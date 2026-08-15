/**
 * REQ-074 T3 — bridge WebSocket server & session lifecycle (plan §3; AC-3
 * security, OQ-3 multi-tab, OQ-2 loopback). A pure relay: this module owns
 * zero editor logic, only the localhost listener, the per-run pairing-token
 * gate, request/response id-correlation, and newest-wins takeover.
 */

import * as crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { CallFrame, DescribeFrame } from './protocol';

/** Distinct WebSocket close codes for the two server-initiated close paths
 * (AC-3, OQ-3) — both >=4000 (RFC 6455 private-use range), unambiguously
 * distinct from normal/protocol closes (1000-2999). */
export const CLOSE_CODE_BAD_TOKEN = 4001;
export const CLOSE_CODE_SUPERSEDED = 4002;

/** How long a freshly connected socket has to send its `hello` frame before
 * being closed for inactivity — generous, since every real client sends
 * `hello` as its very first frame with no round trip in between. */
const HELLO_TIMEOUT_MS = 5000;

/** Default per-call timeout when the caller doesn't specify one. */
const DEFAULT_CALL_TIMEOUT_MS = 10_000;

export interface StartBridgeServerOptions {
  /** Bind port; omit (or 0) for an OS-assigned ephemeral port (the normal,
   * parallel-run-safe case — plan §3). */
  port?: number;
}

export interface BridgeServerHandle {
  /** The bound, OS-assigned (unless overridden) ephemeral port, reachable at
   * 127.0.0.1 only. */
  readonly port: number;
  /** The per-run pairing token a connecting tab must echo back in its
   * `hello` frame. */
  readonly token: string;
  /** Whether a tab is currently connected and past the token gate. */
  isTabConnected(): boolean;
  /** Registers a handler invoked with the connected tab's live
   * `figpea.describe()` manifest, each time one is received (initial connect
   * and every reconnect/takeover). */
  onDescribe(handler: (manifest: unknown) => void): void;
  /** The connected tab's most recently reported `figpea.version`, or `null`
   * if no tab has ever reported one. */
  getContractVersion(): string | null;
  /** Relays a call to the connected tab, resolving with its structured
   * `{ok,...}` result, correlated by a server-assigned id. Rejects if no tab
   * is connected, or once `timeoutMs` elapses with no matching result. */
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  /** Shuts down the listener and rejects any still-pending calls. */
  close(): Promise<void>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Starts the localhost-only bridge WebSocket server (plan §3). */
export async function startBridgeServer(options?: StartBridgeServerOptions): Promise<BridgeServerHandle> {
  const token = crypto.randomUUID();

  const wss = await new Promise<WebSocketServer>((resolve, reject) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: options?.port ?? 0 });
    const onListenError = (err: Error) => reject(err);
    server.once('error', onListenError);
    server.once('listening', () => {
      server.removeListener('error', onListenError);
      resolve(server);
    });
  });

  // Lives for the server's whole lifetime (not just startup) -- logs rather
  // than throwing, since a single bad frame from a tab must never take the
  // bridge down (AC-3's "pure relay" never trusts the far side).
  wss.on('error', (err: Error) => {
    console.error('[figpea-mcp] bridge server error:', err);
  });

  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error('figpea-mcp bridgeServer: failed to determine the bound ephemeral port');
  }
  const port = address.port;

  let activeSocket: WebSocket | undefined;
  let contractVersion: string | null = null;
  let nextCallId = 1;
  const pending = new Map<string, PendingCall>();
  const describeHandlers: Array<(manifest: unknown) => void> = [];

  function rejectAllPending(reason: unknown): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  }

  function sendFrame(socket: WebSocket, frame: unknown): void {
    socket.send(JSON.stringify(frame));
  }

  function handleTabFrame(data: WebSocket.RawData): void {
    let frame: any;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return; // Malformed frame from an already-authenticated tab: drop it, never crash the relay.
    }

    if (frame?.type === 'describe_result') {
      contractVersion = typeof frame.version === 'string' ? frame.version : null;
      for (const handler of describeHandlers) handler(frame.manifest);
      return;
    }

    if (frame?.type === 'result' && typeof frame.id === 'string') {
      const entry = pending.get(frame.id);
      if (!entry) return; // Stale/unknown id (e.g. already timed out) -- ignore.
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.ok) {
        entry.resolve({ ok: true, value: frame.value });
      } else {
        entry.resolve({ ok: false, code: frame.code, message: frame.message });
      }
    }
  }

  wss.on('connection', (socket: WebSocket) => {
    socket.on('error', () => {
      // A transport-level error on an individual socket must never crash the
      // bridge or leave an unhandled 'error' rejection; 'close' still fires
      // and tears down bookkeeping normally.
    });

    let sawHello = false;
    const helloTimer = setTimeout(() => {
      if (!sawHello) {
        socket.close(CLOSE_CODE_BAD_TOKEN, 'no hello frame received');
      }
    }, HELLO_TIMEOUT_MS);

    const onHelloFrame = (data: WebSocket.RawData): void => {
      clearTimeout(helloTimer);
      socket.off('message', onHelloFrame);

      let frame: any;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        socket.close(CLOSE_CODE_BAD_TOKEN, 'malformed hello frame');
        return;
      }

      if (frame?.type !== 'hello' || frame.token !== token) {
        socket.close(CLOSE_CODE_BAD_TOKEN, 'invalid or missing pairing token');
        return;
      }

      sawHello = true;

      // Newest-wins takeover (OQ-3): a second valid-token connection
      // supersedes the first, which is closed with a distinct code and
      // logged on this (bridge) side; the client side (T4) flips its own
      // "agent connected" indicator on receiving this close code.
      if (activeSocket && activeSocket !== socket && activeSocket.readyState === WebSocket.OPEN) {
        console.error('[figpea-mcp] bridge: a new tab connection superseded the previous one');
        activeSocket.close(CLOSE_CODE_SUPERSEDED, 'superseded by a newer tab connection');
      }
      activeSocket = socket;

      socket.on('message', handleTabFrame);
      const describeRequest: DescribeFrame = { type: 'describe' };
      sendFrame(socket, describeRequest);
    };

    socket.on('message', onHelloFrame);

    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (activeSocket === socket) {
        activeSocket = undefined;
      }
    });
  });

  return {
    port,
    token,
    isTabConnected(): boolean {
      return activeSocket !== undefined && activeSocket.readyState === WebSocket.OPEN;
    },
    onDescribe(handler: (manifest: unknown) => void): void {
      describeHandlers.push(handler);
    },
    getContractVersion(): string | null {
      return contractVersion;
    },
    callTab(group: string, method: string, args: unknown[], timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
      const socket = activeSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('figpea-mcp bridgeServer: no tab is connected'));
      }
      const id = String(nextCallId++);
      const frame: CallFrame = { type: 'call', id, group, method, args };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`figpea-mcp bridgeServer: call ${group}.${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        sendFrame(socket, frame);
      });
    },
    async close(): Promise<void> {
      rejectAllPending(new Error('figpea-mcp bridgeServer: server closed'));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
