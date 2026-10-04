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
  /**
   * REQ-1444 — the value this rule is ABOUT, carried rather than re-derived at
   * the reporting site.
   *
   * Both new rules answer a question the pure module cannot: "is the file this
   * path names actually there?" That needs `fs.stat`, and an `fs` call in here
   * would break the very property (no I/O, unit-testable in isolation) that
   * makes this module worth having. So the predicate reports the VALUE and the
   * one site that already does I/O picks the code — which is also the only way
   * both readings of a "did the pre-flight swallow the missing-file case?"
   * requirement can be satisfied with the answer that is true in each.
   */
  offendingValue?: string;
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

/** Is this value a string whose trimmed form is `{…}`- or `[…]`-wrapped — the
 *  single narrow guard REQ-1318's Rule C fires on. Deliberately the same
 *  predicate `rawJson.ts`'s `parseRawJsonValue` uses, so the pre-flight and the
 *  parse it precedes can never disagree about what "JSON-looking" means. */
function looksLikeJsonLiteral(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

/** The one route that survives a collapsing host, appended to a hint that
 *  would otherwise be a dead end (REQ-1318, AC-4).
 *
 *  The envelope hint names the mistake and the fix for an agent whose host is
 *  well-behaved — but the whole reason the envelope arrived is that the host is
 *  NOT well-behaved, and such a host may not survive being told to send a real
 *  nested array. The one thing it cannot damage is a SCALAR. So the hint now
 *  ends with the route this server actually implements: a structured parameter
 *  may travel as a JSON string, and the server parses it.
 *
 *  A payload to copy rather than an abstract rule — the REQ-1268 idiom, because
 *  an agent left to construct the escaping itself will get it wrong. */
function jsonStringEscapeHatch(): string {
  const payload = '[{"method":"create","args":["rect",{"rwidth":100}]}]';
  return (
    ' Or send it as a JSON string — a string is a scalar, which no host collapses — and this server will parse it, e.g. ' +
    JSON.stringify(payload) +
    '. figpea_describe({group, method}) lists this method\'s own string-capable params as stringJsonParams.'
  );
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

  // REQ-1318 Rule C — the STRINGIFIED case, which until now was a dead end: a
  // string is not a plain object, so Rule A/B never saw it, the value reached
  // the tab, and the agent got the editor's bare `props must be object (got
  // string)` — naming neither remedy, one wasted round trip later.
  //
  // ⛔ WHY THE GUARD IS THIS NARROW, and why firing on ANY string at a
  // structured position would be rejected rather than merely narrowed. By the
  // time this pre-flight runs, the server's schema-scoped parse has ALREADY
  // parsed every JSON-looking string at a structured position it could rescue.
  // So the only strings left here are ones the escape hatch could not fix:
  // malformed (`"{name: 'x'}"`, truncated JSON) or shape-mismatched
  // (`"[1,2,3]"` at an object position). A value that does not LOOK like JSON
  // is left to the tab, exactly as today — refusing it would invent a
  // pre-flight rejection class with a false-rejection risk the editor does not
  // have, and a false rejection is the expensive direction.
  //
  // Both routes are named, because for a malformed payload the real object is
  // a fix and the JSON string is not, and for a shape-mismatched one the
  // reverse — the agent needs to know which it has before it retries.
  if (looksLikeJsonLiteral(value) && (schema.type === 'object' || isArraySchema(schema))) {
    return {
      path,
      expected: describeSchema(schema),
      got: describeValue(value),
      hint:
        `Send a real ${describeSchema(schema)} at this position, or send a JSON string and this server will parse it for you. ` +
        `The string arrived unparsed, so it is either not valid JSON or it parses to the wrong kind for a parameter declared ${describeSchema(schema)} — ` +
        jsonStringEscapeHatch() +
        `Offending value: ${value}.`,
    };
  }

  if (isArraySchema(schema)) {
    if (isPlainObject(value)) {
      const envelope = isSingleKeyEnvelope(value);
      return {
        path,
        expected: describeSchema(schema),
        got: describeValue(value),
        hint: envelope
          ? `Your host collapsed a nested array into a single-key {"item": …} envelope. ${schema.type === 'array' ? 'Pass the array itself — an array of ' + describeSchema(schema.of) + '.' : ''} Never wrap an array in an object.${jsonStringEscapeHatch()}`
          : `${schema.type === 'array' ? 'This parameter is an array' : 'This parameter is an array of numbers'} and it arrived as an object. Pass the array itself, positionally, with no wrapper key.${jsonStringEscapeHatch()}`,
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

/* ------------------------------------------------------------------ *
 * REQ-1295 — the DECLARED-WRAPPER rule.
 *
 * The incident: an agent read `describe()`'s `params` — a NAMED declaration —
 * and sent exactly that, so the wrapper arrived where the object itself was
 * due. The editor then validated the WRAPPER as the patch and answered
 * `unsupported_style_key: patch`: an error asserting that a style key the
 * caller never sent was disallowed, sending the agent hunting a problem it does
 * not have. The declaration is the editor's and is correct; the description is
 * what misleads, so the refusal is relay-side and pre-flight.
 *
 * ⛔ THREE CONDITIONS, ALL NARROWER THAN THE CLASS, because a false rejection
 * of a call the editor accepts is the expensive direction (the rule recorded
 * above this section). In particular the editor EXPANDS a single object keyed
 * by a method's own parameter names — `registry.ts:130`, `raw.length !== 1` —
 * so "never pass a name-keyed object" would be false, and two published
 * examples depend on the form working.
 *
 * ⛔ DECLINE RATHER THAN GUESS, like every other rule here: no schemas, no
 * declared shape to tell two readings apart, a value that is not an object, an
 * exhausted budget, or a call the editor might still expand ⇒ forward it.
 */

/**
 * The explanation, derived from the manifest so it cannot name a parameter
 * that does not exist, and carrying NO claim about style keys — the one thing
 * today's message gets wrong. An appended hint that kept the editor's wording
 * would reintroduce the false lesson with extra words.
 */
function declaredWrapperHint(
  paramName: string,
  contents: string[],
  sentKeys: string[],
): string {
  const sample = contents.slice(0, 3).join(', ');
  return (
    `The object at this position arrived keyed by ${sentKeys.map((k) => `"${k}"`).join(', ')} — the manifest's own ` +
    `DECLARATION of ${paramName}, sent instead of the contents. The declaration is not the encoding: ` +
    `${paramName} IS this positional slot, so send its contents flat (keys: ${sample}${contents.length > 3 ? ', …' : ''}) ` +
    `with no "${paramName}" wrapper. `
  );
}

/**
 * Finds a declared wrapper sent where an object's CONTENTS were due, or
 * `undefined` when this call has no opinion — which includes every call the
 * editor accepts.
 *
 * Fires only when all three hold:
 *  1. **Wrapper signature** — every key of the value is a declared param name
 *     of this method, and there is at least one. This is what "you sent the
 *     descriptor's named declaration" means, and it is why an arbitrary
 *     unknown key is never flagged: only this method's own names can form the
 *     signature.
 *  2. **Not contents** — the parameter declares a `shape` (or `byKind`), and
 *     NO key of the value is one of its legal keys. A legitimate contents
 *     object that happens to contain a param-named key is therefore never
 *     flagged, and a parameter with no declared shape is declined outright:
 *     with nothing to tell the two readings apart, the tab's answer is the
 *     one that counts.
 *  3. **Provably unexpandable** — `positionalLength >= 2`. The tab receives
 *     this very array, spread into the method (`bridge/client.ts:69`,
 *     `fn(...frame.args)`), and the editor's wrapper expansion runs only for a
 *     call of exactly one argument. So at two or more there is no reading of
 *     the payload that works, and refusing costs nothing. At one, we decline.
 *
 * @param positionalLength the array the TAB will receive — the editor's own
 *                         `raw.length`, and the same number in both lanes
 */
export function findDeclaredWrapperMismatch(
  paramSchemas: Record<string, ParamSchemaLike> | undefined,
  values: Record<string, unknown>,
  pathFor: (paramName: string) => string,
  positionalLength: number,
  budget: Budget = { nodes: 0 },
): ArgShapeMismatch | undefined {
  if (!paramSchemas) return undefined;
  if (positionalLength < 2) return undefined;
  const declaredNames = new Set(Object.keys(paramSchemas));
  for (const [paramName, schema] of Object.entries(paramSchemas)) {
    if (budget.nodes++ > MAX_NODES) return undefined;
    if (schema.type !== 'object') continue;
    const value = values[paramName];
    if (!isPlainObject(value)) continue;
    const sentKeys = Object.keys(value);
    if (sentKeys.length === 0) continue;
    // (1) wrapper signature — every key is one of this method's param names.
    if (!sentKeys.every((key) => declaredNames.has(key))) continue;
    // (2) not contents — a declared shape must exist and none of the sent keys
    // may be one of its legal keys.
    const legal = new Set(Object.keys(schema.shape ?? {}));
    for (const kindFields of Object.values(schema.byKind ?? {})) {
      for (const key of Object.keys(kindFields)) legal.add(key);
    }
    if (legal.size === 0) continue;
    if (sentKeys.some((key) => legal.has(key))) continue;
    return {
      path: pathFor(paramName),
      expected: `the contents of "${paramName}" flat at this position`,
      got: describeValue(value),
      hint: declaredWrapperHint(paramName, Array.from(legal), sentKeys),
    };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * REQ-1444 — the THREE wrong-shape families, and the one predicate each needs.
 *
 * The incident (card REQ-1444, from the `2026-10-01-counterform-specimen-og`
 * `/design` run): an agent read `describe()`'s NAMED declaration and sent
 * exactly that — `openFile({input:{filePath:"/abs/path/design.fp"}})`. Compact
 * mode's local-file translation reads `args[0].filePath` POSITIONALLY, so the
 * envelope put the key one level too deep, nothing was translated, and the bare
 * local path was forwarded to the editor as a URL — which answered
 * `open_fetch_failed: HTTP 404 Not Found` about a file that exists. Three round
 * trips of that one class went into the filesystem instead of into the
 * argument.
 *
 * Every header rule above applies here without exception: pure, schema-driven,
 * no bridge, no I/O; derive, never enumerate; decline rather than guess; detect
 * and explain, never repair.
 * ------------------------------------------------------------------ */

/**
 * The transport's own key. Not an enumeration: this module exists to reason
 * about the one key this server reads positionally at three call sites, so the
 * key is the SUBJECT of the rule rather than one entry in a hard-coded list —
 * the same standing `isSingleKeyEnvelope` above has for `item`.
 */
const FILE_PATH_KEY = 'filePath';

/**
 * The explanation for a declared-wrapper envelope around a positional
 * `filePath`. ⛔ IT NEVER QUOTES A FETCH FAILURE, and that is the whole point:
 * no fetch happened, because the file was never asked for. Naming a 404 here
 * would repeat the very confusion this rule exists to end.
 */
function filePathEnvelopeHint(path: string, sentKeys: string[]): string {
  return (
    `The object at this position arrived keyed by ${sentKeys.map((k) => `"${k}"`).join(', ')} — this method's own named ` +
    `DECLARATION, sent around the contents that belong here. ` +
    `The local-file translation this server performs reads "${FILE_PATH_KEY}" straight out of ${path}, so an envelope leaves ` +
    `nothing for it to translate, and a bare local path reaches the editor where it expects a URL. ` +
    `Retrying this shape fails identically — the argument is what has to change, not the error. ` +
    `Send the contents flat, with "${FILE_PATH_KEY}" among them, e.g. {"${FILE_PATH_KEY}": "<absolute path>"}.`
  );
}

/**
 * Finds a single-argument declared-wrapper envelope that carries a local
 * `filePath` one level too deep for this server's own positional read, or
 * `undefined` when this call has no opinion — which includes every call the
 * editor accepts.
 *
 * ⛔ THE RULE IS NOT "WRAPPER ⇒ REFUSE". It fires only when all of these hold,
 * and each guard is the conservative direction because a false rejection of a
 * call the editor accepts is the expensive mistake:
 *
 *  1. **Exactly one argument.** At two or more the wrapper is not the whole of
 *     `args` and the editor cannot expand it (`registry.ts:130`, `raw.length
 *     !== 1`); the argument in front is what arrives instead, so no positional
 *     read is defeated by an envelope at all.
 *  2. **A plain object at `args[0]`**, and a wrapper SIGNATURE — every one of
 *     its keys is a declared parameter name of this method. The CORRECT flat
 *     spelling (`args[0]` being `{filePath: …}`) fails here and has to: that is
 *     what separates "the declaration was sent" from "the contents were sent".
 *  3. **A non-empty STRING path**, one level in, at one of those declared slots.
 *     `url`, `bytes` and the filename aliases carry nothing for the translation
 *     to miss, so `openFile({input:{url:"https://…"}})` — which SUCCEEDS today,
 *     because the editor expands the wrapper and opens the URL — is declined.
 *     So are an empty, blank or non-string path, which the reporting site's own
 *     guards already answer with their own messages.
 *
 * It reports `offendingValue` (the INNER path) so the one site that already
 * does I/O can answer the truthful thing in each case: `open_failed` /
 * `invalid_image_source` for a file that is not there, `invalid_params` for one
 * that is. See `ArgShapeMismatch.offendingValue` for why the verdict cannot
 * live here.
 *
 * @param pathFor          renders a param name as the path this lane names it
 * @param positionalLength the array the TAB will receive — the editor's own
 *                         `raw.length`, and the same number in both lanes
 */
export function findFilePathEnvelopeMismatch(
  paramSchemas: Record<string, ParamSchemaLike> | undefined,
  args: readonly unknown[],
  pathFor: (paramName: string) => string,
  positionalLength: number,
  budget: Budget = { nodes: 0 },
): ArgShapeMismatch | undefined {
  if (!paramSchemas) return undefined;
  if (positionalLength !== 1) return undefined;
  if (budget.nodes++ > MAX_NODES) return undefined;
  const only = args[0];
  if (!isPlainObject(only)) return undefined;
  const declaredNames = new Set(Object.keys(paramSchemas));
  const sentKeys = Object.keys(only);
  if (sentKeys.length === 0) return undefined;
  // (2) wrapper signature — only this method's own names can form one.
  if (!sentKeys.every((key) => declaredNames.has(key))) return undefined;
  // (3) the contents, one level in, carrying a real path to translate.
  for (const paramName of Object.keys(paramSchemas)) {
    if (budget.nodes++ > MAX_NODES) return undefined;
    if (paramSchemas[paramName]?.type !== 'object') continue;
    const inner = only[paramName];
    if (!isPlainObject(inner)) continue;
    const filePath = inner[FILE_PATH_KEY];
    if (typeof filePath !== 'string' || filePath.trim() === '') continue;
    const path = pathFor(paramName);
    return {
      path,
      expected: `the object itself at this position, with "${FILE_PATH_KEY}" as one of its own keys`,
      got: describeValue(only),
      hint: filePathEnvelopeHint(path, sentKeys),
      offendingValue: filePath,
    };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * REQ-1498 — the SINGULAR wrong-shape family: a bare local path where an
 * OBJECT was due.
 *
 * The incident (card REQ-1498): `figpea_call({group:'session',
 * method:'openFile', args:['/abs/path/x.fp']})` reported success while
 * opening nothing. Walked through this server, EVERY pre-flight above
 * declines a string at an object slot — `applyStructuredStringJson` skips it
 * (not JSON-looking), `findFilePathEnvelopeMismatch` needs a plain object
 * (see the `positionalLength !== 1` / `isPlainObject` guards above), and
 * Rule C fires only on a JSON-LOOKING string — so the path was forwarded
 * verbatim and the `ok:true` was the TAB's answer relayed back.
 *
 * ⛔ THE DECLINE SET IS THE RULE. Every guard below is the conservative
 * direction, because a false rejection of a call the editor accepts is the
 * expensive mistake (the standing rule at the top of this module):
 *
 *  1. **A declared `filePath` to have a name to give.** Fires only where a
 *     TOP-LEVEL `object` param's declared `shape` contains `filePath`. That
 *     is derived from the manifest, so `session.openFile`, `layer.create`'s
 *     `props`, `layer.setImageFill`'s `source` and any future method
 *     published that way are covered with no edit here — and a method whose
 *     object has no `filePath` has nothing this rule could say, so it is
 *     declined rather than answered about the wrong thing.
 *  2. **A plain STRING**, non-blank, and not JSON-looking. REQ-1318's Rule C
 *     owns the JSON-looking case above and must stay the single answer to
 *     it; `null`/`undefined` and every non-string decline outright.
 *
 * `valueAt` is a lookup rather than a positional array because the two lanes
 * name a parameter's value differently — `args[i]` in compact mode, the
 * parameter's own key in full mode — and this rule must not have to know
 * which one it is in.
 * ------------------------------------------------------------------ */

/**
 * The explanation for a bare path sent where an object was due. ⛔ IT NEVER
 * QUOTES A FETCH FAILURE and never claims a file was opened, for the same
 * reason `filePathEnvelopeHint` above does: nothing was fetched, because
 * nothing was translated.
 */
function singularFilePathHint(path: string): string {
  return (
    `A bare string arrived where ${path}'s object belongs, and it reads as a local file path — this method's own ` +
    `declaration lists "${FILE_PATH_KEY}" among that object's keys. This server reads "${FILE_PATH_KEY}" straight out ` +
    `of the object, so a bare string leaves nothing to translate and the path reaches the editor where it expects a ` +
    `URL. Retrying this shape fails identically — the argument is what has to change, not the error. ` +
    `Send the object with "${FILE_PATH_KEY}" among its keys, e.g. {"${FILE_PATH_KEY}": "<absolute path>"}.`
  );
}

/**
 * Finds a bare local path sitting where a `filePath`-bearing object was due, or
 * `undefined` when this call has no opinion — which includes every call the
 * editor accepts.
 *
 * It reports `offendingValue` (the path the caller sent) so the ONE site that
 * already does I/O can answer the truthful thing in each case: the site's own
 * missing-file code when the file is not there, and this server's
 * `invalid_params` when it is. See `ArgShapeMismatch.offendingValue` for why
 * that verdict cannot live in here.
 *
 * @param paramSchemas the call's declared param schemas, keyed by param name
 * @param valueAt      reads the value sent for a param, in whichever naming
 *                     this lane uses
 * @param pathFor      renders a param name as the path this lane names it
 *                     (`args[0]` in compact mode, the bare name in full mode)
 */
export function findSingularFilePathMismatch(
  paramSchemas: Record<string, ParamSchemaLike> | undefined,
  valueAt: (paramName: string) => unknown,
  pathFor: (paramName: string) => string,
  budget: Budget = { nodes: 0 },
): ArgShapeMismatch | undefined {
  if (!paramSchemas) return undefined;
  for (const [paramName, schema] of Object.entries(paramSchemas)) {
    if (budget.nodes++ > MAX_NODES) return undefined;
    // (1) a declared object param whose own shape has a `filePath` to name.
    if (schema?.type !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(schema.shape ?? {}, FILE_PATH_KEY)) continue;
    // (2) a plain, non-blank, non-JSON-looking string.
    const value = valueAt(paramName);
    if (typeof value !== 'string') continue;
    if (value.trim() === '') continue;
    if (looksLikeJsonLiteral(value)) continue;
    const path = pathFor(paramName);
    return {
      path,
      expected: `the object itself at this position, with "${FILE_PATH_KEY}" as one of its own keys`,
      got: describeValue(value),
      hint: singularFilePathHint(path),
      offendingValue: value,
    };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The create()-prop derivation, for the RELAY-SIDE half (REQ-1444 AC-4).
 *
 * `layer.create` accepts a `style` PROP — geometry and appearance nested one
 * level down, `{style:{fontSize:26}}` — while `stylePatch` takes style keys
 * FLAT. An agent that learned the first and called the second is answered
 * `unsupported_style_key: "style"`, which is accurate about what arrived and
 * points at the wrong thing to change, exactly like the envelope above.
 *
 * ⛔ DERIVED, NEVER ENUMERATED. The common-prop set is read out of the
 * manifest this server already holds (`params.props.shape` of any
 * create-shaped declaration), so a prop added upstream is right here with no
 * edit, and a method published the same way is covered for free.
 * ------------------------------------------------------------------ */

const CREATE_COMMON_PROP_NAMES = new WeakMap<ParamSchemaLike, ReadonlySet<string>>();

/**
 * The props that apply to EVERY kind, derived from a create-shaped params
 * declaration — an object param publishing per-kind entries — and memoized on
 * that declaration's schema object exactly as `kindAllowedKeys` above memoizes
 * its own, so a check that runs on every relayed failure costs one
 * `WeakMap.get` thereafter and returns the IDENTICAL frozen instance.
 *
 * `undefined` (no opinion) when there is no such declaration, or when it
 * declares no `shape`: an empty set would read as "this method has no common
 * props", which is a claim, and this rule has none to make.
 */
export function createCommonPropNames(createPropsSchema: ParamSchemaLike | undefined): ReadonlySet<string> | undefined {
  if (!createPropsSchema) return undefined;
  if (!createPropsSchema.byKind || Object.keys(createPropsSchema.byKind).length === 0) return undefined;
  if (!createPropsSchema.shape) return undefined;
  const cached = CREATE_COMMON_PROP_NAMES.get(createPropsSchema);
  if (cached) return cached;
  const built = Object.freeze(new Set(Object.keys(createPropsSchema.shape))) as ReadonlySet<string>;
  CREATE_COMMON_PROP_NAMES.set(createPropsSchema, built);
  return built;
}

/** `{fontSize: 26, fontFamily: "Inter"}` — a payload to copy rather than an
 *  abstract rule, rendered from the keys the caller actually sent (the
 *  REQ-1268 idiom). A nested value renders as `…` rather than being expanded:
 *  the claim being made is about the KEYS being flat, not about their depth. */
function renderFlatObject(value: Record<string, unknown>): string {
  const entries = Object.entries(value).map(([key, v]) => `${key}: ${v !== null && typeof v === 'object' ? '…' : JSON.stringify(v)}`);
  return `{${entries.join(', ')}}`;
}

/**
 * The lesson for a `create()` prop sent as a style key, or `undefined` when it
 * would explain nothing — which is every `unsupported_style_key` that is not
 * this mistake.
 *
 * Fires only when ALL hold: the offending key IS one of the create-shaped
 * declaration's common props (read from the manifest, not from a list); an
 * object parameter of the CALLED method carries it; and the value sent under it
 * is a PLAIN OBJECT. That last guard is what makes "send it flat" unambiguous
 * and what lets the message show the keys actually sent. A genuinely unknown
 * style key, or a `style` sent as anything but an object, is somebody else's
 * error and gets no lesson here.
 *
 * ⛔ The leading argument of the rendered flat form is the caller's OWN first
 * positional value, not a literal placeholder for a named parameter: naming one
 * would be the enumeration this module's header forbids, and it would read as a
 * claim about a parameter name that a future declaration could change.
 */
export function createPropStyleHint(
  group: string,
  method: string,
  createPropsSchemas: readonly ParamSchemaLike[],
  paramSchemas: Record<string, ParamSchemaLike> | undefined,
  values: Record<string, unknown> | undefined,
  propName: string,
  firstArg: unknown,
): string | undefined {
  if (!paramSchemas || !values) return undefined;
  const isCommonProp = createPropsSchemas.some((schema) => createCommonPropNames(schema)?.has(propName));
  if (!isCommonProp) return undefined;
  for (const [paramName, schema] of Object.entries(paramSchemas)) {
    if (schema.type !== 'object') continue;
    const sent = values[paramName];
    if (!isPlainObject(sent)) continue;
    const inner = sent[propName];
    if (!isPlainObject(inner) || Object.keys(inner).length === 0) continue;
    const lead = typeof firstArg === 'string' ? firstArg : '…';
    return (
      `"${propName}" is a create() top-level prop, not a style key — ${method} takes style keys FLAT, so send them as ` +
      `${method}(${lead}, ${renderFlatObject(inner)}) with no "${propName}" wrapper. ` +
      `Learn the exact shape first: figpea_describe({group:"${group}", method:"${method}"}).`
    );
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The JSON-string blind spot, for the RELAY-SIDE half (REQ-1444 AC-5).
 *
 * The escape hatch a host that collapses nesting needs is real and correct: a
 * string is a scalar, and this server parses a JSON-looking string at any
 * position the manifest declares as `object`/`array`/`matrix`. But
 * `applyStructuredStringJson` (`rawJson.ts:263-306`) iterates `positions` —
 * the container's TOP-LEVEL indices — and gates each on
 * `expectsStructuredValue(opts.schemaAt(i))`. With `args = [{pageId, patch:"…"}]`
 * position 0's schema is `pageId`, declared a string, so the gate is false and
 * the inner `patch` string is never visited.
 *
 * The result is a dead end: `setPageFill(): patch must be object (got string)`
 * names what arrived and nothing about what to send. This rule supplies both
 * ways out — and, deliberately, reuses `looksLikeJsonLiteral` above verbatim so
 * the lesson and the parse it explains can never disagree about what
 * "JSON-looking" means.
 * ------------------------------------------------------------------ */

/** `setPageFill(pageId, {…})` — the positional form, rendered from the
 *  manifest's own declared parameter names and order, with the offending slot
 *  shown as the object it has to be. Derived: a method this has never seen
 *  renders correctly. */
function renderPositionalCall(method: string, inputKeys: readonly string[], paramName: string): string {
  return `${method}(${inputKeys.map((name) => (name === paramName ? '{…}' : name)).join(', ')})`;
}

/**
 * Finds a JSON-looking string sitting at a parameter declared `object`/`array`
 * INSIDE a whole-`args` wrapper, or `undefined` when this call has no opinion.
 *
 * Declines on: no schemas (a legacy free-text manifest included), any arity but
 * one, a non-object `args[0]`, an object with no keys, keys that are not all
 * declared parameter names, a real object in the slot, a parameter declared a
 * scalar — a JSON-looking string at a declared `string` is a NAME and is never
 * parsed (`rawJson.ts`'s gate), so this rule has nothing to add — a string
 * that is not JSON-looking, and an exhausted budget.
 */
export function findNestedStructuredStringMismatch(
  paramSchemas: Record<string, ParamSchemaLike> | undefined,
  args: readonly unknown[],
  pathFor: (paramName: string) => string,
  budget: Budget = { nodes: 0 },
  positionalLength: number = args.length,
): ArgShapeMismatch | undefined {
  if (!paramSchemas) return undefined;
  if (positionalLength !== 1) return undefined;
  if (budget.nodes++ > MAX_NODES) return undefined;
  const only = args[0];
  if (!isPlainObject(only)) return undefined;
  const declaredNames = new Set(Object.keys(paramSchemas));
  const sentKeys = Object.keys(only);
  if (sentKeys.length === 0) return undefined;
  if (!sentKeys.every((key) => declaredNames.has(key))) return undefined;
  for (const paramName of Object.keys(paramSchemas)) {
    if (budget.nodes++ > MAX_NODES) return undefined;
    const schema = paramSchemas[paramName];
    if (schema?.type !== 'object' && !isArraySchema(schema)) continue;
    const value = only[paramName];
    if (!looksLikeJsonLiteral(value)) continue;
    return {
      // The slot the editor reads AFTER it expands the wrapper — which is also
      // the form the hint tells the caller to send, so the two cannot disagree.
      path: pathFor(paramName),
      expected: describeSchema(schema),
      got: describeValue(value),
      hint:
        `A JSON-looking string is not parsed where it sits: the JSON-string route visits WHOLE positional slots and never ` +
        `descends into an object, so a value stringified inside a real object arrives as the string it is. ` +
        `Send it as its own positional slot, with a real object there.`,
      offendingValue: value,
    };
  }
  return undefined;
}

/**
 * Both ways out, in one sentence: the positional form rendered from the
 * manifest, and WHY the JSON-string route did not save the call. Ends with the
 * same `figpea_describe` clause every other hint here uses, which is also what
 * makes `appendShapeHint` decline and keeps the agent to one appended sentence.
 */
export function nestedStringHint(
  group: string,
  method: string,
  inputKeys: readonly string[],
  paramSchemas: Record<string, ParamSchemaLike> | undefined,
  paramName: string,
): string | undefined {
  // No declaration of this parameter, no way to render its positional slot —
  // and a hint built from a guess is the same error as a pre-flight built from
  // one. `findNestedStructuredStringMismatch` has already proved the parameter
  // exists; this is the guard that keeps the two from drifting apart.
  if (!paramSchemas || !Object.prototype.hasOwnProperty.call(paramSchemas, paramName)) return undefined;
  return (
    `The JSON-string route visits WHOLE positional slots and never descends into an object, so a JSON string nested inside a ` +
    `real object is never parsed — which is what left "${paramName}" a string here. ` +
    `Send it positionally as ${renderPositionalCall(method, inputKeys, paramName)}, where "${paramName}" is its own slot with a ` +
    `real object in it. ` +
    `Learn the exact shape first: figpea_describe({group:"${group}", method:"${method}"}).`
  );
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
