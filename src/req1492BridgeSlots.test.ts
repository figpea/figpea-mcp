import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';

import { startBridgeServer, CLOSE_CODE_SUPERSEDED } from './bridgeServer';

/**
 * REQ-1492 T1 — the bridge must never let a second connection silently take a
 * live tab's place (AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-9).
 *
 * ## Why this file exists
 *
 * The incident this REQ was filed from was silent, not loud: the second tab
 * connected, the FIRST tab was closed with `4002`, and `status` kept answering
 * `tabConnected: true` the whole time — so the evicted session's next write
 * landed in the other session's document with nothing in either payload saying
 * so. Every test below is written from the ACs, and the ones that matter most
 * (AC-9's disjunction and its negative form) are deliberately written so that
 * **today's takeover behaviour fails them**: on the unfixed bridge a second
 * valid-token hello closes the incumbent in BOTH modes, which is exactly the
 * "silently displaced while still reporting success" state AC-9 forbids.
 *
 * ## The surface these tests assume
 *
 * The plan (`docs/plans/REQ-1492-6ac022eb.md` § *The design*) pins the shape:
 * `startBridgeServer({ slots: 'single' | 'multi' })`, a handle exposing
 * `getSlotMode()`, `getConnections()`, `selectConnection(id)` and
 * `callTab(group, method, args, timeoutMs?, connectionId?)`. `figpea-mcp` has
 * no browser and no Playwright runner, so — like `bridgeServer.test.ts` — the
 * tabs here are real `ws` clients speaking the real wire protocol; the real
 * editor tab half is T8's `v3` Playwright spec.
 *
 * The assertions read the ACs' observable claims (which socket received the
 * frame, which connection is active, which origin was seen, what the caller is
 * told), never an internal representation — an implementation that satisfied
 * them by any other route would still pass.
 */

/** One paired slot, as `status` and `selectConnection` see it. */
interface BridgeConnectionLike {
  connectionId: string;
  origin: string | null;
  originSource: 'handshake' | 'absent';
  contractVersion: string | null;
  pairedAt: string;
  active: boolean;
}

interface SlotsBridge {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  getSlotMode(): 'single' | 'multi';
  getConnections(): BridgeConnectionLike[];
  selectConnection(connectionId: string): Promise<void>;
  getConnectionDiagnosis(): { lastEvent: string; nextStep: string; supersededCount: number };
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number, connectionId?: string): Promise<unknown>;
  close(): Promise<void>;
}

type BridgeMode = 'single' | 'multi';

// These assertions wait on a real socket handshake and a real drill round trip,
// so the default 5 s budget is too tight for the polling helpers below to report
// anything more precise than a bare timeout.
vi.setConfig({ testTimeout: 30_000 });

const openBridges: Array<{ close(): Promise<void> }> = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  // Sockets first: `close()` waits for its connections to end, so a live one
  // would hang its own teardown.
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  openSockets.length = 0;
  for (const bridge of openBridges.splice(0)) await bridge.close().catch(() => {});
});

async function liveBridge(slots?: BridgeMode): Promise<SlotsBridge> {
  const bridge = (await startBridgeServer(slots ? { slots } : undefined)) as unknown as SlotsBridge;
  openBridges.push(bridge);
  return bridge;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

/**
 * Polls `probe` until `ok` holds, retrying through a THROW as well as a false —
 * a probe that cannot run yet (the handle has no such method on the unfixed
 * bridge) is "not yet", not "failed", so the test still reports the state it
 * actually observed instead of a stack trace from the first attempt.
 */
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

/** The `call` frames a socket received, in order (its drill frames ignored). */
function callFrames(frames: any[]): any[] {
  return frames.filter((f) => f?.type === 'call');
}

interface TabClient {
  ws: WebSocket;
  frames: any[];
  closed: { code: number; reason: string } | null;
}

/**
 * One stand-in editor tab: a real `ws` socket that completes the handshake with
 * the bridge's own token, answers the `describe` drill (so this slot produces a
 * manifest), and records every frame the bridge sends it.
 *
 * `origin` is the HTTP `Origin` header the client puts on its upgrade request.
 * `ws` sends none unless asked to, which makes the absent-header case a real
 * observation rather than a mocked one.
 */
async function connectTab(bridge: SlotsBridge, options?: { origin?: string; version?: string }): Promise<TabClient> {
  const version = options?.version ?? '2.59.1';
  const ws = options?.origin
    ? new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: options.origin })
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
    // A real editor answers the bare probe with the COMPACT index (a group maps
    // to its one-line doc string) and a selector with THAT group's descriptors
    // only — serving the whole manifest for every selector would hand the drill a
    // shape no editor produces.
    const manifest =
      frame.selector === undefined
        ? drillIndex(version)
        : (drillGroups(version) as Record<string, unknown>)[frame.selector as string];
    ws.send(JSON.stringify({ type: 'describe_result', manifest, version }));
  });
  ws.on('close', (code: number, reasonBuf: Buffer) => {
    tab.closed = { code, reason: reasonBuf.toString() };
  });

  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  return tab;
}

/** The compact index a contract >= 0.16.0 editor's bare `describe()` returns. */
function drillIndex(version: string): unknown {
  return {
    version,
    session: `Opens a design file (contract ${version}).`,
    layer: `Creates a layer (contract ${version}).`,
  };
}

/** The full descriptors, grouped the way `drillManifest` reassembles them. */
function drillGroups(version: string): unknown {
  return {
    session: { openFile: { doc: `Opens a design file (contract ${version}).`, params: {}, result: 'void' } },
    layer: { create: { doc: `Creates a layer (contract ${version}).`, params: {}, result: 'string' } },
  };
}

/** The paired slots, once at least `n` of them have paired. */
async function connectionsWhen(bridge: SlotsBridge, n: number, label: string): Promise<BridgeConnectionLike[]> {
  return waitFor(
    () => bridge.getConnections(),
    (list) => list.length >= n,
    `${label} (expected ${n} paired slot(s))`,
  );
}

/** Answers the first relayed call on `tab`, resolving the caller's promise. */
async function answerCall(tab: TabClient, value: unknown = { id: 'layer-1' }): Promise<void> {
  const frame = await waitFor(() => callFrames(tab.frames)[0], (f) => f !== undefined, 'a call frame arrives on the tab');
  tab.ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value }));
}

/**
 * AC-9 — the regression the card asks for, stated as the card states it: a
 * second socket must leave the incumbent *either still served or explicitly
 * refused*, never silently displaced while the bridge keeps reporting success.
 *
 * Both modes are covered in one test on purpose — AC-9 is a disjunction, and a
 * disjunction pinned one branch at a time is a disjunction nobody checked.
 */
describe('REQ-1492 AC-9 — a second connection is served alongside or explicitly refused', () => {
  it('multi-slot: the incumbent keeps serving; single-slot: the newcomer is refused by name', async () => {
    // --- multi-slot mode: both tabs stay paired ---
    const multi = await liveBridge('multi');
    const first = await connectTab(multi, { origin: 'https://editor.figpea.com' });
    await connectionsWhen(multi, 1, 'first tab pairs');
    const second = await connectTab(multi, { origin: 'http://localhost:8080' });
    const connections = await connectionsWhen(multi, 2, 'second tab pairs alongside the first');

    expect(multi.getSlotMode(), 'the bridge reports which mode it is running').toBe('multi');
    expect(first.closed, 'the incumbent is NOT closed by a second pairing').toBeNull();
    expect(second.closed, 'the newcomer is not closed either — both are served').toBeNull();
    expect(multi.isTabConnected(), 'the bridge still reports a live tab').toBe(true);
    expect(connections.map((c) => c.connectionId), 'each slot carries its own connection id').toEqual(['c1', 'c2']);

    // --- single-slot mode (the default): the newcomer is refused, loudly ---
    const single = await liveBridge('single');
    const incumbent = await connectTab(single, { origin: 'https://editor.figpea.com' });
    await connectionsWhen(single, 1, 'first tab pairs');
    const newcomer = await connectTab(single, { origin: 'http://localhost:8080' });

    const refused = await waitFor(
      () => newcomer.closed,
      (c) => c !== null,
      'the second connection is refused in single-slot mode',
    );
    expect(refused!.code, 'refused with the supersession close code').toBe(CLOSE_CODE_SUPERSEDED);
    expect(incumbent.closed, 'the incumbent keeps its socket — nothing is displaced').toBeNull();
    expect(single.isTabConnected(), 'the bridge still reports the incumbent as connected').toBe(true);
    expect(single.getConnectionDiagnosis().lastEvent, 'and the refusal is named, not silent').toBe('slot_refused');
  });

  it('never reports a tab as connected while the socket it is reporting on has been closed without a refusal', async () => {
    // AC-9's negative form. The forbidden state is the incident exactly: the
    // incumbent's socket is gone, `isTabConnected()` still says yes, and no
    // refusal was recorded — so nothing anywhere says what happened.
    for (const mode of ['multi', 'single'] as const) {
      const bridge = await liveBridge(mode);
      const first = await connectTab(bridge, { origin: 'https://editor.figpea.com' });
      await connectionsWhen(bridge, 1, `first tab pairs (${mode})`);
      await connectTab(bridge, { origin: 'http://localhost:8080' });
      await new Promise((r) => setTimeout(r, 400));

      const diagnosis = bridge.getConnectionDiagnosis();
      expect(diagnosis, `${mode}: the bridge publishes what it observed`).toBeTruthy();
      if (first.closed !== null) {
        // Closing the incumbent is only ever legitimate if it was recorded.
        expect(
          diagnosis.supersededCount > 0 ||
            diagnosis.lastEvent === 'slot_refused' ||
            diagnosis.lastEvent === 'tab_superseded',
          `${mode}: the incumbent socket was closed, so a refusal/supersession must be on the record — saw ${diagnosis.lastEvent} / ${diagnosis.supersededCount}`,
        ).toBe(true);
      } else {
        expect(bridge.isTabConnected(), `${mode}: a live incumbent is reported as connected`).toBe(true);
      }
    }
  });
});

/** AC-5 — pairing a second tab is not a supersession. */
describe('REQ-1492 AC-5 — two tabs pairing is not a supersession', () => {
  it('multi-slot leaves supersededCount at zero and records no supersession token', async () => {
    const bridge = await liveBridge('multi');
    await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    await connectTab(bridge, { origin: 'http://localhost:8080' });
    await connectionsWhen(bridge, 2, 'second tab pairs');

    const count = await waitFor(
      () => bridge.getConnectionDiagnosis().supersededCount,
      (n) => n === 0,
      'no connection was displaced, so supersededCount stays 0',
    );
    expect(count, 'the counter is zero after both pairings').toBe(0);
    const diagnosis = bridge.getConnectionDiagnosis();
    expect(
      ['hello_accepted', 'disconnected'],
      'no supersession/refusal token was recorded for a second legitimate pairing',
    ).toContain(diagnosis.lastEvent);
  });
});

/** AC-3 — the tab that was there first is still the one calls reach. */
describe('REQ-1492 AC-3 — the first tab is still the tab this bridge answers for', () => {
  it('an unaddressed call reaches the first tab and the second tab receives nothing', async () => {
    const bridge = await liveBridge('multi');
    const first = await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    const second = await connectTab(bridge, { origin: 'http://localhost:8080' });
    await connectionsWhen(bridge, 2, 'second tab pairs');

    const activeId = bridge.getConnections().find((c) => c.active)?.connectionId;
    expect(activeId, 'the bridge names which slot it answers for').toBe('c1');

    const callPromise = bridge.callTab('layer', 'create', ['rect', { name: 'via-tab-a' }], 8000);
    await answerCall(first);
    await expect(callPromise).resolves.toEqual({ ok: true, value: { id: 'layer-1' } });

    expect(callFrames(first.frames), 'the call reached the first tab').toHaveLength(1);
    expect(callFrames(second.frames), 'the second tab was not touched').toHaveLength(0);
  });
});

/** AC-4 — each tab has its own document, addressable by its own id. */
describe('REQ-1492 AC-4 — a tab pairs independently and is addressable by its own id', () => {
  it('a call addressed at the second tab reaches only the second tab', async () => {
    const bridge = await liveBridge('multi');
    const first = await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    const second = await connectTab(bridge, { origin: 'http://localhost:8080' });
    const connections = await connectionsWhen(bridge, 2, 'second tab pairs');
    const secondId = connections[1].connectionId;

    const callPromise = bridge.callTab('layer', 'create', ['rect', { name: 'via-tab-b' }], 8000, secondId);
    await answerCall(second);
    await expect(callPromise).resolves.toEqual({ ok: true, value: { id: 'layer-1' } });

    expect(callFrames(second.frames), 'the addressed tab received the call').toHaveLength(1);
    expect(callFrames(first.frames), 'the other tab received nothing — separate documents').toHaveLength(0);
  });

  it('an unknown connection id is refused by name, listing the live ids — never silently routed to another tab', async () => {
    const bridge = await liveBridge('multi');
    const first = await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    const second = await connectTab(bridge, { origin: 'http://localhost:8080' });
    await connectionsWhen(bridge, 2, 'second tab pairs');

    let rejection: unknown;
    try {
      await bridge.callTab('layer', 'create', ['rect', { name: 'lost' }], 3000, 'c99');
    } catch (err) {
      rejection = err;
    }
    expect(rejection, 'addressing a connection that does not exist is an error').toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message, 'the error names the live connection ids so the caller can retry with one of them').toContain('c1');
    expect(message).toContain('c2');

    // The defect class is silent fallback: a write must never be applied to a
    // tab nobody addressed.
    expect(callFrames(first.frames), 'the active tab did not receive a write nobody addressed to it').toHaveLength(0);
    expect(callFrames(second.frames), 'nor did the other tab').toHaveLength(0);
  });
});

/**
 * AC-7 — the default (single-slot) bridge refuses a second connection with a
 * named, actionable reason while the incumbent keeps serving.
 */
describe('REQ-1492 AC-7 — the default bridge refuses the second connection by name', () => {
  it('closes the newcomer with the supersession code and a reason naming the incumbent', async () => {
    const bridge = await liveBridge('single');
    const incumbent = await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    const newcomer = await connectTab(bridge, { origin: 'http://localhost:8080' });

    const refused = await waitFor(
      () => newcomer.closed,
      (c) => c !== null,
      'the second connection is refused in single-slot mode',
    );
    expect(refused!.code).toBe(CLOSE_CODE_SUPERSEDED);
    expect(
      refused!.reason,
      'the reason names WHO holds the slot, so the refused tab is not left guessing',
    ).toMatch(/c1/);
  });

  it('the incumbent keeps receiving calls, and the refusal is published with an action to take', async () => {
    const bridge = await liveBridge('single');
    const incumbent = await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    const newcomer = await connectTab(bridge, { origin: 'http://localhost:8080' });
    await waitFor(() => newcomer.closed, (c) => c !== null, 'the second connection is refused');

    const callPromise = bridge.callTab('session', 'layerTree', [], 8000);
    await answerCall(incumbent);
    await expect(callPromise).resolves.toEqual({ ok: true, value: { id: 'layer-1' } });
    expect(callFrames(incumbent.frames), 'the tab already paired is still the one being served').toHaveLength(1);

    const count = await waitFor(
      () => bridge.getConnectionDiagnosis().supersededCount,
      (n) => n === 1,
      'the refusal increments supersededCount',
    );
    expect(count, 'one connection asked for the slot and did not get it').toBe(1);
    const diagnosis = bridge.getConnectionDiagnosis();
    expect(diagnosis.lastEvent, 'the refusal is a named state, not silence').toBe('slot_refused');
    expect(diagnosis.nextStep.length, 'the state ships the action to take').toBeGreaterThan(0);
    expect(diagnosis.nextStep, 'the action tells the caller which tab holds the bridge').toMatch(/tab/i);
  });
});

/**
 * AC-6 — `status` names the origin and contract version of the tab this bridge
 * is attached to. At the bridge level that means: the slot records the origin
 * from the WebSocket handshake, and when the browser sent no `Origin` header
 * the value is absent — never reconstructed from the pairing URL or `Host`,
 * because a fabricated origin is worse than a missing one.
 */
describe('REQ-1492 AC-6 — the origin comes from the handshake, or is reported unavailable', () => {
  it('records the Origin header the upgrade request carried, and says it came from the handshake', async () => {
    const bridge = await liveBridge('multi');
    await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    const connections = await connectionsWhen(bridge, 1, 'tab with an Origin header pairs');

    expect(connections[0].origin, 'the origin scheme://host:port is published').toBe('https://editor.figpea.com');
    expect(connections[0].originSource, 'and the payload says where that value came from').toBe('handshake');
  });

  it('reports origin null with originSource "absent" when the handshake carried no header — never a fabricated value', async () => {
    const bridge = await liveBridge('multi');
    await connectTab(bridge); // no `origin` option ⇒ no Origin header on the upgrade
    const connections = await connectionsWhen(bridge, 1, 'tab without an Origin header pairs');

    expect(connections[0].origin, 'no header means no origin — the bridge does not invent one').toBeNull();
    expect(
      connections[0].originSource,
      'the key is always present, so a caller can tell "unavailable" from "this build cannot tell you"',
    ).toBe('absent');
  });

  it('each slot reports its own origin and its own contract version', async () => {
    const bridge = await liveBridge('multi');
    await connectTab(bridge, { origin: 'https://editor.figpea.com', version: '2.59.1' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    await connectTab(bridge, { origin: 'http://localhost:8080', version: '2.50.0' });
    await connectionsWhen(bridge, 2, 'second tab pairs');

    const connections = bridge.getConnections();
    expect(connections[0].origin, 'each slot carries the origin of its OWN handshake').toBe('https://editor.figpea.com');
    expect(connections[1].origin).toBe('http://localhost:8080');
    const versions = await waitFor(
      () => bridge.getConnections().map((c) => c.contractVersion),
      (list) => list.every((v) => v !== null),
      'both slots report their own contract version',
    );
    expect(versions, 'two tabs can legitimately run different contract versions').toEqual(['2.59.1', '2.50.0']);
  });
});

/**
 * The hazard the incident's two tabs made real: they ran contract 2.59.1 and
 * 2.50.0, so "which tab am I addressing" and "whose schema am I holding" are
 * separate facts that must move TOGETHER. Selecting a tab that only moved the
 * pointer would keep handing an agent tab A's descriptions for tab B's document
 * — reachable, and the exact shape of the incident.
 */
describe("REQ-1492 — selecting a tab re-publishes THAT tab's contract, never the previous one", () => {
  it('after selecting the second tab, subscribers are handed the second tab\'s manifest', async () => {
    const bridge = await liveBridge('multi');
    const published: any[] = [];
    bridge.onDescribe((m) => published.push(m));

    await connectTab(bridge, { origin: 'https://editor.figpea.com', version: '2.59.1' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    await connectTab(bridge, { origin: 'http://localhost:8080', version: '2.50.0' });
    await connectionsWhen(bridge, 2, 'second tab pairs');

    // The ACTIVE slot's manifest is the one published; pairing a second tab must
    // not quietly swap the tool surface to the tab that is NOT addressed.
    await waitFor(() => published.length, (n) => n >= 1, 'the active tab publishes its manifest');
    expect(JSON.stringify(published[0]), 'the published manifest is the ACTIVE tab\'s').toContain('2.59.1');

    await bridge.selectConnection('c2');
    await waitFor(() => published.length, (n) => n >= 2, 'selecting a tab re-publishes a manifest');

    const republished = JSON.stringify(published[published.length - 1]);
    expect(republished, 'selecting tab B re-publishes B\'s manifest').toContain('2.50.0');
    expect(republished, 'and never keeps describing the previously active tab').not.toContain('2.59.1');
    expect(bridge.getConnections().find((c) => c.active)?.connectionId, 'the pointer moved to B').toBe('c2');
  });

  it('selecting a connection that is no longer paired is refused by name', async () => {
    const bridge = await liveBridge('multi');
    const first = await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    await connectTab(bridge, { origin: 'http://localhost:8080' });
    await connectionsWhen(bridge, 2, 'second tab pairs');
    first.ws.close();
    await waitFor(
      () => bridge.getConnections().map((c) => c.connectionId),
      (list) => list.length === 1,
      'the closed tab leaves the slot registry',
    );

    await expect(bridge.selectConnection('c1'), 'a stale id is refused, never silently ignored').rejects.toBeTruthy();
  });
});

/** When the served tab closes, another must take over — and describe itself. */
describe('REQ-1492 — the longest-paired remaining tab is promoted when the active one closes', () => {
  it('the survivor becomes active, its own manifest is published, and calls reach it', async () => {
    const bridge = await liveBridge('multi');
    const published: any[] = [];
    bridge.onDescribe((m) => published.push(m));

    const first = await connectTab(bridge, { origin: 'https://editor.figpea.com', version: '2.59.1' });
    await connectionsWhen(bridge, 1, 'first tab pairs');
    const second = await connectTab(bridge, { origin: 'http://localhost:8080', version: '2.50.0' });
    await connectionsWhen(bridge, 2, 'second tab pairs');
    await waitFor(() => published.length, (n) => n >= 1, 'the active tab publishes its manifest');

    first.ws.close();
    await waitFor(
      () => bridge.getConnections().map((c) => c.connectionId),
      (list) => list.length === 1 && list[0] === 'c2',
      'the closed slot leaves the registry and the survivor is promoted',
    );
    expect(bridge.getConnections()[0].active, 'the survivor is now the tab being addressed').toBe(true);
    expect(bridge.isTabConnected(), 'and the bridge still reports a live tab').toBe(true);

    await waitFor(() => published.length, (n) => n >= 2, 'promotion re-publishes a manifest');
    expect(
      JSON.stringify(published[published.length - 1]),
      'promotion re-publishes the PROMOTED tab\'s manifest, so the tool surface matches the tab calls reach',
    ).toContain('2.50.0');

    // An unaddressed call now reaches the survivor.
    const callPromise = bridge.callTab('session', 'layerTree', [], 8000);
    await answerCall(second);
    await expect(callPromise).resolves.toEqual({ ok: true, value: { id: 'layer-1' } });
  });
});