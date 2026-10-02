import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMcpServer } from './mcpServer';
import type { ManifestLike } from './tools';

/**
 * REQ-1444 — a wrong-shape call is answered with a message about the wrong
 * thing, and three of the four wrong-shape families are one family.
 *
 * The incident (card REQ-1444, from the `2026-10-01-counterform-specimen-og`
 * `/design` run): an agent read `describe()`'s NAMED declaration and sent
 * exactly that — `figpea_call({group:'session', method:'openFile',
 * args:[{input:{filePath:'/abs/path/design.fp'}}]})`. Compact mode's
 * file-path translation reads `args[0].filePath` POSITIONALLY, so the
 * envelope put the key one level too deep, nothing was translated, and the
 * bare local path was forwarded to the editor as a URL — which answered
 * `open_fetch_failed: HTTP 404 Not Found for "/abs/path/design.fp"` about a
 * file that exists. Three round trips of that one class went into the
 * filesystem instead of into the argument.
 *
 * Vehicle: this repo has no Playwright lane, so "end-to-end" is a real MCP SDK
 * `Client` over `InMemoryTransport` driving the real server — a genuine
 * `registerTool` → `safeParseAsync` → handler → `callTab` round trip — with a
 * **stub tab** standing in for the paired editor (REQ-1280's precedent). The
 * stub is TRANSCRIBED from v3 rather than guessed at, because the messages
 * this requirement pins are the editor's own:
 *
 *   | stub behaviour                                  | transcribed from            | used by |
 *   |-------------------------------------------------|-----------------------------|---------|
 *   | single-object wrapper expansion at ONE argument | `registry.ts:130-142`        | AC-2/3/5|
 *   | `<m>(): <key> must be <t> (got <u>)`, invalid_params | `validateArgs.ts:166`    | AC-5    |
 *   | first style key outside the whitelist → `unsupported style key "…"` | `stylePatch.ts:1087-1091` | AC-4 |
 *   | `openFile` on a non-URL `filePath` → `open_fetch_failed` + the 404 quoting the path | the observed editor answer (`session.impl.ts:341-361` over `file.ts:52`) | AC-1's RED state |
 *
 * The "file that exists" precondition is a REAL temp `.fp` on disk, not a
 * mock, and every bridge round trip is COUNTED — the whole cost of this defect
 * is a call spent to learn nothing, so "zero round trips" is the behaviour,
 * not a nicety.
 *
 * AC map (see `docs/plans/REQ-1444-6abec8d2.md` § Use cases → task → test):
 *  - AC-1  the repro: envelope + existing file ⇒ `invalid_params` naming
 *          `args[0]`, never mentioning 404, costing zero tab round trips
 *  - AC-2  the pre-flight must not swallow the real missing-file case, on
 *          either reading of "the same call" — all three rows pinned
 *  - AC-3  every currently-valid spelling is unchanged, INCLUDING the legal
 *          whole-`args` wrapper that carries a `url`
 *  - AC-4  `stylePatch(id, {style:{…}})` names the flat form, and still
 *          carries `unsupported_style_key`; a genuine unknown style key is
 *          NOT given that lesson
 *  - AC-5  a stringified `patch` nested inside a real object names BOTH ways
 *          out and still carries the editor's own clause verbatim; a real
 *          object in that slot is untouched
 *  - AC-6  every one of those messages is pinned HERE, and this file's red run
 *          on the unfixed worktree is recorded in the dev log
 *  - AC-7  the regression table: every currently-valid spelling of the four
 *          touched methods is replayed and the tab must receive EXACTLY what
 *          it received at base — same code, same positional array
 *
 * RED on the unfixed worktree, and for the right reason: the compact handler
 * forwards the envelope untouched (so AC-1 answers with the 404 and costs a
 * round trip), and AC-4/AC-5 come back as the bare editor message with nothing
 * appended. The AC-2 second row, the AC-3 rows and the AC-7 table are GREEN on
 * arrival — they guard behaviour that already works, which is exactly why they
 * are here rather than hunted for.
 */

/* ──────────────────────────────────────────────────────────────────────────
 * The manifest — real declarations, transcribed, never imported.
 *
 * `figpea-mcp` is a standalone package that must build with no sibling `v3/`
 * checkout, so every schema below is copied from the descriptor it claims:
 * `session.descriptor.ts:32-45` (openFile's single `input` param),
 * `layer.descriptor.ts:258-265` (stylePatch), `:524-538` (setPageFill),
 * `:266-285` (setImageFill) and `createSchema.ts:100-106`'s
 * `CREATE_COMMON_FIELDS` beside `layer.descriptor.ts`'s per-kind entries.
 * ────────────────────────────────────────────────────────────────────────── */

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
            type: { type: 'string', required: false },
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
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'line', 'polygon', 'text', 'image'] },
        props: {
          type: 'object',
          required: false,
          // `CREATE_COMMON_FIELDS` — the props that apply to EVERY kind.
          shape: {
            parentId: { type: 'string', required: false },
            index: { type: 'number', required: false },
            name: { type: 'string', required: false },
            transform: { type: 'matrix', required: false },
            style: { type: 'object', required: false, shape: STYLE_PATCH_SHAPE },
          },
          byKind: {
            rect: { rwidth: { type: 'number', required: false }, rheight: { type: 'number', required: false } },
            text: { text: { type: 'string', required: false } },
            image: {
              url: { type: 'string', required: false },
              filePath: { type: 'string', required: false },
              bytes: { type: 'array', required: false, of: { type: 'number', required: true } },
            },
          },
        },
      },
      result: { id: 'string' },
    },
    stylePatch: {
      doc: "Patches a layer's style with an explicit whitelist of public keys.",
      params: {
        id: { type: 'string', required: true },
        patch: { type: 'object', required: true, shape: STYLE_PATCH_SHAPE },
      },
      result: 'void',
    },
    setPageFill: {
      doc: "Sets a page's background fill.",
      params: {
        pageId: { type: 'string', required: true },
        patch: {
          type: 'object',
          required: true,
          shape: { fill: { type: 'string', required: false }, fillType: { type: 'string', required: false, enum: ['solid', 'none'] } },
        },
      },
      result: 'void',
    },
    setImageFill: {
      doc: 'Attaches an image fill (from url, bytes, or local filePath) to an existing paintable shape layer.',
      params: {
        id: { type: 'string', required: true },
        source: {
          type: 'object',
          required: true,
          shape: {
            url: { type: 'string', required: false },
            bytes: { type: 'array', required: false, of: { type: 'number', required: true } },
            filePath: { type: 'string', required: false },
            mimeType: { type: 'string', required: false },
            patternScaleType: { type: 'string', required: false, enum: ['cover', 'tile'] },
            patternRepeat: { type: 'string', required: false, enum: ['no-repeat', 'repeat'] },
          },
        },
      },
      result: 'void',
    },
  },
} as unknown as ManifestLike;

/* ──────────────────────────────────────────────────────────────────────────
 * The stub tab — v3's real answer, not a plausible one.
 * ────────────────────────────────────────────────────────────────────────── */

const BRIDGE_PORT = 54397;

/** v3's `receivedTypeName` (`validateArgs.ts:35-45`), verbatim in behaviour. */
function receivedTypeName(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/** v3's `matchesDeclaredType` (`validateArgs.ts:48-70`) for the top-level types
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

/** The fixture's declared positional types, in declaration order, keyed by the
 *  BARE method name — `callTab(group, method, args)` receives `method` without
 *  its group prefix on both lanes. */
const DECLARED: Record<string, Record<string, string>> = {
  openFile: { input: 'object' },
  create: { kind: 'string', props: 'object' },
  stylePatch: { id: 'string', patch: 'object' },
  setPageFill: { pageId: 'string', patch: 'object' },
  setImageFill: { id: 'string', source: 'object' },
};

/** v3's `tryUnwrapWrapper` (`registry.ts:125-145`): a single plain object
 *  keyed entirely by the method's own parameter names expands to positional
 *  order, and ONLY when the call carries exactly one argument
 *  (`registry.ts:130`, `raw.length !== 1`). This is why the ENVELOPE around
 *  `openFile`'s input is accepted rather than rejected, and why the same
 *  wrapper two arguments deep is not — the stub must reproduce it exactly or
 *  the repro it stands in for is not the repro. */
function tryUnwrapWrapper(method: string, args: unknown[]): unknown[] {
  if (args.length !== 1) return args;
  const only = args[0];
  if (only === null || typeof only !== 'object' || Array.isArray(only)) return args;
  const names = Object.keys(DECLARED[method] ?? {});
  if (names.length === 0) return args;
  const keys = Object.keys(only as Record<string, unknown>);
  if (keys.length === 0) return args;
  if (!keys.every((k) => names.includes(k))) return args;
  return names.map((k) => (only as Record<string, unknown>)[k]);
}

/** v3's `STYLE_PATCH_WHITELIST` (`stylePatch.ts:55-104`) as the subset this
 *  fixture declares. No key of it is named `patch`, `style` or `id` — which is
 *  what makes AC-4's two rows reachable at all. */
const STYLE_WHITELIST = new Set(Object.keys(STYLE_PATCH_SHAPE));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** v3's `validateArgs` (`validateArgs.ts:154-170`): the FIRST positional
 *  argument that does not match its declared type is rejected with exactly
 *  `<method>(): <key> must be <declared> (got <received>)`, code
 *  `invalid_params`. That string is AC-5's — and it is the one clause the
 *  README's coherence pin requires verbatim on its counter-example. */
function validateArgs(method: string, args: unknown[]): { ok: false; code: string; message: string } | undefined {
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

/** The editor's `openFile` answer on a bare local `filePath`: it is handed as a
 *  URL and the fetch fails. Transcribed from `session.impl.ts:341-361`
 *  (which returns `OPEN_FETCH_FAILED` with `downloadFile`'s own message, from
 *  `facade/file/file.ts:52`) — including the 404 and the quoted path, because
 *  those two strings ARE the defect: an accurate report of what arrived, and a
 *  pointer at the wrong thing to change. */
function openFileAnswer(args: unknown[]): { ok: false; code: string; message: string } | { ok: true; value: unknown } {
  const input = args[0];
  if (isPlainObject(input) && typeof input.filePath === 'string' && input.filePath) {
    const fp = input.filePath;
    if (/^[a-z][a-z0-9+.-]*:/i.test(fp)) return { ok: true, value: { opened: input.fileName ?? fp } };
    return {
      ok: false,
      code: 'open_fetch_failed',
      message: `Download failed: HTTP 404 Not Found for "${fp}" — server returned 404`,
    };
  }
  return { ok: true, value: { opened: isPlainObject(input) ? (input.fileName ?? input.url ?? true) : true } };
}

function editorAnswer(method: string, args: unknown[]): { ok: false; code: string; message: string } | { ok: true; value: unknown } {
  const expanded = tryUnwrapWrapper(method, args);
  const rejected = validateArgs(method, expanded);
  if (rejected) return rejected;
  if (method === 'stylePatch') {
    const patch = expanded[1];
    if (isPlainObject(patch)) {
      for (const key of Object.keys(patch)) {
        if (!STYLE_WHITELIST.has(key)) {
          return { ok: false, code: 'unsupported_style_key', message: `unsupported style key "${key}"` };
        }
      }
    }
    return { ok: true, value: { id: expanded[0], applied: Object.keys((patch ?? {}) as Record<string, unknown>) } };
  }
  if (method === 'openFile') return openFileAnswer(expanded);
  if (method === 'setPageFill') return { ok: true, value: { pageId: expanded[0], patch: expanded[1] } };
  if (method === 'create') return { ok: true, value: { id: 'L_probe', kind: expanded[0], received: expanded[1] } };
  if (method === 'setImageFill') return { ok: true, value: { id: expanded[0], received: expanded[1] } };
  return { ok: true, value: { method, received: expanded } };
}

interface Capture {
  group: string;
  method: string;
  args: unknown[];
}

function makeStub(opts?: { manifest?: unknown }) {
  const captured: Capture[] = [];
  const deliver = opts?.manifest ?? MANIFEST;
  const stub = {
    port: BRIDGE_PORT,
    token: 'test-token-1444',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => h(deliver),
    // The PRODUCT's own URL string, not one invented here: the whole point of
    // the translation is that this is the string the editor is handed.
    getFileUrl: (fp: string) => `http://localhost:${BRIDGE_PORT}/file?path=${encodeURIComponent(fp)}`,
    callTab: async (group: string, method: string, args: unknown[]) => {
      captured.push({ group, method, args: structuredClone(args) });
      return editorAnswer(method, args);
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

async function connect(bridge: unknown) {
  const server = createMcpServer(bridge as never, { toolMode: 'compact' } as never);
  const client = new Client({ name: 'req-1444-test', version: '0.0.0' });
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
    // envelope so the failure reads as the defect it is, not a parse error here.
    return { ok: false, code: 'non_envelope', message: text };
  }
  return JSON.parse(text);
}

/** A REAL file on disk — AC-1's precondition is a fact, not a mock. */
function tempDesignFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1444-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'design.fp');
  fs.writeFileSync(file, Buffer.from('PKfigpea-fixture-project'));
  return file;
}

/** A path guaranteed absent: a fresh temp dir that is removed immediately, so
 *  nothing can create it between here and the call. */
function absentPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1444-absent-'));
  const file = path.join(dir, 'no-such-design.fp');
  fs.rmSync(dir, { recursive: true, force: true });
  return file;
}

const bridgeUrl = (fp: string) => `http://localhost:${BRIDGE_PORT}/file?path=${encodeURIComponent(fp)}`;

/* ───────────────────────────────────────────────────────────── AC-1 ── */

describe('REQ-1444 AC-1 — the envelope is named BEFORE the fetch, not after a 404', () => {
  it('the defect is real: the untranslated call reaches the tab as a URL and 404s about a file that exists', () => {
    // Proven against the transcribed editor behaviour directly rather than
    // through this server: once the pre-flight is in place the server never
    // forwards this payload, so the repro has to be pinned at its source or
    // AC-1's evidence evaporates. A REAL file on disk is the input.
    const file = tempDesignFile();
    expect(fs.existsSync(file), 'the precondition is a file that exists').toBe(true);

    const forwarded = editorAnswer('openFile', [{ input: { filePath: file } }]);
    expect(forwarded.ok).toBe(false);
    expect((forwarded as any).code).toBe('open_fetch_failed');
    expect((forwarded as any).message).toContain('404');
    expect((forwarded as any).message).toContain(file);
    // …and the same path, FLAT, is what the editor accepts — the difference is
    // the argument's shape, never the file.
    const afterTranslation = { url: bridgeUrl(file), fileName: 'design.fp' };
    expect(editorAnswer('openFile', [afterTranslation]).ok).toBe(true);
  });

  it('is answered invalid_params naming args[0] as where filePath belongs — and costs no tab round trip', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = tempDesignFile();

    const result = await callToolJson(client, 'figpea_call', {
      group: 'session',
      method: 'openFile',
      args: [{ input: { filePath: file } }],
    });
    const message = String(result.message ?? '');

    expect(result.ok, 'the call is refused, not mis-served').toBe(false);
    // The code is this relay's own pre-flight family. AC-1 names it exactly.
    expect(result.code).toBe('invalid_params');

    // It names the POSITION `filePath` belongs at — the thing the card says the
    // agent was never told.
    expect(message, 'args[0] is named').toMatch(/args\[0\]/);
    expect(message, 'filePath is named').toMatch(/filePath/);
    // It names the mistake: the declaration arrived instead of the contents.
    expect(message).toMatch(/declaration|wrapper/i);
    // It says the cure is the ARGUMENT, because retrying this shape is the one
    // thing that provably cannot help.
    expect(message).toMatch(/retrying this shape fails identically/i);
    // …and it does NOT quote the editor's fetch failure. No fetch happened: the
    // file was never asked for, so a 404 in the message would be a lie.
    expect(message, 'no 404 — none happened').not.toContain('404');
    expect(message, 'no open_fetch_failed — none happened').not.toMatch(/open_fetch_failed/);

    // The cost this whole requirement exists to remove.
    expect(captured, 'the refusal is a PRE-FLIGHT: zero bridge round trips').toHaveLength(0);
  });

  it('is derived, not hard-coded to one method: the same envelope defeats the other two positional filePath reads', async () => {
    // The compact lane translates a local path at exactly three sites
    // (`session_openFile`, `layer_setImageFill`, `layer_create` with
    // kind==='image'), and an envelope defeats all three identically — reaching
    // the same misleading failure for the same file that exists. A rule keyed
    // to one method name would leave two reachable copies of this defect.
    const file = tempDesignFile();

    for (const call of [
      { group: 'session', method: 'openFile', args: [{ input: { filePath: file } }] },
      { group: 'layer', method: 'setImageFill', args: [{ id: 'L1', source: { filePath: file } }] },
      { group: 'layer', method: 'create', args: [{ kind: 'image', props: { filePath: file } }] },
    ]) {
      const { stub, captured } = makeStub();
      const client = await connect(stub);
      const result = await callToolJson(client, 'figpea_call', call);
      expect(result.ok, `${call.method}: refused, not forwarded as a URL`).toBe(false);
      expect(result.code, `${call.method}: the relay's own pre-flight code`).toBe('invalid_params');
      expect(String(result.message), `${call.method}: names the slot`).toMatch(/args\[\d\]/);
      expect(String(result.message), `${call.method}: never mentions a 404`).not.toContain('404');
      expect(captured, `${call.method}: no bridge round trip spent`).toHaveLength(0);
    }
  });

  it('layer.batch is untouched — its ops are nested in an array, which no positional read sees', async () => {
    // The deliberate non-goal, asserted rather than asserted-in-prose: an
    // envelope inside a batch op would need each op's own method resolved
    // against the manifest, and no acceptance criterion asks for it. This row
    // is what keeps the gap from reading as an oversight.
    const file = tempDesignFile();
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [[{ method: 'create', args: [{ input: { filePath: file } }] }]],
    });
    expect(result.ok, 'a batch op is forwarded exactly as it is today').toBe(true);
    expect(captured, 'and it really reached the tab').toHaveLength(1);
  });
});

/* ───────────────────────────────────────────────────────────── AC-2 ── */

describe('REQ-1444 AC-2 — the pre-flight never swallows the real missing-file case', () => {
  it('the CORRECT positional form against a missing file still reports open_failed, naming the path', async () => {
    const { stub } = makeStub();
    const client = await connect(stub);
    const missing = absentPath();

    const result = await callToolJson(client, 'figpea_call', {
      group: 'session',
      method: 'openFile',
      args: [{ filePath: missing }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('open_failed');
    expect(String(result.message)).toContain(missing);
  });

  it('the ENVELOPE against a missing file also reports open_failed — naming the INNER path', async () => {
    // Both readings of AC-2 are satisfied, so the agent is never told the wrong
    // thing. A file that is not there is not there whatever shape it arrived
    // in, and reshaping the argument will not conjure it — so the answer is
    // the missing-file answer, naming the path the caller actually sent.
    const { stub } = makeStub();
    const client = await connect(stub);
    const missing = absentPath();

    const result = await callToolJson(client, 'figpea_call', {
      group: 'session',
      method: 'openFile',
      args: [{ input: { filePath: missing } }],
    });
    expect(result.ok).toBe(false);
    expect(result.code, 'a missing file is a missing file, whatever the shape').toBe('open_failed');
    expect(String(result.message), 'the INNER path is the one named').toContain(missing);
  });

  it('the CORRECT positional form against an existing file still succeeds', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = tempDesignFile();

    const result = await callToolJson(client, 'figpea_call', {
      group: 'session',
      method: 'openFile',
      args: [{ filePath: file }],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
  });

  it('an empty or non-string filePath keeps the message it has today — this rule is not the one that owns those', async () => {
    // Both are already the transport's own refusals (`open_failed`), reached
    // through a different branch. Narrowing this rule to "a non-empty STRING
    // filePath" is what keeps those messages byte-identical rather than
    // silently re-routed through a new one.
    const { stub } = makeStub();
    const client = await connect(stub);
    for (const bad of ['', '   ', 42, null, ['/a']]) {
      const flat = await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [{ filePath: bad }] });
      expect(flat.code, `flat filePath=${JSON.stringify(bad)}`).toBe('open_failed');
      const wrapped = await callToolJson(client, 'figpea_call', {
        group: 'session',
        method: 'openFile',
        args: [{ input: { filePath: bad } }],
      });
      expect(wrapped.code, `enveloped filePath=${JSON.stringify(bad)} is not this rule's to answer`).not.toBe('invalid_params');
    }
  });
});

/* ───────────────────────────────────────────────────────────── AC-3 ── */

describe('REQ-1444 AC-3 — every currently-valid spelling is unchanged', () => {
  it('the flat positional form still loads the file, and the tab receives the bridge URL with filePath removed', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = tempDesignFile();

    const result = await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [{ filePath: file }] });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const relayed = captured[0]!.args[0] as Record<string, unknown>;
    expect(relayed.url, 'the translation happened').toBe(bridgeUrl(file));
    expect(Object.prototype.hasOwnProperty.call(relayed, 'filePath'), 'the local path is never forwarded').toBe(false);
    expect(relayed.fileName).toBe('design.fp');
  });

  it('the LEGAL whole-args wrapper carrying a url still succeeds — the one row that makes AC-7 real', async () => {
    // `openFile({input:{url:"https://…"}})` succeeds TODAY: nothing about it
    // defeats a transport read, the editor expands the wrapper, and the URL is
    // opened. The obvious implementation of this requirement ("wrapper ⇒
    // refuse") breaks exactly this call, so it is pinned as its own row.
    const { stub, captured } = makeStub();
    const client = await connect(stub);

    const result = await callToolJson(client, 'figpea_call', {
      group: 'session',
      method: 'openFile',
      args: [{ input: { url: 'https://example.com/design.fp' } }],
    });
    expect(result.ok, 'a wrapper with no filePath is not this rule\'s business').toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args).toEqual([{ input: { url: 'https://example.com/design.fp' } }]);
  });

  it('the four sibling envelopes the rule must decline all still reach the tab', async () => {
    const file = tempDesignFile();
    const cases: Array<[string, string, unknown[]]> = [
      // (a) bytes — a documented branch of the same union.
      ['session', 'openFile', [{ input: { bytes: [1, 2, 3] } }]],
      // (b) the filename aliases alone.
      ['session', 'openFile', [{ input: { fileName: 'renamed.fp' } }]],
      // (c) a name — the other documented alias.
      ['session', 'openFile', [{ input: { name: 'aliased' } }]],
      // (d) an image create carrying a URL rather than a path.
      ['layer', 'create', [{ kind: 'image', props: { url: 'https://example.com/a.png' } }]],
    ];
    for (const [group, method, args] of cases) {
      const { stub, captured } = makeStub();
      const client = await connect(stub);
      const result = await callToolJson(client, 'figpea_call', { group, method, args });
      expect(result.ok, `${method} ${JSON.stringify(args)} is accepted today and must stay so`).toBe(true);
      expect(captured, `${method} was forwarded, not refused`).toHaveLength(1);
    }
    // …while the SAME spelling carrying a real local path is the defect, so
    // the rows above decline for the right reason rather than by accident.
    // `layer.create`'s branch reads `effectiveArgs[1]` for its props, and a
    // whole-`args` wrapper leaves that slot empty — so the wrapper is not a
    // second spelling this transport can translate, it is the same unreachable
    // filePath with one more layer of naming. Refusing it by name is the whole
    // point; unwrapping it would be the repair this package does not do.
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const wrapped = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'create', args: [{ kind: 'image', props: { filePath: file } }] });
    expect(wrapped.code, 'an envelope around a local path is refused by name').toBe('invalid_params');
    expect(captured, 'and never reaches the tab as a URL').toHaveLength(0);
  });

  it('the flat rect create still succeeds and is relayed verbatim', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const props = { rwidth: 100, rheight: 50 };
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'create', args: ['rect', props] });
    expect(result.ok).toBe(true);
    expect(captured[0]!.args).toEqual(['rect', props]);
  });
});

/* ───────────────────────────────────────────────────────────── AC-4 ── */

describe('REQ-1444 AC-4 — a create() prop used as a style key gets the flat form named', () => {
  it('names the flat form rendered from the keys actually sent, AND keeps the editor\'s code and message', async () => {
    const { stub } = makeStub();
    const client = await connect(stub);

    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'stylePatch',
      args: ['L_kicker', { style: { fontSize: 26, fontFamily: 'Inter' } }],
    });
    const message = String(result.message ?? '');

    expect(result.ok).toBe(false);
    // The editor's own code and message are PRESERVED BYTE-FOR-BYTE — AC-4
    // says "not only unsupported_style_key", which only has meaning if it is
    // still there. Replacing it would also mean replacing a message this
    // server does not own.
    expect(result.code).toBe('unsupported_style_key');
    expect(message).toContain('unsupported style key "style"');

    // The flat form, rendered from the caller's OWN keys.
    expect(message).toMatch(/stylePatch\(L_kicker, \{fontSize: 26, fontFamily: "Inter"\}\)/);
    // The reason, in words: `style` is a create() prop, stylePatch takes keys flat.
    expect(message).toMatch(/create\(\) top-level prop/i);
    expect(message).toMatch(/flat/i);
    // Exactly ONE appended lesson: the agent must not read two sentences that
    // each claim to be the next step.
    expect((message.match(/figpea_describe/g) ?? []).length, 'one appended sentence, not two').toBe(1);
  });

  it('a genuinely unknown style key is NOT given that lesson', async () => {
    const { stub } = makeStub();
    const client = await connect(stub);

    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'stylePatch',
      args: ['L_kicker', { bogus: 1 }],
    });
    const message = String(result.message ?? '');
    expect(result.code).toBe('unsupported_style_key');
    // `bogus` is not a create() prop, so the create-prop lesson explains nothing
    // about it and appending it would be the same error one word later.
    expect(message).not.toMatch(/create\(\) top-level prop/i);
    expect(message, 'nothing appended at all').not.toMatch(/figpea_describe/);
    expect(message, "the editor's message is untouched").toBe('unsupported style key "bogus"');
  });

  it('a nested style object is still a refusal this time — the hint teaches, it does not repair', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    await callToolJson(client, 'figpea_call', { group: 'layer', method: 'stylePatch', args: ['L_kicker', { style: { fontSize: 26 } }] });
    // The tab WAS asked: this is a relay-side append, not a pre-flight, because
    // the editor's answer is the one that has to survive verbatim.
    expect(captured).toHaveLength(1);
  });

  it('the declared-wrapper lesson and this one never both fire on the same key', async () => {
    // Both are relay-side appends keyed on `unsupported_style_key`, so the
    // exclusive case is load-bearing: a key that IS a declared parameter name
    // (`patch`) is REQ-1295's declaration mistake, and teaching the create-prop
    // lesson about it would be the same error one word later. A legacy
    // free-text manifest is the shape that reaches the tab with the editor's
    // code intact, which is where the two appends are both live at once.
    const legacy = {
      layer: {
        stylePatch: { doc: "Patches a layer's style.", params: { id: 'a layer id', patch: 'an object of style keys' }, result: 'void' },
      },
    };
    const { stub, captured } = makeStub({ manifest: legacy });
    const client = await connect(stub);

    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'stylePatch',
      args: ['L1', { patch: { fill: '#12395C' } }],
    });
    const message = String(result.message ?? '');
    expect(captured, 'with no schemas to derive from, the payload is forwarded').toHaveLength(1);
    expect(result.code, "the editor's own code, preserved").toBe('unsupported_style_key');
    // REQ-1295's lesson (its own relay-side wording), and only that one.
    expect(message).toMatch(/own DECLARATION arriving where its contents were due/i);
    // "Exactly one appended lesson" rather than "exactly one figpea_describe":
    // REQ-1295's hint carries no describe clause, so counting that would pass
    // a message that had gained both lessons. What has to be exclusive is the
    // lesson itself.
    const lessons = [/own DECLARATION arriving where its contents were due/i, /create\(\) top-level prop/i].filter((re) => re.test(message));
    expect(lessons.length, 'exactly one lesson is appended, never two').toBe(1);
  });
});

/* ───────────────────────────────────────────────────────────── AC-5 ── */

describe('REQ-1444 AC-5 — a stringified value nested inside a real object names both ways out', () => {
  it('names the positional form and the blind spot, and KEEPS the editor\'s clause verbatim', async () => {
    const { stub } = makeStub();
    const client = await connect(stub);

    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setPageFill',
      args: [{ pageId: 'P_1', patch: '{"fill":"#EFEBE3","fillType":"solid"}' }],
    });
    const message = String(result.message ?? '');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    // The editor's own words, still first. `readme.test.ts`'s coherence pin
    // requires this clause verbatim on the README's counter-example, and it can
    // only stay truthful here if the server preserves it.
    expect(message).toContain('setPageFill(): patch must be object (got string)');

    // Way out #1 — the positional form, rendered from the manifest's own
    // parameter names and order.
    expect(message).toMatch(/setPageFill\(pageId, \{…\}\)/);
    // Way out #2 — WHY the JSON-string route did not save it. Verified, not
    // asserted: `applyStructuredStringJson` iterates the container's top-level
    // positions, so at `args[0]` the schema is `pageId` (a string) and the gate
    // is false — the inner `patch` string is never visited.
    expect(message).toMatch(/never descends into an object/i);
    expect(message).toMatch(/whole (positional )?slot/i);
    expect((message.match(/figpea_describe/g) ?? []).length, 'one appended sentence, not two').toBe(1);
  });

  it('a REAL object in that slot is untouched — the hint cannot appear on a call that works', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);

    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setPageFill',
      args: [{ pageId: 'P_1', patch: { fill: '#EFEBE3', fillType: 'solid' } }],
    });
    expect(result.ok, 'the legal single-object wrapper still works').toBe(true);
    expect(captured).toHaveLength(1);
  });

  it('a string at a parameter declared `string` is somebody else\'s lesson', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setPageFill',
      args: [{ pageId: '{"not":"a page id"}', patch: { fill: '#EFEBE3' } }],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
  });
});

/* ───────────────────────────────────────────────────────────── AC-7 ── */

describe('REQ-1444 AC-7 — no call that succeeds on the base commit fails or changes after this work', () => {
  it('every currently-valid spelling of the four touched methods delivers EXACTLY what the tab received at base', async () => {
    const file = tempDesignFile();
    const flatStyle = { fontFamily: 'Inter', fontSize: 26, fill: '#1A1A1A' };
    const flatFill = { fill: '#EFEBE3', fillType: 'solid' };

    // The table is the AC. `to` is the exact positional array the tab must
    // receive — same code, same values, same order — so any behaviour change is
    // a failing test in this file rather than something a suite-wide green has
    // to be trusted to catch.
    const table: Array<{ group: string; method: string; args: unknown[]; to: unknown[] }> = [
      { group: 'session', method: 'openFile', args: [{ filePath: file }], to: [{ url: bridgeUrl(file), fileName: 'design.fp' }] },
      { group: 'session', method: 'openFile', args: [{ url: 'https://example.com/design.fp' }], to: [{ url: 'https://example.com/design.fp' }] },
      { group: 'session', method: 'openFile', args: [{ input: { url: 'https://example.com/design.fp' } }], to: [{ input: { url: 'https://example.com/design.fp' } }] },
      { group: 'session', method: 'openFile', args: [{ fileName: 'kept.fp' }], to: [{ fileName: 'kept.fp' }] },
      { group: 'layer', method: 'stylePatch', args: ['L1', flatStyle], to: ['L1', flatStyle] },
      { group: 'layer', method: 'stylePatch', args: [{ id: 'L1', patch: flatStyle }], to: [{ id: 'L1', patch: flatStyle }] },
      { group: 'layer', method: 'setPageFill', args: ['P_1', flatFill], to: ['P_1', flatFill] },
      { group: 'layer', method: 'setPageFill', args: [{ pageId: 'P_1', patch: flatFill }], to: [{ pageId: 'P_1', patch: flatFill }] },
      { group: 'layer', method: 'create', args: ['rect', { rwidth: 100, rheight: 50 }], to: ['rect', { rwidth: 100, rheight: 50 }] },
      { group: 'layer', method: 'create', args: ['text', { text: 'Counterform', style: { fontSize: 26 } }], to: ['text', { text: 'Counterform', style: { fontSize: 26 } }] },
      { group: 'layer', method: 'create', args: [{ kind: 'text', props: { text: 'Counterform' } }], to: [{ kind: 'text', props: { text: 'Counterform' } }] },
      { group: 'layer', method: 'setImageFill', args: ['L1', { url: 'https://example.com/a.png' }], to: ['L1', { url: 'https://example.com/a.png' }] },
      { group: 'layer', method: 'setImageFill', args: ['L1', { filePath: file }], to: ['L1', { url: bridgeUrl(file) }] },
    ];

    for (const row of table) {
      const { stub, captured } = makeStub();
      const client = await connect(stub);
      const result = await callToolJson(client, 'figpea_call', { group: row.group, method: row.method, args: row.args });
      const label = `${row.method} ${JSON.stringify(row.args)}`;
      expect(result.ok, `${label} still succeeds`).toBe(true);
      expect(captured, `${label} still costs exactly one round trip`).toHaveLength(1);
      expect(captured[0]!.args, `${label} delivers exactly the base positional array`).toEqual(row.to);
    }
  });

  it('every legal form still answers the editor\'s own code, not a pre-flight invention', async () => {
    // The three refusal families below all have to keep answering with the
    // EDITOR's code and message: this work appends to them, it never re-labels
    // them, and a code this server renamed would be a message nobody downstream
    // can match on.
    const { stub } = makeStub();
    const client = await connect(stub);

    const wrapper = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'stylePatch',
      args: ['L1', { patch: { fill: '#12395C' } }],
    });
    expect(wrapper.code, 'REQ-1295\'s pre-flight keeps its code').toBe('invalid_params');

    const nested = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setPageFill',
      args: [{ pageId: 'P_1', patch: '{"fill":"#EFEBE3"}' }],
    });
    expect(nested.code).toBe('invalid_params');
    expect(String(nested.message)).toContain('setPageFill(): patch must be object (got string)');

    const kind = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['text', { x: 120, y: 250 }],
    });
    expect(kind.code, 'REQ-1309 relays the editor\'s code').toBe('invalid_transform');
  });
});