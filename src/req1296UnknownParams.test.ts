import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { startBridgeServer } from './bridgeServer';
import { buildToolsFromManifest, type GeneratedTool } from './tools';
import { sessionDirFor } from './returnPath';

/**
 * REQ-1296 T1 — failing acceptance tests for the failure class this
 * requirement exists to close: **a parameter the server does not understand,
 * answered with `ok:true` and a success payload.**
 *
 * The spec here is the AC text, not this repo's implementation. The
 * behaviours pinned below are, stated independently of any code:
 *   - AC-1 the defect, stated as its own repro: from a paired editor tab,
 *     `canvas.screenshot` called with a `filePath` argument. Today the call
 *     returns `ok:true` with the image inline and NO file written at either
 *     location — the requested path, nor the off-band session dir. The
 *     closed behaviour the AC names is the second of its two acceptable
 *     "after"s: **the call fails naming `filePath` as an unknown param.**
 *   - AC-2 `export.project({format:"figpea"})` with `returnAs:"path"` returns
 *     a path to a written native `.fp`, never base64. This is a **pin**: the
 *     behaviour shipped in REQ-1279, so it is GREEN on arrival and is not
 *     this requirement's work. The written file must be a readable ZIP
 *     holding the project's entries, byte-identical to what inline mode
 *     returns.
 *   - AC-3 the blanket rule, asserted as a **sweep over every generated
 *     contract tool** rather than as the one example in the card: no contract
 *     method accepts an unrecognised param and returns `ok:true`, in EITHER
 *     calling convention (the per-tool full mode, and the compact-mode
 *     `figpea_call` dispatcher, where the same defect has two spellings — an
 *     unknown top-level key, and a surplus positional argument).
 *
 * Harness: a real MCP SDK `Client` over `InMemoryTransport`, wrapped around a
 * real `startBridgeServer({port: 0})` with a stubbed `callTab` — the shape
 * `src/req1279BinaryReturn.test.ts` and `src/req1017FileTranslation.test.ts`
 * already use, and the plan's own T1 instruction. The tab is stubbed for
 * determinism (AC-1's own first word); it is not the locus of this defect
 * anyway, because the offending key is destroyed one layer ABOVE the tab call.
 *
 * The `.fp` payload is a REAL exported project, committed as
 * `src/__fixtures__/req1279-tiny.fp`, and its ZIP central directory is parsed
 * with `node:fs` only — this is a published standalone package and gains no
 * runtime dependency for a test.
 */

const FIXTURE = path.join(__dirname, '__fixtures__', 'req1279-tiny.fp');
const FP_BYTES = fs.readFileSync(FIXTURE);
const FP_B64 = FP_BYTES.toString('base64');
const PNG_B64 = Buffer.from('req1296-screenshot-png').toString('base64');

/** A key that is not a parameter of anything, in either calling convention. */
const BOGUS_KEY = 'totally_not_a_parameter';

/** Reads a ZIP's entry names by walking the End-Of-Central-Directory record and
 *  the central directory — no decompression, no dependency, and enough to prove
 *  "a readable ZIP holding the same entries". */
function zipEntryNames(buf: Buffer): string[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('not a zip: bad central directory signature');
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.subarray(off + 46, off + 46 + nameLen).toString('utf8'));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * A realistic manifest, copied in shape from the real v3 descriptors: a
 * zero-param method (`session.layerTree`), a single-param method
 * (`session.waitForIdle`), `canvas.screenshot` with its real
 * `{options: {id, pixelRatio}}` params, an `enum` param (`layer.create`'s
 * `kind`), `session.openFile` (whose REQ-1017 top-level `filePath` shim is
 * this change's one real regression risk), and `export.project` for AC-2.
 */
const MANIFEST: any = {
  canvas: {
    screenshot: {
      doc: 'Captures the live canvas as a PNG screenshot.',
      params: { options: { type: 'object', required: false, shape: { id: { type: 'string', required: false }, pixelRatio: { type: 'number', required: false } } } },
      result: { bytes: 'string', mime: 'string', width: 'number', height: 'number' },
    },
  },
  session: {
    layerTree: { doc: 'Returns the current layer tree.', params: {}, result: { layers: 'array' } },
    waitForIdle: { doc: 'Waits until the editor is idle.', params: { timeout: { type: 'number', required: false } }, result: { idle: 'boolean' } },
    openFile: {
      doc: 'Opens a design file in the editor.',
      params: { input: { type: 'object', required: false, shape: { url: { type: 'string', required: false }, filePath: { type: 'string', required: false } } } },
      result: { documentId: 'string' },
    },
  },
  layer: {
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'text', 'image'] },
        props: { type: 'object', required: false, shape: { name: { type: 'string', required: false }, rwidth: { type: 'number', required: false } } },
      },
      result: { id: 'string' },
    },
    setPosition: { doc: 'Places a layer at world coordinates.', params: { id: { type: 'string', required: true }, pos: { type: 'object', required: true, shape: { x: { type: 'number', required: false }, y: { type: 'number', required: false } } } }, result: { id: 'string' } },
  },
  export: {
    project: {
      doc: 'Exports the whole project as pdf/zip/figpea.',
      params: { input: { type: 'object', required: false, shape: { format: { type: 'string', required: false, enum: ['pdf', 'zip', 'figpea'] } } } },
      result: { bytes: 'string', mime: 'string', filename: 'string' },
    },
  },
};

const GENERATED: GeneratedTool[] = buildToolsFromManifest(MANIFEST as any);

/** The payloads the stub tab returns, keyed by `group.method`. */
function payloadFor(group: string, method: string): unknown {
  if (group === 'canvas' && method === 'screenshot') {
    // `canvas.screenshot` carries no `filename` — the contract declares none.
    return { bytes: PNG_B64, mime: 'image/png', width: 640, height: 400 };
  }
  if (group === 'export' && method === 'project') {
    return { bytes: FP_B64, mime: 'application/zip', filename: 'My Design.fp' };
  }
  return null;
}

/** A value that satisfies the tool's OWN declared schema for `key`, so a
 *  sweep call is well-formed in every respect except the one under test. */
function valueForSchema(schema: any): unknown {
  if (!schema) return 'req1296';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'object':
      return {};
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'matrix':
      return [0, 0, 0, 0, 0, 0];
    default:
      return 'req1296';
  }
}

/** Every declared parameter of `tool`, given a schema-valid value, as the
 *  named-argument object full mode takes. */
function namedArgsFor(tool: GeneratedTool): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of tool.inputKeys) args[key] = valueForSchema(tool.paramSchemas?.[key]);
  return args;
}

/** The same values, as the POSITIONAL array compact mode's `figpea_call` takes. */
function positionalArgsFor(tool: GeneratedTool): unknown[] {
  return tool.inputKeys.map((key) => valueForSchema(tool.paramSchemas?.[key]));
}

interface Call { name: string; args: unknown[] }

let cleanup: Array<() => Promise<void>> = [];
let tmpDirs: string[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function createHarnessedClient(toolMode: 'full' | 'compact' = 'full') {
  const realBridge: any = await startBridgeServer({ port: 0 });
  const calls: Call[] = [];
  const stub: any = {
    port: realBridge.port,
    token: realBridge.token,
    isTabConnected: () => true,
    onDescribe: (h: any) => h(MANIFEST),
    callTab: async (group: string, method: string, args: unknown[]) => {
      calls.push({ name: `${group}_${method}`, args });
      return { ok: true, value: payloadFor(group, method) };
    },
    close: () => realBridge.close(),
    getFileUrl: (fp: string) => realBridge.getFileUrl(fp),
    registerBlob: (fp: string) => realBridge.registerBlob(fp),
  };
  const server = createMcpServer(stub as any, toolMode === 'compact' ? { toolMode: 'compact' } : undefined);
  const client = new Client({ name: 'req1296-unknown-params', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => { await client.close(); await server.close(); await realBridge.close(); });
  return { client, stub, realBridge, calls };
}

function textOf(res: any): string {
  const blocks = (res.content as any[]).filter((c: any) => c.type === 'text');
  expect(blocks, 'a text content block is present').toHaveLength(1);
  return blocks[0].text;
}
function payloadOf(res: any): any {
  return JSON.parse(textOf(res));
}

describe('REQ-1296 AC-1: canvas.screenshot with a filePath argument fails naming the key, and writes no file', () => {
  it('names filePath as an unknown param, and no file appears at the requested path or in the session dir', async () => {
    const { client, realBridge } = await createHarnessedClient('full');
    const requested = path.join(tmpDir('req1296-wanted-'), 'capture.png');
    const sessionDir = sessionDirFor(realBridge.token);
    const before = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).sort() : [];

    const res: any = await client.callTool({
      name: 'canvas_screenshot',
      arguments: { options: {}, filePath: requested } as any,
    });

    // Today this is `isError:false` with the image inline and nothing on disk.
    expect(res.isError, 'an unrecognised parameter is an error, never a success').toBe(true);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(false);
    expect(payload.code, 'the failure is a parameter failure').toBe('invalid_params');
    // Asserted on the MESSAGE BODY, not on the code: a check that only reads
    // `isError:true` would also pass against an opaque SDK rejection that
    // names a JSON path array instead of the key the caller got wrong.
    expect(payload.message, 'the message names the offending key').toContain('"filePath"');
    expect(payload.message, 'the message names the tool').toContain('canvas_screenshot');
    // "no file written at either location" — pinned, not assumed.
    expect(fs.existsSync(requested), 'nothing was written at the requested path').toBe(false);
    const after = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).sort() : [];
    expect(after, 'nothing was written to the off-band session dir either').toEqual(before);
  });

  it('is the same failure the compact-mode dispatcher gives, and it is equally silent-free', async () => {
    const { client, realBridge } = await createHarnessedClient('compact');
    const requested = path.join(tmpDir('req1296-wanted-'), 'capture.png');
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group: 'canvas', method: 'screenshot', args: [], filePath: requested } as any,
    });
    expect(res.isError, 'compact mode is the same failure class').toBe(true);
    const payload = payloadOf(res);
    expect(payload.code).toBe('invalid_params');
    expect(payload.message).toContain('"filePath"');
    expect(fs.existsSync(requested), 'still no file at the requested path').toBe(false);
    expect(fs.existsSync(sessionDirFor(realBridge.token)), 'a rejected call never even creates the off-band session dir').toBe(false);
  });
});

describe('REQ-1296 AC-2 (pin): export.project with returnAs:"path" returns a written native .fp, never base64', () => {
  // GREEN ON ARRIVAL — REQ-1279 delivered this. It is pinned here so a
  // regression in the off-band lane is caught by the same file that changes
  // the argument lane, and so this REQ's own red run carries positive proof
  // that AC-2 was already satisfied.
  it('returns one text block carrying a .fp path, and the written file is a readable ZIP', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({
      name: 'export_project',
      arguments: { input: { format: 'figpea' }, returnAs: 'path' } as any,
    });
    expect(res.isError, 'path mode is not an error').toBe(false);
    expect((res.content as any[]).some((c: any) => c.type === 'image'), 'no image block crosses the wire').toBe(false);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(true);
    expect(payload.path, 'the path is a native .fp').toMatch(/\.fp$/);
    expect(payload.mime).toBe('application/zip');
    expect(payload.bytes, 'bytes is the decoded payload length').toBe(FP_BYTES.length);
    expect(textOf(res), 'no base64 anywhere in the returned text').not.toContain(FP_B64);

    const written = fs.readFileSync(payload.path);
    expect(zipEntryNames(written), 'the written file is a readable ZIP holding the project entries').toEqual(['main.fpe', 'repo.json']);
    const inline: any = await client.callTool({ name: 'export_project', arguments: { input: { format: 'figpea' } } as any });
    expect(written.equals(Buffer.from(payloadOf(inline).value.bytes, 'base64')), 'the off-band bytes are the inline bytes').toBe(true);
  });
});

describe('REQ-1296 AC-3: no contract method accepts an unrecognised param and returns ok:true — full mode, every tool', () => {
  it.each(GENERATED.map((t) => [t.name, t] as const))('%s rejects an unrecognised key, naming it, without spending a tab round trip', async (_name, tool) => {
    const { client, calls } = await createHarnessedClient('full');
    const res: any = await client.callTool({
      name: tool.name,
      arguments: { ...namedArgsFor(tool), [BOGUS_KEY]: 'whatever' } as any,
    });
    expect(res.isError, `${tool.name} must not answer ok:true for a key it does not understand`).toBe(true);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('invalid_params');
    expect(payload.message, 'the offending key is named in the message body').toContain(`"${BOGUS_KEY}"`);
    expect(calls, 'a rejected call costs zero bridge round trips').toHaveLength(0);
  });

  it('names every offending key when several arrive at once, and lists what is accepted', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({
      name: 'canvas_screenshot',
      arguments: { options: {}, filePath: '/tmp/req1296-a.png', saveTo: '/tmp/req1296-b.png' } as any,
    });
    expect(res.isError).toBe(true);
    const payload = payloadOf(res);
    expect(payload.message).toContain('"filePath"');
    expect(payload.message).toContain('"saveTo"');
    expect(payload.message, 'the message says what IS accepted').toContain('options');
    expect(payload.message, 'and points at the off-band lane that actually persists a file').toContain('returnAs');
  });
});

describe('REQ-1296 AC-3: compact mode — both spellings of the same defect are rejected', () => {
  it.each(GENERATED.map((t) => [t.name, t] as const))('figpea_call into %s rejects an unrecognised TOP-LEVEL key', async (_name, tool) => {
    const [group, method] = splitToolName(tool.name);
    const { client, calls } = await createHarnessedClient('compact');
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group, method, args: positionalArgsFor(tool), [BOGUS_KEY]: 'whatever' } as any,
    });
    expect(res.isError, `${tool.name} must not answer ok:true for a key it does not understand`).toBe(true);
    const payload = payloadOf(res);
    expect(payload.code).toBe('invalid_params');
    expect(payload.message).toContain(`"${BOGUS_KEY}"`);
    expect(calls, 'a rejected call costs zero bridge round trips').toHaveLength(0);
  });

  it('rejects a SURPLUS POSITIONAL argument, naming the index and the expected arity', async () => {
    // `canvas.screenshot` declares exactly one parameter (`options`), so a
    // second positional argument is the positional spelling of the same
    // defect: today it is silently discarded and the call still returns ok.
    const { client, calls } = await createHarnessedClient('compact');
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group: 'canvas', method: 'screenshot', args: [{ id: 'page-1' }, { id: 'page-2' }] } as any,
    });
    expect(res.isError, 'a surplus positional argument is an error, never a success').toBe(true);
    const payload = payloadOf(res);
    expect(payload.code).toBe('invalid_params');
    expect(payload.message, 'the offending position is named').toContain('args[1]');
    expect(payload.message, 'the expected arity is stated').toContain('1 positional');
    expect(payload.message, 'and the one call that teaches the shape is named').toContain('figpea_describe');
    expect(calls, 'a rejected call costs zero bridge round trips').toHaveLength(0);
  });
});

describe('REQ-1296 AC-3: findUnknownTopLevelKeys — the pure predicate, unit-tested with no bridge', () => {
  // Imported lazily so a MISSING `src/unknownParams.ts` fails only this block.
  // The AC-2 pin above is green on the unfixed tree, and that is the evidence
  // REQ-1279 already delivered AC-2 — it has to stay observable in the red
  // run this file exists to produce.
  let findUnknownTopLevelKeys: (raw: Record<string, unknown>, allowed: ReadonlySet<string>) => string[];
  let FULL_MODE_RESERVED: readonly string[];
  let COMPACT_RESERVED: readonly string[];

  beforeAll(async () => {
    ({ findUnknownTopLevelKeys, FULL_MODE_RESERVED, COMPACT_RESERVED } = await import('./unknownParams'));
  });

  it('exposes exactly the reserved keys each calling convention accepts', () => {
    expect([...FULL_MODE_RESERVED]).toEqual(['_timeoutMs', '_rawJson', 'returnAs']);
    expect([...COMPACT_RESERVED]).toEqual(['group', 'method', 'args', '_timeoutMs', '_rawJson', 'returnAs']);
  });

  it('returns every key that is neither declared nor reserved, in arrival order, with no duplicates', () => {
    const allowed = new Set<string>(['options', '_timeoutMs', '_rawJson', 'returnAs']);
    expect(findUnknownTopLevelKeys({ options: {}, filePath: '/a', saveTo: '/b', _timeoutMs: 1 }, allowed)).toEqual(['filePath', 'saveTo']);
  });

  it('returns nothing for a payload that is entirely understood', () => {
    const allowed = new Set<string>(['group', 'method', 'args', '_timeoutMs', '_rawJson', 'returnAs']);
    expect(findUnknownTopLevelKeys({ group: 'canvas', method: 'screenshot', args: [], returnAs: 'path' }, allowed)).toEqual([]);
    expect(findUnknownTopLevelKeys({}, allowed), 'an empty payload has nothing unknown').toEqual([]);
  });

  it('judges a key by its NAME, not by its value — a wrong value is still a wrong key', () => {
    const allowed = new Set<string>(['options', 'returnAs']);
    // `returnAs: "path"` (typo) is a known key with a bad value; `filePath` is
    // an unknown key with a plausible value. Only the second is this
    // predicate's business, and conflating the two would duplicate — and
    // contradict — `returnAs`'s own dedicated validation.
    expect(findUnknownTopLevelKeys({ options: {}, returnAs: 'path' }, allowed)).toEqual([]);
    expect(findUnknownTopLevelKeys({ filePath: null }, allowed)).toEqual(['filePath']);
    expect(findUnknownTopLevelKeys({ filePath: undefined }, allowed)).toEqual(['filePath']);
  });

  it('is total: a payload with an exotic key name, and a payload with no own keys', () => {
    const allowed = new Set<string>(['options']);
    expect(findUnknownTopLevelKeys({ options: {}, '': 1, 'a b': 2, constructor: 3 }, allowed)).toEqual(['', 'a b', 'constructor']);
    expect(findUnknownTopLevelKeys(Object.create({ inherited: 1 }) as Record<string, unknown>, allowed), 'inherited keys are not the caller-sent ones').toEqual([]);
  });
});

describe('REQ-1296 preservation: everything that worked before the change must still work', () => {
  it('every declared parameter is still forwarded to the tab, positionally and in declaration order', async () => {
    const { client, calls } = await createHarnessedClient('full');
    for (const tool of GENERATED) {
      const before = calls.length;
      const res: any = await client.callTool({ name: tool.name, arguments: namedArgsFor(tool) as any });
      expect(res.isError, `${tool.name} still answers a well-formed call`).toBe(false);
      expect(calls.length - before, `${tool.name} still reaches the tab`).toBe(1);
      expect(calls[before].name).toBe(tool.name);
      expect(calls[before].args, `${tool.name} forwards exactly its declared parameters`).toEqual(positionalArgsFor(tool));
    }
  });

  it('every reserved key is still accepted, and is still never forwarded to the tab', async () => {
    const { client, calls } = await createHarnessedClient('full');
    for (const tool of GENERATED) {
      const before = calls.length;
      const res: any = await client.callTool({
        name: tool.name,
        arguments: { ...namedArgsFor(tool), _timeoutMs: 30_000, _rawJson: true, returnAs: 'inline' } as any,
      });
      expect(res.isError, `${tool.name} still accepts the reserved keys`).toBe(false);
      expect(calls.length - before).toBe(1);
      expect(JSON.stringify(calls[before].args), 'no reserved key leaks into the tab-side args').not.toMatch(/_timeoutMs|_rawJson|returnAs/);
    }
  });

  it('an invalid enum value is still rejected — REQ-093 validation is not weakened by the loose shape', async () => {
    const { client, calls } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'layer_create', arguments: { kind: 'not-a-kind' } as any });
    expect(res.isError, 'a bad enum value is still an error').toBe(true);
    expect(textOf(res)).toMatch(/rect/);
    expect(calls, 'and it never reaches the tab').toHaveLength(0);
  });

  // NOTE on the red run this file produces: the top-level branch of that
  // shim is currently UNREACHABLE — `filePath` is not in the manifest's
  // `inputKeys`, so the SDK's parse strips it before the handler ever reads
  // `effectiveRawArgs.filePath`, and only the nested `input.filePath` form
  // works (which is what REQ-1017's own committed test exercises). This test
  // is therefore RED today and goes green by design: it pins the one tool
  // whose undeclared key must be allowed rather than rejected once the shape
  // stops stripping it. Asserting today's dead-branch behaviour instead would
  // be asserting the bug.
  it("session_openFile keeps honouring a top-level filePath (REQ-1017) — the one tool where an undeclared key is legitimate", async () => {
    const fp = path.join(tmpDir('req1296-open-'), 'design.fp');
    fs.writeFileSync(fp, '{"k":"v"}');
    const { client, calls } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'session_openFile', arguments: { filePath: fp } as any });
    expect(res.isError, 'the compatibility shim is still accepted, not rejected as unknown').toBe(false);
    expect(calls, 'and it still reaches the tab').toHaveLength(1);
    const input = calls[0].args[0] as Record<string, any>;
    expect(input?.url, 'filePath is still translated to a loopback bridge URL').toMatch(/^http:\/\/localhost:\d+\/file\?path=/);
    expect(input?.filePath, 'the shim key is still stripped before relay').toBeUndefined();
    expect(input?.fileName).toBe('design.fp');
  });

  it('tools/list still advertises every property, and the known-good calls still advertise what they did', async () => {
    const { client } = await createHarnessedClient('full');
    const list: any = await client.listTools();
    const byName = new Map<string, any>(list.tools.map((t: any) => [t.name, t.inputSchema]));
    const screenshot = byName.get('canvas_screenshot');
    expect(Object.keys(screenshot.properties).sort(), 'every declared + reserved key is still advertised').toEqual(
      ['_rawJson', '_timeoutMs', 'options', 'returnAs'].sort(),
    );
    expect(screenshot.properties.options, 'the structured object param is advertised exactly as before').toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, pixelRatio: { type: 'number' } },
      additionalProperties: true,
    });
    expect(screenshot.properties.returnAs, 'the reserved key keeps its advertised enum').toEqual({ type: 'string', enum: ['inline', 'path'] });
    const create = byName.get('layer_create');
    expect(create.properties.kind, 'an enum param still advertises its values').toEqual({ type: 'string', enum: ['page', 'rect', 'text', 'image'] });
  });

  it('a well-formed call that returns nothing still returns exactly the same success envelope', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'session_layerTree', arguments: {} as any });
    expect(res.isError).toBe(false);
    expect(payloadOf(res)).toEqual({ ok: true, value: null });
  });
});

/** `group_method` → `[group, method]`, for the compact-mode sweep. */
function splitToolName(name: string): [string, string] {
  const idx = name.indexOf('_');
  return [name.slice(0, idx), name.slice(idx + 1)];
}
