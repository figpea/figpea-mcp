import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * REQ-074 T1 — static tools `open_editor` + `status` (plan §2, OQ-4).
 *
 * `mcpServer.ts` does not exist yet (T3 builds it) — every test below fails
 * at this file's own import statement ("Cannot find module './mcpServer'"),
 * never inside an assertion. This is the intended RED.
 *
 * Drives the real `McpServer` through a real `Client` over
 * `InMemoryTransport.createLinkedPair()` (SDK, already a runtime dep) --
 * mirrors the plan's OQ-B choice for the AC e2e harness, at package-unit
 * scale (no browser, no real bridge WebSocket listener).
 *
 * ASSUMPTIONS (the plan pins the *tool contract* -- {port,token,url} /
 * {port,tabConnected,contractVersion,toolCount} -- not exact export names):
 *   - `createMcpServer(bridge: BridgeServerHandle, options？: { editorBaseUrl?: string }): McpServer`
 *     -- takes an already-started bridge handle (bridgeServer.ts's assumed
 *     shape, see bridgeServer.test.ts) as a dependency, rather than starting
 *     its own bridge internally. This keeps mcpServer.ts unit-testable with
 *     a plain stub bridge (no real WebSocket listener needed for these
 *     open_editor/status assertions) and lets cli.ts own the one real
 *     `startBridgeServer()` call plan §2 describes.
 *   - `open_editor`'s tool result is JSON text content whose parsed body is
 *     exactly `{port, token, url}` (plan §2).
 *   - `status`'s tool result is JSON text content whose parsed body is
 *     exactly `{port, tabConnected, contractVersion, toolCount}`; with no
 *     tab connected, `contractVersion` is `null` and `toolCount` is `0`
 *     (OQ-4: contract tools are registered but return `no_tab` errors while
 *     disconnected -- the *tool list* itself only grows once a tab's
 *     `describe()` is known, so an empty/no-tab toolCount of 0 is the most
 *     literal reading of "toolCount"; a builder finding this ambiguous
 *     should push back to the planner rather than guess differently).
 */

interface BridgeServerHandleStub {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

function fakeBridge(overrides?: Partial<BridgeServerHandleStub>): BridgeServerHandleStub {
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

import { createMcpServer } from './mcpServer';

let cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanupFns) await fn();
  cleanupFns = [];
  delete process.env.FIGPEA_EDITOR_URL;
});

async function connectedClient(bridge: BridgeServerHandleStub, options?: { editorBaseUrl?: string }) {
  const server = createMcpServer(bridge, options);
  const client = new Client({ name: 'req-074-mcpServer-test', version: '0.0.0' });
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
  expect(textBlock, `${name} tool result includes a text content block`).toBeDefined();
  return JSON.parse(textBlock!.text!);
}

describe('createMcpServer — static tools are always present (plan §2 OQ-4)', () => {
  it('lists open_editor and status before any tab ever connects', async () => {
    const client = await connectedClient(fakeBridge());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('open_editor');
    expect(names).toContain('status');
  });
});

describe('open_editor — well-formed URL (plan §2)', () => {
  it('returns {port, token, url}, defaulting the base to https://editor.figpea.com', async () => {
    const bridge = fakeBridge({ port: 54321, token: 'test-token-abc' });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'open_editor', {});
    expect(payload.port).toBe(54321);
    expect(payload.token).toBe('test-token-abc');
    expect(payload.url).toBe('https://editor.figpea.com/?agent=1&bridgePort=54321&bridgeToken=test-token-abc');
  });

  it('honors an explicit editorBaseUrl argument over the default', async () => {
    const bridge = fakeBridge({ port: 9999, token: 'tok-2' });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'open_editor', { editorBaseUrl: 'http://localhost:8154' });
    expect(payload.url).toBe('http://localhost:8154/?agent=1&bridgePort=9999&bridgeToken=tok-2');
  });

  it('honors the FIGPEA_EDITOR_URL env var when no editorBaseUrl argument or option is given', async () => {
    process.env.FIGPEA_EDITOR_URL = 'http://localhost:9000';
    const bridge = fakeBridge({ port: 111, token: 'tok-3' });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'open_editor', {});
    expect(payload.url).toBe('http://localhost:9000/?agent=1&bridgePort=111&bridgeToken=tok-3');
  });

  it('a constructor-level editorBaseUrl option takes precedence over FIGPEA_EDITOR_URL', async () => {
    process.env.FIGPEA_EDITOR_URL = 'http://localhost:9000';
    const bridge = fakeBridge({ port: 111, token: 'tok-4' });
    const client = await connectedClient(bridge, { editorBaseUrl: 'http://localhost:8154' });
    const payload = await callToolJson(client, 'open_editor', {});
    expect(payload.url).toBe('http://localhost:8154/?agent=1&bridgePort=111&bridgeToken=tok-4');
  });

  it('a per-call editorBaseUrl argument takes precedence over the constructor option', async () => {
    const bridge = fakeBridge({ port: 111, token: 'tok-5' });
    const client = await connectedClient(bridge, { editorBaseUrl: 'http://localhost:8154' });
    const payload = await callToolJson(client, 'open_editor', { editorBaseUrl: 'http://localhost:7777' });
    expect(payload.url).toBe('http://localhost:7777/?agent=1&bridgePort=111&bridgeToken=tok-5');
  });

  it('appends the REQ-016 loader-seam params when a file is given', async () => {
    const bridge = fakeBridge({ port: 222, token: 'tok-6' });
    const client = await connectedClient(bridge, { editorBaseUrl: 'http://localhost:8154' });
    const payload = await callToolJson(client, 'open_editor', { file: 'https://example.com/design.fig' });
    const url = new URL(payload.url);
    expect(url.searchParams.get('agent')).toBe('1');
    expect(url.searchParams.get('bridgePort')).toBe('222');
    expect(url.searchParams.get('bridgeToken')).toBe('tok-6');
    expect(url.searchParams.get('loader')).toBe('http');
    expect(url.searchParams.get('url')).toBe('https://example.com/design.fig');
  });

  it('omits loader params entirely when no file is given', async () => {
    const bridge = fakeBridge({ port: 222, token: 'tok-7' });
    const client = await connectedClient(bridge, { editorBaseUrl: 'http://localhost:8154' });
    const payload = await callToolJson(client, 'open_editor', {});
    const url = new URL(payload.url);
    expect(url.searchParams.has('loader')).toBe(false);
    expect(url.searchParams.has('url')).toBe(false);
  });
});

describe('status — reports live bridge state (plan §2 OQ-4)', () => {
  it('reports tabConnected:false, contractVersion:null, toolCount:0 with no tab connected', async () => {
    const bridge = fakeBridge({ port: 333, token: 'tok-8', isTabConnected: () => false });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'status', {});
    expect(payload).toEqual({ port: 333, tabConnected: false, contractVersion: null, toolCount: 0 });
  });

  it('reports tabConnected:true once the bridge reports a connected tab', async () => {
    const bridge = fakeBridge({ port: 444, token: 'tok-9', isTabConnected: () => true });
    const client = await connectedClient(bridge);
    const payload = await callToolJson(client, 'status', {});
    expect(payload.port).toBe(444);
    expect(payload.tabConnected).toBe(true);
  });
});

/**
 * REQ-093 T1 — AC-4 (docs/plans/REQ-093.md, Use cases -> test mapping: "MCP
 * inputSchema reflects enum params (z.enum) for an enum method"). Today
 * `buildInputShape` (mcpServer.ts:56-79) maps EVERY inputKey to a blind
 * `z.any().optional()`, regardless of what the manifest's param value
 * actually contains — so an enum-bearing param's registered Zod schema
 * carries no `enum` at all. Drives the REAL `McpServer` through a REAL SDK
 * `Client` (mirrors this file's own established `connectedClient` harness
 * above) and inspects the WIRE-LEVEL `tools/list` result's `inputSchema`
 * (JSON Schema, per `@modelcontextprotocol/sdk`'s own `toJsonSchemaCompat`
 * conversion in `server/mcp.js` — verified directly: a `z.enum([...])`
 * raw-shape field becomes `{type:"string", enum:[...]}` in the JSON Schema
 * `properties` the SDK serializes for `tools/list`).
 *
 * `fakeBridge`'s `onDescribe` here immediately invokes the passed handler
 * with a manifest carrying an enum param — `createMcpServer` calls
 * `bridge.onDescribe(handler)` once at construction (mcpServer.ts:212-214),
 * so this synchronously populates the contract tools before
 * `connectedClient` returns (no polling/wait needed, unlike the dev-lane e2e
 * harness's `waitForContractTool`, which is polling a REAL async bridge
 * connect instead of this in-process stub).
 */
describe('REQ-093 AC-4: contract tools carry enum params through as z.enum in the registered inputSchema', () => {
  const ENUM_MANIFEST = {
    layer: {
      reorder: {
        doc: 'Moves a layer to a sibling position relative to a target layer.',
        params: {
          id: { type: 'string', required: true },
          targetId: { type: 'string', required: true },
          pos: { type: 'string', required: true, enum: ['before', 'on', 'after'] },
        },
      },
    },
  };

  it("layer_reorder's registered inputSchema exposes pos as an enum of before/on/after", async () => {
    const bridge = fakeBridge({
      onDescribe: (handler) => handler(ENUM_MANIFEST),
    });
    const client = await connectedClient(bridge);
    const { tools } = await client.listTools();
    const reorder = tools.find((t) => t.name === 'layer_reorder');
    expect(reorder, 'layer_reorder contract tool is registered from the enum-bearing manifest').toBeDefined();
    const posSchema = (reorder as any)?.inputSchema?.properties?.pos;
    expect(posSchema, 'pos appears in the registered inputSchema properties').toBeDefined();
    expect(posSchema?.enum, 'pos.enum carries the allowed values through (z.enum, REQ-093 T5)').toEqual([
      'before',
      'on',
      'after',
    ]);
  });

  it('required-ness is advertised, never enforced as rejection — omitting a "required" param still reaches the bridge call, not a schema-validation error (Q1)', async () => {
    const bridge = fakeBridge({
      onDescribe: (handler) => handler(ENUM_MANIFEST),
      isTabConnected: () => false,
    });
    const client = await connectedClient(bridge);
    // Omitting `pos` entirely must not be rejected by the registered schema
    // itself (Q1: advertise required-ness, never enforce it, preserving
    // REQ-074's deliberate top-level `.optional()`) -- with no real tab
    // connected in this stub, the call should fall through to the bridge's
    // OWN "no_tab" gate, never a schema-validation rejection.
    const payload = await callToolJson(client, 'layer_reorder', { id: 'a', targetId: 'b' });
    expect(
      payload.code,
      'omitting "pos" is not rejected by schema validation -- falls through to the bridge\'s own no_tab gate',
    ).toBe('no_tab');
  });
});

describe('REQ-699 — prefetchedManifest & reconciliation / structural discriminator', () => {
  const FIXTURE_MANIFEST = {
    session: {
      status: { doc: 'Status doc', params: {}, result: {} }
    },
    layer: {
      create: { doc: 'Create layer', params: {}, result: {} }
    }
  };

  it('registers tools from prefetchedManifest immediately with no tab connected (AC-3)', async () => {
    const bridge = fakeBridge({ isTabConnected: () => false });
    const server = createMcpServer(bridge, { prefetchedManifest: FIXTURE_MANIFEST as any });
    const client = new Client({ name: 'req-699-prefetch-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanupFns.push(async () => {
      await client.close();
      await server.close();
    });

    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toContain('session_status');
    expect(names).toContain('layer_create');
  });

  it('reconciles when a narrower real tab connects, disabling surplus prefetched tools (AC-7)', async () => {
    const WIDE_PREFETCH = {
      session: {
        status: { doc: 'Status doc', params: {}, result: {} },
        close: { doc: 'Close session', params: {}, result: {} },
      },
      layer: {
        create: { doc: 'Create layer', params: {}, result: {} },
        delete: { doc: 'Delete layer', params: {}, result: {} },
      },
    };
    const NARROW_TAB_MANIFEST = {
      session: {
        status: { doc: 'Status doc', params: {}, result: {} },
      },
      layer: {
        create: { doc: 'Create layer', params: {}, result: {} },
      },
    };

    let onDescribeHandler: ((manifest: unknown) => void) | undefined;
    let isConnected = false;
    const bridge = fakeBridge({
      isTabConnected: () => isConnected,
      onDescribe: (handler) => {
        onDescribeHandler = handler;
      },
      callTab: async (group, method, args) => ({ ok: true, value: `${group}.${method}` }),
    });

    const server = createMcpServer(bridge, { prefetchedManifest: WIDE_PREFETCH as any });
    const client = new Client({ name: 'req-699-reconcile-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanupFns.push(async () => {
      await client.close();
      await server.close();
    });

    // 1. Initially with no tab, all 4 prefetched tools are registered
    const initialTools = await client.listTools();
    const initialNames = initialTools.tools.map((t) => t.name).sort();
    expect(initialNames).toEqual([
      'layer_create',
      'layer_delete',
      'open_editor',
      'session_close',
      'session_status',
      'status',
    ]);

    // 2. Real tab connects with narrower surface
    isConnected = true;
    expect(onDescribeHandler).toBeDefined();
    onDescribeHandler!(NARROW_TAB_MANIFEST);

    // 3. Surplus tools (session_close, layer_delete) are disabled and omitted from active tools list
    const postConnectTools = await client.listTools();
    const postConnectNames = postConnectTools.tools.map((t) => t.name).sort();
    expect(postConnectNames).toEqual(['layer_create', 'open_editor', 'session_status', 'status']);
    expect(postConnectNames).not.toContain('session_close');
    expect(postConnectNames).not.toContain('layer_delete');

    // 4. Advertised tools work normally
    const result = await callToolJson(client, 'session_status', {});
    expect(result).toEqual({ ok: true, value: 'session.status' });

    // 5. Calling a disabled surplus tool fails with tool disabled error
    const disabledCall = await client.callTool({ name: 'session_close', arguments: {} });
    expect(disabledCall.isError).toBe(true);
    expect(((disabledCall as any).content?.[0] as any)?.text).toMatch(/disabled/i);
  });

  it('handles pre-0.16.0 full-manifest-shaped tab connecting after prefetch via structural discriminator (AC-9)', async () => {
    const PREFETCH = {
      session: {
        status: { doc: 'Prefetched status', params: {}, result: {} },
      },
    };
    // Pre-0.16.0 full manifest shape (bare describe returns full descriptor objects with doc/params/result)
    const PRE_016_FULL_MANIFEST = {
      session: {
        status: { doc: 'Legacy session status', params: {}, result: {} },
      },
      layer: {
        create: { doc: 'Legacy layer create', params: { name: { type: 'string' } }, result: {} },
        inspect: { doc: 'Legacy layer inspect', params: {}, result: {} },
      },
    };

    let onDescribeHandler: ((manifest: unknown) => void) | undefined;
    let isConnected = false;
    const bridge = fakeBridge({
      isTabConnected: () => isConnected,
      onDescribe: (handler) => {
        onDescribeHandler = handler;
      },
      callTab: async (group, method, args) => ({ ok: true, value: `called ${group}.${method}` }),
    });

    const server = createMcpServer(bridge, { prefetchedManifest: PREFETCH as any });
    const client = new Client({ name: 'req-699-ac9-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanupFns.push(async () => {
      await client.close();
      await server.close();
    });

    // Tab connects reporting full-manifest shape
    isConnected = true;
    expect(onDescribeHandler).toBeDefined();
    onDescribeHandler!(PRE_016_FULL_MANIFEST);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['layer_create', 'layer_inspect', 'open_editor', 'session_status', 'status']);

    const callResult = await callToolJson(client, 'layer_create', { name: 'my-layer' });
    expect(callResult).toEqual({ ok: true, value: 'called layer.create' });
  });
});

