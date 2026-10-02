import { describe, it, expect } from 'vitest';
import { buildToolsFromManifest } from './tools';
import type { ManifestLike, ParamSchemaLike } from './tools';

/**
 * REQ-1444 T2 — the three pure predicates that carry the diagnostics, pinned in
 * isolation, with no bridge and no server.
 *
 * `argShape.ts` exists to be testable exactly this way: pure, schema-driven, no
 * bridge, no I/O — which is also why the missing-file verdict for AC-2 lives at
 * the REPORTING SITE rather than here (an `fs.stat` in this module would break
 * the property that makes it worth existing). So what this file pins is each
 * rule's CONTRACT — when it fires, when it declines, and what it reports — and
 * `req1444EnvelopeDiagnostics.test.ts` pins what the composed server does.
 *
 * The three:
 *  - `findFilePathEnvelopeMismatch` — a single-argument declared-wrapper
 *    envelope carrying a non-empty string `filePath` at a slot this transport
 *    reads POSITIONALLY. It reports the INNER path, so the site can answer
 *    `open_failed` when the file is not there (AC-2) and `invalid_params` when
 *    it is (AC-1).
 *  - `createCommonPropNames` — the `create()` common props, DERIVED from a
 *    manifest's `props.shape` and memoized on the schema object, never from a
 *    literal (AC-4).
 *  - `findNestedStructuredStringMismatch` — a JSON-looking string at a param
 *    declared `object`/array INSIDE a whole-`args` wrapper: the blind spot of
 *    the JSON-string route (AC-5).
 *
 * Every decline guard is a separate assertion rather than a comment, because
 * ⛔ DECLINE RATHER THAN GUESS is the module's rule and a false rejection of a
 * call the editor accepts is the expensive direction — AC-7 turns that into a
 * promise this file has to keep honest.
 *
 * The modules under construction are imported DYNAMICALLY so this file LOADS on
 * the unfixed tree and every row is observably red for its own reason, rather
 * than the whole file dying on a missing export at link time (the technique
 * `req1295WireEncoding.test.ts` established).
 */

async function argShapeModule(): Promise<any> {
  return import('./argShape');
}

/* ──────────────────────────────────────────────────────────────────────────
 * Fixture schemas — the REAL declarations, transcribed (never imported: this is
 * a standalone package with no sibling `v3/`), via `buildToolsFromManifest`, so
 * what these rules read is exactly what the server reads.
 * ────────────────────────────────────────────────────────────────────────── */

const MANIFEST = {
  session: {
    openFile: {
      doc: 'Opens a design file into the active session.',
      params: {
        input: {
          type: 'object',
          required: true,
          shape: {
            url: { type: 'string', required: false },
            bytes: { type: 'array', required: false, of: { type: 'number', required: true } },
            filePath: { type: 'string', required: false },
            fileName: { type: 'string', required: false },
            name: { type: 'string', required: false },
          },
        },
      },
      result: 'void',
    },
  },
  layer: {
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'text', 'image'] },
        props: {
          type: 'object',
          required: false,
          shape: {
            parentId: { type: 'string', required: false },
            index: { type: 'number', required: false },
            name: { type: 'string', required: false },
            transform: { type: 'matrix', required: false },
            style: { type: 'object', required: false, shape: { fontSize: { type: 'number', required: false } } },
          },
          byKind: {
            rect: { rwidth: { type: 'number', required: false } },
            image: { url: { type: 'string', required: false }, filePath: { type: 'string', required: false } },
          },
        },
      },
      result: { id: 'string' },
    },
    stylePatch: {
      doc: "Patches a layer's style.",
      params: {
        id: { type: 'string', required: true },
        patch: { type: 'object', required: true, shape: { fill: { type: 'string', required: false }, fontSize: { type: 'number', required: false } } },
      },
      result: 'void',
    },
    setPageFill: {
      doc: "Sets a page's background fill.",
      params: {
        pageId: { type: 'string', required: true },
        patch: { type: 'object', required: true, shape: { fill: { type: 'string', required: false }, fillType: { type: 'string', required: false } } },
      },
      result: 'void',
    },
  },
} as unknown as ManifestLike;

/** A pre-REQ-093 manifest: `params` values are free-text hint strings, so
 *  `buildParamSchemas` carries nothing structured through. This is the state a
 *  rule must decline in — with no declaration there is nothing to derive a
 *  wrapper signature or a prop set from. */
const LEGACY_MANIFEST = {
  layer: { stylePatch: { doc: "Patches a layer's style.", params: { id: 'a layer id', patch: 'an object of style keys' }, result: 'void' } },
} as unknown as ManifestLike;

function schemasFor(group: string, method: string): Record<string, ParamSchemaLike> {
  const tool = buildToolsFromManifest(MANIFEST).find((t) => t.name === `${group}_${method}`);
  expect(tool, `the fixture publishes ${group}.${method}`).toBeDefined();
  return tool!.paramSchemas as Record<string, ParamSchemaLike>;
}

const OPENFILE = schemasFor('session', 'openFile');
const OPENFILE_KEYS = Object.keys(OPENFILE);
const STYLE_PATCH = schemasFor('layer', 'stylePatch');
const STYLE_PATCH_KEYS = Object.keys(STYLE_PATCH);
const SET_PAGE_FILL = schemasFor('layer', 'setPageFill');
const SET_PAGE_FILL_KEYS = Object.keys(SET_PAGE_FILL);
const CREATE = schemasFor('layer', 'create');
const CREATE_KEYS = Object.keys(CREATE);

/** The manifest's own `create()` common props — the expectation is built from
 *  the FIXTURE, so a rule that hard-coded the key list fails here. */
const CREATE_COMMON_KEYS = Object.keys(
  (MANIFEST.layer.create.params as Record<string, any>).props.shape as Record<string, unknown>,
);
/** …and the per-kind union it must NOT be: `rwidth` is a `rect` prop, not a
 *  common one, so a rule that returned the union would pass the rows above and
 *  explain a genuine style-key error. */
const CREATE_BYKIND_KEYS = ['rwidth', 'url', 'filePath'];

const pathFor = (keys: readonly string[]) => (name: string) => `args[${keys.indexOf(name)}]`;

/* ────────────────────────────────────────────────────────────────── AC-1/AC-2 ── */

describe('REQ-1444 — the file-path envelope rule', () => {
  it('fires on openFile\'s exact payload and reports the INNER path so the site can pick the code', async () => {
    const { findFilePathEnvelopeMismatch } = await argShapeModule();
    const found = findFilePathEnvelopeMismatch(
      OPENFILE,
      [{ input: { filePath: '/abs/path/design.fp' } }],
      pathFor(OPENFILE_KEYS),
      1,
    );
    expect(found, 'the envelope is the defect').toBeDefined();
    // `args[0]` is where `filePath` belongs — the whole point of the message.
    expect(found.path).toBe('args[0]');
    expect(found.expected).toMatch(/filePath/);
    expect(found.got).toMatch(/input/);
    // The inner path, so the reporting site can answer `open_failed` for a file
    // that is not there instead of inventing a shape verdict about it (AC-2).
    expect(found.offendingValue).toBe('/abs/path/design.fp');
    // The hint must never quote a fetch failure: none happened.
    expect(found.hint).not.toContain('404');
    expect(found.hint).toMatch(/retrying this shape fails identically/i);
  });

  it('declines every wrapper that does not defeat a positional filePath read', async () => {
    const { findFilePathEnvelopeMismatch } = await argShapeModule();
    const declines: Array<[string, unknown]> = [
      // The legal whole-`args` wrapper carrying a url — SUCCEEDS today and must
      // keep succeeding. This is the row that makes AC-7 real.
      ['a url', [{ input: { url: 'https://example.com/design.fp' } }]],
      ['bytes', [{ input: { bytes: [1, 2, 3] } }]],
      ['a filename alias alone', [{ input: { fileName: 'kept.fp' } }]],
      ['a name alias alone', [{ input: { name: 'aliased' } }]],
      ['an object with no keys', [{}]],
      ['a non-object argument', ['/abs/path/design.fp']],
      ['an array argument', [[{ input: { filePath: '/abs/path/design.fp' } }]]],
      ['an empty filePath', [{ input: { filePath: '' } }]],
      ['a blank filePath', [{ input: { filePath: '   ' } }]],
      ['a non-string filePath', [{ input: { filePath: 42 } }]],
      ['a null filePath', [{ input: { filePath: null } }]],
      // The FLAT form: `filePath` is a key of args[0] itself, so nothing is
      // wrapped and the translation reads it. Declining this is the difference
      // between a rule and "wrapper ⇒ refuse".
      ['the correct flat spelling', [{ filePath: '/abs/path/design.fp' }]],
    ];
    for (const [label, args] of declines) {
      expect(
        findFilePathEnvelopeMismatch(OPENFILE, args as unknown[], pathFor(OPENFILE_KEYS), (args as unknown[]).length),
        `must decline ${label}`,
      ).toBeUndefined();
    }
  });

  it('declines at arity ≥ 2, where the wrapper is not the whole of args', async () => {
    const { findFilePathEnvelopeMismatch } = await argShapeModule();
    // A positional argument goes in front ⇒ nothing expands it ⇒ the wrapper
    // arrives as the object itself and there is no single-argument envelope.
    expect(
      findFilePathEnvelopeMismatch(OPENFILE, [{ input: { filePath: '/abs/x.fp' } }, 'surplus'], pathFor(OPENFILE_KEYS), 2),
    ).toBeUndefined();
  });

  it('declines when the wrapper\'s keys are not all declared parameter names', async () => {
    const { findFilePathEnvelopeMismatch } = await argShapeModule();
    // `filePath` is NOT a parameter of `session.openFile` — `input` is — so
    // this object is CONTENTS, not the declaration. Flagging it would refuse
    // the single most common correct call in the whole transport.
    expect(
      findFilePathEnvelopeMismatch(OPENFILE, [{ nope: { filePath: '/abs/x.fp' } }], pathFor(OPENFILE_KEYS), 1),
    ).toBeUndefined();
    // A partially-declared wrapper is no more a declaration than an undeclared one.
    expect(
      findFilePathEnvelopeMismatch(OPENFILE, [{ input: { filePath: '/abs/x.fp' }, stray: 1 }], pathFor(OPENFILE_KEYS), 1),
    ).toBeUndefined();
  });

  it('declines with no schemas — including the legacy free-text manifest', async () => {
    const { findFilePathEnvelopeMismatch } = await argShapeModule();
    expect(findFilePathEnvelopeMismatch(undefined, [{ input: { filePath: '/abs/x.fp' } }], pathFor(OPENFILE_KEYS), 1)).toBeUndefined();
    // The REQ-1280 row: a legacy manifest carries nothing structured, so this is
    // the same no-opinion state reached by a different route.
    const legacyTool = buildToolsFromManifest(LEGACY_MANIFEST)[0]!;
    expect(legacyTool.paramSchemas, 'the legacy manifest really does carry no schemas').toBeUndefined();
    expect(findFilePathEnvelopeMismatch(legacyTool.paramSchemas, [{ input: { filePath: '/abs/x.fp' } }], pathFor(['input']), 1)).toBeUndefined();
  });

  it('declines on an exhausted budget — the cap is shared, so it holds per CALL not per rule', async () => {
    const { findFilePathEnvelopeMismatch, MAX_NODES } = await argShapeModule();
    const exhausted = { nodes: MAX_NODES + 1 };
    expect(
      findFilePathEnvelopeMismatch(OPENFILE, [{ input: { filePath: '/abs/x.fp' } }], pathFor(OPENFILE_KEYS), 1, exhausted),
    ).toBeUndefined();
    // …and the SAME budget object, when it still has room, fires — proving the
    // allowance is spent, not a per-rule constant.
    const shared = { nodes: 0 };
    expect(findFilePathEnvelopeMismatch(OPENFILE, [{ input: { filePath: '/abs/x.fp' } }], pathFor(OPENFILE_KEYS), 1, shared)).toBeDefined();
    expect(shared.nodes, 'the rule spends the shared allowance it was handed').toBeGreaterThan(0);
  });

  it('is DERIVED, never enumerated: the same rule reads the other two create-shaped methods\' declarations', async () => {
    const { findFilePathEnvelopeMismatch } = await argShapeModule();
    // `layer.setImageFill`'s whole-args wrapper defeats its positional read
    // identically, and nothing here names either method.
    const setImageFill = {
      id: { type: 'string', required: true },
      source: { type: 'object', required: true, shape: { url: { type: 'string', required: false }, filePath: { type: 'string', required: false } } },
    };
    expect(findFilePathEnvelopeMismatch(setImageFill, [{ id: 'L1', source: { filePath: '/abs/a.png' } }], pathFor(['id', 'source']), 1)).toBeDefined();
    expect(findFilePathEnvelopeMismatch(setImageFill, [{ id: 'L1', source: { url: 'https://x/a.png' } }], pathFor(['id', 'source']), 1)).toBeUndefined();
    // `layer.create`'s own create-shaped wrapper, where the props slot is the
    // one carrying the path — and it is `args[1]`, not `args[0]`, because the
    // position comes from the manifest rather than from a literal.
    const found = findFilePathEnvelopeMismatch(CREATE, [{ kind: 'image', props: { filePath: '/abs/a.png' } }], pathFor(CREATE_KEYS), 1);
    expect(found).toBeDefined();
    expect(found.path).toBe('args[1]');
    expect(found.offendingValue).toBe('/abs/a.png');
    expect(findFilePathEnvelopeMismatch(CREATE, [{ kind: 'rect', props: { rwidth: 10 } }], pathFor(CREATE_KEYS), 1)).toBeUndefined();
  });
});

/* ───────────────────────────────────────────────────────────────────── AC-4 ── */

describe('REQ-1444 — the create() common-prop derivation', () => {
  it('derives the key set from the manifest\'s own props.shape, not from a literal', async () => {
    const { createCommonPropNames } = await argShapeModule();
    const names = createCommonPropNames(CREATE.props);
    expect(names, 'the create-shaped props declaration is found structurally').toBeDefined();
    expect(Array.from(names!)).toEqual(CREATE_COMMON_KEYS);
    expect(names!.has('style'), '"style" is a common prop — this is the key AC-4 is about').toBe(true);
    // The union would answer a question nobody asked.
    for (const perKind of CREATE_BYKIND_KEYS) {
      expect(names!.has(perKind), `${perKind} is a per-kind prop, not a common one`).toBe(false);
    }
  });

  it('memoizes on the schema object and returns the IDENTICAL frozen Set thereafter', async () => {
    const { createCommonPropNames } = await argShapeModule();
    // A check that runs on every relayed failure must be one `WeakMap.get`
    // thereafter, and two callers must not be able to observe two sets.
    const first = createCommonPropNames(CREATE.props);
    const second = createCommonPropNames(CREATE.props);
    expect(second, 'the identical instance, not an equal copy').toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('declines when there is no create-shaped declaration, or no shape to derive from', async () => {
    const { createCommonPropNames } = await argShapeModule();
    expect(createCommonPropNames(undefined), 'no manifest, no opinion').toBeUndefined();
    // `session.openFile`'s single `input` param carries no `byKind` entry, so
    // this rule has nothing to say about it.
    expect(createCommonPropNames(OPENFILE.input), 'a params object with no per-kind entries is not a create shape').toBeUndefined();
    // …and a create-shaped object that declares no common `shape` is declined
    // rather than answered with an empty set, which would read as "none".
    const shapeless = { type: 'object' as const, required: false, byKind: { rect: { rwidth: { type: 'number' as const, required: false } } } };
    expect(createCommonPropNames(shapeless)).toBeUndefined();
  });

  it('names the flat form only when the offending key is a common prop AND an object was sent under it', async () => {
    const { createPropStyleHint } = await argShapeModule();
    const sent = { style: { fontSize: 26, fontFamily: 'Inter' } };
    const values = { id: 'L_kicker', patch: sent };
    const call = (propName: string, vals: Record<string, unknown> = values) =>
      createPropStyleHint('layer', 'stylePatch', [CREATE.props], STYLE_PATCH, vals, propName, vals.id);

    const hint = call('style');
    expect(hint, 'the lesson fires for a create() prop sent where style keys go').toBeDefined();
    // Rendered from the caller's OWN keys, and carrying the authority.
    expect(hint).toMatch(/stylePatch\(L_kicker, \{fontSize: 26, fontFamily: "Inter"\}\)/);
    expect(hint).toMatch(/create\(\) top-level prop/i);
    expect(hint).toMatch(/figpea_describe\(\{group:"layer", method:"stylePatch"\}\)/);

    // Declines, each for its own reason.
    expect(call('bogus'), 'a genuine unknown style key is not this lesson').toBeUndefined();
    expect(call('style', { id: 'L_kicker', patch: { style: 'flat' } }), 'a non-object under the key says nothing about nesting').toBeUndefined();
    expect(call('style', { id: 'L_kicker', patch: {} }), 'a key sent with no value is not a rejection either').toBeUndefined();
    expect(call('style', { id: 'L_kicker' }), 'the key is nowhere in what was sent').toBeUndefined();
    // No create-shaped declaration anywhere in the manifest ⇒ no opinion.
    expect(
      createPropStyleHint('layer', 'stylePatch', [], STYLE_PATCH, values, 'style', 'L_kicker'),
      'a manifest with no create-shaped params carries no common-prop set',
    ).toBeUndefined();
  });
});

/* ───────────────────────────────────────────────────────────────────── AC-5 ── */

describe('REQ-1444 — the nested structured-string rule', () => {
  it('fires on a JSON-looking string at a param declared object inside a whole-args wrapper', async () => {
    const { findNestedStructuredStringMismatch } = await argShapeModule();
    const raw = '{"fill":"#EFEBE3","fillType":"solid"}';
    const found = findNestedStructuredStringMismatch(SET_PAGE_FILL, [{ pageId: 'P_1', patch: raw }], pathFor(SET_PAGE_FILL_KEYS));
    expect(found).toBeDefined();
    // The slot the editor will read AFTER it expands the wrapper — which is the
    // form the hint tells the caller to send, so the two agree by construction.
    expect(found.path).toBe('args[1]');
    expect(found.expected).toBe('an object');
    expect(found.offendingValue).toBe(raw);
  });

  it('names both ways out, rendered from the manifest\'s own parameter names and order', async () => {
    const { nestedStringHint } = await argShapeModule();
    const hint = nestedStringHint('layer', 'setPageFill', SET_PAGE_FILL_KEYS, SET_PAGE_FILL, 'patch');
    expect(hint).toMatch(/setPageFill\(pageId, \{…\}\)/);
    // The reason, stated rather than asserted: the JSON-string route visits
    // WHOLE positional slots and never descends into an object.
    expect(hint).toMatch(/never descends into an object/i);
    expect(hint).toMatch(/figpea_describe\(\{group:"layer", method:"setPageFill"\}\)/);
  });

  it('declines a real object in that slot, a string at a param declared string, and every no-opinion state', async () => {
    const { findNestedStructuredStringMismatch, MAX_NODES } = await argShapeModule();
    const declines: Array<[string, unknown[], Record<string, ParamSchemaLike> | undefined, number]> = [
      ['a real object in the patch slot', [{ pageId: 'P_1', patch: { fill: '#EFEBE3' } }], SET_PAGE_FILL, 1],
      // `pageId` is declared a string, so a JSON-looking string there is a NAME
      // and `applyStructuredStringJson`'s gate never parses it — REQ-1338's rule.
      ['a JSON-looking string at a string param', [{ pageId: '{"not":"an id"}', patch: { fill: '#1' } }], SET_PAGE_FILL, 1],
      ['an arity-2 call, where nothing expands the wrapper', ['P_1', '{"fill":"#1"}'], SET_PAGE_FILL, 2],
      ['an empty object', [{}], SET_PAGE_FILL, 1],
      ['an object whose keys are not parameter names', [{ nope: '{"fill":"#1"}' }], SET_PAGE_FILL, 1],
      ['no manifest at all', [{ pageId: 'P_1', patch: '{"fill":"#1"}' }], undefined, 1],
      ['a legacy free-text manifest', [{ id: 'L1', patch: '{"fill":"#1"}' }], undefined, 1],
      // A string that is not JSON-looking is somebody else's rule — the editor
      // names it, and this one must not invent a verdict about it.
      ['a non-JSON string', [{ pageId: 'P_1', patch: 'solid' }], SET_PAGE_FILL, 1],
    ];
    for (const [label, args, schemas, arity] of declines) {
      expect(
        findNestedStructuredStringMismatch(schemas, args as unknown[], pathFor(SET_PAGE_FILL_KEYS), undefined, arity),
        `must decline ${label}`,
      ).toBeUndefined();
    }
    // …and an exhausted budget, for the same shared-cap reason as above.
    expect(
      findNestedStructuredStringMismatch(SET_PAGE_FILL, [{ pageId: 'P_1', patch: '{"fill":"#1"}' }], pathFor(SET_PAGE_FILL_KEYS), { nodes: MAX_NODES + 1 }),
    ).toBeUndefined();
  });

  it('reuses the SAME "looks like JSON" predicate the parse itself uses, so the two cannot disagree', async () => {
    const { findNestedStructuredStringMismatch } = await argShapeModule();
    // `looksLikeJsonLiteral` is module-private by design; this pins its BOUNDARY
    // from outside, which is the property that matters: an array literal is as
    // much a candidate as an object literal, and anything else is not.
    for (const raw of ['{"a":1}', '[{"a":1}]', '  {"a":1}  ']) {
      expect(findNestedStructuredStringMismatch(SET_PAGE_FILL, [{ pageId: 'P_1', patch: raw }], pathFor(SET_PAGE_FILL_KEYS)), raw).toBeDefined();
    }
    for (const raw of ['{"a":1', 'not json', '"a string"', '1']) {
      expect(findNestedStructuredStringMismatch(SET_PAGE_FILL, [{ pageId: 'P_1', patch: raw }], pathFor(SET_PAGE_FILL_KEYS)), raw).toBeUndefined();
    }
  });
});