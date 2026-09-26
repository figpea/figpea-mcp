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
}

/** Bounds, so a pathological payload cannot make the check expensive. The
 *  whole check runs before a bridge round trip; it must stay far cheaper than
 *  the round trip it saves. */
const MAX_DEPTH = 12;
const MAX_NODES = 4000;

interface Budget {
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
