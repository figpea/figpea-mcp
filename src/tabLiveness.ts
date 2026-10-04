/**
 * REQ-1503 — the ONE tab-liveness ledger: the token vocabulary, the per-tab
 * counters, the derivation, and the recovery clause that rides on a timeout.
 *
 * The defect this module exists to close is not that the information is
 * unavailable — the bridge observes all of it and discards it. `callTab` sees
 * every `result` frame and every deadline it enforces, keeps none of it, and
 * `status` publishes the one-bit reduction: `tabConnected`, which reduces to
 * `readyState === OPEN`. A tab whose main thread is wedged keeps its socket open
 * forever, so that bit stays `true` while **every** call runs out its deadline.
 * An agent reading it cannot tell a wedged tab from a busy one, and the only
 * remaining move it has is another retry.
 *
 * So liveness moves here, a zero-import leaf both sides consume — the same "one
 * place, one vocabulary" shape `callTimeout.ts`, `connectionDiagnosis.ts`,
 * `protocol.ts` and `rawJson.ts` already use in this package. It stays a leaf
 * deliberately: `mcpServer.ts`'s `BridgeServerHandleLike` is a structural
 * stand-in, not an import, so importing `bridgeServer` into `mcpServer` (or the
 * reverse) would be a new and wrong coupling.
 *
 * ⛔ WHAT LIVENESS IS NOT, stated before the vocabulary because it governs every
 * value below. It reports **what this bridge observed**, and never why. A
 * non-answer is a real answer, not a failure: a large project mid-render and a
 * frozen tab look identical from outside, so the honest report is the ambiguity
 * and no token may claim proof the tab is dead. A caller that reads "dead" on a
 * merely-busy tab abandons live work. Reciprocally, a green reading here says
 * nothing about whether the BRIDGE PROCESS is alive — a different process with a
 * different failure mode, and the one that takes the stdio channel with it.
 *
 * This is a NEW AXIS, deliberately not a ninth `connection.lastEvent` token: all
 * eight of those describe the WebSocket transport, and a live socket to a wedged
 * tab reports `hello_accepted` — correctly, and uselessly. Folding "is the tab
 * answering?" into that map would collapse "the socket is fine" into a field
 * about something else, so liveness is a separate per-tab block beside `tab`.
 *
 * What lives here and nothing else:
 *  - `LIVENESS_STATES` / `NEXT_STEP` — the vocabulary and its actions, so the
 *    payload, the prose and the README table are pinned against the SAME source
 *    and cannot drift apart;
 *  - `createTabLivenessLedger()` — the mutable per-tab counters;
 *  - `deriveLiveness()` — the pure function that turns that state into the
 *    published `TabLiveness`;
 *  - `legacyLiveness()` — the honest fallback for a handle that cannot report
 *    one, beside `connectionDiagnosis`'s `legacyDiagnosis`;
 *  - `recoveryHint()` — the envelope clause, next to `stateCheckHint`.
 *
 * `bridgeServer.ts` never derives anything; it records each fact where it
 * already exists. `mcpServer.ts` never inspects a socket; it asks the bridge for
 * a snapshot.
 */

/**
 * The observable states of one tab, as reported in `liveness.state`.
 *
 * Ordered from "no tab" through "nothing observed yet" to the two readings a
 * caller has to be able to tell apart. A VOCABULARY, not an enum object: it
 * crosses the wire as JSON text an LLM reads, and a plain string is what it
 * reads most reliably.
 *
 * `unknown` is named for what it is rather than for what a reader hopes: it means
 * nothing has been observed yet. It is NOT a synonym for "healthy" — a brand-new
 * pair has proven nothing, and reporting it as `responsive` would be the
 * mirror-image lie of reporting one timeout as proof of failure.
 */
export type LivenessState = 'unpaired' | 'unknown' | 'responsive' | 'unresponsive';

/** The published vocabulary, in the same order as the union above. */
export const LIVENESS_STATES: readonly LivenessState[] = [
  'unpaired',
  'unknown',
  'responsive',
  'unresponsive',
] as const;

/**
 * What an agent should DO, given only `liveness.state` — one sentence per token.
 *
 * Prose inside a machine-readable field, deliberately, for the same reason
 * `connectionDiagnosis.NEXT_STEP` is: an agent that has to map a token to an
 * action is exactly the work this requirement removes. One module owns the map
 * and the docs are pinned to it, so the sentences exist once.
 *
 * ⛔ None of them asserts that the tab is dead. Each names what was observed and
 * the next thing to DO, which is why `unresponsive` sends the reader to look at
 * the editor tab rather than declaring a verdict about it.
 */
export const NEXT_STEP: Readonly<Record<LivenessState, string>> = {
  unpaired:
    'no tab is paired to this bridge — open the pairing URL this status call prints in a browser to pair one; there is no tab to answer a call until then',
  unknown:
    'a tab is paired but nothing has been observed on it yet — this bridge has seen no answered call and no timeout, which is not the same as healthy: make one call and read this block again',
  responsive:
    'the last call this bridge sent this tab was answered — proceed; a call still in flight is published as inFlight/oldestInFlightMs, and on a large project that is usually a render still settling rather than a failure',
  unresponsive:
    "two calls in a row went unanswered on this tab (or one, on a tab that had never answered) — that is what this bridge observed, not why: a large project mid-render and a frozen tab look identical from here, so it is not proof the tab failed. Look at the editor tab — if it is still working, wait for it; if it is not, the tab is what needs attention. With the MCP channel gone, drive the tab through the bridge's own call route (README → Recovering a lost session).",
};

/**
 * The raw, mutable state one tab's ledger accumulates. Published through
 * `snapshot()`.
 *
 * The three instants are **epoch milliseconds**, because `bridgeServer.ts`
 * records them at the moment the fact exists and never converts; the PUBLISHED
 * block carries them as ISO-8601 instead, so a reader sees the same shape as
 * `tab.pairedAt` and `connection.startedAt`. The conversion happens once, in the
 * derivation, rather than at four recording sites.
 */
export interface TabLivenessLedgerState {
  /** The slot this ledger belongs to (`c1`, `c2`, …) — which tab it describes. */
  connectionId: string;
  /** Calls this bridge sent to this tab that came back at all, answered or not. */
  callsAnswered: number;
  /** Calls since the last one that came back. Reset by any answer. */
  consecutiveTimeouts: number;
  /** Epoch ms of the most recent answer, or null if there has never been one. */
  lastAnswerAt: number | null;
  /** Epoch ms of the most recent unanswered call, or null. */
  lastTimeoutAt: number | null;
  /** Calls sent to this tab and not yet settled. */
  inFlight: number;
  /** Epoch ms of the OLDEST in-flight call, or null when nothing is in flight. */
  oldestInFlightAt: number | null;
}

/** The published block: the state, the counters behind it, and the action. */
export interface TabLiveness {
  /** The tab calls are addressed to, or null when none is paired / the bridge
   *  cannot name one (see `legacyLiveness`). */
  connectionId: string | null;
  /** What this bridge observed about whether the tab is ANSWERING. Never a
   *  verdict: `unresponsive` is not proof the tab failed (REQ-772 AC-3), and
   *  `responsive` says nothing about the bridge process. */
  state: LivenessState;
  /** Calls sent and not yet settled. */
  inFlight: number;
  /** How long the oldest in-flight call has been unanswered, in ms, or null.
   *  Published as DATA rather than folded into `state`: a legitimately slow
   *  `session.openFile` runs 120 s by its own documented default, so age alone
   *  cannot separate that from a wedge — a caller may weigh it, this function
   *  may not. */
  oldestInFlightMs: number | null;
  consecutiveTimeouts: number;
  /** ISO-8601 instants, or null for an event that has not happened. */
  lastAnswerAt: string | null;
  lastTimeoutAt: string | null;
  /** The action `state` implies, verbatim from `NEXT_STEP`. */
  nextStep: string;
}

export interface TabLivenessLedger {
  /** One call was sent to this tab and has not settled yet. */
  noteDispatched(nowMs?: number): void;
  /** One in-flight call settled — answered OR timed out. Paired with every
   *  `pending.delete`, so the count cannot leak on a path that forgets one. */
  noteSettled(): void;
  /** The tab replied to a call. Any reply counts: `{ok:false}` is the tab
   *  answering, which is the fact this axis is about. */
  noteAnswered(nowMs?: number): void;
  /** A call ran out its deadline with no reply. */
  noteTimedOut(nowMs?: number): void;
  /** A copy, so a later `note*` cannot mutate a snapshot a caller is holding. */
  snapshot(): TabLivenessLedgerState;
}

/**
 * REQ-1503's calibration, in one place and in one expression, because it is the
 * part of this module a future edit is most likely to erode by accident.
 *
 * `unresponsive` needs **two consecutive** unanswered calls — or ONE on a tab
 * that has never answered anything, where there is no prior answer to weigh the
 * timeout against. A single timeout after a successful answer is explicitly NOT
 * `unresponsive`: REQ-772 AC-3 established deliberately that a relay timeout is
 * not proof the tab failed, because the tab keeps executing and the effect (e.g.
 * `layer.create`) may land anyway, so collapsing that calibration would make
 * `status` cry wolf on every legitimately slow call.
 */
function deriveState(state: TabLivenessLedgerState): LivenessState {
  if (state.consecutiveTimeouts >= 2 || (state.consecutiveTimeouts >= 1 && state.callsAnswered === 0)) {
    return 'unresponsive';
  }
  if (state.callsAnswered > 0) return 'responsive';
  return 'unknown';
}

function isoOrNull(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

/**
 * One tab's ledger. `bridgeServer.ts` creates one per paired tab, beside the
 * `pending` map that already tracks that tab's in-flight calls, and feeds it the
 * facts it already has at the points it already has them.
 */
export function createTabLivenessLedger(connectionId: string): TabLivenessLedger {
  const state: TabLivenessLedgerState = {
    connectionId,
    callsAnswered: 0,
    consecutiveTimeouts: 0,
    lastAnswerAt: null,
    lastTimeoutAt: null,
    inFlight: 0,
    oldestInFlightAt: null,
  };

  return {
    noteDispatched(nowMs: number = Date.now()): void {
      state.inFlight += 1;
      if (state.oldestInFlightAt === null) state.oldestInFlightAt = nowMs;
    },

    noteSettled(): void {
      // Clamped, and the age cleared with it: a count that goes negative or an
      // age left behind by the call that ended it would both be read as evidence
      // about a tab, which is the one thing this block must never do.
      state.inFlight = Math.max(0, state.inFlight - 1);
      if (state.inFlight === 0) state.oldestInFlightAt = null;
    },

    noteAnswered(nowMs: number = Date.now()): void {
      state.callsAnswered += 1;
      // The streak ends here whatever came before: this is the fact that
      // separates "one slow call" from "this tab is not answering".
      state.consecutiveTimeouts = 0;
      state.lastAnswerAt = nowMs;
    },

    noteTimedOut(nowMs: number = Date.now()): void {
      state.consecutiveTimeouts += 1;
      state.lastTimeoutAt = nowMs;
    },

    snapshot(): TabLivenessLedgerState {
      return { ...state };
    },
  };
}

/**
 * The pure derivation, kept separate from the mutable ledger so the published
 * shape is a function of the state and nothing else — and so the fallback below
 * and this function cannot disagree about a token.
 *
 * `null` state is `unpaired`: no tab, no ledger, and the one answer available
 * without an observation.
 */
export function deriveLiveness(
  state: TabLivenessLedgerState | null,
  nowMs: number = Date.now(),
): TabLiveness {
  if (state === null) {
    return {
      connectionId: null,
      state: 'unpaired',
      inFlight: 0,
      oldestInFlightMs: null,
      consecutiveTimeouts: 0,
      lastAnswerAt: null,
      lastTimeoutAt: null,
      nextStep: NEXT_STEP.unpaired,
    };
  }

  const token = deriveState(state);
  // `Math.max(0, …)` so a clock that steps backwards reports no age rather than
  // a negative one — an impossible-looking number is worse than an absent one,
  // because a reader would try to act on it.
  const oldestInFlightMs =
    state.inFlight > 0 && state.oldestInFlightAt !== null ? Math.max(0, nowMs - state.oldestInFlightAt) : null;

  return {
    connectionId: state.connectionId,
    state: token,
    inFlight: state.inFlight,
    oldestInFlightMs,
    consecutiveTimeouts: state.consecutiveTimeouts,
    lastAnswerAt: isoOrNull(state.lastAnswerAt),
    lastTimeoutAt: isoOrNull(state.lastTimeoutAt),
    nextStep: NEXT_STEP[token],
  };
}

/**
 * The fallback for a bridge that cannot report liveness at all — a stub in a
 * test, or any caller passing a handle without `getLiveness`. It exists because
 * the field is otherwise a lie by omission: an agent reading a payload with no
 * `liveness` key cannot tell "nothing observed" from "this build does not
 * report it". The `legacyDiagnosis` pattern, applied to this axis.
 *
 * Every value is the honest one rather than the convenient one, and the token is
 * the load-bearing part:
 *
 *  - `connectionId: null` — such a bridge genuinely cannot name its tab, and a
 *    fabricated id is worse than a missing one (the same rule `tab.origin`'s
 *    `originSource` exists for).
 *  - connected ⇒ **`unknown`**, never `responsive`. The only bit it has says a
 *    socket is open; that is evidence about the transport, not about whether the
 *    tab ever answers a call. `tabConnected ? 'responsive' : 'unpaired'` is the
 *    obvious implementation and it is a lie in a direction no reader could
 *    detect — it would report a wedged tab as healthy, which is this
 *    requirement's entire defect.
 *  - not connected ⇒ `unpaired`, the one thing the bit really does establish.
 */
export function legacyLiveness(tabConnected: boolean): TabLiveness {
  const token: LivenessState = tabConnected ? 'unknown' : 'unpaired';
  return {
    connectionId: null,
    state: token,
    inFlight: 0,
    oldestInFlightMs: null,
    consecutiveTimeouts: 0,
    lastAnswerAt: null,
    lastTimeoutAt: null,
    nextStep: NEXT_STEP[token],
  };
}

/**
 * REQ-1503 — the clause APPENDED to a relay timeout envelope, after
 * `stateCheckHint` and before the serving build stamp.
 *
 * REQ-1282 AC-3 fixed the previous gap: "check state before retrying" is advice
 * with no route attached, and both reactions to it are expensive. But the state
 * check it names needs the MCP channel — and the case this clause exists for is
 * the one where that channel is gone. So it names the two routes that survive
 * it: the `liveness` field (which says whether the tab is answering at all, so
 * the next call is chosen rather than repeated) and the bridge's own token-gated
 * call route (which relays a call with no MCP server in the picture).
 *
 * **Conditional on the streak, which is why the sentence is conditional.** This
 * clause rides on a timer that fires when the streak is 1, and one unanswered
 * call is not evidence that the tab is not answering (REQ-772). So it says what
 * to do IF the next one times out too, rather than announcing a dead tab — the
 * same discipline `deriveState` applies to the token.
 *
 * It names routes instead of advising a retry, which is the REQ-1282 failure
 * mode: "retry" is the advice that duplicates a mutation that already applied.
 *
 * The route is named by its REAL spelling (`POST /call`), not described. This
 * clause's whole audience is an agent that read the failure and needs the next
 * command, and one that only reads `tools/list` may never open the README — a
 * description of the route is a second thing to look up at the moment the run is
 * already stuck, which is the moment the plan's brief says this exists to serve.
 */
export function recoveryHint(group: string, method: string): string {
  return (
    `if your next call to this tab also times out, this tab is not answering — ${group}.${method} timed out ` +
    'unanswered, and it is the streak that separates a busy tab from a wedged one. Read `status.liveness`, then ' +
    "drive the tab through the bridge's own `POST /call` route (README → Recovering a lost session); the bridge " +
    'keeps serving without the MCP channel.'
  );
}
