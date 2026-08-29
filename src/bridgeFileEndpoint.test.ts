import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startBridgeServer } from './bridgeServer';

/**
 * REQ-1017 plan phase — failing acceptance tests for bridge HTTP file endpoint.
 * AC-5: GET /file?path must return ACAO:* + correct MIME.
 * AC-1-4: filePath handling depends on this endpoint being present.
 *
 * RED reason: bridgeServer currently has no HTTP file handler, so fetches
 * either 404/426 or lack ACAO header. All assertions below fail.
 */

let handles: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const h of handles) await h.close();
  handles = [];
});

function tmpFile(ext: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1017-'));
  const fp = path.join(dir, `sample${ext}`);
  fs.writeFileSync(fp, content);
  return fp;
}

describe('REQ-1017 AC-5: bridge HTTP file endpoint CORS + MIME', () => {
  it('GET /file?path=<local image> returns 200, ACAO:*, and image/jpeg', async () => {
    const fp = tmpFile('.jpg', 'fake-jpeg-bytes');
    const bridge: any = await startBridgeServer();
    handles.push(bridge);
    const url = `http://127.0.0.1:${bridge.port}/file?path=${encodeURIComponent(fp)}`;
    const res = await fetch(url);
    expect(res.status, 'file endpoint is reachable').toBe(200);
    expect(res.headers.get('access-control-allow-origin'), 'ACAO:*').toBe('*');
    expect(res.headers.get('content-type'), 'mime for .jpg').toMatch(/image\/jpeg/);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it('GET /file?path=<.fp file> uses application/octet-stream or similar and has ACAO', async () => {
    const fp = tmpFile('.fp', '{"fake":"fp"}');
    const bridge: any = await startBridgeServer();
    handles.push(bridge);
    const url = `http://127.0.0.1:${bridge.port}/file?path=${encodeURIComponent(fp)}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toBeTruthy();
  });

  it('GET /file?path=<non-existent> returns 404 with JSON code not_found/open_failed and still has ACAO', async () => {
    const bridge: any = await startBridgeServer();
    handles.push(bridge);
    const url = `http://127.0.0.1:${bridge.port}/file?path=${encodeURIComponent('/tmp/does-not-exist-req1017-404-xyz.jpg')}`;
    const res = await fetch(url);
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('OPTIONS preflight to /file returns 204 with ACAO', async () => {
    const bridge: any = await startBridgeServer();
    handles.push(bridge);
    const url = `http://127.0.0.1:${bridge.port}/file?path=${encodeURIComponent('/tmp/x.jpg')}`;
    const res = await fetch(url, { method: 'OPTIONS' });
    expect([200, 204].includes(res.status), 'preflight status').toBe(true);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
