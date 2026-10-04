import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import WebSocket from 'ws';

import { startBridgeServer } from './bridgeServer';
import { createMcpServer } from './mcpServer';
// Type-only, so the runtime module graph never has to resolve `./tabLiveness`
// for this file to load. The VALUES below are reached through `await import()`
// on purpose: a static import of a module that does not exist yet fails
// COLLECTION, which hides the repro below behind a resolver error. The defect
// this file exists to record is a payload that says a tab is connected while
// saying nothing about whether it is answering — and that failure has to be
// legible at the top of the RED run, not replaced by "cannot find module".
import type { TabLiveness, TabLivenessLedgerState } from './tabLiveness';

/**
 * REQ-1503 T1 — tab liveness: the repro, and the pins for the vocabulary.
 *
 * WHAT THE CARD SAYS. A `figpea-mcp` client cannot tell a wedged editor tab
 * from a busy one: every call runs out its deadline while `status` keeps
 * reporting `tabConnected: true`. This file pins the other half of that
 * statement — that `status` also tells you which of the two it is, in words
 * that do not over-claim.
 *
 * Harness is the package's own established top tier (there is no browser and no
 * Playwright suite in this repo): a REAL `startBridgeServer()` listener on an
 * OS-assigned port, a REAL `ws` client standing in for the editor tab, a REAL
 * `McpServer` reached through a REAL `@modelcontextprotocol/sdk` `Client` over
 * `InMemoryTransport`. The subject is a JSON payload on a localhost protocol,
 * which is exactly what this tier speaks to.
 *
 * TWO TIERS ON PURPOSE, and the split is the point:
 *
 *  - The REPRO and the payload shape are driven through the wire, because the
 *    card's claim is about what an agent RECEIVES. A stub handle could satisfy
 *    a payload assertion without the bridge ever observing anything.
 *  - The vocabulary and the CALIBRATION are driven through `deriveLiveness`
 *    directly, because several of the cases are unreachable through a real
 *    listener without contriving a wedged OS thread: "one timeout after a
 *    successful answer", "two consecutive timeouts", "a never-answered tab".
 *    Those are the cases the calibration is *about*, so they are asserted as
 *    inputs to the one derivation that produces every published value.
 *
 * THE CALIBRATION, stated here because it is what a reader must not erode:
 * liveness reports WHAT THIS BRIDGE OBSERVED and never why. A non-answer is a
 * real answer, not a failure — a large project mid-render and a frozen tab look
 * identical from outside — so no value here may claim proof the tab is dead,
 * and every token that is not `unpaired` must be reachable from something the
 * bridge actually saw.
 */

type Bridge = Awaited<ReturnType<typeof startBridgeServer>>;

const openBridges: Bridge[] = [];
const openSockets: WebSocket[] = [];
const cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Order matters: the bridge's `close()` waits for its connections to end, so
  // every socket is destroyed BEFORE the listener is asked to close — otherwise
  // a deliberately silent socket would hang its own teardown.
  for (const ws of openSockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  for (const bridge of openBridges.splice(0)) await bridge.close().catch(() => {});
  for (const fn of cleanupFns.splice(0)) await fn().catch(() => {});
});

async function liveBridge(): Promise<Bridge> {
  const bridge = await startBridgeServer();
  openBridges.push(bridge);
  return bridge;
}

/** A real tab that completes the handshake and is then held silent. */
async function connectSilentTab(bridge: { port: number; token: string }): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  return ws;
}

async function connectedClient(bridge: unknown, options?: Record<string, unknown>): Promise<Client> {
  const server = createMcpServer(bridge as never, options as never);
  const client = new Client({ name: 'req-1503-liveness-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanupFns.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** The whole `status` payload, exactly as an agent receives it. */
async function statusOf(client: Client): Promise<any> {
  const result = await client.callTool({ name: 'status', arguments: {} });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, 'status returns a text content block').toBeDefined();
  return JSON.parse(textBlock!.text!);
}

/** Polls until `probe` stops throwing, so no assertion depends on a sleep. */
async function eventually<T>(probe: () => Promise<T>, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await probe();
    } catch (err) {
      lastError = err;
      if (Date.now() > deadline) throw new Error(`${label}: ${String(lastError)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/** The rejection message of a call the tab never answered. */
async function timeoutMessage(bridge: Bridge, timeoutMs = 400): Promise<string> {
  try {
    await bridge.callTab('layer', 'create', ['rect', { name: 'wedge-probe' }], timeoutMs);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the call to time out, but it resolved');
}

/** A ledger state with every counter explicit — no hidden defaults. */
function ledger(overrides: Partial<TabLivenessLedgerState> = {}): TabLivenessLedgerState {
  return {
    connectionId: 'c1',
    callsAnswered: 0,
    consecutiveTimeouts: 0,
    lastAnswerAt: null,
    lastTimeoutAt: null,
    inFlight: 0,
    oldestInFlightAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The repro: a live socket to a tab that never answers.
// ---------------------------------------------------------------------------

describe('REQ-1503 — a wedged tab is invisible to the status payload (the repro)', () => {
  it('a tab that never answers keeps the one bit that exists set — the bit is about the socket', async () => {
    // This half PASSES today, and that is the finding rather than a nuisance:
    // `isTabConnected()` reduces to `readyState === OPEN`, so a tab whose main
    // thread is wedged reports connected forever. Pinned because it is the
    // evidence the rest of this file hangs on.
    const bridge = await liveBridge();
    await connectSilentTab(bridge);
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const s = await eventually(
      async () => {
        const status = await statusOf(client);
        expect(status.tabConnected).toBe(true);
        return status;
      },
      'the socket bit flips when a tab completes the handshake',
    );
    // And the call really does go unanswered, so the two facts coexist.
    expect(await timeoutMessage(bridge)).toMatch(/timed out after \d+ms/);
    const after = await statusOf(client);
    expect(
      after.tabConnected,
      'the socket is still open, so the bit is still true after the timeout',
    ).toBe(true);
    expect(s.tabConnected).toBe(true);
  });

  for (const toolMode of ['compact', 'full'] as const) {
    it(`says nothing at all about the tab not answering (${toolMode} mode)`, async () => {
      // THE RED, and the defect in the card's own words. After a call this
      // bridge observed go unanswered, the payload an agent reads still carries
      // no liveness block: nothing distinguishes "busy rendering" from "wedged",
      // so the agent has no basis for anything except another retry.
      const bridge = await liveBridge();
      await connectSilentTab(bridge);
      const client = await connectedClient(bridge, { toolMode });
      await eventually(
        async () => {
          expect((await statusOf(client)).tabConnected).toBe(true);
        },
        'the tab is paired before the call is made',
      );
      await timeoutMessage(bridge);

      const s = await statusOf(client);
      expect(
        'liveness' in s,
        'status publishes what this bridge observed about whether the TAB is answering',
      ).toBe(true);
    });
  }

  it('after one unanswered call on a tab that had never answered, liveness says so and names the tab', async () => {
    const bridge = await liveBridge();
    await connectSilentTab(bridge);
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    await eventually(
      async () => {
        expect((await statusOf(client)).tabConnected).toBe(true);
      },
      'the tab is paired before the call is made',
    );
    await timeoutMessage(bridge);

    const s = await statusOf(client);
    const live = s.liveness as TabLiveness;
    // One unanswered call on a tab that had never answered IS the card's case:
    // there is no evidence it ever worked, so this is the weakest honest reading
    // that is still not a guess. It is `unresponsive`, not `responsive`.
    expect(live.state, 'a tab that never answered one call and never answered anything before').toBe('unresponsive');
    // …and it is the tab CALLS ARE ADDRESSED TO, named so a multi-slot reader
    // can tell which tab the block is about.
    expect(live.connectionId, 'liveness names the tab it describes').toBe(s.activeConnectionId);
    expect(live.inFlight, 'the timed-out call is no longer in flight').toBe(0);
    expect(typeof live.nextStep, 'every liveness value carries the action its token implies').toBe('string');
    expect(live.nextStep.length).toBeGreaterThan(0);
  });

  it('the status tool description names the field, or an agent that reads only tools/list never learns of it', async () => {
    // REQ-1394 AC-3's precedent, applied: a field no tool description mentions is
    // a field nobody reads, and this payload's whole value is being read.
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const { tools } = await client.listTools();
    const status = tools.find((t) => t.name === 'status');
    expect(status, 'status is registered').toBeDefined();
    expect(status!.description ?? '', 'the description names the liveness block').toContain('liveness');
  });
});

// ---------------------------------------------------------------------------
// The vocabulary and its calibration.
// ---------------------------------------------------------------------------

describe('REQ-1503 — the four liveness tokens, and what each one is allowed to claim', () => {
  it('publishes exactly the four documented tokens, each with its own action', async () => {
    const { LIVENESS_STATES, NEXT_STEP } = await import('./tabLiveness');
    expect([...LIVENESS_STATES].sort()).toEqual(['responsive', 'unknown', 'unpaired', 'unresponsive']);
    // Every token has an action sentence, so the vocabulary cannot grow a value
    // an agent would have to map to a response by hand — the defect class REQ-1394
    // exists to remove, in the same shape.
    for (const state of LIVENESS_STATES) {
      expect(typeof NEXT_STEP[state], `${state} has a nextStep`).toBe('string');
      expect(NEXT_STEP[state].trim().length, `${state}'s nextStep is a sentence`).toBeGreaterThan(0);
    }
    // Pairwise distinct: a reader who can only act correctly on one of them needs
    // to be able to tell them apart, and four copies of one sentence is not that.
    const sentences = LIVENESS_STATES.map((s) => NEXT_STEP[s]);
    expect(new Set(sentences).size, 'each token implies its own action').toBe(sentences.length);
  });

  it('no token claims the tab is dead — a busy tab must not read as a failed one', async () => {
    // The brief's one rule the docs must not get wrong, asserted on the DATA
    // rather than left to the README: REQ-772 AC-3 established deliberately
    // that a relay timeout is not proof the tab failed, because the tab keeps
    // executing and the effect may land anyway. A caller that reads "dead" on a
    // merely-busy tab abandons live work.
    const { NEXT_STEP } = await import('./tabLiveness');
    for (const [state, sentence] of Object.entries(NEXT_STEP)) {
      expect(sentence, `${state} does not assert the tab is dead`).not.toMatch(
        /\b(?:the tab is dead|tab has died|tab has crashed|tab is gone)\b/i,
      );
    }
  });

  it('deriveLiveness: a fresh pair reads unknown, never responsive', async () => {
    const { deriveLiveness } = await import('./tabLiveness');
    // `unknown` means nothing has been observed YET. Reporting a brand-new pair
    // as `responsive` would be the mirror-image lie: "healthy" is a claim about
    // calls that have not happened.
    const live = deriveLiveness(ledger(), 1_000);
    expect(live.state, 'a tab that has answered nothing is not known to be answering').toBe('unknown');
  });

  it('deriveLiveness: a departed tab reads unpaired', async () => {
    const { deriveLiveness } = await import('./tabLiveness');
    // No tab, no ledger — the one state that needs no observation to be sure of.
    const live = deriveLiveness(null, 1_000);
    expect(live.state).toBe('unpaired');
    expect(live.connectionId, 'and it names no tab, because there is none').toBeNull();
    expect(live.inFlight, 'with no tab there are no calls in flight').toBe(0);
  });

  it('deriveLiveness: ONE timeout after a successful answer is NOT unresponsive (REQ-772)', async () => {
    const { deriveLiveness } = await import('./tabLiveness');
    // The calibration the card turns on. This tab demonstrably works — it
    // answered — and one unanswered call is what a slow export looks like from
    // outside. Reading it as `unresponsive` is crying wolf on every legitimately
    // slow call, which is the reason REQ-772 refused to treat a timeout as proof.
    const live = deriveLiveness(
      ledger({ callsAnswered: 3, consecutiveTimeouts: 1, lastAnswerAt: 900, lastTimeoutAt: 950 }),
      1_000,
    );
    expect(live.state, 'a working tab with one timeout is still answering').toBe('responsive');
    expect(live.consecutiveTimeouts, 'the streak is published as data').toBe(1);
    expect(live.lastTimeoutAt, 'the timeout is still recorded — nothing is hidden').toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('deriveLiveness: two consecutive timeouts ARE unresponsive', async () => {
    const { deriveLiveness } = await import('./tabLiveness');
    const live = deriveLiveness(
      ledger({ callsAnswered: 3, consecutiveTimeouts: 2, lastAnswerAt: 800, lastTimeoutAt: 990 }),
      1_000,
    );
    expect(live.state, 'a tab that has missed two calls in a row is not answering').toBe('unresponsive');
  });

  it('deriveLiveness: a tab that has never answered anything is unresponsive after its FIRST unanswered call', async () => {
    const { deriveLiveness } = await import('./tabLiveness');
    // The asymmetry, stated because it is deliberate: with no prior answer there
    // is nothing to weigh the timeout against, so one is enough — and the honest
    // reading of a tab that has never once answered a call.
    const live = deriveLiveness(ledger({ consecutiveTimeouts: 1, lastTimeoutAt: 990 }), 1_000);
    expect(live.state).toBe('unresponsive');
  });

  it('deriveLiveness: in-flight age is DATA, never the state', async () => {
    const { deriveLiveness } = await import('./tabLiveness');
    // A legitimately slow `session.openFile` runs for 120 s by its own
    // documented default. Age alone cannot tell that from a wedge, so a long
    // unanswered call must not flip the token — it is published as
    // `oldestInFlightMs` for a caller who wants to weigh it themselves.
    const now = 1_000_000;
    const live = deriveLiveness(
      ledger({
        callsAnswered: 2,
        inFlight: 1,
        oldestInFlightAt: now - 90_000,
        lastAnswerAt: now - 120_000,
      }),
      now,
    );
    expect(live.state, '90s of silence on a tab that has answered is not a verdict').toBe('responsive');
    expect(live.inFlight, 'but the work in flight is published').toBe(1);
    expect(live.oldestInFlightMs, 'as an age a caller can act on').toBe(90_000);
  });

  it('deriveLiveness: published instants are ISO-8601 and ages are absent when nothing is in flight', async () => {
    const { deriveLiveness } = await import('./tabLiveness');
    const idle = deriveLiveness(ledger({ callsAnswered: 1, lastAnswerAt: 1_700_000_000_000 }), 1_700_000_001_000);
    expect(idle.lastAnswerAt, 'an instant, in the same shape status already publishes').toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(idle.lastTimeoutAt, 'and nothing is invented for an event that did not happen').toBeNull();
    expect(idle.oldestInFlightMs, 'no in-flight call means no age to report').toBeNull();
  });
});

describe('REQ-1503 — a bridge that cannot report liveness still emits the field', () => {
  it('a legacy handle reports what its one bit can honestly support — connected is unknown, not responsive', async () => {
    const { legacyLiveness } = await import('./tabLiveness');
    // The fallback exists for the same reason `legacyDiagnosis` does: a missing
    // key cannot be distinguished from "this build does not report it". And it
    // must not be MORE informative than the evidence behind it — such a bridge
    // has seen no call outcome at all, so the connected case is `unknown`. This
    // is the assertion that stops the fallback being implemented as
    // `tabConnected ? responsive : unpaired`, which would be a lie in a
    // direction no reader could detect.
    expect(legacyLiveness(true).state, 'connected says nothing about answering').toBe('unknown');
    expect(legacyLiveness(false).state, 'not connected is the one thing it does know').toBe('unpaired');
    expect(legacyLiveness(true).lastAnswerAt, 'and no instant is invented').toBeNull();
  });

  it('the field reaches an agent through a handle that has no getLiveness at all', async () => {
    // `BridgeServerHandleLike` is a structural stand-in satisfied by ~45 test
    // files with their own stubs, so `getLiveness` is OPTIONAL — the whole point
    // is that a stub bridge keeps compiling and still produces the key.
    const stub = {
      port: 5599,
      token: 'stub-token',
      isTabConnected: () => true,
      onDescribe: () => {},
      callTab: async () => ({ ok: true, value: null }),
      close: async () => {},
    };
    const client = await connectedClient(stub, { toolMode: 'compact' });
    const s = await statusOf(client);
    expect('liveness' in s, 'the key is present even when the bridge cannot derive one').toBe(true);
    expect(s.liveness.state, 'carrying the honest reading of the bit it does have').toBe('unknown');
  });
});
