import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';

/**
 * REQ-1018 — figpea-mcp compact mode default with figpea_call dispatcher
 * Failing-first tests for AC-1..AC-4. Written against the AC text, not the
 * implementation. Must be RED on the unfixed tree (no compact mode, no
 * figpea_call) and GREEN after T2+T3.
 *
 * Harness mirrors mcpServer.test.ts: real McpServer + real Client over
 * InMemoryTransport, stub bridge (no real WebSocket).
 */

interface BridgeStub {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
  getContractVersion?(): string | null;
  getFileUrl?(filePath: string): string;
}

function fakeBridge(overrides?: Partial<BridgeStub>): BridgeStub {
  return {
    port: 54321,
    token: 'test-token-abc',
    isTabConnected: () => false,
    onDescribe: () => {},
    callTab: async () => ({ ok: true, value: null }),
    close: async () => {},
    ...overrides,
  };
}

let cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanupFns) await fn();
  cleanupFns = [];
});

async function connectedClient(bridge: BridgeStub, options?: any) {
  const server = createMcpServer(bridge as any, options);
  const client = new Client({ name: 'req-1018-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanupFns.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, `${name} returns a text block`).toBeDefined();
  return JSON.parse(textBlock!.text!);
}

const FIXTURE_MANIFEST = {
  session: {
    status: { doc: 'Status', params: {}, result: {} },
    layerTree: { doc: 'Layer tree', params: {}, result: {} },
  },
  layer: {
    create: { doc: 'Create layer', params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } }, result: {} },
    setPosition: { doc: 'Set position', params: { id: { type: 'string', required: true }, pos: { type: 'object', required: true } }, result: {} },
  },
  canvas: {
    screenshot: { doc: 'Screenshot', params: { id: { type: 'string', required: false } }, result: {} },
  },
  export: {
    project: { doc: 'Export project', params: {}, result: {} },
  },
};

describe('REQ-1018 AC-1 — compact mode default: tools/list returns only open_editor, status, figpea_skill, figpea_call', () => {
  it('with toolMode compact and no manifest, listTools is exactly the 4 compact tools', async () => {
    const client = await connectedClient(fakeBridge(), { toolMode: 'compact' } as any);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['figpea_call', 'figpea_skill', 'open_editor', 'status']);
  });

  it('with prefetchedManifest but still compact (default compact), contract tools are NOT registered', async () => {
    const client = await connectedClient(fakeBridge(), { prefetchedManifest: FIXTURE_MANIFEST as any, toolMode: 'compact' } as any);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['figpea_call', 'figpea_skill', 'open_editor', 'status']);
    expect(names).not.toContain('layer_create');
    expect(names).not.toContain('session_status');
  });

  it('status.toolCount reflects compact surface (0 contract tools) even with prefetched manifest', async () => {
    const client = await connectedClient(fakeBridge({ isTabConnected: () => false }), { prefetchedManifest: FIXTURE_MANIFEST as any, toolMode: 'compact' } as any);
    const payload = await callToolJson(client, 'status', {});
    expect(payload.toolCount).toBe(0);
  });

  it('CLI default without --mode and without FIGPEA_TOOL_MODE is compact (via resolveToolMode)', async () => {
    const { resolveToolMode } = await import('./cli');
    expect(resolveToolMode([], {})).toBe('compact');
    expect(resolveToolMode(['--mode=full'], {})).toBe('full');
    expect(resolveToolMode([], { FIGPEA_TOOL_MODE: 'full' } as any)).toBe('full');
    expect(resolveToolMode(['--mode=compact'], { FIGPEA_TOOL_MODE: 'full' } as any)).toBe('compact');
  });
});

describe('REQ-1018 AC-4 — --mode=full / FIGPEA_TOOL_MODE=full restores full surface', () => {
  it('toolMode full with prefetchedManifest registers all contract tools plus static 3 (no figpea_call)', async () => {
    const client = await connectedClient(fakeBridge({ isTabConnected: () => false }), {
      prefetchedManifest: FIXTURE_MANIFEST as any,
      toolMode: 'full',
    } as any);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('open_editor');
    expect(names).toContain('status');
    expect(names).toContain('figpea_skill');
    expect(names).toContain('layer_create');
    expect(names).toContain('session_status');
    expect(names).toContain('canvas_screenshot');
    expect(names).not.toContain('figpea_call');
    // N contract tools (6 in fixture) + 3 static = 9
    expect(names.length).toBe(9);
    const payload = await callToolJson(client, 'status', {});
    expect(payload.toolCount).toBe(6);
  });

  it('live describe in full mode also registers contract tools (onDescribe)', async () => {
    let handler: ((m: unknown) => void) | undefined;
    const bridge = fakeBridge({
      isTabConnected: () => false,
      onDescribe: (h) => { handler = h; },
    });
    const client = await connectedClient(bridge, { toolMode: 'full' } as any);
    let { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('layer_create');
    handler!(FIXTURE_MANIFEST);
    ({ tools } = await client.listTools());
    expect(tools.map((t) => t.name)).toContain('layer_create');
  });
});

describe('REQ-1018 AC-2 — figpea_call dispatcher forwards to bridge.callTab and returns structured result', () => {
  it('forwards group/method/args to bridge.callTab and returns the structured result', async () => {
    const captured: Array<{ group: string; method: string; args: unknown[] }> = [];
    const bridge = fakeBridge({
      isTabConnected: () => true,
      callTab: async (group, method, args) => {
        captured.push({ group, method, args });
        return { ok: true, value: { id: 'new-layer-id' } };
      },
    });
    const client = await connectedClient(bridge, { toolMode: 'compact' } as any);
    // ensure figpea_call exists
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('figpea_call');

    const payload = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['rect', { rwidth: 100, rheight: 50 }],
    });
    expect(captured.length).toBe(1);
    expect(captured[0]).toEqual({ group: 'layer', method: 'create', args: ['rect', { rwidth: 100, rheight: 50 }] });
    expect(payload).toEqual({ ok: true, value: { id: 'new-layer-id' } });
  });

  it('args defaults to [] when omitted', async () => {
    const captured: Array<unknown[]> = [];
    const bridge = fakeBridge({
      isTabConnected: () => true,
      callTab: async (_g, _m, args) => {
        captured.push(args);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge, { toolMode: 'compact' } as any);
    await callToolJson(client, 'figpea_call', { group: 'session', method: 'layerTree' });
    expect(captured[0]).toEqual([]);
  });

  it('returns no_tab error when no tab is paired', async () => {
    const bridge = fakeBridge({ isTabConnected: () => false, port: 12345, token: 'tok-123' });
    const client = await connectedClient(bridge, { toolMode: 'compact' } as any);
    const result = await client.callTool({ name: 'figpea_call', arguments: { group: 'layer', method: 'create', args: [] } });
    const content = (result as any).content as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === 'text')!.text!;
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('no_tab');
    expect(parsed.url).toContain('bridgePort=12345');
  });
});

describe('REQ-1018 AC-3 — figpea_call image response includes MCP image content block and text summary', () => {
  it('image-shaped success value returns both image and text content blocks', async () => {
    const bridge = fakeBridge({
      isTabConnected: () => true,
      callTab: async () => ({ ok: true, value: { bytes: 'QUJDRA==', mime: 'image/png', width: 12, height: 8 } }),
    });
    const client = await connectedClient(bridge, { toolMode: 'compact' } as any);
    const result = await client.callTool({ name: 'figpea_call', arguments: { group: 'canvas', method: 'screenshot', args: [] } });
    const content = (result as any).content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    const imageBlock = content.find((c) => c.type === 'image');
    const textBlock = content.find((c) => c.type === 'text');
    expect(imageBlock, 'image content block present').toBeDefined();
    expect(imageBlock!.data).toBe('QUJDRA==');
    expect(imageBlock!.mimeType).toBe('image/png');
    expect(textBlock, 'text summary accompanies image').toBeDefined();
    expect(result.isError).not.toBe(true);
  });
});

describe('REQ-1018 AC-2/AC-3 — figpea_call timeout handling (clamp + table)', () => {
  it('_timeoutMs override is forwarded to bridge.callTab and clamped to 120000', async () => {
    const captured: Array<number | undefined> = [];
    const bridge = fakeBridge({
      isTabConnected: () => true,
      callTab: async (_g, _m, _args, timeoutMs) => {
        captured.push(timeoutMs);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge, { toolMode: 'compact' } as any);
    await callToolJson(client, 'figpea_call', { group: 'layer', method: 'setPosition', args: ['x', { x: 0, y: 0 }], _timeoutMs: 45_000 });
    expect(captured[0]).toBe(45_000);
    await callToolJson(client, 'figpea_call', { group: 'layer', method: 'setPosition', args: [], _timeoutMs: 999_999_999 });
    expect(captured[1]).toBe(120_000);
  });

  it('known-slow method without override uses DEFAULT_TIMEOUT_TABLE_MS (e.g. session_openFile → 120000)', async () => {
    const captured: Array<number | undefined> = [];
    const bridge = fakeBridge({
      isTabConnected: () => true,
      callTab: async (_g, _m, _args, timeoutMs) => {
        captured.push(timeoutMs);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge, { toolMode: 'compact' } as any);
    await callToolJson(client, 'figpea_call', { group: 'session', method: 'openFile', args: [{ url: 'https://example.com/a.fig' }] });
    expect(captured[0]).toBe(120_000);
  });
});
