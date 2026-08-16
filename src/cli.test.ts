import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * REQ-074 T1 — shipped-bin stdio smoke (plan §8 OQ-B).
 *
 * "Spawn the real figpea-mcp entry over stdio (StdioClientTransport) and
 * assert tools/list returns the static open_editor+status with no tab
 * connected — proves the npx figpea-mcp entrypoint + stdio transport for
 * real (built to dist/, ... builder's choice)."
 *
 * T3 has not written `cli.ts` yet, nor run `npm run build` inside the
 * package, so `packages/figpea-mcp/dist/cli.js` does not exist. Spawning
 * `node <that path>` fails immediately (Node prints "Cannot find module"
 * and exits nonzero) -- the SDK's StdioClientTransport/Client surfaces that
 * as a connect() rejection or a transport close before the MCP handshake
 * completes. Either way `client.connect()` below does not resolve
 * successfully, which is the intended RED: the shipped bin (dist/cli.js)
 * does not exist yet, not a bug in this test.
 *
 * Deliberately spawns the compiled dist/cli.js by absolute path (matching
 * package.json's own "bin": "dist/cli.js" + tsconfig's outDir "dist"/rootDir
 * "src") rather than relying on the npm-workspaces bin symlink
 * (node_modules/.bin/figpea-mcp) -- that symlink is only meaningfully
 * "real" once dist/cli.js exists to link to, and pinning the absolute path
 * keeps this test independent of the workspace-linking step's timing.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli.js');

describe('figpea-mcp bin — stdio smoke (plan §8 OQ-B)', () => {
  it('tools/list returns the static open_editor + status tools with no tab connected', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
    });
    const client = new Client({ name: 'req-074-cli-smoke', version: '0.0.0' });

    try {
      await client.connect(transport, { timeout: 10_000 });
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['open_editor', 'status']);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 15_000);

  it('honors FIGPEA_DISABLE_CONTRACT_FETCH=1 (AC-10)', async () => {
    // Spawns with FIGPEA_DISABLE_CONTRACT_FETCH=1, ensuring zero network calls and working cold start
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
    });
    const client = new Client({ name: 'req-699-disable-fetch-test', version: '0.0.0' });

    try {
      await client.connect(transport, { timeout: 10_000 });
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['open_editor', 'status']);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 15_000);

  it('targets the origin specified by FIGPEA_EDITOR_URL to fetch contract (AC-4)', async () => {
    let requestedPath = '';
    const server = http.createServer((req, res) => {
      requestedPath = req.url ?? '';
      if (req.url === '/agent/contract.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            surfaceVersion: '1.8.0',
            envVersion: 2,
            manifest: {
              custom_group: {
                custom_tool: { doc: 'Custom tool doc', params: {}, result: {} },
              },
            },
            errorCodes: {},
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: { ...process.env, FIGPEA_EDITOR_URL: origin, FIGPEA_DISABLE_CONTRACT_FETCH: '0' },
    });
    const client = new Client({ name: 'req-699-ac4-test', version: '0.0.0' });

    try {
      await client.connect(transport, { timeout: 10_000 });
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(requestedPath).toBe('/agent/contract.json');
      expect(names).toContain('custom_group_custom_tool');
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it('yields a working cold-start server when contract fetch fails / unreachable origin (AC-5)', async () => {
    // Port 1 on localhost is unreachable / connection refused
    const badOrigin = 'http://127.0.0.1:1';

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: { ...process.env, FIGPEA_EDITOR_URL: badOrigin, FIGPEA_DISABLE_CONTRACT_FETCH: '0' },
    });
    const client = new Client({ name: 'req-699-ac5-test', version: '0.0.0' });

    try {
      await client.connect(transport, { timeout: 10_000 });
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['open_editor', 'status']);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 15_000);

  it('fetches contract at most once per server run across lifecycle and operations (AC-6)', async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/agent/contract.json') {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            surfaceVersion: '1.8.0',
            envVersion: 2,
            manifest: {
              session: { status: { doc: 'Status', params: {}, result: {} } },
            },
            errorCodes: {},
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: { ...process.env, FIGPEA_EDITOR_URL: origin, FIGPEA_DISABLE_CONTRACT_FETCH: '0' },
    });
    const client = new Client({ name: 'req-699-ac6-test', version: '0.0.0' });

    try {
      await client.connect(transport, { timeout: 10_000 });
      await client.listTools();
      await client.callTool({ name: 'status', arguments: {} });
      await client.listTools();
      // Server fetches once at startup in main(), never on subsequent tool listings or calls
      expect(requestCount).toBe(1);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

