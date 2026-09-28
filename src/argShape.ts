import type { ParamSchemaLike } from './tools';

/**
 * REQ-1268 T5 (AC-5) — detect a wrong wire shape, and explain it.
 *
 * The incident (2026-09-26): an agent sent `layer.batch`'s ops array as
 * `{"item": …}` — a single-key envelope — at BOTH array levels, because the
 * host harness collapsed nested arrays. The editor rejected it correctly
 * (`ops must be array (got object)`) and figpea-mcp relayed that verbatim, so
 * the agent spent a round trip to learn nothing it could not have been told
 * up front.
 *
 * This module is the pre-flight half of the fix: pure, schema-driven, no
 * bridge, no I/O — so it can be unit-tested in isolation and costs a mangled
 * payload ZERO round trips.
 *
 * ⛔ DETECT AND EXPLAIN, NEVER REPAIR. Nothing here unwraps `{"item": X}` back
 * to `X`. The requirement's own decision note recommends against it: it
 * treats one observed symptom, and it would silently accept a malformed shape
 * — including a legitimate single-key argument object that happens to be
 * named `item`. Naming the wrong thing is a bad round trip; silently
 * reinterpreting the agent's payload is a wrong design.
 */

/** A detected shape problem, located precisely enough to fix blind. */
export interface ArgShapeMismatch {
  /** Dotted path into the positional args, e.g. `args[0]` or `args[0][1].props`. */
  path: string;
  /** What the declared schema wants, in words. */
  expected: string;
  /** What actually arrived, in words. */
  got: string;
  /** The rule that fired, in a sentence an agent can act on. */
  hint: string;
  /**
   * REQ-1309 — the code to report with this mismatch, when it is not this
   * server's own. The wire-shape rule above is ours (`invalid_params`, a
   * pre-flight invention). The per-kind rule is the EDITOR's
   * (`invalid_transform`), replayed one round trip earlier — and the whole
   * point of the requirement is that an agent which hits both paths reads one
   * rule, not two. Carrying the code on the mismatch keeps the two rules one
   * reporting family instead of two wrappers that each know their own code.
   */
  code?: string;
}

/** Bounds, so a pathological payload cannot make the check expensive. The
 *  whole check runs before a bridge round trip; it must stay far cheaper than
 *  the round trip it saves. Exported (REQ-1309) because a second rule shares
 *  them, and a constant nothing can read is a constant nothing can pin. */
export const MAX_DEPTH = 12;
export const MAX_NODES = 4000;

export interface Budget {
  nodes: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArraySchema(schema: ParamSchemaLike | undefined): boolean {
  return schema?.type === 'array' || schema?.type === 'matrix';
}

/** Human wording for a schema, used in the `expected` field. */
function describeSchema(schema: ParamSchemaLike | undefined): string {
  if (!schema) return 'a value';
  switch (schema.type) {
    case 'array':
      return schema.of ? `an array of ${describeSchema(schema.of)}` : 'an array';
    case 'matrix':
      return 'an array of numbers';
    case 'object':
      return 'an object';
    case 'number':
      return 'a number';
    case 'string':
      return 'a string';
    case 'boolean':
      return 'a boolean';
    default:
      return `a ${schema.type}`;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array (length ${value.length})`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 1
      ? `an object with the single key "${keys[0]}"`
      : `an object with keys ${keys.join(', ')}`;
  }
  return `a ${typeof value}`;
}

/**
 * The single-key array envelope the harness produces, recognised narrowly.
 *
 * ⚠️ DELIBERATE NARROWING, deviating from the plan's first draft on purpose.
 * The plan sketched Rule B as firing "at a position declared
 * `array`/`matrix`/`object`". Including `object` contradicts the plan's own
 * stated intent two sentences later — *"it never triggers on a legitimate
 * `{"item": …}` argument"* — because a single-key object at an **object**
 * position is exactly such a legitimate argument, and flagging it would steal
 * a round trip on a call the editor would have handled. So Rule B fires only
 * where the schema positively declares an array/matrix. Shapes it cannot
 * classify are not silently dropped either: the caller appends the same hint
 * to a tab-returned `invalid_params`, which is the belt-and-braces half.
 */
function isSingleKeyEnvelope(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'item';
}

/**
 * Finds the FIRST shape mismatch between `value` and the declared `schema`,
 * or `undefined` when the value is consistent with it.
 *
 * Rules:
 *  - A (the incident's own failure): a plain object at a position the schema
 *    declares `array`/`matrix`.
 *  - B (the harness's collapse signature): a single-key `{"item": …}` object
 *    at a position the schema declares `array`/`matrix` — reported with the
 *    envelope-specific hint.
 *  - Otherwise: descend through declared `object.shape` and `array.of` so a
 *    mismatch nested deep inside a batch op is still found.
 */
export function findArgShapeMismatch(
  value: unknown,
  schema: ParamSchemaLike | undefined,
  path: string,
  depth = 0,
  budget: Budget = { nodes: 0 },
): ArgShapeMismatch | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (budget.nodes++ > MAX_NODES) return undefined;
  if (!schema) return undefined;

  if (isArraySchema(schema)) {
    if (isPlainObject(value)) {
      const envelope = isSingleKeyEnvelope(value);
      return {
        path,
        expected: describeSchema(schema),
        got: describeValue(value),
        hint: envelope
          ? `Your host collapsed a nested array into a single-key {"item": …} envelope. ${schema.type === 'array' ? 'Pass the array itself — an array of ' + describeSchema(schema.of) + '.' : ''} Never wrap an array in an object.`
          : `${schema.type === 'array' ? 'This parameter is an array' : 'This parameter is an array of numbers'} and it arrived as an object. Pass the array itself, positionally, with no wrapper key.`,
      };
    }
    if (Array.isArray(value) && schema.of) {
      for (let i = 0; i < value.length; i++) {
        const found = findArgShapeMismatch(value[i], schema.of, `${path}[${i}]`, depth + 1, budget);
        if (found) return found;
      }
    }
    return undefined;
  }

  if (schema.type === 'object' && isPlainObject(value)) {
    if (!schema.shape) return undefined;
    for (const [key, sub] of Object.entries(schema.shape)) {
      if (!(key in value)) continue;
      const found = findArgShapeMismatch(value[key], sub, `${path}.${key}`, depth + 1, budget);
      if (found) return found;
    }
    return undefined;
  }

  return undefined;
}

/* ------------------------------------------------------------------ *
 * REQ-1309 — the PER-KIND prop applicability rule.
 *
 * The incident: an agent sent `layer.create("text", {…, x, y})`. The editor
 * rejected it correctly (`invalid_transform`, naming `x, y`) and figpea-mcp
 * relayed that verbatim — so the agent spent a whole round trip to learn
 * something the manifest already in this server's memory said for free: which
 * props THAT kind takes.
 *
 * ⛔ DERIVE, NEVER ENUMERATE. Nothing below names a method or a kind. The rule
 * is keyed on the manifest carrying a `byKind`-bearing param beside exactly one
 * string-enum sibling, so a method published that way is covered with no edit
 * here, and a kind that later gains a field is right for free. A hard-coded
 * kind list would be a drift generator the very next contract change has to
 * come back and edit.
 *
 * ⛔ DECLINE RATHER THAN GUESS. Zero opinions ⇒ forward the call. Every guard
 * below (no schema, no single selector, a kind outside the selector's enum, a
 * kind absent from `byKind`, a non-object value, an exhausted budget) is the
 * conservative direction: a false rejection of a call the editor accepts is the
 * expensive mistake, and deferring to the tab is what this server does
 * everywhere else.
 */

/** The editor's code for "these props do not apply to the requested kind",
 *  relayed rather than invented — the manifest's own `errorCodes` list carries
 *  it, so there is no local code registry here to fall out of date. */
const INVALID_TRANSFORM = 'invalid_transform';

/**
 * The allowed-key set for one `(param, kind)` pair: the param's common `shape`
 * merged with that kind's own `byKind` entry.
 *
 * Memoized on a module-level `WeakMap` keyed by the schema object (stable for
 * a registration's lifetime) and then by kind, exactly as the editor memoizes
 * its own `ALLOWED_CREATE_KEYS` at module load. The first call for a pair
 * builds the set; every later call is one `Map.get` and returns the IDENTICAL
 * instance — which is what keeps a check that runs on every contract call
 * O(props keys) rather than O(schema size).
 */
const ALLOWED_BY_KIND = new WeakMap<ParamSchemaLike, Map<string, ReadonlySet<string>>>();

/** The memoized `shape` ∪ `byKind[kind]` key set. Returns the identical frozen
 *  `Set` instance on every call for the same `(schema, kind)` pair. */
export function kindAllowedKeys(schema: ParamSchemaLike, kind: string): ReadonlySet<string> {
  let perKind = ALLOWED_BY_KIND.get(schema);
  if (!perKind) {
    perKind = new Map();
    ALLOWED_BY_KIND.set(schema, perKind);
  }
  const cached = perKind.get(kind);
  if (cached) return cached;
  const keys = new Set<string>(Object.keys(schema.shape ?? {}));
  for (const key of Object.keys(schema.byKind?.[kind] ?? {})) keys.add(key);
  const built = Object.freeze(keys) as ReadonlySet<string>;
  perKind.set(kind, built);
  return built;
}

/**
 * The sibling param that SELECTS which `byKind` entry applies.
 *
 * "Exactly one" is the whole guard, and it is structural rather than
 * name-based: a method publishing a second string-enum param next to its
 * per-kind props has made the selector ambiguous, and a guess here would reject
 * a call the editor accepts. Zero or several ⇒ no opinion.
 */
function findKindSelector(
  paramSchemas: Record<string, ParamSchemaLike>,
  forParam: string,
): { name: string; values: string[] } | undefined {
  const candidates = Object.entries(paramSchemas).filter(
    ([name, schema]) =>
      name !== forParam && schema.type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0,
  );
  if (candidates.length !== 1) return undefined;
  return { name: candidates[0][0], values: candidates[0][1].enum! };
}

/**
 * The editor's own rejection text for props that do not apply to a kind, built
 * from the transcription the server holds — NOT imported, because this is a
 * standalone package with no sibling editor checkout. Every value here comes
 * from the manifest or the call, so a kind this package has never heard of
 * renders correctly for free.
 *
 * The `Applicable props for "…": …` line is the editor's string with the
 * editor's own ordering, which is what makes AC-2's "an agent that hit both
 * paths reads one rule" true in fact and not just in intent.
 */
function kindPropHint(kind: string, sortedOffenders: string[], applicable: ReadonlySet<string>): string {
  const applicableList = Array.from(applicable).sort().join(', ');
  return (
    `these props do not apply to kind "${kind}": ${sortedOffenders.join(', ')}.\n` +
    `Applicable props for "${kind}": ${applicableList}\n` +
    `(the manifest's params.props.shape merged with params.props.byKind.${kind} — the editor rejects this ` +
    `identical call with the identical code, one tab round trip later).\n` +
    `Nothing was created.`
  );
}

/**
 * Finds a prop that the requested kind does not accept, or `undefined` when
 * this call has no opinion (which includes every call the editor accepts).
 *
 * @param paramSchemas the call's declared param schemas, keyed by param name
 * @param values       the call's values, keyed by the SAME param names
 * @param pathFor      renders a param name as the path this lane names it
 *                     (`args[1]` in compact mode, the bare name in full mode)
 * @param budget       shared node allowance; exhausted ⇒ no opinion
 */
export function findKindPropMismatch(
  paramSchemas: Record<string, ParamSchemaLike> | undefined,
  values: Record<string, unknown>,
  pathFor: (paramName: string) => string,
  budget: Budget = { nodes: 0 },
): ArgShapeMismatch | undefined {
  if (!paramSchemas) return undefined;
  for (const [paramName, schema] of Object.entries(paramSchemas)) {
    if (!schema.byKind || Object.keys(schema.byKind).length === 0) continue;
    if (budget.nodes++ > MAX_NODES) return undefined;
    const selector = findKindSelector(paramSchemas, paramName);
    if (!selector) continue;
    const kind = values[selector.name];
    // A kind the selector does not list, or that this build of the manifest
    // does not describe, is the tab's error to name — not ours to guess at.
    if (typeof kind !== 'string' || !selector.values.includes(kind)) continue;
    if (!Object.prototype.hasOwnProperty.call(schema.byKind, kind)) continue;
    const props = values[paramName];
    if (!isPlainObject(props)) continue;
    const allowed = kindAllowedKeys(schema, kind);
    const offenders: string[] = [];
    for (const key of Object.keys(props)) {
      if (budget.nodes++ > MAX_NODES) return undefined;
      // The editor's own rule: a key present with value `undefined` is never
      // written, so it is never a rejection either.
      if (props[key] !== undefined && !allowed.has(key)) offenders.push(key);
    }
    if (offenders.length === 0) continue;
    offenders.sort();
    return {
      code: INVALID_TRANSFORM,
      path: pathFor(paramName),
      expected: `an object whose keys apply to kind "${kind}"`,
      got: describeValue(props),
      hint: kindPropHint(kind, offenders, allowed),
    };
  }
  return undefined;
}

/** Renders a schema as a short JSON-ish example, for an error message that
 *  shows the shape instead of only naming it. */

export function renderSchemaExample(schema: ParamSchemaLike | undefined, depth = 0): string {
  if (!schema || depth > 4) return '…';
  switch (schema.type) {
    case 'array': {
      if (schema.of?.type === 'object' && schema.of.shape) {
        const inner = Object.entries(schema.of.shape)
          .slice(0, 4)
          .map(([k, v]) => `"${k}": ${renderSchemaExample(v, depth + 1)}`)
          .join(', ');
        return `[{ ${inner} }]`;
      }
      return `[${renderSchemaExample(schema.of, depth + 1)}]`;
    }
    case 'matrix':
      return '[0, 0, 0, 1, 0, 0]';
    case 'object': {
      if (!schema.shape) return '{ … }';
      const inner = Object.entries(schema.shape)
        .slice(0, 4)
        .map(([k, v]) => `"${k}": ${renderSchemaExample(v, depth + 1)}`)
        .join(', ');
      return `{ ${inner} }`;
    }
    case 'number':
      return '0';
    case 'string':
      return '"…"';
    case 'boolean':
      return 'false';
    default:
      return '…';
  }
}
