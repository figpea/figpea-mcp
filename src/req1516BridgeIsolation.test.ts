import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';

import { startBridgeServer, CLOSE_CODE_SUPERSEDED } from './bridgeServer';

/**
 * REQ-1516 T5 — ground-truth bridge-isolation spec for AC-5, taken on the
 * live tree BEFORE any fix.
 *
 * AC-5: "Two concurrent runs can each hold their own bridge and neither
 * displaces the other's editor tab by accident; a second pairing attempt
 * against a live bridge either fails loudly or is explicitly opted into."
 * Takeover semantics are out of scope (card Scope) — what is pinned here is
 * that the CURRENT mechanism already refuses loudly by default, isolates
 * bridges by port, and pairs both tabs only under the explicit
 * `--bridge-slots=multi` opt-in.
 *
 * Harness mirrors `req1492BridgeSlots.test.ts` (the established tier for this
 * surface): REAL `startBridgeServer()` listeners on OS-assigned ports, REAL
 * `ws` clients standing in for editor tabs, speaking the real wire protocol
 * (hello + describe drill + call/result frames).
 *
 * Whatever sub-row is red defines T6's fix. If all rows are green on the
 * live tree, the mechanism holds and these rows stand as pinning tests — T6
 * is then pinning-tests-only and records that outcome.
 */

vi.setConfig({ testTimeout: 30_000 });

type Bridge = Awaited<ReturnType<typeof startBridgeServer>>;

const openBridges: Bridge[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  for (const bridge of openBridges.splice(0)) await bridge.close().catch(() => {});
});

async function liveBridge(slots?: 'single' | 'multi'): Promise<Bridge> {
  const bridge = await startBridgeServer(slots ? { slots } : undefined);
  openBridges.push(bridge);
  return bridge;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

async function waitFor<T>(probe: () => T, ok: (value: T) => boolean, label: string, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = probe();
      if (ok(value)) return value;
      last = value;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      const seen = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`${label} — last observed: ${seen}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface TabClient {
  ws: WebSocket;
  frames: any[];
  closed: { code: number; reason: string } | null;
}

/** One stand-in editor tab: real `ws` socket, handshake, drill, frame log. */
async function connectTab(bridge: Bridge, origin?: string): Promise<TabClient> {
  const ws = origin
    ? new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin })
    : new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await waitForOpen(ws);

  const tab: TabClient = { ws, frames: [], closed: null };
  ws.on('message', (data: WebSocket.RawData) => {
    let frame: any;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    tab.frames.push(frame);
    if (frame?.type !== 'describe') return;
    const manifest =
      frame.selector === undefined
        ? { version: '2.59.1', session: 'session group', layer: 'layer group' }
        : { openFile: { doc: 'Opens a design file.', params: {}, result: 'void' } };
    ws.send(JSON.stringify({ type: 'describe_result', manifest, version: '2.59.1' }));
  });
  ws.on('close', (code: number, reasonBuf: Buffer) => {
    tab.closed = { code, reason: reasonBuf.toString() };
  });
  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  return tab;
}

function callFrames(tab: TabClient): any[] {
  return tab.frames.filter((f) => f?.type === 'call');
}

/** Answers the first relayed call on `tab`, resolving the caller's promise. */
async function answerCall(tab: TabClient, value: unknown = { id: 'layer-1' }): Promise<void> {
  const frame = await waitFor(() => callFrames(tab)[0], (f) => f !== undefined, 'a call frame arrives on the tab');
  tab.ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value }));
}

describe('REQ-1516 AC-5 — a second pairing against a live bridge fails loudly by default', () => {
  it('refuses the newcomer by name and the first tab keeps serving', async () => {
    const bridge = await liveBridge('single');
    const incumbent = await connectTab(bridge, 'https://editor.figpea.com');
    await waitFor(() => bridge.getConnections().length, (n) => n === 1, 'first tab pairs');
    const newcomer = await connectTab(bridge, 'http://localhost:8080');

    const refused = await waitFor(() => newcomer.closed, (c) => c !== null, 'the second pairing is refused');
    expect(refused!.code, 'refused with the supersession close code').toBe(CLOSE_CODE_SUPERSEDED);
    expect(refused!.reason, 'the refusal names the holder of the slot').toMatch(/c1/);
    expect(incumbent.closed, 'the incumbent is untouched').toBeNull();
    expect(bridge.getConnectionDiagnosis().lastEvent, 'the refusal is a named state').toBe('slot_refused');

    const callPromise = bridge.callTab('session', 'layerTree', [], 8000);
    await answerCall(incumbent);
    await expect(callPromise, 'the first tab still answers calls').resolves.toEqual({
      ok: true,
      value: { id: 'layer-1' },
    });
  });
});

describe('REQ-1516 AC-5 — two concurrent runs hold their own bridges', () => {
  it('each bridge pairs its own tab and calls never cross', async () => {
    const first = await liveBridge('single');
    const second = await liveBridge('single');
    expect(second.port, 'two bridges bind different ports').not.toBe(first.port);

    const tabA = await connectTab(first, 'https://editor.figpea.com');
    const tabB = await connectTab(second, 'http://localhost:8080');
    await waitFor(() => first.getConnections().length, (n) => n === 1, 'tab A pairs on the first bridge');
    await waitFor(() => second.getConnections().length, (n) => n === 1, 'tab B pairs on the second bridge');

    const callA = first.callTab('layer', 'create', ['rect', {}], 8000);
    await answerCall(tabA);
    await expect(callA).resolves.toEqual({ ok: true, value: { id: 'layer-1' } });
    const callB = second.callTab('layer', 'create', ['rect', {}], 8000);
    await answerCall(tabB);
    await expect(callB).resolves.toEqual({ ok: true, value: { id: 'layer-1' } });

    expect(callFrames(tabA), 'tab A saw only its own bridge’s call').toHaveLength(1);
    expect(callFrames(tabB), 'tab B saw only its own bridge’s call').toHaveLength(1);
    expect(tabA.closed, 'neither tab was displaced').toBeNull();
    expect(tabB.closed, 'neither tab was displaced').toBeNull();
  });
});

describe('REQ-1516 AC-5 — pairing both tabs is explicitly opted into', () => {
  it('--bridge-slots=multi pairs both tabs and addresses each by id', async () => {
    const bridge = await liveBridge('multi');
    const tabA = await connectTab(bridge, 'https://editor.figpea.com');
    await waitFor(() => bridge.getConnections().length, (n) => n === 1, 'first tab pairs');
    const tabB = await connectTab(bridge, 'http://localhost:8080');
    const connections = await waitFor(
      () => bridge.getConnections(),
      (list) => list.length === 2,
      'second tab pairs alongside the first under the opt-in',
    );

    expect(tabA.closed, 'the incumbent is not closed under the opt-in').toBeNull();
    expect(tabB.closed, 'nor is the newcomer').toBeNull();
    expect(connections.map((c) => c.connectionId)).toEqual(['c1', 'c2']);

    await bridge.selectConnection('c2');
    expect(bridge.getConnections().find((c) => c.active)?.connectionId).toBe('c2');
    const callPromise = bridge.callTab('layer', 'create', ['rect', {}], 8000, 'c2');
    await answerCall(tabB);
    await expect(callPromise).resolves.toEqual({ ok: true, value: { id: 'layer-1' } });
    expect(callFrames(tabA), 'the unaddressed tab receives nothing').toHaveLength(0);
  });
});
