/**
 * REQ-1394 — the ONE connection-diagnosis ledger: the token vocabulary, the
 * mutable counters, and the actionable sentence each token implies.
 *
 * The defect this module exists to close is not that the information is
 * unavailable — the bridge observes all of it and discards it. Every accepted
 * TCP socket, every completed WebSocket upgrade, every `hello` accepted or
 * rejected or malformed, the 5-second silence timer, the newest-wins takeover,
 * every close and its RFC 6455 code: `bridgeServer.ts` sees all of it, keeps
 * none of it, and `status` publishes the one-bit reduction —
 * `activeSocket !== undefined && readyState === OPEN`. An agent asking "which
 * of the five things went wrong?" got the same answer for all five.
 *
 * So the whole ladder moves here, a zero-import leaf both sides consume — the
 * same "one place, one number" shape `callTimeout.ts`, `protocol.ts` and
 * `rawJson.ts` already use in this package. It stays a leaf deliberately:
 * `mcpServer.ts`'s `BridgeServerHandleLike` is a structural stand-in, not an
 * import, so importing `bridgeServer` into `mcpServer` (or the reverse) would
 * be a new and wrong coupling.
 *
 * What lives here and nothing else:
 *  - `CONNECTION_EVENTS` / `NEXT_STEP` — the vocabulary and its actions, so the
 *    payload and the README table are pinned against the SAME source
 *    (`req1394ReadmeDiagnosis.test.ts`) and cannot drift apart;
 *  - `createConnectionLedger()` — the mutable per-process counters;
 *  - `deriveDiagnosis()` — the pure function that turns that state into the
 *    published `ConnectionDiagnosis`.
 *
 * `bridgeServer.ts` never derives anything; it calls `record(...)` at the
 * points where it already has the fact. `mcpServer.ts` never inspects a
 * socket; it asks the bridge for a snapshot.
 */

/**
 * The observable states of a pairing attempt, as reported in `lastEvent`.
 *
 * Ordered from "nothing happened yet" to "a tab is live", plus `disconnected`
 * for the tab that was. This is a VOCABULARY, not an enum object: it crosses
 * the wire as JSON text an LLM reads, and a plain string is what it reads most
 * reliably and what a human greps in a log.
 *
 * ⛔ ONE TOKEN CANNOT COVER EVERY CASE THE CARD NAMES, and this list is the
 * honest edge of that. The card's fifth state is "wrong port / nothing
 * listening there", which is defined relative to an address that is *not* the
 * bridge answering the question: a socket aimed at a dead or foreign port never
 * reaches this process, so no event observable from inside can distinguish it
 * from "no tab was ever opened". What resolves the pair is not a token but the
 * identity published beside it — `port`, `token` and `startedAt` — which an
 * agent compares against the pairing URL it holds. See `status` in README.md.
 */
export type ConnectionEvent =
  | 'no_attempt'
  | 'transport_only'
  | 'hello_timeout'
  | 'hello_rejected'
  | 'hello_accepted'
  | 'slot_refused'
  | 'tab_superseded'
  | 'disconnected';

/** The published vocabulary, in the same order as the union above. */
export const CONNECTION_EVENTS: readonly ConnectionEvent[] = [
  'no_attempt',
  'transport_only',
  'hello_timeout',
  'hello_rejected',
  'hello_accepted',
  'slot_refused',
  'tab_superseded',
  'disconnected',
] as const;

/**
 * What an agent should DO, given only `lastEvent` — one sentence per token.
 *
 * These sentences are prose inside a machine-readable field, deliberately:
 * AC-3 asks for an ACTIONABLE token, and an agent that has to map a token to
 * an action is exactly the work this requirement removes. Keeping the map in
 * one module and pinning the README table to it (`req1394ReadmeDiagnosis.test.ts`)
 * means the prose exists once and the two surfaces cannot disagree.
 *
 * ⛔ WHAT THEY MUST NOT CLAIM. They report what THIS PROCESS observed, not why
 * a failure occurred — nothing here promises that opening a tab will fix
 * anything, that a failure was retried or recovered, or that anything was
 * diagnosed that this process cannot see. `transport_only` and `hello_timeout`
 * name the shape of the handshake that never completed and stop there: the
 * cause (a stale tab, a blocked port, a browser that never fired `hello`) is
 * outside this package.
 */
export const NEXT_STEP: Readonly<Record<ConnectionEvent, string>> = {
  no_attempt:
    'nothing has reached this bridge yet — open the pairing URL from this status call in a browser to start an editor tab',
  transport_only:
    'a socket reached this port but no WebSocket handshake ever completed — check you are on the exact bridgePort printed above, then reload the editor tab',
  hello_timeout:
    'the WebSocket handshake completed but no hello frame arrived within 5s — reload the editor tab, and check nothing (a proxy, an extension) is holding the connection open',
  hello_rejected:
    'the pairing token was rejected — re-read token from this status call and open a freshly minted pairing URL; a token from an earlier server run is always stale',
  hello_accepted:
    'a tab is paired — proceed; read tabConnected for live truth',
  slot_refused:
    'another tab already holds this bridge\'s single slot and is still serving — to pair this one too, close that tab, or restart the bridge with --bridge-slots=multi (or FIGPEA_BRIDGE_SLOTS=multi)',
  tab_superseded:
    'a newer tab took over the connection — paired, proceed; if you expected the older tab, close the newer one',
  disconnected:
    'the paired tab has gone away — open a fresh pairing URL from this status call to pair again',
};

/** The raw, mutable state a ledger accumulates. Published via `snapshot()`. */
export interface ConnectionLedgerState {
  /** The most recent recorded event; `no_attempt` until something is. */
  lastEvent: ConnectionEvent;
  /** Raw sockets accepted by the listener (includes REQ-1017's HTTP endpoints). */
  tcpConnections: number;
  /** WebSocket handshakes that completed. */
  upgrades: number;
  helloAccepted: number;
  helloRejected: number;
  supersededCount: number;
  /** RFC 6455 code of the most recent close this process initiated or observed. */
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  /** ISO-8601 instant this bridge run started. The counters belong to it. */
  startedAt: string | null;
}

/** The published payload: the state plus the action its token implies. */
export interface ConnectionDiagnosis {
  /** The most recent observed event. NOT a verdict — `tab_superseded` and
   *  `hello_accepted` are both healthy states. `tabConnected` remains
   *  authoritative for whether a tab is live RIGHT NOW. */
  lastEvent: ConnectionEvent;
  /** The action `lastEvent` implies, verbatim from `NEXT_STEP`. */
  nextStep: string;
  tcpConnections: number;
  upgrades: number;
  helloAccepted: number;
  helloRejected: number;
  supersededCount: number;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  /** ISO-8601 start of this run. The counters are per-run and are never
   *  persisted, so this is what dates them. `null` only on the fallback below. */
  startedAt: string | null;
}

/** Close information a recording site already holds when it records an event. */
export interface ConnectionEventDetail {
  closeCode?: number;
  closeReason?: string;
}

export interface ConnectionLedger {
  /**
   * One completed WebSocket handshake. A distinct fact from any `hello`
   * outcome, and counted at the moment it happens so `transport_only` is
   * suppressed immediately rather than up to five seconds later, when the
   * silent socket's `hello` timer finally fires.
   */
  recordUpgrade(): void;
  /** Records one observed event. `no_attempt` is the derived default, never recorded. */
  record(event: ConnectionEvent, detail?: ConnectionEventDetail): void;
  /** The state so far — a copy, so a later `record` cannot mutate a snapshot a caller is holding. */
  snapshot(): ConnectionLedgerState;
}

/** A zero-counter, never-recorded ledger state — the honest "nothing yet". */
function emptyState(startedAt: string | null): ConnectionLedgerState {
  return {
    lastEvent: 'no_attempt',
    tcpConnections: 0,
    upgrades: 0,
    helloAccepted: 0,
    helloRejected: 0,
    supersededCount: 0,
    lastCloseCode: null,
    lastCloseReason: null,
    startedAt,
  };
}

/**
 * The per-process ledger. `bridgeServer.ts` creates exactly one, at start, and
 * feeds it the facts it already has; nothing is read back until `status` or a
 * `no_tab` refusal asks for a diagnosis.
 */
export function createConnectionLedger(options?: { startedAt?: string | null }): ConnectionLedger {
  // AC-5: the counters are per-process and must be DATED, so a reader can tell
  // them apart from a previous run's. Defaulted here, once, rather than at the
  // read sites.
  const startedAt = options?.startedAt ?? new Date().toISOString();
  const state = emptyState(startedAt);

  function applyCloseDetail(detail?: ConnectionEventDetail): void {
    if (detail?.closeCode !== undefined) state.lastCloseCode = detail.closeCode;
    if (detail?.closeReason !== undefined) state.lastCloseReason = detail.closeReason;
  }

  return {
    recordUpgrade(): void {
      state.upgrades++;
    },

    record(event: ConnectionEvent, detail?: ConnectionEventDetail): void {
      switch (event) {
        // ⛔ The guard that makes `transport_only` honest, and the only place a
        // recording is DROPPED. The bridge serves REQ-1017's `/file` and
        // `/blob` endpoints on the same listener, so those requests open TCP
        // sockets too; once anything has completed a handshake, "a socket
        // reached this port" is not the state, and reporting it would blame the
        // pairing for an HTTP fetch. Any future change that lets an HTTP-only
        // client hit this port before a tab pairs will make this fire
        // spuriously — that is the re-check this comment exists for.
        case 'transport_only':
          state.tcpConnections++;
          if (state.upgrades > 0) return;
          break;

        // The derived default, never an observation: `record` accepts it (the
        // type is closed on the vocabulary) and treats it as nothing to record.
        case 'no_attempt':
          return;

        case 'hello_rejected':
          state.helloRejected++;
          break;

        case 'hello_accepted':
          state.helloAccepted++;
          break;

        // REQ-1492 AC-7 — a second connection that asked for this bridge's one
        // slot and did not get it. It shares `supersededCount` with
        // `tab_superseded` on purpose, because that counter's published meaning
        // is now *connections that asked for the serving slot and did not get
        // it*: refused here, and displaced by an OLDER build of this package,
        // which is a real and still-reachable outcome in the wild (an old
        // `figpea-mcp` process plus a current editor tab). Redefining the
        // counter under its existing name would have been the stealth edit this
        // file exists to prevent; `tab_superseded` keeps its own meaning and its
        // byte-identical sentence.
        case 'slot_refused':
          state.supersededCount++;
          break;

        case 'tab_superseded':
          state.supersededCount++;
          break;

        // No counter of its own — the close code/reason ARE the evidence here.
        case 'hello_timeout':
        case 'disconnected':
          break;
      }

      state.lastEvent = event;
      applyCloseDetail(detail);
    },

    snapshot(): ConnectionLedgerState {
      return { ...state };
    },
  };
}

/**
 * The pure derivation. Kept separate from the mutable ledger so the published
 * shape is a function of the state and nothing else — and so the fallback below
 * can run through the same `NEXT_STEP` lookup rather than hand-writing a
 * sentence that would then drift from the documented one.
 */
export function deriveDiagnosis(state: ConnectionLedgerState): ConnectionDiagnosis {
  return {
    lastEvent: state.lastEvent,
    nextStep: NEXT_STEP[state.lastEvent],
    tcpConnections: state.tcpConnections,
    upgrades: state.upgrades,
    helloAccepted: state.helloAccepted,
    helloRejected: state.helloRejected,
    supersededCount: state.supersededCount,
    lastCloseCode: state.lastCloseCode,
    lastCloseReason: state.lastCloseReason,
    startedAt: state.startedAt,
  };
}

/**
 * The fallback for a bridge that cannot report a diagnosis at all — a stub in a
 * test, or any caller passing a handle without `getConnectionDiagnosis`. The
 * field is then never MISSING and never lies: it reports the one bit the legacy
 * boolean carries, in the vocabulary, with every counter zero (nothing was
 * counted) and `startedAt` null (nothing is claimed about a run this process
 * cannot see).
 *
 * It exists because the field is otherwise a lie by omission — an agent reading
 * a payload with no `connection` key cannot tell "nothing happened" from "this
 * build does not report it".
 */
export function legacyDiagnosis(tabConnected: boolean): ConnectionDiagnosis {
  const state = emptyState(null);
  // The only evidence such a bridge has is the boolean, and the honest way to
  // render it in the vocabulary is the token for "a tab got through the
  // handshake" — not the token for "a tab is live", which this bit cannot tell
  // (a superseded-then-closed tab leaves it false).
  if (tabConnected) state.lastEvent = 'hello_accepted';
  return deriveDiagnosis(state);
}

/**
 * REQ-1492 — the same fallback for the `connections` block: a bridge that
 * cannot report its slots gets ONE synthetic entry describing the single tab it
 * says is connected, rather than a payload with the key missing.
 *
 * Every value is the honest one, not the convenient one: `origin: null` with
 * `originSource: 'absent'` because such a bridge genuinely cannot tell where its
 * tab came from (never a fabricated one), `contractVersion` whatever the bridge
 * itself reports — it did report one, so withholding it would be a second lie —
 * and `pairedAt: null`, because "when did this tab pair" is a fact this bridge
 * does not have.
 */
export function legacyConnections(
  tabConnected: boolean,
  contractVersion: string | null = null,
): Array<{
  connectionId: string;
  origin: string | null;
  originSource: 'handshake' | 'absent';
  contractVersion: string | null;
  pairedAt: string | null;
  active: boolean;
}> {
  if (!tabConnected) return [];
  return [
    {
      connectionId: 'c1',
      origin: null,
      originSource: 'absent',
      contractVersion,
      pairedAt: null,
      active: true,
    },
  ];
}