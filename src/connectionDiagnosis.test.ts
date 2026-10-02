import { describe, it, expect } from 'vitest';

import {
  CONNECTION_EVENTS,
  NEXT_STEP,
  createConnectionLedger,
  deriveDiagnosis,
  legacyDiagnosis,
  type ConnectionEvent,
} from './connectionDiagnosis';

/**
 * REQ-1394 T1 — the connection ledger and its token vocabulary (AC-1, AC-3,
 * AC-5).
 *
 * `connectionDiagnosis.ts` does not exist yet (T2 builds it) — every test
 * below fails at this file's own import statement ("Cannot find module
 * './connectionDiagnosis'"), never inside an assertion. This is the intended
 * RED.
 *
 * WHAT IS BEING PINNED, in the AC's own words rather than the design's:
 *
 *  - AC-1 — the bridge's pairing state is a space with several distinct
 *    values, not one boolean, and each observed event must land the reported
 *    `lastEvent` on a different, named state.
 *  - AC-3 — an agent reading ONLY `lastEvent` (plus the `nextStep` sentence
 *    shipped beside it) must be able to name the action to take next. So every
 *    token carries a non-empty next step, and two tokens never share one —
 *    otherwise the token would not determine the action.
 *  - AC-5 — the counters describe THIS process only: a ledger that has
 *    observed nothing reports zero, not null/undefined/"unknown", and the run
 *    it belongs to is identified by `startedAt` rather than by any history.
 *
 * The ledger is driven through the same public shape `bridgeServer.ts` will
 * use (`recordUpgrade()` / `record(event, detail?)` / `snapshot()`), so a
 * behaviour asserted here is the behaviour the bridge will actually publish.
 */

/** Convenience: the diagnosis a ledger currently reports. */
function diagnose(ledger: { snapshot: () => Parameters<typeof deriveDiagnosis>[0] }) {
  return deriveDiagnosis(ledger.snapshot());
}

describe('REQ-1394 — a fresh ledger reports "nothing was ever attempted", honestly (AC-5)', () => {
  it('a ledger that has observed nothing reports lastEvent "no_attempt"', () => {
    const ledger = createConnectionLedger();
    expect(diagnose(ledger).lastEvent).toBe('no_attempt');
  });

  it('a fresh ledger reports every counter as the number 0, not null or undefined (AC-5)', () => {
    const { lastEvent: _l, nextStep: _n, startedAt: _s, ...counters } = diagnose(createConnectionLedger());
    // `lastCloseCode`/`lastCloseReason` are the two nullable ones by design —
    // "no close has happened yet" is genuinely unknown, not zero. Everything
    // else is a count and must be a real 0.
    expect(counters.tcpConnections).toBe(0);
    expect(counters.upgrades).toBe(0);
    expect(counters.helloAccepted).toBe(0);
    expect(counters.helloRejected).toBe(0);
    expect(counters.supersededCount).toBe(0);
    expect(counters.lastCloseCode).toBeNull();
    expect(counters.lastCloseReason).toBeNull();
  });

  it('a fresh ledger stamps startedAt with this run, so the counters can be dated (AC-5)', () => {
    const startedAt = diagnose(createConnectionLedger()).startedAt;
    expect(typeof startedAt, 'startedAt is present on a real ledger').toBe('string');
    expect(Number.isNaN(Date.parse(startedAt!)), 'startedAt is a parseable ISO-8601 instant').toBe(false);
  });

  it('two ledgers started at different times report different startedAt — they are per-process, not shared', () => {
    const early = createConnectionLedger({ startedAt: '2026-01-01T00:00:00.000Z' });
    const late = createConnectionLedger({ startedAt: '2026-06-01T00:00:00.000Z' });
    expect(diagnose(early).startedAt).not.toBe(diagnose(late).startedAt);
  });
});

describe('REQ-1394 — every observed event lands on its own named state (AC-1)', () => {
  // One row per token, driven the way the bridge drives it. `no_attempt` is the
  // derived default and has no recording sequence — it is covered above.
  const sequences: Array<{ event: ConnectionEvent; drive: (l: ReturnType<typeof createConnectionLedger>) => void }> = [
    { event: 'transport_only', drive: (l) => l.record('transport_only') },
    { event: 'hello_timeout', drive: (l) => { l.recordUpgrade(); l.record('hello_timeout', { closeCode: 4001 }); } },
    { event: 'hello_rejected', drive: (l) => { l.recordUpgrade(); l.record('hello_rejected', { closeCode: 4001 }); } },
    { event: 'hello_accepted', drive: (l) => { l.recordUpgrade(); l.record('hello_accepted'); } },
    { event: 'tab_superseded', drive: (l) => { l.recordUpgrade(); l.record('hello_accepted'); l.recordUpgrade(); l.record('tab_superseded', { closeCode: 4002 }); } },
    { event: 'disconnected', drive: (l) => { l.recordUpgrade(); l.record('hello_accepted'); l.record('disconnected', { closeCode: 1000, closeReason: 'bye' }); } },
  ];

  for (const { event, drive } of sequences) {
    it(`the most recent ${event} is the reported lastEvent`, () => {
      const ledger = createConnectionLedger();
      drive(ledger);
      expect(diagnose(ledger).lastEvent).toBe(event);
    });
  }

  it('every token in the published vocabulary is reachable, and only those (AC-1/AC-3)', () => {
    const reachable = new Set<ConnectionEvent>(['no_attempt', ...sequences.map((s) => s.event)]);
    expect(new Set(CONNECTION_EVENTS), 'the vocabulary and the reachable set agree').toEqual(reachable);
  });

  it('the two rejection-shaped states are distinguishable from each other (AC-1)', () => {
    const rejected = createConnectionLedger();
    rejected.recordUpgrade();
    rejected.record('hello_rejected', { closeCode: 4001, closeReason: 'invalid or missing pairing token' });
    const timedOut = createConnectionLedger();
    timedOut.recordUpgrade();
    timedOut.record('hello_timeout', { closeCode: 4001, closeReason: 'no hello frame received' });
    // Same close code — the two are only separable because the bridge records
    // which branch closed, not because it re-reads the code.
    expect(diagnose(rejected).lastEvent).not.toBe(diagnose(timedOut).lastEvent);
  });

  it('a superseded tab keeps reporting tab_superseded, and its close code is retained', () => {
    // Sequence: tab A pairs, tab B pairs and takes over (A is closed with
    // 4002), then B disconnects cleanly. Each of those three facts must be
    // readable without knowing the ordering of any other.
    const ledger = createConnectionLedger();
    ledger.recordUpgrade();
    ledger.record('hello_accepted');
    ledger.recordUpgrade();
    ledger.record('tab_superseded', { closeCode: 4002, closeReason: 'superseded by a newer tab connection' });
    const afterTakeover = diagnose(ledger);
    expect(afterTakeover.lastEvent).toBe('tab_superseded');
    expect(afterTakeover.supersededCount).toBe(1);
    expect(afterTakeover.lastCloseCode).toBe(4002);

    ledger.record('disconnected', { closeCode: 1000, closeReason: 'tab closed' });
    const afterClose = diagnose(ledger);
    expect(afterClose.lastEvent).toBe('disconnected');
    expect(afterClose.lastCloseCode).toBe(1000);
    expect(afterClose.supersededCount, 'the supersede is not erased by a later close').toBe(1);
  });

  it('counters accumulate across a session instead of being overwritten by the latest event', () => {
    const ledger = createConnectionLedger();
    ledger.record('transport_only'); // an HTTP-only client hit the port first
    ledger.recordUpgrade();
    ledger.record('hello_rejected', { closeCode: 4001 });
    ledger.recordUpgrade();
    ledger.record('hello_accepted');
    ledger.recordUpgrade();
    ledger.record('tab_superseded', { closeCode: 4002 });
    const d = diagnose(ledger);
    expect(d.tcpConnections).toBe(1);
    expect(d.upgrades).toBe(3);
    expect(d.helloAccepted).toBe(1);
    expect(d.helloRejected).toBe(1);
    expect(d.supersededCount).toBe(1);
  });
});

describe('REQ-1394 — "a socket reached us" is only reported while nothing has upgraded (AC-1)', () => {
  it('a completed WebSocket upgrade stops transport_only being reported (AC-1)', () => {
    const ledger = createConnectionLedger();
    ledger.recordUpgrade(); // a tab reached the handshake
    ledger.record('transport_only'); // ...then an HTTP-only client hit the port
    const d = diagnose(ledger);
    expect(d.lastEvent, 'a plain request after an upgrade is not the reported state').not.toBe('transport_only');
    expect(d.tcpConnections, 'the socket is still counted as evidence').toBe(1);
    expect(d.upgrades).toBe(1);
  });

  it('before any upgrade, that same socket IS the reported state', () => {
    const ledger = createConnectionLedger();
    ledger.record('transport_only');
    expect(diagnose(ledger).lastEvent).toBe('transport_only');
  });
});

describe('REQ-1394 — every token names its own next step (AC-3)', () => {
  it('the vocabulary is non-empty and every entry is a usable token string', () => {
    expect(CONNECTION_EVENTS.length).toBeGreaterThan(0);
    for (const token of CONNECTION_EVENTS) {
      expect(typeof token, 'each vocabulary entry is a string').toBe('string');
      expect(token.trim().length, 'each vocabulary entry is non-empty').toBeGreaterThan(0);
    }
    // The vocabulary is a LIST, so the published set cannot gain a token the
    // derivation's map has never been asked about.
    expect(new Set(CONNECTION_EVENTS).size, 'the vocabulary has no duplicates').toBe(CONNECTION_EVENTS.length);
  });

  it('every token has a non-empty next step', () => {
    for (const token of CONNECTION_EVENTS) {
      expect(typeof NEXT_STEP[token], `${token} has a next step`).toBe('string');
      expect(NEXT_STEP[token].trim().length, `${token}'s next step is non-empty`).toBeGreaterThan(0);
    }
  });

  it('the payload’s nextStep is exactly the documented one for the reported token', () => {
    const ledger = createConnectionLedger();
    ledger.recordUpgrade();
    ledger.record('hello_rejected', { closeCode: 4001 });
    const d = diagnose(ledger);
    expect(d.nextStep).toBe(NEXT_STEP.hello_rejected);
  });

  it('two tokens never share a next step — otherwise lastEvent alone would not name an action (AC-3)', () => {
    const seen = new Map<string, ConnectionEvent>();
    for (const token of CONNECTION_EVENTS) {
      const step = NEXT_STEP[token];
      expect(seen.has(step), `${token} shares its next step with ${seen.get(step)}`).toBe(false);
      seen.set(step, token);
    }
  });

  it('a next step is an instruction, not a restatement of the token', () => {
    for (const token of CONNECTION_EVENTS) {
      expect(NEXT_STEP[token].toLowerCase()).not.toBe(token.toLowerCase().replace(/_/g, ' '));
    }
  });
});

describe('REQ-1394 — the fallback for a bridge that cannot report anything (AC-2)', () => {
  it('reports no_attempt with zero counters and no startedAt when no tab is connected', () => {
    const d = legacyDiagnosis(false);
    expect(d.lastEvent).toBe('no_attempt');
    expect(d.nextStep).toBe(NEXT_STEP.no_attempt);
    expect(d.tcpConnections).toBe(0);
    expect(d.upgrades).toBe(0);
    expect(d.helloAccepted).toBe(0);
    expect(d.helloRejected).toBe(0);
    expect(d.supersededCount).toBe(0);
    expect(d.lastCloseCode).toBeNull();
    expect(d.startedAt, 'nothing is claimed about a run this process cannot see').toBeNull();
  });

  it('reports hello_accepted when a tab is connected — and still claims no history', () => {
    const d = legacyDiagnosis(true);
    expect(d.lastEvent).toBe('hello_accepted');
    expect(d.nextStep).toBe(NEXT_STEP.hello_accepted);
    expect(d.startedAt).toBeNull();
    // Honest, not useful: it is one bit of evidence rendered as the vocabulary,
    // and the counters stay zero because the process never counted anything.
    expect(d.upgrades).toBe(0);
  });
});