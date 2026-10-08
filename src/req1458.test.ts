import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import type { ManifestLike } from './tools';

/**
 * REQ-1458 T6 — the passthrough pin (AC-6, figpea-mcp half).
 *
 * No product change is expected here: tools are generated from the fetched
 * manifest (REQ-699) and results are `JSON.stringify`'d payloads, so
 * `lineWidths` / `warning` pass through by construction. This file PROVES that
 * premise rather than asserting it in prose:
 *
 *  1. a fixture manifest bearing `lineWidths` on `measureText` and `warning`
 *     on `create` / `setText` generates tools whose descriptions carry the fields;
 *  2. a stubbed bridge result bearing them arrives byte-identical in the MCP
 *     content text (parsed back and compared with `toEqual`, not substring).
 *
 * Vehicle: a real MCP SDK `Client` over `InMemoryTransport` driving the real
 * server — a genuine `registerTool` → handler → `callTab` round trip, with a
 * stub tab standing in for the paired editor.
 *
 * Green-by-design. If red: STOP and report — the passthrough premise is
 * falsified, and the bridge must NOT be "fixed" here.
 */

const MANIFEST = {
  layer: {
    measureText: {
      doc: 'Measures text without creating a layer.',
      params: {
        spec: {
          type: 'object',
          required: true,
          shape: {
            text: { type: 'string', required: true },
            style: { type: 'object', required: false },
          },
        },
      },
      result: {
        naturalWidth: 'number',
        naturalHeight: 'number',
        lines: 'number (the UNCLIPPED wrapped line count)',
        lineWidths: 'number[] (one ink width per wrapped line, in order, length === lines)',
      },
    },
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: { type: 'string', required: true },
        props: { type: 'object', required: false },
      },
      result: { id: 'string', warning: 'string (present only when there is something to say)' },
    },
    setText: {
      doc: "Replaces a text layer's full text content.",
      params: {
        id: { type: 'string', required: true },
        text: { type: 'string', required: true },
      },
      result: { warning: 'string (present only when the applied breaks differ)' },
    },
  },
} as unknown as ManifestLike;

/** The v3-shaped answers the stub returns — bearing the new fields. */
const MEASURE_VALUE = {
  ok: true,
  value: {
    naturalWidth: 295,
    naturalHeight: 40,
    lines: 2,
    lineWidths: [201, 295],
    requestedFamily: 'IBM Plex Sans',
    measuredFamily: 'IBM Plex Sans',
    substituted: false,
    verified: true,
  },
};
const CREATE_VALUE = {
  ok: true,
  value: {
    id: 'L_probe',
    warning: 'text line 2 measures 295px in a 240px box and was re-wrapped into 2 lines',
  },
};
const SETTEXT_VALUE = {
  ok: true,
  value: {
    warning: 'text line 1 measures 280px in a 240px box and was re-wrapped into 2 lines',
  },
};

function makeStub() {
  const stub = {
    port: 54398,
    token: 'test-token-1458',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      h(MANIFEST);
    },
    callTab: async (group: string, method: string, _args: unknown[]) => {
      if (group === 'layer' && method === 'measureText') return structuredClone(MEASURE_VALUE);
      if (group === 'layer' && method === 'create') return structuredClone(CREATE_VALUE);
      if (group === 'layer' && method === 'setText') return structuredClone(SETTEXT_VALUE);
      return { ok: false as const, code: 'not_found', message: `unknown ${group}.${method}` };
    },
    close: async () => {},
  };
  return { stub };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function connect(bridge: unknown) {
  const server = createMcpServer(bridge as never, {} as never);
  const client = new Client({ name: 'req-1458-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result: any = await client.callTool({ name, arguments: args } as any);
  const content = result.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, `${name} returned a text block`).toBeDefined();
  return JSON.parse(textBlock!.text ?? '');
}

describe('REQ-1458 AC-6 — figpea-mcp passes the new fields through', () => {
  it('the generated layer_measureText tool description carries lineWidths', async () => {
    const { stub } = makeStub();
    const client = await connect(stub);
    const tools: any = await client.listTools();
    const names = tools.tools.map((t: any) => t.name);
    expect(names, 'the fixture manifest generates a layer_measureText tool').toContain('layer_measureText');
    const tool = tools.tools.find((t: any) => t.name === 'layer_measureText');
    expect(JSON.stringify(tool), 'the tool description carries the new field').toContain('lineWidths');
  });

  it('a measureText result bearing lineWidths arrives byte-identical', async () => {
    const { stub } = makeStub();
    const client = await connect(stub);
    const back = await callToolJson(client, 'layer_measureText', {
      spec: { text: 'a\nb', style: { fontSize: 15, fixWidth: 240 } },
    });
    expect(back.value.lineWidths, 'lineWidths survives the round trip').toEqual(
      MEASURE_VALUE.value.lineWidths,
    );
    expect(back.value.naturalWidth, 'existing fields still arrive alongside').toBe(295);
  });

  it('create/setText results bearing warning arrive byte-identical', async () => {
    const { stub } = makeStub();
    const client = await connect(stub);
    const created = await callToolJson(client, 'layer_create', {
      kind: 'text',
      props: { text: 'a\nb', style: { fixWidth: 240 } },
    });
    expect(created.value.warning, 'the create warning survives the round trip').toBe(
      CREATE_VALUE.value.warning,
    );
    const set = await callToolJson(client, 'layer_setText', { id: 'L_probe', text: 'wide line here' });
    expect(set.value.warning, 'the setText warning survives the round trip').toBe(
      SETTEXT_VALUE.value.warning,
    );
  });
});
