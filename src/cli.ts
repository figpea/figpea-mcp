#!/usr/bin/env node
/**
 * REQ-074 T3 — the `figpea-mcp` bin (plan §2, §8 OQ-B). Starts the bridge,
 * connects the `McpServer` over stdio, and prints connect guidance to
 * stderr.
 *
 * stdout hygiene (plan "Risks & notes"): the MCP stdio transport owns
 * stdout for the JSON-RPC channel end-to-end. Every diagnostic line in this
 * file (and everywhere else in this package) must go to stderr via
 * `console.error` -- a stray stdout write would corrupt the framing the
 * connected MCP client is parsing.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startBridgeServer } from './bridgeServer';
import { createMcpServer } from './mcpServer';
import { fetchContract } from './contractFetch';
import { fetchSkill } from './skillFetch';

/** Minimal argv parsing (plan §2): only a fixed bridge port is worth
 * exposing on the command line -- everything else (editor base URL) is
 * already covered by the `FIGPEA_EDITOR_URL` env var / `open_editor`'s
 * per-call argument. */
function parsePortArg(argv: string[]): number | undefined {
  for (const arg of argv) {
    const match = /^--port=(\d+)$/.exec(arg);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function defaultConnectUrl(port: number, token: string): string {
  const base = process.env.FIGPEA_EDITOR_URL ?? 'https://editor.figpea.com';
  const url = new URL(base);
  url.searchParams.set('agent', '1');
  url.searchParams.set('bridgePort', String(port));
  url.searchParams.set('bridgeToken', token);
  return url.toString();
}

async function main(): Promise<void> {
  const port = parsePortArg(process.argv.slice(2));
  const bridge = await startBridgeServer(port !== undefined ? { port } : undefined);

  console.error(`[figpea-mcp] bridge listening on 127.0.0.1:${bridge.port}`);
  console.error(`[figpea-mcp] pairing token: ${bridge.token}`);
  console.error('[figpea-mcp] open this URL in a browser to connect an editor tab:');
  console.error(`[figpea-mcp]   ${defaultConnectUrl(bridge.port, bridge.token)}`);
  console.error('[figpea-mcp] (or call the open_editor tool from the connected MCP client)');

  let prefetchedManifest: any | undefined;
  let prefetchedSkillBody: string | undefined;
  const disableFetch = process.env.FIGPEA_DISABLE_CONTRACT_FETCH === '1' || process.env.FIGPEA_DISABLE_CONTRACT_FETCH === 'true';
  if (!disableFetch) {
    const editorBase = process.env.FIGPEA_EDITOR_URL ?? 'https://editor.figpea.com';
    // REQ-705: the skill fetch reuses REQ-699's startup fetch ladder --
    // same gating env var, same editor-origin resolution -- rather than
    // inventing a parallel mechanism/flag.
    const [contractRes, skillRes] = await Promise.all([fetchContract(editorBase), fetchSkill(editorBase)]);
    if (contractRes.status === 'ok') {
      prefetchedManifest = contractRes.manifest;
    }
    if (skillRes.status === 'ok') {
      prefetchedSkillBody = skillRes.body;
    }
  }

  const serverOptions =
    prefetchedManifest || prefetchedSkillBody
      ? { prefetchedManifest, prefetchedSkillBody }
      : undefined;
  const server = createMcpServer(bridge, serverOptions);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close().catch(() => {});
    await bridge.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[figpea-mcp] fatal error:', err);
  process.exit(1);
});
