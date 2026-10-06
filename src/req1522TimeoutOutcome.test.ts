import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { startBridgeServer } from './bridgeServer';
import { createMcpServer } from './mcpServer';
import type { TabLiveness } from './tabLiveness';

/**
 * REQ-1522 T1 — the honest outcome of a call that outlived its deadline
 * (AC-1, AC-2, AC-3, AC-5).
 *
 * The card's incident is a single line in the relay: at the deadline it ran the
 * SAME teardown the reply path runs, so it deleted the very record the reply
 * would have been matched against. The tab's answer then arrived into a
 * stale-id guard and was dropped, and everything followed from the bridge never
 * learning what had happened to the call it had already given up on:
 *
 *  - the only evidence that a mutation landed was a frame it threw away (AC-1);
 *  - the caller could not tell a deadline from a hard relay failure, because
 *    both carried the one generic code, so the code said "failed" while the
 *    message said "the editor may still be executing this call" (AC-2);
 *  - a reply racing the expiry could lose to it and be dropped (AC-3);
 *  - and a caller who trusted the code re-issued a non-idempotent call, which
 *    is what AC-4/AC-5 exist to stop.
 *
 * What is asserted here is what a CALLER SEES, through the package's top-tier
 * harness: a real listener, a real `ws` tab that genuinely applies the mutation
 * and then answers late, and a real `McpServer` behind a real SDK `Client` for
 * both calling lanes. Nothing is asserted against a helper's return shape.
 *
 * RED on the unfixed tree, and for the right reason in each case:
 *
 *  1. the repro (AC-1) — the tab's recorded effects prove the mutation landed
 *     while the envelope reported a plain failure;
 *  2. the race (AC-2/AC-3/AC-5) — a reply inside the grace window is consumed
 *     and nothing about the call is left unaccounted for;
 *  3. the structural pin (AC-3) — a pending call's teardown has ONE owner, so a
 *     reply cannot lose a race against it and land in a guard that already fired.
 *
 * The code literal below is the acceptance contract, not an implementation
 * detail: AC-2 names a distinct code for "the deadline fired and the change may
 * have landed", and this test is what makes that a promise. The MECHANICAL
 * spelling pin — that the published docs carry the value the module exports
 * rather than a hand-copied copy of it — lives with the docs it protects
 * (`req1522OutcomeDocs.test.ts`).
 */

/** AC-2: the distinct code that tells the caller the change MAY have landed.
 *  Deliberately not the generic `bridge_error`, which keeps its meaning (no tab,
 *  socket gone, malformed relay) and is asserted against separately so this code
 *  cannot be satisfied by renaming the failure it sits beside. */
const MAYBE_APPLIED = 'bridge_timeout_maybe_applied';

/** The generic code that used to cover the deadline as well as every hard
 *  failure. Asserted as a negative wherever the new code is asserted. */
const GENERIC_BRIDGE_ERROR = 'bridge_error';

/** REQ-772's wording, which this requirement appends to and never rewrites —
 *  the envelope is a thing callers and two shipped requirements match on. */
const PINNED_SUBSTRINGS = ['timed out after', 'may still be executing this call', 'check state before retrying'] as const;

const DEADLINE_MS = 60;
/** Comfortably past the deadline and well inside any grace window an
 *  implementation might document — the shape AC-1's own repro produces when an
 *  editor answers after the relay has given up. */
const LATE_REPLY_MS = 180;

interface BridgeHandle {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  getLiveness(): TabLiveness;
  close(): Promise<void>;
}

/** One `call` frame the tab actually received. Recording it IS applying it,
 *  exactly as the 80-layer model recorded every layer it was asked for — and it
 *  is the only place a duplicated mutation can be seen from the outside. */
interface AppliedCall {
  id: string;
  group: string;
  method: string;
  args: unknown[];
}

const DRILL_INDEX = {
  version: '1.8.0',
  session: { layerTree: 'The tree.' },
  layer: { stylePatch: 'Patches a layer.' },
  errorCodes: ['no_session'],
};

const DRILL_GROUPS: Record<string, unknown> = {
  session: {
    layerTree: { doc: 'The tree.', params: {}, result: 'void' },
  },
  layer: {
    stylePatch: {
      doc: 'Patches a layer.',
      params: { id: { type: 'string', required: true }, patch: { type: 'object', required: true } },
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
  openSockets.length = 0;
  if (activeHandle) {
    await activeHandle.close();
    activeHandle = undefined;
  }
  for (const fn of cleanups.splice(0)) await fn();
});

interface TabModel {
  ws: WebSocket;
  /** Every `call` frame received, in order. Counting these is how "exactly one
   *  mutation" is established rather than inferred from an envelope. */
  received: AppliedCall[];
  /** Push a `result` frame for a given call id — the late answer, on demand. */
  answer(id: string, body: { ok: boolean; value?: unknown; code?: string; message?: string }): void;
}

/**
 * A stand-in editor tab that behaves the way the incident's editor did: it
 * APPLIES the mutation the moment it is asked, keeps working past the relay's
 * deadline, and only then answers.
 *
 * `answerAfterMs: null` is the wedged tab — nothing is ever applied and nothing
 * is ever answered, which is the control every other case is read against.
 * `answerAfterMs: 'manual'` holds the answer until the test releases it, which
 * is how the two sides of the deadline race are made deterministic.
 */
async function connectTab(bridge: BridgeHandle, answerAfterMs: number | null | 'manual'): Promise<TabModel> {
  const described = new Promise<void>((resolve) => {
    bridge.onDescribe(() => resolve());
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const received: AppliedCall[] = [];
  const model: TabModel = {
    ws,
    received,
    answer(id, body) {
      ws.send(JSON.stringify({ type: 'result', id, ...body }));
    },
  };

  // `on`, not `once`: the describe drill's frames arrive first, and only a
  // relayed `call` frame is the thing under test.
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
    // The effect lands HERE, immediately — the mutation is applied the instant
    // the frame arrives, which is what makes "reported as failed, applied
    // anyway" an observable pair of facts rather than one belief.
    received.push({ id: frame.id, group: frame.group, method: frame.method, args: frame.args });
    if (answerAfterMs === null || answerAfterMs === 'manual') return;
    setTimeout(() => model.answer(frame.id, { ok: true, value: { applied: true } }), answerAfterMs);
  });

  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);
  await described;
  return model;
}

/** The rejection one relay call produced, as the caller receives it. */
async function rejectionFrom(call: Promise<unknown>): Promise<Error & { code?: unknown }> {
  let seen: unknown;
  try {
    await call;
  } catch (e) {
    seen = e;
  }
  expect(seen, 'the relay rejects at its own deadline rather than hanging').toBeInstanceOf(Error);
  return seen as Error & { code?: unknown };
}

async function connectedClient(bridge: BridgeHandle, toolMode: 'compact' | 'full'): Promise<Client> {
  const server = createMcpServer(bridge, { toolMode });
  const client = new Client({ name: 'req-1522-outcome-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((c) => c.type === 'text')!.text!);
}

const PATCH_ARGS = ['layer-9', { fill: '#ff0000' }];

describe('REQ-1522 AC-1 — the repro: a call reported failed whose change had already landed', () => {
  it('the envelope is the deadline outcome, not a plain relay failure, while the change is on the record', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const tab = await connectTab(bridge, LATE_REPLY_MS);

    const err = await rejectionFrom(bridge.callTab('layer', 'stylePatch', PATCH_ARGS, DEADLINE_MS));

    // …the change landed, read back off the tab's own record…
    await expect.poll(() => tab.received.length, { timeout: 2000 }).toBe(1);
    expect(
      tab.received.map((c) => [c.method, JSON.stringify(c.args)]),
      'AC-1: the tab really was asked to apply the change, so the change may have landed',
    ).toContainEqual(['stylePatch', JSON.stringify(PATCH_ARGS)]);

    // …while the envelope reported a plain failure with nothing to tell a
    // reader that the two facts belong to the same call.
    expect(err.code, 'AC-2: the deadline is named by its own code').toBe(MAYBE_APPLIED);
    expect(
      err.code,
      'and it is NOT the generic code every hard relay failure also carries — that code is what a caller branches on',
    ).not.toBe(GENERIC_BRIDGE_ERROR);
    for (const pinned of PINNED_SUBSTRINGS) {
      expect(err.message, `the envelope keeps "${pinned}" verbatim`).toContain(pinned);
    }
  });

  it('both MCP calling lanes report the deadline outcome, with the envelope intact', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;

    // Both servers are built BEFORE the tab pairs: the relay publishes the tab's
    // manifest once, when the drill completes, so a server built afterwards
    // registers no contract tools at all. A real ordering constraint of the
    // relay, not a test artefact.
    const fullClient = await connectedClient(bridge, 'full');
    const compactClient = await connectedClient(bridge, 'compact');
    await connectTab(bridge, LATE_REPLY_MS);

    // The two lanes are addressed with DIFFERENT arguments on purpose. This case is
    // about both lanes reporting one deadline outcome, not about re-issuing: an
    // identical second call is a different scenario (AC-4, its own suite) and
    // would be refused rather than relayed, which would make this test assert a
    // refusal while claiming to assert an outcome.
    for (const [lane, result] of [
      [
        'full mode',
        await callToolJson(fullClient, 'layer_stylePatch', {
          id: 'layer-9',
          patch: { fill: '#ff0000' },
          _timeoutMs: DEADLINE_MS,
        }),
      ],
      [
        'compact mode',
        await callToolJson(compactClient, 'figpea_call', {
          group: 'layer',
          method: 'stylePatch',
          args: ['layer-10', { fill: '#00ff00' }],
          _timeoutMs: DEADLINE_MS,
        }),
      ],
    ] as const) {
      expect(result.ok, `${lane}: the call did not return a value`).toBe(false);
      expect(result.code, `${lane}: the deadline is named by its own code`).toBe(MAYBE_APPLIED);
      expect(result.code, `${lane}: not the generic failure code`).not.toBe(GENERIC_BRIDGE_ERROR);
      for (const pinned of PINNED_SUBSTRINGS) {
        expect(result.message, `${lane}: "${pinned}" survives verbatim`).toContain(pinned);
      }
      // REQ-1282's named state check is the route out of the ambiguity, so it
      // has to survive the code change too — it is what tells a caller what to
      // run, rather than whether to retry — and it has to name the layer THIS
      // lane addressed, which is how the two lanes are told apart.
      expect(result.message, `${lane}: the named state check reaches the agent`).toContain(
        `session.layerById("${lane === 'full mode' ? 'layer-9' : 'layer-10'}")`,
      );
    }
  });
});

describe('REQ-1522 AC-2 — the late answer is consumed, not discarded', () => {
  it('an answer arriving after the deadline is accounted for, so a slow tab is not left looking wedged', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectTab(bridge, LATE_REPLY_MS);

    await rejectionFrom(bridge.callTab('layer', 'stylePatch', PATCH_ARGS, DEADLINE_MS));

    // The tab DID answer — which is exactly what REQ-1503's liveness axis is
    // asked to be told — so a tab that is merely slow must not keep accruing a
    // timeout streak on the strength of a frame the bridge threw away.
    await expect.poll(() => bridge.getLiveness().consecutiveTimeouts, { timeout: 3000 }).toBe(0);
    expect(
      bridge.getLiveness().lastAnswerAt,
      'the late answer is recorded as an answer, so it is visible rather than discarded',
    ).not.toBeNull();
  });

  it('the deadline settles the in-flight count exactly once, so nothing leaks and nothing double-counts', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectTab(bridge, LATE_REPLY_MS);

    // Three calls in flight at once, all crossing the deadline, all answering
    // late: the count has to come back to zero from every direction at once.
    const calls = [
      bridge.callTab('layer', 'stylePatch', ['a', { fill: '#111111' }], DEADLINE_MS),
      bridge.callTab('layer', 'stylePatch', ['b', { fill: '#222222' }], DEADLINE_MS),
      bridge.callTab('layer', 'stylePatch', ['c', { fill: '#333333' }], DEADLINE_MS),
    ];
    expect(bridge.getLiveness().inFlight, 'dispatched calls are in flight').toBe(3);
    for (const err of await Promise.all(calls.map(rejectionFrom))) {
      expect(err.code, 'every deadline carries its own code').toBe(MAYBE_APPLIED);
    }
    await expect.poll(() => bridge.getLiveness().inFlight, { timeout: 3000 }).toBe(0);

    await expect.poll(() => bridge.getLiveness().consecutiveTimeouts, { timeout: 3000 }).toBe(0);
    expect(
      bridge.getLiveness().inFlight,
      'and the late answers do not push the count below zero — the deadline already settled it',
    ).toBe(0);
  });

  it('an answer that WINS the race is given the value, never the timeout prose', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const tab = await connectTab(bridge, 'manual');

    const call = bridge.callTab('layer', 'stylePatch', PATCH_ARGS, DEADLINE_MS);
    await expect.poll(() => tab.received.length, { timeout: 2000 }).toBe(1);
    tab.answer(tab.received[0].id, { ok: true, value: { applied: true } });

    const value = (await call) as any;
    expect(value, 'a call answered before its deadline resolves with the tab result').toEqual({
      ok: true,
      value: { applied: true },
    });
    expect(bridge.getLiveness().consecutiveTimeouts, 'an answered call is not a timeout').toBe(0);
    expect(bridge.getLiveness().inFlight, 'and it settles the in-flight count').toBe(0);
  });

  it('an unrelated id is still dropped rather than guessed at, and a never-answering tab is unaffected', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const tab = await connectTab(bridge, null);

    // A stale/unknown id must be ignored, never matched to somebody else's call.
    tab.answer('no-such-id', { ok: true, value: { applied: 'someone else entirely' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.isTabConnected(), 'a stale id is dropped, not guessed at').toBe(true);

    const stuck = await rejectionFrom(bridge.callTab('layer', 'stylePatch', PATCH_ARGS, DEADLINE_MS));
    expect(
      stuck.code,
      'a tab that never answers is the same deadline outcome — there is no late frame to convert',
    ).toBe(MAYBE_APPLIED);
    expect(bridge.getLiveness().consecutiveTimeouts, 'and it is honestly recorded as a timeout').toBe(1);

    // The bridge is still usable afterwards: a demoted record must not wedge the
    // next call. This tab still never answers, so the proof is that the new call
    // REACHES it and runs out its own deadline — not that it is short-circuited,
    // hung, or answered by the entry left over from the timed-out one.
    const answered = bridge.callTab('layer', 'stylePatch', ['layer-10', { fill: '#00ff00' }], DEADLINE_MS);
    await expect.poll(() => tab.received.length, { timeout: 2000 }).toBe(2);
    const second = await rejectionFrom(answered);
    expect(second.code, 'the next call gets its own outcome, not the previous call leftover').toBe(MAYBE_APPLIED);
    expect(second.message, 'and its own deadline').toContain(`timed out after ${DEADLINE_MS}ms`);
    expect(bridge.getLiveness().inFlight, 'with the in-flight count still honest').toBe(0);
  });
});

describe('REQ-1522 AC-3 — one owner for a pending call’s teardown', () => {
  it('a reply racing the expiry is neither dropped nor double-settled', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    const tab = await connectTab(bridge, 'manual');

    // The reply is released just AFTER the deadline, which is the race the
    // requirement names: the expiry has already fired and the frame is already
    // on the wire. Exactly one outcome may reach the caller, and the mutation
    // may not be left unaccounted for.
    const raced = await rejectionFrom(bridge.callTab('layer', 'stylePatch', PATCH_ARGS, DEADLINE_MS));
    await expect.poll(() => tab.received.length, { timeout: 2000 }).toBe(1);
    expect(raced.code, 'the deadline won this one, and says so in its own words').toBe(MAYBE_APPLIED);

    tab.answer(tab.received[0].id, { ok: true, value: { applied: true } });
    await expect.poll(() => bridge.getLiveness().consecutiveTimeouts, { timeout: 3000 }).toBe(0);
    expect(
      bridge.getLiveness().inFlight,
      'the count was settled by the deadline; the late reply must not settle it a second time',
    ).toBe(0);
  });

  // The structural half of AC-3, in the shape `metadata.test.ts` already uses for
  // this package's source-level guarantees. Deliberately NAMING-INDEPENDENT: it
  // classifies every timer clear by the SHAPE of what it clears (a property
  // access versus a bare identifier) rather than by a local variable's name, so
  // it cannot be satisfied by renaming the thing — and it cannot be satisfied by
  // deleting a different requirement's timer clear, which would look like a
  // tidier settle path while actually leaking a timer.
  //
  // Comments are stripped first, because this requirement's own docblocks QUOTE
  // the very statements the pin forbids (`target.pending.delete(id)` appears in
  // the comment explaining why it is gone). A structural pin that counted its
  // own rationale would be a pin nobody could ever satisfy.
  const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const BRIDGE_SOURCE = stripComments(fs.readFileSync(path.resolve(__dirname, 'bridgeServer.ts'), 'utf8'));
  const CLEAR_TIMEOUT_ARGS = [...BRIDGE_SOURCE.matchAll(/clearTimeout\(\s*([^)]*?)\s*\)/g)].map((m) => m[1]);
  const ENTRY_TIMER_CLEARS = CLEAR_TIMEOUT_ARGS.filter((arg) => /\.timer\s*$/.test(arg));
  const OTHER_TIMER_CLEARS = CLEAR_TIMEOUT_ARGS.filter((arg) => !/\.timer\s*$/.test(arg));
  const PENDING_MAP_DELETES = [...BRIDGE_SOURCE.matchAll(/\.pending\.delete\(/g)].length;

  it('a pending call’s timer is cleared in exactly one place', () => {
    expect(
      ENTRY_TIMER_CLEARS,
      'AC-3: a pending call entry has exactly ONE teardown site, so a reply cannot lose a race against it and land in a guard that has already fired',
    ).toHaveLength(1);
  });

  it('a pending call is removed from its map in exactly one place — and the deadline is not it', () => {
    expect(
      PENDING_MAP_DELETES,
      'AC-2/AC-3: the deadline must not destroy the correlation record an in-flight frame is matched against, and every removal goes through the one owner',
    ).toBe(1);
  });

  it('the other timers in this file still clear themselves, so AC-3 cannot be satisfied by deleting someone else’s clear', () => {
    // `pendingDescribe`'s deadline and the handshake deadline are different slot
    // fields with their own timers; they are not AC-3's subject, and deleting
    // one of their clears would read as a simplification while leaking a timer.
    expect(
      OTHER_TIMER_CLEARS.length,
      'the non-entry timer clears (the describe deadline and the handshake deadline) are still there',
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('REQ-1522 AC-5 — one outcome for the caller, and the mutation acknowledged', () => {
  it('a call whose reply lands after its timeout yields exactly one envelope, never a pair', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectTab(bridge, LATE_REPLY_MS);

    let settlements = 0;
    const call = bridge.callTab('layer', 'stylePatch', PATCH_ARGS, DEADLINE_MS).then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    await call;
    expect(settlements, 'the caller holds one outcome the moment the deadline fires').toBe(1);

    // The mutation is now acknowledged rather than unaccounted for: the tab's
    // late answer is recorded as an answer instead of vanishing into the guard.
    await expect.poll(() => bridge.getLiveness().consecutiveTimeouts, { timeout: 3000 }).toBe(0);
    expect(
      settlements,
      'a reply that arrives afterwards does not hand the caller a SECOND outcome — the late frame is consumed, not replayed',
    ).toBe(1);
  });
});