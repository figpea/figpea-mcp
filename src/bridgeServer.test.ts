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
  /** REQ-125 — the connected tab's last reported `figpea.version`, or null.
   * Declared here because REQ-188's drill tests assert it survives the
   * multi-frame drill; this stand-in interface otherwise drifts from the
   * real handle and the assertion fails to typecheck rather than to run. */
  getContractVersion(): string | null;
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

/**
 * REQ-188 — the bridge drives the progressive `describe()` drill (AC-1, AC-2,
 * AC-3). Sequencing itself is unit-tested in `describeDrill.test.ts`; these
 * tests pin the WIRE behavior and the `onDescribe` contract, driven with a
 * real `ws` client standing in for an editor tab.
 */

/** A compact index as contract >=0.16.0's bare `describe()` returns it. */
const DRILL_INDEX = {
  version: '1.8.0',
  session: { openFile: 'Opens a design file.' },
  layer: { create: 'Creates a layer.' },
  errorCodes: ['no_session'],
};

const DRILL_GROUPS: Record<string, unknown> = {
  session: { openFile: { doc: 'Opens a design file.', params: { url: { kind: 'string' } }, result: 'void' } },
  layer: { create: { doc: 'Creates a layer.', params: { kind: { kind: 'string' } }, result: 'string' } },
};

/** Makes `ws` answer describe frames like a real tab: bare -> compact index,
 * `selector` -> that group's full descriptors. Selectors listed in `missing`
 * reply with the `manifest` key ABSENT (never null) -- exactly how an
 * unresolved selector serializes v3-side. Returns the selectors seen, in
 * order. */
function serveDrill(ws: WebSocket, missing: string[] = []): Array<string | undefined> {
  const seen: Array<string | undefined> = [];
  ws.on('message', (data: WebSocket.RawData) => {
    let frame: any;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame?.type !== 'describe') return;
    seen.push(frame.selector);

    if (frame.selector === undefined) {
      ws.send(JSON.stringify({ type: 'describe_result', manifest: DRILL_INDEX, version: '1.8.0' }));
      return;
    }
    if (missing.includes(frame.selector)) {
      // No `manifest` key at all -- JSON.stringify drops an undefined value.
      ws.send(JSON.stringify({ type: 'describe_result', version: '1.8.0' }));
      return;
    }
    ws.send(JSON.stringify({ type: 'describe_result', manifest: DRILL_GROUPS[frame.selector], version: '1.8.0' }));
  });
  return seen;
}

async function connectDrillingTab(bridge: BridgeServerHandle, missing: string[] = []) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await waitForOpen(ws);
  const seen = serveDrill(ws, missing);
  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  return { ws, seen };
}

/**
 * REQ-772 T1 (AC-3 + AC-6, docs/plans/REQ-772.md task T1) — a timed-out
 * call's error must be HONEST ABOUT AMBIGUITY: the tab keeps executing after
 * the relay gives up, so the rejection message must say so explicitly.
 * Written against the AC text, red on the unfixed tree (today's message is
 * just "timed out after Nms"). Driven through the real ws listener with a
 * fake tab, mirroring this file's established harness.
 */
describe('REQ-772 AC-3 — timeout rejection states the editor may still be executing the call', () => {
  async function connectSilentTab(bridge: BridgeServerHandle): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
    await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);
    return ws;
  }

  it('a call whose tab never replies rejects with the full ambiguity clause', async () => {
    const bridge = trackHandle(await startBridgeServer());
    await connectSilentTab(bridge);

    let rejection: unknown;
    try {
      await bridge.callTab('session', 'waitForIdle', [], 100);
    } catch (e) {
      rejection = e;
    }
    expect(rejection, 'callTab rejects when nothing answers').toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain('timed out after 100ms');
    expect(
      message,
      'AC-3: the message must state the tab may still complete the work',
    ).toContain('may still be executing this call');
    expect(message, 'AC-3: callers must be told not to blindly retry').toContain('check state before retrying');
  });

  it('the pending entry is deleted at the deadline while a late tab-side result still arrives (the effect lands anyway)', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const ws = await connectSilentTab(bridge);

    const LATE_RESULT_DELAY_MS = 150;
    const TIMEOUT_MS = 50;
    // `on`, not `once`: the drill's describe frames arrive first; we act
    // only on the relayed `call` frame.
    ws.on('message', (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame?.type !== 'call') return;
      // The tab side keeps working past the relay's deadline and eventually
      // delivers its result — exactly the ambiguous-failure shape REQ-772
      // documents. The server must ignore this stale id (entry deleted).
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: 'late-tab-side-effect' }));
      }, LATE_RESULT_DELAY_MS);
    });

    const callPromise = bridge.callTab('session', 'waitForIdle', [], TIMEOUT_MS);
    await expect(callPromise, 'the relay itself still gives up at its own deadline').rejects.toThrow(/timed out/);

    // Let the late reply arrive and be dropped; the bridge must neither
    // crash nor wedge — it stays usable for the next call.
    await new Promise((resolve) => setTimeout(resolve, LATE_RESULT_DELAY_MS + 150));
    expect(bridge.isTabConnected()).toBe(true);
  });
});

describe('startBridgeServer — progressive describe drilling (REQ-188)', () => {
  it('sends a bare describe first, then one per group carrying a selector (AC-2)', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const { seen } = await connectDrillingTab(bridge);

    await expect.poll(() => seen.length, { timeout: 3000 }).toBe(3);
    expect(seen[0]).toBeUndefined();
    expect(seen.slice(1).sort()).toEqual(['layer', 'session']);
  });

  it('never drills the reserved errorCodes or version keys (AC-2)', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const { seen } = await connectDrillingTab(bridge);

    await expect.poll(() => seen.length, { timeout: 3000 }).toBe(3);
    expect(seen).not.toContain('errorCodes');
    expect(seen).not.toContain('version');
  });

  it('fires onDescribe ONCE with the reassembled full manifest (AC-1)', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const received: unknown[] = [];
    bridge.onDescribe((manifest) => received.push(manifest));

    await connectDrillingTab(bridge);

    await expect.poll(() => received.length, { timeout: 3000 }).toBe(1);
    // The full descriptors, not the compact index's doc strings -- and none
    // of the reserved keys, which downstream would read as groups.
    expect(received[0]).toEqual(DRILL_GROUPS);
  });

  it('still reports the contract version from the drilled frames', async () => {
    const bridge = trackHandle(await startBridgeServer());
    await connectDrillingTab(bridge);

    await expect.poll(() => bridge.getContractVersion(), { timeout: 3000 }).toBe('1.8.0');
  });

  it('skips a group whose reply omits the manifest key, keeping the rest (AC-3)', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const received: any[] = [];
    bridge.onDescribe((manifest) => received.push(manifest));

    await connectDrillingTab(bridge, ['layer']);

    await expect.poll(() => received.length, { timeout: 3000 }).toBe(1);
    expect(Object.keys(received[0])).toEqual(['session']);
    expect(received[0]).not.toHaveProperty('layer');
  });

  it('re-drills on reconnect so a new tab refreshes the manifest', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const received: unknown[] = [];
    bridge.onDescribe((manifest) => received.push(manifest));

    await connectDrillingTab(bridge);
    await expect.poll(() => received.length, { timeout: 3000 }).toBe(1);

    await connectDrillingTab(bridge);
    await expect.poll(() => received.length, { timeout: 3000 }).toBe(2);
    expect(received[1]).toEqual(DRILL_GROUPS);
  });

  it('does not hang forever when a tab answers hello but never answers describe', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(ws);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));

    // The tab is connected; the drill is stalled. The bridge must stay
    // usable rather than wedging on an unresolved describe promise.
    await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);
    await expect(bridge.callTab('session', 'ping', [], 300)).rejects.toThrow(/timed out/);
  });
});
