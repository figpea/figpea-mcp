import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { startBridgeServer } from './bridgeServer';
import { buildToolsFromManifest, type GeneratedTool } from './tools';

/**
 * REQ-1309 T1/T2 — acceptance tests for the round trip a non-compliant
 * `create` call used to buy: a prop that does not apply to the requested kind
 * is only discovered by the editor, one tab round trip later.
 *
 * The spec here is the AC text, not this repo's implementation. What the
 * requirements state, stated independently of any code here:
 *   - AC-1: from a paired tab, `layer.create("text", {parentId, text, x, y})`
 *     is answered with `invalid_transform` naming `x, y` — and with **zero**
 *     `bridge.callTab` invocations. Counted, not timed.
 *   - AC-2: the message names the applicable set for THAT kind in the editor's
 *     own wording, `Applicable props for "text": index, name, parentId, style,
 *     text, transform`.
 *   - AC-3: that set is DERIVED from the manifest (`params.props.shape` ∪
 *     `params.props.byKind[kind]`), never a hard-coded kind list.
 *   - AC-4: no valid call changes — one bridge call, the tab's result untouched.
 *   - AC-5: standalone-degrade. Nothing to derive from ⇒ no opinion ⇒ FORWARD.
 *   - AC-6: the check stays far cheaper than the round trip it may save.
 *
 * Harness: a real MCP SDK `Client` over `InMemoryTransport` around a real
 * `createMcpServer`, with `callTab` stubbed and counted. The tab is stubbed
 * because it is provably not the locus: the rule the editor applies is
 * derivable from a manifest this server already holds in memory. The stub is
 * seeded with the editor's REAL `invalid_transform` payload, so the only
 * difference a test can see between today and after is the round trip itself —
 * which is exactly what AC-1 asks to be measured.
 *
 * **Both lanes are asserted for every behaviour.** Compact `figpea_call` is the
 * default mode; the per-tool full mode is what real MCP clients use. A rule
 * wired into one lane alone satisfies the example in one calling convention
 * and keeps billing the round trip in the other.
 */

/* ------------------------------------------------------------------ *
 * The editor's rule, transcribed. Not imported: `figpea-mcp` is a
 * standalone package that must build with no sibling `v3/` checkout.
 * ------------------------------------------------------------------ */

/** `v3/src/agent/createSchema.ts` — CREATE_COMMON_FIELDS (:87-93). */
const CREATE_COMMON_FIELDS: Record<string, any> = {
  parentId: { type: 'string', required: false },
  index: { type: 'number', required: false },
  name: { type: 'string', required: false },
  transform: { type: 'matrix', required: false },
  // `style`'s own 44-key shape is irrelevant to the key-membership rule under
  // test and is deliberately not transcribed; a two-field stand-in keeps the
  // fixture honest about what this suite depends on.
  style: { type: 'object', required: false, shape: { fill: { type: 'string', required: false }, opacity: { type: 'number', required: false } } },
  // REQ-1029 — world-space `position` joined the editor's common fields
  // (`v3/src/agent/createSchema.ts` — CREATE_COMMON_FIELDS), so every kind
  // accepts it and the applicable-set derivation below must include it. The
  // value shape is transcribed faithfully (both axes required); only
  // key-membership is under test here.
  position: { type: 'object', required: false, shape: { x: { type: 'number', required: true }, y: { type: 'number', required: true } } },
};

/** `v3/src/agent/createSchema.ts` — CREATE_KIND_SCHEMA (:114-195). */
const CREATE_KIND_SCHEMA: Record<string, Record<string, any>> = {
  rect: {
    x: { type: 'number', required: false, default: 0 },
    y: { type: 'number', required: false, default: 0 },
    rwidth: { type: 'number', required: false, default: 100 },
    rheight: { type: 'number', required: false, default: 50 },
  },
  ellipse: {
    cx: { type: 'number', required: false, default: 0 },
    cy: { type: 'number', required: false, default: 0 },
    rx: { type: 'number', required: false, default: 50 },
    ry: { type: 'number', required: false, default: 50 },
  },
  line: { x2: { type: 'number', required: false, default: 100 }, y2: { type: 'number', required: false, default: 0 } },
  polygon: {
    points: { type: 'array', required: false, of: { type: 'object', required: true, shape: { x: { type: 'number', required: true }, y: { type: 'number', required: true } } } },
  },
  path: { path: { type: 'string', required: false, default: 'M0 0' } },
  text: { text: { type: 'string', required: false, default: '' } },
  folder: {},
  page: { pageWidth: { type: 'number', required: false, default: 300 }, pageHeight: { type: 'number', required: false, default: 150 } },
  image: {
    url: { type: 'string', required: false },
    bytes: { type: 'array', required: false, of: { type: 'number', required: true } },
    filePath: { type: 'string', required: false },
    mimeType: { type: 'string', required: false },
    x: { type: 'number', required: false, default: 0 },
    y: { type: 'number', required: false, default: 0 },
    rwidth: { type: 'number', required: false },
    rheight: { type: 'number', required: false },
    patternScaleType: { type: 'string', required: false, enum: ['fill', 'cover', 'free', 'fit'] },
    patternRepeat: { type: 'string', required: false, enum: ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'] },
    deferred: { type: 'boolean', required: false },
  },
  icon: { name: { type: 'string', required: false, default: 'heart', enum: ['heart', 'star', 'check'] }, size: { type: 'number', required: false, default: 24 } },
  arc: {
    r: { type: 'number', required: false, default: 50 },
    startAngle: { type: 'number', required: false, default: 0 },
    endAngle: { type: 'number', required: false, default: 270 },
    thickness: { type: 'number', required: false, default: 12 },
    rx: { type: 'number', required: false, default: 90 },
    ry: { type: 'number', required: false, default: 90 },
    sweep: { type: 'number', required: false },
  },
};

const CREATE_LAYER_KINDS = Object.keys(CREATE_KIND_SCHEMA);

/**
 * The editor's own `validateCreateProps` message, reconstructed from the
 * transcription by the editor's OWN algorithm — so this is an independent
 * statement of the rule, not a mirror of whatever this package happens to
 * print. `createSchema.ts:261-274`.
 */
function editorPropsMessage(kind: string, props: Record<string, unknown>): string {
  const allowed = new Set<string>([...Object.keys(CREATE_COMMON_FIELDS), ...Object.keys(CREATE_KIND_SCHEMA[kind] ?? {})]);
  const offenders = Object.keys(props).filter((k) => props[k] !== undefined && !allowed.has(k));
  return `these props do not apply to kind "${kind}": ${offenders.sort().join(', ')}.\nApplicable props for "${kind}": ${Array.from(allowed).sort().join(', ')}`;
}

/** The AC-2 line, quoted from the requirement, pinned against the fixture so a
 *  wrong transcription fails here rather than being absorbed by the derivation
 *  it is supposed to be checking. */
const AC2_TEXT_APPLICABLE = 'Applicable props for "text": index, name, parentId, position, style, text, transform';
const AC2_ARC_APPLICABLE =
  'Applicable props for "arc": endAngle, index, name, parentId, position, r, rx, ry, startAngle, style, sweep, thickness, transform';

/* ------------------------------------------------------------------ *
 * Fixture manifests
 * ------------------------------------------------------------------ */

function manifestWithCreateParams(params: unknown, kindEnum: string[] = CREATE_LAYER_KINDS): any {
  return {
    layer: {
      create: { doc: 'Creates a new layer of the given kind.', params, result: { id: 'string' } },
    },
  };
}

/** The faithful shape: a kind SELECTOR sibling (string + enum) next to a
 *  props param carrying `shape` (common fields) ∪ `byKind` (per-kind). */
const REAL_MANIFEST: any = manifestWithCreateParams({
  kind: { type: 'string', required: true, enum: CREATE_LAYER_KINDS },
  props: { type: 'object', required: false, shape: CREATE_COMMON_FIELDS, byKind: CREATE_KIND_SCHEMA },
});

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

interface Call { group: string; method: string; args: unknown[] }

let cleanup: Array<() => Promise<void>> = [];
let tmpDirs: string[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function tmpFile(ext: string, content = 'x'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1309-'));
  tmpDirs.push(dir);
  const fp = path.join(dir, `f${ext}`);
  fs.writeFileSync(fp, content);
  return fp;
}

/** The tab's own rejection, verbatim in the shape `validateCreateProps`
 *  produces. Seeded into the stub so a forwarded call is visibly a round trip
 *  that bought exactly one sentence. */
function editorRejection(kind: string, props: Record<string, unknown>): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: 'invalid_transform',
    message: `create("${kind}"): ${editorPropsMessage(kind, props)}\n(describe("layer.create").params.props — shape merged with byKind.${kind}). Nothing was created.`,
  };
}

async function createHarnessedClient(opts: {
  mode: 'full' | 'compact';
  manifest?: any;
  /** `false` = the tab never describes itself and no manifest was prefetched
   *  (the published-npm standalone case). */
  haveManifest?: boolean;
  reply?: (group: string, method: string, args: unknown[]) => unknown;
}) {
  const { mode } = opts;
  const haveManifest = opts.haveManifest !== false;
  const realBridge: any = await startBridgeServer({ port: 0 });
  const calls: Call[] = [];
  const stub: any = {
    port: realBridge.port,
    token: realBridge.token,
    isTabConnected: () => true,
    onDescribe: haveManifest ? (h: any) => h(opts.manifest ?? REAL_MANIFEST) : () => undefined,
    callTab: async (group: string, method: string, args: unknown[]) => {
      calls.push({ group, method, args });
      if (opts.reply) return opts.reply(group, method, args);
      // Default: a well-formed success, so an un-rejected call is visibly a
      // pass-through and not an accident of a shared error stub.
      return { ok: true, value: { id: 'layer-1', kind: args[0] } };
    },
    close: () => realBridge.close(),
    getFileUrl: (fp: string) => realBridge.getFileUrl(fp),
    registerBlob: (fp: string) => realBridge.registerBlob(fp),
  };
  const server = createMcpServer(stub as any, { toolMode: mode });
  const client = new Client({ name: 'req1309-kind-props', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => { await client.close(); await server.close(); await realBridge.close(); });
  return { client, calls, realBridge };
}

function textOf(res: any): string {
  const blocks = (res.content as any[]).filter((c: any) => c.type === 'text');
  expect(blocks, 'a text content block is present').toHaveLength(1);
  return blocks[0].text;
}
function payloadOf(res: any): any {
  return JSON.parse(textOf(res));
}

/** Compact-lane call. */
function callCompact(client: Client, args: unknown[]): Promise<any> {
  return client.callTool({ name: 'figpea_call', arguments: { group: 'layer', method: 'create', args } as any }) as Promise<any>;
}
/** Full-lane call. */
function callFull(client: Client, props: Record<string, unknown>, kind = 'text'): Promise<any> {
  return client.callTool({ name: 'layer_create', arguments: { kind, props } as any }) as Promise<any>;
}

/* ================================================================== *
 * AC-1 + AC-2 — the repro (T1)
 * ================================================================== */

/** The card's payload, verbatim: the strings are the point (an agent writes
 *  `"120"` where a number is wanted, and the pre-flight must read the object
 *  the TAB would have read — i.e. post-coercion). */
const OFFENDING_PROPS = { parentId: 'page-1', text: 'RASTER', x: '120', y: '250' };

describe('REQ-1309 AC-1: a prop that does not apply to the kind is refused WITHOUT a tab round trip', () => {
  it('compact lane — returns the editor\'s own code, names x and y, and spends ZERO bridge calls', async () => {
    const { client, calls } = await createHarnessedClient({
      mode: 'compact',
      reply: () => editorRejection('text', { parentId: 'page-1', text: 'RASTER', x: 120, y: 250 }),
    });
    const res = await callCompact(client, ['text', OFFENDING_PROPS]);
    const payload = payloadOf(res);
    expect(payload.ok, 'the call fails').toBe(false);
    expect(payload.code, "with the editor's OWN code, not this server's invention").toBe('invalid_transform');
    expect(payload.message, 'the offending props are named').toContain('x, y');
    expect(calls, 'AC-1: zero bridge.callTab invocations — the round trip is what this REQ removes').toHaveLength(0);
  });

  it('full lane — the identical refusal, because the lane most agents use must be protected too', async () => {
    const { client, calls } = await createHarnessedClient({
      mode: 'full',
      reply: () => editorRejection('text', { parentId: 'page-1', text: 'RASTER', x: 120, y: 250 }),
    });
    const res = await callFull(client, OFFENDING_PROPS);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('invalid_transform');
    expect(payload.message).toContain('x, y');
    expect(calls, 'AC-1: zero bridge.callTab invocations').toHaveLength(0);
  });

  it('names EVERY offending prop, not just the first', async () => {
    const { client, calls } = await createHarnessedClient({ mode: 'full' });
    const res = await callFull(client, { name: 'T', x: 1, y: 2, rwidth: 10, opacity: 0.5 });
    const payload = payloadOf(res);
    expect(payload.message, 'all four are named').toContain('opacity, rwidth, x, y');
    expect(calls).toHaveLength(0);
  });
});

describe('REQ-1309 AC-2: the message states the applicable set in the editor\'s own wording', () => {
  it('the transcription used by this suite agrees with the string the requirement quotes', () => {
    // Pinned BEFORE any derivation is asserted, so a wrong transcription is
    // caught as a wrong transcription rather than absorbed by the rule it is
    // supposed to check.
    expect(editorPropsMessage('text', { x: 1, y: 2 })).toContain(AC2_TEXT_APPLICABLE);
    expect(editorPropsMessage('arc', { text: 'x' })).toContain(AC2_ARC_APPLICABLE);
  });

  it('compact lane — names the applicable set for "text"', async () => {
    const { client } = await createHarnessedClient({ mode: 'compact' });
    const payload = payloadOf(await callCompact(client, ['text', OFFENDING_PROPS]));
    expect(payload.message, 'AC-2: the editor\'s own Applicable-props line, byte-for-byte').toContain(AC2_TEXT_APPLICABLE);
  });

  it('full lane — names the applicable set for "text"', async () => {
    const { client } = await createHarnessedClient({ mode: 'full' });
    const payload = payloadOf(await callFull(client, OFFENDING_PROPS));
    expect(payload.message).toContain(AC2_TEXT_APPLICABLE);
  });

  it('a second kind is a DIFFERENT set — proving the line is derived, not a literal', async () => {
    // `arc` takes 13 applicable props (12 pre-REQ-1029 plus the common
    // `position`) and shares exactly six with `text`. A hard-coded `text`
    // answer could not produce this.
    const { client } = await createHarnessedClient({ mode: 'full' });
    const payload = payloadOf(await callFull(client, { name: 'A', text: 'not an arc prop' }, 'arc'));
    expect(payload.message, 'the set follows the requested kind').toContain(AC2_ARC_APPLICABLE);
    expect(payload.message, "and `text` is not an `arc` prop").toContain('text');
    const applicableLine = payload.message.split('\n').find((l: string) => l.startsWith('Applicable props for'))!;
    expect(applicableLine.split(', ').length, 'thirteen applicable props, not the seven of `text`').toBe(13);
    expect(applicableLine, 'the set is the one the editor computes for arc').not.toContain(AC2_TEXT_APPLICABLE);
  });
});

/* ------------------------------------------------------------------ *
 * Guards the plan pins for the two implementation halves (T3/T4).
 * Kept here so a later edit that names a kind or a method fails HERE,
 * in the file that owns the AC, not in a code review.
 * ------------------------------------------------------------------ */

describe('REQ-1309 AC-3 guard: the rule names no method and no kind', () => {
  it('no create-kind literal appears in the new rule\'s source', () => {
    const src = fs.readFileSync(path.join(__dirname, 'argShape.ts'), 'utf8');
    const start = src.indexOf('export function findKindPropMismatch');
    expect(start, 'findKindPropMismatch exists in src/argShape.ts').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    // AC-3's own teeth: a hard-coded kind list is the drift generator REQ-1281
    // would immediately have to come back and edit. Scanned as QUOTED literals
    // — a bare word scan would false-positive on ordinary property names like
    // `path`, and a check that cries wolf is a check nobody keeps.
    expect(body, 'no create-kind literal in the rule').not.toMatch(/['"`](rect|ellipse|line|polygon|path|text|folder|page|image|icon|arc)['"`]/);
    expect(body, 'no contract method name in the rule').not.toMatch(/layer[._]?create|createAllowedKeys|validateCreateProps/);
  });

  it('the rule imports nothing outside this package (AC-5 standalone-degrade)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'argShape.ts'), 'utf8');
    // The specifiers are read with the TypeScript scanner, not with a regex
    // over `from '…'`. The regex form matched PROSE as well as imports:
    // REQ-1444 documented findFilePathEnvelopeMismatch with the sentence
    // `what separates "the declaration was sent" from "the contents were
    // sent"`, and that trailing `from "…"` was reported here as an import
    // reaching outside the package — a false red on correct source. The
    // scanner reads the import/export declarations themselves, so it is
    // STRICTLY the stronger check: it also sees bare side-effect imports,
    // `export … from`, and dynamic `import()`, none of which a
    // `from '…'` regex can see, while reporting nothing for a comment.
    const imports = ts
      .preProcessFile(src, true, true)
      .importedFiles.map((file) => file.fileName);
    for (const spec of imports) {
      expect(spec, `argShape.ts must not reach outside figpea-mcp/src: ${spec}`).toMatch(/^\.\//);
    }
  });

  it('the scanner that guards AC-5 still sees a real outside import — a guard that cannot fail guards nothing', () => {
    // The check above is only worth its assertion if the scanner itself
    // detects an outside specifier. Pinned here so a future "make the red go
    // away" edit to the scanner cannot quietly turn AC-5 into a no-op.
    const outside = ts.preProcessFile("import type { A } from 'node:fs';\n", true, true);

    expect(outside.importedFiles.map((file) => file.fileName)).toEqual(['node:fs']);
    expect(() => {
      for (const spec of outside.importedFiles.map((file) => file.fileName)) {
        expect(spec).toMatch(/^\.\//);
      }
    }).toThrow();
  });
});

/* ================================================================== *
 * AC-3 — the applicable set is DERIVED from the manifest (T2)
 * ================================================================== */

/** REQ-1281's stated future change, expressed as a manifest: `x`/`y` added to
 *  `text`. The requirement's own regression risk is that a hard-coded kind list
 *  here would need an edit when that lands. */
const REQ_1281_MANIFEST: any = manifestWithCreateParams({
  kind: { type: 'string', required: true, enum: CREATE_LAYER_KINDS },
  props: {
    type: 'object',
    required: false,
    shape: CREATE_COMMON_FIELDS,
    byKind: { ...CREATE_KIND_SCHEMA, text: { text: CREATE_KIND_SCHEMA.text.text, x: { type: 'number', required: false }, y: { type: 'number', required: false } } },
  },
});

/** A different kind, a different gain — so the derivation is not a one-off. */
const RECT_GAIN_MANIFEST: any = manifestWithCreateParams({
  kind: { type: 'string', required: true, enum: CREATE_LAYER_KINDS },
  props: {
    type: 'object',
    required: false,
    shape: CREATE_COMMON_FIELDS,
    byKind: { ...CREATE_KIND_SCHEMA, rect: { ...CREATE_KIND_SCHEMA.rect, rotation: { type: 'number', required: false } } },
  },
});

describe('REQ-1309 AC-3: the applicable set comes from the manifest, not from the code', () => {
  it('a manifest that gives `text` an x/y makes the SAME payload acceptable — no code change', async () => {
    // The pre-flight is asked the identical question with an identical
    // `figpea-mcp`, and only the manifest differs. If the verdict does not
    // move, the rule is reading a list baked into this package.
    const before = await createHarnessedClient({ mode: 'full', manifest: REAL_MANIFEST });
    const beforePayload = payloadOf(await callFull(before.client, OFFENDING_PROPS));
    expect(beforePayload.ok, "today's manifest: the payload is refused").toBe(false);
    expect(before.calls, 'and costs no round trip to say so').toHaveLength(0);

    const after = await createHarnessedClient({ mode: 'full', manifest: REQ_1281_MANIFEST });
    const afterRes = await callFull(after.client, OFFENDING_PROPS);
    expect(payloadOf(afterRes).ok, "REQ-1281's manifest: the identical payload is accepted").toBe(true);
    expect(after.calls, 'and is forwarded to the tab').toHaveLength(1);
  });

  it('the same holds in the compact lane, and for a second kind', async () => {
    const cBefore = await createHarnessedClient({ mode: 'compact', manifest: REAL_MANIFEST });
    expect(payloadOf(await callCompact(cBefore.client, ['text', OFFENDING_PROPS])).ok).toBe(false);
    expect(cBefore.calls).toHaveLength(0);

    const cAfter = await createHarnessedClient({ mode: 'compact', manifest: REQ_1281_MANIFEST });
    expect(payloadOf(await callCompact(cAfter.client, ['text', OFFENDING_PROPS])).ok, 'accepted under the gained manifest').toBe(true);
    expect(cAfter.calls).toHaveLength(1);

    // `rect` gains `rotation` instead — the gain is read per kind, not per rule.
    const rAfter = await createHarnessedClient({ mode: 'full', manifest: RECT_GAIN_MANIFEST });
    const res = payloadOf(await callFull(rAfter.client, { name: 'R', rotation: 45 }, 'rect'));
    expect(res.ok, 'the gained rect prop is accepted').toBe(true);
    expect(rAfter.calls).toHaveLength(1);
    const rBefore = await createHarnessedClient({ mode: 'full', manifest: REAL_MANIFEST });
    const refused = payloadOf(await callFull(rBefore.client, { name: 'R', rotation: 45 }, 'rect'));
    expect(refused.ok, "today's manifest still refuses it, naming the prop").toBe(false);
    expect(refused.message).toContain('rotation');
    expect(rBefore.calls).toHaveLength(0);
  });
});

/** Manifests the rule must DECLINE to judge: nothing to derive from, or a
 *  `byKind` whose keys are not the selector's values. A guess in any of these
 *  shapes would be a false rejection of a call the editor accepts. */
const NO_BY_KIND_MANIFEST: any = manifestWithCreateParams({
  kind: { type: 'string', required: true, enum: CREATE_LAYER_KINDS },
  props: { type: 'object', required: false, shape: CREATE_COMMON_FIELDS },
});
const UNRELATED_BY_KIND_MANIFEST: any = manifestWithCreateParams(
  {
    kind: { type: 'string', required: true, enum: ['red', 'green'] },
    props: { type: 'object', required: false, shape: { tone: { type: 'string', required: false } }, byKind: { alpha: { gauge: { type: 'number', required: false } }, beta: { gauge: { type: 'number', required: false } } } },
  },
  ['red', 'green'],
);
const TWO_SELECTOR_MANIFEST: any = manifestWithCreateParams({
  kind: { type: 'string', required: true, enum: CREATE_LAYER_KINDS },
  unit: { type: 'string', required: false, enum: ['px', 'em'] },
  props: { type: 'object', required: false, shape: CREATE_COMMON_FIELDS, byKind: CREATE_KIND_SCHEMA },
});

describe('REQ-1309 AC-3: a `byKind` the selector cannot resolve is declined, not guessed', () => {
  it.each([
    ['no `byKind` at all', NO_BY_KIND_MANIFEST, 'text', { totallyUnknown: 1 }],
    ['a `byKind` unrelated to the selector', UNRELATED_BY_KIND_MANIFEST, 'red', { totallyUnknown: 1 }],
    ['TWO string-enum siblings — the selector is ambiguous', TWO_SELECTOR_MANIFEST, 'text', { totallyUnknown: 1 }],
  ])('%s — forwards untouched', async (_label, manifest, kind, props) => {
    for (const mode of ['full', 'compact'] as const) {
      const { client, calls } = await createHarnessedClient({ mode, manifest });
      const res = mode === 'full' ? await callFull(client, props, kind) : await callCompact(client, [kind, props]);
      expect(payloadOf(res).ok, `${mode}: a call the editor accepts is never refused by the pre-flight`).toBe(true);
      expect(calls, `${mode}: exactly one bridge call`).toHaveLength(1);
    }
  });
});

/* ================================================================== *
 * AC-4 — no valid call changes (T2)
 * ================================================================== */

const VALID_CASES: Array<{ label: string; kind: string; props: Record<string, unknown> }> = [
  { label: 'rect with x/y (the two kinds that declare them today)', kind: 'rect', props: { name: 'R', x: 10, y: 20, rwidth: 100, rheight: 50 } },
  { label: 'text with a style object', kind: 'text', props: { name: 'T', text: 'hello', style: { fill: '#ff0000' } } },
  { label: 'image', kind: 'image', props: { url: 'http://127.0.0.1:1/blob/x', mimeType: 'image/png', rwidth: 32, rheight: 32 } },
  { label: 'path', kind: 'path', props: { name: 'P', path: 'M0 0 L10 10' } },
  { label: 'arc', kind: 'arc', props: { name: 'A', r: 20, startAngle: 0, endAngle: 180, thickness: 4, rx: 10, ry: 10, sweep: 0.5 } },
  { label: 'icon', kind: 'icon', props: { name: 'heart', size: 24 } },
];

describe('REQ-1309 AC-4: no valid call changes — one bridge call, the tab\'s result untouched', () => {
  it.each(VALID_CASES)('$label', async ({ kind, props }) => {
    for (const mode of ['full', 'compact'] as const) {
      const { client, calls } = await createHarnessedClient({ mode });
      const res = mode === 'full' ? await callFull(client, props, kind) : await callCompact(client, [kind, props]);
      expect(res.isError, `${mode} ${kind}: still a success`).toBe(false);
      expect(calls, `${mode} ${kind}: exactly ONE bridge call`).toHaveLength(1);
      expect(calls[0].args, `${mode} ${kind}: the same positional arguments reach the tab`).toEqual([kind, props]);
      // Deep equality against the STUB's own object, not a subset: a pre-flight
      // that appended, dropped or reshaped a field would be caught here.
      expect(payloadOf(res), `${mode} ${kind}: the tab's result passes through byte-for-byte`).toEqual({
        ok: true,
        value: { id: 'layer-1', kind },
      });
    }
  });

  it('image + props.filePath is translated to a bridge url and still forwarded once (AC-4 edge 1)', async () => {
    for (const mode of ['full', 'compact'] as const) {
      const fp = tmpFile('.png', 'pngbytes');
      const { client, calls } = await createHarnessedClient({ mode });
      const res = mode === 'full'
        ? await callFull(client, { filePath: fp, mimeType: 'image/png' }, 'image')
        : await callCompact(client, ['image', { filePath: fp, mimeType: 'image/png' }]);
      expect(payloadOf(res).ok, `${mode}: the translation is not a rejection`).toBe(true);
      expect(calls, `${mode}: exactly one bridge call`).toHaveLength(1);
      const sent = calls[0].args[1] as Record<string, unknown>;
      // What AC-4 edge 1 pins is the *shape* of the translation, and all of it
      // is below: an `http` URL, a loopback host, a port, and the `/file?path=`
      // query — so dropping the `filePath`→`url` translation, dropping the
      // port, or losing the query each fail here.
      //
      // Which loopback SPELLING that host carries is not REQ-1309's contract
      // and never was — the literal arrived here incidentally. REQ-1301 owns it
      // as one fact (`BRIDGE_URL_HOST` in `src/bridgeHost.ts`: the emitted URL
      // says `localhost` while the bind deliberately stays `127.0.0.1`), and
      // pins it precisely, with that rationale, in
      // `src/req1301BridgeHost.test.ts`. Hence the alternation rather than one
      // frozen literal: do not "fix" this back to a single host.
      expect(sent.url, `${mode}: filePath became a loopback bridge url (which loopback spelling is REQ-1301's contract — pinned in src/req1301BridgeHost.test.ts)`)
        .toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/file\?path=/);
      expect(sent.filePath, `${mode}: filePath is stripped before relay`).toBeUndefined();
    }
  });

  it('an unknown key present with value `undefined` counts as ABSENT and forwards (AC-4 edge 2)', async () => {
    // The editor's own "design decision 2": a key present with value
    // `undefined` is not written, so it is not a rejection either.
    for (const mode of ['full', 'compact'] as const) {
      const { client, calls } = await createHarnessedClient({ mode });
      const props = { name: 'T', text: 'hi', someAbsentProp: undefined };
      const res = mode === 'full' ? await callFull(client, props) : await callCompact(client, ['text', props]);
      expect(payloadOf(res).ok, `${mode}: not a rejection`).toBe(true);
      expect(calls, `${mode}: exactly one bridge call`).toHaveLength(1);
    }
    // THIS TEST IS THE PIN for the rule's handling of an `undefined` value,
    // and it is load-bearing: delete the `!== undefined` guard at
    // `src/argShape.ts:312` (`if (props[key] !== undefined && !allowed.has(key))`)
    // and this assertion is the ONLY one that fails — the other 33 in this file
    // stay green.
    //
    // The key reaches the pre-flight because the harness uses the MCP SDK's
    // `InMemoryTransport` (see `createHarnessedClient`), which hands the params
    // object across in-process. Nothing `JSON.stringify`s the request on this
    // path, so `someAbsentProp` survives as a *present* key whose value is
    // `undefined` — exactly the shape the guard exists to absorb. (An earlier
    // note here claimed `JSON.stringify` dropped the key before it crossed the
    // wire, and pointed at a predicate-level test for the real evidence. No
    // such test exists: the only `findKindPropMismatch` call sites are the
    // budget/memoization ones lower down, and all of them pass defined values.)
  });
});

/* ================================================================== *
 * AC-5 — standalone-degrade: no opinion ⇒ FORWARD (T2)
 * ================================================================== */

describe('REQ-1309 AC-5: with nothing to derive from, the pre-flight takes no opinion and FORWARDS', () => {
  it('no manifest at all — the published-npm standalone case', async () => {
    // Compact mode can still reach the method through the dispatcher, so the
    // absence is observable there: the call must go through untouched.
    const { client, calls } = await createHarnessedClient({ mode: 'compact', haveManifest: false });
    const res = await callCompact(client, ['text', OFFENDING_PROPS]);
    expect(payloadOf(res).ok, 'no manifest ⇒ no opinion ⇒ the tab decides').toBe(true);
    expect(calls, 'forwarded').toHaveLength(1);
    // No manifest means no schema, and therefore not even the generic numeric
    // coercion — the strings stay strings. That is the strongest form of
    // "no opinion": the server changes nothing at all before forwarding.
    expect(calls[0].args[1], 'the agent\'s payload reaches the tab untouched').toEqual(OFFENDING_PROPS);

    // Full mode cannot reach the handler without a manifest — the tool is not
    // registered at all. Asserting the absence is the honest form: there is no
    // handler, so there is no pre-flight to have an opinion.
    const full = await createHarnessedClient({ mode: 'full', haveManifest: false });
    const list: any = await full.client.listTools();
    expect(list.tools.map((t: any) => t.name), 'no manifest ⇒ no generated tools at all').not.toContain('layer_create');
  });

  it('a manifest whose create method declares no params', async () => {
    // With no declared parameters there is no schema to consult, so this rule
    // has nothing to say. Both lanes still have their OWN pre-flights (REQ-1296's
    // surplus-positional and unknown-parameter rules) and those are what
    // refuse the call — the assertion is that none of the wording here appears,
    // and that no round trip is spent either way.
    const manifest = manifestWithCreateParams({});
    for (const mode of ['full', 'compact'] as const) {
      const { client, calls } = await createHarnessedClient({ mode, manifest });
      const res = mode === 'full' ? await callFull(client, OFFENDING_PROPS) : await callCompact(client, ['text', OFFENDING_PROPS]);
      expect(textOf(res), `${mode}: this rule's wording appears nowhere`).not.toContain('do not apply to kind');
      expect(textOf(res), `${mode}: nor its applicable-set line`).not.toContain('Applicable props for');
      expect(calls, `${mode}: no round trip is spent`).toHaveLength(0);
    }
  });

  it('a manifest with a selector but NO props param — a selector with nothing to apply it to', async () => {
    const manifest = manifestWithCreateParams({ kind: { type: 'string', required: true, enum: CREATE_LAYER_KINDS } });
    for (const mode of ['full', 'compact'] as const) {
      const { client, calls } = await createHarnessedClient({ mode, manifest });
      const res = mode === 'full'
        ? await client.callTool({ name: 'layer_create', arguments: { kind: 'text' } } as any)
        : await callCompact(client, ['text']);
      expect(payloadOf(res).ok, `${mode}: forwarded`).toBe(true);
      expect(calls, `${mode}: exactly one bridge call`).toHaveLength(1);
    }
  });

  it('a manifest whose props has a `shape` but NO `byKind`', async () => {
    for (const mode of ['full', 'compact'] as const) {
      const { client, calls } = await createHarnessedClient({ mode, manifest: NO_BY_KIND_MANIFEST });
      const res = mode === 'full' ? await callFull(client, { text: 'hi', rwidth: 10 }) : await callCompact(client, ['text', { text: 'hi', rwidth: 10 }]);
      expect(payloadOf(res).ok, `${mode}: a shape alone is no per-kind rule`).toBe(true);
      expect(calls, `${mode}: forwarded`).toHaveLength(1);
    }
  });

  it('a kind the sibling enum does not list — compact forwards, full is refused by the ENUM, not by this rule', async () => {
    const manifest = manifestWithCreateParams(
      { kind: { type: 'string', required: true, enum: CREATE_LAYER_KINDS }, props: { type: 'object', required: false, shape: CREATE_COMMON_FIELDS, byKind: CREATE_KIND_SCHEMA } },
    );
    const compact = await createHarnessedClient({ mode: 'compact', manifest });
    const cRes = payloadOf(await callCompact(compact.client, ['not-a-kind', { x: 1 }]));
    expect(cRes.ok, 'compact does not enum-validate, and the pre-flight must not either').toBe(true);
    expect(compact.calls, 'forwarded').toHaveLength(1);

    // Full mode DOES validate the advertised enum (REQ-093, pinned by REQ-1296).
    // What AC-5 asks is that the pre-flight is not the thing refusing — so the
    // refusal must be the enum's, and must carry none of the rule's wording.
    const full = await createHarnessedClient({ mode: 'full', manifest });
    const fRes: any = await callFull(full.client, { x: 1 }, 'not-a-kind');
    expect(fRes.isError, 'the enum is still enforced').toBe(true);
    expect(textOf(fRes), "the pre-flight's wording appears nowhere").not.toContain('do not apply to kind');
    expect(textOf(fRes), "nor the rule's applicable-set line").not.toContain('Applicable props for');
    expect(full.calls, 'no round trip either way').toHaveLength(0);
  });

  it('a kind with no own `byKind` entry (the editor\'s `folder`) forwards — the safe direction', async () => {
    // Stated as a known limitation in the plan: the manifest cannot
    // distinguish "this kind declares no own props" from "this kind is
    // unknown", so the pre-flight declines. The pin is that it DECLINES —
    // inferring the opposite here is precisely the false rejection AC-5
    // forbids.
    for (const mode of ['full', 'compact'] as const) {
      const { client, calls } = await createHarnessedClient({ mode });
      const res = mode === 'full' ? await callFull(client, { x: 1, y: 2 }, 'folder') : await callCompact(client, ['folder', { x: 1, y: 2 }]);
      expect(payloadOf(res).ok, `${mode}: folder still costs a round trip, by design`).toBe(true);
      expect(calls, `${mode}: forwarded`).toHaveLength(1);
    }
  });
});

/* ================================================================== *
 * AC-6 — the check stays far cheaper than the round trip it saves (T2)
 * ================================================================== */

/**
 * The pure rule, imported lazily so a missing implementation fails ONLY the
 * blocks that need it. The end-to-end blocks above stay observable in the red
 * run, which is the whole point of a recorded red.
 */
type Budget = { nodes: number };
let rule: {
  findKindPropMismatch?: (
    paramSchemas: Record<string, any> | undefined,
    values: Record<string, unknown>,
    pathFor: (name: string) => string,
    budget?: Budget,
  ) => any;
  kindAllowedKeys?: (schema: any, kind: string) => ReadonlySet<string>;
  MAX_DEPTH?: number;
  MAX_NODES?: number;
};
let ruleModule: Record<string, unknown> = {};
beforeAll(async () => {
  ruleModule = (await import('./argShape')) as Record<string, unknown>;
  rule = ruleModule as any;
});

const CREATE_TOOL: GeneratedTool = buildToolsFromManifest(REAL_MANIFEST).find((t) => t.name === 'layer_create')!;

describe('REQ-1309 AC-6: the check is bounded and memoized', () => {
  it('exposes the same bounds the module documents, so the constants cannot drift silently', () => {
    expect(rule.MAX_DEPTH, 'depth bound').toBe(12);
    expect(rule.MAX_NODES, 'node bound').toBe(4000);
  });

  it('an exhausted budget yields NO opinion, and the call is forwarded rather than refused', () => {
    const values = { kind: 'text', props: { x: 1, y: 2 } };
    expect(
      rule.findKindPropMismatch!(CREATE_TOOL.paramSchemas, values, (n) => n, { nodes: rule.MAX_NODES! }),
      'a budget already spent is the safe direction: decline, never reject',
    ).toBeUndefined();
  });

  it('the same query with budget to spare DOES have an opinion', () => {
    const found = rule.findKindPropMismatch!(CREATE_TOOL.paramSchemas, { kind: 'text', props: { x: 1, y: 2 } }, (n) => n, { nodes: 0 });
    expect(found, 'otherwise the previous test would pass for the wrong reason').toBeTruthy();
    expect(found.code, "the editor's own code travels with the mismatch").toBe('invalid_transform');
    expect(found.path, 'the path comes from pathFor, so each lane names its own').toBe('props');
  });

  it('a payload big enough to exhaust the budget is FORWARDED, not refused (the safe direction, end to end)', async () => {
    // Over `MAX_NODES` offending keys: the traversal runs out of allowance
    // mid-scan and the rule declines, so the tab decides. A check that kept
    // going would be the expensive mistake this bound exists to prevent.
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < rule.MAX_NODES! + 500; i++) huge[`nope${i}`] = i;
    const { client, calls } = await createHarnessedClient({ mode: 'full' });
    const res = await callFull(client, huge);
    expect(payloadOf(res).ok, 'budget exhausted ⇒ no opinion ⇒ forwarded').toBe(true);
    expect(calls, 'and the tab is the one that answers').toHaveLength(1);
  });

  it('the allowed-key set is MEMOIZED: the identical Set instance on every one of 10 000 lookups', () => {
    const schema = CREATE_TOOL.paramSchemas!.props;
    const first = rule.kindAllowedKeys!(schema, 'text');
    for (let i = 0; i < 10_000; i++) {
      expect(rule.kindAllowedKeys!(schema, 'text'), `call ${i} returned a fresh Set`).toBe(first);
    }
    expect(first, 'and it is the editor\'s own set for that kind').toEqual(new Set([...Object.keys(CREATE_COMMON_FIELDS), ...Object.keys(CREATE_KIND_SCHEMA.text)]));
    expect(rule.kindAllowedKeys!(schema, 'arc'), 'a different kind is a different set').not.toBe(first);
    const otherSchema = buildToolsFromManifest(REQ_1281_MANIFEST).find((t) => t.name === 'layer_create')!.paramSchemas!.props;
    expect(rule.kindAllowedKeys!(otherSchema, 'text'), 'a different schema is a different set').not.toBe(first);
  });

  it('the rule adds no await and no I/O — it runs before a round trip, so it must not need one', () => {
    const src = fs.readFileSync(path.join(__dirname, 'argShape.ts'), 'utf8');
    const start = src.indexOf('export function findKindPropMismatch');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body, 'no await in the rule').not.toMatch(/\bawait\b/);
    expect(body, 'no I/O in the rule').not.toMatch(/fetch\(|require\(|node:|readFile|WebSocket/);
    // It is a synchronous predicate: a Promise here would make both call sites
    // need an await, which is the one thing a pre-flight must not cost.
    expect(rule.findKindPropMismatch!(CREATE_TOOL.paramSchemas, { kind: 'text', props: { x: 1 } }, (n) => n)).not.toBeInstanceOf(Promise);
  });
});

