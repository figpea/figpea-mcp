import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import type { ManifestLike } from './tools';

/**
 * REQ-1037 — opencode harness stringifies numbers inside nested objects.
 *
 * Failure surface (from Trello desc, contract 1.15.0 verified):
 *  - layer_create page props.pageWidth "1500" (string) -> should arrive as number 1500
 *  - layer_setTransform matrix ["5","0","0","3.5","0","0"] -> numbers
 *  - session_openFile input.bytes ["72","101"] -> numbers
 *  - layer_batch ops deeply-nested rwidth:"100" inside args array -> numbers (schema-opaque, currently uncoerced)
 *  - _rawJson bypass: props as JSON string + _rawJson:true -> parsed object with numbers
 *
 * RED reason before fix:
 *  - AC-1..3 are technically covered by REQ-870's schema-aware coercion, so they PASS on current tree (regression pins).
 *  - AC-4 FAILS because batch args inner object has no schema — generic walk stops at args array without of, leaving rwidth:"100" as string.
 *  - AC-5 FAILS because _rawJson is not implemented — stringified JSON stays string.
 */

function fakeBridge(overrides?: any) {
  return {
    port: 54321,
    token: 'test-token-1037',
    isTabConnected: () => false,
    onDescribe: () => {},
    callTab: async () => ({ ok: true, value: null }),
    close: async () => {},
    ...overrides,
  };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function connectedClient(bridge: any, manifest: ManifestLike) {
  // Have bridge deliver manifest via onDescribe
  const stub = fakeBridge({
    ...bridge,
    onDescribe: (h: any) => h(manifest),
  });
  const server = createMcpServer(stub as any);
  const client = new Client({ name: 'req-1037-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { client, stub };
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result: any = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, `${name} has text block`).toBeDefined();
  return JSON.parse(textBlock!.text!);
}

const MANIFEST = {
  layer: {
    create: {
      doc: 'Creates layer',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect'] },
        props: {
          type: 'object',
          required: false,
          shape: {
            pageWidth: { type: 'number', required: false },
            pageHeight: { type: 'number', required: false },
            rwidth: { type: 'number', required: false },
            rheight: { type: 'number', required: false },
            text: { type: 'string', required: false },
          },
          byKind: {
            page: { pageWidth: { type: 'number' }, pageHeight: { type: 'number' } },
            rect: { rwidth: { type: 'number' }, rheight: { type: 'number' } },
          },
        },
      },
      result: {},
    },
    setTransform: {
      doc: 'setTransform',
      params: {
        id: { type: 'string', required: true },
        matrix: { type: 'matrix', required: true },
      },
      result: {},
    },
    batch: {
      doc: 'batch',
      params: {
        ops: {
          type: 'array',
          required: true,
          of: {
            type: 'object',
            required: true,
            shape: {
              method: { type: 'string', required: true },
              args: { type: 'array', required: true },
            },
          },
        },
      },
      result: {},
    },
  },
  session: {
    openFile: {
      doc: 'openFile',
      params: {
        input: {
          type: 'object',
          required: true,
          shape: {
            url: { type: 'string', required: false },
            bytes: { type: 'array', required: false, of: { type: 'number', required: true } },
            filePath: { type: 'string', required: false },
          },
        },
      },
      result: {},
    },
  },
} as unknown as ManifestLike;

describe('REQ-1037 AC-1 — page create nested numbers stringified', () => {
  it('props.pageWidth "1500" arrives as number 1500 at bridge', async () => {
    const captured: unknown[][] = [];
    const { client } = await connectedClient(
      { isTabConnected: () => true, callTab: async (_g: string, _m: string, args: unknown[]) => { captured.push(args); return { ok: true, value: null }; } },
      MANIFEST,
    );
    await callToolJson(client, 'layer_create', { kind: 'page', props: { pageWidth: '1500', pageHeight: '1050' } });
    const props = captured[0][1] as any;
    expect(typeof props.pageWidth).toBe('number');
    expect(props.pageWidth).toBe(1500);
    expect(typeof props.pageHeight).toBe('number');
    expect(props.pageHeight).toBe(1050);
  });
});

describe('REQ-1037 AC-2 — matrix string numbers', () => {
  it('matrix ["5","0","0","3.5","0","0"] arrives as numbers', async () => {
    const captured: unknown[][] = [];
    const { client } = await connectedClient(
      { isTabConnected: () => true, callTab: async (_g: string, _m: string, args: unknown[]) => { captured.push(args); return { ok: true, value: null }; } },
      MANIFEST,
    );
    await callToolJson(client, 'layer_setTransform', { id: 'x', matrix: ['5', '0', '0', '3.5', '0', '0'] as any });
    const mat = captured[0][1] as unknown[];
    expect(mat).toEqual([5, 0, 0, 3.5, 0, 0]);
    expect(mat.every((v) => typeof v === 'number')).toBe(true);
  });
});

describe('REQ-1037 AC-3 — bytes array string numbers', () => {
  it('input.bytes ["72","101"] arrives as numbers', async () => {
    const captured: unknown[][] = [];
    const { client } = await connectedClient(
      { isTabConnected: () => true, callTab: async (_g: string, _m: string, args: unknown[]) => { captured.push(args); return { ok: true, value: null }; } },
      MANIFEST,
    );
    await callToolJson(client, 'session_openFile', { input: { bytes: ['72', '101', '108'] as any } });
    const input = captured[0][0] as any;
    expect(input.bytes.every((v: unknown) => typeof v === 'number')).toBe(true);
    expect(input.bytes).toEqual([72, 101, 108]);
  });
});

describe('REQ-1037 AC-4 — batch deeply-nested numbers (schema-opaque) — EXPECTED RED', () => {
  it('ops[0].args[1].rwidth "100" inside batch arrives as number 100', async () => {
    const captured: unknown[][] = [];
    const { client } = await connectedClient(
      { isTabConnected: () => true, callTab: async (_g: string, _m: string, args: unknown[]) => { captured.push(args); return { ok: true, value: null }; } },
      MANIFEST,
    );
    await callToolJson(client, 'layer_batch', { ops: [{ method: 'create', args: ['rect', { rwidth: '100', rheight: '50' }] }] });
    const ops = captured[0][0] as any[];
    const nested = ops[0].args[1] as any;
    // This is RED before fix: nested.rwidth stays string "100"
    expect(typeof nested.rwidth).toBe('number');
    expect(nested.rwidth).toBe(100);
    expect(typeof nested.rheight).toBe('number');
    expect(nested.rheight).toBe(50);
  });
});

describe('REQ-1037 AC-5 — _rawJson bypass — EXPECTED RED', () => {
  it('props as JSON string with _rawJson:true parsed to object with numbers', async () => {
    const captured: unknown[][] = [];
    const { client } = await connectedClient(
      { isTabConnected: () => true, callTab: async (_g: string, _m: string, args: unknown[]) => { captured.push(args); return { ok: true, value: null }; } },
      MANIFEST,
    );
    await callToolJson(client, 'layer_create', {
      kind: 'page',
      props: '{"pageWidth":1500,"pageHeight":1050}' as any,
      _rawJson: true,
    } as any);
    const props = captured[0][1] as any;
    expect(typeof props).toBe('object');
    expect(props.pageWidth).toBe(1500);
    expect(typeof props.pageWidth).toBe('number');
  });

  it('matrix as JSON string with _rawJson:true parsed to array of numbers', async () => {
    const captured: unknown[][] = [];
    const { client } = await connectedClient(
      { isTabConnected: () => true, callTab: async (_g: string, _m: string, args: unknown[]) => { captured.push(args); return { ok: true, value: null }; } },
      MANIFEST,
    );
    await callToolJson(client, 'layer_setTransform', {
      id: 'x',
      matrix: '[5,0,0,3.5,0,0]' as any,
      _rawJson: true,
    } as any);
    const mat = captured[0][1] as unknown[];
    expect(Array.isArray(mat)).toBe(true);
    expect(mat).toEqual([5, 0, 0, 3.5, 0, 0]);
  });
});

describe('REQ-1037 AC-6 — no new rejections / permissive', () => {
  it('text:"1000" stays string (not coerced)', async () => {
    const captured: unknown[][] = [];
    const { client } = await connectedClient(
      { isTabConnected: () => true, callTab: async (_g: string, _m: string, args: unknown[]) => { captured.push(args); return { ok: true, value: null }; } },
      MANIFEST,
    );
    await callToolJson(client, 'layer_create', { kind: 'rect', props: { text: '1000' } });
    const props = captured[0][1] as any;
    expect(typeof props.text).toBe('string');
    expect(props.text).toBe('1000');
  });
});
