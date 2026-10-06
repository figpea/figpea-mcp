import { MAX_CALL_TIMEOUT_MS } from './callTimeout';

/**
 * REQ-1522 — the vocabulary of a call whose outcome is NOT "failed".
 *
 * A relay deadline is not a failure verdict: the tab keeps executing after the
 * bridge stops waiting, and the effect of a mutation may land anyway. That was
 * already true and already said so — in prose, inside `message`, while the
 * machine-readable field said `bridge_error`, the same code a missing tab, a
 * closed socket and a malformed relay all produced. Every consumer branches on
 * `code`, so the honest reading existed only for a caller willing to parse
 * English, and the two reactions to a plain failure were both expensive:
 * believe it and abandon a mutation that landed, or re-issue a non-idempotent
 * call and duplicate it.
 *
 * So the outcome gets a name of its own, and it lives here — a leaf module, the
 * same shape `callTimeout.ts`, `tabLiveness.ts`, `protocol.ts` and
 * `rawJson.ts` already use in this package, for the same reason: `mcpServer.ts`
 * must read these codes without ever importing `bridgeServer.ts` (or the
 * reverse), which is a structural stand-in, not a module.
 *
 * ⛔ THE DISCIPLINE THAT MAKES THAT WORK: the code crosses the layer boundary
 * ON THE ERROR OBJECT, never through an import. `bridgeServer.ts` throws
 * `CallOutcomeError`; `mcpServer.ts` reads `err.code` structurally and falls
 * back to `bridge_error` for anything that does not carry one. So the fallback
 * keeps meaning exactly what it meant — no tab, socket gone, malformed relay —
 * and the new codes are additions to the vocabulary rather than a
 * redefinition of an existing one.
 */

/**
 * The relay's own deadline fired. The change MAY have landed: the tab was
 * executing when the bridge stopped waiting, and a result frame that arrives
 * later is matched and recorded rather than discarded.
 *
 * `maybe`, deliberately, and not `possibly`: the bridge has no evidence either
 * way at the moment it rejects, and a code that promised an answer it does not
 * have would be the same class of lie this requirement removes.
 */
export const OUTCOME_TIMEOUT_MAYBE_APPLIED = 'bridge_timeout_maybe_applied';

/**
 * An identical re-issue of a call whose outcome is unknown (or is recorded as
 * applied) was REFUSED rather than relayed. The earlier call is the reason; the
 * state check named in the message is the route forward.
 */
export const OUTCOME_PREVIOUS_UNRESOLVED = 'bridge_previous_call_unresolved';

/**
 * How long a demoted entry stays matchable, DERIVED rather than given a second
 * literal.
 *
 * It is the ceiling this package already imposes on any single call, so "how
 * long may we still be waiting on an answer" and "how long may one call ever
 * be" are the same number by construction — and there is no new tunable to
 * document, drift, or justify in a third place. The reason the derivation is
 * right rather than merely tidy: AC-1's own repro sets `_timeoutMs` to its
 * minimum, so a tab may legitimately answer long after a short deadline, and
 * any window shorter than the package's own maximum call would discard exactly
 * the frames this requirement exists to keep.
 */
export const UNRESOLVED_CALL_TTL_MS = MAX_CALL_TIMEOUT_MS;

/** What is known about a call that crossed the relay's deadline.
 *  `unknown` is the honest default and the reason the entry exists at all: the
 *  bridge stopped waiting, so it has no verdict, and a record that claimed one
 *  would be inventing the very thing the caller is being told to go and look
 *  for. */
export type UnresolvedOutcome = 'unknown' | 'applied' | 'failed';

/**
 * The error the relay rejects with when the outcome is not a hard failure.
 *
 * It carries `code` so the MCP layer can pass it through without importing
 * anything, and `outcome` so a caller reading the object (rather than parsing
 * the message) knows what the code means. `code` and `outcome` are separate on
 * purpose: `outcome` describes the CALL, `code` is the wire vocabulary, and
 * conflating them is how a "maybe" becomes an accidental "no".
 */
export class CallOutcomeError extends Error {
  readonly code: string;
  readonly outcome: UnresolvedOutcome;

  constructor(code: string, message: string, outcome: UnresolvedOutcome) {
    super(message);
    this.name = 'CallOutcomeError';
    this.code = code;
    this.outcome = outcome;
  }
}

/**
 * One call's identity for the purpose of "is this the same call again?".
 *
 * `group_method` plus a STABLE serialization of `args`: object keys are sorted
 * recursively so two payloads that differ only in property order are recognised
 * as identical, while anything else — argument order, values, an omitted vs
 * `undefined` entry — keeps them apart. Key order is not something a caller
 * controls and is not something that changes what a re-issue would do, so two
 * payloads differing only in it ARE the same re-issue, and treating them as
 * different would let the guard be walked straight past.
 *
 * Not a hash: the arguments of one call are bounded by this package's own
 * per-call budget, and a digest would buy nothing but a second way to be wrong.
 */
export function unresolvedCallKey(group: string, method: string, args: unknown[]): string {
  return `${group}_${method}:${stableSerialize(args)}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`);
  return `{${entries.join(',')}}`;
}

/** One timed-out call whose fate the bridge does not yet know. */
export interface UnresolvedCall {
  /** `group_method` — named rather than keyed, because it is what a caller
   *  reads and a refusal quotes. */
  tool: string;
  outcome: UnresolvedOutcome;
  /** Absolute epoch ms after which the record is swept regardless. */
  expiresAtMs: number;
}

export interface UnresolvedCallLedger {
  /** Records that a call timed out and its outcome is not known. Idempotent for
   *  one key: a second timeout of the same identical call refreshes the window
   *  rather than adding a record, so a caller in a retry loop cannot grow the
   *  ledger without bound. */
  markUnresolved(tool: string, key: string, nowMs?: number): void;
  /** Records what the tab eventually said, if it said anything in time. */
  resolve(key: string, outcome: Exclude<UnresolvedOutcome, 'unknown'>): void;
  /** What is known about this key: `unknown` when nothing is recorded, which is
   *  also the answer for a key that has been swept. */
  lookup(key: string): UnresolvedOutcome;
  /** What this ledger already knows about this EXACT call, or `null` when it
   *  knows nothing — which is not the same answer as `'unknown'`, and the
   *  difference is the whole point of asking this way.
   *
   *  `null` means the bridge was never in doubt about this call, and a guard
   *  must fail OPEN there: refusing a call nobody has a reason to doubt would
   *  block ordinary work on the strength of a record that does not exist.
   *  `'unknown'` means an identical call DID cross a deadline and nobody has
   *  said how it went — the conservative case. `'failed'` is the one recorded
   *  outcome that must NOT block anything, because the caller has just learned
   *  the call did not land and re-issuing is the only way forward.
   *
   *  It answers only "what is known", deliberately: whether that knowledge
   *  BLOCKS a re-issue also depends on whether the tool is safe to repeat,
   *  which is a fact about the contract method rather than about this call, so
   *  that half of the decision belongs with the caller that has the method.
   */
  priorOutcome(key: string): UnresolvedOutcome | null;
  /** Drops everything past its expiry. Called on a timer by the owner, and by
   *  the slot's teardown; kept here so the rule lives beside the record. */
  sweep(nowMs?: number): void;
  size(): number;
}

/**
 * The per-slot record of calls that crossed the relay's deadline and whose
 * outcome is not yet known.
 *
 * One entry per unresolved call, each with a bounded life, so the memory it
 * holds is bounded by construction and not by how long a tab stays wedged. A
 * record that outlives its window is swept whether or not an answer ever
 * arrives — the alternative is a ledger whose entries are all "unknown"
 * forever, which is the same false negative with extra storage.
 */
export function createUnresolvedCallLedger(): UnresolvedCallLedger {
  const records = new Map<string, UnresolvedCall>();

  return {
    markUnresolved(tool, key, nowMs = Date.now()): void {
      records.set(key, { tool, outcome: 'unknown', expiresAtMs: nowMs + UNRESOLVED_CALL_TTL_MS });
    },

    resolve(key, outcome): void {
      const existing = records.get(key);
      if (existing === undefined) return;
      records.set(key, { ...existing, outcome });
    },

    lookup(key): UnresolvedOutcome {
      return records.get(key)?.outcome ?? 'unknown';
    },

    priorOutcome(key): UnresolvedOutcome | null {
      return records.get(key)?.outcome ?? null;
    },

    sweep(nowMs = Date.now()): void {
      for (const [key, record] of records) {
        if (record.expiresAtMs <= nowMs) records.delete(key);
      }
    },

    size(): number {
      return records.size;
    },
  };
}