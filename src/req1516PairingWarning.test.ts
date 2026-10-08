import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer, type BridgeServerHandleLike } from './mcpServer';

/**
 * REQ-1516 T3 — red-first spec for the AC-4 pairing warning (one line on
 * `status()` when `FIGPEA_EDITOR_URL` is unset).
 *
 * WHY THIS EXISTS. An agent aiming at a local dev editor but running with
 * the default environment pairs against production without anything saying
 * so — the pairing URL embeds `https://editor.figpea.com` silently. The
 * warning must fire on the env being UNSET (an explicit production URL is a
 * choice, not an accident), and it must be additive: no existing `status` key
 * changes shape.
 *
 * Harness is the package's established unit tier: a REAL `McpServer` reached
 * through a REAL SDK `Client` over `InMemoryTransport`, with a stub bridge
 * (no tab paired — the warning is about the URL that WOULD be paired, so no
 * tab is needed to observe it).
 *
 * RED state (before T4): `status()` carries no `pairingWarning` key at all.
 */

const SAVED_EDITOR_URL = process.env.FIGPEA_EDITOR_URL;

afterEach(() => {
  if (SAVED_EDITOR_URL === undefined) delete process.env.FIGPEA_EDITOR_URL;
  else process.env.FIGPEA_EDITOR_URL = SAVED_EDITOR_URL;
});

function stubBridge(): BridgeServerHandleLike {
  return {
    port: 9,
    token: 'req-1516-test-token',
    isTabConnected: () => false,
    onDescribe: () => {},
    callTab: async () => {
      throw new Error('no tab paired');
    },
    close: async () => {},
  };
}

async function statusWithEnv(envValue: string | undefined): Promise<any> {
  if (envValue === undefined) delete process.env.FIGPEA_EDITOR_URL;
  else process.env.FIGPEA_EDITOR_URL = envValue;
  const server = createMcpServer(stubBridge());
  const client = new Client({ name: 'req-1516-pairing-warning', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: 'status', arguments: {} });
    const content = (result as any).content as Array<{ type: string; text?: string }>;
    const textBlock = content.find((c) => c.type === 'text');
    expect(textBlock, 'status returns a text content block').toBeDefined();
    return JSON.parse(textBlock!.text!);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

describe('REQ-1516 AC-4 — status warns before a pairing against production', () => {
  it('names the unset FIGPEA_EDITOR_URL and the production target in one line', async () => {
    const status = await statusWithEnv(undefined);
    expect(status.pairingWarning, 'the warning is present when the env is unset').toBeTypeOf('string');
    expect(status.pairingWarning).toContain('FIGPEA_EDITOR_URL');
    expect(status.pairingWarning).toContain('https://editor.figpea.com');
    expect(status.pairingWarning, 'one line, not a paragraph').not.toContain('\n');
    expect(status.url).toContain('https://editor.figpea.com');
  });

  it('is null when FIGPEA_EDITOR_URL names a local dev editor', async () => {
    const status = await statusWithEnv('http://localhost:8080');
    expect(status.pairingWarning, 'an explicit dev-editor URL is a choice, not an accident').toBeNull();
    expect(status.url).toContain('http://localhost:8080');
  });

  it('is null when FIGPEA_EDITOR_URL explicitly names production', async () => {
    const status = await statusWithEnv('https://editor.figpea.com');
    expect(status.pairingWarning, 'an explicit production URL is a choice, not an accident').toBeNull();
  });

  it('is additive — no other status key changes shape', async () => {
    const status = await statusWithEnv(undefined);
    expect(Object.keys(status).sort()).toEqual(
      [
        'activeConnectionId',
        'bridgeSlots',
        'build',
        'buildStale',
        'connection',
        'connections',
        'contractVersion',
        'document',
        'liveness',
        'pairingWarning',
        'port',
        'tab',
        'tabConnected',
        'token',
        'toolCount',
        'url',
      ].sort(),
    );
  });
});
