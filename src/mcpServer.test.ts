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

  // REQ-705 AC-7 — figpea_skill joins the always-present set, regardless of
  // tab state or whether a skill body was ever prefetched.
  it('lists figpea_skill before any tab ever connects', async () => {
    const client = await connectedClient(fakeBridge());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('figpea_skill');
  });
});

/**
 * REQ-705 T5 — `figpea_skill` MCP tool (Tech design §E). Sourced from the
 * origin artifact over REQ-699's startup fetch (cli.ts calls `fetchSkill()`
 * alongside `fetchContract()`, threading the result in as
 * `prefetchedSkillBody`) -- NOT tab-derived, so (unlike the manifest-driven
 * contract tools) it needs no `bridge.onDescribe` wiring: it's captured once
 * at construction and never changes for this server's lifetime.
 */
describe('REQ-705 — figpea_skill MCP tool (prefetchedSkillBody)', () => {
  it('has no inputSchema (no-argument tool, mirrors "status")', async () => {
    const client = await connectedClient(fakeBridge());
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'figpea_skill');
    expect(tool, 'figpea_skill is registered').toBeDefined();
    expect(
      (tool as any)?.inputSchema?.properties ?? {},
      'figpea_skill has no input properties',
    ).toEqual({});
  });

  it('returns the prefetched skill body as plain text when present, with no tab connected', async () => {
    const bridge = fakeBridge({ isTabConnected: () => false });
    const server = createMcpServer(bridge, { prefetchedSkillBody: '# Some skill markdown\n\nBody text.' });
    const client = new Client({ name: 'req-705-skill-tool-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanupFns.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({ name: 'figpea_skill', arguments: {} });
    const content = (result as any).content as Array<{ type: string; text?: string }>;
    const textBlock = content.find((c) => c.type === 'text');
    expect(textBlock, 'figpea_skill returns a text content block').toBeDefined();
    expect(textBlock!.text).toBe('# Some skill markdown\n\nBody text.');
    expect(result.isError, 'a successful skill fetch is not an error result').not.toBe(true);
  });

  it('degrades without crashing and reports why when no skill body was prefetched (fetch failed or disabled)', async () => {
    const bridge = fakeBridge({ isTabConnected: () => false });
    // No `prefetchedSkillBody` option at all -- the fetch failed, or was
    // disabled via FIGPEA_DISABLE_CONTRACT_FETCH, before this server was
    // constructed.
    const client = await connectedClient(bridge);

    let threw = false;
    let result: Awaited<ReturnType<Client['callTool']>> | undefined;
    try {
      result = await client.callTool({ name: 'figpea_skill', arguments: {} });
    } catch {
      threw = true;
    }
    expect(threw, 'figpea_skill must never throw/reject even with no prefetched body').toBe(false);

    const content = (result as any).content as Array<{ type: string; text?: string }>;
    const textBlock = content.find((c) => c.type === 'text');
    expect(textBlock, 'figpea_skill still returns a text content block').toBeDefined();
    const parsed = JSON.parse(textBlock!.text!);
    expect(parsed.ok, 'the degraded result is a structured {ok:false,...}, never a thrown error').toBe(false);
    expect(parsed.code).toBe('skill_unavailable');
    expect(typeof parsed.message, 'names WHY it is unavailable and how to get the body another way').toBe('string');
    expect(parsed.message.length).toBeGreaterThan(0);
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
    // (plus the two always-present static tools + figpea_skill, REQ-705)
    const initialTools = await client.listTools();
    const initialNames = initialTools.tools.map((t) => t.name).sort();
    expect(initialNames).toEqual([
      'figpea_skill',
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
    expect(postConnectNames).toEqual(['figpea_skill', 'layer_create', 'open_editor', 'session_status', 'status']);
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
    expect(names).toEqual(['figpea_skill', 'layer_create', 'layer_inspect', 'open_editor', 'session_status', 'status']);

    const callResult = await callToolJson(client, 'layer_create', { name: 'my-layer' });
    expect(callResult).toEqual({ ok: true, value: 'called layer.create' });
  });
});

/**
 * REQ-769 T1 — AC-1 + AC-4 red repro (docs/plans/REQ-769.md). Root cause:
 * `buildInputShape()` honors only `enum` from each structured ParamSchema and
 * maps everything else to `z.any().optional()`, which Zod v4 serializes as
 * `{}` in the JSON Schema the SDK advertises over `tools/list` — so every
 * object/array param (`layer_create.props`, `layer_setPosition.pos`,
 * `layer_stylePatch.patch`, `session_setSelection.ids`) is advertised untyped
 * and type-respecting clients stringify structured arguments.
 *
 * Two halves, both written against the ACCEPTANCE CRITERIA (not the fix):
 *  (a) schema half — a real SDK Client's `tools/list` advertisement declares
 *      the six structured types of AC-1 (objects passthrough with
 *      additionalProperties:true, scalars typed, arrays/matrix typed array);
 *  (b) chain half — a real `client.callTool` with an object argument delivers
 *      it to the stub bridge's `callTab` still `typeof "object"`.
 *
 * Same harness as REQ-093's AC-4 block above: InMemoryTransport linked pair +
 * real Client, `onDescribe` firing synchronously with an inline manifest
 * carrying structured params mirroring the live surface's methods.
 */
describe('REQ-769 AC-1/AC-4: contract tools advertise structured param types from the manifest', () => {
  const TYPED_MANIFEST = {
    layer: {
      setPosition: {
        doc: 'Places a layer visible box at world coords.',
        params: {
          id: { type: 'string', required: true },
          pos: { type: 'object', required: true, shape: { x: { type: 'number' }, y: { type: 'number' } } },
        },
        result: {},
      },
      create: {
        doc: 'Creates a new layer.',
        params: {
          kind: { type: 'string', required: true, enum: ['rect', 'ellipse', 'text'] },
          props: { type: 'object', required: false },
        },
        result: {},
      },
      stylePatch: {
        doc: 'Patches layer style keys.',
        params: {
          id: { type: 'string', required: true },
          patch: { type: 'object', required: true },
        },
        result: {},
      },
      setTransform: {
        doc: 'Sets the affine transform.',
        params: {
          id: { type: 'string', required: true },
          matrix: { type: 'array', required: true },
        },
        result: {},
      },
    },
    canvas: {
      // REQ-769 review-r1 F1: pin the bare scalar branches of the type
      // mapping — number and boolean params without enum must advertise
      // their own types, never regress to an untyped {} advertisement.
      setZoom: {
        doc: 'Sets the viewport zoom level.',
        params: {
          zoom: { type: 'number', required: false },
        },
        result: {},
      },
      setGridVisible: {
        doc: 'Toggles grid visibility.',
        params: {
          visible: { type: 'boolean', required: false },
        },
        result: {},
      },
    },
    session: {
      setSelection: {
        doc: 'Sets the current selection.',
        params: {
          ids: { type: 'array', required: false },
        },
        result: {},
      },
    },
  };

  function typedBridge(overrides?: Partial<BridgeServerHandleStub>) {
    return fakeBridge({
      onDescribe: (handler) => handler(TYPED_MANIFEST),
      ...overrides,
    });
  }

  async function toolByName(client: Client, name: string): Promise<any> {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    expect(tool, `${name} is registered from the typed manifest`).toBeDefined();
    return tool;
  }

  it('(AC-1 schema half) layer_setPosition advertises pos.type="object" (passthrough, additionalProperties:true) and id.type="string"', async () => {
    const client = await connectedClient(typedBridge());
    const posSchema = ((await toolByName(client, 'layer_setPosition')).inputSchema?.properties?.pos);
    expect(posSchema?.type, 'pos is advertised as object').toBe('object');
    expect(posSchema?.additionalProperties, 'object params stay passthrough — unknown keys keep flowing').toBe(true);
    const idSchema = (await toolByName(client, 'layer_setPosition')).inputSchema?.properties?.id;
    expect(idSchema?.type, 'id is advertised as string').toBe('string');
  });

  it('(AC-1 schema half) layer_create advertises props.type="object"; layer_stylePatch advertises patch.type="object"', async () => {
    const client = await connectedClient(typedBridge());
    expect((await toolByName(client, 'layer_create')).inputSchema?.properties?.props?.type).toBe('object');
    expect((await toolByName(client, 'layer_stylePatch')).inputSchema?.properties?.patch?.type).toBe('object');
  });

  it('(AC-1 schema half) bare number and boolean params advertise their own scalar types — never an untyped {} (review-r1 F1)', async () => {
    const client = await connectedClient(typedBridge());
    const zoom = (await toolByName(client, 'canvas_setZoom')).inputSchema?.properties?.zoom;
    expect(zoom?.type, 'a bare {type:"number"} param advertises type "number"').toBe('number');
    const visible = (await toolByName(client, 'canvas_setGridVisible')).inputSchema?.properties?.visible;
    expect(visible?.type, 'a bare {type:"boolean"} param advertises type "boolean"').toBe('boolean');
  });

  it('(AC-1 schema half) session_setSelection advertises ids.type="array" and layer_setTransform advertises matrix.type="array"', async () => {
    const client = await connectedClient(typedBridge());
    expect((await toolByName(client, 'session_setSelection')).inputSchema?.properties?.ids?.type).toBe('array');
    // matrix (an affine transform tuple) is advertised as an array per AC-1.
    expect((await toolByName(client, 'layer_setTransform')).inputSchema?.properties?.matrix?.type).toBe('array');
  });

  it('(AC-4 chain half) an object argument sent through a real client.callTool reaches bridge.callTab still typeof "object", contents intact', async () => {
    const captured: Array<unknown[]> = [];
    const bridge = typedBridge({
      isTabConnected: () => true,
      callTab: async (_group, _method, args) => {
        captured.push(args);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge);

    const result = await callToolJson(client, 'layer_setPosition', { id: 'test-id', pos: { x: 10, y: 10 } });
    expect(result.ok, 'the call succeeds end-to-end').toBe(true);

    expect(captured.length, 'bridge.callTab was reached exactly once').toBe(1);
    const [idArg, posArg] = captured[0];
    expect(idArg).toBe('test-id');
    expect(typeof posArg, 'the object argument arrives as a real object, not a JSON string').toBe('object');
    expect(posArg, 'contents survive the relay intact').toEqual({ x: 10, y: 10 });
  });
});

/**
 * REQ-769 T3 — guard pins around the AC-1/AC-2/AC-4 fix (docs/plans/REQ-769.md
 * task T3). Deliberate regression fences, written AFTER the fix they fence:
 * each behavior below holds both before and after T2's change, so any future
 * refactor of buildInputShape that breaks permissiveness (AC-2), legacy
 * registration (AC-3), or the enum mapping (AC-5) fails here loudly.
 */
describe('REQ-769 T3 guard pins — permissiveness, legacy manifests, enum precedence', () => {
  const PIN_MANIFEST = {
    layer: {
      setPosition: {
        doc: 'Places a layer visible box at world coords.',
        params: {
          id: { type: 'string', required: true },
          pos: { type: 'object', required: true },
        },
        result: {},
      },
    },
    legacy: {
      hintMethod: {
        doc: 'A pre-REQ-093 descriptor whose params are legacy free-text hint strings.',
        params: {
          target: 'the layer id to act on',
          options: '{width, height} — informal shape hint',
        },
        result: {},
      },
    },
  };

  function pinnedBridge(overrides?: Partial<BridgeServerHandleStub>) {
    return fakeBridge({
      onDescribe: (handler) => handler(PIN_MANIFEST),
      ...overrides,
    });
  }

  it('(AC-2) a wrong-typed value (string where "object" is advertised) still reaches bridge.callTab untouched', async () => {
    const captured: Array<unknown[]> = [];
    const bridge = pinnedBridge({
      isTabConnected: () => true,
      callTab: async (_g, _m, args) => {
        captured.push(args);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge);

    // The schema ADVERTISES pos as object; supplying a string must not be
    // rejected server-side — the value passes through value-identical.
    const result = await callToolJson(client, 'layer_setPosition', { id: 'x', pos: 'i-am-not-an-object' });
    expect(result.ok).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0][0]).toBe('x');
    expect(captured[0][1]).toBe('i-am-not-an-object');
  });

  it('(AC-2) an entirely omitted optional key reaches bridge.callTab as an undefined positional slot (inputKeys.map convention)', async () => {
    const captured: Array<unknown[]> = [];
    const bridge = pinnedBridge({
      isTabConnected: () => true,
      callTab: async (_g, _m, args) => {
        captured.push(args);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge);

    const result = await callToolJson(client, 'layer_setPosition', { id: 'only-id' });
    expect(result.ok).toBe(true);
    expect(captured[0].length, 'positional arity is preserved').toBe(2);
    expect(captured[0][0]).toBe('only-id');
    expect(captured[0][1], 'the omitted key lands as undefined in its declared position').toBeUndefined();
  });

  it('(AC-2) every typed-mapped property stays .optional() in the advertisement — none appear in inputSchema.required', async () => {
    const client = await connectedClient(pinnedBridge());
    const { tools } = await client.listTools();
    const setPosition = tools.find((t) => t.name === 'layer_setPosition');
    const required: string[] | undefined = (setPosition as any)?.inputSchema?.required;
    expect(required ?? []).toEqual([]);
  });

  it('(AC-3) a legacy free-text-hint descriptor registers unchanged and its properties stay untyped {} advertisements', async () => {
    const client = await connectedClient(pinnedBridge());
    const { tools } = await client.listTools();
    const hint = tools.find((t) => t.name === 'legacy_hintMethod');
    expect(hint, 'legacy descriptor registers successfully').toBeDefined();
    const props = (hint as any)?.inputSchema?.properties;
    expect(Object.keys(props ?? {}).sort()).toEqual(['options', 'target']);
    // Untyped: today's z.any().optional() serializes to an empty property schema.
    expect(props.target ?? {}).toEqual({});
    expect(props.options ?? {}).toEqual({});
  });

  it('(AC-5) an enum-carrying param still advertises {type:"string", enum:[…]} alongside typed params', async () => {
    const ENUM_MANIFEST = {
      layer: {
        reorder: {
          doc: 'Moves a layer relative to a target.',
          params: {
            id: { type: 'string', required: true },
            pos: { type: 'string', required: true, enum: ['before', 'on', 'after'] },
          },
          result: {},
        },
      },
    };
    const bridge = fakeBridge({ onDescribe: (handler) => handler(ENUM_MANIFEST) });
    const client = await connectedClient(bridge);
    const { tools } = await client.listTools();
    const pos = (tools.find((t) => t.name === 'layer_reorder') as any)?.inputSchema?.properties?.pos;
    expect(pos?.type, 'enum params advertise their constrained string type').toBe('string');
    expect(pos?.enum).toEqual(['before', 'on', 'after']);
    // And its parse stays enum-constrained (pre-existing REQ-093 behavior):
    // a non-listed value is rejected by the SDK's validation role.
    const bridge2 = fakeBridge({
      onDescribe: (h) => h(ENUM_MANIFEST),
      isTabConnected: () => false,
    });
    const client2 = await connectedClient(bridge2);
    const rejected = await client2.callTool({ name: 'layer_reorder', arguments: { id: 'x', pos: 'sideways' } });
    const rejectedText = ((rejected as any).content as Array<{ type: string; text?: string }>)
      .find((c) => c.type === 'text')
      ?.text;
    expect(
      rejected.isError === true || /invalid/i.test(rejectedText ?? ''),
      'non-listed enum value is still rejected (unchanged REQ-093 behavior)',
    ).toBe(true);
  });

  it('(AC-5) a param carrying both enum and type resolves enum-FIRST: the advertisement is the constrained string, never the raw type', async () => {
    const PRECEDENCE_MANIFEST = {
      layer: {
        setBlend: {
          doc: 'Sets blend mode.',
          params: {
            mode: { type: 'number', required: true, enum: ['normal', 'multiply'] },
          },
          result: {},
        },
      },
    };
    const bridge = fakeBridge({ onDescribe: (handler) => handler(PRECEDENCE_MANIFEST) });
    const client = await connectedClient(bridge);
    const { tools } = await client.listTools();
    const mode = (tools.find((t) => t.name === 'layer_setBlend') as any)?.inputSchema?.properties?.mode;
    expect(mode?.type, 'enum wins over the declared type (documented precedence)').toBe('string');
    expect(mode?.enum).toEqual(['normal', 'multiply']);
  });
});

describe('contract tool calls when no tab is connected — AC-1 actionable no_tab error', () => {
  it('returns no_tab with a message and a url carrying origin, agent=1, bridgePort, and bridgeToken', async () => {
    const bridge = fakeBridge({ port: 12345, token: 'secret-tok' });
    const manifest = { layer: { setPosition: { doc: 'Move layer', params: {} } } };
    const bridgeWithDescribe = { ...bridge, onDescribe: (h: any) => h(manifest) };
    const client = await connectedClient(bridgeWithDescribe);
    const result = await client.callTool({ name: 'layer_setPosition', arguments: {} });
    const textBlock = (result.content as any).find((c: any) => c.type === 'text');
    const parsed = JSON.parse(textBlock.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('no_tab');
    expect(parsed.message).toContain('No editor tab paired');
    expect(parsed.url).toBe('https://editor.figpea.com/?agent=1&bridgePort=12345&bridgeToken=secret-tok');
  });
});

