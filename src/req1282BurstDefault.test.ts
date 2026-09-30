import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * REQ-1282 T1 — the repro (AC-1, AC-2, AC-4, AC-6).
 *
 * The incident: on a project of ~80 text layers, `layer.create` (and any
 * other method outside the six-entry `DEFAULT_TIMEOUT_TABLE_MS` table) was
 * relayed with a flat 10-second deadline. The editor's render-settle window
 * on a project that size is longer than that, so the relay gave up and
 * reported `bridge_error` **while the tab went on applying the mutation** —
 * the false negative an agent then "fixes" by retrying, silently duplicating
 * the layer.
 *
 * WHAT THIS FILE CAN AND CANNOT REACH. `figpea-mcp` is a relay: it has no
 * browser harness, no Playwright dependency and no fixture editor, so the
 * card's "a person following this cold reproduces it" is modelled at the tab
 * boundary (plan D3). What is modelled with real machinery is the part that
 * is ours — the deadline — and what is modelled as data is the project: a
 * stand-in `ws` tab holding a real array of created layer records, answering
 * `session.find` from it, so the create genuinely lands in the model and the
 * created layer is genuinely findable afterwards. Every frame crosses a real
 * `ws` connection to a real `startBridgeServer()` listener on an
 * OS-assigned ephemeral loopback port.
 *
 * TIMER MECHANICS (spelled out because this repo has never used fake
 * timers, and the seam is real). `vi.useFakeTimers` is installed only AFTER
 * the tab is paired and its `describe` drill has published, so no handshake
 * or drill timer is frozen mid-flight, and only `setTimeout`/`clearTimeout`
 * are faked — `setImmediate`/`nextTick`/`Date` stay real so `ws` message
 * delivery is unaffected. Fake time is advanced explicitly, and real timers
 * are restored in a `finally` (plus `afterEach`) so teardown never runs
 * against a frozen clock.
 *
 * The settle window is a NAMED CONSTANT IN THIS FILE, not in production:
 * the production floor is justified independently (plan D1), and nothing
 * derives one from the other. The budget assertions below use no timers at
 * all, so the red-on-current property of this REQ never rests on the
 * fake-timer seam alone.
 */

import { startBridgeServer } from './bridgeServer';
import { createMcpServer, MAX_CALL_TIMEOUT_MS } from './mcpServer';

/** Modelled editor render-settle cost, per text layer already in the
 * project. 200 ms/layer over 80 layers gives a 16 000 ms window — 1.6x the
 * old flat 10 s deadline, which is exactly why the incident reproduced, and
 * comfortably under the shipped floor. */
const SETTLE_MS_PER_LAYER = 200;

/** The card's project size: ">=80 text layers". */
const PROJECT_LAYER_COUNT = 80;

/** The modelled render-settle window for a project of `n` layers. */
const settleWindowMs = (n: number): number => SETTLE_MS_PER_LAYER * n;

/** The burst's own layers are created under an explicit, generous deadline:
 * the burst establishes PROJECT SIZE, it is not the call under test. */
const BURST_SETUP_TIMEOUT_MS = 5_000;

interface BridgeHandle {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

interface TabLayer {
  id: string;
  name: string;
  kind: string;
}

const DRILL_INDEX = {
  version: '1.8.0',
  session: { find: 'Finds layers.' },
  layer: { create: 'Creates a layer.' },
  errorCodes: ['no_session'],
};

const DRILL_GROUPS: Record<string, unknown> = {
  session: { find: { doc: 'Finds layers by selector.', params: { selector: { kind: 'object' } }, result: 'void' } },
  layer: { create: { doc: 'Creates a layer.', params: { kind: { kind: 'string' }, props: { kind: 'object' } }, result: 'void' } },
};

let activeHandle: BridgeHandle | undefined;
const openSockets: WebSocket[] = [];
const cleanups: Array<() => Promise<void>> = [];

function trackHandle<T extends BridgeHandle>(bridge: T): T {
  activeHandle = bridge;
  return bridge;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  openSockets.length = 0;
  if (activeHandle) {
    await activeHandle.close();
    activeHandle = undefined;
  }
  for (const fn of cleanups.splice(0)) await fn();
});

/**
 * A stand-in editor tab with a real project behind it. `layers` is the
 * model: creates push onto it and `session.find` answers from it, so
 * "the layer exists" is data, not a mock's return value.
 */
async function connectStandInTab(bridge: BridgeHandle): Promise<{
  layers: TabLayer[];
  holdCreates(hold: boolean): void;
  flushHeld(): void;
  nextCallFrame(): Promise<any>;
}> {
  const layers: TabLayer[] = [];
  for (let i = 0; i < PROJECT_LAYER_COUNT; i++) {
    layers.push({ id: `layer-${i + 1}`, name: `row-${i + 1}`, kind: 'text' });
  }

  const described = new Promise<void>((resolve) => {
    // Registered BEFORE connecting: fires once the drill has published, which
    // is also the point at which no drill timer is outstanding.
    bridge.onDescribe(() => resolve());
  });

  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const held: any[] = [];
  const callWaiters: Array<(frame: any) => void> = [];
  let holdCreates = false;

  function answer(frame: any): void {
    if (frame.group === 'layer' && frame.method === 'create') {
      const kind = frame.args[0];
      const props = (frame.args[1] ?? {}) as { name?: string };
      const record: TabLayer = { id: `layer-${layers.length + 1}`, name: String(props.name ?? ''), kind: String(kind ?? '') };
      layers.push(record);
      ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: { ...record } }));
      return;
    }
    if (frame.group === 'session' && frame.method === 'find') {
      const selector = (frame.args[0]?.selector ?? {}) as { name?: string };
      const matches = layers.filter((l) => selector.name == null || l.name === selector.name);
      ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: matches }));
      return;
    }
    ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: null }));
  }

  // Attached BEFORE `hello`, so the drill's describe frames are answered on
  // arrival — the tab has to be able to describe itself the moment it pairs.
  ws.on('message', (data: WebSocket.RawData) => {
    const frame = JSON.parse(data.toString());
    if (frame?.type === 'describe') {
      ws.send(
        JSON.stringify(
          frame.selector === undefined
            ? { type: 'describe_result', manifest: DRILL_INDEX, version: '1.8.0' }
            : { type: 'describe_result', manifest: DRILL_GROUPS[frame.selector], version: '1.8.0' },
        ),
      );
      return;
    }
    if (frame?.type !== 'call') return;
    for (const waiter of callWaiters.splice(0)) waiter(frame);
    // A held create is the editor still settling: the tab has not answered
    // yet, which is the whole point of the reproduction.
    if (frame.group === 'layer' && frame.method === 'create' && holdCreates) {
      held.push(frame);
      return;
    }
    answer(frame);
  });

  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  await expect
    .poll(() => bridge.isTabConnected(), { timeout: 3000 })
    .toBe(true);
  await described;

  return {
    layers,
    holdCreates(hold: boolean) {
      holdCreates = hold;
    },
    flushHeld() {
      for (const frame of held.splice(0)) answer(frame);
    },
    nextCallFrame() {
      return new Promise<any>((resolve) => callWaiters.push(resolve));
    },
  };
}

// ── the real MCP lane, for the timer-free budget assertions ──────────────────

interface BridgeStub {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

const BURST_MANIFEST = {
  session: { find: { doc: 'Finds layers by selector.', params: { selector: { type: 'object', required: true } }, result: {} } },
  layer: {
    create: {
      doc: 'Creates a layer.',
      params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } },
      result: {},
    },
  },
};

function capturingBridge() {
  const captured: Array<{ name: string; args: unknown[]; timeoutMs?: number }> = [];
  const bridge: BridgeStub = {
    port: 54321,
    token: 'test-token-abc',
    isTabConnected: () => true,
    onDescribe: (handler) => handler(BURST_MANIFEST),
    callTab: async (group, method, args, timeoutMs) => {
      captured.push({ name: `${group}_${method}`, args, timeoutMs });
      return { ok: true, value: null };
    },
    close: async () => {},
  };
  return { bridge, captured };
}

async function connectedClient(bridge: BridgeStub, options?: { toolMode?: 'compact' | 'full' }) {
  const server = createMcpServer(bridge, options as any);
  const client = new Client({ name: 'req-1282-burst-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((c) => c.type === 'text')!.text!);
}

describe('REQ-1282 — an 80-layer burst: the next layer.create with no _timeoutMs (AC-1, AC-2, AC-6)', () => {
  it('survives its own modelled settle window, returns ok:true, and the created layer is findable afterwards', async () => {
    const bridge = trackHandle(await startBridgeServer());
    const tab = await connectStandInTab(bridge);

    // The project: PROJECT_LAYER_COUNT text layers created back-to-back
    // through the REAL relay, so the tab's model really holds them.
    for (let i = 0; i < PROJECT_LAYER_COUNT; i++) {
      const created = await bridge.callTab('layer', 'create', ['text', { name: `burst-row-${i + 1}` }], BURST_SETUP_TIMEOUT_MS);
      expect(created, `burst layer ${i + 1} was created`).toEqual({ ok: true, value: expect.anything() });
    }
    expect(tab.layers.length, 'the stand-in project really grew').toBe(PROJECT_LAYER_COUNT * 2);

    // The call under test: NO _timeoutMs anywhere on the path, which is
    // exactly AC-2's shape.
    tab.holdCreates(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      const decisive = bridge.callTab('layer', 'create', ['text', { name: 'cat-label' }]);
      // Attached immediately, and recorded rather than awaited, so a relay
      // deadline that fires early is OBSERVABLE instead of surfacing as an
      // unhandled rejection.
      decisive.then(
        () => {
          outcome = 'resolved';
        },
        () => {
          outcome = 'rejected';
        },
      );

      const frame = await tab.nextCallFrame();
      expect(frame.args[1]?.name, 'the untimed create reached the editor').toBe('cat-label');

      // The editor is still settling. Advance 1 ms short of the modelled
      // window: a deadline shorter than the work must not have fired.
      const window = settleWindowMs(PROJECT_LAYER_COUNT);
      await vi.advanceTimersByTimeAsync(window - 1);
      expect(
        outcome,
        `the relay deadline must outlive the editor's render-settle window (${window}ms) — a shorter deadline reports a create that the editor is still applying`,
      ).toBe('pending');

      // The editor finishes and answers; the call resolves normally.
      tab.flushHeld();
      await expect(decisive, 'the untimed create resolves ok:true once the editor has applied it').resolves.toEqual({
        ok: true,
        value: expect.objectContaining({ name: 'cat-label', kind: 'text' }),
      });
    } finally {
      vi.useRealTimers();
    }

    // AC-1's observable shape, kept after the fix: the mutation really was
    // applied, and the cheap state check the error text recommends finds it.
    const found = await bridge.callTab('session', 'find', [{ selector: { name: 'cat-label' } }]);
    expect(found, 'the created layer is findable, so a "check state" round trip resolves the ambiguity').toEqual({
      ok: true,
      value: [expect.objectContaining({ name: 'cat-label', kind: 'text' })],
    });
  });
});

describe('REQ-1282 — the deadline a no-override call actually gets (AC-2, AC-4), no timers involved', () => {
  it('outlives the modelled settle window in BOTH tool modes, and stays under the cap', async () => {
    const window = settleWindowMs(PROJECT_LAYER_COUNT);

    const full = capturingBridge();
    const fullClient = await connectedClient(full.bridge, { toolMode: 'full' });
    await callToolJson(fullClient, 'layer_create', { kind: 'text', props: { name: 'cat-label' } });
    const fullDeadline = full.captured[0].timeoutMs;
    expect(typeof fullDeadline, 'full mode resolves a number, not "no explicit timeout"').toBe('number');
    expect(
      fullDeadline as number,
      `full mode: a layer.create with no _timeoutMs must be allowed at least the modelled settle window (${window}ms)`,
    ).toBeGreaterThanOrEqual(window);
    expect(fullDeadline as number, 'and the default must stay under the clamp, or the cap is vacuous').toBeLessThanOrEqual(MAX_CALL_TIMEOUT_MS);

    const compact = capturingBridge();
    const compactClient = await connectedClient(compact.bridge, { toolMode: 'compact' });
    await callToolJson(compactClient, 'figpea_call', { group: 'layer', method: 'create', args: ['text', { name: 'cat-label' }] });
    const compactDeadline = compact.captured[0].timeoutMs;
    expect(typeof compactDeadline, 'compact mode resolves a number, not "no explicit timeout"').toBe('number');
    expect(
      compactDeadline as number,
      `compact mode: figpea_call layer.create with no _timeoutMs must be allowed at least the modelled settle window (${window}ms)`,
    ).toBeGreaterThanOrEqual(window);
  });

  it('AC-4: an explicit _timeoutMs is still honoured, still clamped at the cap, and agrees with the default at the ceiling', async () => {
    const { bridge, captured } = capturingBridge();
    const client = await connectedClient(bridge, { toolMode: 'full' });

    await callToolJson(client, 'layer_create', { kind: 'text', props: { name: 'a' }, _timeoutMs: 60_000 });
    await callToolJson(client, 'layer_create', { kind: 'text', props: { name: 'b' }, _timeoutMs: 999_999_999 });
    await callToolJson(client, 'layer_create', { kind: 'text', props: { name: 'c' }, _timeoutMs: 5_000 });
    await callToolJson(client, 'layer_create', { kind: 'text', props: { name: 'd' } });

    expect(captured[0].timeoutMs, 'an in-range override is honoured verbatim').toBe(60_000);
    expect(captured[1].timeoutMs, 'an over-cap override clamps to the cap instead of being rejected').toBe(MAX_CALL_TIMEOUT_MS);
    expect(captured[2].timeoutMs, 'AC-4: an override shorter than the default is honoured too — raising the floor does not take the knob away').toBe(5_000);
    expect(typeof captured[3].timeoutMs, 'the no-override default resolves to a number, like every other branch').toBe('number');
    expect(
      captured[3].timeoutMs as number,
      'AC-4: omitting _timeoutMs and passing it agree, and the ceiling is the only thing between them',
    ).toBeLessThanOrEqual(MAX_CALL_TIMEOUT_MS);
  });
});
