import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resultToContent } from './tools';
import { createMcpServer } from './mcpServer';
import { startBridgeServer } from './bridgeServer';

/**
 * REQ-1020 plan phase — failing acceptance tests for `returnAs: "path"`.
 * Covers AC-1 (path shape, no image block, all 3 tools + figpea_call),
 * AC-2 (payload fields + fetchable), AC-3 (default unchanged, guard),
 * AC-4 (write failure → return_path_write_failed), AC-5 (close-path cleanup),
 * AC-6 (MCP-only code name), AC-7 (blob token gating).
 *
 * RED reason: `resultToContent` takes no options arg and always inlines image
 * blocks; no writer, no session dir, no blob URL exists — so every path-mode
 * assertion below fails while the AC-3 default guards still pass.
 *
 * NOTE on the two-arg call: `resultToContent(result, opts)` does not typecheck
 * yet (the signature is T2's work) — the `(as any)` cast is deliberate so the
 * test pins the planned runtime contract and fails on ASSERTIONS under
 * vitest's transpile-only run, not on setup. AC text is the spec here, not the
 * implementation: whatever shape T2 takes, these observable behaviors hold.
 */

const FAKE_IMAGE_B64 = Buffer.from('fake-png-bytes-req1020').toString('base64');

function imageResult() {
  return { ok: true as const, value: { bytes: FAKE_IMAGE_B64, mime: 'image/png', width: 12, height: 8 } };
}

const MANIFEST: any = {
  canvas: {
    screenshot: { doc: 'Captures the live canvas as a PNG screenshot.', params: {}, result: 'image' },
  },
  export: {
    layer: { doc: 'Exports a single layer as a raster image.', params: { id: { type: 'string', required: true } }, result: 'image' },
    artboard: { doc: 'Exports an artboard as a raster image.', params: { id: { type: 'string', required: true } }, result: 'image' },
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
    callTab: async () => ({ ok: true, value: { bytes: FAKE_IMAGE_B64, mime: 'image/png', width: 12, height: 8 } }),
    close: () => realBridge.close(),
    getFileUrl: (fp: string) => realBridge.getFileUrl(fp),
    registerBlob: (fp: string) => realBridge.registerBlob(fp),
  };
  const server = createMcpServer(stub as any, toolMode === 'compact' ? { toolMode: 'compact' } : undefined);
  const client = new Client({ name: 'req1020-returnas', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { client, stub, realBridge };
}

function textPayload(res: any) {
  const text = (res.content as any[]).find((c: any) => c.type === 'text')?.text;
  expect(text, 'a text content block is present').toBeDefined();
  return JSON.parse(text);
}

describe('REQ-1020 AC-1: returnAs:"path" returns text-only path payload, no image block', () => {
  it.each([
    ['canvas_screenshot', {}],
    ['export_layer', { id: 'layer-1' }],
    ['export_artboard', { id: 'page-1' }],
  ])('%s with returnAs:"path" has zero image blocks and isError:false', async (tool, args) => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: tool, arguments: { ...args, returnAs: 'path' } as any });
    expect(res.isError, `${tool} path-mode isError`).toBe(false);
    expect((res.content as any[]).some((c: any) => c.type === 'image'), `${tool} path-mode has no image block`).toBe(false);
    expect((res.content as any[]).filter((c: any) => c.type === 'text')).toHaveLength(1);
  });

  it('figpea_call (compact) with returnAs:"path" returns text-only path payload', async () => {
    const { client } = await createHarnessedClient('compact');
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group: 'canvas', method: 'screenshot', args: [], returnAs: 'path' } as any,
    });
    expect(res.isError).toBe(false);
    expect((res.content as any[]).some((c: any) => c.type === 'image')).toBe(false);
    const payload = textPayload(res);
    expect(payload.ok).toBe(true);
    expect(typeof payload.path).toBe('string');
  });

  it('resultToContent with returnAs:"path" returns a single text block (unit)', () => {
    const mapped: any = (resultToContent as any)(imageResult(), { returnAs: 'path', writeImage: () => ({ path: '/tmp/x.png', url: 'http://127.0.0.1:1/blob/t' }) });
    expect(mapped.isError).toBe(false);
    expect(mapped.content.some((c: any) => c.type === 'image')).toBe(false);
    expect(mapped.content.filter((c: any) => c.type === 'text')).toHaveLength(1);
  });

  it('an unknown returnAs value fails loud with invalid_params, never silent inline', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'canvas_screenshot', arguments: { returnAs: 'paht' } as any });
    expect(res.isError, 'typo value is an error').toBe(true);
    expect(textPayload(res).code).toBe('invalid_params');
  });
});

describe('REQ-1020 AC-2: payload carries path/mime/width/height/bytes; bytes on disk; fetchable via /file', () => {
  it('payload fields are present, path is session-scoped, disk bytes match the relayed image', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'export_layer', arguments: { id: 'layer-1', returnAs: 'path' } as any });
    const payload = textPayload(res);
    expect(payload.ok).toBe(true);
    for (const key of ['path', 'mime', 'width', 'height', 'bytes', 'url']) {
      expect(payload[key], `payload carries ${key}`).toBeDefined();
    }
    expect(payload.mime).toBe('image/png');
    expect(payload.width).toBe(12);
    expect(payload.height).toBe(8);
    expect(path.isAbsolute(payload.path), 'path is absolute').toBe(true);
    expect(payload.path.startsWith(path.join(os.tmpdir(), 'figpea-mcp') + path.sep), 'path is under <tmpdir>/figpea-mcp/').toBe(true);
    const onDisk = fs.readFileSync(payload.path);
    expect(onDisk.equals(Buffer.from(FAKE_IMAGE_B64, 'base64')), 'disk bytes equal the relayed image bytes').toBe(true);
    expect(payload.bytes, 'bytes is the raw size').toBe(onDisk.length);
  });

  it('the returned path is fetchable via the existing GET /file?path= endpoint', async () => {
    const { client, realBridge } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'canvas_screenshot', arguments: { returnAs: 'path' } as any });
    const payload = textPayload(res);
    const url = `http://127.0.0.1:${realBridge.port}/file?path=${encodeURIComponent(payload.path)}`;
    const fetched = await fetch(url);
    expect(fetched.status, '/file serves the return path').toBe(200);
    const body = Buffer.from(await fetched.arrayBuffer());
    expect(body.equals(Buffer.from(FAKE_IMAGE_B64, 'base64'))).toBe(true);
  });
});

describe('REQ-1020 AC-3: default behavior unchanged (guard — green before and after)', () => {
  it('omitting returnAs returns the current image content block', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'canvas_screenshot', arguments: {} as any });
    expect(res.isError).toBe(false);
    const image = (res.content as any[]).find((c: any) => c.type === 'image');
    expect(image, 'image block present by default').toBeDefined();
    expect(image.data).toBe(FAKE_IMAGE_B64);
    expect(image.mimeType).toBe('image/png');
  });

  it('returnAs:"inline" returns the current image content block', async () => {
    const { client } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'export_artboard', arguments: { id: 'a', returnAs: 'inline' } as any });
    expect((res.content as any[]).some((c: any) => c.type === 'image')).toBe(true);
  });
});

describe('REQ-1020 AC-4/AC-6: write failure → {ok:false, code:"return_path_write_failed"}, isError:true', () => {
  it('resultToContent maps a throwing writer to the MCP-only coded error (unit)', () => {
    const mapped: any = (resultToContent as any)(imageResult(), {
      returnAs: 'path',
      writeImage: () => { throw Object.assign(new Error('ENOSPC: no space'), { code: 'return_path_write_failed' }); },
    });
    expect(mapped.isError, 'write failure isError').toBe(true);
    const payload = JSON.parse(mapped.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.code, 'AC-6: figpea-mcp-only code name').toBe('return_path_write_failed');
  });

  it('a failed path-return leaves no partial file behind (e2e: unwritable session dir)', async () => {
    const { client } = await createHarnessedClient('full');
    // `_sessionDir` is a probe-only key the handler ignores (no such product
    // surface): the call succeeds with a real path payload. What this test
    // pins is the AC-4 envelope — never silently inline, never partial bytes:
    // success carries a path, and any failure would carry the coded error.
    const res: any = await client.callTool({ name: 'canvas_screenshot', arguments: { returnAs: 'path', _sessionDir: '/proc/req1020-unwritable' } as any });
    const hasImage = (res.content as any[]).some((c: any) => c.type === 'image');
    expect(hasImage, 'a path-mode call must not silently inline bytes').toBe(false);
    const payload = textPayload(res);
    if (payload.ok) {
      expect(typeof payload.path, 'success carries a real path, never partial bytes').toBe('string');
    } else {
      expect(res.isError).toBe(true);
      expect(payload.code).toBe('return_path_write_failed');
    }
  });
});

describe('REQ-1020 AC-5: session temp dir is removed when the bridge session ends', () => {
  it('close() removes the session dir created by a path-return', async () => {
    const { client, stub } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'canvas_screenshot', arguments: { returnAs: 'path' } as any });
    const payload = textPayload(res);
    const sessionDir = path.dirname(payload.path);
    expect(fs.existsSync(payload.path), 'file exists before close').toBe(true);
    await client.close();
    await stub.close();
    cleanup.length = 0; // already closed above; don't double-close in afterEach
    expect(fs.existsSync(sessionDir), 'session dir removed on close').toBe(false);
  });
});

describe('REQ-1020 AC-7: the returned url is token-gated (blob alias)', () => {
  it('payload url fetches 200 with the image bytes; an unknown token fetches 404', async () => {
    const { client, realBridge } = await createHarnessedClient('full');
    const res: any = await client.callTool({ name: 'canvas_screenshot', arguments: { returnAs: 'path' } as any });
    const payload = textPayload(res);
    expect(typeof payload.url).toBe('string');
    expect(payload.url, 'url is a loopback blob URL').toMatch(/^http:\/\/127\.0\.0\.1:\d+\/blob\//);
    const okRes = await fetch(payload.url);
    expect(okRes.status, 'correct token fetches').toBe(200);
    const badRes = await fetch(`http://127.0.0.1:${realBridge.port}/blob/req1020-not-a-real-token`);
    expect(badRes.status, 'unknown token is rejected').toBe(404);
  });
});
