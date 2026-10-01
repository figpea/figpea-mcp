import { describe, it, expect } from 'vitest';
import {
  isRawJsonFlag,
  parseRawJsonValue,
  expectsStructuredValue,
  rawJsonParseApplies,
  applyRawJson,
  rawJsonFailureMessage,
} from './rawJson';
import type { ParamSchemaLike } from './tools';

/**
 * REQ-1280 T2 — unit net for the shared `_rawJson` module.
 *
 * The behaviour ACs live in `req1280.test.ts` (driven through the real MCP
 * surface). This file is the *extraction* net (AC-7's "cannot drift" claim):
 * it pins the truthiness set, the shape test, the object-only guard, and above
 * all the GUARD MATRIX — which positions a failed parse is allowed to be loud
 * at, and which it must be left alone at, because that is the claim the
 * round-1 review made falsifiable.
 */

const schema = (type: string): ParamSchemaLike => ({ type, required: false });

describe('REQ-1280 — isRawJsonFlag: the truthiness set is full mode\'s, verbatim', () => {
  it('accepts exactly true, "true", 1 and "1"', () => {
    for (const v of [true, 'true', 1, '1']) expect(isRawJsonFlag(v), String(v)).toBe(true);
  });

  it('rejects everything else, including the near-misses a truthy coercion would accept', () => {
    // `'TRUE'`, `2`, `'yes'`, `[]` and `{}` are all TRUTHY in JS. A
    // `Boolean(v)` rule would accept every one of them; full mode has never
    // done that, and compact mode must not start now.
    for (const v of [false, 'false', 0, '0', '', 'TRUE', 2, 'yes', 'on', [], {}, null, undefined, NaN]) {
      expect(isRawJsonFlag(v), JSON.stringify(v) ?? String(v)).toBe(false);
    }
  });
});

describe('REQ-1280 — parseRawJsonValue: one parse, three untouched cases', () => {
  it('parses a stringified object and a stringified array', () => {
    expect(parseRawJsonValue('{"name":"probe","pageWidth":300}')).toEqual({
      ok: true,
      value: { name: 'probe', pageWidth: 300 },
    });
    expect(parseRawJsonValue('[1,0,0,1,0,0]')).toEqual({ ok: true, value: [1, 0, 0, 1, 0, 0] });
  });

  it('is trim-tolerant: surrounding whitespace does not disqualify a value', () => {
    expect(parseRawJsonValue('  \n {"a":1} \t ')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('leaves a non-string untouched — no copy, same identity', () => {
    const obj = { already: 'parsed' };
    const arr = [1, 2];
    expect(parseRawJsonValue(obj)).toEqual({ ok: true, value: obj });
    expect(parseRawJsonValue(arr)).toEqual({ ok: true, value: arr });
    expect(parseRawJsonValue(42)).toEqual({ ok: true, value: 42 });
    expect(parseRawJsonValue(null)).toEqual({ ok: true, value: null });
    expect(parseRawJsonValue(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('leaves a string that is not brace/bracket-wrapped untouched', () => {
    // The card's rule is explicitly element-wise on the TRIMMED form: a string
    // that merely mentions JSON, or is wrapped in the wrong delimiters, is
    // not a stringified value.
    for (const v of ['Hero', '[Hero', 'Hero]', '{a:1', '"quoted"', "'single'", '']) {
      expect(parseRawJsonValue(v), v).toEqual({ ok: true, value: v });
    }
  });

  it('leaves a JSON literal that is not an object/array a STRING (the object-only guard)', () => {
    // `'"42"'` parses to the number 42 and `'"\\"hi\\""'` to the string "hi" —
    // both must stay the strings the caller sent, or a `name` prop would
    // silently become a number. Lifted from the guard the inline loop carried.
    expect(parseRawJsonValue('"42"')).toEqual({ ok: true, value: '"42"' });
    expect(parseRawJsonValue('"\\"hi\\""')).toEqual({ ok: true, value: '"\\"hi\\""' });
    expect(parseRawJsonValue('42')).toEqual({ ok: true, value: '42' });
    expect(parseRawJsonValue('true')).toEqual({ ok: true, value: 'true' });
    expect(parseRawJsonValue('null')).toEqual({ ok: true, value: 'null' });
  });

  it('REPORTS a JSON-looking string that does not parse, keeping the raw value verbatim', () => {
    const raw = '  {name: "probe"}  ';
    expect(parseRawJsonValue(raw)).toEqual({ ok: false, raw });
    expect(parseRawJsonValue('[5,0,zz,0,0,0]')).toEqual({ ok: false, raw: '[5,0,zz,0,0,0]' });
    expect(parseRawJsonValue('{}')).toEqual({ ok: true, value: {} });
  });
});

describe('REQ-1280 — expectsStructuredValue: the guard, lifted not invented', () => {
  it('is true exactly for object, array and matrix', () => {
    expect(expectsStructuredValue(schema('object'))).toBe(true);
    expect(expectsStructuredValue(schema('array'))).toBe(true);
    expect(expectsStructuredValue(schema('matrix'))).toBe(true);
  });

  it('is false for a scalar position, and for a position with NO schema', () => {
    // `undefined` is the load-bearing case: a legacy free-text manifest, and
    // compact mode before any describe() has delivered one. Loudness there
    // would break `setName(id, '[Hero]')` and the first call of a session.
    for (const t of ['string', 'number', 'boolean', 'color', 'anything']) {
      expect(expectsStructuredValue(schema(t)), t).toBe(false);
    }
    expect(expectsStructuredValue(undefined)).toBe(false);
  });
});

describe('REQ-1338 — rawJsonParseApplies: the FLAG\'s guard, over the whole declared-type space', () => {
  // REQ-1338 AC-6 — the guard matrix for the new predicate. `expectsStructuredValue`
  // answers "is a structured value PROVABLY intended here?", which is the
  // flag-LESS route's question: skip unless the declaration says structured.
  // `rawJsonParseApplies` answers "MAY the flag parse this position?", and the
  // two differ in exactly one cell — the one that decides whether `_rawJson`
  // survives a cold start.
  it('is true for the structured declared types: the flag still converts what was meant to be converted', () => {
    for (const t of ['object', 'array', 'matrix']) {
      expect(rawJsonParseApplies(schema(t)), t).toBe(true);
    }
  });

  it('is false for a scalar declared position — a JSON literal there is TEXT the caller chose', () => {
    // The defect REQ-1338 exists to close. `setName(id, '[1,2,3]')` is a NAME;
    // parsing it produced an array, and the editor rejected the call for being
    // the wrong type — naming a type, and never the flag that caused it.
    for (const t of ['string', 'number', 'boolean', 'color', 'anything']) {
      expect(rawJsonParseApplies(schema(t)), t).toBe(false);
    }
  });

  it('is true where NO declaration is reachable — the flag\'s whole reason to exist', () => {
    // A compact-mode first call before any `describe()`, a legacy free-text
    // manifest, `FIGPEA_DISABLE_CONTRACT_FETCH=1`, a surplus positional
    // argument past the declared arity. With nothing declared there is nothing
    // to scope a parse to, so the flag parses. A predicate that skipped here
    // would make the flag manifest-dependent — dead on exactly the first call
    // an agent is most likely to make.
    expect(rawJsonParseApplies(undefined)).toBe(true);
    // A schema object that carries no `type` is the same state, not a third
    // answer: a hint the module cannot read must not be read as "scalar".
    expect(rawJsonParseApplies({} as ParamSchemaLike)).toBe(true);
  });

  it('DIFFERS from expectsStructuredValue in exactly the no-declaration cell — and the reason is the flag\'s design', () => {
    // The two predicates are one line apart and must NOT be collapsed into one
    // function. They agree on every NAMED declared type, and they disagree on
    // the one state that is not a declared type at all:
    //   - `expectsStructuredValue(undefined) === false` is what lets the
    //     flag-LESS default leave an undeclared value provably untouched;
    //   - `rawJsonParseApplies(undefined) === true` is what keeps the flag
    //     usable where there is no manifest.
    for (const s of [undefined, {} as ParamSchemaLike]) {
      expect(rawJsonParseApplies(s), 'the flag parses where nothing declares').toBe(true);
      expect(expectsStructuredValue(s), 'the default touches nothing there').toBe(false);
    }
    for (const t of ['object', 'array', 'matrix', 'string', 'number', 'boolean']) {
      expect(rawJsonParseApplies(schema(t)), t).toBe(expectsStructuredValue(schema(t)));
    }
    // Read together those two statements are the whole design: the flag's guard
    // is the flag-LESS route's guard everywhere except where a declaration is
    // missing, which is precisely the position the flag exists to reach.
  });

  it('applyRawJson leaves a declared-scalar value BYTE-IDENTICAL, and keeps the same container identity', () => {
    // The record form (full mode's named params): the flag is set, the value is
    // valid JSON, and the declaration says `string` — so nothing happens, and
    // the caller gets back the very container it sent.
    const args = { id: 'L1', name: '[1,2,3]' } as Record<string, unknown>;
    const applied = applyRawJson(args, {
      keys: ['id', 'name'],
      schemaAt: () => schema('string'),
      pathAt: (i) => (i === 0 ? 'id' : 'name'),
    });
    expect(applied.value).toBe(args);
    expect(applied.value.name).toBe('[1,2,3]');
    expect(applied.structuredFailures).toEqual([]);
  });

  it('applyRawJson over the ARRAY form: a declared scalar is skipped while a declared object still parses', () => {
    // Both halves in one call, which is the claim a reviewer should not have to
    // take on trust: the guard is per-POSITION, so narrowing one position never
    // narrows its neighbour.
    const schemas = [schema('string'), schema('object'), schema('string'), schema('array')];
    const applied = applyRawJson(['L1', '{"pageWidth":1500}', '[1,2,3]', '[{"method":"setName"}]'], {
      schemaAt: (i) => schemas[i],
      pathAt: (i) => `args[${i}]`,
    });
    expect(applied.value).toEqual(['L1', { pageWidth: 1500 }, '[1,2,3]', [{ method: 'setName' }]]);
    expect(applied.structuredFailures).toEqual([]);
  });

  it('a NO-DECLARATION position still parses — the rows above it in this file are unchanged and this is why', () => {
    // The existing no-manifest rows use `schemaAt: () => undefined` and are
    // left unedited; this is the same contract stated against the new predicate
    // directly, so the reason they still pass is visible rather than inferred.
    const applied = applyRawJson(['L1', '[1,2,3]'], { schemaAt: () => undefined, pathAt: (i) => `args[${i}]` });
    expect(applied.value).toEqual(['L1', [1, 2, 3]]);
  });

  it('a declared-scalar position is skipped BEFORE the parse, so a value that does not parse there is neither recorded nor reported', () => {
    // The failure-recording guard and the parse guard answer two different
    // questions and both stay: at a structured position a failure is loud, at a
    // declared scalar the position is never reached, and with no declaration the
    // parse happens and its failure is still silent. Collapsing any two of
    // those is the regression this row exists to catch.
    const scalar = applyRawJson(['L1', '{name: "probe"}'], {
      schemaAt: (i) => schema('string'),
      pathAt: (i) => `args[${i}]`,
    });
    expect(scalar.structuredFailures).toEqual([]);
    expect(scalar.value).toEqual(['L1', '{name: "probe"}']);

    const structured = applyRawJson(['L1', '{name: "probe"}'], {
      schemaAt: (i) => schema('object'),
      pathAt: (i) => `args[${i}]`,
    });
    expect(structured.structuredFailures).toEqual([{ path: 'args[1]', raw: '{name: "probe"}' }]);
    expect(structured.value).toEqual(['L1', '{name: "probe"}']);
  });
});

describe('REQ-1280 — applyRawJson over the ARRAY form (compact mode\'s positional args)', () => {
  const noSchema = { schemaAt: () => undefined, pathAt: (i: number) => `args[${i}]` };

  it('parses every stringified element and leaves the rest alone', () => {
    const { value, structuredFailures } = applyRawJson(['page', '{"name":"probe"}', 7, ['already'], null], noSchema);
    expect(value).toEqual(['page', { name: 'probe' }, 7, ['already'], null]);
    expect(structuredFailures).toEqual([]);
  });

  it('returns the SAME array identity when nothing parsed — the common case allocates nothing', () => {
    const args = ['page', { name: 'probe' }, 100];
    const applied = applyRawJson(args, noSchema);
    expect(applied.value).toBe(args);
  });

  it('reports the FIRST offender, and only where the schema expects a structured value', () => {
    const schemas = [schema('string'), schema('object'), schema('array')];
    const applied = applyRawJson(['L1', '{bad json}', '[1,2,x]'], {
      schemaAt: (i) => schemas[i],
      pathAt: (i) => `args[${i}]`,
    });
    expect(applied.structuredFailures).toHaveLength(2);
    // first-offender ordering is what the handler's single-message return needs
    expect(applied.structuredFailures[0]).toEqual({ path: 'args[1]', raw: '{bad json}' });
    expect(applied.structuredFailures[1]).toEqual({ path: 'args[2]', raw: '[1,2,x]' });
  });

  it('leaves the value UNTOUCHED at a non-structured position — no partial repair', () => {
    const applied = applyRawJson(['L1', '[Hero]'], {
      schemaAt: (i) => schema('string'),
      pathAt: (i) => `args[${i}]`,
    });
    expect(applied.structuredFailures).toEqual([]);
    expect(applied.value).toEqual(['L1', '[Hero]']);
  });

  it('records NOTHING when no schema is available at all (no manifest yet)', () => {
    const applied = applyRawJson(['L1', '{bad json}'], noSchema);
    expect(applied.structuredFailures).toEqual([]);
    expect(applied.value).toEqual(['L1', '{bad json}']);
  });

  it('is ELEMENT-WISE, never recursive: a stringified value nested inside a parsed object stays a string', () => {
    // Documented, deliberate: the card's rule is element-wise, and a deep walk
    // would repair payloads no AC asked for.
    const applied = applyRawJson(['rect', '{"transform":"[1,0,0,1,0,0]"}'], noSchema);
    const props = applied.value[1] as unknown as Record<string, unknown>;
    expect(props.transform).toBe('[1,0,0,1,0,0]');
  });

  it('does not re-parse a value it already parsed (the compact verdict re-run is a no-op)', () => {
    const once = applyRawJson(['rect', '{"a":1}'], noSchema).value;
    const twice = applyRawJson(once, noSchema);
    expect(twice.value).toBe(once);
    expect(twice.structuredFailures).toEqual([]);
  });

  it('an empty args array is fine, and so is a zero-schema-method call', () => {
    const applied = applyRawJson([], noSchema);
    expect(applied.value).toEqual([]);
    expect(applied.structuredFailures).toEqual([]);
  });
});

describe('REQ-1280 — applyRawJson over the RECORD form (full mode\'s named params)', () => {
  it('maps by DECLARED key order, not the object\'s own key order', () => {
    // This is what makes `schemaAt(i)`/`pathAt(i)` mean the same thing on both
    // paths: position i is `keys[i]`, whatever order the client sent.
    const args = { name: '[Hero]', props: '{"a":1}' } as Record<string, unknown>;
    const applied = applyRawJson(args, {
      keys: ['props', 'name'],
      schemaAt: (i) => (i === 0 ? schema('object') : schema('string')),
      pathAt: (i) => (i === 0 ? 'props' : 'name'),
    });
    expect(applied.value.props).toEqual({ a: 1 });
    expect(applied.value.name).toBe('[Hero]');
  });

  it('visits ONLY the declared keys, so a reserved key is never parsed', () => {
    const applied = applyRawJson({ props: '{"a":1}', _rawJson: true, returnAs: '{"a":1}' } as Record<string, unknown>, {
      keys: ['props'],
      schemaAt: () => schema('object'),
      pathAt: () => 'props',
    });
    expect(applied.value._rawJson).toBe(true);
    expect(applied.value.returnAs).toBe('{"a":1}');
  });

  it('defaults to the object\'s own key order when no keys are given', () => {
    const applied = applyRawJson({ props: '{"a":1}' } as Record<string, unknown>, {
      schemaAt: () => schema('object'),
      pathAt: (i) => `k${i}`,
    });
    expect(applied.value.props).toEqual({ a: 1 });
  });

  it('returns the SAME record identity when nothing parsed', () => {
    const args = { id: 'L1', name: 'Hero' };
    const applied = applyRawJson(args, { schemaAt: () => schema('string'), pathAt: () => 'name' });
    expect(applied.value).toBe(args);
  });
});

describe('REQ-1280 — rawJsonFailureMessage: one message, two paths', () => {
  it('names the flag, the position, and what to send instead', () => {
    const message = rawJsonFailureMessage('layer_setTransform', 'matrix', '[5,0,zz,0,0,0]');
    expect(message).toContain('_rawJson');
    expect(message).toContain('matrix');
    expect(message).toContain('could not be parsed as JSON');
    expect(message).toContain('[5,0,zz,0,0,0]');
    expect(message).toContain('Send a real object/array');
  });

  it('differs between paths ONLY in the position — the guidance tail is byte-equal (AC-7)', () => {
    const full = rawJsonFailureMessage('layer_setTransform', 'matrix', '[5,0,zz,0,0,0]');
    const compact = rawJsonFailureMessage('layer_setTransform', 'args[1] (matrix)', '[5,0,zz,0,0,0]');
    const tail = (m: string) => m.slice(m.indexOf('could not be parsed as JSON'));
    expect(tail(compact)).toBe(tail(full));
  });
});

describe('REQ-1280 — AC-7 structural guarantee', () => {
  it('the shared module owns the flag\'s only parse, and the handler has no inline one', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    // The product sources only — a test may of course parse JSON itself.
    const files = readdirSync(join(__dirname))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => [f, readFileSync(join(__dirname, f), 'utf8')] as const);
    const count = (text: string, needle: string) => (text.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;

    // The flag's parse lives here, once.
    const rawJsonSrc = files.find(([f]) => f === 'rawJson.ts')![1];
    expect(count(rawJsonSrc, 'JSON.parse(')).toBe(1);

    const server = files.find(([f]) => f === 'mcpServer.ts')![1];
    // The handler READS the flag through the shared module…
    expect(count(server, 'isRawJsonFlag(')).toBeGreaterThanOrEqual(1);
    // …and owns NO parse of its own, on either branch. REQ-1280 pinned this at
    // exactly 1 and named the survivor: full mode's pre-existing FLAG-LESS
    // auto-parse heuristic, an inline loop the card then put out of scope.
    // REQ-1318 de-duplicated that loop into the same shared module, so the
    // count goes 1 → 0. STRICTLY STRONGER, not relaxed: after this the server
    // owns no `JSON.parse` at all, on either lane, for either spelling of the
    // flag. (Other modules parse their own protocol payloads — bridge frames,
    // the fetched contract — which is unrelated; what must not be forked is a
    // parse of a CALL's argument, and there is now none here.)
    const flagAt = server.indexOf('if (rawJsonFlag)');
    const elseAt = server.indexOf('} else {', flagAt);
    expect(flagAt).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(flagAt);
    expect(count(server.slice(flagAt, elseAt), 'JSON.parse(')).toBe(0);
    expect(count(server, 'JSON.parse(')).toBe(0);
  });

  it('BOTH relay paths call that one implementation — the loop is not forked', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const server = readFileSync(join(__dirname, 'mcpServer.ts'), 'utf8');
    const count = (needle: string) => (server.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    // THREE `applyRawJson` call sites, and all three are the shared loop:
    // full mode's contract handler (once), and compact mode's `figpea_call`
    // TWICE — step 1 parses before the file-path translation, step 2 renders
    // the verdict after `contractToolFor`. (REQ-1338: both compact steps now
    // pass the SAME declared schema, so they make identical parse decisions at
    // every position and step 2 remains a cheap no-op on values that are
    // already parsed. Before this, step 1 was schema-blind and the two could
    // disagree — which is why the schema the flag used to be blind to is now
    // reachable above it, where REQ-1318's hoist already put the lookup.) This
    // is the assertion that fails if either path ever grows its own inline
    // parse — the drift AC-7 exists to prevent.
    expect(count('applyRawJson(')).toBe(3);
    // REQ-1318: the same anti-drift pin for the FLAG-LESS parse, at exactly TWO
    // call sites — one per lane. Before this, full mode carried an inline
    // re-implementation of the rule and compact mode carried none, which is
    // precisely the drift. Two sites means both lanes adopted the shared
    // function; three would mean one lane grew its own copy, and one would
    // mean a lane silently stopped using it.
    expect(count('applyStructuredStringJson(')).toBe(2);
    // …and one per lane, provably: the compact one is inside `figpea_call`'s
    // handler (beside the hoisted `contractToolFor`), the full-mode one in the
    // `else` sibling of `if (rawJsonFlag)`.
    const fullModeFlagBranch = server.indexOf('if (rawJsonFlag)');
    const fullModeFlagless = server.indexOf('} else {', fullModeFlagBranch);
    expect(fullModeFlagBranch).toBeGreaterThan(-1);
    expect(fullModeFlagless).toBeGreaterThan(fullModeFlagBranch);
    // Inside the flag branch: no, that is `applyRawJson`'s job.
    expect(server.slice(fullModeFlagBranch, fullModeFlagless).includes('applyStructuredStringJson(')).toBe(false);
    // In its `else` sibling: yes — the de-duplicated call.
    expect(server.slice(fullModeFlagless, fullModeFlagless + 2000).includes('applyStructuredStringJson(')).toBe(true);
    // And the compact lane adopted it beside the flag branch, before the
    // file-path translation — the only place a parsed-then-translated payload
    // is still correct. The ORDERING is the property worth pinning, not a
    // character window: `session_openFile`/`layer_setImageFill`/`layer_create`
    // read `args[0]`/`args[1]` as `{filePath}`, so a parse placed after them
    // would leave a stringified `{"filePath":…}` untranslated.
    const compactFlagless = server.indexOf('} else if (contractTool) {');
    expect(compactFlagless).toBeGreaterThan(-1);
    const compactCall = server.indexOf('applyStructuredStringJson(args, {');
    expect(compactCall).toBeGreaterThan(compactFlagless);
    const filePathTranslation = server.indexOf("toolName === 'session_openFile'");
    expect(filePathTranslation).toBeGreaterThan(-1);
    expect(compactCall, 'the compact flag-less parse runs BEFORE the file-path translation').toBeLessThan(filePathTranslation);
    // The flag test and the message builder are one per PATH, never per call.
    expect(count('isRawJsonFlag(')).toBe(2);
    expect(count('rawJsonFailureMessage(')).toBe(2);
  });
});
