import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import WebSocket from 'ws';

import { startBridgeServer } from './bridgeServer';
import { createMcpServer } from './mcpServer';
import { CONNECTION_EVENTS } from './connectionDiagnosis';

/**
 * REQ-1492 T4 — what an AGENT reads, driven the way an agent reads it
 * (AC-1, AC-4, AC-6, AC-7, AC-8).
 *
 * The harness is this package's strongest tier: a real `startBridgeServer()`
 * listener on an OS-assigned port, real `ws` clients standing in for editor
 * tabs, and a real `McpServer` reached through a real MCP `Client` over
 * `InMemoryTransport`. Every assertion is about a JSON payload or a
 * `tools/list` name — the two things an agent actually consumes.
 *
 * WHAT IS PINNED, in the ACs' own words:
 *
 *  - AC-1 — one tab paired: `tabConnected` is true and `lastEvent` is
 *    `hello_accepted`.
 *  - AC-2 / AC-6 — a second tab appears in `connections` with its own id,
 *    origin and contract version; `activeConnectionId` still names the first;
 *    `status.tab` names the tab the call is answered for; and `originSource` is
 *    published on `tab` and on EVERY connection entry, as `handshake` when the
 *    upgrade request carried an `Origin` header and `absent` when it did not —
 *    never a missing key, never a fabricated origin.
 *  - AC-4 — `select_tab` moves the pointer, the next call reaches the selected
 *    tab, and the manifest re-published to subscribers is THAT tab's (two tabs on
 *    deliberately different contract versions, so a stale re-publication fails).
 *  - AC-7 — the single-slot refusal is published: `slot_refused`, its
 *    `nextStep`, and an incremented `supersededCount`, with the incumbent still
 *    connected.
 *  - AC-8 — the compat row. With one tab, every pre-existing `status` key is
 *    present with its existing type and meaning, AND the default bridge's tool
 *    list is exactly what it was: `select_tab` is absent in single-slot mode
 *    (there is nothing to select) and present in multi-slot mode. Both halves
 *    are asserted because the README and the site docs promise exactly that
 *    condition — so the mode gate is pinned by the REQ's own test rather than
 *    only by six pre-existing list assertions that would fail if it leaked.
 */

type BridgeMode = 'single' | 'multi';

vi.setConfig({ testTimeout: 30_000 });

interface TabClient {
  ws: WebSocket;
  callFrames: any[];
  closed: { code: number; reason: string } | null;
}

/**
 * The AGENT-ISSUED frames this tab received — every relayed contract-tool call,
 * excluding the bridge's own bounded `session.document` probe.
 *
 * REQ-1451 added that probe to `status`, which is why this selector exists.
 * `callFrames[0]` used to mean "the first call this tab saw" and was correct by
 * accident, because `status` never called the tab at all. It now reads the
 * probe, so an index-based wait answers the wrong `id` and the awaited
 * `figpea_call` never resolves. Selecting by the frame a real call carries is
 * STRICTER than indexing: it asserts WHICH call reached the tab, not merely that
 * some frame did.
 *
 * `session.document` is excluded because it is a READ, and REQ-1451's guard
 * deliberately never guards reads — the assertions below are about writes and
 * about which tab they reach, which is what AC-4 and AC-7 are about.
 */
function agentCalls(tab: TabClient): any[] {
  return tab.callFrames.filter((f) => !(f.group === 'session' && f.method === 'document'));
}

/** True when every frame the tab received is the bridge's own read probe. */
function onlyDocumentProbes(tab: TabClient): boolean {
  return tab.callFrames.every((f) => f.group === 'session' && f.method === 'document');
}

const openBridges: Array<{ close(): Promise<void> }> = [];
const openSockets: WebSocket[] = [];
const cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  openSockets.length = 0;
  for (const bridge of openBridges.splice(0)) await bridge.close().catch(() => {});
  for (const fn of cleanupFns.splice(0)) await fn().catch(() => {});
});

async function liveBridge(slots?: BridgeMode) {
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

/**
 * Polls `probe` until `ok` holds, awaiting an async probe and retrying through a
 * THROW as well as a false — a probe that cannot run yet is "not yet", not
 * "failed", so the test still reports the state it actually observed instead of
 * a stack trace from the first attempt.
 */
async function waitFor<T>(
  probe: () => T | Promise<T>,
  ok: (value: T) => boolean,
  label: string,
  timeoutMs = 6000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
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

/**
 * One stand-in editor tab. `origin` is the HTTP `Origin` header on the upgrade
 * request — `ws` sends none unless asked to, which is what makes the
 * `originSource: "absent"` case a real observation rather than a mock.
 */
async function connectTab(
  bridge: { port: number; token: string },
  options?: { origin?: string; version?: string },
): Promise<TabClient> {
  const version = options?.version ?? '2.59.1';
  const ws = options?.origin
    ? new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: options.origin })
    : new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await waitForOpen(ws);

  const tab: TabClient = { ws, callFrames: [], closed: null };
  // Each stand-in tab answers `session.document` with its OWN identity, keyed on
  // its origin, so two tabs in one bridge are observably two documents.
  const documentId = `doc-${options?.origin ?? 'default'}`;
  ws.on('message', (data: WebSocket.RawData) => {
    let frame: any;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame?.type === 'call') {
      tab.callFrames.push(frame);
      // REQ-1451: `status` now makes ONE bounded tab-side read of its own,
      // `session.document`, on every call it serves. A real editor answers that
      // from its live project, so this fake tab answers it too — and it is
      // recorded in `callFrames` like any other call, because hiding it would
      // let the routing assertions below pass for the wrong reason: `callFrames[0]`
      // used to be the first frame a tab saw, and it is now a `status` probe.
      if (frame.group === 'session' && frame.method === 'document') {
        ws.send(
          JSON.stringify({
            type: 'result',
            id: frame.id,
            ok: true,
            value: { documentId, documentName: 'Untitled design' },
          }),
        );
        return;
      }
    }
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

/** The full descriptors, grouped the way `drillManifest` reassembles them.
 *  `layer.create` declares one positional parameter, so a real `layer_create`
 *  call validates against it — a zero-param fixture would make REQ-1296's
 *  arg-shape guard reject the call before it ever reaches the bridge, and the
 *  routing claim under test would go unproven. */
function drillGroups(version: string): unknown {
  return {
    session: { openFile: { doc: `Opens a design file (contract ${version}).`, params: {}, result: 'void' } },
    layer: {
      create: {
        doc: `Creates a layer (contract ${version}).`,
        params: { kind: { type: 'string', required: true } },
        result: 'string',
      },
    },
  };
}

async function connectedClient(bridge: unknown, options?: Record<string, unknown>): Promise<Client> {
  const server = createMcpServer(bridge as never, options as never);
  const client = new Client({ name: 'req-1492-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanupFns.push(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, `${name} returns a text content block`).toBeDefined();
  return JSON.parse(textBlock!.text!);
}

async function statusOf(client: Client): Promise<any> {
  return callToolJson(client, 'status');
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

/** Pairs one tab and waits until `status` reports it. */
async function pairedStatus(bridge: any, client: Client, options?: { origin?: string; version?: string }) {
  await connectTab(bridge, options);
  return waitFor(
    () => statusOf(client),
    (s: any) => s.connections.length >= 1 && s.connections[0].contractVersion !== null,
    'the tab pairs and its contract version is published',
  );
}

describe('REQ-1492 AC-1 — one tab paired reads exactly as it did before', () => {
  it('reports tabConnected true and lastEvent hello_accepted', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const status = await pairedStatus(bridge, client, { origin: 'https://editor.figpea.com' });

    expect(status.tabConnected, 'AC-1: a paired tab is reported connected').toBe(true);
    expect(status.connection.lastEvent, 'AC-1: and the pairing is named').toBe('hello_accepted');
  });
});

describe('REQ-1492 AC-2 / AC-6 — status names the tab, and every paired connection', () => {
  it('lists both tabs with their own ids, origins and contract versions, and still answers for the first', async () => {
    const bridge = await liveBridge('multi');
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    await connectTab(bridge, { origin: 'https://editor.figpea.com', version: '2.59.1' });

    const withOne = await waitFor(
      () => statusOf(client),
      (s: any) => s.connections.length === 1 && s.connections[0].contractVersion !== null,
      'the first tab is published',
    );
    expect(withOne.activeConnectionId, 'the first tab to pair is the active one').toBe('c1');
    expect(withOne.tab.connectionId, 'and `tab` names that same tab (AC-6)').toBe('c1');
    expect(withOne.tab.origin, 'with the origin its handshake carried').toBe('https://editor.figpea.com');
    expect(withOne.tab.originSource).toBe('handshake');
    expect(withOne.contractVersion, 'the pre-existing top-level key is now the ACTIVE tab\'s').toBe('2.59.1');

    await connectTab(bridge, { origin: 'http://localhost:8080', version: '2.50.0' });
    const withTwo = await waitFor(
      () => statusOf(client),
      (s: any) => s.connections.length === 2 && s.connections[1].contractVersion !== null,
      'the second tab is published beside the first',
    );

    expect(withTwo.tabConnected, 'the second pairing does not make the first look gone').toBe(true);
    expect(withTwo.activeConnectionId, 'AC-3: a later tab does not steal the pointer').toBe('c1');
    expect(
      withTwo.connections.map((c: any) => c.connectionId),
      'each paired tab has its own id',
    ).toEqual(['c1', 'c2']);
    expect(withTwo.connections.map((c: any) => c.origin), 'each carries its OWN origin').toEqual([
      'https://editor.figpea.com',
      'http://localhost:8080',
    ]);
    expect(withTwo.connections.map((c: any) => c.contractVersion), 'and its own contract version').toEqual([
      '2.59.1',
      '2.50.0',
    ]);
    expect(withTwo.connections.map((c: any) => c.active), 'exactly one is active').toEqual([true, false]);
    expect(
      withTwo.connections.every((c: any) => c.originSource === 'handshake'),
      'AC-6: originSource is published on every connection entry, never omitted',
    ).toBe(true);
    expect(typeof withTwo.connections[0].pairedAt, 'and each slot says when it paired').toBe('string');
  });

  it('publishes origin null with originSource "absent" for a tab whose handshake carried no header', async () => {
    const bridge = await liveBridge('multi');
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    await connectTab(bridge); // no Origin header on the upgrade

    const status = await waitFor(
      () => statusOf(client),
      (s: any) => s.connections.length === 1,
      'the header-less tab pairs',
    );
    expect(status.tab.origin, 'no header means no origin — the bridge never invents one').toBeNull();
    expect(
      status.tab.originSource,
      'and the key is present saying so, so "unavailable" is distinguishable from "this build cannot tell you"',
    ).toBe('absent');
    expect(status.connections[0].origin).toBeNull();
    expect(status.connections[0].originSource).toBe('absent');
  });

  it('says which mode the bridge is serving, so a reader can tell why a tool is missing', async () => {
    const single = await liveBridge();
    const singleStatus = await statusOf(await connectedClient(single, { toolMode: 'compact' }));
    expect(singleStatus.bridgeSlots, 'the mode is published, not implicit').toBe('single');

    const multi = await liveBridge('multi');
    const multiStatus = await statusOf(await connectedClient(multi, { toolMode: 'compact' }));
    expect(multiStatus.bridgeSlots).toBe('multi');
  });
});

describe('REQ-1492 AC-4 — select_tab moves the pointer AND re-describes the selected tab', () => {
  it('moves the pointer, routes the next call to the selected tab, and re-publishes THAT tab\'s contract', async () => {
    const bridge = await liveBridge('multi');
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const first = await connectTab(bridge, { origin: 'https://editor.figpea.com', version: '2.59.1' });
    await waitFor(
      () => statusOf(client),
      (s: any) => s.connections.length === 1 && s.connections[0].contractVersion !== null,
      'the first tab is published',
    );
    const second = await connectTab(bridge, { origin: 'http://localhost:8080', version: '2.50.0' });
    await waitFor(
      () => statusOf(client),
      (s: any) => s.connections.length === 2 && s.connections[1].contractVersion !== null,
      'the second tab is published',
    );

    // Selecting is a real tool call, driven the way an agent drives it.
    const selected = await callToolJson(client, 'select_tab', { connectionId: 'c2' });
    expect(selected, 'the call succeeds').toMatchObject({ ok: true });

    const afterSelect = await statusOf(client);
    expect(afterSelect.activeConnectionId, 'the pointer moved to tab B').toBe('c2');
    expect(afterSelect.tab.connectionId, 'and `tab` now describes tab B').toBe('c2');
    expect(afterSelect.tab.origin).toBe('http://localhost:8080');
    expect(afterSelect.contractVersion, 'the top-level contract version follows the addressed tab').toBe('2.50.0');

    // The next unaddressed call reaches tab B only — tab A's document is a
    // different document, and must not receive a write nobody sent it.
    const callPromise = client.callTool({ name: 'figpea_call', arguments: { group: 'layer', method: 'create', args: ['rect'] } });
    const frame = await waitFor(
      () => agentCalls(second)[0],
      (f) => f !== undefined,
      'the call frame reaches the selected tab',
    );
    expect(frame, 'and it is the layer.create this test issued').toMatchObject({ group: 'layer', method: 'create' });
    second.ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: { id: 'layer-b' } }));
    const result = await callPromise;
    expect((result as any).content[0].text).toContain('layer-b');
    // Tab A is not addressed any more, so no AGENT-ISSUED call reaches it — the
    // write went to the selected tab only. `status`'s own `session.document` READ
    // may still have reached it (that is what `status` does, and a read is never
    // guarded), so this asserts the stronger, more specific thing rather than the
    // old accidental one: nothing tab A received was anything but that read.
    expect(agentCalls(first), 'tab A received no agent-issued call — its document is untouched').toHaveLength(0);
    expect(onlyDocumentProbes(first), 'and every frame it did receive was `status`\'s own document read').toBe(true);

    // The registered tool surface must describe the tab calls now reach. With two
    // deliberately different contract versions, a stale re-publication is visible.
    const described = await callToolJson(client, 'figpea_describe', { group: 'layer' });
    expect(
      JSON.stringify(described),
      'the manifest re-published by select_tab is the SELECTED tab\'s, not the previously active one',
    ).toContain('2.50.0');
    expect(JSON.stringify(described)).not.toContain('2.59.1');
  });

  it('refuses an unknown connection id by name, listing the live ones', async () => {
    const bridge = await liveBridge('multi');
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    await waitFor(() => statusOf(client), (s: any) => s.connections.length === 1, 'the first tab is published');

    const result = await callToolJson(client, 'select_tab', { connectionId: 'c99' });
    expect(result.ok, 'selecting a connection that does not exist fails rather than silently doing nothing').toBe(false);
    expect(String(result.message ?? ''), 'and names the live ids').toContain('c1');
    const after = await statusOf(client);
    expect(after.activeConnectionId, 'the pointer did not move').toBe('c1');
  });
});

describe('REQ-1492 AC-7 — the refusal is published on the same payload as every other event', () => {
  it('names slot_refused, ships its action, counts it, and leaves the incumbent connected', async () => {
    const bridge = await liveBridge('single');
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const incumbent = await connectTab(bridge, { origin: 'https://editor.figpea.com' });
    await waitFor(() => statusOf(client), (s: any) => s.tabConnected === true, 'the first tab is paired');

    const newcomer = await connectTab(bridge, { origin: 'http://localhost:8080' });
    const status = await waitFor(
      () => statusOf(client),
      (s: any) => s.connection.lastEvent === 'slot_refused',
      'the refusal is published under its own name',
    );

    expect(status.connection.supersededCount, 'a connection that asked for the slot and did not get it is counted').toBe(1);
    expect(status.connection.nextStep.length, 'with the action to take').toBeGreaterThan(0);
    expect(status.connection.nextStep, 'naming the tab that holds the bridge and the knob to opt in').toMatch(
      /another tab/i,
    );
    expect(status.tabConnected, 'the incumbent is STILL connected — nothing was displaced').toBe(true);
    expect(status.connections.map((c: any) => c.connectionId), 'and still holds the only slot').toEqual(['c1']);
    await waitFor(() => newcomer.closed, (c) => c !== null, 'the newcomer is closed by the bridge');

    // The incumbent is still the one being served.
    const callPromise = client.callTool({ name: 'figpea_call', arguments: { group: 'session', method: 'layerTree', args: [] } });
    const frame = await waitFor(
      () => agentCalls(incumbent)[0],
      (f) => f !== undefined,
      'the incumbent still receives relayed calls',
    );
    expect(frame, 'and it is the session.layerTree this test issued').toMatchObject({
      group: 'session',
      method: 'layerTree',
    });
    incumbent.ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: { id: 'root' } }));
    await callPromise;
  });
});

describe('REQ-1492 AC-8 — the single-tab flow and its tool list are unchanged', () => {
  it('every pre-existing status key is present, with its existing type and meaning', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    await connectTab(bridge, { origin: 'https://editor.figpea.com', version: '2.59.1' });
    const status = await waitFor(
      () => statusOf(client),
      (s: any) => s.tabConnected === true && s.contractVersion !== null,
      'one tab is paired and described',
    );

    // Every key `status` shipped before REQ-1492, with the type and meaning it
    // had. `connection`/`build`/`buildStale` are REQ-1394's and REQ-1457's and are
    // asserted for shape only — this row is AC-8, the pre-existing single-tab flow.
    expect(status.port, 'the bound port').toBe(bridge.port);
    expect(status.token, 'the pairing token').toBe(bridge.token);
    expect(status.url).toContain(`bridgePort=${bridge.port}`);
    expect(status.url).toContain(`bridgeToken=${bridge.token}`);
    expect(status.tabConnected).toBe(true);
    expect(status.contractVersion, 'the connected tab\'s version, unchanged with one tab').toBe('2.59.1');
    expect(status.toolCount, 'compact mode registers no contract tools').toBe(0);
    expect(typeof status.connection.lastEvent).toBe('string');
    expect(typeof status.connection.supersededCount).toBe('number');
    expect(typeof status.build.version).toBe('string');
    expect(typeof status.buildStale).toBe('boolean');
  });

  it('select_tab is ABSENT on the default single-slot bridge and PRESENT in multi-slot mode', async () => {
    // Both halves, because the README and the site docs promise exactly this
    // condition: the tool exists only where there is something to select. An
    // unconditional registration would be a tool that refuses on the default
    // flow every existing consumer uses.
    const single = await liveBridge();
    const singleNames = await toolNames(await connectedClient(single, { toolMode: 'compact' }));
    expect(singleNames, 'the default bridge\'s tool list is exactly what it was').toEqual([
      'figpea_call',
      'figpea_describe',
      'figpea_skill',
      'open_editor',
      'status',
    ]);
    expect(singleNames, 'no select_tab on the default bridge').not.toContain('select_tab');

    const multi = await liveBridge('multi');
    const multiNames = await toolNames(await connectedClient(multi, { toolMode: 'compact' }));
    expect(multiNames, 'multi-slot mode adds exactly one tool').toEqual([
      'figpea_call',
      'figpea_describe',
      'figpea_skill',
      'open_editor',
      'select_tab',
      'status',
    ]);
  });

  it('the select_tab description states the condition it is registered under', async () => {
    // An agent that reads the tool's own description must not be told it is
    // unconditional — the README and docs both state the gate, so the tool's own
    // text has to agree with them.
    const multi = await liveBridge('multi');
    const client = await connectedClient(multi, { toolMode: 'compact' });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'select_tab');
    expect(tool, 'select_tab is registered in multi-slot mode').toBeDefined();
    expect(tool!.description ?? '').toMatch(/multi-slot/i);
    expect(tool!.description ?? '', 'and does not claim to be always available').not.toMatch(/always registered/i);
  });

  it('the status description enumerates the lastEvent vocabulary the payload can actually report', async () => {
    // F1 from code-review round 1. The description ENUMERATES the tokens, so it is
    // a promise about the payload's vocabulary rather than prose about it — and
    // REQ-1492 made `slot_refused` reachable. A description that lists seven of
    // the eight tells a reader the refusal does not exist, while the README table
    // and the payload's own `nextStep` both say it does.
    //
    // Asserted against `CONNECTION_EVENTS` rather than a copied list, so a future
    // token cannot be added without this turning red.
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const { tools } = await client.listTools();
    const status = tools.find((t) => t.name === 'status');
    expect(status, 'the status tool is registered').toBeDefined();
    const description = status!.description ?? '';

    // The description ENUMERATES the tokens, in a parenthesised list, so it is a
    // promise about the payload's vocabulary rather than prose about it. Read that
    // list back and compare it as a SET against the vocabulary the payload can
    // actually report — comparing token-by-token with `toContain` would fail on
    // the first miss and hide WHICH token is missing, which is the whole finding.
    const enumeration = /`lastEvent`\s*\(([^)]*)\)/.exec(description);
    expect(
      enumeration,
      'the status description enumerates the lastEvent vocabulary in a parenthesised list',
    ).not.toBeNull();
    const listed = new Set(
      enumeration![1]
        .split(',')
        .map((t) => t.trim().replace(/`/g, ''))
        .filter((t) => /^[a-z_]+$/.test(t)),
    );

    const missing = CONNECTION_EVENTS.filter((t) => !listed.has(t));
    expect(
      missing,
      `the status description omits lastEvent token(s) the payload can report: ${missing.join(', ')}`,
    ).toEqual([]);
    const extra = [...listed].filter((t) => !CONNECTION_EVENTS.includes(t as never));
    expect(extra, `the status description names token(s) the payload cannot report: ${extra.join(', ')}`).toEqual([]);
  });

  it('a stub bridge without the new seams renders the legacy single-connection shape, not a missing key', async () => {
    // ~45 test files satisfy `BridgeServerHandleLike` with their own stub, so the
    // new members are optional by construction. A caller holding such a stub must
    // get the legacy shape rather than a payload with keys missing.
    const stub = {
      port: 4242,
      token: 'stub-token',
      isTabConnected: () => true,
      onDescribe: () => {},
      callTab: async () => ({ ok: true, value: null }),
      close: async () => {},
      getContractVersion: () => '2.59.1',
    };
    const status = await statusOf(await connectedClient(stub, { toolMode: 'compact' }));
    expect(status.connections, 'the legacy shape still lists a connection').toEqual([
      // Every key present, and every value the honest one: a bridge that cannot
      // report its slots cannot tell where its tab came from (never a fabricated
      // origin) nor when it paired — so both say so rather than guessing.
      { connectionId: 'c1', origin: null, originSource: 'absent', contractVersion: '2.59.1', pairedAt: null, active: true },
    ]);
    expect(status.activeConnectionId, 'and names which one is being answered for').toBe('c1');
    expect(status.bridgeSlots, 'defaulting to the mode such a build is actually serving').toBe('single');
  });
});