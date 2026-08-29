import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { buildToolsFromManifest } from './tools';
import type { ManifestLike } from './tools';

/**
 * REQ-870 — REQ-769 follow-up: nested numeric properties stringified.
 *
 * AC-1: tools/list advertises nested types (props.pageWidth etc as number, pos.x/y as number, matrix as array)
 * AC-2: string numerics "1000"/"1000.0"/"0" for number-declared fields arrive as number at bridge.callTab, text:"1000" stays string
 * AC-3: no new rejections / legacy still permissive
 *
 * Failures are expected on unfixed tree:
 *  - AC-1 fails because buildParamSchemas discards shape/byKind/of, so buildInputShape advertises flat {type:object}
 *  - AC-2 fails because makeContractHandler has no coercion, so "1000" stays string
 */

interface BridgeStub {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
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

async function connectedClient(bridge: BridgeStub, options?: { editorBaseUrl?: string }) {
  const server = createMcpServer(bridge as any, options);
  const client = new Client({ name: 'req-870-test', version: '0.0.0' });
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

// Minimal nested manifest mirroring real surface for AC-1/AC-2
const NESTED_MANIFEST = {
  layer: {
    create: {
      doc: 'Creates a new layer.',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'ellipse'] },
        props: {
          type: 'object',
          required: false,
          shape: {
            name: { type: 'string', required: false },
            pageWidth: { type: 'number', required: false },
            pageHeight: { type: 'number', required: false },
            rwidth: { type: 'number', required: false },
            rheight: { type: 'number', required: false },
            text: { type: 'string', required: false },
          },
          byKind: {
            page: {
              pageWidth: { type: 'number', required: false },
              pageHeight: { type: 'number', required: false },
            },
            rect: {
              rwidth: { type: 'number', required: false },
              rheight: { type: 'number', required: false },
            },
          },
        },
      },
      result: {},
    },
    setPosition: {
      doc: 'Places a layer.',
      params: {
        id: { type: 'string', required: true },
        pos: {
          type: 'object',
          required: true,
          shape: {
            x: { type: 'number', required: true },
            y: { type: 'number', required: true },
          },
        },
      },
      result: {},
    },
    setTransform: {
      doc: 'Sets transform.',
      params: {
        id: { type: 'string', required: true },
        matrix: { type: 'array', required: true, of: { type: 'number', required: true } },
      },
      result: {},
    },
    batch: {
      doc: 'Batch.',
      params: {
        ops: { type: 'array', required: true, of: { type: 'object', required: true } },
      },
      result: {},
    },
  },
} as unknown as ManifestLike;

describe('REQ-870 AC-1 — Nested types advertised via tools/list', () => {
  it('layer_create props advertises pageWidth/pageHeight/rwidth as number inside properties', async () => {
    const bridge = fakeBridge({ onDescribe: (h) => h(NESTED_MANIFEST) });
    const client = await connectedClient(bridge);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'layer_create');
    expect(tool, 'layer_create is registered').toBeDefined();
    const propsSchema = (tool as any)?.inputSchema?.properties?.props;
    expect(propsSchema, 'props is advertised').toBeDefined();
    expect(propsSchema?.type).toBe('object');
    // Nested properties must be typed
    const nested = propsSchema?.properties;
    expect(nested, 'props has nested properties advertised').toBeDefined();
    expect(nested?.pageWidth?.type, 'pageWidth advertised as number').toBe('number');
    expect(nested?.pageHeight?.type, 'pageHeight advertised as number').toBe('number');
    expect(nested?.rwidth?.type, 'rwidth advertised as number').toBe('number');
    expect(nested?.rheight?.type, 'rheight advertised as number').toBe('number');
  });

  it('layer_setPosition pos advertises x/y as number', async () => {
    const bridge = fakeBridge({ onDescribe: (h) => h(NESTED_MANIFEST) });
    const client = await connectedClient(bridge);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'layer_setPosition');
    const posSchema = (tool as any)?.inputSchema?.properties?.pos;
    expect(posSchema?.type).toBe('object');
    expect(posSchema?.properties?.x?.type, 'pos.x is number').toBe('number');
    expect(posSchema?.properties?.y?.type, 'pos.y is number').toBe('number');
  });

  it('layer_setTransform matrix advertises as array', async () => {
    const bridge = fakeBridge({ onDescribe: (h) => h(NESTED_MANIFEST) });
    const client = await connectedClient(bridge);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'layer_setTransform');
    const matrixSchema = (tool as any)?.inputSchema?.properties?.matrix;
    expect(matrixSchema?.type, 'matrix is array').toBe('array');
  });

  it('tools.ts buildToolsFromManifest preserves shape/byKind/of for nested advertisement', () => {
    const tools = buildToolsFromManifest(NESTED_MANIFEST as any);
    const createTool = tools.find((t) => t.name === 'layer_create');
    expect(createTool?.paramSchemas?.props, 'props paramSchema exists').toBeDefined();
    const propsSchema: any = createTool?.paramSchemas?.props;
    expect(propsSchema?.shape?.pageWidth?.type, 'shape preserved').toBe('number');
    expect(propsSchema?.byKind?.page?.pageWidth?.type, 'byKind preserved').toBe('number');
    const transformTool = tools.find((t) => t.name === 'layer_setTransform');
    const matrixSchema: any = transformTool?.paramSchemas?.matrix;
    expect(matrixSchema?.of?.type, 'matrix.of preserved').toBe('number');
  });
});

describe('REQ-870 AC-2 — String numerics coerced to numbers where declared type is number', () => {
  it('props.pageWidth "1000" arrives as number 1000, "1000.0" as 1000, text "1000" stays string', async () => {
    const captured: unknown[][] = [];
    const bridge = fakeBridge({
      onDescribe: (h) => h(NESTED_MANIFEST),
      isTabConnected: () => true,
      callTab: async (_g, _m, args) => {
        captured.push(args);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge);
    // "1000" string for number field
    await callToolJson(client, 'layer_create', { kind: 'page', props: { pageWidth: '1000', pageHeight: 700 } });
    expect(captured[0][1], 'props is object').toBeDefined();
    expect(typeof (captured[0][1] as any).pageWidth, 'pageWidth coerced to number').toBe('number');
    expect((captured[0][1] as any).pageWidth).toBe(1000);

    captured.length = 0;
    await callToolJson(client, 'layer_create', { kind: 'page', props: { pageWidth: '1000.0' } });
    expect(typeof (captured[0][1] as any).pageWidth).toBe('number');
    expect((captured[0][1] as any).pageWidth).toBe(1000);

    captured.length = 0;
    await callToolJson(client, 'layer_create', { kind: 'rect', props: { text: '1000' } });
    expect(typeof (captured[0][1] as any).text, 'text stays string').toBe('string');
    expect((captured[0][1] as any).text).toBe('1000');
  });

  it('pos.x "0" arrives as number 0', async () => {
    const captured: unknown[][] = [];
    const bridge = fakeBridge({
      onDescribe: (h) => h(NESTED_MANIFEST),
      isTabConnected: () => true,
      callTab: async (_g, _m, args) => {
        captured.push(args);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge);
    await callToolJson(client, 'layer_setPosition', { id: 'x', pos: { x: '0', y: '0' } });
    expect(typeof (captured[0][1] as any).x).toBe('number');
    expect((captured[0][1] as any).x).toBe(0);
    expect(typeof (captured[0][1] as any).y).toBe('number');
  });

  it('matrix string elements coerced to numbers', async () => {
    const captured: unknown[][] = [];
    const bridge = fakeBridge({
      onDescribe: (h) => h(NESTED_MANIFEST),
      isTabConnected: () => true,
      callTab: async (_g, _m, args) => {
        captured.push(args);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge);
    await callToolJson(client, 'layer_setTransform', { id: 'x', matrix: ['1', '0', '0', '1', '0', '0'] as any });
    const mat = captured[0][1] as unknown[];
    expect(mat.every((v) => typeof v === 'number'), 'all matrix elements coerced to number').toBe(true);
  });
});

describe('REQ-870 AC-3 — No new rejections / legacy still permissive', () => {
  it('wrong-typed values still reach tab (permissive)', async () => {
    const captured: unknown[][] = [];
    const bridge = fakeBridge({
      onDescribe: (h) => h(NESTED_MANIFEST),
      isTabConnected: () => true,
      callTab: async (_g, _m, args) => {
        captured.push(args);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge);
    // Send string where object expected — should not be rejected, should reach tab
    await callToolJson(client, 'layer_setPosition', { id: 'x', pos: 'not-an-object' as any });
    expect(captured[0][1]).toBe('not-an-object');
  });

  it('omitted optional keys still reach tab as undefined positional', async () => {
    const captured: unknown[][] = [];
    const bridge = fakeBridge({
      onDescribe: (h) => h(NESTED_MANIFEST),
      isTabConnected: () => true,
      callTab: async (_g, _m, args) => {
        captured.push(args);
        return { ok: true, value: null };
      },
    });
    const client = await connectedClient(bridge);
    await callToolJson(client, 'layer_create', { kind: 'page' });
    expect(captured[0].length).toBe(2);
    expect(captured[0][1]).toBeUndefined();
  });

  it('legacy free-text hint descriptors still register as {}', async () => {
    const legacyManifest = {
      legacy: {
        hintMethod: {
          doc: 'Legacy',
          params: { target: 'the id', options: '{width,height}' },
          result: {},
        },
      },
    } as unknown as ManifestLike;
    const bridge = fakeBridge({ onDescribe: (h) => h(legacyManifest) });
    const client = await connectedClient(bridge);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'legacy_hintMethod');
    expect(tool).toBeDefined();
    const props: any = (tool as any)?.inputSchema?.properties;
    expect(Object.keys(props ?? {}).sort()).toEqual(expect.arrayContaining(['options', 'target']));
    expect(props.target ?? {}).toEqual({});
  });
});
