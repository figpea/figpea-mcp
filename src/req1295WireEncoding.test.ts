import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { buildToolsFromManifest } from './tools';
import type { ManifestLike } from './tools';

/**
 * REQ-1295 — `describe()` states the positional encoding, and a wrapped
 * object is refused by name.
 *
 * The spec here is the AC text, not this repo's implementation. What the card
 * states, stated independently of any code here:
 *
 *  - AC-1 (repro) `figpea_describe({group:'layer', method:'stylePatch'})`
 *    reports `params.patch` as a NAMED object declaration; sending that shape
 *    — `['L1', {patch:{fill:'#12395C'}}]`, two positional arguments — is
 *    answered `unsupported_style_key: patch`, because the wrapper was received
 *    AS the patch and hit the style whitelist. The declaration is CORRECT and
 *    stays; the description is what misleads.
 *  - AC-2 `describe()` for `stylePatch` states the encoding unambiguously — a
 *    wire/args listing showing `method(id, patchContents)` — so a caller
 *    reading only the manifest sends the form that works.
 *  - AC-3 calling `stylePatch('<id>', {patch:{…}})` returns an error that NAMES
 *    THE MISTAKE (the declared wrapper was sent instead of the contents), not a
 *    bare `unsupported_style_key`.
 *  - AC-4 every method whose argument is an object carries the same explicit
 *    encoding statement — `stylePatch`, `setPosition`, `setText`,
 *    `layer.create`, `setAutoLayout`, `setConstraints`, `canvas.screenshot`,
 *    `export.artboard` and every other method, present and future.
 *
 * Harness: a real MCP SDK `Client` over `InMemoryTransport` around a real
 * `createMcpServer`, with `callTab` stubbed and COUNTED. The stub is not
 * neutral — it applies v3's real `validateStylePatch` whitelist rejection and
 * its real `tryUnwrapWrapper` expansion (`registry.ts:130`, `raw.length !== 1`)
 * and echoes what it received, so "the tab rejected the wrapper" and "the
 * wrapper never reached the tab" are two DIFFERENT, separately observable
 * facts, and the round trip a refusal saves is counted rather than timed.
 *
 * **Both lanes are asserted for every behaviour.** Compact `figpea_call` is
 * the default mode; full mode's per-tool surface is what real MCP clients use.
 *
 * The pure rows import the modules under construction DYNAMICALLY, so this file
 * LOADS on the unfixed tree and each row is observably red for its own reason
 * rather than the whole file dying on a missing export at link time — which is
 * what keeps the red run evidence rather than a syntax error.
 */

/* ------------------------------------------------------------------ *
 * The manifest — real declarations, transcribed, not invented.
 * Every schema below is what `v3` publishes (layer.descriptor.ts,
 * canvas.descriptor.ts, export.descriptor.ts). Transcribed rather than
 * imported because `figpea-mcp` is a standalone package that must build with
 * no sibling `v3/` checkout. Style/patch shapes carry a representative subset
 * of the real key set: what these rows assert about `contents` is that it is
 * the declared shape's own keys, not how many there are.
 * ------------------------------------------------------------------ */

const STYLE_PATCH_SHAPE = {
  fill: { type: 'string', required: false },
  fillType: { type: 'string', required: false },
  strokeEnabled: { type: 'boolean', required: false },
  strokeColor: { type: 'string', required: false },
  strokeWidth: { type: 'number', required: false },
  opacity: { type: 'number', required: false },
  fontFamily: { type: 'string', required: false },
  fontSize: { type: 'number', required: false },
  fontWeight: { type: 'number', required: false },
  letterSpacing: { type: 'number', required: false },
  lineHeight: { type: 'number', required: false },
  cornerRadius: { type: 'number', required: false },
  visible: { type: 'boolean', required: false },
};

const MANIFEST = {
  layer: {
    stylePatch: {
      doc: "Patches a layer's style with an explicit whitelist of public keys — any other key is rejected (OQ-7).",
      params: {
        id: { type: 'string', required: true },
        patch: { type: 'object', required: true, shape: STYLE_PATCH_SHAPE },
      },
      result: 'void',
    },
    setPosition: {
      doc: "Places a layer's visible box: the layer's bounds top-left lands exactly on {x,y}.",
      params: {
        id: { type: 'string', required: true },
        pos: {
          type: 'object',
          required: true,
          shape: {
            x: { type: 'number', required: false },
            y: { type: 'number', required: false },
            space: { type: 'string', required: false, enum: ['world', 'local'] },
          },
        },
      },
      result: 'void',
    },
    setText: {
      doc: "Replaces a text layer's full text content.",
      params: {
        id: { type: 'string', required: true },
        text: { type: 'string', required: true },
      },
      result: 'void',
    },
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'line', 'polygon', 'text', 'image'] },
        props: {
          type: 'object',
          required: false,
          shape: { parentId: { type: 'string', required: false }, name: { type: 'string', required: false } },
          byKind: {
            text: { text: { type: 'string', required: false }, fontSize: { type: 'number', required: false } },
            rect: { rwidth: { type: 'number', required: false }, rheight: { type: 'number', required: false } },
          },
        },
      },
      result: { id: 'string' },
    },
    setAutoLayout: {
      doc: "Sets a group or page's stack layout by patching its autoLayout field — one call, one undo step.",
      params: {
        id: { type: 'string', required: true },
        patch: {
          type: 'object',
          required: true,
          shape: {
            mode: { type: 'string', required: false, enum: ['none', 'horizontal', 'vertical'] },
            itemSpacing: { type: 'number', required: false },
          },
        },
      },
      result: 'void',
    },
    setConstraints: {
      doc: "Sets a layer's per-child constraint axes.",
      params: {
        id: { type: 'string', required: true },
        patch: {
          type: 'object',
          required: true,
          shape: {
            horizontal: { type: 'string', required: false, enum: ['left', 'right', 'scale', 'center'] },
            vertical: { type: 'string', required: false, enum: ['top', 'bottom', 'scale', 'center'] },
          },
        },
      },
      result: 'void',
    },
    setName: {
      doc: 'Renames a layer or page by id.',
      params: { id: { type: 'string', required: true }, name: { type: 'string', required: true } },
      result: 'void',
    },
    batch: {
      doc: 'Applies a sequence of layer ops as ONE undo step.',
      params: {
        ops: {
          type: 'array',
          required: true,
          of: {
            type: 'object',
            required: true,
            shape: { method: { type: 'string', required: true }, args: { type: 'array', required: true } },
          },
        },
      },
      result: { results: 'OpResult[]' },
    },
  },
  canvas: {
    screenshot: {
      doc: 'Captures the live canvas as a PNG screenshot.',
      params: {
        options: {
          type: 'object',
          required: false,
          shape: { id: { type: 'string', required: false }, pixelRatio: { type: 'number', required: false } },
        },
      },
      result: { bytes: 'string', mime: 'string' },
    },
  },
  export: {
    artboard: {
      doc: 'Exports an artboard as a raster image or SVG.',
      params: {
        id: { type: 'string', required: true },
        input: {
          type: 'object',
          required: true,
          shape: {
            format: { type: 'string', required: true, enum: ['png', 'svg', 'jpg'] },
            scale: { type: 'number', required: false },
          },
        },
      },
      result: { bytes: 'string', mime: 'string', filename: 'string' },
    },
  },
  session: {
    describe: {
      doc: 'Returns the agent contract surface.',
      params: {},
      result: {},
    },
  },
} as unknown as ManifestLike;

/** A pre-REQ-093 manifest: `params` values are free-text hints, so nothing in
 *  them is a schema and this server has no declaration to reason from. */
const LEGACY_MANIFEST = {
  layer: {
    stylePatch: {
      doc: "Patches a layer's style.",
      params: { id: 'a layer id', patch: 'an object of style keys' },
      result: 'void',
    },
  },
} as unknown as ManifestLike;

/* ------------------------------------------------------------------ *
 * The stub tab — v3's real answer, not a plausible one.
 * ------------------------------------------------------------------ */

/**
 * v3's `STYLE_PATCH_WHITELIST` (stylePatch.ts:55-104), as the subset this
 * fixture's declaration above uses. No key of it is named `patch` or `id`.
 */
const STYLE_WHITELIST = new Set(Object.keys(STYLE_PATCH_SHAPE));

/**
 * v3's `tryUnwrapWrapper` (registry.ts:125-145): a single object keyed by the
 * method's own parameter names expands to positional order — and ONLY when the
 * call carries exactly one argument (`registry.ts:130`, `raw.length !== 1`).
 * This is the whole reason `['L1', {patch:{…}}]` fails while
 * `[{id:'L1', patch:{…}}]` works, so the stub must reproduce it exactly or the
 * repro it stands in for is not the repro.
 */
function tryUnwrapWrapper(method: string, args: unknown[], paramNames: string[]): unknown[] {
  if (args.length !== 1) return args;
  const only = args[0];
  if (only === null || typeof only !== 'object' || Array.isArray(only)) return args;
  const keys = Object.keys(only as Record<string, unknown>);
  if (keys.length === 0) return args;
  if (!keys.every((k) => paramNames.includes(k))) return args;
  return paramNames.map((k) => (only as Record<string, unknown>)[k]);
}

const PARAM_NAMES: Record<string, string[]> = {
  stylePatch: ['id', 'patch'],
  setPosition: ['id', 'pos'],
  setText: ['id', 'text'],
  create: ['kind', 'props'],
  setAutoLayout: ['id', 'patch'],
  setConstraints: ['id', 'patch'],
  setName: ['id', 'name'],
  batch: ['ops'],
  screenshot: ['options'],
  artboard: ['id', 'input'],
  describe: [],
};

/**
 * v3's real rejection for this failure: `validateStylePatch` (stylePatch.ts:
 * 1087-1091) walks the object it was handed and returns the FIRST key outside
 * the whitelist. Given the wrapper, the object it was handed IS the wrapper, so
 * the first offending key is `patch` — the parameter's own name.
 */
function editorAnswer(method: string, args: unknown[]): { ok: false; code: string; message: string } | { ok: true; value: unknown } {
  const names = PARAM_NAMES[method];
  const expanded = names ? tryUnwrapWrapper(method, args, names) : args;
  if (method === 'stylePatch') {
    const patch = expanded[1];
    if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
      for (const key of Object.keys(patch as Record<string, unknown>)) {
        if (!STYLE_WHITELIST.has(key)) {
          return { ok: false, code: 'unsupported_style_key', message: `unsupported style key "${key}"` };
        }
      }
    }
    return { ok: true, value: { id: expanded[0], applied: Object.keys((patch ?? {}) as Record<string, unknown>) } };
  }
  return { ok: true, value: { method, received: expanded } };
}

interface Capture {
  group: string;
  method: string;
  args: unknown[];
}

function makeStub(opts?: { deliverManifest?: unknown }) {
  const captured: Capture[] = [];
  const deliver = 'deliverManifest' in (opts ?? {}) ? opts!.deliverManifest : MANIFEST;
  const stub = {
    port: 54397,
    token: 'test-token-1295',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      if (deliver !== undefined) h(deliver);
    },
    callTab: async (group: string, method: string, args: unknown[]) => {
      captured.push({ group, method, args: structuredClone(args) });
      return editorAnswer(method, args);
    },
    close: async () => {},
  };
  return { stub, captured };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

type Mode = 'compact' | 'full';

async function connect(bridge: unknown, mode: Mode, opts?: { prefetchedManifest?: unknown }) {
  const server = createMcpServer(
    bridge as never,
    { toolMode: mode, ...(opts && 'prefetchedManifest' in opts ? { prefetchedManifest: opts.prefetchedManifest } : {}) } as never,
  );
  const client = new Client({ name: 'req-1295-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result: any = await client.callTool({ name, arguments: args } as any);
  const content = result.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, `${name} returned a text block`).toBeDefined();
  const text = textBlock!.text ?? '';
  if (!text.trimStart().startsWith('{')) {
    // A handler that throws reaches the client as plain text; surface it as an
    // envelope so the failure reads as the defect, not a JSON parse error here.
    return { ok: false, code: 'non_envelope', message: text };
  }
  return JSON.parse(text);
}

/** The modules under construction, imported per-row so this file LOADS without
 *  them — which is what keeps every row's red reason its own. */
async function wireShapeModule(): Promise<any> {
  return import('./wireShape');
}
async function argShapeModule(): Promise<any> {
  return import('./argShape');
}

// ── the payloads, spelled once ───────────────────────────────────────────────

/** The card's repro, byte-for-byte: the shape `describe()` advertises, sent as
 *  TWO positional arguments. */
const WRAPPER_ARGS = ['L1', { patch: { fill: '#12395C' } }];

/** The form that works: the object's contents flat in its own slot. */
const FLAT_ARGS = ['L1', { fill: '#12395C' }];

/** The other legal form: the same wrapper as the WHOLE of `args` — which the
 *  editor expands, because it carries exactly one argument. */
const WHOLE_ARGS_WRAPPER = [{ id: 'L1', patch: { fill: '#12395C' } }];

// ───────────────────────────────────────────────────────────── AC-1 ──

describe('REQ-1295 AC-1 — the repro is real, and the declaration stays correct', () => {
  it('the tab really does answer unsupported_style_key: patch to the advertised wrapper — the defect is genuine', () => {
    // Proven against the transcribed editor behaviour directly, not through this
    // server: with the fix in place the server never forwards this payload, so
    // the repro has to be pinned at its source or AC-1's evidence evaporates.
    const forwarded = editorAnswer('stylePatch', WRAPPER_ARGS);
    expect(forwarded.ok).toBe(false);
    expect((forwarded as any).code).toBe('unsupported_style_key');
    expect((forwarded as any).message).toBe('unsupported style key "patch"');
    // The contrast that makes it a WRAPPER problem and not a bad-style-key one:
    // the contents, flat, are accepted by the identical validator.
    expect(editorAnswer('stylePatch', FLAT_ARGS).ok).toBe(true);
    // …and the same wrapper as the whole of args is legal, because it expands.
    expect(editorAnswer('stylePatch', WHOLE_ARGS_WRAPPER).ok).toBe(true);
  });

  it('describe still reports params.patch as a NAMED object declaration — that declaration is correct and is NOT changed', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'stylePatch' });
    expect(payload.ok).toBe(true);
    // Unchanged BY DESIGN (the card rules the editor's validation out of scope):
    // the fix is relay-side, so the declaration an agent reads is the editor's.
    expect(payload.params.patch.type).toBe('object');
    expect(payload.params.patch.required).toBe(true);
    expect(payload.params.patch.shape.fill.type).toBe('string');
    expect(payload.params.id.type).toBe('string');
  });

  it('the two-positional-argument wrapper is refused by name, on BOTH lanes, before the round trip', async () => {
    for (const mode of ['compact', 'full'] as Mode[]) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', { group: 'layer', method: 'stylePatch', args: WRAPPER_ARGS })
          : await callToolJson(client, 'layer_stylePatch', { id: 'L1', patch: { patch: { fill: '#12395C' } } });

      expect(result.ok, `${mode}: the wrapper is refused, not applied`).toBe(false);
      // AC-3's code: the relay's own pre-flight family, never the editor's.
      expect(result.code, `${mode}: pre-flight code`).toBe('invalid_params');
      // The round trip it saves. The whole cost of this defect is one bridge
      // call spent to learn nothing, so this is the behaviour, not a nicety.
      expect(captured, `${mode}: the wrapper never reached the tab`).toHaveLength(0);
    }
  });
});

// ───────────────────────────────────────────────────────────── AC-2 ──

describe('REQ-1295 AC-2 — describe() states the encoding unambiguously', () => {
  it('stylePatch carries a wire listing that shows method(id, patchContents)', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'stylePatch' });

    expect(payload.wire, 'the encoding statement is present').toBeDefined();
    const wire = payload.wire;
    expect(wire.encoding).toBe('positional');
    // AC-2's literal ask: `method(id, patchContents)`.
    expect(wire.callAs).toBe('layer.stylePatch(id, patchContents)');

    // Each declared param at its own args[index].
    expect(wire.args).toHaveLength(2);
    expect(wire.args[0]).toMatchObject({ index: 0, name: 'id', type: 'string', required: true });
    expect(wire.args[1]).toMatchObject({ index: 1, name: 'patch', type: 'object', required: true });

    // The object param's legal contents — its declared shape's own keys, in
    // declaration order.
    expect(Array.isArray(wire.args[1].contents)).toBe(true);
    expect(wire.args[1].contents).toEqual(Object.keys(STYLE_PATCH_SHAPE));
    // …and the one envelope NOT to send, rendered from the same key.
    expect(wire.args[1].notThis).toBe('{ "patch": { … } }');

    // A caller reading ONLY this knows the form that works.
    expect(wire.note).toMatch(/POSITIONAL/i);
    expect(wire.note).toMatch(/never an envelope keyed by the parameter/i);
  });

  it('the additive key sits BESIDE the editor\'s own doc/params/result, which still spread through untouched', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'stylePatch' });
    expect(payload.doc).toBe(MANIFEST.layer.stylePatch.doc);
    expect(payload.result).toBe('void');
    expect(Object.keys(payload.params)).toEqual(['id', 'patch']);
    // This server does not restate the editor's documentation; it adds the one
    // fact the manifest cannot express.
    expect(payload.group).toBe('layer');
    expect(payload.method).toBe('stylePatch');
  });

  it('the key is OMITTED for a legacy free-text params manifest — no opinion, no key', async () => {
    const { stub } = makeStub({ deliverManifest: LEGACY_MANIFEST });
    const client = await connect(stub, 'compact', { prefetchedManifest: LEGACY_MANIFEST });
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'stylePatch' });
    expect(payload.ok).toBe(true);
    expect(payload.params).toBeDefined();
    // Nothing structured to derive from ⇒ no opinion ⇒ no key. An empty listing
    // would read as "this method has none" rather than "this server cannot tell".
    expect(payload.wire).toBeUndefined();
  });

  it('a method that declares no parameters carries no wire listing either', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const payload = await callToolJson(client, 'figpea_describe', { group: 'session', method: 'describe' });
    expect(payload.ok).toBe(true);
    expect(payload.wire).toBeUndefined();
  });

  it('a group listing states the encoding once, for every method it holds', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer' });
    expect(payload.ok).toBe(true);
    expect(typeof payload.encodingNote).toBe('string');
    expect(payload.encodingNote).toMatch(/POSITIONAL/i);
    expect(payload.encodingNote).toMatch(/never an envelope keyed by the parameter/i);
    // …and the group's methods are still there beside it.
    expect(Object.keys(payload.methods)).toContain('stylePatch');
  });

  it('the derivation is DERIVED, never enumerated: it names no method and no param', async () => {
    // REQ-1309's anti-enumeration technique. A hard-coded list is a drift
    // generator the next contract change has to come back and edit.
    const { wireEncoding } = await wireShapeModule();
    const src = readFileSync(join(__dirname, 'wireShape.ts'), 'utf8');
    const start = src.indexOf('export function wireEncoding');
    expect(start, 'the derivation is one named, readable function').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).not.toMatch(/\b(stylePatch|setPosition|setText|setAutoLayout|setConstraints|artboard|screenshot|patch|props|pos|input|id)\b/);

    // …and it is genuinely derived: a manifest this suite has never seen yields
    // its own wire listing, with no edit anywhere.
    const derived = wireEncoding(
      { params: { alpha: { type: 'string', required: true }, beta: { type: 'object', required: false, shape: { gamma: { type: 'number', required: false } } } } },
      'novel.thing',
    );
    expect(derived.callAs).toBe('novel.thing(alpha, betaContents)');
    expect(derived.args.map((a: any) => a.name)).toEqual(['alpha', 'beta']);
    expect(derived.args[1].contents).toEqual(['gamma']);
  });

  it('wire does not shadow or collide with stringJsonParams — both coexist, and say different things', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'create' });
    // REQ-1318's key, unchanged and still exact.
    expect(payload.stringJsonParams).toEqual(['props']);
    // REQ-1295's key, additive and separate.
    expect(payload.wire).toBeDefined();
    expect(payload.wire.args.map((a: any) => a.name)).toEqual(['kind', 'props']);
    // An array param is not an object param, so it carries no object-slot clause.
    const batch = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'batch' });
    expect(batch.stringJsonParams).toEqual(['ops']);
    expect(batch.wire.args[0]).toMatchObject({ index: 0, name: 'ops', type: 'array' });
    expect(batch.wire.args[0].contents).toBeUndefined();
    expect(batch.wire.args[0].notThis).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────── AC-3 ──

describe('REQ-1295 AC-3 — the error names the mistake, not a style key', () => {
  it('every one of the brief\'s five message requirements holds, on the compact lane', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'stylePatch', args: WRAPPER_ARGS });
    const message = String(result.message ?? '');

    // (1) name what arrived — the position, and that an object keyed `patch` did.
    expect(message).toMatch(/args\[1\]/);
    expect(message).toMatch(/"patch"/);
    // (2) name the mistake — the declared wrapper was sent instead of contents.
    expect(message).toMatch(/declaration|wrapper/i);
    expect(message).toMatch(/instead of/i);
    // (3) say what to send instead — the contents, flat.
    expect(message).toMatch(/contents/i);
    expect(message).toMatch(/flat/i);
    // (4) never claim a style key is invalid. This is the one requirement a
    // "helpful append" silently breaks, so it is pinned as an ABSENCE.
    expect(message).not.toMatch(/unsupported style key/i);
    expect(message).not.toMatch(/unsupported_style_key/i);
    // (5) …and the message is the relay's own pre-flight code, so the editor's
    // rejection is never reasserted over the top of it.
    expect(result.code).toBe('invalid_params');
  });

  it('the refusal is the SAME message in full mode, where the position is named the way that lane names it', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'full');
    const result = await callToolJson(client, 'layer_stylePatch', { id: 'L1', patch: { patch: { fill: '#12395C' } } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    // Full mode's convention is the bare param name: the caller wrote
    // `{id, patch}`, not `args[1]`.
    expect(String(result.message)).toMatch(/patch/);
    expect(String(result.message)).not.toMatch(/unsupported style key/i);
  });

  it('a RELAYED unsupported_style_key gains the wrapper explanation while KEEPING the editor\'s own code and message', async () => {
    // Belt-and-braces half: a shape the pre-flight cannot classify must still
    // reach the agent as an answer that names the mistake. A legacy free-text
    // manifest is the cleanest such shape — this server has no schemas at all,
    // so there is nothing to derive a wrapper signature from and the call is
    // forwarded, exactly as a nested batch op's wrapper is.
    const { stub, captured } = makeStub({ deliverManifest: LEGACY_MANIFEST });
    const client = await connect(stub, 'compact', { prefetchedManifest: LEGACY_MANIFEST });
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'stylePatch', args: WRAPPER_ARGS });

    // The tab really did answer, and this server did not rewrite it.
    expect(captured, 'with no schemas the payload is forwarded').toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.code, "the editor's own code is preserved, never replaced").toBe('unsupported_style_key');
    expect(String(result.message)).toMatch(/unsupported style key "patch"/);

    // …and the missing next step is appended: what arrived, what to send, why.
    const message = String(result.message);
    expect(message, 'the appended half names the wrapper').toMatch(/declaration|wrapper/i);
    expect(message, 'the appended half names the contents as the remedy').toMatch(/contents/i);
    // Idempotent: a message that already carries the explanation is untouched.
    const again = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'stylePatch', args: WRAPPER_ARGS });
    expect(again.message).toBe(message);
  });

  it('the rule must not fire on anything the editor accepts — five shapes, all forwarded', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const accepted: Array<[string, string, unknown[]]> = [
      // (a) the legal single-object whole-`args` wrapper — the editor expands it.
      ['layer', 'stylePatch', WHOLE_ARGS_WRAPPER],
      // (b) the flat contents in their own slot — the form the docs teach.
      ['layer', 'stylePatch', FLAT_ARGS],
      // (c) a single-positional-argument call can never be unexpandable, so an
      //     object param that IS the whole of args is not a wrapper either.
      ['canvas', 'screenshot', [{ pixelRatio: 2 }]],
      // (d) a method with no object param at all has nothing to confuse.
      ['layer', 'setName', ['L1', 'hero']],
      // (e) a non-object value at an object slot is somebody else's rule.
      ['layer', 'stylePatch', ['L1', 'not an object']],
    ];
    let expectedTrips = 0;
    for (const [group, method, args] of accepted) {
      const result = await callToolJson(client, 'figpea_call', { group, method, args });
      expect(result.ok, `${group}.${method} ${JSON.stringify(args)} reaches the tab`).toBe(true);
      expect(captured.length, `${group}.${method} was forwarded, not refused`).toBe(expectedTrips + 1);
      expectedTrips++;
    }
    expect(captured, 'every accepted form cost exactly one round trip').toHaveLength(accepted.length);

    // An unknown method is the tab's error to name: this server has no
    // `inputKeys` for it, and guessing one would reject a call for a more
    // fundamental reason than any rule here.
    await callToolJson(client, 'figpea_call', { group: 'layer', method: 'noSuchMethod', args: ['L1', { patch: { fill: '#1' } }] });
    expect(captured.length).toBe(accepted.length + 1);
  });

  it('the wrapper rule answers BEFORE the per-kind rule — the same mistake must not get two messages', async () => {
    // REQ-1309's rule would answer a wrapped `props` as `invalid_transform`,
    // naming the wrapper key as an INAPPLICABLE PROP: the same misleading-error
    // class this REQ exists to remove, one rule earlier.
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['text', { props: { text: 'hi' } }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe('invalid_transform');
    expect(String(result.message)).toMatch(/args\[1\]/);

    // …and the per-kind rule still owns its OWN mistake, untouched.
    const perKind = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['text', { rwidth: 100 }],
    });
    expect(perKind.code).toBe('invalid_transform');
  });

  it('the pure rule is scoped: it declines rather than guesses on all seven shapes', async () => {
    const { findDeclaredWrapperMismatch } = await argShapeModule();
    const schemas = {
      id: { type: 'string', required: true },
      patch: { type: 'object', required: true, shape: STYLE_PATCH_SHAPE },
    };
    const pathFor = (name: string) => `args[${name === 'id' ? 0 : 1}]`;

    // Fires: the declared wrapper at a two-positional-argument call.
    const fired = findDeclaredWrapperMismatch(schemas, { id: 'L1', patch: { patch: { fill: '#1' } } }, pathFor, 2);
    expect(fired, 'the declared wrapper is detected').toBeDefined();
    expect(fired.path).toBe('args[1]');
    expect(fired.got).toMatch(/"patch"/);

    // Declines: one argument — the editor may still expand it.
    expect(findDeclaredWrapperMismatch(schemas, { id: 'L1', patch: { patch: { fill: '#1' } } }, pathFor, 1)).toBeUndefined();
    // Declines: no declared schemas at all (a legacy manifest).
    expect(findDeclaredWrapperMismatch(undefined, { patch: { patch: { fill: '#1' } } }, pathFor, 2)).toBeUndefined();
    // Declines: an object param with NO declared shape — nothing to tell the two
    // readings apart, so the tab's answer is the one that counts.
    expect(
      findDeclaredWrapperMismatch({ patch: { type: 'object', required: true } }, { patch: { patch: { a: 1 } } }, pathFor, 2),
    ).toBeUndefined();
    // Declines: a value whose keys ARE legal contents.
    expect(
      findDeclaredWrapperMismatch(schemas, { id: 'L1', patch: { fill: '#1', id: 'L1' } }, pathFor, 2),
    ).toBeUndefined();
    // Declines: a value that is not an object.
    expect(findDeclaredWrapperMismatch(schemas, { id: 'L1', patch: 'nope' }, pathFor, 2)).toBeUndefined();
    // Declines: an object whose keys are NOT declared param names — some other
    // object's contents, sent at the wrong slot; naming that is the tab's job.
    expect(
      findDeclaredWrapperMismatch(schemas, { id: 'L1', patch: { somethingElse: { fill: '#1' } } }, pathFor, 2),
    ).toBeUndefined();
    // Declines: an exhausted budget.
    expect(
      findDeclaredWrapperMismatch(schemas, { id: 'L1', patch: { patch: { fill: '#1' } } }, pathFor, 2, { nodes: 99999 }),
    ).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────── AC-4 ──

describe('REQ-1295 AC-4 — every method carries the statement, present and future', () => {
  /** The card's eight, verbatim. Two of them carry no object param at all
   *  (`setText`'s second argument is a `string`, `canvas.screenshot`'s is its
   *  only parameter) and both still carry the statement. */
  const NAMED_EIGHT = [
    ['layer', 'stylePatch'],
    ['layer', 'setPosition'],
    ['layer', 'setText'],
    ['layer', 'create'],
    ['layer', 'setAutoLayout'],
    ['layer', 'setConstraints'],
    ['canvas', 'screenshot'],
    ['export', 'artboard'],
  ] as const;

  it('all eight named methods state the encoding on figpea_describe', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    for (const [group, method] of NAMED_EIGHT) {
      const payload = await callToolJson(client, 'figpea_describe', { group, method });
      expect(payload.ok, `${group}.${method} describes`).toBe(true);
      expect(payload.wire, `${group}.${method} states the encoding`).toBeDefined();
      expect(payload.wire.encoding, `${group}.${method}`).toBe('positional');
      expect(payload.wire.callAs, `${group}.${method} shows the call form`).toBe(
        `${group}.${method}(${payload.wire.args.map((a: any) => a.name + (a.contents ? 'Contents' : '')).join(', ')})`,
      );
      expect(payload.wire.args.length, `${group}.${method} lists every declared slot`).toBe(
        Object.keys((MANIFEST[group] as any)[method].params).length,
      );
    }
  });

  it('no method in the manifest with a declared object param lacks the statement — a sweep, not a list', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    let checked = 0;
    for (const [group, methods] of Object.entries(MANIFEST)) {
      for (const method of Object.keys(methods)) {
        const params = (methods as any)[method].params ?? {};
        const declaresObject = Object.values(params).some((s: any) => s && typeof s === 'object' && s.type === 'object');
        if (!declaresObject) continue;
        checked++;
        const payload = await callToolJson(client, 'figpea_describe', { group, method });
        expect(payload.wire, `${group}.${method} declares an object param`).toBeDefined();
        const objectArgs = payload.wire.args.filter((a: any) => a.type === 'object');
        for (const arg of objectArgs) {
          expect(arg.contents, `${group}.${method}.${arg.name} lists its legal contents`).toEqual(
            Object.keys((params[arg.name].shape ?? {}) as Record<string, unknown>),
          );
          expect(arg.notThis, `${group}.${method}.${arg.name} names the envelope not to send`).toBe(`{ "${arg.name}": { … } }`);
        }
      }
    }
    // The sweep is only evidence if it actually swept.
    expect(checked, 'the sweep found the object-param methods').toBeGreaterThanOrEqual(6);
  });

  it('the object-slot clause appears where, and only where, the slot IS an object', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    // `setText`'s second argument is a declared string — no object, no envelope.
    const setText = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'setText' });
    expect(setText.wire.callAs).toBe('layer.setText(id, text)');
    expect(setText.wire.args[1].contents).toBeUndefined();
    expect(setText.wire.args[1].notThis).toBeUndefined();
    // …but it still states the encoding, which is the AC-4 requirement.
    expect(setText.wire.note).toMatch(/POSITIONAL/i);

    // `canvas.screenshot`'s object is its ONLY parameter — one argument, so the
    // editor expands a wrapper there and nothing may be refused.
    const shot = await callToolJson(client, 'figpea_describe', { group: 'canvas', method: 'screenshot' });
    expect(shot.wire.callAs).toBe('canvas.screenshot(optionsContents)');
    expect(shot.wire.args[0].contents).toEqual(['id', 'pixelRatio']);
  });

  it('full mode\'s generated tool description states the mode-appropriate encoding — the lane with no describe tool', async () => {
    const tools = buildToolsFromManifest(MANIFEST);
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const [group, method] of NAMED_EIGHT) {
      const tool = byName.get(`${group}_${method}`);
      expect(tool, `${group}_${method} exists`).toBeDefined();
      const declaresObject = Object.values((MANIFEST[group] as any)[method].params).some(
        (s: any) => s && typeof s === 'object' && s.type === 'object',
      );
      if (!declaresObject) {
        // In full mode the parameters are NAMED keys and a declared string needs
        // no envelope lesson: the declaration and the payload agree, which is the
        // card's own line about methods that take scalars.
        expect(tool!.description).not.toMatch(/^Encoding:/m);
        continue;
      }
      const line = tool!.description.split('\n').find((l) => l.startsWith('Encoding:'));
      expect(line, `${group}_${method} states its encoding`).toBeDefined();
      // The lane-appropriate half: parameters are NAMED here.
      expect(line).toMatch(/NAMED/);
      // …and an object takes its CONTENTS under its own key, never a second copy.
      expect(line).toMatch(/CONTENTS/);
      const objectParam = Object.entries((MANIFEST[group] as any)[method].params).find(
        ([, s]: [string, any]) => s && typeof s === 'object' && s.type === 'object',
      )![0];
      expect(line, `${group}_${method} names its own object param`).toContain(objectParam);
    }
  });

  it('the full-mode line is DERIVED, so a method nobody enumerated carries it too', () => {
    const tools = buildToolsFromManifest({
      novel: {
        invention: {
          doc: 'Does a thing.',
          params: { handle: { type: 'string', required: true }, payload: { type: 'object', required: true, shape: { alpha: { type: 'number', required: false } } } },
          result: 'void',
        },
      },
    } as unknown as ManifestLike);
    const line = tools[0]!.description.split('\n').find((l) => l.startsWith('Encoding:'));
    expect(line, 'a method this suite has never seen carries the statement').toBeDefined();
    expect(line).toContain('payload');
    // The doubled-key counter-example, derived from the param's own first shape key.
    expect(line).toMatch(/"payload":\s*\{\s*"payload"/);
  });
});

// ── the one derived helper, pinned from both sides at once ──────────────────

describe('REQ-1295 — the two lanes cannot disagree, because they share one derivation', () => {
  it('every describe wire listing agrees with the full-mode description line, method for method', async () => {
    const tools = new Map(buildToolsFromManifest(MANIFEST).map((t) => [t.name, t]));
    const { wireEncoding } = await wireShapeModule();
    for (const [group, methods] of Object.entries(MANIFEST)) {
      for (const [method, descriptor] of Object.entries(methods)) {
        const wire = wireEncoding(descriptor as any, `${group}.${method}`);
        if (!wire) continue;
        const line = tools.get(`${group}_${method}`)!.description.split('\n').find((l) => l.startsWith('Encoding:'));
        const objectArgs = wire.args.filter((a: { contents?: string[] }) => a.contents !== undefined);
        // Present in full mode iff there is an object param to warn about — the
        // one rule, computed twice.
        expect(line !== undefined, `${group}_${method}`).toBe(objectArgs.length > 0);
        for (const arg of objectArgs) {
          expect(line, `${group}_${method} names ${arg.name}`).toContain(arg.name);
        }
      }
    }
  });
});