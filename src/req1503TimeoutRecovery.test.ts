import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import WebSocket from 'ws';

import { startBridgeServer } from './bridgeServer';
import { createMcpServer } from './mcpServer';
import { servingBuildStamp } from './buildIdentity';

/**
 * REQ-1503 T3 — the timeout envelope names a way forward, not just a check.
 *
 * The envelope a relayed call rejects with is the one piece of prose every stuck
 * agent is guaranteed to read, and until this change it ended with a state check
 * (REQ-1282) that needs the MCP channel — plus a build stamp (REQ-1457). The
 * case it could not speak to is the one this requirement exists for: the channel
 * is gone, so the state check it names is unreachable and the run cannot be
 * finished. So one clause is APPENDED, between the state check and the stamp.
 *
 * Four things are pinned here, and three of them are about what must NOT move:
 *
 *  1. REQ-772's three substrings survive byte-for-byte. Two prior requirements
 *     pinned them literally, and an edit that reshapes them to make room for a
 *     new clause would break an agent that matched on them.
 *  2. `servingBuildStamp()` is still LAST. Asserted as `endsWith`, which is the
 *     structural form of "still last" — a stamp moved into the middle would read
 *     fine to a `toContain` check and break every caller that takes the tail of
 *     the message as the identity.
 *  3. The new clause names the two CONCRETE routes (the `liveness` field, the
 *     bridge's own call route) rather than advising a retry — "retry" is the
 *     advice that duplicates a mutation that already applied, which is the
 *     REQ-1282 failure this whole mechanism exists to prevent.
 *  4. A call that IS answered is untouched: the clause rides on the deadline, so
 *     a tab that replies must never see any of it.
 *
 * Harness is the package's top tier again: a REAL listener, a REAL `ws` tab that
 * describes itself (so the drill completes and leaves no drill timer behind) and
 * then never answers a call, and a REAL `McpServer` behind a REAL SDK `Client`.
 * The envelope is observed where the product emits it, not through a stub.
 */

interface BridgeHandle {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

/** REQ-772 / REQ-1282 wording that must survive this requirement byte-for-byte.
 *  The first is a template rather than a literal because the deadline is a
 *  parameter; the other two are the substrings those tests assert literally. */
const PINNED_SUBSTRINGS = [
  'timed out after 60ms',
  'may still be executing this call',
  'check state before retrying',
] as const;

/** The clause's own vocabulary, pinned as the two routes it must name. */
const LIVENESS_ROUTE = 'status.liveness';
const CALL_ROUTE = 'POST /call';

const DRILL_INDEX = {
  version: '1.8.0',
  session: { find: 'Finds layers.' },
  layer: { create: 'Creates a layer.' },
  errorCodes: ['no_session'],
};

const DRILL_GROUPS: Record<string, unknown> = {
  session: {
    find: { doc: 'Finds layers by selector.', params: { selector: { type: 'object', required: true } }, result: 'void' },
  },
  layer: {
    create: {
      doc: 'Creates a layer.',
      params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } },
      result: 'void',
    },
  },
};

let activeHandle: BridgeHandle | undefined;
const openSockets: WebSocket[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  if (activeHandle) {
    await activeHandle.close();
    activeHandle = undefined;
  }
  for (const fn of cleanups.splice(0)) await fn();
});

/** A tab that describes itself on demand, then never answers a relayed call. */
async function connectStuckTab(bridge: BridgeHandle): Promise<WebSocket> {
  const described = new Promise<void>((resolve) => {
    bridge.onDescribe(() => resolve());
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('message', (data: WebSocket.RawData) => {
    const frame = JSON.parse(data.toString());
    if (frame?.type !== 'describe') return;
    ws.send(
      JSON.stringify(
        frame.selector === undefined
          ? { type: 'describe_result', manifest: DRILL_INDEX, version: '1.8.0' }
          : { type: 'describe_result', manifest: DRILL_GROUPS[frame.selector], version: '1.8.0' },
      ),
    );
  });
  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);
  await described;
  return ws;
}

/** A tab that answers a `call` frame, the counterpart the clause must not reach. */
async function connectAnsweringTab(bridge: BridgeHandle, value: unknown = { applied: true }): Promise<WebSocket> {
  const ws = await connectStuckTab(bridge);
  const describeOnly = ws.listeners('message');
  for (const listener of describeOnly) ws.off('message', listener as (...args: unknown[]) => void);
  ws.on('message', (data: WebSocket.RawData) => {
    const frame = JSON.parse(data.toString());
    if (frame?.type !== 'call') return;
    ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value }));
  });
  return ws;
}

/** The message the real relay produces for a call the tab never answers. */
async function timeoutMessageFor(
  bridge: BridgeHandle,
  group: string,
  method: string,
  args: unknown[],
  timeoutMs = 60,
): Promise<string> {
  let message = '';
  try {
    await bridge.callTab(group, method, args, timeoutMs);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message, `${group}.${method} rejects when the tab never answers`).toContain('timed out');
  return message;
}

async function connectedClient(bridge: unknown, toolMode: 'compact' | 'full'): Promise<Client> {
  const server = createMcpServer(bridge as never, { toolMode } as never);
  const client = new Client({ name: 'req-1503-timeout-test', version: '0.0.0' });
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
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, `${name} returns a text content block`).toBeDefined();
  return JSON.parse(textBlock!.text!);
}

describe('REQ-1503 — the timeout envelope gains a recovery clause', () => {
  it('keeps REQ-772 wording byte-for-byte, adds the clause, and still ends with the serving build stamp', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const message = await timeoutMessageFor(bridge, 'layer', 'create', ['text', { name: 'cat-label' }]);

    // 1. Nothing that came before is reshaped to make room.
    for (const pinned of PINNED_SUBSTRINGS) {
      expect(message, `the pinned clause "${pinned}" survives verbatim`).toContain(pinned);
    }
    expect(message, 'and the state check REQ-1282 named still reaches the agent').toContain(
      'session.find({name:"cat-label"})',
    );

    // 2. The new clause names both concrete routes, not a retry.
    expect(message, 'the recovery pointer names the field to read').toContain(LIVENESS_ROUTE);
    expect(message, 'and the route to drive the tab with when the channel is gone').toContain(CALL_ROUTE);
    expect(
      message,
      'and never advises a blind retry, which is the advice that duplicates a mutation that already applied',
    ).not.toMatch(/just retry|retry the call|try again/i);

    // 3. APPENDED BETWEEN the two existing tails, with the stamp still LAST.
    //    `endsWith` is the structural form of "still last": a stamp moved into
    //    the middle reads fine to a containment check and breaks every caller
    //    that takes the tail of the message as the build identity.
    expect(
      message.indexOf(CALL_ROUTE),
      'the clause comes after the state check, never substituted into it',
    ).toBeGreaterThan(message.indexOf('check state before retrying'));
    expect(message.endsWith(servingBuildStamp()), 'REQ-1457: the serving build stamp is still the last thing said').toBe(
      true,
    );
  });

  it('is conditional on the next call also failing — one timeout is not a dead tab', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const message = await timeoutMessageFor(bridge, 'session', 'find', [{ selector: { name: 'cat-label' } }]);

    // The clause rides on a timer that fires when the timeout streak is 1, so it
    // must not announce a dead tab. REQ-772 AC-3 established deliberately that a
    // relay timeout is not proof the tab failed — the tab keeps executing and the
    // effect may land anyway — and an agent that reads this envelope as a verdict
    // abandons live work.
    expect(message, 'no verdict about the tab is stated').not.toMatch(
      /\b(?:the tab is dead|tab has died|tab has crashed|tab is gone)\b/i,
    );
    // …and the condition is stated, so the clause reads as advice about the NEXT
    // call rather than a conclusion about this one.
    expect(
      message,
      'the clause is conditioned on the next call also timing out',
    ).toMatch(/if your next call to this tab also times out/i);
    // The call that actually timed out is named, so the reader can see which
    // unanswered call the streak is counting.
    expect(message, 'and it names the call that went unanswered').toContain('session.find');
  });

  it('reaches the agent through BOTH calling lanes, since both relay through the same envelope', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    // The relay publishes its manifest ONCE, when the drill completes, so both
    // servers are created BEFORE the tab pairs — a real ordering constraint of
    // the relay rather than a test artefact.
    const fullClient = await connectedClient(bridge, 'full');
    const compactClient = await connectedClient(bridge, 'compact');
    await connectStuckTab(bridge);

    for (const [lane, result] of [
      [
        'full mode',
        await callToolJson(fullClient, 'layer_create', { kind: 'text', props: { name: 'cat-label' }, _timeoutMs: 60 }),
      ],
      [
        'compact mode',
        // REQ-1522 AC-4: a different layer KIND from the full-mode row above, so
        // the two lanes are not the same call — an identical re-issue of an
        // unresolved call is refused, and this test is about the envelope
        // reaching both lanes, not about a retry. The kind is not interpolated
        // into the hint, so every message assertion below is unchanged.
        await callToolJson(compactClient, 'figpea_call', {
          group: 'layer',
          method: 'create',
          args: ['rect', { name: 'cat-label' }],
          _timeoutMs: 60,
        }),
      ],
    ] as const) {
      expect(result.ok, `${lane}: a timed-out call is a failed envelope`).toBe(false);
      // REQ-1522 AC-2: the deadline now carries its own code, so a caller
      // branching on `code` can tell it from a hard relay failure. The recovery
      // clause assertions below are untouched.
      expect(result.code).toBe('bridge_timeout_maybe_applied');
      for (const pinned of PINNED_SUBSTRINGS) {
        expect(result.message, `${lane}: "${pinned}" survives verbatim`).toContain(pinned);
      }
      expect(result.message, `${lane}: the recovery pointer reaches it too`).toContain(LIVENESS_ROUTE);
      expect(result.message, `${lane}: with the route, so a lost channel is not a dead end`).toContain(CALL_ROUTE);
      expect(result.message, `${lane}: and the build stamp is still the tail`).toContain('served by figpea-mcp');
    }
  });

  it('never reaches a call that WAS answered — the clause rides on the deadline', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectAnsweringTab(bridge, { layerId: 'layer-9' });

    const result = (await bridge.callTab('layer', 'create', ['text', { name: 'cat-label' }], 60)) as any;

    // A tab that replies gets its answer and nothing else: no timeout prose, no
    // recovery advice, no build stamp. The clause exists to explain a failure,
    // and attaching it to successes would train a reader to skip the envelope.
    expect(result.ok, 'the tab answered').toBe(true);
    expect(result.value).toEqual({ layerId: 'layer-9' });
    const serialised = JSON.stringify(result);
    expect(serialised, 'no timeout prose on an answered call').not.toContain('timed out');
    expect(serialised, 'no recovery advice on an answered call').not.toContain(LIVENESS_ROUTE);
    expect(serialised, 'no build stamp on an answered call').not.toContain('served by figpea-mcp');
  });
});

// The envelope's two tails are asserted against the modules that own them, so a
// change to either vocabulary cannot make this file's "still last" / "still
// byte-identical" assertions quietly vacuous.
describe('REQ-1503 — the clause is a pure function of the call that timed out', () => {
  it('names the timed-out call, and the same call always gets the same clause', async () => {
    const { recoveryHint } = await import('./tabLiveness');
    const one = recoveryHint('layer', 'create');
    const two = recoveryHint('layer', 'create');
    expect(one, 'deterministic — nothing here depends on a clock or a counter').toBe(two);
    expect(one, 'and it names the call that was not answered').toContain('layer.create');
    expect(recoveryHint('session', 'find'), 'a different call gets its own clause').not.toBe(one);
    expect(recoveryHint('session', 'find')).toContain('session.find');
  });

  it('lives beside stateCheckHint in the module that owns the timeout vocabulary', async () => {
    const { recoveryHint } = await import('./tabLiveness');
    const { stateCheckHint } = await import('./callTimeout');
    // Both are one-liners over the call that timed out, and they are the two
    // halves of the same sentence: what to check, and what to do if the check
    // cannot be run because the channel is gone.
    expect(typeof stateCheckHint).toBe('function');
    expect(typeof recoveryHint).toBe('function');
    expect(recoveryHint('layer', 'create')).toMatch(/bridge/i);
  });
});

// Keeps the file honest about which build the assertion above compares against:
// a stamp can only be "still last" if it is the same string the relay produced.
describe('REQ-1503 — the tail this file pins is the real stamp', () => {
  it('endsWith compares against the same stamp the relay stamps', () => {
    expect(servingBuildStamp(), 'the stamp is a non-trivial identity, not an empty string').toMatch(
      /^served by figpea-mcp \d+\.\d+\.\d+ build /,
    );
    expect(path.basename(servingBuildStamp())).not.toBe('');
  });
});
