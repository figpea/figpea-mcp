import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMcpServer } from './mcpServer';
import type { ManifestLike } from './tools';

/**
 * REQ-1280 — `_rawJson` is declared on `figpea_call` (the ONLY tool compact
 * mode registers) and never honoured.
 *
 * The incident (card REQ-1280, found by `/design` on
 * `designs/runs/2026-09-26-tessera-api-docs`): a compact-mode agent set the
 * documented escape hatch for a stringified `props` object and got the
 * editor's own rejection back — `create(): props must be object (got string)` —
 * with nothing connecting the error to the flag it had set. One run's ~775
 * elements became ~600 sequential round trips instead of ~200, because the
 * flag that was supposed to rescue `layer.batch` and `create(transform)` is
 * stripped-and-ignored on the default dispatcher.
 *
 * Vehicle: this repo has no Playwright lane, so "e2e" is a real MCP SDK
 * `Client` over `InMemoryTransport` driving the real server — a genuine
 * `registerTool` → `safeParseAsync` → handler → `callTab` round trip, with a
 * **stub tab** standing in for the paired editor. The stub applies v3's real
 * `validateArgs` rule (`v3/src/agent/validateArgs.ts:48-70, 166`) to the
 * declared fixture schema, so the AC-1 repro is deterministic in CI rather
 * than a claim about a live tab, and it captures the exact positional array
 * the tab would receive — the thing every AC here is about.
 *
 * AC map (see `docs/plans/REQ-1280-6ab85e20.md` §Use cases → task → test):
 *  - AC-1  deterministic repro, carried in BOTH directions: the unflagged call
 *          still returns the editor's envelope verbatim (so the repro stays
 *          runnable cold, forever), and the flagged one no longer does
 *  - AC-2  the stringified `props` arrives at the tab as a real object
 *  - AC-3  a nested `transform` array survives as a real 6-number matrix
 *  - AC-4  a `layer.batch` ops array sent as one JSON string arrives as a real
 *          array, complete and in order, in a single `callTab`
 *  - AC-5  with no flag, behaviour is byte-identical to today
 *  - AC-6  `_rawJson:false`/absent is a no-op, and the flag can never be
 *          forwarded at any depth
 *  - AC-7  compact and full produce deep-equal positional args for the same
 *          input, and agree on the loud failure
 *  - AC-8  loud where the schema proves a structured value was intended;
 *          unchanged (and NOT an error) at a `string` position or with no
 *          manifest; loud when `args` is not an array
 *  - AC-9  the three flag behaviours, stated as their own AC
 *
 * RED on the unfixed worktree: the compact handler reads `args` verbatim and
 * never consults the flag, so every flagged test below fails with either the
 * captured arg still being a string or the editor's own `invalid_params`
 * envelope coming back after a wasted round trip.
 */

// ── fixture manifest ────────────────────────────────────────────────────────
// Purpose-built, in the REQ-1268 fixture's shape: `layer.create` (`kind`
// string, `props` object carrying CREATE_COMMON_FIELDS including a `matrix`
// `transform`, per v3/src/agent/createSchema.ts:87-91), `layer.batch` (`ops`:
// array of `{method, args}`), `layer.setName` (`name`: **string** — the
// round-1 guard row) and `layer.setTransform` (`matrix`).

const MANIFEST = {
  layer: {
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'text', 'image'] },
        props: {
          type: 'object',
          required: false,
          shape: {
            name: { type: 'string', required: false },
            pageWidth: { type: 'number', required: false },
            pageHeight: { type: 'number', required: false },
            rwidth: { type: 'number', required: false },
            rheight: { type: 'number', required: false },
            parentId: { type: 'string', required: false },
            url: { type: 'string', required: false },
            filePath: { type: 'string', required: false },
            transform: { type: 'matrix', required: false },
          },
        },
      },
      result: { id: 'string', name: 'string (stored layer name; absent when unnamed)' },
    },
    batch: {
      doc: 'Applies a sequence of layer ops as ONE undo step, all-or-nothing.',
      params: {
        ops: {
          type: 'array',
          required: true,
          of: {
            type: 'object',
            required: true,
            shape: {
              method: { type: 'string', required: true },
              args: { type: 'array', required: true },
            },
          },
        },
      },
      result: { results: 'OpResult[]' },
    },
    setName: {
      doc: 'Renames a layer or page by id.',
      params: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      result: 'void',
    },
    setTransform: {
      doc: 'Sets a layer transform matrix.',
      params: {
        id: { type: 'string', required: true },
        matrix: { type: 'matrix', required: true },
      },
      result: 'void',
    },
  },
  session: {
    openFile: {
      doc: 'Opens a file in the editor.',
      params: {
        input: {
          type: 'object',
          required: true,
          shape: {
            url: { type: 'string', required: false },
            filePath: { type: 'string', required: false },
          },
        },
      },
      result: 'void',
    },
  },
} as unknown as ManifestLike;

/**
 * REQ-1338 AC-4(b) — a LEGACY free-text manifest, the one "no schema is
 * available" state that is NOT the same code path as "no manifest at all".
 *
 * Here every `params` value is a hint STRING, so `buildParamSchemas`
 * (`tools.ts`) carries nothing structured through and returns `undefined`:
 * a lane that *has* a tool, whose every position nonetheless has no declared
 * type. This is the state a pre-REQ-093 manifest leaves behind, and it is the
 * row a schema-guarded parse would silently break into a manifest-dependent
 * flag — the flag has to keep parsing here, because there is nothing to scope
 * a parse to.
 */
const LEGACY_MANIFEST = {
  layer: {
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: 'the kind of layer to create, e.g. "page", "rect", "text" or "image"',
        props: 'an object of properties for the new layer',
      },
      result: 'the new layer id',
    },
    setName: {
      doc: 'Renames a layer or page by id.',
      params: {
        id: 'the id of the layer or page to rename',
        name: 'the new name',
      },
      result: 'nothing',
    },
  },
} as unknown as ManifestLike;

// ── the stub tab: v3's real answer, not a plausible one ────────────────────

/** v3's `receivedTypeName` (validateArgs.ts:35-45), verbatim in behaviour. */
function receivedTypeName(v: unknown): string {
  if (Array.isArray(v) || v instanceof ArrayBuffer) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/** v3's `matchesDeclaredType` (validateArgs.ts:48-70) for the top-level types
 *  this fixture declares. */
function matchesDeclaredType(declared: string, v: unknown): boolean {
  switch (declared) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array':
    case 'matrix':
      return Array.isArray(v);
    default:
      return true;
  }
}

/** The fixture's declared positional types, in declaration order — keyed by the
 *  BARE method name, because `callTab(group, method, args)` receives `method`
 *  without its group prefix on BOTH paths (mcpServer.ts:747 and :1145). */
const DECLARED: Record<string, Record<string, string>> = {
  create: { kind: 'string', props: 'object' },
  batch: { ops: 'array' },
  setName: { id: 'string', name: 'string' },
  setTransform: { id: 'string', matrix: 'matrix' },
  openFile: { input: 'object' },
};

/** v3's `validateArgs` (validateArgs.ts:154-170): the FIRST positional arg
 *  that does not match its declared type is rejected with exactly
 *  `${methodName}(): ${key} must be ${declared} (got ${receivedTypeName(arg)})`
 *  and code `invalid_params`. That string is AC-1's. */
function editorRejection(method: string, args: unknown[]): { ok: false; code: string; message: string } | undefined {
  const declared = DECLARED[method];
  if (!declared) return undefined;
  const keys = Object.keys(declared);
  for (let i = 0; i < args.length; i++) {
    const key = keys[i];
    if (key === undefined) break;
    const arg = args[i];
    if (arg === undefined) continue;
    if (!matchesDeclaredType(declared[key]!, arg)) {
      return {
        ok: false,
        code: 'invalid_params',
        message: `${method}(): ${key} must be ${declared[key]} (got ${receivedTypeName(arg)})`,
      };
    }
  }
  return undefined;
}

/** A successful editor answer that ECHOES what it was given, so "the tab
 *  received a real object" is never satisfiable by a stub that ignores its
 *  input. */
function editorSuccess(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'create': {
      const props = args[1] as Record<string, unknown> | undefined;
      return { id: 'L_probe', name: props?.name, ...(props?.transform ? { transform: props.transform } : {}) };
    }
    case 'batch': {
      const ops = args[0] as Array<{ method: string }>;
      return { results: ops.map((op, i) => ({ opIndex: i, ok: true, value: { id: `L_${op.method}_${i}` } })) };
    }
    case 'setTransform':
      return { id: args[0], matrix: args[1] };
    default:
      return null;
  }
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
    token: 'test-token-1280',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      if (deliver !== undefined) h(deliver);
    },
    callTab: async (group: string, method: string, args: unknown[]) => {
      captured.push({ group, method, args: structuredClone(args) });
      return editorRejection(method, args) ?? { ok: true, value: editorSuccess(method, args) };
    },
    close: async () => {},
  };
  return { stub, captured };
}

let cleanup: Array<() => Promise<void>> = [];
let tempDirs: string[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

type Mode = 'compact' | 'full';

async function connect(bridge: unknown, mode: Mode) {
  const server = createMcpServer(bridge as never, { toolMode: mode } as never);
  const client = new Client({ name: 'req-1280-test', version: '0.0.0' });
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
    // A handler that throws (or a tool the SDK could not route) reaches the
    // client as plain text. Surface it as an envelope so the failure reads as
    // the defect it is instead of a JSON parse error in the helper.
    return { ok: false, code: 'non_envelope', message: text };
  }
  return JSON.parse(text);
}

/** True if `key` appears as an own key anywhere in the payload, at any depth. */
function hasKeyAtAnyDepth(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((el) => hasKeyAtAnyDepth(el, key));
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(rec, key)) return true;
    return Object.values(rec).some((v) => hasKeyAtAnyDepth(v, key));
  }
  return false;
}

function tempImageFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1280-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'probe.png');
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return file;
}

/** The editor's answer to a `props` string at a position declared `object`,
 *  quoted verbatim by AC-1 and reproduced from v3's `validateArgs`
 *  (validateArgs.ts:166) + `layer.create`'s `props: {type:"object"}` decl
 *  (layer.descriptor.ts:103). */
const AC1_REPRO_MESSAGE = 'create(): props must be object (got string)';

/** A JSON-looking string that is NOT valid JSON — starts `{`/ends `}` (or
 *  `[`/`]`) so the escape hatch engages, then fails to parse. */
const BROKEN_OBJECT = '{name: "probe"}';
const BROKEN_ARRAY = '[5,0,zz,0,0,0]';
/** The round-1 guard row: a `string`-declared parameter whose value is
 *  bracket-wrapped but not valid JSON. Works today, and must keep working. */
const LEGIT_STRING = '[Hero]';

// ───────────────────────────────────────────────────── AC-1 / AC-2 / AC-9 ──

describe('REQ-1280 AC-1 — the deterministic repro, in both directions', () => {
  // ⛔ SUPERSEDED IN PLACE by REQ-1318 (AC-6). This assertion previously read
  // "without the flag the editor answer is relayed verbatim" and pinned
  // REQ-1280 AC-5's user-approved "the fix is opt-in only". REQ-1318 makes that
  // sentence FALSE by design: `props` is declared `object`, so a JSON-looking
  // string at that position is now PARSED WITHOUT THE FLAG — schema-scoped,
  // which is what makes the default safe, and unlike this REQ's flag it also
  // refuses to touch a position no declaration reaches (REQ-1338).
  // The same payload now SUCCEEDS with no flag, and the tab receives a real
  // object. The assertion is REPLACED, not deleted, skipped or relaxed: the
  // editor-answer relay it asserted is still tested below through the
  // no-manifest row, and the full REQ-1318 contract lives in
  // req1318StringJson.test.ts. Nothing here was turned into `expect(true)`.
  it('without the flag the same payload now succeeds — the editor answer is never bought', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
    });
    expect(result.ok).toBe(true);
    // The payload the tab receives is byte-equal to the flagged row's below —
    // that is the whole contract of the supersession: two spellings, one
    // forwarded value, and no round trip spent learning it.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toEqual({ name: 'probe', pageWidth: 300, pageHeight: 200 });
    expect(result.value).toEqual({ id: 'L_probe', name: 'probe' });
  });

  it('the editor answer is still relayed verbatim when the server has no declaration to reason from', async () => {
    // The relay behaviour the superseded row above asserted, kept where it is
    // still true: with NO manifest there is nothing saying `props` should have
    // been structured, so the server takes no opinion and the tab's own
    // `props must be object (got string)` is relayed after the round trip.
    const { stub, captured } = makeStub({ deliverManifest: undefined });
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
    });
    // The envelope REQ-1280 AC-1 quotes, produced by the tab and relayed. The
    // relayed message carries REQ-1268's shape-hint suffix on top of the tab's
    // own answer (already pinned by req1268.test.ts), so AC-1's string is
    // asserted as the prefix it is — the tab's verbatim answer, unaltered.
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    expect(result.message).toContain(AC1_REPRO_MESSAGE);
    expect(result.message.startsWith(AC1_REPRO_MESSAGE)).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toBe('{"name":"probe","pageWidth":300,"pageHeight":200}');
  });

  it('AC-1/AC-2/AC-9 — with the flag the very same call succeeds and the tab receives a real object', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
      _rawJson: true,
    });
    expect(result.ok).toBe(true);
    // Parsed BEFORE the round trip: the captured arg is a real object…
    expect(captured).toHaveLength(1);
    const props = captured[0]!.args[1];
    expect(typeof props).toBe('object');
    expect(Array.isArray(props)).toBe(false);
    expect(props).toEqual({ name: 'probe', pageWidth: 300, pageHeight: 200 });
    // …and the numbers are REAL numbers, not strings the tab would reject.
    expect((props as any).pageWidth).toBe(300);
    expect(typeof (props as any).pageWidth).toBe('number');
    // The stub echoes what it received, so the tab's own answer carries the
    // parsed name too — the assertion cannot be satisfied by an ignoring stub.
    expect(result.value).toEqual({ id: 'L_probe', name: 'probe' });
  });
});

// ───────────────────────────────────────────────────────────────────── AC-3 ──

describe('REQ-1280 AC-3 — a nested array survives the flag', () => {
  it('create(transform) arrives as a real 6-number matrix and is read back as one', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['rect', '{"parentId":"P1","rwidth":100,"rheight":50,"transform":[1,0,0,1,0,0]}'],
      _rawJson: true,
    });
    expect(result.ok).toBe(true);
    const props = captured[0]!.args[1] as any;
    expect(props.parentId).toBe('P1');
    expect(props.rwidth).toBe(100);
    expect(props.rheight).toBe(50);
    // The nested array inside the stringified object is a real 6-number matrix.
    expect(Array.isArray(props.transform)).toBe(true);
    expect(props.transform).toHaveLength(6);
    expect(props.transform.every((n: unknown) => typeof n === 'number')).toBe(true);
    // "read back" is the tab's read: the stub echoes the value it received.
    expect(result.value.transform).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

// ───────────────────────────────────────────────────────────────────── AC-4 ──

describe('REQ-1280 AC-4 — a layer.batch ops array sent as one JSON string applies as one call', () => {
  it('the whole batch arrives as a real, complete, ordered array in ONE callTab', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const ops = [
      { method: 'create', args: ['page', { name: 'p1', pageWidth: 300, pageHeight: 200 }] },
      { method: 'create', args: ['rect', { parentId: 'P1', rwidth: 100, rheight: 50 }] },
      { method: 'setName', args: ['L_rect', 'hero'] },
    ];
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [JSON.stringify(ops)],
      _rawJson: true,
    });
    expect(result.ok).toBe(true);
    // The batch is delivered whole in a SINGLE callTab — this REQ's half of
    // "one undo step": the editor can only make the batch atomic if it
    // receives the complete ops array in one call.
    expect(captured).toHaveLength(1);
    const received = captured[0]!.args[0];
    expect(Array.isArray(received)).toBe(true);
    // Not a `{"item": …}` envelope, not a string.
    expect(received).not.toBe('{"item":…}');
    const list = received as Array<{ method: string; args: unknown[] }>;
    expect(list).toHaveLength(ops.length);
    for (const op of list) {
      expect(typeof op.method).toBe('string');
      expect(Array.isArray(op.args)).toBe(true);
    }
    // Complete and in order — nothing dropped or reordered by the parse.
    expect(list.map((op) => op.method)).toEqual(['create', 'create', 'setName']);
    expect(list[1]!.args[1]).toEqual({ parentId: 'P1', rwidth: 100, rheight: 50 });
    // The tab applied all three, in order.
    expect(result.value.results).toHaveLength(3);
    expect(result.value.results.map((r: any) => r.opIndex)).toEqual([0, 1, 2]);
  });
});

// ───────────────────────────────────────────────────────────────────── AC-5 ──

// ⛔ AC-5's HEADLINE IS SUPERSEDED by REQ-1318 (AC-6); this row is replaced in
// place. "Without the flag behaviour is byte-identical to today… the fix is
// opt-in only" was user-approved and true when REQ-1280 shipped. REQ-1318's
// whole point is to reverse it for the SCHEMA-DECLARED positions: a structured
// param may now travel as a JSON string with no flag, so the two spellings
// agree. The flag itself is untouched — still present, still opt-in, still the
// route for a position with no declaration to reason from. (REQ-1338 closed the
// flag's parse-scoping residual: it now asks the declaration where one is
// reachable, which is why at a declared scalar it does nothing the default
// does not already do. What is left that is unique to the flag is the position
// nothing declares.) So the row is REPLACED with the stronger guarantee, not
// deleted, skipped or weakened.
describe('REQ-1280 AC-5 — superseded by REQ-1318 AC-6: the flag-less route is now equivalent, not inert', () => {
  it('absent and _rawJson:false are indistinguishable, and both deliver a real object', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const withoutFlag = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
    });
    const withFalse = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
      _rawJson: false,
    });
    // `false` is still a no-op, so the two envelopes are the same result…
    expect(withFalse).toEqual(withoutFlag);
    // …and the new flag-less default is STRICTLY STRONGER than the old one was:
    // not "the same failure twice", but one success reached two spellings.
    expect(withoutFlag.ok).toBe(true);
    // The tab received a real object in both cases, never the string.
    expect(captured).toHaveLength(2);
    expect(captured.every((c) => typeof c.args[1] === 'object' && c.args[1] !== null)).toBe(true);
    expect(captured[0]!.args[1]).toEqual({ name: 'probe', pageWidth: 300, pageHeight: 200 });
    expect(captured[1]!.args[1]).toEqual(captured[0]!.args[1]);
  });

  it('the flag remains the route for a position with NO declaration to reason from', async () => {
    // The scope that keeps `_rawJson` alive and opt-in, now stated positively
    // rather than as an accident: with no manifest the schema-scoped route
    // cannot know `props` should have been structured, so this call's outcome
    // still depends on the flag. The pinned relay behaviour survives here.
    const { stub, captured } = makeStub({ deliverManifest: undefined });
    const client = await connect(stub, 'compact');
    const withoutFlag = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
    });
    expect(withoutFlag.code).toBe('invalid_params');
    expect(withoutFlag.message).toContain(AC1_REPRO_MESSAGE);
    expect(captured[0]!.args[1]).toBe('{"name":"probe","pageWidth":300,"pageHeight":200}');
    // With the flag, the parse is what rescues it — unchanged: with no manifest
    // in memory there is no declaration to scope to, so the flag parses
    // (REQ-1338's predicate returns true for an absent schema, which is exactly
    // what keeps the flag off the manifest's neck).
    const withFlag = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
      _rawJson: true,
    });
    expect(withFlag.ok).toBe(true);
    expect(captured[1]!.args[1]).toEqual({ name: 'probe', pageWidth: 300, pageHeight: 200 });
  });

  it('a legitimate props object with the flag absent is forwarded untouched', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const props = { name: 'probe', pageWidth: 300, pageHeight: 200 };
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'create', args: ['page', props] });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args).toEqual(['page', props]);
  });
});

// ───────────────────────────────────────────────────────────────────── AC-6 ──

describe('REQ-1280 AC-6 — _rawJson:false/absent is a no-op and never leaks', () => {
  it('the flag never appears in the forwarded positional args, at any depth', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const ops = [{ method: 'create', args: ['rect', { parentId: 'P1', rwidth: 10, rheight: 5 }] }];
    await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
      _rawJson: true,
    });
    await callToolJson(client, 'figpea_call', { group: 'layer', method: 'batch', args: [JSON.stringify(ops)], _rawJson: '1' });
    await callToolJson(client, 'figpea_call', { group: 'layer', method: 'create', args: ['page', { name: 'x' }], _rawJson: false });
    expect(captured.length).toBeGreaterThanOrEqual(3);
    for (const call of captured) {
      expect(hasKeyAtAnyDepth(call.args, '_rawJson'), `leaked into ${call.method}`).toBe(false);
    }
  });

  it('args.length is unchanged by the flag\'s presence', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const args = ['page', { name: 'probe', pageWidth: 300, pageHeight: 200 }];
    await callToolJson(client, 'figpea_call', { group: 'layer', method: 'create', args });
    await callToolJson(client, 'figpea_call', { group: 'layer', method: 'create', args, _rawJson: true });
    expect(captured).toHaveLength(2);
    expect(captured[0]!.args).toHaveLength(2);
    expect(captured[1]!.args).toHaveLength(2);
    expect(captured[0]!.args).toEqual(captured[1]!.args);
  });
});

// ───────────────────────────────────────────────────────────────────── AC-7 ──

describe('REQ-1280 AC-7 — compact and full cannot drift', () => {
  it('the same stringified object produces deep-equal positional args on both paths', async () => {
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
      _rawJson: true,
    });

    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    await callToolJson(fullClient, 'layer_create', {
      kind: 'page',
      props: '{"name":"probe","pageWidth":300,"pageHeight":200}',
      _rawJson: true,
    });

    expect(compactRun.captured[0]!.args).toEqual(fullRun.captured[0]!.args);
    expect(compactRun.captured[0]!.args).toEqual(['page', { name: 'probe', pageWidth: 300, pageHeight: 200 }]);
  });

  it('the same stringified array produces deep-equal positional args on both paths', async () => {
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'setTransform',
      args: ['L1', '[5,0,0,3.5,0,0]'],
      _rawJson: true,
    });

    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    await callToolJson(fullClient, 'layer_setTransform', { id: 'L1', matrix: '[5,0,0,3.5,0,0]', _rawJson: true });

    expect(compactRun.captured[0]!.args).toEqual(fullRun.captured[0]!.args);
    expect(compactRun.captured[0]!.args[1]).toEqual([5, 0, 0, 3.5, 0, 0]);
  });

  it('a value that fails to parse: both paths return the same code and the same _rawJson clause', async () => {
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'setTransform',
      args: ['L1', BROKEN_ARRAY],
      _rawJson: true,
    });

    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_setTransform', {
      id: 'L1',
      matrix: BROKEN_ARRAY,
      _rawJson: true,
    });

    expect(compactResult.code).toBe('invalid_params');
    expect(fullResult.code).toBe(compactResult.code);
    // Each names the flag and its own position…
    expect(compactResult.message).toContain('_rawJson');
    expect(fullResult.message).toContain('_rawJson');
    expect(compactResult.message).toContain('args[1]');
    expect(fullResult.message).toContain('matrix');
    // …and the guidance after the position is byte-equal, so the two writers
    // cannot disagree about what the agent should do next.
    const tail = (m: string) => m.slice(m.indexOf('could not be parsed as JSON'));
    expect(tail(compactResult.message)).toBe(tail(fullResult.message));
    // Neither path spends a round trip on a payload it already knows is broken.
    expect(compactRun.captured).toHaveLength(0);
    expect(fullRun.captured).toHaveLength(0);
  });

  it('guard row: a string-declared value that is not valid JSON still works on BOTH paths', async () => {
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', LEGIT_STRING],
      _rawJson: true,
    });

    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_setName', { id: 'L1', name: LEGIT_STRING, _rawJson: true });

    expect(compactResult.ok).toBe(true);
    expect(fullResult.ok).toBe(true);
    expect(compactRun.captured).toHaveLength(1);
    expect(fullRun.captured).toHaveLength(1);
    // Forwarded as the literal string it is — untouched, and not an error.
    expect(compactRun.captured[0]!.args[1]).toBe(LEGIT_STRING);
    expect(fullRun.captured[0]!.args[1]).toBe(LEGIT_STRING);
    expect(compactRun.captured[0]!.args).toEqual(fullRun.captured[0]!.args);
    expect(compactResult.message).toBeUndefined();
  });

  it('guard row: with NO manifest the flag still parses and never refuses (schema unknown ⇒ safe default)', async () => {
    const { stub, captured } = makeStub({ deliverManifest: undefined });
    const client = await connect(stub, 'compact');
    // No manifest at all: `contractToolFor` returns undefined, so no position
    // can be proven structured. A string-declared-looking value is untouched…
    const legit = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', LEGIT_STRING],
      _rawJson: true,
    });
    expect(legit.ok).toBe(true);
    expect(captured[0]!.args[1]).toBe(LEGIT_STRING);
    // …and a stringified object is still parsed, because with no declaration
    // reachable there is nothing to scope a parse to and the flag parses on its
    // own (that is what makes the flag usable on a first call).
    const parsed = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
      _rawJson: true,
    });
    expect(parsed.ok).toBe(true);
    expect(captured[1]!.args[1]).toEqual({ name: 'probe', pageWidth: 300, pageHeight: 200 });
  });
});

// ───────────────────────────────────────────────────────────────────── AC-8 ──

describe('REQ-1280 AC-8 — a flag that cannot apply fails loudly', () => {
  it('at a position the schema declares object: invalid_params naming _rawJson, at zero round trips', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', BROKEN_OBJECT],
      _rawJson: true,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    // Names the flag, the position, and that the value could not be parsed.
    expect(result.message).toContain('_rawJson');
    expect(result.message).toContain('props');
    expect(result.message).toContain('could not be parsed as JSON');
    // The agent's belief that the escape hatch was honoured is provably false,
    // so we say so for free — the tab is never asked.
    expect(captured).toHaveLength(0);
  });

  it('the same loud failure on a declared array position (layer.batch ops)', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: ['[{"method": "create", }]'],
      _rawJson: true,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    expect(result.message).toContain('_rawJson');
    expect(result.message).toContain('ops');
    expect(captured).toHaveLength(0);
  });

  it('at a string-declared position the same broken value is NOT an error — it is forwarded as the literal string', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', LEGIT_STRING],
      _rawJson: true,
    });
    // The complementary case, pinned as a non-error: a call that works today
    // must keep working, so a loud failure here would be a regression.
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toBe(LEGIT_STRING);
  });

  it('a declared string position holding VALID json is NOT parsed (REQ-1338 — polarity inverted)', async () => {
    // ⛔ POLARITY INVERTED BY REQ-1338, IN PLACE. This row used to read "a
    // residual, deliberately not fixed: a string position holding VALID json is
    // still parsed (documenting test)" — it existed precisely so that a
    // schema-guarded parse would FAIL it, and REQ-1338 is that guard. The
    // tripwire is kept and its polarity flipped rather than deleted or skipped:
    // the same file, the same position, the same role, now failing if the parse
    // ever stops being declaration-scoped. A delete would be indistinguishable
    // from a weakened assertion to the next reader (AC-6).
    //
    // PRE-FIX, kept here so the repro stays runnable cold: both paths returned
    // `{ok:false, code:'invalid_params', message:'setName(): name must be
    // string (got array)'}` and the tab had been sent ["L1",[1,2,3]] — the
    // parsed value, of a type the caller never chose.
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', '[1,2,3]'],
      _rawJson: true,
    });
    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_setName', { id: 'L1', name: '[1,2,3]', _rawJson: true });

    // Neither path refuses, and neither path converts the text: the layer is
    // named `[1,2,3]`, which is what the caller meant.
    expect(compactResult.ok).toBe(true);
    expect(fullResult.ok).toBe(true);
    expect(compactResult.message).toBeUndefined();
    expect(fullResult.message).toBeUndefined();
    expect(compactRun.captured[0]!.args[1]).toBe('[1,2,3]');
    expect(typeof compactRun.captured[0]!.args[1]).toBe('string');
    expect(fullRun.captured[0]!.args[1]).toBe('[1,2,3]');
    expect(typeof fullRun.captured[0]!.args[1]).toBe('string');
    // Byte-equal on the wire, so the two paths cannot drift on the fix either.
    expect(compactRun.captured[0]!.args).toEqual(fullRun.captured[0]!.args);
  });

  it('flag truthy with args present but not an array: a loud failure that names args', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group: 'layer', method: 'create', args: 'not-an-array', _rawJson: true },
    } as any);
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
    // Never silently ignored. VERIFIED (scratch dump of the real SDK): the
    // tool's own `z.array` shape (mcpServer.ts:566) rejects a non-array
    // before the handler runs, so the observable loud failure today is the
    // SDK's validation error naming `args`; the handler keeps its own
    // `_rawJson`-naming clause as the defensive second layer, because the card
    // puts the inputSchema shape out of scope.
    expect(result.isError === true || JSON.parse(text).ok === false).toBe(true);
    expect(text).toMatch(/args/);
    expect(text).toMatch(/expected array|args must be an array/);
    if (result.isError !== true) expect(text).toContain('_rawJson');
    expect(captured).toHaveLength(0);
  });
});

// ───────────────────────────────── REQ-1338 — a declared scalar is never parsed ──

/**
 * REQ-1338 — `_rawJson` must not rewrite a value a `string`-declared position
 * was given as text.
 *
 * REQ-1280 shipped the parse deliberately schema-blind and recorded the residue
 * as this follow-up by name (`rawJson.ts`'s own module header, boundary 2, said
 * so too). The defect: a position the manifest declares `string`/`number`/
 * `boolean`, holding text that happens to be VALID JSON, was converted into
 * real data and the editor then rejected it for being the wrong type — after
 * a round trip, with an error naming a type and nothing naming the flag the
 * caller had set.
 *
 * AC map (see `docs/plans/REQ-1338-6ab963e9.md` §Use cases → task → test):
 *  - AC-1  the repro, closed, on BOTH paths: `{ok:true}` and the literal
 *          `'[1,2,3]'` on the wire, asserted on the CAPTURED positional arg
 *          (so a stub that ignored its input could not satisfy it). The
 *          pre-fix envelope is quoted verbatim in the comment below so the
 *          repro stays runnable cold, in both directions.
 *  - AC-2  the same two calls with the flag ABSENT are unchanged — the fix is
 *          opt-in and cannot move unflagged behaviour on either path.
 *  - AC-3  every structured declared type still parses, on both paths.
 *  - AC-4  no schema available — compact before any `describe()`, a legacy
 *          free-text manifest, and (the same code path as the first) a disabled
 *          startup contract fetch — the flag still parses and still never
 *          refuses. A schema-guarded parse must NOT become a manifest-dependent
 *          flag.
 *  - AC-5  the loud-failure contract REQ-1280 shipped is untouched: a
 *          JSON-looking string that cannot be parsed at a STRUCTURED position
 *          is still refused by name at 0 round trips, byte-equal across both
 *          paths; the same value at a SCALAR position is still forwarded
 *          verbatim and is not an error.
 *  - AC-6  the test that used to DOCUMENT the schema-blind behaviour is
 *          inverted in place below, keeping its tripwire role.
 *
 * RED on the unfixed worktree: `applyRawJson` consults the declared schema
 * only to decide whether a FAILED parse is worth reporting, so every AC-1/AC-2
 * flagged row below fails with `setName(): name must be string (got array)`
 * and a captured `args[1]` that is `[1,2,3]` rather than the string.
 */
const JSON_LITERAL_NAME = '[1,2,3]';
/** The exact pre-fix envelope AC-1 records. Before the fix BOTH paths returned
 *  `{ok:false, code:'invalid_params', message:'setName(): name must be string
 *  (got array)'}` and the tab had been sent `["L1",[1,2,3]]` — a round trip
 *  spent on a value the caller never sent in that shape. */
const PRE_FIX_ENVELOPE_MESSAGE = 'setName(): name must be string (got array)';

describe('REQ-1338 AC-1/AC-2 — a declared string position is forwarded as the literal text', () => {
  it('compact, flag on: figpea_call({setName, ["L1","[1,2,3]"]}) returns ok:true and the tab receives the STRING', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', JSON_LITERAL_NAME],
      _rawJson: true,
    });
    // PRE-FIX, for the record and to keep the repro runnable cold: this call
    // returned `{ok:false, code:'invalid_params', message:
    // 'setName(): name must be string (got array)'}` after the tab had been
    // sent ["L1",[1,2,3]] — a type error that never mentioned the flag.
    expect(result.message).not.toBe(PRE_FIX_ENVELOPE_MESSAGE);
    expect(result.ok).toBe(true);
    // Asserted on the CAPTURED positional arg, not merely on the envelope: a
    // stub that ignored its input could not satisfy this, and neither could a
    // server that parsed the value and then happened to report success.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toBe(JSON_LITERAL_NAME);
    expect(typeof captured[0]!.args[1]).toBe('string');
    expect(Array.isArray(captured[0]!.args[1])).toBe(false);
    expect(captured[0]!.args).toEqual(['L1', JSON_LITERAL_NAME]);
  });

  it('full, flag on: layer_setName({name:"[1,2,3]", _rawJson:true}) returns ok:true and the tab receives the STRING', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const result = await callToolJson(client, 'layer_setName', { id: 'L1', name: JSON_LITERAL_NAME, _rawJson: true });
    expect(result.message).not.toBe(PRE_FIX_ENVELOPE_MESSAGE);
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toBe(JSON_LITERAL_NAME);
    expect(typeof captured[0]!.args[1]).toBe('string');
    expect(captured[0]!.args).toEqual(['L1', JSON_LITERAL_NAME]);
  });

  it('AC-2 — the same two calls with the flag ABSENT are unchanged: literal string, ok:true, both paths', async () => {
    // The fix is opt-in, so it must be invisible here. REQ-1318 owns the
    // flag-LESS route proper (and pins it in req1318StringJson.test.ts); this
    // row is specifically the UNFLAGGED call at a `string` position, which is
    // the cell the new guard could most easily have disturbed.
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', JSON_LITERAL_NAME],
    });

    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_setName', { id: 'L1', name: JSON_LITERAL_NAME });

    expect(compactResult.ok).toBe(true);
    expect(fullResult.ok).toBe(true);
    expect(compactResult.message).not.toBe(PRE_FIX_ENVELOPE_MESSAGE);
    expect(fullResult.message).not.toBe(PRE_FIX_ENVELOPE_MESSAGE);
    expect(compactRun.captured).toHaveLength(1);
    expect(fullRun.captured).toHaveLength(1);
    expect(compactRun.captured[0]!.args[1]).toBe(JSON_LITERAL_NAME);
    expect(fullRun.captured[0]!.args[1]).toBe(JSON_LITERAL_NAME);
    // The two paths are one value, which is what makes "the fix cannot change
    // unflagged behaviour" a fact about the wire rather than about a message.
    expect(compactRun.captured[0]!.args).toEqual(fullRun.captured[0]!.args);
  });
});

describe('REQ-1338 AC-3 — every structured declared type still parses, on both paths', () => {
  it('object, array and matrix positions are unaffected: the flag still converts them', async () => {
    // The structured half of the new predicate, stated directly rather than
    // inferred from the guard rows: narrowing the flag's reach must cost the
    // three declared types nothing. REQ-1280's own AC-2/3/4 rows (the
    // `create(props + transform)` and `layer.batch(ops)` cases) stay in place
    // and green above — this row adds the declared-type enumeration.
    const structured: Array<{
      tool: string;
      compact: Record<string, unknown>;
      full: Record<string, unknown>;
      declared: string;
      index: number;
      expected: unknown;
    }> = [
      {
        tool: 'layer_create',
        compact: { group: 'layer', method: 'create', args: ['page', '{"pageWidth":1500}'], _rawJson: true },
        full: { kind: 'page', props: '{"pageWidth":1500}', _rawJson: true },
        declared: 'object',
        index: 1,
        expected: { pageWidth: 1500 },
      },
      {
        tool: 'layer_batch',
        compact: { group: 'layer', method: 'batch', args: ['[{"method":"setName","args":["L1","hero"]}]'], _rawJson: true },
        full: { ops: '[{"method":"setName","args":["L1","hero"]}]', _rawJson: true },
        declared: 'array',
        index: 0,
        expected: [{ method: 'setName', args: ['L1', 'hero'] }],
      },
      {
        tool: 'layer_setTransform',
        compact: { group: 'layer', method: 'setTransform', args: ['L1', '[5,0,0,3.5,0,0]'], _rawJson: true },
        full: { id: 'L1', matrix: '[5,0,0,3.5,0,0]', _rawJson: true },
        declared: 'matrix',
        index: 1,
        expected: [5, 0, 0, 3.5, 0, 0],
      },
    ];

    for (const row of structured) {
      const compactRun = makeStub();
      const compactClient = await connect(compactRun.stub, 'compact');
      const compactResult = await callToolJson(compactClient, 'figpea_call', row.compact);
      const fullRun = makeStub();
      const fullClient = await connect(fullRun.stub, 'full');
      const fullResult = await callToolJson(fullClient, row.tool, row.full);

      expect(compactResult.ok, `${row.declared} (compact)`).toBe(true);
      expect(fullResult.ok, `${row.declared} (full)`).toBe(true);
      expect(compactRun.captured[0]!.args[row.index], `${row.declared} (compact) is parsed`).toEqual(row.expected);
      expect(fullRun.captured[0]!.args[row.index], `${row.declared} (full) is parsed`).toEqual(row.expected);
      expect(compactRun.captured[0]!.args, `${row.declared}: the two paths agree`).toEqual(fullRun.captured[0]!.args);
    }
  });
});

describe('REQ-1338 AC-4 — with NO schema available the flag still parses, and still never refuses', () => {
  it('compact before any describe(): a value that would be a declared string is STILL parsed, and the flag is not the thing that refuses', async () => {
    // Sits beside the row above it at the same place in the file: "with NO
    // manifest the flag still parses and never refuses" stays GREEN and
    // UNEDITED, and this is the row beside it that a naive schema guard would
    // have broken. With no manifest, `contractToolFor` yields `undefined` at
    // every position, so there is no declaration to scope a parse to and the
    // flag must parse — that is the whole reason it cannot be
    // manifest-dependent, and the whole reason it stays opt-in.
    const { stub, captured } = makeStub({ deliverManifest: undefined });
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', JSON_LITERAL_NAME],
      _rawJson: true,
    });
    // The server took no opinion: the value WAS parsed, and the tab's own
    // `validateArgs` rule is what refuses it, after the round trip. Naming the
    // tab's message is the honest way to pin "the flag parsed" — a silent
    // no-op here would forward the string and return ok:true instead.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toEqual([1, 2, 3]);
    expect(Array.isArray(captured[0]!.args[1])).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(PRE_FIX_ENVELOPE_MESSAGE);
  });

  it('a LEGACY free-text manifest: full mode still parses, because that state has a tool but no declared types', async () => {
    // AC-4's second named state, and the only one that is a genuinely different
    // code path from "no manifest at all": the lane HAS a tool, so the handler
    // runs, but every `params` value is a hint string, so `buildParamSchemas`
    // returns `undefined` and `schemaAt(i)` yields no schema at any position.
    // A parse guarded on "the schema says structured" would silently stop
    // working here and the flag would become manifest-dependent.
    const { stub, captured } = makeStub({ deliverManifest: LEGACY_MANIFEST });
    const client = await connect(stub, 'full');
    const result = await callToolJson(client, 'layer_create', { kind: 'page', props: '{"pageWidth":1500}', _rawJson: true });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    // A real object with a real number, not the string — the parse happened.
    expect(captured[0]!.args[1]).toEqual({ pageWidth: 1500 });
    expect(typeof (captured[0]!.args[1] as any).pageWidth).toBe('number');
  });

  it('and a FAILED parse in that same state is still neither recorded nor reported', async () => {
    // The other half of the no-declaration contract, in the state that HAS a
    // tool: the flag parses (row above), the value cannot be parsed, and
    // because nothing is provably structured here the failure is neither
    // recorded nor reported — the call succeeds with the text as sent. Loudness
    // in this state would break a call that works today, which is why the
    // failure-recording guard stays a SEPARATE question from the parse guard.
    const { stub, captured } = makeStub({ deliverManifest: LEGACY_MANIFEST });
    const client = await connect(stub, 'full');
    const result = await callToolJson(client, 'layer_setName', { id: 'L1', name: BROKEN_OBJECT, _rawJson: true });
    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toBe(BROKEN_OBJECT);
  });
});

describe('REQ-1338 AC-5 — the loud-failure contract REQ-1280 shipped is unchanged', () => {
  it('a JSON-looking string that FAILS to parse at a structured position: invalid_params naming _rawJson, byte-equal, 0 round trips', async () => {
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', BROKEN_OBJECT],
      _rawJson: true,
    });

    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_create', { kind: 'page', props: BROKEN_OBJECT, _rawJson: true });

    expect(compactResult.code).toBe('invalid_params');
    expect(fullResult.code).toBe(compactResult.code);
    // One message builder, so the guidance after the position is byte-equal and
    // two writers cannot drift (AC-7 of REQ-1280, still owed after this change).
    const tail = (m: string) => m.slice(m.indexOf('could not be parsed as JSON'));
    expect(tail(compactResult.message)).toBe(tail(fullResult.message));
    expect(compactResult.message).toContain('_rawJson');
    expect(fullResult.message).toContain('_rawJson');
    // Zero round trips on BOTH paths: the tab is never asked.
    expect(compactRun.captured).toHaveLength(0);
    expect(fullRun.captured).toHaveLength(0);
  });

  it('the SAME value at a scalar position is still forwarded verbatim, and is NOT an error', async () => {
    // The complementary half, pinned in the same place because the fix must not
    // buy the row above by costing this one: a declared `string` position is
    // now skipped by the parse, so nothing can be recorded there either — the
    // value travels as the text the caller sent and the call succeeds.
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', BROKEN_OBJECT],
      _rawJson: true,
    });

    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_setName', { id: 'L1', name: BROKEN_OBJECT, _rawJson: true });

    expect(compactResult.ok).toBe(true);
    expect(fullResult.ok).toBe(true);
    expect(compactResult.code).not.toBe('invalid_params');
    expect(fullResult.code).not.toBe('invalid_params');
    expect(compactRun.captured).toHaveLength(1);
    expect(fullRun.captured).toHaveLength(1);
    expect(compactRun.captured[0]!.args[1]).toBe(BROKEN_OBJECT);
    expect(fullRun.captured[0]!.args[1]).toBe(BROKEN_OBJECT);
    expect(compactRun.captured[0]!.args).toEqual(fullRun.captured[0]!.args);
  });
});

// ───────────────────────────── T3's own assertions: placement & advertisement ──

describe('REQ-1280 — the flag composes with the rest of the compact path', () => {
  it('a stringified filePath in a flagged layer.create("image") still reaches the bridge as a URL', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const file = tempImageFile();
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['image', JSON.stringify({ name: 'probe', rwidth: 10, rheight: 10, filePath: file })],
      _rawJson: true,
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const props = captured[0]!.args[1] as any;
    // Translation (REQ-1017) sees a PARSED object, not a string — so the flag
    // composes with the file-path translation instead of shadowing it.
    expect(typeof props).toBe('object');
    expect(props.filePath).toBeUndefined();
    expect(String(props.url)).toContain('/file?path=');
    expect(String(props.url)).toContain(encodeURIComponent(file));
  });

  // ⛔ SUPERSEDED IN PLACE by REQ-1318 (T2/T3), in substance if not in the plan's
  // own list. This row asserted "an UNFLAGGED stringified payload is answered by
  // the tab" — `captured` length 1, the string forwarded as a string. That is
  // exactly the behaviour REQ-1318 replaces: an unflagged stringified payload is
  // now parsed before the translation blocks read it, so the tab is no longer
  // asked. The row is therefore REPLACED by two rows that keep its actual
  // purpose — the `in`-operator hardening — and pin the new contract, which is
  // strictly stronger than what it asserted. Nothing is deleted or weakened.
  it('an unflagged stringified payload is now PARSED before the file-translation blocks read it', async () => {
    // The file-translation blocks guard their `in` tests with the value itself
    // (`input && 'filePath' in input`, `props && 'filePath' in props`), and the
    // `in` operator REJECTS a string primitive — so an unflagged stringified
    // payload used to throw a TypeError out of the handler, before the `try`
    // that turns failures into envelopes. REQ-1318 removes the hazard at the
    // root: by the time these blocks run, a JSON-looking string at a declared
    // `object` position has already been parsed into a REAL object, so there is
    // no primitive left for `in` to reject.
    for (const call of [
      { group: 'session', method: 'openFile', args: ['{"filePath":123}'], code: 'open_failed', message: 'input.filePath must be a string' },
      { group: 'layer', method: 'create', args: ['image', '{"filePath":123}'], code: 'invalid_image_source', message: 'props.filePath must be a string' },
    ]) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, 'compact');
      const result = await callToolJson(client, 'figpea_call', { group: call.group, method: call.method, args: call.args });
      // Strictly better than the row it replaces: the invalid `filePath` is now
      // caught by the server's OWN guard, at ZERO round trips, naming the
      // precise problem — where before a whole tab round trip bought the same
      // information wrapped in an editor message.
      expect(result, call.method).toHaveProperty('ok');
      expect(result.ok, call.method).toBe(false);
      expect(result.code, call.method).toBe(call.code);
      expect(result.message, call.method).toBe(call.message);
      expect(captured, call.method).toHaveLength(0);
    }
  });

  it('a NON-JSON string at the same positions is still forwarded, and no TypeError escapes the handler', async () => {
    // The `in`-operator hazard is still LIVE for a value the escape hatch
    // cannot parse — a plain string does not look like JSON, so REQ-1318's
    // narrow guard leaves it alone and it reaches the tab as the string it is.
    // This row is where the original hardening claim actually has to hold, and
    // it is kept verbatim in substance: the handler must not throw, and the
    // tab's own answer must come back as a normal envelope (compact relays it
    // with REQ-1268's shape-hint suffix appended).
    for (const call of [
      { group: 'session', method: 'openFile', args: ['plain string'], message: 'input must be object (got string)' },
      { group: 'layer', method: 'create', args: ['image', 'plain string'], message: 'props must be object (got string)' },
    ]) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, 'compact');
      const result = await callToolJson(client, 'figpea_call', { group: call.group, method: call.method, args: call.args });
      expect(captured, call.method).toHaveLength(1);
      expect(captured[0]!.args[0], call.method).toBe(call.args[0]);
      expect(result, call.method).toHaveProperty('ok');
      // A TypeError would have surfaced as the helper's `non_envelope`
      // envelope, so asserting the real editor message also asserts no throw.
      expect(result.code, call.method).not.toBe('non_envelope');
      expect(result.message, call.method).toContain(call.message);
    }
  });

  it('tools/list advertises _rawJson as a working escape hatch with a worked figpea_call example', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const { tools } = await client.listTools();
    const call = tools.find((t) => t.name === 'figpea_call')!;
    const description: string = (call as any).inputSchema.properties._rawJson.description;
    // VERIFIED, not assumed: the advertised text is today exactly
    // "Reserved passthrough for harness stringification tolerance" — a claim
    // no compact-mode caller could rely on, since the flag was inert here.
    expect(description).not.toBe('Reserved passthrough for harness stringification tolerance');
    expect(description).toContain('_rawJson');
    // A concrete payload an agent can copy, in the REQ-1268 idiom.
    expect(description).toMatch(/figpea_call/);
    expect(description).toMatch(/\{["']?group["']?:["']?layer/);
    // It advertises that stringified objects/arrays are parsed — and does not
    // promise more than the guard delivers.
    expect(description).toMatch(/object|array/i);
  });
});
