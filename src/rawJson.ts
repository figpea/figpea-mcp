import type { ParamSchemaLike } from './tools';

/**
 * REQ-1280 — the ONE `_rawJson` implementation, shared by both relay paths.
 *
 * The defect this module exists to close: `_rawJson` is declared on
 * `figpea_call` (the only tool compact mode registers) and was inert there,
 * while it worked on the full-mode generated tools. The card's own rule is
 * element-wise and schema-independent — "JSON-parse any element of `args`
 * that is a string whose trimmed form starts with `{`/`[` and ends with
 * `}`/`]`" — and that is exactly what both paths need, so both call THIS
 * module rather than growing a second loop that can drift (AC-7).
 *
 * Pure: no bridge, no I/O, no zod — unit-testable in isolation (the
 * `argShape.ts` precedent, REQ-1268 T5).
 *
 * ⛔ PARSE AND RECORD, NEVER REPAIR AND NEVER THROW. Two deliberate
 * boundaries, both load-bearing:
 *
 *  1. A value that is a string, looks like JSON, and does NOT parse is left
 *     exactly as it is. It is recorded as a structured failure ONLY where the
 *     declared schema for that position positively expects `object`/`array`/
 *     `matrix` (`expectsStructuredValue`) — the same test the flag-less
 *     auto-parse branch six lines below the full-mode flag block already
 *     applies (mcpServer.ts:1106-1109). At a `string`/`number`/`boolean`
 *     position, or where no schema is available at all (a legacy free-text
 *     manifest, or compact mode before any `describe()` has delivered one), it
 *     is neither recorded nor touched, which is byte-identical to today.
 *     Loudness where a structured value was provably intended is the card's
 *     AC-8; loudness everywhere would break a call that works today
 *     (`setName(id, '[Hero]')` with `name` declared `string`).
 *
 *  2. The PARSE itself stays schema-blind on both paths. A *valid* JSON
 *     literal sitting at a `string` position is therefore parsed and rejected
 *     downstream — the documented residual class, identical to full mode's
 *     behaviour since REQ-1037, so the two paths cannot diverge. Guarding the
 *     parse would change full mode, which the card puts out of scope.
 */

/** A failed parse, located precisely enough to fix blind. */
export interface RawJsonFailure {
  /** Human path for the offending position, e.g. `args[1] (props)`. */
  path: string;
  /** The string exactly as the caller sent it (untrimmed), for the message. */
  raw: string;
}

/** The declared-schema facts this module needs, and no more. */
export type RawJsonSchemaLike = Pick<ParamSchemaLike, 'type'> | undefined;

/** Where a position's declared schema and human path come from. Both are
 *  indexed by POSITION, so the caller owns the positional↔schema mapping
 *  (full mode: `inputKeys`; compact mode: `contractTool.inputKeys`). */
export interface ApplyRawJsonOptions {
  schemaAt: (i: number) => RawJsonSchemaLike;
  pathAt: (i: number) => string;
  /**
   * The ordered keys to visit for a RECORD container — the declared
   * positional order, which is NOT the object's own key order once a reserved
   * key (`_rawJson`, `_timeoutMs`, `returnAs`) or a client-side key order is
   * in play. Defaults to the container's own key order, which is correct for
   * the array form. Full mode MUST pass `inputKeys` (it is also what keeps the
   * reserved keys out of the parse).
   */
  keys?: readonly string[];
}

/**
 * Is this flag set? The truthy set is lifted VERBATIM from full mode's own
 * test (mcpServer.ts:1081-1085, unchanged since REQ-1037), so compact mode
 * accepts exactly the flag spellings full mode already accepts. A new
 * truthiness rule on one path and not the other would itself be the drift
 * AC-7 exists to prevent.
 */
export function isRawJsonFlag(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** The single `JSON.parse` call site in the package (AC-7's guarantee).
 *
 *  - non-string ⇒ returned untouched;
 *  - trimmed form not `{…}`/`[…]`-wrapped ⇒ untouched;
 *  - parses to something that is not a non-null object ⇒ untouched, so
 *    `'"42"'` and `'"\\"hi\\""'` stay the strings the caller sent.
 *
 * A failed parse is REPORTED, not thrown — see the module header. */
export function parseRawJsonValue(value: unknown): { ok: true; value: unknown } | { ok: false; raw: string } {
  if (typeof value !== 'string') return { ok: true, value };
  const trimmed = value.trim();
  const looksLikeJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!looksLikeJson) return { ok: true, value };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, raw: value };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: true, value };
  return { ok: true, value: parsed };
}

/**
 * Does this position's declared schema expect a structured value?
 *
 * Lifted from the flag-less auto-parse branch's own inline test
 * (mcpServer.ts:1106-1109) — the branch that parses WITHOUT the flag already
 * asks the schema first; the branch that parses WITH the flag did not.
 * Extracting the test that already exists and applying it to both is what
 * makes the loud failure safe.
 */
export function expectsStructuredValue(schema: RawJsonSchemaLike): boolean {
  return schema?.type === 'object' || schema?.type === 'array' || schema?.type === 'matrix';
}

/**
 * The one loop both relay paths call. `container` is either a record keyed by
 * parameter name (full mode) or the positional `args` array (compact mode).
 *
 * Returns the same container (by identity) when nothing parsed, so the common
 * case allocates nothing and no caller has to reason about a fresh copy.
 */
export function applyRawJson<T extends Record<string, unknown> | unknown[]>(
  container: T,
  opts: ApplyRawJsonOptions,
): { value: T; structuredFailures: RawJsonFailure[] } {
  const isArray = Array.isArray(container);
  const positions: Array<string | number> = isArray
    ? (container as unknown[]).map((_, i) => i)
    : (opts.keys ?? Object.keys(container as Record<string, unknown>)).slice();
  const source = container as unknown as Record<string | number, unknown>;
  const structuredFailures: RawJsonFailure[] = [];
  // Copy-on-write, preserving the container's kind: a positional `args` array
  // must stay an array (a `{...array}` spread would silently turn it into an
  // index-keyed object, which the tab would then receive positionally wrong).
  let next: unknown[] | Record<string, unknown> | undefined;

  for (let i = 0; i < positions.length; i++) {
    const key = positions[i]!;
    const original = source[key];
    const parsed = parseRawJsonValue(original);
    if (parsed.ok) {
      if (parsed.value !== original) {
        if (next === undefined) {
          next = isArray ? [...(container as unknown[])] : { ...(container as Record<string, unknown>) };
        }
        if (Array.isArray(next)) next[i] = parsed.value;
        else next[key as string] = parsed.value;
      }
      continue;
    }
    // A failed parse at a position the schema proves was meant to be
    // structured is the case where the caller's belief that the flag was
    // honoured is provably false — report it, leave the value alone.
    if (expectsStructuredValue(opts.schemaAt(i))) {
      structuredFailures.push({ path: opts.pathAt(i), raw: parsed.raw });
    }
  }

  return { value: (next ?? container) as T, structuredFailures };
}

/**
 * The one message both handlers emit, so AC-7's byte-parity between the two
 * paths holds by construction rather than by two writers agreeing. Names the
 * flag, the position, and what to send instead.
 */
export function rawJsonFailureMessage(toolName: string, path: string, raw: string): string {
  return (
    `${toolName}: _rawJson — ${path} could not be parsed as JSON, so it was not forwarded. ` +
    `Send a real object/array, or a valid JSON string such as '{"pageWidth":1500}' or '[1,0,0,1,0,0]'. ` +
    `Offending value: ${raw}`
  );
}
