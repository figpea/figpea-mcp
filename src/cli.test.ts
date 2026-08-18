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
      // REQ-705: figpea_skill joins the always-present set.
      expect(names).toEqual(['figpea_skill', 'open_editor', 'status']);
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
      // REQ-705: figpea_skill is still present (registered unconditionally),
      // even though its own body fetch is gated by the SAME env var and
      // therefore also disabled here -- it just degrades (skill_unavailable)
      // rather than being absent from tools/list.
      expect(names).toEqual(['figpea_skill', 'open_editor', 'status']);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 15_000);

  it('targets the origin specified by FIGPEA_EDITOR_URL to fetch contract AND skill (AC-4)', async () => {
    // REQ-705: cli.ts now fetches BOTH /agent/contract.json and
    // /agent/skill.md from the same origin at startup -- track every
    // requested path (not a single reassigned variable) so both fetches are
    // independently observable, and serve a real skill.md body so the
    // figpea_skill tool call below (T5/T6's own new assertions) has real
    // content to return.
    const requestedPaths: string[] = [];
    const skillBody = '# Figpea Agent Skill (fixture)\n\nFixture reference body.\n';
    const server = http.createServer((req, res) => {
      requestedPaths.push(req.url ?? '');
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
      } else if (req.url === '/agent/skill.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(skillBody);
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
      expect(requestedPaths).toContain('/agent/contract.json');
      expect(requestedPaths, 'REQ-705: the skill.md fetch also targets FIGPEA_EDITOR_URL\'s origin').toContain(
        '/agent/skill.md',
      );
      expect(names).toContain('custom_group_custom_tool');

      // REQ-705: figpea_skill returns the fetched fixture body verbatim.
      const skillResult = await client.callTool({ name: 'figpea_skill', arguments: {} });
      const content = (skillResult as any).content as Array<{ type: string; text?: string }>;
      const textBlock = content.find((c) => c.type === 'text');
      expect(textBlock?.text).toBe(skillBody);
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
      // REQ-705: figpea_skill is still registered (always-present) even
      // though its own prefetch also failed against the same unreachable
      // origin -- it just degrades when called, never absent from the list.
      expect(names).toEqual(['figpea_skill', 'open_editor', 'status']);

      const skillResult = await client.callTool({ name: 'figpea_skill', arguments: {} });
      expect(skillResult).toBeDefined();
      const content = (skillResult as any).content as Array<{ type: string; text?: string }>;
      const textBlock = content.find((c) => c.type === 'text');
      expect(textBlock, 'figpea_skill still returns a text content block, degraded but non-throwing').toBeDefined();
      const parsed = JSON.parse(textBlock!.text!);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('skill_unavailable');
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }, 15_000);

  it('fetches contract AND skill at most once each per server run across lifecycle and operations (AC-6)', async () => {
    let contractRequestCount = 0;
    let skillRequestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/agent/contract.json') {
        contractRequestCount++;
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
      } else if (req.url === '/agent/skill.md') {
        skillRequestCount++;
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end('# skill body\n');
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
      await client.callTool({ name: 'figpea_skill', arguments: {} });
      await client.listTools();
      // Both fetches happen once at startup in main(), never on subsequent
      // tool listings or calls.
      expect(contractRequestCount).toBe(1);
      expect(skillRequestCount, 'REQ-705: the skill.md fetch is also a one-shot startup fetch').toBe(1);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

