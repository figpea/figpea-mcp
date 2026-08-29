import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { startBridgeServer } from './bridgeServer';

/**
 * REQ-1017 plan phase — failing tests for filePath→bridge-URL translation in MCP.
 * AC-1 (openFile), AC-2 (setImageFill), AC-3 (create image), AC-4 (invalid path).
 *
 * RED reason: mcpServer currently has no filePath interception, so tools either
 * reject filePath as unexpected or forward it verbatim and the bridge call
 * never carries a loopback http URL; assertions for http://127.0.0.1 and for
 * structured error codes fail.
 */

function tmpFile(ext: string, content = 'x'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1017-mcp-'));
  const fp = path.join(dir, `f${ext}`);
  fs.writeFileSync(fp, content);
  return fp;
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function createHarnessedClient(bridgePort: number, bridgeToken: string, fakeCallTab: (g: string, m: string, a: unknown[]) => Promise<unknown>) {
  const realBridge: any = await startBridgeServer({ port: 0 });
  // Override port/token to deterministic harness? Instead use realBridge port for file serving check;
  // we need a stub bridge that also serves files — so use real bridge's file handler but stub callTab
  const stub: any = {
    port: realBridge.port,
    token: realBridge.token,
    isTabConnected: () => true,
    onDescribe: (h: any) => h({
      session: {
        openFile: { doc: 'open', params: { input: { type: 'object', required: true, shape: { url: { type: 'string', required: false }, bytes: { type: 'array', required: false }, filePath: { type: 'string', required: false } } } }, result: 'void' },
      },
      layer: {
        setImageFill: { doc: 'fill', params: { id: { type: 'string', required: true }, source: { type: 'object', required: true, shape: { url: { type: 'string', required: false }, bytes: { type: 'array', required: false }, filePath: { type: 'string', required: false } } } }, result: 'void' },
        create: { doc: 'create', params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false, shape: {}, byKind: { image: { filePath: { type: 'string', required: false }, url: { type: 'string', required: false } } } } }, result: { id: 'string' } },
      },
    }),
    callTab: fakeCallTab,
    close: () => realBridge.close(),
    getFileUrl: (fp: string) => `http://127.0.0.1:${realBridge.port}/file?path=${encodeURIComponent(fp)}`,
  };
  const server = createMcpServer(stub as any);
  const client = new Client({ name: 'req1017-translation', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { client, stub, realBridge };
}

describe('REQ-1017 AC-1: session_openFile filePath→bridge URL', () => {
  it('translates filePath to http://127.0.0.1 bridge URL before relaying', async () => {
    const fp = tmpFile('.fp', '{"k":"v"}');
    let relayedArgs: unknown[] = [];
    const { client } = await createHarnessedClient(0, '', async (g, m, a) => { relayedArgs = a; return { ok: true, value: undefined }; });
    await client.callTool({ name: 'session_openFile', arguments: { input: { filePath: fp } } as any });
    const input = (relayedArgs[0] as any);
    expect(input?.url, 'MCP maps filePath to url').toMatch(/^http:\/\/127\.0\.0\.1:\d+\/file\?path=/);
    expect(input?.filePath, 'filePath stripped before relay').toBeUndefined();
  });

  it('returns open_failed for non-existent filePath without relaying (AC-4)', async () => {
    let called = false;
    const { client } = await createHarnessedClient(0, '', async () => { called = true; return { ok: true } as any; });
    const res: any = await client.callTool({ name: 'session_openFile', arguments: { input: { filePath: '/tmp/does-not-exist-req1017-xyz.fp' } } as any });
    const text = (res.content as any).find((c: any) => c.type === 'text')?.text;
    const payload = JSON.parse(text);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('open_failed');
    expect(called, 'no bridge relay on bad path').toBe(false);
  });
});

describe('REQ-1017 AC-2: layer_setImageFill filePath→bridge URL', () => {
  it('translates source.filePath to url with loopback', async () => {
    const fp = tmpFile('.jpg', 'jpegbytes');
    let relayed: unknown[] = [];
    const { client } = await createHarnessedClient(0, '', async (g, m, a) => { relayed = a; return { ok: true, value: undefined }; });
    await client.callTool({ name: 'layer_setImageFill', arguments: { id: 'layer-1', source: { filePath: fp } } as any });
    const source = (relayed[1] as any);
    expect(source?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/file\?path=/);
    expect(source?.filePath).toBeUndefined();
  });
});

describe('REQ-1017 AC-3: layer_create image filePath', () => {
  it('translates props.filePath to props.url for image kind', async () => {
    const fp = tmpFile('.png', 'pngbytes');
    let relayed: unknown[] = [];
    const { client } = await createHarnessedClient(0, '', async (g, m, a) => { relayed = a; return { ok: true, value: { id: 'new-id' } }; });
    await client.callTool({ name: 'layer_create', arguments: { kind: 'image', props: { filePath: fp } } as any });
    const props = (relayed[1] as any);
    expect(props?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/file\?path=/);
    expect(props?.filePath).toBeUndefined();
  });
});
