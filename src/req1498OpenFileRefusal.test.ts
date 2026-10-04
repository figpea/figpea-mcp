import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { findSingularFilePathMismatch } from './argShape';

/**
 * REQ-1498 (AC-6, AC-7, AC-8) — a bare path where `session.openFile`'s object
 * belongs is forwarded verbatim and comes back `ok:true`.
 *
 * The card's failure: `figpea_call({group:'session', method:'openFile',
 * args:['/abs/path/x.fp']})` reported success while opening nothing. An agent
 * that trusts that stops checking — the failure class this brand cannot afford.
 *
 * **MEASURED PRE-FIX, and it is not what the card recorded.** Walked through
 * this server on the unfixed tree, every pre-flight DECLINES a string at an
 * object slot: `applyStructuredStringJson` skips it (not JSON-looking),
 * `refuseFilePathEnvelope` needs a plain object (argShape.ts:598), and
 * `findArgShapeMismatch`'s Rule C fires only on a JSON-LOOKING string
 * (argShape.ts:205, and the deliberate narrowing at :190-204). So the string is
 * forwarded verbatim and the `ok:true` is the TAB's answer, not this server's.
 * On the current editor that tab refuses it — `validateEntryArgs` runs at
 * `v3/src/agent/registry.ts:160` and only `batch` is exempt, so
 * `validateArgs.ts:163` answers `invalid_params: input must be object (got
 * string)` — which is why the card's observation was made against a build
 * without REQ-770's entry validation.
 *
 * What ships, therefore, is NOT "we repaired a silent ok:true". It is a
 * refusal that costs **zero** round trips, names the argument it wanted, and
 * holds against ANY paired editor build — including one that answers `ok:true`.
 * The stub tab below deliberately answers `ok:true` to anything it is asked, so
 * every row here is a measurement of the RELAY: if the tab is never asked, the
 * refusal is the relay's own.
 *
 * AC-8 is the counterweight: the well-formed form must keep working exactly as
 * it does today, and its refusals must be the LIVE siblings' answers rather than
 * copied strings.
 */

// ── fixture manifest ────────────────────────────────────────────────────────
// `session.openFile`'s declared union, `layer.create`'s `props` and
// `layer.setImageFill`'s `source` — the three object params whose declared
// shapes carry a `filePath` key, which is what the new rule is derived from.

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
            bytes: { type: 'string', required: false },
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
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'text', 'image'] },
        props: {
          type: 'object',
          required: false,
          shape: {
            name: { type: 'string', required: false },
            rwidth: { type: 'number', required: false },
            filePath: { type: 'string', required: false },
          },
        },
      },
      result: { id: 'string' },
    },
    setImageFill: {
      doc: "Sets a layer's image fill from a source object.",
      params: {
        id: { type: 'string', required: true },
        source: {
          type: 'object',
          required: true,
          shape: { url: { type: 'string', required: false }, filePath: { type: 'string', required: false } },
        },
      },
      result: 'void',
    },
  },
};

interface Capture {
  group: string;
  method: string;
  args: unknown[];
}

/** A tab that answers `ok:true` to EVERYTHING — the card's failure made
 *  faithful, so a refusal can only be the relay's own doing. */
function makeStub() {
  const captured: Capture[] = [];
  const stub = {
    port: 54322,
    token: 'test-token-req1498-openfile',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      h(MANIFEST);
    },
    callTab: async (group: string, method: string, args: unknown[]) => {
      captured.push({ group, method, args: structuredClone(args) });
      return { ok: true, value: { opened: true } };
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

async function connect(bridge: unknown, mode: 'compact' | 'full' = 'compact') {
  const server = createMcpServer(bridge as never, { toolMode: mode } as never);
  const client = new Client({ name: 'req1498-openfile-refusal-test', version: '0.0.0' });
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
  if (!text.trimStart().startsWith('{')) return { ok: false, code: 'non_envelope', message: text };
  return JSON.parse(text);
}

/** A real file on disk — a path that demonstrably exists, so the refusal
 *  cannot be confused with a missing-file answer. */
function realFile(name = 'design.fp'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1498-open-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from([0x00, 0x46, 0x50]));
  return file;
}

function absentPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1498-open-'));
  tempDirs.push(dir);
  return path.join(dir, 'nothing-here.fp');
}

// ─────────────────────────── the singular refusal (AC-6/AC-7) ──────────────

describe('a bare path where the object belongs is refused before the round trip', () => {
  it('compact lane: ok:false, a named code, and the tab is NEVER asked', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = realFile();
    const result = await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [file] });

    expect(result.ok).toBe(false);
    // A NAMED code — the card's evidence is `ok:true`, and "something went
    // wrong" would not be a fix.
    expect(typeof result.code).toBe('string');
    expect(result.code.length).toBeGreaterThan(0);
    expect(result.code).toBe('invalid_params');
    // The card's own evidence, as a measurement: the tab is not asked at all,
    // so the answer cannot be the tab's.
    expect(captured).toHaveLength(0);
  });

  it('full lane: {input: "<path>"} is refused the same way', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const file = realFile();
    const result = await callToolJson(client, 'session_openFile', { input: file });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    expect(captured).toHaveLength(0);
  });

  it('the refusal names the argument it wanted and carries a payload to copy', async () => {
    const { stub } = makeStub();
    const client = await connect(stub);
    const file = realFile();
    const result = await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [file] });

    expect(result.message).toContain('filePath');
    // "so the caller can fix it in one retry": a payload, not an abstract rule.
    expect(result.message).toMatch(/\{\s*"filePath"\s*:/);
    // And the shape of this method, so the retry needs no describe round trip.
    expect(result.message).toContain('Expected');
  });

  it('the corrected call succeeds in the SAME session, one round trip', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = realFile();

    const refused = await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [file] });
    expect(refused.ok).toBe(false);
    expect(captured).toHaveLength(0);

    const fixed = await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [{ filePath: file }] });
    expect(fixed.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('openFile');
  });

  it('the rule is derived, not keyed on a method name: layer.create and layer.setImageFill get it too', async () => {
    for (const [call, method] of [
      [{ group: 'layer', method: 'create', args: ['image', realFile('plate.jpg')] }, 'create'],
      [{ group: 'layer', method: 'setImageFill', args: ['L1', realFile('plate.jpg')] }, 'setImageFill'],
    ] as Array<[Record<string, unknown>, string]>) {
      const { stub, captured } = makeStub();
      const client = await connect(stub);
      const result = await callToolJson(client, 'figpea_call', call);

      expect(result.ok, method).toBe(false);
      expect(result.code, method).toBe('invalid_params');
      expect(result.message, method).toContain('filePath');
      expect(captured, method).toHaveLength(0);
    }
  });

  it('a bare path to a file that is NOT there answers with the site\'s own missing-file code and wording', async () => {
    const missing = absentPath();

    // The LIVE sibling: the same missing file at the well-formed slot.
    const siblingRun = makeStub();
    const siblingClient = await connect(siblingRun.stub);
    const sibling = await callToolJson(siblingClient, 'figpea_call', {
      group: 'session',
      method: 'openFile',
      args: [{ filePath: missing }],
    });

    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const result = await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [missing] });

    expect(result.ok).toBe(false);
    // Measured equality, so the four file refusals in this server cannot drift
    // into four different answers for one absent file.
    expect(result.code).toBe(sibling.code);
    expect(result.message).toBe(sibling.message);
    expect(result.code).toBe('open_failed');
    expect(result.message).toBe(`file not found or not readable: ${missing}`);
    expect(captured).toHaveLength(0);
  });

  it('a bare string is the ONLY thing refused: the correct object, a URL and a JSON-looking string all still go through', async () => {
    // The expensive direction is a FALSE rejection, so the decline set is
    // asserted as first-class rows, not left implicit.
    const file = realFile();
    const cases: Array<[unknown, string]> = [
      [{ url: 'https://example.com/a.fp' }, 'a url-only object (the editor expands it and opens the URL)'],
      [{ filePath: file }, 'the correct object'],
      ['{"filePath":"' + file + '"}', 'a JSON-looking string (REQ-1318 owns this case)'],
      ['  ', 'a blank string'],
      ['', 'an empty string'],
      [null, 'null'],
      [42, 'a number'],
    ];
    for (const [input, label] of cases) {
      const { stub, captured } = makeStub();
      const client = await connect(stub);
      const result = await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [input] });

      expect(result.ok, label).toBe(true);
      expect(captured, label).toHaveLength(1);
    }
  });
});

// ───────────────────────── the well-formed form (AC-8 parity) ──────────────

describe('the well-formed {filePath} form keeps working, unchanged', () => {
  it('compact lane: it still translates to a bridge /file?path= URL, one round trip', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = realFile();
    const result = await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [{ filePath: file }] });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const input = captured[0]!.args[0] as any;
    expect(input.filePath).toBeUndefined();
    expect(String(input.url)).toContain('/file?path=');
    expect(String(input.url)).toContain(encodeURIComponent(file));
  });

  it('full lane: the same translation, this lane\'s own handler', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const file = realFile();
    const result = await callToolJson(client, 'session_openFile', { input: { filePath: file } });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const input = captured[0]!.args[0] as any;
    expect(input.filePath).toBeUndefined();
    expect(String(input.url)).toContain('/file?path=');
    expect(String(input.url)).toContain(encodeURIComponent(file));
  });

  it('its MISSING-file refusal is byte-identical to the sibling branch\'s, on both lanes', async () => {
    const missing = absentPath();

    const compactSiblingRun = makeStub();
    const compactSiblingClient = await connect(compactSiblingRun.stub);
    const compactSibling = await callToolJson(compactSiblingClient, 'figpea_call', {
      group: 'session',
      method: 'openFile',
      args: [{ filePath: missing }],
    });

    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub);
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'session',
      method: 'openFile',
      args: [{ filePath: missing }],
    });
    expect(compactResult.code).toBe(compactSibling.code);
    expect(compactResult.message).toBe(compactSibling.message);
    expect(compactRun.captured).toHaveLength(0);

    const fullSiblingRun = makeStub();
    const fullSiblingClient = await connect(fullSiblingRun.stub, 'full');
    const fullSibling = await callToolJson(fullSiblingClient, 'session_openFile', { input: { filePath: missing } });

    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'session_openFile', { input: { filePath: missing } });
    expect(fullResult.code).toBe(fullSibling.code);
    expect(fullResult.message).toBe(fullSibling.message);
    expect(fullResult.message).toBe(`file not found or not readable: ${missing}`);
    expect(fullRun.captured).toHaveLength(0);
  });

  it('the other two filePath-bearing methods still translate, on both lanes', async () => {
    const file = realFile('plate.jpg');
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, number]> = [
      ['layer_create', { group: 'layer', method: 'create', args: ['image', { filePath: file }] }, { kind: 'image', props: { filePath: file } }, 1],
      ['layer_setImageFill', { group: 'layer', method: 'setImageFill', args: ['L1', { filePath: file }] }, { id: 'L1', source: { filePath: file } }, 1],
      ['session_openFile', { group: 'session', method: 'openFile', args: [{ filePath: file }] }, { input: { filePath: file } }, 0],
    ];
    for (const [name, compactArgs, fullArgs, slot] of cases) {
      const compactRun = makeStub();
      const compactClient = await connect(compactRun.stub);
      const compactResult = await callToolJson(compactClient, 'figpea_call', compactArgs);
      expect(compactResult.ok, `compact:${name}`).toBe(true);
      expect(compactRun.captured, `compact:${name}`).toHaveLength(1);
      const compactObj = compactRun.captured[0]!.args[slot] as any;
      expect(compactObj.filePath, `compact:${name}`).toBeUndefined();
      expect(String(compactObj.url), `compact:${name}`).toContain(encodeURIComponent(file));

      const fullRun = makeStub();
      const fullClient = await connect(fullRun.stub, 'full');
      const fullResult = await callToolJson(fullClient, name, fullArgs);
      expect(fullResult.ok, `full:${name}`).toBe(true);
      expect(fullRun.captured, `full:${name}`).toHaveLength(1);
      const fullObj = fullRun.captured[0]!.args[slot] as any;
      expect(fullObj.filePath, `full:${name}`).toBeUndefined();
      expect(String(fullObj.url), `full:${name}`).toContain(encodeURIComponent(file));
    }
  });
});

// ─────────────────── the pure rule, unit-tested with no bridge ──────────────

describe('findSingularFilePathMismatch — pure, derived, and narrow', () => {
  const openFileSchemas = MANIFEST.session.openFile.params as any;
  const at = (value: unknown) => () => value;

  it('fires on a bare path at a filePath-bearing object slot, and reports the value', () => {
    const mismatch = findSingularFilePathMismatch(openFileSchemas, at('/abs/x.fp'), (name) => `args[0] (${name})`);
    expect(mismatch).toBeDefined();
    expect(mismatch!.offendingValue).toBe('/abs/x.fp');
    expect(mismatch!.path).toBe('args[0] (input)');
    expect(mismatch!.expected).toContain('filePath');
    expect(mismatch!.got).toBe('a string');
    // A payload to copy, not an abstract rule.
    expect(mismatch!.hint).toMatch(/\{\s*"filePath"\s*:/);
  });

  it('declines every case that is not a bare, non-JSON, non-blank path at such a slot', () => {
    const declines: Array<[unknown, string]> = [
      ['{"filePath":"/abs/x.fp"}', 'a JSON-looking string (REQ-1318 owns it)'],
      ['[1,2,3]', 'a JSON-looking array literal'],
      ['', 'an empty string'],
      ['   ', 'a blank string'],
      [null, 'null'],
      [undefined, 'undefined'],
      [42, 'a number'],
      [true, 'a boolean'],
      [{ filePath: '/abs/x.fp' }, 'the correct object'],
      [[{ filePath: '/abs/x.fp' }], 'an array of objects'],
    ];
    for (const [value, label] of declines) {
      expect(findSingularFilePathMismatch(openFileSchemas, at(value), (n) => `args[0] (${n})`), label).toBeUndefined();
    }
  });

  it('declines an object param whose declared shape carries no filePath key — there is no name to give', () => {
    const noFilePath = { options: { type: 'object', required: false, shape: { scale: { type: 'number', required: false } } } } as any;
    expect(findSingularFilePathMismatch(noFilePath, at('/abs/x.fp'), (n) => n)).toBeUndefined();
    // And an object param with no declared shape at all.
    const shapeless = { options: { type: 'object', required: false } } as any;
    expect(findSingularFilePathMismatch(shapeless, at('/abs/x.fp'), (n) => n)).toBeUndefined();
  });

  it('declines with no schemas at all — a legacy free-text manifest is nobody\'s opinion', () => {
    expect(findSingularFilePathMismatch(undefined, at('/abs/x.fp'), (n) => n)).toBeUndefined();
    expect(findSingularFilePathMismatch({}, at('/abs/x.fp'), (n) => n)).toBeUndefined();
  });

  it('declines once the node budget is exhausted — a pathological payload costs no time', () => {
    expect(findSingularFilePathMismatch(openFileSchemas, at('/abs/x.fp'), (n) => n, { nodes: 999_999 })).toBeUndefined();
  });

  it('is DERIVED: a method published later with the same shape gets the lesson with no edit here', () => {
    // A schema this module has never seen, built at the call site — exactly what
    // a future manifest entry looks like.
    const futureSchemas = {
      thing: {
        type: 'object',
        required: true,
        shape: { filePath: { type: 'string', required: false }, whatever: { type: 'number', required: false } },
      },
    } as any;
    const mismatch = findSingularFilePathMismatch(futureSchemas, at('/abs/y.fp'), (n) => n);
    expect(mismatch).toBeDefined();
    expect(mismatch!.offendingValue).toBe('/abs/y.fp');
  });
});