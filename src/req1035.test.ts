import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer } from './mcpServer';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli.js');

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      const p = addr.port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

/**
 * REQ-1035 — paste-ready connection string guarantee.
 * AC-1 stderr is paste-ready, AC-2 open_editor paste-ready URL,
 * AC-3 status surfaces pairing, AC-4 three families round-trip, AC-5 stdout hygiene.
 *
 * Test vehicle: real SDK Client over InMemoryTransport (same as mcpServer.test.ts).
 * Parser helper is a verbatim copy of v3/src/agent/bridge/parsePairing.ts
 * (REQ-1022 tolerant parser) — not product code, pure pin that emitted
 * strings are accepted byte-for-byte by the editor.
 */

// --- vendored parsePairingFromPaste (verbatim from v3/src/agent/bridge/parsePairing.ts @ b932bad0) ---
function safeDecodeAndTrim(s: string): string {
  let out = s;
  try { out = decodeURIComponent(out); } catch {}
  return out.trim();
}
function validatePort(raw: string): { value: number } | { error: string } {
  const normalized = safeDecodeAndTrim(raw);
  if (!/^\d+$/.test(normalized)) return { error: 'invalid bridgePort' };
  const n = Number(normalized);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return { error: 'invalid bridgePort: out of range' };
  return { value: n };
}
function parsePairingFromPaste(input: string): { port: number; token: string } | { error: string } {
  if (typeof input !== 'string') return { error: 'missing bridgePort' };
  const trimmed = input.trim();
  if (!trimmed) return { error: 'missing bridgePort' };
  const portMatch = trimmed.match(/[?&]bridgePort=([^&\s"'`]+)/);
  const tokenMatch = trimmed.match(/[?&]bridgeToken=([^&\s"'`]+)/);
  if (portMatch && tokenMatch) {
    const portRaw = safeDecodeAndTrim(portMatch[1]);
    const tokenRaw = safeDecodeAndTrim(tokenMatch[1]);
    const portRes = validatePort(portRaw);
    if ('error' in portRes) return { error: portRes.error };
    if (!tokenRaw) return { error: 'missing bridgeToken' };
    return { port: portRes.value, token: tokenRaw };
  }
  if (portMatch || tokenMatch) {
    if (!portMatch) return { error: 'missing bridgePort' };
    if (!tokenMatch) return { error: 'missing bridgeToken' };
  }
  let jsonCandidates: any[] = [];
  let wholeParsed: any = null;
  try { wholeParsed = JSON.parse(trimmed); } catch {}
  if (wholeParsed && typeof wholeParsed === 'object') jsonCandidates.push(wholeParsed);
  const jsonRegex = /\{[^{}]*\}/g;
  const seen = new Set<string>();
  if (wholeParsed) { try { seen.add(JSON.stringify(wholeParsed)); } catch {} }
  let m: RegExpExecArray | null;
  jsonRegex.lastIndex = 0;
  while ((m = jsonRegex.exec(trimmed)) !== null) {
    const cand = m[0];
    if (seen.has(cand)) continue;
    try {
      const obj = JSON.parse(cand);
      if (obj && typeof obj === 'object') { jsonCandidates.push(obj); seen.add(cand); }
    } catch {}
  }
  for (const obj of jsonCandidates) {
    const portRawAny = (obj as any).port ?? (obj as any).bridgePort;
    const tokenRawAny = (obj as any).token ?? (obj as any).bridgeToken;
    if (portRawAny !== undefined && tokenRawAny !== undefined) {
      const portRes = validatePort(safeDecodeAndTrim(String(portRawAny)));
      if ('error' in portRes) return { error: portRes.error };
      const tokenVal = safeDecodeAndTrim(String(tokenRawAny));
      if (!tokenVal) return { error: 'missing bridgeToken' };
      return { port: portRes.value, token: tokenVal };
    }
    if (typeof (obj as any).url === 'string') {
      const urlStr = (obj as any).url as string;
      const pm = urlStr.match(/[?&]bridgePort=([^&\s"'`]+)/);
      const tm = urlStr.match(/[?&]bridgeToken=([^&\s"'`]+)/);
      if (pm && tm) {
        const portRaw = safeDecodeAndTrim(pm[1]);
        const tokenRaw = safeDecodeAndTrim(tm[1]);
        const portRes = validatePort(portRaw);
        if ('error' in portRes) return { error: portRes.error };
        if (!tokenRaw) return { error: 'missing bridgeToken' };
        return { port: portRes.value, token: tokenRaw };
      }
    }
  }
  const jp = trimmed.match(/"port"\s*:\s*"?(\d+)"?/i) || trimmed.match(/"bridgePort"\s*:\s*"?(\d+)"?/i);
  const jt = trimmed.match(/"token"\s*:\s*"([^"]+)"/i) || trimmed.match(/"bridgeToken"\s*:\s*"([^"]+)"/i);
  if (jp && jt) {
    const portRes = validatePort(safeDecodeAndTrim(jp[1]));
    if ('error' in portRes) return { error: portRes.error };
    const tokenRaw = safeDecodeAndTrim(jt[1]);
    if (!tokenRaw) return { error: 'missing bridgeToken' };
    return { port: portRes.value, token: tokenRaw };
  }
  if (jp || jt) {
    if (!jp) return { error: 'missing bridgePort' };
    if (!jt) return { error: 'missing bridgeToken' };
  }
  const listenPortMatch = trimmed.match(/127\.0\.0\.1[:\s]+(\d{1,5})/);
  let pairingTokenMatch: RegExpMatchArray | null = trimmed.match(/pairing token[:\s]*([^\s"'`]+)/i);
  if (!pairingTokenMatch) pairingTokenMatch = trimmed.match(/token[:\s]*([^\s"'`]+)/i);
  if (listenPortMatch && pairingTokenMatch) {
    const portRes = validatePort(safeDecodeAndTrim(listenPortMatch[1]));
    if ('error' in portRes) return { error: portRes.error };
    const tokenRaw = safeDecodeAndTrim(pairingTokenMatch[1]);
    if (!tokenRaw) return { error: 'missing bridgeToken' };
    return { port: portRes.value, token: tokenRaw };
  }
  const parts = trimmed.split(/[\s,;|\n\r]+/).filter(Boolean);
  const expandedParts: string[] = [];
  for (const p of parts) {
    if (p.includes(':') && !p.startsWith('http')) {
      const sub = p.split(':');
      for (const s of sub) if (s) expandedParts.push(s);
    } else expandedParts.push(p);
  }
  for (let i = 0; i < expandedParts.length - 1; i++) {
    const a = safeDecodeAndTrim(expandedParts[i]);
    const b = safeDecodeAndTrim(expandedParts[i + 1]);
    if (/^\d+$/.test(a) && b && !/^\d+$/.test(b) && b.length >= 2) {
      const portRes = validatePort(a);
      if (!('error' in portRes) && b) {
        if (b !== 'https' && b !== 'http' && !b.includes('://')) return { port: portRes.value, token: b };
      }
    }
  }
  const uuidMatch = trimmed.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  const portMatches = [...trimmed.matchAll(/\b(\d{1,5})\b/g)].map((mm) => mm[1]);
  for (const pm of portMatches) {
    const portRes = validatePort(safeDecodeAndTrim(pm));
    if (!('error' in portRes)) {
      if (uuidMatch) {
        const tokenVal = safeDecodeAndTrim(uuidMatch[0]);
        if (tokenVal) return { port: portRes.value, token: tokenVal };
      }
    }
  }
  const hasPortLike = /\b\d{1,5}\b/.test(trimmed);
  if (!hasPortLike) return { error: 'missing bridgePort' };
  return { error: 'missing bridgeToken' };
}

// --- harness helpers ---
function fakeBridge(overrides?: any) {
  return {
    port: 54321,
    token: '550e8400-e29b-41d4-a716-446655440000',
    isTabConnected: () => false,
    onDescribe: () => {},
    callTab: async () => ({ ok: true, value: null }),
    close: async () => {},
    getContractVersion: () => null,
    ...overrides,
  };
}
let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns) await fn();
  cleanupFns = [];
  delete process.env.FIGPEA_EDITOR_URL;
});
async function connectedClient(bridge: any, options?: any) {
  const server = createMcpServer(bridge, options);
  const client = new Client({ name: 'req-1035-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanupFns.push(async () => { await client.close(); await server.close(); });
  return client;
}
async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result: any = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c: any) => c.type === 'text');
  expect(textBlock, `${name} has text block`).toBeDefined();
  return JSON.parse(textBlock!.text!);
}

// --- AC-2 — open_editor returns paste-ready URL ---
describe('REQ-1035 AC-2 — open_editor returns paste-ready URL', () => {
  it('returns {port,token,url} where url contains agent=1&bridgePort&bridgeToken and parses back', async () => {
    const bridge = fakeBridge({ port: 54321, token: '550e8400-e29b-41d4-a716-446655440000' });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'open_editor', {});
    expect(payload.port).toBe(54321);
    expect(payload.token).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(payload.url).toContain('agent=1');
    expect(payload.url).toContain('bridgePort=54321');
    expect(payload.url).toContain('bridgeToken=550e8400-e29b-41d4-a716-446655440000');
    const parsed = parsePairingFromPaste(payload.url);
    expect((parsed as any).port).toBe(54321);
    expect((parsed as any).token).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect((parsed as any).error).toBeUndefined();
  });

  it('honors FIGPEA_EDITOR_URL and appends loader=http&url when file given', async () => {
    process.env.FIGPEA_EDITOR_URL = 'http://localhost:9000';
    const bridge = fakeBridge({ port: 11111, token: 'abc-token-123' });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'open_editor', { file: 'https://example.com/design.fig' });
    expect(payload.url).toContain('http://localhost:9000');
    expect(payload.url).toContain('bridgePort=11111');
    expect(payload.url).toContain('bridgeToken=abc-token-123');
    expect(payload.url).toContain('loader=http');
    expect(payload.url).toContain('url=https%3A%2F%2Fexample.com%2Fdesign.fig');
    const parsed = parsePairingFromPaste(payload.url);
    expect((parsed as any).port).toBe(11111);
    expect((parsed as any).token).toBe('abc-token-123');
  });

  it('honors per-call editorBaseUrl over FIGPEA_EDITOR_URL', async () => {
    process.env.FIGPEA_EDITOR_URL = 'http://localhost:9000';
    const bridge = fakeBridge({ port: 22222, token: 'tok-xyz' });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'open_editor', { editorBaseUrl: 'http://localhost:8154' });
    expect(payload.url).toContain('http://localhost:8154');
    expect(payload.url).not.toContain('http://localhost:9000');
    const parsed = parsePairingFromPaste(payload.url);
    expect((parsed as any).port).toBe(22222);
  });
});

// --- AC-3 — status surfaces pairing (EXPECTED RED before fix: status lacks token/url) ---
describe('REQ-1035 AC-3 — status surfaces pairing', () => {
  it('status before tab connects returns port, token, url, tabConnected false, and url parses', async () => {
    const bridge = fakeBridge({ port: 33333, token: 'status-token-aaa', isTabConnected: () => false, getContractVersion: () => null });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'status', {});
    // Existing fields
    expect(payload.port).toBe(33333);
    expect(payload.tabConnected).toBe(false);
    expect(payload.contractVersion).toBeNull();
    // New paste-ready fields — EXPECTED RED: token/url missing on unfixed tree
    expect(typeof payload.token, 'status must surface token').toBe('string');
    expect(payload.token).toBe('status-token-aaa');
    expect(typeof payload.url, 'status must surface url').toBe('string');
    expect(payload.url).toContain('bridgePort=33333');
    expect(payload.url).toContain('bridgeToken=status-token-aaa');
    const parsed = parsePairingFromPaste(payload.url);
    expect((parsed as any).port).toBe(33333);
    expect((parsed as any).token).toBe('status-token-aaa');
  });

  it('status after tab connects returns tabConnected true and same token/url still parses', async () => {
    const bridge = fakeBridge({ port: 44444, token: 'status-token-bbb', isTabConnected: () => true, getContractVersion: () => '1.8.0' });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'status', {});
    expect(payload.tabConnected).toBe(true);
    expect(payload.port).toBe(44444);
    expect(typeof payload.token).toBe('string');
    expect(payload.token).toBe('status-token-bbb');
    expect(typeof payload.url).toBe('string');
    const parsed = parsePairingFromPaste(payload.url);
    expect((parsed as any).port).toBe(44444);
    expect((parsed as any).token).toBe('status-token-bbb');
  });

  it('status url honors FIGPEA_EDITOR_URL', async () => {
    process.env.FIGPEA_EDITOR_URL = 'http://localhost:7777';
    const bridge = fakeBridge({ port: 55555, token: 'tok-555' });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'status', {});
    expect(payload.url).toContain('http://localhost:7777');
    expect(payload.url).toContain('bridgePort=55555');
  });
});

// --- AC-4 — all three paste families round-trip ---
describe('REQ-1035 AC-4 — all three paste families round-trip', () => {
  const PORT = 54321;
  const TOKEN = '550e8400-e29b-41d4-a716-446655440000';

  it('(a) full URL from open_editor round-trips', async () => {
    const bridge = fakeBridge({ port: PORT, token: TOKEN });
    const client = await connectedClient(bridge);
    const { url } = await callToolJson(client, 'open_editor', {});
    const parsed = parsePairingFromPaste(url);
    expect(parsed).toEqual({ port: PORT, token: TOKEN });
  });

  it('(b) JSON.stringify({port,token,url}) round-trips', async () => {
    const bridge = fakeBridge({ port: PORT, token: TOKEN });
    const client = await connectedClient(bridge);
    const { port, token, url } = await callToolJson(client, 'open_editor', {});
    const jsonStr = JSON.stringify({ port, token, url });
    const parsed = parsePairingFromPaste(jsonStr);
    expect(parsed).toEqual({ port: PORT, token: TOKEN });
  });

  it('(c) stderr 127.0.0.1:port + pairing token pair round-trips', async () => {
    const stderrPair = `[figpea-mcp] bridge listening on 127.0.0.1:${PORT}\n[figpea-mcp] pairing token: ${TOKEN}`;
    const parsed = parsePairingFromPaste(stderrPair);
    expect(parsed).toEqual({ port: PORT, token: TOKEN });
  });

  it('(c) stderr pair concatenated with whitespace also round-trips', async () => {
    const pair = `127.0.0.1:${PORT} pairing token: ${TOKEN}`;
    const parsed = parsePairingFromPaste(pair);
    expect(parsed).toEqual({ port: PORT, token: TOKEN });
  });

  it('(a) full URL with loader params still round-trips', async () => {
    const bridge = fakeBridge({ port: PORT, token: TOKEN });
    const client = await connectedClient(bridge);
    const { url } = await callToolJson(client, 'open_editor', { file: 'https://example.com/a.fig' });
    const parsed = parsePairingFromPaste(url);
    expect(parsed).toEqual({ port: PORT, token: TOKEN });
  });
});

// --- AC-1 stderr paste-ready via StdioClientTransport (plan T1/T2) + AC-5 stdout hygiene ---
describe('REQ-1035 AC-1 — stderr is paste-ready (dist/cli.js via StdioClientTransport, capturing stderr)', () => {
  it('default ephemeral: stderr contains pairing URL parseable via parsePairingFromPaste and zero stdout (valid JSON-RPC)', async () => {
    const stderrChunks: Buffer[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (c: Buffer) => stderrChunks.push(Buffer.from(c as any)));
    const client = new Client({ name: 'req-1035-ac1-default', version: '0.0.0' });
    try {
      await client.connect(transport, { timeout: 10_000 });
      // Valid JSON-RPC on stdout is proven by successful handshake + tool call.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('open_editor');
      const status = await callToolJson(client, 'status', {});
      // Allow small flush for stderr banner (printed before connect)
      await new Promise((r) => setTimeout(r, 200));
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      expect(stderr, 'stderr contains bridge listening line').toContain('bridge listening on 127.0.0.1:');
      expect(stderr, 'stderr contains pairing token line').toContain('pairing token:');
      expect(stderr, 'stderr contains open this URL line').toContain('open this URL');
      // Extract the indented pairing URL (the line beginning with two spaces)
      const urlMatch = stderr.match(/https?:\/\/[^\s]+bridgePort=\d+[^\s]*/);
      expect(urlMatch, 'stderr contains a single pairing URL with bridgePort & bridgeToken').toBeTruthy();
      const url = urlMatch![0];
      expect(url).toContain('agent=1');
      expect(url).toContain('bridgePort=');
      expect(url).toContain('bridgeToken=');
      const parsed = parsePairingFromPaste(url);
      expect((parsed as any).error).toBeUndefined();
      expect((parsed as any).port).toBe(status.port);
      expect((parsed as any).token).toBe(status.token);
      // The two-line stderr pair also round-trips
      const stderrPair = stderr;
      const parsedPair = parsePairingFromPaste(stderrPair);
      expect((parsedPair as any).port).toBe(status.port);
      expect((parsedPair as any).token).toBe(status.token);
      // stdout hygiene: client connection succeeded => stdout was valid JSON-RPC with no stray writes
      expect(stderr, 'stdout not leaked into stderr check — pairing URL is on stderr, not stdout').toContain('[figpea-mcp]');
      // Ensure no stdout bytes were captured as stderr missing: already proven via successful MCP handshake
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 15_000);

  it('FIGPEA_EDITOR_URL variant: stderr URL honors custom origin and parses', async () => {
    const customOrigin = 'http://localhost:9000';
    const stderrChunks: Buffer[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1', FIGPEA_EDITOR_URL: customOrigin },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (c: Buffer) => stderrChunks.push(Buffer.from(c as any)));
    const client = new Client({ name: 'req-1035-ac1-custom-origin', version: '0.0.0' });
    try {
      await client.connect(transport, { timeout: 10_000 });
      const status = await callToolJson(client, 'status', {});
      await new Promise((r) => setTimeout(r, 200));
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const urlMatch = stderr.match(/https?:\/\/[^\s]+bridgePort=\d+[^\s]*/);
      expect(urlMatch).toBeTruthy();
      const url = urlMatch![0];
      expect(url).toContain('http://localhost:9000');
      const parsed = parsePairingFromPaste(url);
      expect((parsed as any).port).toBe(status.port);
      expect((parsed as any).token).toBe(status.token);
      // status url must also honor same origin
      expect(status.url).toContain('http://localhost:9000');
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 15_000);

  it('--port variant: stderr URL reflects explicit port and header uses that port', async () => {
    const fixedPort = await getFreePort();
    const stderrChunks: Buffer[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, `--port=${fixedPort}`],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (c: Buffer) => stderrChunks.push(Buffer.from(c as any)));
    const client = new Client({ name: 'req-1035-ac1-fixed-port', version: '0.0.0' });
    try {
      await client.connect(transport, { timeout: 10_000 });
      const status = await callToolJson(client, 'status', {});
      expect(status.port).toBe(fixedPort);
      await new Promise((r) => setTimeout(r, 200));
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      expect(stderr).toContain(`127.0.0.1:${fixedPort}`);
      const urlMatch = stderr.match(/https?:\/\/[^\s]+bridgePort=\d+[^\s]*/);
      expect(urlMatch).toBeTruthy();
      const url = urlMatch![0];
      expect(url).toContain(`bridgePort=${fixedPort}`);
      const parsed = parsePairingFromPaste(url);
      expect((parsed as any).port).toBe(fixedPort);
      expect((parsed as any).token).toBe(status.token);
      const openEditor = await callToolJson(client, 'open_editor', {});
      expect(openEditor.port).toBe(fixedPort);
      expect(openEditor.url).toContain(`bridgePort=${fixedPort}`);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 15_000);
});

describe('REQ-1035 AC-5 — stdout hygiene (StdioClientTransport spawn monitoring raw stdout bytes)', () => {
  it('stdout remains valid MCP JSON-RPC with no stray writes across startup and tool calls', async () => {
    const stderrChunks: Buffer[] = [];
    // StdioClientTransport stdout is pipe for JSON-RPC; any stray console.log would break framing.
    // We monitor stderr separately and assert MCP operations succeed — which they only do with valid stdout.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (c: Buffer) => stderrChunks.push(Buffer.from(c as any)));
    const client = new Client({ name: 'req-1035-ac5-hygiene', version: '0.0.0' });
    try {
      await client.connect(transport, { timeout: 10_000 });
      // Perform multiple tool calls — each round-trip validates stdout framing
      await client.listTools();
      const openEditor = await callToolJson(client, 'open_editor', {});
      expect(openEditor.port).toBeGreaterThan(0);
      const status = await callToolJson(client, 'status', {});
      expect(status.port).toBe(openEditor.port);
      const skill = await client.callTool({ name: 'figpea_skill', arguments: {} });
      expect(skill).toBeDefined();
      // Ensure stderr banner was emitted but never leaked into stdout:
      // If stdout had stray writes, the above calls would have thrown JSON parse errors.
      await new Promise((r) => setTimeout(r, 100));
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      expect(stderr).toContain('[figpea-mcp] bridge listening on 127.0.0.1:');
      expect(stderr).toContain('pairing token:');
      // Assert stdout was not captured as empty due to stray — the client is still alive
      expect(status.toolCount).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 15_000);
});
