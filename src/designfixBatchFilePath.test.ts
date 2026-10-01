import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';

/**
 * `/design` run `2026-10-01-kiln-spring-workshops-d3` — a `filePath` nested
 * inside a `layer.batch` op is never translated into the bridge's loopback
 * `/file?path=` URL, while the SAME path on a top-level `layer.create` is.
 *
 * Measured on the live editor in that run, with one absolute path that
 * demonstrably exists (the bridge had served it `200 image/jpeg` seconds
 * earlier):
 *
 *   figpea_call({group:'layer', method:'create',
 *     args:['image',{…, filePath:'/…/clay-07.jpg'}]})
 *     → { ok:true, value:{ id, name:'plate' } }          // image renders
 *
 *   figpea_call({group:'layer', method:'batch',
 *     args:[[{method:'create', args:['image',{…, filePath:'/…/clay-07.jpg'}]}]]})
 *     → { ok:false, code:'invalid_image_source',
 *         message:'failed to fetch "/…/clay-07.jpg": 404 Not Found' }
 *
 * The absolute filesystem path was forwarded verbatim, so the editor's image
 * loader treated it as a URL and its fetch failed. `layer.batch` is
 * all-or-nothing, so ONE untranslated op rolled back a complete 12-layer card
 * build — and the message quotes the path next to `404 Not Found`, so the
 * obvious reading is "the file is missing" rather than "this call shape is
 * never translated".
 *
 * The spec here is that defect, not an implementation. What this suite asserts:
 *   - a `filePath` inside an `image` create op reaches the tab as a bridge
 *     `/file?path=` URL, with `filePath` gone, for EVERY op in the batch
 *   - a missing/unreadable file is refused with the SAME code and message the
 *     sibling top-level `layer.create` branch returns, and the batch is NOT
 *     forwarded at all (it is all-or-nothing; a half-translated batch would be
 *     a new failure mode, not a fix)
 *   - a non-string `filePath` is refused the same way the sibling refuses one,
 *     never forwarded
 *   - the translation is `layer.batch`-scoped: a non-`create` op, and a
 *     `create` op whose kind is not `image`, are forwarded verbatim — a blanket
 *     deep rewrite would also mangle values that legitimately carry the key
 *   - the three pre-existing `filePath` branches still behave exactly as before
 *
 * Every parity claim above is asserted by RUNNING the sibling branch in the
 * same test and comparing, so "same wording" is a measured equality rather
 * than a copy of a string that can drift.
 *
 * Harness: a real MCP SDK `Client` over `InMemoryTransport` around a real
 * `createMcpServer`, with `callTab` stubbed and counted. The tab is stubbed
 * because it is provably not the locus — the translation happens in this
 * server, before the round trip — and counting `callTab` is what proves "not
 * forwarded" rather than "forwarded and failed".
 *
 * **Both lanes are asserted.** Compact `figpea_call` is the default mode; the
 * generated per-tool full mode is what real MCP clients use, and it carries
 * its OWN copy of the translation blocks, so it shipped the identical defect
 * (verified by probe before the fix: the tab received
 * `[{"method":"create","args":["image",{"filePath":"/abs/plate.jpg"}]}]`).
 * A fix wired into one lane alone would satisfy the incident in one calling
 * convention and leave the other forwarding a local path to the editor.
 *
 * The two lanes' siblings differ in ONE respect each, and those differences
 * are preserved rather than smoothed over: full mode's `layer_create` also
 * refuses an EMPTY `filePath` (`filePath cannot be empty`), which the compact
 * lane's does not. Each lane's batch branch therefore matches ITS OWN
 * sibling, and the parity assertions below run that lane's sibling live.
 */

// ── fixture manifest ────────────────────────────────────────────────────────
// Purpose-built in the REQ-1280 fixture's shape: `layer.create` (`kind`
// string, `props` object carrying the image `filePath`/`url` fields), and
// `layer.batch` (`ops`: array of `{method, args}`, per the editor's own
// descriptor — "args is the same array the direct figpea_layer_<method> call
// would take"). `session.openFile` and `layer.setImageFill` are here for the
// untouched-siblings row.

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
            parentId: { type: 'string', required: false },
            x: { type: 'number', required: false },
            y: { type: 'number', required: false },
            rwidth: { type: 'number', required: false },
            rheight: { type: 'number', required: false },
            url: { type: 'string', required: false },
            filePath: { type: 'string', required: false },
          },
        },
      },
      result: { id: 'string', name: 'string' },
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
  session: {
    openFile: {
      doc: 'Opens a file in the editor.',
      params: {
        input: {
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

function makeStub(opts?: { deliverManifest?: unknown }) {
  const captured: Capture[] = [];
  const deliver = 'deliverManifest' in (opts ?? {}) ? opts!.deliverManifest : MANIFEST;
  const stub = {
    port: 54319,
    token: 'test-token-designfix',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      if (deliver !== undefined) h(deliver);
    },
    callTab: async (group: string, method: string, args: unknown[]) => {
      captured.push({ group, method, args: structuredClone(args) });
      if (method === 'batch') {
        const ops = args[0] as Array<{ method: string }> | undefined;
        return { ok: true, value: { results: (ops ?? []).map((op, i) => ({ opIndex: i, ok: true, value: { id: `L_${op.method}_${i}` } })) } };
      }
      return { ok: true, value: { id: 'L_probe' } };
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
  const client = new Client({ name: 'designfix-batch-filePath-test', version: '0.0.0' });
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
    // A handler that throws reaches the client as plain text. Surface it as an
    // envelope so the failure reads as the defect, not a parse error here.
    return { ok: false, code: 'non_envelope', message: text };
  }
  return JSON.parse(text);
}

/** A real on-disk file with an image extension, as the incident's paths had. */
function tempImageFile(name = 'plate.jpg'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designfix-batch-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  // Minimal JPEG SOI + EOI marker bytes — only "is a readable file" matters.
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return file;
}

/** A path inside a real temp dir that does not exist. */
function absentImagePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designfix-batch-'));
  tempDirs.push(dir);
  return path.join(dir, 'absent.jpg');
}

const IMAGE_PROPS = (filePath: unknown) => ({ parentId: 'P1', x: 10, y: 20, rwidth: 200, rheight: 150, filePath });

/** `figpea_call({group:'layer', method:'batch', args:[ops]})`. */
function batchCall(ops: unknown[]) {
  return { group: 'layer', method: 'batch', args: [ops] };
}

/** `figpea_call({group:'layer', method:'batch', args:[ops]})` on full mode's
 *  generated `layer_batch` tool, which takes `{ops}` rather than positional
 *  `args`. */
function fullBatchCall(ops: unknown[]) {
  return { name: 'layer_batch', args: { ops } };
}

/** The ops array the tab received from whichever lane was driven. */
function forwardedOps(captured: Capture[]): any[] {
  return captured[0]!.args[0] as any[];
}

/** The props object the tab received for op `i` of the forwarded batch. */
function forwardedOpProps(captured: Capture[], i: number): any {
  return forwardedOps(captured)[i]!.args[1];
}

// ────────────────────────── the defect: an image filePath inside a batch ───

describe('layer.batch — a filePath inside an image create op is translated like a top-level one', () => {
  it('reaches the tab as a bridge /file?path= URL in ops[i].args[1].url, with filePath removed', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = tempImageFile();
    const ops = [{ method: 'create', args: ['image', IMAGE_PROPS(file)] }];
    const result = await callToolJson(client, 'figpea_call', batchCall(ops));

    expect(result.ok).toBe(true);
    // ONE round trip for the whole batch — this is a translation, not a
    // per-op rewrite that could fan out into separate calls.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('batch');

    const props = forwardedOpProps(captured, 0);
    expect(props.filePath).toBeUndefined();
    expect(String(props.url)).toContain('/file?path=');
    expect(String(props.url)).toContain(encodeURIComponent(file));
    // The rest of the op survives byte-for-byte: only `filePath` is replaced.
    expect(props.parentId).toBe('P1');
    expect(props.x).toBe(10);
    expect(props.y).toBe(20);
    expect(props.rwidth).toBe(200);
    expect(props.rheight).toBe(150);
    // `args[0]` is the kind string and is never touched.
    expect((captured[0]!.args[0] as any[])[0]!.args[0]).toBe('image');
    // The caller's own payload is not rewritten in place — the server sends a
    // translated COPY, so a client that reuses its ops array still holds the
    // absolute paths it wrote.
    expect((ops[0]!.args[1] as any).filePath).toBe(file);
    expect((ops[0]!.args[1] as any).url).toBeUndefined();
  });

  it('translates EVERY image op in the array, not just the first', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const a = tempImageFile('clay-07.jpg');
    const b = tempImageFile('clay-11.jpg');
    const result = await callToolJson(client, 'figpea_call', batchCall([
      { method: 'create', args: ['rect', { parentId: 'P1', rwidth: 4, rheight: 4 }] },
      { method: 'create', args: ['image', IMAGE_PROPS(a)] },
      { method: 'create', args: ['image', IMAGE_PROPS(b)] },
      { method: 'setName', args: ['$0', 'plate'] },
    ]));

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const ops = captured[0]!.args[0] as any[];
    expect(ops).toHaveLength(4);
    expect(String(ops[1]!.args[1].url)).toContain(encodeURIComponent(a));
    expect(ops[1]!.args[1].filePath).toBeUndefined();
    expect(String(ops[2]!.args[1].url)).toContain(encodeURIComponent(b));
    expect(ops[2]!.args[1].filePath).toBeUndefined();
    // Order and every non-image op are untouched.
    expect(ops[0]!.args[0]).toBe('rect');
    expect(ops[0]!.args[1]).toEqual({ parentId: 'P1', rwidth: 4, rheight: 4 });
    expect(ops[3]).toEqual({ method: 'setName', args: ['$0', 'plate'] });
  });

  it('a missing file is refused with the sibling layer.create wording, and the batch is not forwarded', async () => {
    const missing = absentImagePath();

    // The sibling's own answer for the same path, measured on the same server.
    const siblingRun = makeStub();
    const siblingClient = await connect(siblingRun.stub);
    const sibling = await callToolJson(siblingClient, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['image', IMAGE_PROPS(missing)],
    });

    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const batched = await callToolJson(client, 'figpea_call', batchCall([
      { method: 'create', args: ['rect', { parentId: 'P1', rwidth: 4, rheight: 4 }] },
      { method: 'create', args: ['image', IMAGE_PROPS(missing)] },
    ]));

    // Same code, same message, same path — a measured equality, so the two
    // branches cannot drift into different wording.
    expect(batched.code).toBe(sibling.code);
    expect(batched.message).toBe(sibling.message);
    expect(batched.code).toBe('invalid_image_source');
    expect(batched.message).toBe(`file not found or not readable: ${missing}`);
    // All-or-nothing: a batch carrying an unresolvable image must not be sent
    // at all, so the caller gets the reason instead of an editor 404 quoting
    // the path.
    expect(captured).toHaveLength(0);
  });

  it('a non-string filePath is refused like the sibling refuses one, never forwarded', async () => {
    // Measured against the sibling rather than a copied string.
    const siblingRun = makeStub();
    const siblingClient = await connect(siblingRun.stub);
    const sibling = await callToolJson(siblingClient, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['image', { parentId: 'P1', filePath: 123 }],
    });

    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const batched = await callToolJson(client, 'figpea_call', batchCall([
      { method: 'create', args: ['image', { parentId: 'P1', filePath: 123 }] },
    ]));

    expect(batched.code).toBe(sibling.code);
    expect(batched.message).toBe(sibling.message);
    expect(batched.code).toBe('invalid_image_source');
    expect(batched.message).toBe('props.filePath must be a string');
    expect(captured).toHaveLength(0);
  });

  it('the translation is layer.batch-scoped: a non-create op and a non-image create op are forwarded verbatim', async () => {
    // The guard against a blanket deep rewrite. `setName`'s name and a rect's
    // props both legitimately carry the string `filePath` as DATA in this
    // fixture; neither is an image source, so neither may be rewritten, and
    // neither may be refused.
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const ops = [
      { method: 'create', args: ['rect', { parentId: 'P1', rwidth: 4, rheight: 4, filePath: '/not/an/image' }] },
      { method: 'setName', args: ['$0', 'filePath'] },
    ];
    const result = await callToolJson(client, 'figpea_call', batchCall(ops));

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    // Byte-identical to what was sent — the tab is the only thing that gets to
    // decide what a `filePath` on a rect means.
    expect(captured[0]!.args[0]).toEqual(ops);
  });
});

// ──────────────────────── full mode: the generated layer_batch tool ────────

describe('layer.batch on FULL mode — the lane real MCP clients use', () => {
  it('reaches the tab as a bridge /file?path= URL, with filePath removed', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const file = tempImageFile();
    const { name, args } = fullBatchCall([
      { method: 'create', args: ['rect', { parentId: 'P1', rwidth: 4, rheight: 4 }] },
      { method: 'create', args: ['image', IMAGE_PROPS(file)] },
    ]);
    const result = await callToolJson(client, name, args as Record<string, unknown>);

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('batch');

    const ops = forwardedOps(captured);
    const props = ops[1]!.args[1];
    expect(props.filePath).toBeUndefined();
    expect(String(props.url)).toContain('/file?path=');
    expect(String(props.url)).toContain(encodeURIComponent(file));
    // The non-image op ahead of it is untouched.
    expect(ops[0]!.args[1]).toEqual({ parentId: 'P1', rwidth: 4, rheight: 4 });
  });

  it('a missing file is refused with THIS lane\'s sibling wording, and not forwarded', async () => {
    const missing = absentImagePath();

    const siblingRun = makeStub();
    const siblingClient = await connect(siblingRun.stub, 'full');
    const sibling = await callToolJson(siblingClient, 'layer_create', {
      kind: 'image',
      props: IMAGE_PROPS(missing),
    });

    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const { name, args } = fullBatchCall([
      { method: 'create', args: ['rect', { parentId: 'P1', rwidth: 4, rheight: 4 }] },
      { method: 'create', args: ['image', IMAGE_PROPS(missing)] },
    ]);
    const batched = await callToolJson(client, name, args as Record<string, unknown>);

    expect(batched.code).toBe(sibling.code);
    expect(batched.message).toBe(sibling.message);
    expect(batched.code).toBe('invalid_image_source');
    expect(batched.message).toBe(`file not found or not readable: ${missing}`);
    expect(captured).toHaveLength(0);
  });

  it('a non-string filePath is refused like the sibling refuses one, never forwarded', async () => {
    const siblingRun = makeStub();
    const siblingClient = await connect(siblingRun.stub, 'full');
    const sibling = await callToolJson(siblingClient, 'layer_create', {
      kind: 'image',
      props: { parentId: 'P1', filePath: 123 },
    });

    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const { name, args } = fullBatchCall([{ method: 'create', args: ['image', { parentId: 'P1', filePath: 123 }] }]);
    const batched = await callToolJson(client, name, args as Record<string, unknown>);

    expect(batched.code).toBe(sibling.code);
    expect(batched.message).toBe(sibling.message);
    expect(batched.message).toBe('props.filePath must be a string');
    expect(captured).toHaveLength(0);
  });

  it('an EMPTY filePath is refused here too — this lane\'s sibling does refuse one', async () => {
    // The one place the two lanes legitimately differ, preserved rather than
    // smoothed over: full mode's `layer_create` refuses an empty string
    // (mcpServer.ts:1697), so its batch branch must refuse it identically.
    // The compact lane's sibling has no such clause, so neither does its batch
    // branch — each matches its own sibling, which is what "same wording"
    // has to mean for a rule that exists twice.
    const siblingRun = makeStub();
    const siblingClient = await connect(siblingRun.stub, 'full');
    const sibling = await callToolJson(siblingClient, 'layer_create', {
      kind: 'image',
      props: { parentId: 'P1', filePath: '' },
    });

    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const { name, args } = fullBatchCall([{ method: 'create', args: ['image', { parentId: 'P1', filePath: '' }] }]);
    const batched = await callToolJson(client, name, args as Record<string, unknown>);

    expect(sibling.ok).toBe(false);
    expect(batched.code).toBe(sibling.code);
    expect(batched.message).toBe(sibling.message);
    expect(batched.message).toBe('filePath cannot be empty');
    expect(captured).toHaveLength(0);
  });

  it('is layer.batch-scoped here too: a non-create op and a non-image create op are forwarded verbatim', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const ops = [
      { method: 'create', args: ['rect', { parentId: 'P1', rwidth: 4, rheight: 4, filePath: '/not/an/image' }] },
      { method: 'setName', args: ['$0', 'filePath'] },
    ];
    const { name, args } = fullBatchCall(ops);
    const result = await callToolJson(client, name, args as Record<string, unknown>);

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(forwardedOps(captured)).toEqual(ops);
  });
});

// ──────────────────── the three pre-existing branches, still unchanged ─────
describe('the pre-existing filePath branches are untouched by the batch fix', () => {
  it('session.openFile, layer.setImageFill and a top-level layer.create all still translate', async () => {
    const cases: Array<{ call: (file: string) => Record<string, unknown>; read: (args: unknown[]) => any }> = [
      {
        call: (file) => ({ group: 'session', method: 'openFile', args: [{ filePath: file }] }),
        read: (args) => args[0],
      },
      {
        call: (file) => ({ group: 'layer', method: 'setImageFill', args: ['L1', { filePath: file }] }),
        read: (args) => args[1],
      },
      {
        call: (file) => ({ group: 'layer', method: 'create', args: ['image', IMAGE_PROPS(file)] }),
        read: (args) => args[1],
      },
    ];

    for (const { call, read } of cases) {
      const { stub, captured } = makeStub();
      const client = await connect(stub);
      const file = tempImageFile();
      const result = await callToolJson(client, 'figpea_call', call(file));
      const label = JSON.stringify(call('')).slice(0, 40);

      expect(result.ok, label).toBe(true);
      expect(captured, label).toHaveLength(1);
      const obj = read(captured[0]!.args);
      expect(obj.filePath, label).toBeUndefined();
      expect(String(obj.url), label).toContain('/file?path=');
      expect(String(obj.url), label).toContain(encodeURIComponent(file));
    }

    // The same three, on full mode's generated tools — this lane has its own
    // copy of the branches (mcpServer.ts makeContractHandler), so "unchanged"
    // is a claim about six call sites, not three.
    const fullCases: Array<{ name: string; args: (file: string) => Record<string, unknown>; read: (args: unknown[]) => any }> = [
      { name: 'session_openFile', args: (file) => ({ input: { filePath: file } }), read: (a) => a[0] },
      { name: 'layer_setImageFill', args: (file) => ({ id: 'L1', source: { filePath: file } }), read: (a) => a[1] },
      { name: 'layer_create', args: (file) => ({ kind: 'image', props: IMAGE_PROPS(file) }), read: (a) => a[1] },
    ];

    for (const { name, args, read } of fullCases) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, 'full');
      const file = tempImageFile();
      const result = await callToolJson(client, name, args(file));
      const label = `full:${name}`;

      expect(result.ok, label).toBe(true);
      expect(captured, label).toHaveLength(1);
      const obj = read(captured[0]!.args);
      expect(obj.filePath, label).toBeUndefined();
      expect(String(obj.url), label).toContain('/file?path=');
      expect(String(obj.url), label).toContain(encodeURIComponent(file));
    }
  });

  it('their MISSING-file refusals still name the file and still spend no round trip', async () => {
    const missing = absentImagePath();
    const cases: Array<{ call: Record<string, unknown>; code: string }> = [
      { call: { group: 'session', method: 'openFile', args: [{ filePath: missing }] }, code: 'open_failed' },
      { call: { group: 'layer', method: 'setImageFill', args: ['L1', { filePath: missing }] }, code: 'invalid_image_source' },
      { call: { group: 'layer', method: 'create', args: ['image', IMAGE_PROPS(missing)] }, code: 'invalid_image_source' },
    ];

    for (const { call, code } of cases) {
      const { stub, captured } = makeStub();
      const client = await connect(stub);
      const result = await callToolJson(client, 'figpea_call', call);
      const label = JSON.stringify(call).slice(0, 40);

      expect(result.ok, label).toBe(false);
      expect(result.code, label).toBe(code);
      expect(result.message, label).toBe(`file not found or not readable: ${missing}`);
      expect(captured, label).toHaveLength(0);
    }

    const fullCases: Array<{ name: string; args: Record<string, unknown>; code: string }> = [
      { name: 'session_openFile', args: { input: { filePath: missing } }, code: 'open_failed' },
      { name: 'layer_setImageFill', args: { id: 'L1', source: { filePath: missing } }, code: 'invalid_image_source' },
      { name: 'layer_create', args: { kind: 'image', props: IMAGE_PROPS(missing) }, code: 'invalid_image_source' },
    ];

    for (const { name, args, code } of fullCases) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, 'full');
      const result = await callToolJson(client, name, args);
      const label = `full:${name}`;

      expect(result.ok, label).toBe(false);
      expect(result.code, label).toBe(code);
      expect(result.message, label).toBe(`file not found or not readable: ${missing}`);
      expect(captured, label).toHaveLength(0);
    }
  });
});
