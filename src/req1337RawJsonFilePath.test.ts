import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMcpServer } from './mcpServer';
import type { ManifestLike } from './tools';

/**
 * REQ-1337 — full mode's file-path relay: the three unguarded `'filePath' in`
 * sites, and the statement order that decides whether a stringified payload is
 * translated at all.
 *
 * The incident (card REQ-1337, the unfixed twin of REQ-1280): a stringifying
 * host sends `props`/`input`/`source` as a JSON **string**. On the compact
 * `figpea_call` dispatcher that works — REQ-1280 reordered the parse above the
 * translation for exactly this reason. On the **full** lane, which is the
 * library default (`mcpServer.ts:459` — `options?.toolMode ?? 'full'`), the
 * same payload reached a file method and the handler threw
 * `TypeError: Cannot use 'in' operator to search for 'filePath' in …` **out of
 * the handler** — the only `try` in this path wraps `bridge.callTab`, so the
 * failure escaped as plain text with no `code`, no `value` and no progress.
 *
 * MEASURED PRE-FIX OUTPUT (recorded on this worktree at `405362d`, before any
 * edit, with the stub tab and a real temp PNG the harness below uses). Verbatim
 * `content[0].text` of `layer_create({kind:'image',
 * props:'{"name":"x","rwidth":10,"rheight":10,"filePath":"<tmp>/probe.png"}'})`
 * in full mode, `_rawJson:true` and unflagged alike — `isError=true`,
 * `callTab` count **0** in both:
 *
 *     Cannot use 'in' operator to search for 'filePath' in {"name":"x","rwidth":10,"rheight":10,"filePath":"/var/folders/qh/217s2tvx29q9l8w5cmndjx700000gp/T/req1337-probe-fgjBKP/probe.png"}
 *
 * — no `{`, no `ok`, no `code`, and nothing the tab was ever asked. The temp
 * directory is per-run and is the only part that moves; the surrounding text is
 * byte-stable. The same call on the compact dispatcher returned `{ok:true,…}`
 * with the tab receiving `{"url":"http://localhost:54317/file?path=%2F…",
 * "fileName":"probe.png"}`. That string is recorded here and in the dev log
 * rather than asserted, because after this fix no input can produce it: the
 * committed tests keep the exact repro call and assert the **negative** (the
 * signature never appears on either lane), which is strictly stronger than a
 * test that merely documents it.
 *
 * Vehicle: this repo has no Playwright lane, no browser and no UI, so "e2e" is
 * a real MCP SDK `Client` over `InMemoryTransport` driving the real server —
 * a genuine `registerTool` → `safeParseAsync` → handler → `callTab` round trip
 * with a **stub tab** standing in for the paired editor. The stub applies v3's
 * real `validateArgs` rule to the declared fixture schema and ECHOES what it
 * received, so "the tab received a real object" is never satisfiable by a stub
 * that ignores its input, and `callTab` is counted so round trips are asserted
 * rather than assumed. The stub deliberately has **no `getFileUrl`**, so the
 * URL asserted below is the server's own constructed string
 * (`http://<BRIDGE_URL_HOST>:<port>/file?path=<encoded>`), the product's
 * construction rather than a copy of it re-inflated by the test: each lane's
 * own `toBridgeUrl` builds it — `mcpServer.ts:900` (compact) and `mcpServer.ts:1515`
 * (full). Cited by symbol and by BOTH sites on purpose: a bare single line
 * number is exactly what this REQ's own T3 invalidated once, when the hoist
 * moved the full-lane construction 92 lines down.
 *
 * AC map (see `docs/plans/REQ-1337-6ab96384.md` §Use cases → task → test):
 *  - AC-1  full mode + `_rawJson` + a stringified file payload → the structured
 *          `{ok:true, value:{id}}` envelope, and the tab receives the bridge
 *          `url` with `filePath` deleted — for all three file methods, and the
 *          raw `TypeError` signature appears on neither lane
 *  - AC-2  the same three methods with the flag ABSENT → a parseable envelope
 *          deep-equal to the compact lane's in `code`, `message`, round trips
 *          and captured args; plus the row where AC-2's literal "0 round trips"
 *          is literally true (a payload naming a file that does not exist)
 *  - AC-3  compact and full, the same FLAGGED stringified payload → the
 *          captured positional args are deep-equal
 *  - AC-4  a real (non-stringified) object still translates on both lanes, and
 *          the three shipped full-lane file suites stay green unedited
 *  - AC-5  the matrix {3 methods} × {compact, full} × {stringified, real object}
 *          returns a parseable envelope and throws in NO cell; the guard rows
 *          that keep the three type guards load-bearing; and a generalised
 *          sweep over every generated tool's structured-declared positions in
 *          both lanes, so a file method added later is covered without naming
 *          it — and with NO source-text assertion anywhere in this file, so an
 *          unrelated rename breaks nothing
 *  - AC-7  the README's `_rawJson` paragraph and `figpea_call`'s `_rawJson`
 *          `.describe()` are read from their real source and every claim they
 *          make is then driven BEHAVIOURALLY in both lanes, flagged and
 *          unflagged (a source-text test cannot prove truth; `readme.test.ts`
 *          owns "the README says it", this file owns "it is true")
 *  - AC-6  is a gate, not a behaviour: the five named suites and `typecheck`
 *          run green with `git diff` empty against them (recorded in the dev
 *          log, not asserted here — there is nothing to assert about a diff
 *          from inside the suite it guards).
 */

// ── fixture manifests ────────────────────────────────────────────────────────
// Purpose-built, transcribing the REAL declarations for the three file methods
// plus one non-file method with a structured parameter (the generalised sweep
// needs a tool the translation block does not touch, or it proves nothing).

const MANIFEST = {
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
            fileName: { type: 'string', required: false },
            name: { type: 'string', required: false },
          },
        },
      },
      result: 'void',
    },
  },
  layer: {
    setImageFill: {
      doc: "Sets a layer's image fill.",
      params: {
        id: { type: 'string', required: true },
        source: {
          type: 'object',
          required: true,
          shape: {
            url: { type: 'string', required: false },
            filePath: { type: 'string', required: false },
            rwidth: { type: 'number', required: false },
            rheight: { type: 'number', required: false },
          },
        },
      },
      result: 'void',
    },
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
          },
        },
      },
      result: { id: 'string' },
    },
    batch: {
      doc: 'Applies a sequence of layer ops as ONE undo step, all-or-nothing.',
      params: {
        ops: {
          type: 'array',
          required: true,
          of: { type: 'object', required: true, shape: { method: { type: 'string', required: true }, args: { type: 'array', required: true } } },
        },
      },
      result: 'ops results',
    },
  },
} as unknown as ManifestLike;

/** A pre-REQ-093 manifest — `params` values are free-text hints, so NO param has
 *  a structured schema and the schema-scoped (flag-less) parse has nothing to
 *  reason from. This is the full lane's reachable form of "the parse cannot
 *  rescue this value": a generated full-mode tool cannot exist without a
 *  manifest at all (`registerContractTools` is manifest-driven), so the
 *  published-npm "no `describe()` yet" case lands here instead. */
const LEGACY_MANIFEST = {
  session: {
    openFile: {
      doc: 'Opens a file in the editor.',
      params: { input: 'an object carrying a url or a filePath' },
      result: 'void',
    },
  },
  layer: {
    setImageFill: {
      doc: "Sets a layer's image fill.",
      params: { id: 'a string layer id', source: 'an object carrying a url or a filePath' },
      result: 'void',
    },
    create: {
      doc: 'Creates a layer of the given kind.',
      params: { kind: 'a string: page, rect, line, polygon, text or image', props: 'an object of create properties' },
      result: 'the new layer id',
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
 *  without its group prefix on BOTH lanes. */
const DECLARED: Record<string, Record<string, string>> = {
  openFile: { input: 'object' },
  setImageFill: { id: 'string', source: 'object' },
  create: { kind: 'string', props: 'object' },
  batch: { ops: 'array' },
};

/** v3's `validateArgs` (validateArgs.ts:154-170): the FIRST positional arg that
 *  does not match its declared type is rejected with
 *  `${method}(): ${key} must be ${declared} (got ${receivedTypeName(arg)})` and
 *  code `invalid_params`. */
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
      return { ok: false, code: 'invalid_params', message: `${method}(): ${key} must be ${declared[key]} (got ${receivedTypeName(arg)})` };
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
      return { id: 'L_probe', name: props?.name ?? null };
    }
    case 'openFile': {
      const input = args[0] as Record<string, unknown> | undefined;
      return { fileName: input?.fileName ?? null };
    }
    case 'setImageFill':
      return { id: args[0], source: args[1] };
    case 'batch': {
      const ops = args[0] as Array<{ method: string }>;
      return { results: ops.map((op, i) => ({ opIndex: i, ok: true, value: { id: `L_${op.method}_${i}` } })) };
    }
    default:
      return null;
  }
}

interface Capture {
  group: string;
  method: string;
  args: unknown[];
}

/** The stub. No `getFileUrl` — deliberately, so the URL the tests assert is the
 *  one `mcpServer.ts` builds itself (see the header). */
function makeStub(opts?: { deliverManifest?: unknown }) {
  const captured: Capture[] = [];
  const deliver = 'deliverManifest' in (opts ?? {}) ? opts!.deliverManifest : MANIFEST;
  const stub = {
    port: 54317,
    token: 'test-token-1337',
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

async function connect(bridge: unknown, mode: Mode, opts?: { deliverManifest?: unknown }) {
  const { stub, captured } = makeStub(opts);
  const server = createMcpServer(stub as never, { toolMode: mode } as never);
  const client = new Client({ name: 'req-1337-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, captured };
}

interface Outcome {
  /** The tool result's text, verbatim. A thrown handler lands here as plain
   *  text, which is the whole defect this REQ exists to close. */
  raw: string;
  /** The parsed envelope, or the `{ok:false, code:'non_envelope'}` sentinel
   *  when the handler threw instead of answering. */
  env: any;
}

/** Drive one tool through the real protocol and keep BOTH the raw text and the
 *  parsed envelope: AC-1's contract is about the text, AC-2's about the
 *  envelope, and neither can substitute for the other. */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Outcome> {
  let raw = '';
  try {
    const result: any = await client.callTool({ name, arguments: args } as any);
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    raw = content.find((c) => c.type === 'text')?.text ?? '';
  } catch (e) {
    raw = e instanceof Error ? e.message : String(e);
  }
  if (!raw.trimStart().startsWith('{')) return { raw, env: { ok: false, code: 'non_envelope', message: raw } };
  return { raw, env: JSON.parse(raw) };
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

function tempImageFile(prefix = 'probe'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1337-'));
  tempDirs.push(dir);
  const file = path.join(dir, `${prefix}.png`);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return file;
}

const MISSING_FILE = '/tmp/req1337-does-not-exist/probe.png';

/** The bridge URL the tab received is the server's own construction — so assert
 *  its shape and what it decodes to, never a string this file re-inflated. */
function expectBridgeUrl(value: unknown, filePath: string): void {
  expect(typeof value, 'the payload carries a string url').toBe('string');
  const url = value as string;
  expect(url).toMatch(/^http:\/\/localhost:\d+\/file\?path=/);
  expect(url, 'the local path travels inside the url, encoded').toContain(encodeURIComponent(filePath));
  expect(new URL(url).searchParams.get('path'), 'and decodes back to the file on disk').toBe(filePath);
}

/** Every outcome is a parseable envelope and never the raw `TypeError`. This is
 *  AC-5's cell-level assertion and AC-1's negative, in one place. */
function expectEnvelope(what: string, { raw, env }: Outcome): void {
  expect(raw.trimStart().startsWith('{'), `${what}: answered with a JSON envelope, not plain text`).toBe(true);
  expect(typeof env.ok, `${what}: envelope carries ok`).toBe('boolean');
  if (env.ok === false) {
    expect(typeof env.code, `${what}: a refusal carries code`).toBe('string');
    expect(typeof env.message, `${what}: a refusal carries message`).toBe('string');
  }
  expect(raw, `${what}: never the unenveloped 'in' operator TypeError`).not.toContain("Cannot use 'in' operator");
  expect(env.code, `${what}: never the non_envelope sentinel`).not.toBe('non_envelope');
}

// ── the three file methods, one table, reused by every row below ────────────

interface FileMethod {
  id: string;
  group: string;
  method: string;
  /** index of the file-bearing value inside the CAPTURED positional args */
  payloadIndex: number;
  /** the full-mode parameter name that carries it — the README's "the
   *  parameter" in the loud-failure message */
  payloadKey: string;
  /** the real, non-stringified payload the tab must end up receiving */
  payloadObject: (file: string) => Record<string, unknown>;
  /** the two lanes' argument shapes, given whatever value goes at the
   *  file-bearing position (a real object, or a string of any shape) */
  argsOf: (payload: unknown) => { compact: unknown[]; full: Record<string, unknown> };
  /** the code both lanes refuse a missing local file with */
  missingCode: string;
}

const FILE_METHODS: FileMethod[] = [
  {
    id: 'session.openFile',
    group: 'session',
    method: 'openFile',
    payloadIndex: 0,
    payloadKey: 'input',
    payloadObject: (file) => ({ filePath: file }),
    argsOf: (p) => ({ compact: [p], full: { input: p } }),
    missingCode: 'open_failed',
  },
  {
    id: 'layer.setImageFill',
    group: 'layer',
    method: 'setImageFill',
    payloadIndex: 1,
    payloadKey: 'source',
    payloadObject: (file) => ({ filePath: file }),
    argsOf: (p) => ({ compact: ['L_hero', p], full: { id: 'L_hero', source: p } }),
    missingCode: 'invalid_image_source',
  },
  {
    id: 'layer.create',
    group: 'layer',
    method: 'create',
    payloadIndex: 1,
    payloadKey: 'props',
    payloadObject: (file) => ({ name: 'x', rwidth: 10, rheight: 10, filePath: file }),
    argsOf: (p) => ({ compact: ['image', p], full: { kind: 'image', props: p } }),
    missingCode: 'invalid_image_source',
  },
];

/** One lane's spelling of one method call. `payload` is whatever goes at the
 *  file-bearing position; `flag` adds `_rawJson` in whichever spelling the lane
 *  advertises it in. */
async function drive(client: Client, mode: Mode, m: FileMethod, payload: unknown, flag?: boolean): Promise<Outcome> {
  const { compact, full } = m.argsOf(payload);
  if (mode === 'compact') {
    return callTool(client, 'figpea_call', { group: m.group, method: m.method, args: compact, ...(flag ? { _rawJson: true } : {}) });
  }
  return callTool(client, m.group + '_' + m.method, { ...full, ...(flag ? { _rawJson: true } : {}) });
}

// ─────────────────────────────────────────────────────── AC-1 ──────────────

describe('REQ-1337 AC-1 — full mode, flag on, stringified file payload', () => {
  for (const m of FILE_METHODS) {
    it(`${m.id}: the tab receives a bridge url with filePath deleted, never a thrown TypeError`, async () => {
      const png = tempImageFile();
      const { client, captured } = await connect(undefined, 'full');

      const out = await drive(client, 'full', m, JSON.stringify(m.payloadObject(png)), true);

      expectEnvelope(`${m.id} (full, flagged)`, out);
      expect(out.env.ok, `${m.id}: the call succeeds`).toBe(true);
      expect(out.env.value, `${m.id}: the structured value envelope`).toBeTruthy();
      expect(captured, `${m.id}: one round trip`).toHaveLength(1);
      const received = captured[0]!.args[m.payloadIndex];
      expect(typeof received, `${m.id}: the tab received a real object, not the string`).toBe('object');
      expectBridgeUrl((received as Record<string, unknown>).url, png);
      expect(hasKeyAtAnyDepth(received, 'filePath'), `${m.id}: filePath is deleted at every depth`).toBe(false);
    });
  }

  it('the raw TypeError signature this REQ exists to close appears on NEITHER lane', async () => {
    // AC-1's negative, in the file header's own terms: the repro call is kept
    // verbatim and asserted NOT to produce the unenveloped throw it used to.
    const png = tempImageFile();
    for (const mode of ['full', 'compact'] as Mode[]) {
      const { client, captured } = await connect(undefined, mode);
      for (const flag of [true, false]) {
        for (const m of FILE_METHODS) {
          const out = await drive(client, mode, m, JSON.stringify(m.payloadObject(png)), flag);
          expect(out.raw, `${m.id} (${mode}, ${flag ? 'flagged' : 'unflagged'})`).not.toContain("Cannot use 'in' operator");
          expect(out.env.code, `${m.id} (${mode}, ${flag ? 'flagged' : 'unflagged'})`).not.toBe('non_envelope');
        }
      }
      expect(captured.length, `${mode}: the six calls reached the tab rather than throwing at it`).toBe(6);
    }
  });
});

// ─────────────────────────────────────────────────────── AC-2 ──────────────

describe('REQ-1337 AC-2 — the same three methods with NO flag: compact parity', () => {
  for (const m of FILE_METHODS) {
    it(`${m.id}: full is deep-equal to the compact lane's shipped semantics`, async () => {
      const png = tempImageFile();
      const stringified = JSON.stringify(m.payloadObject(png));
      const compactRun = await connect(undefined, 'compact');
      const fullRun = await connect(undefined, 'full');

      const compact = await drive(compactRun.client, 'compact', m, stringified, false);
      const full = await drive(fullRun.client, 'full', m, stringified, false);

      expectEnvelope(`${m.id} (compact, unflagged)`, compact);
      expectEnvelope(`${m.id} (full, unflagged)`, full);
      // The compact handler's shipped semantics ARE the contract.
      expect(full.env.code, `${m.id}: the same code as the compact lane`).toEqual(compact.env.code);
      expect(full.env.message, `${m.id}: the same message as the compact lane`).toEqual(compact.env.message);
      expect(fullRun.captured.length, `${m.id}: the same round-trip count as the compact lane`).toEqual(compactRun.captured.length);
      expect(fullRun.captured[0]!.args, `${m.id}: the same captured args as the compact lane`).toEqual(compactRun.captured[0]!.args);
      // …and what those shipped semantics are, stated outright rather than
      // inherited: parsed, translated, and the value the tab receives is real.
      expect(full.env.ok, `${m.id}: both lanes succeed on the same payload`).toBe(true);
      expectBridgeUrl((fullRun.captured[0]!.args[m.payloadIndex] as Record<string, unknown>).url, png);
    });

    it(`${m.id}: a payload naming a file that does not exist is refused at 0 round trips on both lanes`, async () => {
      // The row where AC-2's literal "0 round trips" is literally true: the
      // pre-flight refuses before the tab is ever asked.
      const stringified = JSON.stringify(m.payloadObject(MISSING_FILE));
      const compactRun = await connect(undefined, 'compact');
      const fullRun = await connect(undefined, 'full');

      const compact = await drive(compactRun.client, 'compact', m, stringified, false);
      const full = await drive(fullRun.client, 'full', m, stringified, false);

      expectEnvelope(`${m.id} (compact, missing file)`, compact);
      expectEnvelope(`${m.id} (full, missing file)`, full);
      expect(compact.env.ok, `${m.id}: refused`).toBe(false);
      expect(compactRun.captured, `${m.id}: the compact lane spends no round trip`).toHaveLength(0);
      expect(fullRun.captured, `${m.id}: full spends no round trip either`).toHaveLength(0);
      expect(full.env.code, `${m.id}: the same refusal code on both lanes`).toEqual(compact.env.code);
      expect(full.env.code, `${m.id}: the documented refusal code`).toBe(m.missingCode);
      expect(full.env.message, `${m.id}: byte-identical message text on both lanes`).toEqual(compact.env.message);
      expect(full.env.message, `${m.id}: names the unreadable path`).toContain(MISSING_FILE);
    });
  }
});

// ─────────────────────────────────────────────────────── AC-3 ──────────────

describe('REQ-1337 AC-3 — flagged cross-lane parity of the CAPTURED args', () => {
  for (const m of FILE_METHODS) {
    it(`${m.id}: compact and full deliver deep-equal positional args`, async () => {
      const png = tempImageFile();
      const stringified = JSON.stringify(m.payloadObject(png));
      const compactRun = await connect(undefined, 'compact');
      const fullRun = await connect(undefined, 'full');

      await drive(compactRun.client, 'compact', m, stringified, true);
      await drive(fullRun.client, 'full', m, stringified, true);

      expect(compactRun.captured, `${m.id}: compact relayed once`).toHaveLength(1);
      expect(fullRun.captured, `${m.id}: full relayed once`).toHaveLength(1);
      const compactArgs = compactRun.captured[0]!.args;
      const fullArgs = fullRun.captured[0]!.args;
      expect(fullArgs, `${m.id}: the two lanes deliver the same positional args`).toEqual(compactArgs);
      // Parity asserted on the CAPTURED value, not on the envelope, so a stub
      // that ignored its input could not satisfy it.
      expectBridgeUrl((fullArgs[m.payloadIndex] as Record<string, unknown>).url, png);
      expect(hasKeyAtAnyDepth(fullArgs, 'filePath'), `${m.id}: neither lane forwards filePath`).toBe(false);
      expect(hasKeyAtAnyDepth(compactArgs, 'filePath'), `${m.id}: neither lane forwards filePath`).toBe(false);
      expect(hasKeyAtAnyDepth(fullArgs, '_rawJson'), `${m.id}: the flag never reaches the tab`).toBe(false);
      expect(hasKeyAtAnyDepth(compactArgs, '_rawJson'), `${m.id}: the flag never reaches the tab`).toBe(false);
    });
  }
});

// ─────────────────────────────────────────────────────── AC-4 ──────────────

describe('REQ-1337 AC-4 — a real object filePath still translates (no regression)', () => {
  for (const mode of ['full', 'compact'] as Mode[]) {
    for (const m of FILE_METHODS) {
      it(`${m.id} on ${mode}: bridge url produced, filePath deleted`, async () => {
        const png = tempImageFile();
        const { client, captured } = await connect(undefined, mode);

        const out = await drive(client, mode, m, m.payloadObject(png), false);

        expectEnvelope(`${m.id} (${mode}, real object)`, out);
        expect(out.env.ok, `${m.id}: the shipped behaviour is unchanged`).toBe(true);
        expect(captured, `${m.id}: one round trip`).toHaveLength(1);
        const received = captured[0]!.args[m.payloadIndex];
        expect(typeof received, `${m.id}: a real object in`).not.toBe('string');
        expectBridgeUrl((received as Record<string, unknown>).url, png);
        expect(hasKeyAtAnyDepth(received, 'filePath'), `${m.id}: filePath deleted`).toBe(false);
      });
    }
  }
});

// ─────────────────────────────────────────────────────── AC-5 ──────────────

describe('REQ-1337 AC-5 — the full matrix throws in no cell', () => {
  for (const mode of ['compact', 'full'] as Mode[]) {
    for (const m of FILE_METHODS) {
      for (const encoding of ['stringified', 'real object'] as const) {
        for (const flag of [true, false]) {
          it(`${m.id} × ${mode} × ${encoding} × ${flag ? 'flagged' : 'unflagged'} → parseable envelope`, async () => {
            const png = tempImageFile();
            const payload = encoding === 'stringified' ? JSON.stringify(m.payloadObject(png)) : m.payloadObject(png);
            const { client, captured } = await connect(undefined, mode);

            const out = await drive(client, mode, m, payload, flag);

            expectEnvelope(`${m.id} × ${mode} × ${encoding} × ${flag}`, out);
            expect(captured.length, `${m.id}: one call costs at most one round trip`).toBeLessThanOrEqual(1);
          });
        }
      }
    }
  }
});

describe('REQ-1337 AC-5 — the rows that keep the three type guards load-bearing', () => {
  // ⛔ These are the cells a future "the parse runs first now, the guard must be
  // dead code" deletion breaks. Each puts a NON-OBJECT at the file-bearing
  // position in a way the parse provably leaves alone, so the value still
  // reaches the guard. None of them asserts TRANSLATION: a value the server
  // cannot see into is the tab's business to reject, and the only contract
  // here is that it is rejected with an envelope rather than a thrown
  // `TypeError` that escapes the handler entirely.

  /** A value the parse leaves exactly as sent, per lane and manifest:
   *  - `no declaration reachable` — a legacy free-text manifest has no
   *    structured schema, so the schema-scoped parse skips the position;
   *  - `plain string` — does not look like JSON, so `parseRawJsonValue` returns
   *    it untouched even where a schema DOES exist;
   *  - `unparseable` — looks like JSON, does not parse, and the flag-less
   *    branch leaves it alone (it reports nothing by construction);
   *  - `wrong shape` — parses to an ARRAY at an `object`-declared position, so
   *    the flag-less parse's shape check leaves it alone.
   *  The FLAGGED spelling of the last two is deliberately absent: the flag's
   *  branch refuses an unparseable value at a declared-structured position with
   *  `invalid_params` (AC-7's loud failure) instead of forwarding it, and a
   *  valid array is parsed wherever it sits. */
  const SURVIVORS: Array<{ why: string; value: (png: string) => string; legacy?: boolean; flag?: boolean }> = [
    { why: 'no declaration reachable (legacy free-text manifest)', value: (png) => JSON.stringify({ filePath: png }), legacy: true },
    { why: 'a plain, non-JSON string', value: () => 'not json at all' },
    { why: 'a JSON-looking value that cannot be parsed', value: () => '{name: "x"}' },
    { why: 'a JSON array at an object-declared position', value: () => '[{"filePath":"/tmp/x.png"}]' },
  ];

  for (const survivor of SURVIVORS) {
    for (const m of FILE_METHODS) {
      it(`${m.id}: ${survivor.why} → an envelope, not a throw (full lane)`, async () => {
        const png = tempImageFile();
        const { client, captured } = await connect(undefined, 'full', survivor.legacy ? { deliverManifest: LEGACY_MANIFEST } : undefined);

        const out = await drive(client, 'full', m, survivor.value(png), survivor.flag);

        expectEnvelope(`${m.id} (full, ${survivor.why})`, out);
        expect(captured.length, `${m.id}: whatever happened, it was an answer, not a throw`).toBeLessThanOrEqual(1);
      });

      it(`${m.id}: ${survivor.why} → an envelope, not a throw (compact lane)`, async () => {
        const png = tempImageFile();
        const { client } = await connect(undefined, 'compact', survivor.legacy ? { deliverManifest: LEGACY_MANIFEST } : undefined);

        const out = await drive(client, 'compact', m, survivor.value(png), survivor.flag);

        expectEnvelope(`${m.id} (compact, ${survivor.why})`, out);
      });
    }
  }

  it('the published-npm standalone case: no manifest in memory at all', async () => {
    // Full mode cannot reach this — a generated tool does not exist without a
    // manifest — so the row lives on the compact lane, which is where the
    // shipped "no `describe()` yet" case actually is. Pinned here so the two
    // lanes' guard behaviour stays comparable.
    const png = tempImageFile();
    for (const m of FILE_METHODS) {
      const { client } = await connect(undefined, 'compact', { deliverManifest: undefined });
      const out = await drive(client, 'compact', m, JSON.stringify(m.payloadObject(png)), true);
      expectEnvelope(`${m.id} (compact, no manifest)`, out);
    }
  });
});

describe('REQ-1337 AC-5 — the generalised sweep over every structured position', () => {
  // The matrix above names three methods; this does not name any. It walks the
  // fixture manifest, asks the SERVER for the tools it registered, and sends a
  // JSON-looking string at every `object`/`array`/`matrix`-declared position in
  // both lanes — which is what makes "a file method added later fails this"
  // true in the literal sense. Asserted on ONE thing only (a parseable
  // envelope, no throw): whether a given payload is acceptable is the tab's
  // answer, and this row is about the server surviving to give it.

  const structuredPositions = () => {
    const rows: Array<{ tool: string; group: string; method: string; index: number; type: string; key: string }> = [];
    for (const [group, methods] of Object.entries(MANIFEST as unknown as Record<string, Record<string, { params: Record<string, { type?: string }> }>>)) {
      for (const [method, descriptor] of Object.entries(methods)) {
        Object.entries(descriptor.params ?? {}).forEach(([key, raw], index) => {
          const type = (raw as { type?: string })?.type ?? '';
          if (type === 'object' || type === 'array' || type === 'matrix') {
            rows.push({ tool: `${group}_${method}`, group, method, index, type, key });
          }
        });
      }
    }
    return rows;
  };

  it('every generated tool, every structured-declared position, both lanes → envelope, never a throw', async () => {
    const png = tempImageFile();
    const sample = (type: string) => (type === 'object' ? `{"filePath":"${png}"}` : '[1,0,0,1,0,0]');
    const rows = structuredPositions();
    expect(rows.length, 'the fixture manifest has structured positions to sweep').toBeGreaterThan(0);

    const fullRun = await connect(undefined, 'full');
    const compactRun = await connect(undefined, 'compact');

    // The tools are read from the server, not assumed — the sweep follows
    // whatever `tools/list` says exists.
    const registered = new Set(((await fullRun.client.listTools()).tools as Array<{ name: string }>).map((t) => t.name));
    for (const row of rows) {
      expect(registered.has(row.tool), `${row.tool} is a registered full-mode tool`).toBe(true);

      // Full mode names its parameters; compact mode takes them positionally,
      // so the same position is filled in both spellings of the same call.
      const compactArgs: unknown[] = [];
      while (compactArgs.length < row.index) compactArgs.push(undefined);
      compactArgs.push(sample(row.type));

      const fullOut = await callTool(fullRun.client, row.tool, { [row.key]: sample(row.type) });
      const compactOut = await callTool(compactRun.client, 'figpea_call', { group: row.group, method: row.method, args: compactArgs, _rawJson: true });
      expectEnvelope(`${row.tool}.${row.key} (full, sweep)`, fullOut);
      expectEnvelope(`${row.group}.${row.method}.${row.key} (compact, sweep)`, compactOut);
    }
  });
});

// ─────────────────────────────────────────────────────── AC-7 ──────────────

describe('REQ-1337 AC-7 — every claim the README and the .describe() make is true of BOTH modes', () => {
  it('the advertised _rawJson description says what this file then proves', async () => {
    // VERIFY-THEN-PIN (the REQ-1280 T3 technique): the text is read from the
    // server's own advertised `inputSchema` — the `_rawJson` description is a
    // PROPERTY of `figpea_call`, not part of the tool's own description, so
    // this cannot drift from what ships. The claims are the three that
    // description makes; each is driven behaviourally in the rows below rather
    // than trusted here.
    const { client } = await connect(undefined, 'compact');
    const tool = ((await client.listTools()).tools as Array<{
      name: string;
      inputSchema?: { properties?: Record<string, { description?: string }> };
    }>).find((t) => t.name === 'figpea_call');
    expect(tool, 'compact mode advertises figpea_call').toBeDefined();
    const description = tool!.inputSchema?.properties?.['_rawJson']?.description ?? '';
    expect(description, 'the flag is advertised at all').toContain('_rawJson');
    // ⛔ RE-POINTED by REQ-1338, and NOT weakened — the same claim in a wider
    // form. This read `/declares as an object\/array is parsed with no flag/`,
    // and the new description widens the enumeration to `object/array/matrix`
    // (the guard has always fired on `matrix`; REQ-1280's reviewer called the
    // old wording an under-promise). The literal substring is gone, the CLAIM
    // is not, so the pin follows the claim rather than the letter.
    expect(description, 'claim 1: a declared object/array/matrix param needs no flag').toMatch(/object\/array\/matrix is parsed with no flag/i);
    // This read `/schema-blind/` — a property the flag no longer has, since
    // REQ-1338 made its parse declaration-scoped too. Re-pointed POSITIVELY,
    // to the rule that replaced it (a declared scalar is NEVER parsed, even
    // when its text is valid JSON), plus an absence guard mirroring the
    // README's, so the falsified framing cannot be restored in one place and
    // removed from the other.
    expect(description, 'claim 2: a declared scalar is NEVER parsed, whatever its text').toMatch(/declares a string\/number\/boolean is NEVER parsed/i);
    expect(description, 'claim 2: the falsified "schema-blind" framing is GONE').not.toMatch(/schema-blind/);
    expect(description, 'claim 3: a value that looks like JSON but cannot be parsed is refused, not forwarded').toMatch(/cannot be parsed/);
  });

  it('the README paragraph is the one the text pin already holds', async () => {
    // The text half belongs to `readme.test.ts`, which is unedited by this REQ.
    // What is re-read here is that the two artefacts this AC names are still
    // the ones being relied on, so a rename cannot quietly move the contract.
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('_rawJson');
    expect(readme, 'the flag is claimed to work on both modes').toMatch(/both.*tool modes/i);
    expect(readme, 'and the no-flag default route is claimed too').toMatch(/no flag/i);
  });

  it('claim 1 — the README\'s own full-mode example arrives parsed, on BOTH lanes', async () => {
    // `figpea_layer_create({kind:'page', props:'{"pageWidth":1500}', _rawJson:true})`
    // — README.md's worked example, verbatim, in both spellings.
    const props = '{"pageWidth":1500}';
    for (const mode of ['full', 'compact'] as Mode[]) {
      const { client, captured } = await connect(undefined, mode);
      const out = mode === 'compact'
        ? await callTool(client, 'figpea_call', { group: 'layer', method: 'create', args: ['page', props], _rawJson: true })
        : await callTool(client, 'layer_create', { kind: 'page', props, _rawJson: true });
      expectEnvelope(`README flag example (${mode})`, out);
      expect(out.env.ok, `README flag example (${mode}) succeeds`).toBe(true);
      expect(captured[0]!.args[1], `README flag example (${mode}) arrives parsed`).toEqual({ pageWidth: 1500 });
    }
  });

  it('claim 1 — the file-method variant arrives as a bridge url on BOTH lanes', async () => {
    for (const mode of ['full', 'compact'] as Mode[]) {
      for (const m of FILE_METHODS) {
        const png = tempImageFile();
        const { client, captured } = await connect(undefined, mode);
        const out = await drive(client, mode, m, JSON.stringify(m.payloadObject(png)), true);
        expectEnvelope(`${m.id} (${mode}, README file variant)`, out);
        expect(out.env.ok, `${m.id} (${mode}): succeeds`).toBe(true);
        expectBridgeUrl((captured[0]!.args[m.payloadIndex] as Record<string, unknown>).url, png);
      }
    }
  });

  it('claim 2 — the same payloads need NO flag on either lane', async () => {
    // README.md: "a parameter the manifest **declares** as an
    // `object`/`array`/`matrix` may travel as a JSON string, and the server
    // parses it". This is the row that fails if only the FLAG branch is moved
    // above the translation.
    for (const mode of ['full', 'compact'] as Mode[]) {
      const { client, captured } = await connect(undefined, mode);
      const noFlag = mode === 'compact'
        ? await callTool(client, 'figpea_call', { group: 'layer', method: 'create', args: ['page', '{"pageWidth":1500}'] })
        : await callTool(client, 'layer_create', { kind: 'page', props: '{"pageWidth":1500}' });
      expectEnvelope(`README no-flag example (${mode})`, noFlag);
      expect(captured[0]!.args[1], `README no-flag example (${mode}) arrives parsed`).toEqual({ pageWidth: 1500 });

      for (const m of FILE_METHODS) {
        const png = tempImageFile();
        const out = await drive(client, mode, m, JSON.stringify(m.payloadObject(png)), false);
        expectEnvelope(`${m.id} (${mode}, README no-flag file variant)`, out);
        expect(out.env.ok, `${m.id} (${mode}, no flag): succeeds`).toBe(true);
        expectBridgeUrl((captured[captured.length - 1]!.args[m.payloadIndex] as Record<string, unknown>).url, png);
      }
    }
  });

  it('claim 3 — the documented loud failure fires up front on BOTH lanes', async () => {
    // README.md: "If a value *looks* like JSON but cannot be parsed, and the
    // parameter is declared an `object`, `array` or `matrix`, the call is
    // refused up front with invalid_params naming `_rawJson` and the parameter,
    // instead of being silently forwarded."
    const broken = '{name: "x"}';
    for (const mode of ['full', 'compact'] as Mode[]) {
      for (const m of FILE_METHODS) {
        const { client, captured } = await connect(undefined, mode);
        const out = await drive(client, mode, m, broken, true);
        expectEnvelope(`${m.id} (${mode}, loud failure)`, out);
        expect(out.env.ok, `${m.id} (${mode}): refused`).toBe(false);
        expect(out.env.code, `${m.id} (${mode}): invalid_params`).toBe('invalid_params');
        expect(out.env.message, `${m.id} (${mode}): names the flag`).toContain('_rawJson');
        expect(out.env.message, `${m.id} (${mode}): names the parameter`).toContain(m.payloadKey);
        expect(captured, `${m.id} (${mode}): refused up front, before the tab`).toHaveLength(0);
      }
    }
  });
});
