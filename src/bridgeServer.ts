/**
 * REQ-074 T3 — bridge WebSocket server & session lifecycle (plan §3; AC-3
 * security, OQ-3 multi-tab, OQ-2 loopback). A pure relay: this module owns
 * zero editor logic, only the localhost listener, the per-run pairing-token
 * gate, request/response id-correlation, and newest-wins takeover.
 *
 * REQ-1017 — add loopback HTTP file endpoint GET /file?path=… (+ /blob/<token>)
 * with ACAO:* and MIME, backed by http.createServer + WebSocketServer({server}).
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';
import type { CallFrame, DescribeFrame } from './protocol';
import { drillManifest, type DescribeFn, type DescribeResultPayload } from './describeDrill';

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

/** How long one `describe` frame may go unanswered before the drill gives up
 * on it (REQ-188). A stalled tab must degrade to a skipped group — or, for
 * the bare index, to no contract tools — never to a promise that never
 * settles and wedges the connection's drill forever. */
const DESCRIBE_TIMEOUT_MS = 10_000;

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
  /** REQ-1017: returns a loopback URL for the given absolute filePath (primary endpoint). */
  getFileUrl(filePath: string): string;
  /** REQ-1017: registers a blob token alias for the filePath and returns its /blob URL. */
  registerBlob(filePath: string): string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Starts the localhost-only bridge WebSocket + HTTP file server (plan §3, REQ-1017). */
export async function startBridgeServer(options?: StartBridgeServerOptions): Promise<BridgeServerHandle> {
  const token = crypto.randomUUID();

  // --- REQ-1017 file handling helpers ---
  const blobMap = new Map<string, string>(); // token -> filePath

  function mimeForPath(p: string): string {
    const ext = path.extname(p).toLowerCase();
    switch (ext) {
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.png': return 'image/png';
      case '.webp': return 'image/webp';
      case '.svg': return 'image/svg+xml';
      case '.gif': return 'image/gif';
      case '.pdf': return 'application/pdf';
      case '.fp': return 'application/octet-stream';
      case '.fig': return 'application/octet-stream';
      case '.psd': return 'image/vnd.adobe.photoshop';
      case '.json': return 'application/json';
      case '.txt': return 'text/plain';
      default: return 'application/octet-stream';
    }
  }

  function setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  async function handleFileRequest(res: http.ServerResponse, filePath: string): Promise<void> {
    // Security: absolute, no null byte
    if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
      setCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'invalid_path', message: `invalid filePath: ${filePath}` }));
      return;
    }
    const normalized = path.normalize(filePath);
    // Size guard / existence
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(normalized);
    } catch {
      setCorsHeaders(res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'not_found', message: `file not found: ${filePath}` }));
      return;
    }
    if (!stat.isFile()) {
      setCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'invalid_path', message: `not a file: ${filePath}` }));
      return;
    }
    const MAX_BYTES = 50 * 1024 * 1024;
    if (stat.size > MAX_BYTES) {
      setCorsHeaders(res);
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'too_large', message: `file too large: ${stat.size}` }));
      return;
    }
    const mime = mimeForPath(normalized);
    setCorsHeaders(res);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(normalized);
    stream.on('error', () => {
      try { res.end(); } catch {}
    });
    stream.pipe(res);
  }

  function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Always handle CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/file') {
      const fp = url.searchParams.get('path');
      if (!fp) {
        setCorsHeaders(res);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'invalid_path', message: 'missing path query' }));
        return;
      }
      void handleFileRequest(res, fp);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/blob/')) {
      const tok = url.pathname.slice('/blob/'.length);
      const fp = blobMap.get(tok);
      if (!fp) {
        setCorsHeaders(res);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'not_found', message: 'unknown blob token' }));
        return;
      }
      void handleFileRequest(res, fp);
      return;
    }
    // Unknown path: 404 with CORS so browser checks don't fail due to missing header
    setCorsHeaders(res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'not_found' }));
  }

  const httpServer = http.createServer(requestHandler);

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    httpServer.once('error', onErr);
    httpServer.listen(options?.port ?? 0, '127.0.0.1', () => {
      httpServer.removeListener('error', onErr);
      resolve();
    });
  });

  const wss = new WebSocketServer({ server: httpServer });

  // Lives for the server's whole lifetime (not just startup) -- logs rather
  // than throwing, since a single bad frame from a tab must never take the
  // bridge down (AC-3's "pure relay" never trusts the far side).
  wss.on('error', (err: Error) => {
    console.error('[figpea-mcp] bridge server error:', err);
  });
  httpServer.on('error', (err: Error) => {
    console.error('[figpea-mcp] http server error:', err);
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('figpea-mcp bridgeServer: failed to determine the bound ephemeral port');
  }
  const port = (address as { port: number }).port;

  let activeSocket: WebSocket | undefined;
  let contractVersion: string | null = null;
  let nextCallId = 1;
  const pending = new Map<string, PendingCall>();
  const describeHandlers: Array<(manifest: unknown) => void> = [];

  /** Resolver for the single in-flight `describe` request, if any.
   *
   * One slot, not a map: `describe_result` frames carry no correlation id and
   * no selector echo (see `protocol.ts`), so a reply can only be matched to
   * its request by ordering. The drill awaits each frame before sending the
   * next, which keeps this slot occupied by at most one request at a time. */
  let pendingDescribe: ((payload: DescribeResultPayload) => void) | undefined;

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
      const resolve = pendingDescribe;
      pendingDescribe = undefined;
      // `manifest` is absent (not null) when the selector missed, so presence
      // is tested on the parsed frame rather than inferred from the value.
      resolve?.({
        hasManifest: Object.prototype.hasOwnProperty.call(frame, 'manifest'),
        manifest: frame.manifest,
        version: contractVersion,
      });
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

  /** Issues one `describe` frame on `socket` and resolves with its reply.
   *
   * Rejects on timeout, and on takeover — if `socket` is no longer the active
   * one, a superseding tab's drill now owns `pendingDescribe`, and answering
   * a dead drill would let the two interleave and cross-assign each other's
   * replies (they are matched only by order). */
  function describeOnce(socket: WebSocket): DescribeFn {
    return (selector?: string) =>
      new Promise<DescribeResultPayload>((resolve, reject) => {
        if (activeSocket !== socket || socket.readyState !== WebSocket.OPEN) {
          reject(new Error('figpea-mcp bridgeServer: tab disconnected before describe completed'));
          return;
        }

        const timer = setTimeout(() => {
          if (pendingDescribe === settle) pendingDescribe = undefined;
          reject(
            new Error(
              `figpea-mcp bridgeServer: describe(${selector ?? ''}) timed out after ${DESCRIBE_TIMEOUT_MS}ms`,
            ),
          );
        }, DESCRIBE_TIMEOUT_MS);

        const settle = (payload: DescribeResultPayload): void => {
          clearTimeout(timer);
          resolve(payload);
        };

        pendingDescribe = settle;
        // `selector` is omitted entirely for the bare index call, keeping
        // that frame byte-identical to the pre-REQ-181 one.
        const frame: DescribeFrame = selector === undefined ? { type: 'describe' } : { type: 'describe', selector };
        sendFrame(socket, frame);
      });
  }

  /** Drills the connected tab's full manifest and publishes it to
   * `onDescribe` subscribers exactly once per connect (REQ-188). */
  async function runDescribeDrill(socket: WebSocket): Promise<void> {
    const manifest = await drillManifest(describeOnce(socket), (message) => console.error(message));

    // A tab that was superseded mid-drill must not publish its stale result
    // over the newer tab's.
    if (activeSocket !== socket) return;
    if (manifest === undefined) return;

    for (const handler of describeHandlers) handler(manifest);
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

    function safeDecodeAndTrim(s: string): string {
      let out = s;
      try {
        out = decodeURIComponent(out);
      } catch {}
      return out.trim();
    }

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

      const receivedRaw = frame?.token == null ? '' : String(frame.token);
      const received = safeDecodeAndTrim(receivedRaw);
      const expected = safeDecodeAndTrim(token);
      if (frame?.type !== 'hello' || !received || received !== expected) {
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
      void runDescribeDrill(socket);
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
          // REQ-772 AC-3: a relay timeout is NOT proof the tab failed — the
          // tab keeps executing and the effect (e.g. layer.create) may land
          // anyway. The rejection must say so, so callers check state before
          // blindly retrying non-idempotent mutations.
          reject(
            new Error(
              `figpea-mcp bridgeServer: call ${group}.${method} timed out after ${timeoutMs}ms; the editor may still be executing this call — check state before retrying`,
            ),
          );
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        sendFrame(socket, frame);
      });
    },
    getFileUrl(filePath: string): string {
      return `http://127.0.0.1:${port}/file?path=${encodeURIComponent(filePath)}`;
    },
    registerBlob(filePath: string): string {
      const tok = crypto.randomUUID();
      blobMap.set(tok, filePath);
      // simple expiry after 5 min
      setTimeout(() => blobMap.delete(tok), 5 * 60 * 1000).unref?.();
      return `http://127.0.0.1:${port}/blob/${tok}`;
    },
    async close(): Promise<void> {
      rejectAllPending(new Error('figpea-mcp bridgeServer: server closed'));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
