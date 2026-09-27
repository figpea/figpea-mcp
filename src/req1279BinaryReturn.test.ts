import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { startBridgeServer } from './bridgeServer';

/**
 * REQ-1279 T1 — failing acceptance tests for off-band `returnAs:"path"` on
 * **non-image** binary exports (the native `.fp` export being the case the
 * requirement exists for).
 *
 * The spec here is the AC text, not this repo's implementation. The behaviours
 * pinned below are, stated independently of any code:
 *   - AC-1 the defect: `returnAs:"path"` on `export.project` hands back a base64
 *     blob with no path, so the artifact never reaches disk. The test pins the
 *     CLOSED behaviour (a path, no base64); the pre-fix shape is preserved and
 *     pinned deliberately in the AC-6 leg, which drives the very same payload
 *     through the *default* inline lane.
 *   - AC-2 path payload shape: `{ok, path, mime, bytes}` where the path ends in
 *     `.fp` and the bytes match the decoded payload, with no base64 anywhere in
 *     the returned text.
 *   - AC-3 the file on disk is a readable ZIP with the same entries, and is
 *     byte-identical to what inline mode would have returned.
 *   - AC-4 the returned path is fetchable over the bridge with permissive CORS.
 *   - AC-5 the three image tools keep their existing path payload.
 *   - AC-6 inline (the default) is untouched: one text block, no image block.
 *   - AC-7 the same holds for every other binary export, each correctly named.
 *
 * Harness: a real MCP SDK `Client` over `InMemoryTransport`, wrapped around a
 * real `startBridgeServer({port: 0})` (so AC-4 is a genuine HTTP request) with a
 * stubbed `callTab` — the shape `src/req1020ReturnAs.test.ts` already uses.
 *
 * The `.fp` payload is a REAL exported project, committed as
 * `src/__fixtures__/req1279-tiny.fp`, and its ZIP central directory is parsed
 * with `node:fs` only — this is a published standalone package and gains no
 * runtime dependency for a test.
 */

const FIXTURE = path.join(__dirname, '__fixtures__', 'req1279-tiny.fp');
const FP_BYTES = fs.readFileSync(FIXTURE);
const FP_B64 = FP_BYTES.toString('base64');

/** Reads a ZIP's entry names by walking the End-Of-Central-Directory record and
 * the central directory — no decompression, no dependency, and enough to prove
 * "a readable ZIP containing the same entries". */
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

/** The payload shapes the v3 export contract actually declares, so the test
 * drives what a real tab returns rather than an idealisation. */
const BINARY_EXPORTS: Record<string, { mime: string; filename: string }> = {
  project: { mime: 'application/zip', filename: 'My Design.fp' },
  originals: { mime: 'application/zip', filename: 'My Design-originals.zip' },
  assetHarvest: { mime: 'application/zip', filename: 'My Design-assets-web.zip' },
  figmaKit: { mime: 'application/zip', filename: 'My Design-figma-kit.zip' },
  contactSheet: { mime: 'application/pdf', filename: 'My Design-contact-sheet.pdf' },
  flowPoster: { mime: 'image/svg+xml', filename: 'My Design-flow-poster.svg' },
};

/** Non-image binaries the stub tab returns, keyed by `group.method`. */
function payloadFor(group: string, method: string): unknown {
  if (group === 'canvas' && method === 'screenshot') {
    // `canvas.screenshot` carries NO filename — the AC-5 byte-identity case.
    return { bytes: Buffer.from('req1279-screenshot-png').toString('base64'), mime: 'image/png', width: 640, height: 400 };
  }
  if (group === 'export' && (method === 'layer' || method === 'artboard')) {
    // The two raster exports DO carry a filename, as the contract declares.
    return { bytes: Buffer.from(`req1279-${method}-png`).toString('base64'), mime: 'image/png', width: 320, height: 240, filename: `${method}-badge.png` };
  }
  const spec = BINARY_EXPORTS[method];
  if (spec) return { bytes: FP_B64, mime: spec.mime, filename: spec.filename };
  throw new Error(`stub tab has no payload for ${group}.${method}`);
}

const MANIFEST: any = {
  canvas: {
    screenshot: { doc: 'Captures the live canvas as a PNG screenshot.', params: {}, result: 'image' },
  },
  export: {
    layer: { doc: 'Exports a single layer as a raster image.', params: { id: { type: 'string', required: true } }, result: 'image' },
    artboard: { doc: 'Exports an artboard as a raster image.', params: { id: { type: 'string', required: true } }, result: 'image' },
    project: {
      doc: 'Exports the whole project as pdf/zip/figpea.',
      params: { input: { type: 'object', required: false, shape: { format: { type: 'string', required: false, enum: ['pdf', 'zip', 'figpea'] } } } },
      result: 'binary',
    },
    originals: { doc: 'Exports the source/original files as a zip.', params: {}, result: 'binary' },
    assetHarvest: { doc: 'Harvests assets as a zip.', params: {}, result: 'binary' },
    figmaKit: { doc: 'Exports a Figma handoff kit as a zip.', params: {}, result: 'binary' },
    contactSheet: { doc: 'Exports a printable contact sheet as a PDF.', params: {}, result: 'binary' },
    flowPoster: { doc: 'Exports a flow poster.', params: { renderFormat: { type: 'string', required: false, enum: ['png', 'svg', 'pdf'] } }, result: 'binary' },
  },
};

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function createHarnessedClient(toolMode: 'full' | 'compact' = 'full') {
  const realBridge: any = await startBridgeServer({ port: 0 });
  const stub: any = {
    port: realBridge.port,
    token: realBridge.token,
    isTabConnected: () => true,
    onDescribe: (h: any) => h(MANIFEST),
    callTab: async (group: string, method: string) => ({ ok: true, value: payloadFor(group, method) }),
    close: () => realBridge.close(),
    getFileUrl: (fp: string) => realBridge.getFileUrl(fp),
    registerBlob: (fp: string) => realBridge.registerBlob(fp),
  };
  const server = createMcpServer(stub as any, toolMode === 'compact' ? { toolMode: 'compact' } : undefined);
  const client = new Client({ name: 'req1279-binary-return', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { client, stub, realBridge };
}

function textOf(res: any): string {
  const blocks = (res.content as any[]).filter((c: any) => c.type === 'text');
  expect(blocks, 'a text content block is present').toHaveLength(1);
  return blocks[0].text;
}
function payloadOf(res: any): any {
  return JSON.parse(textOf(res));
}

describe('REQ-1279 AC-1: returnAs:"path" on a non-image export reaches disk instead of returning base64', () => {
  it('figpea_call(export.project, returnAs:"path") returns a path, not a base64 blob', async () => {
    const { client } = await createHarnessedClient('compact');
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group: 'export', method: 'project', args: [{ format: 'figpea' }], returnAs: 'path' } as any,
    });
    expect(res.isError, 'path mode is not an error').toBe(false);
    expect((res.content as any[]).some((c: any) => c.type === 'image'), 'no image block crosses the wire').toBe(false);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(true);
    // The defect: the base64 payload came back with NO `path` key, so nothing
    // ever reached disk. The closed behaviour is a real path, and no base64.
    expect(payload, 'the payload carries a path').not.toHaveProperty('value');
    expect(typeof payload.path, 'a path came back').toBe('string');
    expect(textOf(res), 'no base64 is relayed to the caller').not.toContain(FP_B64);
  });
});

describe('REQ-1279 AC-2: the path payload is {ok, path, mime, bytes} with a .fp path', () => {
  it('export_project with returnAs:"path" returns one text block, a .fp path, the payload mime and the raw byte count', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({
      name: 'export_project',
      arguments: { input: { format: 'figpea' }, returnAs: 'path' } as any,
    });
    expect(res.isError).toBe(false);
    expect((res.content as any[]).some((c: any) => c.type === 'image')).toBe(false);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(true);
    expect(payload.path, 'the path ends in .fp, never .bin').toMatch(/\.fp$/);
    expect(payload.mime).toBe('application/zip');
    expect(payload.bytes, 'bytes is the decoded payload length').toBe(FP_BYTES.length);
    // Asserted on the WHOLE returned text, not on a key subset: the caller must
    // not be handed the base64 it asked not to have.
    expect(textOf(res), 'no base64 in the returned text').not.toContain(FP_B64);
  });
});

describe('REQ-1279 AC-3: the written file is a readable ZIP, byte-identical to the inline payload', () => {
  it('the bytes on disk equal the inline payload and the ZIP holds the same entries', async () => {
    const { client } = await createHarnessedClient('full');
    const inline: any = await client.callTool({ name: 'export_project', arguments: { input: { format: 'figpea' } } as any });
    const offBand: any = await client.callTool({
      name: 'export_project',
      arguments: { input: { format: 'figpea' }, returnAs: 'path' } as any,
    });
    const written = fs.readFileSync(payloadOf(offBand).path);
    expect(written.equals(Buffer.from(payloadOf(inline).value.bytes, 'base64')), 'off-band bytes equal the inline bytes').toBe(true);
    expect(zipEntryNames(written), 'the written file is a readable ZIP with the project entries').toEqual(['main.fpe', 'repo.json']);
  });
});

describe('REQ-1279 AC-4: the written path is fetchable over the bridge with permissive CORS', () => {
  it('the payload url serves the bytes with Access-Control-Allow-Origin: *', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({
      name: 'export_project',
      arguments: { input: { format: 'figpea' }, returnAs: 'path' } as any,
    });
    const payload = payloadOf(res);
    expect(typeof payload.url, 'a blob url comes back').toBe('string');
    const fetched = await fetch(payload.url);
    expect(fetched.status, 'the blob url serves the file').toBe(200);
    expect(fetched.headers.get('access-control-allow-origin'), 'permissive CORS, as image mode already is').toBe('*');
    expect(Buffer.from(await fetched.arrayBuffer()).equals(FP_BYTES), 'the served body is the payload').toBe(true);
  });
});

describe('REQ-1279 AC-5: the three image tools keep their existing path payload', () => {
  it.each([
    ['canvas_screenshot', {}],
    ['export_layer', { id: 'layer-1' }],
    ['export_artboard', { id: 'page-1' }],
  ])('%s with returnAs:"path" still returns path/mime/width/height/bytes', async (tool, args) => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: tool, arguments: { ...args, returnAs: 'path' } as any });
    expect(res.isError).toBe(false);
    const payload = payloadOf(res);
    for (const key of ['path', 'mime', 'width', 'height', 'bytes']) {
      expect(payload[key], `${tool} payload carries ${key}`).toBeDefined();
    }
    expect(payload.mime).toBe('image/png');
    const expected = fs.existsSync(payload.path) ? fs.readFileSync(payload.path) : null;
    expect(expected, 'the image bytes were written').not.toBeNull();
    expect(payload.bytes, 'bytes is the written size').toBe(expected!.length);
  });

  it('canvas.screenshot is byte-identical to before: no filename key, no stem in the on-disk name', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'canvas_screenshot', arguments: { returnAs: 'path' } as any });
    const payload = payloadOf(res);
    expect(payload, 'a payload with no filename gains no filename key').not.toHaveProperty('filename');
    expect(path.basename(payload.path), 'the on-disk name is still <tool>-<stamp>-<uuid>.png').toMatch(
      /^canvas_screenshot-[\dTZ:-]+-[0-9a-f-]{36}\.png$/,
    );
  });
});

describe('REQ-1279 AC-6: inline (the default) is untouched — the pre-fix shape, deliberately preserved', () => {
  it.each([
    ['returnAs:"inline" explicitly', { returnAs: 'inline' }],
    ['returnAs omitted entirely', {}],
  ])('%s returns the same base64 payload, as one text block and no image block', async (_label, extra) => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'export_project', arguments: { input: { format: 'figpea' }, ...extra } as any });
    expect(res.isError).toBe(false);
    expect((res.content as any[]).some((c: any) => c.type === 'image'), 'a non-image mime is never emitted as image content').toBe(false);
    expect(payloadOf(res)).toEqual({ ok: true, value: { bytes: FP_B64, mime: 'application/zip', filename: 'My Design.fp' } });
  });
});

describe('REQ-1279 AC-7: every binary export is covered, each correctly named', () => {
  it.each([
    ['export_originals', {}, 'zip'],
    ['export_assetHarvest', {}, 'zip'],
    ['export_figmaKit', {}, 'zip'],
    ['export_contactSheet', {}, 'pdf'],
    ['export_flowPoster', { renderFormat: 'svg' }, 'svg'],
  ])('%s with returnAs:"path" writes a correctly-named file, never .bin', async (tool, args, ext) => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: tool, arguments: { ...args, returnAs: 'path' } as any });
    expect(res.isError, `${tool} path mode is not an error`).toBe(false);
    const payload = payloadOf(res);
    expect(typeof payload.path).toBe('string');
    expect(payload.path, `${tool} keeps its own extension`).toMatch(new RegExp(`\\.${ext}$`));
    expect(payload.path, `${tool} is never written as .bin`).not.toMatch(/\.bin$/);
    expect(fs.existsSync(payload.path), 'the file exists').toBe(true);
    expect(payload.filename, 'the payload name is reported back').toBe((BINARY_EXPORTS[tool.replace('export_', '')] as any).filename);
  });
});
