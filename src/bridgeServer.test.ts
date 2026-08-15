import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';

/**
 * REQ-074 T1 — bridge WebSocket server & session lifecycle (plan §3; AC-3
 * security, OQ-3 multi-tab, OQ-2 loopback).
 *
 * `bridgeServer.ts` does not exist yet (T3 builds it) — every test below
 * fails at this file's own import statement ("Cannot find module
 * './bridgeServer'"), never inside an assertion. This is the intended RED:
 * this file pins the exact wire behavior T3 must implement, driven with the
 * real `ws` package as a stand-in "tab" (no browser needed for these unit
 * assertions -- the real editor-tab side is covered by the dev-lane e2e
 * spec, src/tests/browser/req-074-bridge.spec.ts).
 *
 * ASSUMPTIONS (the plan pins the *behavior*, not exact export names/shapes):
 *   - `startBridgeServer(options?: { port?: number }): Promise<BridgeServerHandle>`
 *     where `BridgeServerHandle` exposes `port`, `token`, `isTabConnected()`,
 *     `onDescribe(handler)`, `callTab(group, method, args, timeoutMs?)`, and
 *     `close()`. `port`/`token` are read directly off the handle (plan §2:
 *     "Returning the raw port/token lets a caller compose its own URL").
 *   - Named close-code constants `CLOSE_CODE_BAD_TOKEN` and
 *     `CLOSE_CODE_SUPERSEDED`, exported from bridgeServer.ts, both outside
 *     the reserved 1000-2999 WebSocket range per RFC 6455 (>=4000) so they
 *     are unambiguously distinct from normal/protocol closes.
 *   - Wire frames (mirroring the assumed packages/figpea-mcp/src/protocol.ts,
 *     see src/tests/unit/agent/bridgeProtocol.test.ts): the tab's first frame
 *     is `{type:'hello', token}`; the server relays calls as
 *     `{type:'call', id, group, method, args}` and expects
 *     `{type:'result', id, ok, value?, code?, message?}` back.
 */

interface BridgeServerHandle {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

import { startBridgeServer, CLOSE_CODE_BAD_TOKEN, CLOSE_CODE_SUPERSEDED } from './bridgeServer';

/** Waits for a `ws` client's 'open' event as a promise. */
function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

/** Waits for a `ws` client's 'close' event, resolving with {code, reason}. */
function waitForClose(ws: WebSocket, timeout = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForClose: timed out')), timeout);
    ws.once('close', (code: number, reasonBuf: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reasonBuf.toString() });
    });
  });
}

/** Waits for the next parsed-JSON message frame from a `ws` client. */
function waitForMessage(ws: WebSocket, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMessage: timed out')), timeout);
    ws.once('message', (data: WebSocket.RawData) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

// Module-scoped only for afterEach cleanup (possibly-unset between tests is
// fine there, guarded by `if`); every test body below instead captures its
// own `startBridgeServer()` result into a locally-scoped `const` so TS can
// narrow it as always-defined within that test, and assigns it here only for
// teardown's sake.
let activeHandle: BridgeServerHandle | undefined;
const openSockets: WebSocket[] = [];

function trackHandle(bridge: BridgeServerHandle): BridgeServerHandle {
  activeHandle = bridge;
  return bridge;
}

afterEach(async () => {
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
  openSockets.length = 0;
  if (activeHandle) {
    await activeHandle.close();
    activeHandle = undefined;
  }
});

describe('startBridgeServer — loopback bind (plan §3, AC-3)', () => {
  it('binds to an OS-assigned ephemeral port reachable at 127.0.0.1', async () => {
    const bridge = trackHandle(await startBridgeServer());
    expect(typeof bridge.port).toBe('number');
    expect(bridge.port).toBeGreaterThan(0);

    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws);
    await expect(waitForOpen(ws)).resolves.toBeUndefined();
  });

  it('two independent servers get two different ephemeral ports (parallel-run-safe, no fixed convention port)', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const second = await startBridgeServer();
    try {
      expect(second.port).not.toBe(bridge.port);
    } finally {
      await second.close();
    }
  });
});

describe('startBridgeServer — per-run pairing token gate (plan §3, AC-3)', () => {
  it('a connection that sends the valid token is accepted (stays open, tab registers as connected)', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));

    await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('a connection with the wrong token is refused with a distinct close code, and never registers', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'hello', token: 'not-the-real-token' }));

    const { code } = await waitForClose(ws);
    expect(code).toBe(CLOSE_CODE_BAD_TOKEN);
    expect(bridge.isTabConnected()).toBe(false);
  });

  it('a connection that sends no hello frame at all is refused with the same distinct close code', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws);
    await waitForOpen(ws);
    // Send a non-hello frame as the first message instead of `hello`.
    ws.send(JSON.stringify({ type: 'call', id: '1', group: 'session', method: 'layerTree', args: [] }));

    const { code } = await waitForClose(ws);
    expect(code).toBe(CLOSE_CODE_BAD_TOKEN);
    expect(bridge.isTabConnected()).toBe(false);
  });
});

describe('startBridgeServer — request/response id correlation + timeout (plan §3)', () => {
  it('callTab() resolves with the value the fake tab returns, correlated by the call id the server assigned', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
    await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);

    const callPromise = bridge.callTab('layer', 'move', ['layer-1', 10, 20]);
    const callFrame = await waitForMessage(ws);
    expect(callFrame.type).toBe('call');
    expect(callFrame.group).toBe('layer');
    expect(callFrame.method).toBe('move');
    expect(callFrame.args).toEqual(['layer-1', 10, 20]);
    expect(typeof callFrame.id).toBe('string');

    // Echo the server-assigned id back so correlation is exercised for real,
    // not just assumed by call order.
    ws.send(JSON.stringify({ type: 'result', id: callFrame.id, ok: true, value: null }));
    await expect(callPromise).resolves.toEqual({ ok: true, value: null });
  });

  it('a call that never gets a matching result frame rejects once its timeout elapses', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
    await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);

    await expect(bridge.callTab('layer', 'move', ['layer-1', 1, 1], 100)).rejects.toBeTruthy();
  });
});

describe('startBridgeServer — single active session, newest-wins takeover (plan §3 OQ-3)', () => {
  it('a second valid-token connection supersedes the first; the old socket is closed with a distinct code', async () => {
    const bridge = trackHandle(await startBridgeServer());

    const ws1 = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws1);
    await waitForOpen(ws1);
    ws1.send(JSON.stringify({ type: 'hello', token: bridge.token }));
    await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);

    const ws2 = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws2);
    await waitForOpen(ws2);
    ws2.send(JSON.stringify({ type: 'hello', token: bridge.token }));

    const { code } = await waitForClose(ws1);
    expect(code).toBe(CLOSE_CODE_SUPERSEDED);
    await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);
  });

  it('after takeover, relayed calls route to the new tab, never the superseded one', async () => {
    const bridge = trackHandle(await startBridgeServer());

    const ws1 = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws1);
    await waitForOpen(ws1);
    ws1.send(JSON.stringify({ type: 'hello', token: bridge.token }));
    await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);

    const ws2 = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws2);
    await waitForOpen(ws2);
    ws2.send(JSON.stringify({ type: 'hello', token: bridge.token }));
    await waitForClose(ws1);

    let ws1GotCall = false;
    ws1.on('message', () => {
      ws1GotCall = true;
    });

    const callPromise = bridge.callTab('session', 'layerTree', []);
    const callFrame = await waitForMessage(ws2);
    ws2.send(JSON.stringify({ type: 'result', id: callFrame.id, ok: true, value: { id: 'root' } }));
    await expect(callPromise).resolves.toEqual({ ok: true, value: { id: 'root' } });
    expect(ws1GotCall).toBe(false);
  });
});
