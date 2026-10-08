import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { requireBuiltCli } from './testSupport/requireBuiltCli.test-helper';

/**
 * REQ-1516 T1 — red-first spec for the supported non-stdio entry point
 * (`figpea-mcp --http`), covering AC-1, AC-2, AC-3 and AC-6.
 *
 * ## Why this file exists
 *
 * AC-1 is the repro of a failure mode, not a behaviour to preserve: in a
 * session where the registered stdio MCP server fails to start (`opencode mcp
 * list` reports `figpea failed: Connection closed`), the `figpea_*` tools are
 * simply absent from the tool catalog and the run cannot make a single
 * contract call — a stdio MCP process spawned at session start cannot be
 * respawned by an agent. The testable contract is that the situation now has a
 * documented, supported answer (AC-2): one command from the package's own
 * README starts a transport the agent can call, serving the SAME registered
 * tools with the SAME envelope (AC-3), without needing a local editor checkout
 * (AC-6).
 *
 * Harness is the package's top tier for a second entry point: the REAL built
 * `dist/cli.js` spawned as a child process, driven over REAL loopback HTTP
 * with the REAL SDK `StreamableHTTPClientTransport` — the same client class a
 * host MCP client uses — plus a REAL stdio client for the parity row. There is
 * no browser surface in this package, so Playwright would be theater.
 *
 * RED state (before T2): `dist/cli.js` accepts no `--http` flag, so the child
 * prints the stdio banner and never an MCP HTTP endpoint — every row below
 * fails at the "wait for the endpoint" step with a connection-refused / banner
 * timeout, not a setup error.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli.js');

// Spawning a node child plus two MCP handshakes is slower than an in-memory
// pair; the default 5 s budget reports nothing more precise than a bare
// timeout when the endpoint banner is late.
vi.setConfig({ testTimeout: 60_000 });

const children: ChildProcess[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
  }
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface HttpServer {
  child: ChildProcess;
  /** The loopback MCP endpoint, exactly as the stderr banner printed it. */
  endpoint: string;
  /** The per-run pairing token, exactly as the stderr banner printed it. */
  token: string;
  /** Every stdout byte the child produced — the stdio channel stays clean. */
  stdoutBytes: Buffer[];
}

/** Waits until `lines` holds a line matching `re`, or throws naming the wait. */
async function waitForLine(
  lines: string[],
  re: RegExp,
  label: string,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = lines.find((l) => re.test(l));
    if (found) return found;
    if (Date.now() >= deadline) {
      throw new Error(
        `${label} — never observed (stderr so far:\n${lines.join('\n') || '<empty>'})`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Spawns the REAL built bin in `--http` mode and returns once its stderr
 * banner names the loopback MCP endpoint. Fails RED while `--http` does not
 * exist: the child starts the stdio server instead and never prints one.
 */
async function spawnHttpServer(
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
  cwd?: string,
): Promise<HttpServer> {
  requireBuiltCli(CLI_ENTRY);
  const child = spawn(process.execPath, [CLI_ENTRY, '--http', ...args], {
    env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
  });
  children.push(child);
  const stderrLines: string[] = [];
  let stderrBuf = '';
  const stdoutBytes: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    const parts = stderrBuf.split('\n');
    stderrBuf = parts.pop() ?? '';
    stderrLines.push(...parts);
  });
  child.stdout!.on('data', (chunk: Buffer) => stdoutBytes.push(chunk));

  const endpointLine = await waitForLine(
    stderrLines,
    /http:\/\/127\.0\.0\.1:\d+\/mcp/,
    'the --http stderr banner naming the loopback MCP endpoint',
  );
  const tokenLine = await waitForLine(
    stderrLines,
    /pairing token:\s*\S+/,
    'the --http stderr banner naming the pairing token',
  );
  const endpoint = endpointLine.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)![0];
  const token = tokenLine.match(/pairing token:\s*(\S+)/)![1];
  return { child, endpoint, token, stdoutBytes };
}

async function httpClient(endpoint: string, token: string): Promise<Client> {
  const client = new Client({ name: 'req-1516-http-fallback', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { 'x-figpea-token': token } },
  });
  await client.connect(transport);
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, `${name} returns a text content block`).toBeDefined();
  return JSON.parse(textBlock!.text!);
}

function toolNames(tools: Array<{ name: string }>): string[] {
  return tools.map((t) => t.name).sort();
}

describe('REQ-1516 AC-1 — the failure mode this entry point answers', () => {
  it('without a listener, an MCP HTTP client makes zero contract calls', async () => {
    // Characterization of the AC-1 repro, not gated behaviour: nothing
    // listens on this port, so even the handshake fails — the run cannot make
    // a single contract call. Passes before and after T2; it records WHY the
    // entry point below has to exist.
    const client = new Client({ name: 'req-1516-absent-server', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:1/mcp'));
    await expect(client.connect(transport)).rejects.toBeTruthy();
    await client.close().catch(() => {});
  });
});

describe('REQ-1516 AC-2/AC-3 — --http serves the real MCP surface over loopback HTTP', () => {
  it('serves MCP initialize + tools/list and answers tools/call status with no tab paired', async () => {
    const server = await spawnHttpServer();
    const client = await httpClient(server.endpoint, server.token);
    try {
      const { tools } = await client.listTools();
      expect(toolNames(tools)).toEqual(['figpea_call', 'figpea_describe', 'figpea_skill', 'open_editor', 'status']);

      const status = await callToolJson(client, 'status');
      expect(status.tabConnected).toBe(false);
      expect(typeof status.port).toBe('number');
      expect(typeof status.token).toBe('string');
      expect(typeof status.url).toBe('string');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('keeps stdout clean — the stdio channel stays unowned by diagnostics', async () => {
    const server = await spawnHttpServer();
    const client = await httpClient(server.endpoint, server.token);
    try {
      await client.listTools();
      await new Promise((r) => setTimeout(r, 300));
      const produced = Buffer.concat(server.stdoutBytes).length;
      expect(produced, 'stdout carries no diagnostic bytes in --http mode').toBe(0);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('--port names the HTTP listener port', async () => {
    const freePort = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });

    const server = await spawnHttpServer([`--port=${freePort}`]);
    const client = await httpClient(server.endpoint, server.token);
    try {
      expect(server.endpoint).toBe(`http://127.0.0.1:${freePort}/mcp`);
      const { tools } = await client.listTools();
      expect(toolNames(tools)).toContain('status');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('issues real MCP tools/call against the SAME tools with the SAME envelope as the stdio server', async () => {
    // AC-3, driven the way a consumer drives it: one tools/list plus one
    // tools/call envelope through each entry point, compared verbatim. The
    // call is figpea_describe with no tab paired — deterministic with no
    // editor involved, and it answers the package's own {ok,code,message}
    // envelope rather than a bare payload.
    requireBuiltCli(CLI_ENTRY);
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
    });
    const stdioClient = new Client({ name: 'req-1516-stdio-parity', version: '0.0.0' });
    const server = await spawnHttpServer();
    const http = await httpClient(server.endpoint, server.token);
    try {
      await stdioClient.connect(stdioTransport);
      const stdioList = await stdioClient.listTools();
      const httpList = await http.listTools();
      expect(toolNames(httpList.tools), 'the HTTP entry serves the same tool set as stdio').toEqual(
        toolNames(stdioList.tools),
      );

      const viaStdio = await callToolJson(stdioClient, 'figpea_describe', {});
      const viaHttp = await callToolJson(http, 'figpea_describe', {});
      expect(viaHttp, 'the same call answers the same envelope through both entry points').toEqual(viaStdio);
      expect(viaHttp.ok, 'the compared call is the envelope form').toBe(false);
      expect(typeof viaHttp.code).toBe('string');
      expect(typeof viaHttp.message).toBe('string');
    } finally {
      await stdioClient.close().catch(() => {});
      await stdioTransport.close().catch(() => {});
      await http.close().catch(() => {});
    }
  });

  it('refuses the MCP route without the pairing token', async () => {
    const server = await spawnHttpServer();
    const res = await fetch(server.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status, 'POST /mcp without x-figpea-token is refused').toBe(401);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(typeof body.code).toBe('string');
    expect(typeof body.message).toBe('string');
  });
});

describe('REQ-1516 AC-6 — --http starts with no sibling v3/ checkout', () => {
  function bareCwd(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-1516-ac6-'));
    scratchDirs.push(dir);
    expect(fs.existsSync(path.join(dir, 'v3')), 'the scratch cwd has no v3 sibling').toBe(false);
    return dir;
  }

  it('boots with the contract fetch disabled and still serves tools/list + status', async () => {
    const server = await spawnHttpServer([], { FIGPEA_DISABLE_CONTRACT_FETCH: '1' }, bareCwd());
    const client = await httpClient(server.endpoint, server.token);
    try {
      const { tools } = await client.listTools();
      expect(toolNames(tools)).toContain('status');
      const status = await callToolJson(client, 'status');
      expect(status.tabConnected).toBe(false);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('boots with an unreachable FIGPEA_EDITOR_URL and still serves tools/list + status', async () => {
    const server = await spawnHttpServer(
      [],
      { FIGPEA_DISABLE_CONTRACT_FETCH: '0', FIGPEA_EDITOR_URL: 'http://127.0.0.1:1' },
      bareCwd(),
    );
    const client = await httpClient(server.endpoint, server.token);
    try {
      const { tools } = await client.listTools();
      expect(toolNames(tools)).toContain('status');
      const status = await callToolJson(client, 'status');
      expect(status.tabConnected).toBe(false);
    } finally {
      await client.close().catch(() => {});
    }
  });
});
