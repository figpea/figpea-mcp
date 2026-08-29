import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startBridgeServer, CLOSE_CODE_BAD_TOKEN } from './bridgeServer';

describe('REQ-1017 figpea-mcp tolerant token check — RED before fix', () => {
  let handles: any[] = [];
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      try { ws.close(); } catch {}
    }
    sockets = [];
    for (const h of handles) {
      try { await h.close(); } catch {}
    }
    handles = [];
    // small delay to let ports close
    await new Promise((r) => setTimeout(r, 50));
  });

  function waitForClose(ws: WebSocket, timeout = 2000): Promise<{ code: number }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitForClose timeout')), timeout);
      ws.once('close', (code: number) => {
        clearTimeout(timer);
        resolve({ code });
      });
    });
  }

  function waitForDescribeResult(ws: WebSocket, timeout = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitForDescribeResult timeout')), timeout);
      ws.once('message', (data: WebSocket.RawData) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
  }

  it('AC-2: server accepts hello token with surrounding whitespace (trim tolerance)', async () => {
    const bridge = await startBridgeServer();
    handles.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    // Send hello with whitespace-wrapped token — tolerant server should accept it
    ws.send(JSON.stringify({ type: 'hello', token: `  ${bridge.token}  ` }));
    // Tolerant fix: should receive describe frame, not a BAD_TOKEN close
    const frame = await waitForDescribeResult(ws, 3000);
    expect(frame.type).toBe('describe');
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('AC-2: server accepts hello token that is URL-encoded once', async () => {
    const bridge = await startBridgeServer();
    handles.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const encoded = encodeURIComponent(bridge.token);
    // If token has no special chars, encoded equals raw — use a token with spaces to force encoding
    // Our bridge token is a UUID (no spaces), so we simulate by sending encoded UUID — tolerant server decodes once
    // UUID encode is no-op, so this test uses a whitespace-padded encoded variant to prove decode+trim
    const paddedEncoded = encodeURIComponent(` ${bridge.token} `);
    ws.send(JSON.stringify({ type: 'hello', token: paddedEncoded }));
    const frame = await waitForDescribeResult(ws, 3000);
    expect(frame.type).toBe('describe');
  });

  it('AC-4: strict mismatch (wrong token) still closes with 4001 BAD_TOKEN', async () => {
    const bridge = await startBridgeServer();
    handles.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'hello', token: 'definitely-wrong-token-12345' }));
    const { code } = await waitForClose(ws, 3000);
    expect(code).toBe(CLOSE_CODE_BAD_TOKEN);
  });
});
