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
import { BRIDGE_URL_HOST } from './bridgeHost';
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

/**
 * REQ-1032 AC-5 — resolves the bridge bind port: `--port=` CLI flag first,
 * then the `FIGPEA_MCP_PORT` env sibling to `FIGPEA_EDITOR_URL`, then
 * undefined (which preserves bridgeServer's ephemeral `port ?? 0` default).
 * Invalid env values (non-numeric or outside 1-65535) are ignored with a
 * stderr warning, mirroring resolveToolMode's invalid-FIGPEA_TOOL_MODE
 * handling. Exported for unit tests (same pattern as resolveToolMode).
 */
export function resolveBridgePort(argv: string[], env: NodeJS.ProcessEnv = process.env): number | undefined {
  const cliPort = parsePortArg(argv);
  if (cliPort !== undefined) return cliPort;
  const raw = typeof env.FIGPEA_MCP_PORT === 'string' ? env.FIGPEA_MCP_PORT.trim() : undefined;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[figpea-mcp] ignoring invalid FIGPEA_MCP_PORT="${env.FIGPEA_MCP_PORT}" — expected a port 1-65535`);
    return undefined;
  }
  return n;
}

/** REQ-1018 — parses `--mode=compact|full` (last flag wins, case-insensitive, invalid ignored). */
export function parseModeArg(argv: string[]): string | undefined {
  let found: string | undefined;
  for (const arg of argv) {
    const match = /^--mode=(.+)$/.exec(arg);
    if (match) {
      const raw = match[1].trim().toLowerCase();
      if (raw === 'compact' || raw === 'full') {
        found = raw;
      } else {
        console.error(`[figpea-mcp] ignoring invalid --mode value "${match[1]}" — expected compact or full`);
      }
    }
  }
  return found;
}

/** REQ-1018 — resolves effective tool mode: CLI flag > FIGPEA_TOOL_MODE env > default compact. */
export function resolveToolMode(argv: string[], env: NodeJS.ProcessEnv = process.env): 'compact' | 'full' {
  const cliMode = parseModeArg(argv);
  if (cliMode === 'compact' || cliMode === 'full') return cliMode;
  const envRaw = typeof env.FIGPEA_TOOL_MODE === 'string' ? env.FIGPEA_TOOL_MODE.trim().toLowerCase() : undefined;
  if (envRaw === 'compact' || envRaw === 'full') return envRaw as 'compact' | 'full';
  if (envRaw !== undefined && envRaw !== '') {
    console.error(`[figpea-mcp] ignoring invalid FIGPEA_TOOL_MODE="${env.FIGPEA_TOOL_MODE}" — expected compact or full`);
  }
  return 'compact';
}

/** REQ-1492 — parses `--bridge-slots=single|multi` (last flag wins, case-insensitive, invalid ignored). */
export function parseBridgeSlotsArg(argv: string[]): string | undefined {
  let found: string | undefined;
  for (const arg of argv) {
    const match = /^--bridge-slots=(.+)$/.exec(arg);
    if (match) {
      const raw = match[1].trim().toLowerCase();
      if (raw === 'single' || raw === 'multi') {
        found = raw;
      } else {
        console.error(`[figpea-mcp] ignoring invalid --bridge-slots value "${match[1]}" — expected single or multi`);
      }
    }
  }
  return found;
}

/**
 * REQ-1492 — resolves how many editor tabs this bridge serves: CLI flag >
 * `FIGPEA_BRIDGE_SLOTS` env > `single`.
 *
 * Exactly `resolveToolMode`'s shape and precedence, on purpose: a second knob
 * with its own rules is a second thing to get wrong, and a user who mistypes it
 * must get the same never-crash-the-stdio-channel treatment. The default is
 * `single` — AC-7 names the current default as the default — so the flow every
 * existing consumer has is the one that keeps working, now safe instead of
 * silently evicting. Exported for unit tests (same pattern as the resolvers above).
 */
export function resolveBridgeSlots(argv: string[], env: NodeJS.ProcessEnv = process.env): 'single' | 'multi' {
  const cliMode = parseBridgeSlotsArg(argv);
  if (cliMode === 'single' || cliMode === 'multi') return cliMode;
  const envRaw = typeof env.FIGPEA_BRIDGE_SLOTS === 'string' ? env.FIGPEA_BRIDGE_SLOTS.trim().toLowerCase() : undefined;
  if (envRaw === 'single' || envRaw === 'multi') return envRaw as 'single' | 'multi';
  if (envRaw !== undefined && envRaw !== '') {
    console.error(
      `[figpea-mcp] ignoring invalid FIGPEA_BRIDGE_SLOTS="${env.FIGPEA_BRIDGE_SLOTS}" — expected single or multi`,
    );
  }
  return 'single';
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
  const argv = process.argv.slice(2);
  const port = resolveBridgePort(argv);
  const toolMode = resolveToolMode(argv);
  const slots = resolveBridgeSlots(argv);
  const bridge = await startBridgeServer({ ...(port !== undefined ? { port } : {}), slots });

  // REQ-1301: this line is not decoration — it is the anchor of the documented
  // two-line paste (README "Mid-session pairing"), which the editor's
  // `parsePairingFromPaste` parses (v3/src/agent/bridge/parsePairing.ts, step
  // C). The host is `BRIDGE_URL_HOST`, the same spelling the bridge's emitted
  // URLs use, so the host a user reads is the host their tab is served from.
  // The parser accepts both this and the older `127.0.0.1` form.
  console.error(`[figpea-mcp] bridge listening on ${BRIDGE_URL_HOST}:${bridge.port}`);
  console.error(`[figpea-mcp] pairing token: ${bridge.token}`);
  console.error('[figpea-mcp] open this URL in a browser to connect an editor tab:');
  console.error(`[figpea-mcp]   ${defaultConnectUrl(bridge.port, bridge.token)}`);
  console.error('[figpea-mcp] (or call the open_editor tool from the connected MCP client)');
  // REQ-1492: printed because it is the one thing that changes a refusal into
  // an action — a second tab refused by name cannot discover the knob from the
  // refusal itself unless the refusal says it (it does, in `nextStep`), but the
  // startup banner is where a user looks before opening a second tab.
  if (slots === 'multi') {
    console.error('[figpea-mcp] bridge slots: multi (several tabs may pair; use select_tab to choose which one calls reach)');
  }

  let prefetchedManifest: any | undefined;
  let prefetchedSkillBody: string | undefined;
  let prefetchedSkillUrl: string | undefined;
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
      // This origin is a FACT about the body, not a derived convenience: a run
      // may pair a tab from a different origin/build than the one fetched
      // here, and `figpea_skill` says so rather than answering unattributed
      // (the 2026-10-01 design run read the production skill while every
      // contract call went to a local tab). Reported by `fetchSkill` itself so
      // it cannot drift from where the request actually went.
      prefetchedSkillUrl = skillRes.url;
    }
  }

  const serverOptions: Record<string, unknown> = {};
  if (prefetchedManifest) (serverOptions as any).prefetchedManifest = prefetchedManifest;
  if (prefetchedSkillBody) {
    (serverOptions as any).prefetchedSkillBody = prefetchedSkillBody;
    (serverOptions as any).prefetchedSkillUrl = prefetchedSkillUrl;
  }
  (serverOptions as any).toolMode = toolMode;
  const server = createMcpServer(bridge, Object.keys(serverOptions).length > 0 ? (serverOptions as any) : { toolMode } as any);
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
