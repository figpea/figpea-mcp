import { describe, it, expect } from 'vitest';

/**
 * REQ-1032 AC-5 — figpea-mcp bridge accepts a FIGPEA_MCP_PORT env override
 * as the sibling to FIGPEA_EDITOR_URL, not just --port=.
 *
 * Written against the AC text, not the implementation. Must be RED on the
 * unfixed tree (cli.ts exposes only parsePortArg/--port=, no env sibling)
 * and GREEN after T6.
 *
 * Contract under test (plan tech design T6):
 *   resolveBridgePort(argv, env): number | undefined
 *   precedence: --port= > FIGPEA_MCP_PORT > undefined
 *   (undefined preserves bridgeServer.ts's ephemeral `port ?? 0` default;
 *   invalid env values are ignored with a stderr warning, mirroring
 *   resolveToolMode's invalid-FIGPEA_TOOL_MODE handling.)
 */

async function loadResolveBridgePort(): Promise<unknown> {
  const cli = (await import('./cli')) as Record<string, unknown>;
  return cli.resolveBridgePort;
}

describe('REQ-1032 AC-5 — FIGPEA_MCP_PORT env sibling to FIGPEA_EDITOR_URL', () => {
  it('resolveBridgePort is exported from cli.ts', async () => {
    const fn = await loadResolveBridgePort();
    expect(typeof fn, 'expected cli.ts to export resolveBridgePort (the FIGPEA_MCP_PORT sibling to --port=)').toBe(
      'function',
    );
  });

  it('CLI --port= wins over the env var', async () => {
    const fn = (await loadResolveBridgePort()) as (argv: string[], env?: NodeJS.ProcessEnv) => number | undefined;
    expect(fn(['--port=4321'], { FIGPEA_MCP_PORT: '8765' } as NodeJS.ProcessEnv)).toBe(4321);
  });

  it('env var applies when no --port= flag is given', async () => {
    const fn = (await loadResolveBridgePort()) as (argv: string[], env?: NodeJS.ProcessEnv) => number | undefined;
    expect(fn([], { FIGPEA_MCP_PORT: '8765' } as NodeJS.ProcessEnv)).toBe(8765);
  });

  it('absent flag and absent env resolve to undefined (ephemeral default preserved)', async () => {
    const fn = (await loadResolveBridgePort()) as (argv: string[], env?: NodeJS.ProcessEnv) => number | undefined;
    expect(fn([], {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('invalid env values are ignored, not bound', async () => {
    const fn = (await loadResolveBridgePort()) as (argv: string[], env?: NodeJS.ProcessEnv) => number | undefined;
    expect(fn([], { FIGPEA_MCP_PORT: 'not-a-port' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(fn([], { FIGPEA_MCP_PORT: '99999' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
