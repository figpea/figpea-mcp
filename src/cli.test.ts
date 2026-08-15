import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
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
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI_ENTRY] });
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
});
