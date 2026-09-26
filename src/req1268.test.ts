import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import type { ManifestLike } from './tools';

/**
 * REQ-1268 — compact mode (the DEFAULT) gives an agent no way to learn a
 * nested-array method's wire shape.
 *
 * The incident (Trello card REQ-1268, observed 2026-09-26): an agent called
 * `figpea_call` for `layer.batch` and produced
 *
 *   {"group":"layer","method":"batch","args":[{"item":{"item":{"args":{"item":{"item":["page",{…}]}},"method":"create"}}}]}
 *
 * → `invalid_params: batch(): ops must be array (got object)`. Both array
 * levels were collapsed into single-key `{"item": …}` envelopes by the host
 * harness. Not caller error: compact mode registers exactly four tools, none
 * of which publishes the descriptor, and `figpea_call`'s only worked example
 * is a FLAT positional pair — so `layer.batch`, the one method whose payload
 * is a doubly-nested positional array, is the shape it teaches worst.
 *
 * AC map:
 *  - AC-1  an agent can obtain the wire shape in ONE cheap call → `figpea_describe`
 *  - AC-2  `figpea_call`'s own text teaches the nested payload
 *  - AC-3  compact/full parity: the same `coerceValue` pass runs on the compact path
 *  - AC-5  the mangled payload costs ZERO round trips and gets an actionable error
 *
 * RED on the unfixed worktree: there is no `figpea_describe` (AC-1), the
 * description carries no nested payload (AC-2), compact mode coerces nothing so
 * `pageWidth:"100"` reaches the tab as a string (AC-3), and the incident
 * payload is relayed verbatim after a full bridge round trip (AC-5).
 */

/** The real `layer.batch` descriptor `doc`, verbatim from
 *  v3/src/agent/groups/layer.descriptor.ts (REQ-801/REQ-872 text). Kept
 *  faithful because AC-1 is exactly the claim that an agent reading ONLY this
 *  text can build the payload. */
const BATCH_DOC =
  'Applies a sequence of layer ops as ONE undo step, all-or-nothing: on any op failure the whole batch is rolled back and the result reports the failing op\'s code. Each op is an object {method, args} where method is the bare method name ("create", "setPosition", …) without the "layer." prefix and args is the same array the direct figpea_layer_<method> call would take — its array of POSITIONAL arguments in the same order as that method\'s own parameters — e.g. [{method:"create", args:["rect", {parentId:"<pageId>", rwidth:100, rheight:50}]}, {method:"setPosition", args:["<layerId>", {x:10, y:20}]}] creates a rect and places it in one undo step. args must be array (positional), not an object — e.g. reparent is [id, parentId] not {id, parentId}.';

const MANIFEST = {
  layer: {
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'text'] },
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
        },
      },
      result: { id: 'string' },
    },
    batch: {
      doc: BATCH_DOC,
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
      result: { results: 'OpResult[]' },
    },
  },
  session: {
    describe: {
      doc: 'Returns the agent contract surface: with no argument the group index, with "group" that group, with "group.method" that method.',
      params: {},
      result: {},
    },
  },
} as unknown as ManifestLike;

/** The incident payload, byte-for-byte from the card. Both array levels are
 *  wrapped in single-key `{"item": …}` envelopes. */
const INCIDENT_ARGS = [
  {
    item: {
      item: {
        args: { item: { item: ['page', { name: 'probe', pageWidth: '100', pageHeight: '100' }] } },
        method: 'create',
      },
    },
  },
];

/** The same call, correct: ops is ONE positional element of args, and each
 *  op's own args is an array. */
const CORRECT_ARGS = [[{ method: 'create', args: ['page', { name: 'probe', pageWidth: 100, pageHeight: 100 }] }]];

function fakeBridge(overrides?: Record<string, unknown>) {
  return {
    port: 54399,
    token: 'test-token-1268',
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

/** Compact mode — the DEFAULT (cli.ts:79). `deliverManifest: false` models the
 *  no-tab-yet case, which is what proves the describe tool costs no startup
 *  work: the manifest is already in memory from the prefetch. */
async function compactClient(bridge: Record<string, unknown>, opts?: { manifest?: unknown; deliverManifest?: boolean }) {
  // `in` rather than `??`: the degrade-case test passes `manifest: undefined`
  // on purpose, and `??` would silently fall back to the fixture and make
  // that test assert nothing.
  const manifest = opts && 'manifest' in opts ? opts.manifest : MANIFEST;
  const stub = fakeBridge({
    ...bridge,
    onDescribe:
      opts?.deliverManifest === false ? () => {} : (h: (m: unknown) => void) => h(manifest),
  });
  const server = createMcpServer(stub as never, {
    toolMode: 'compact',
    ...(manifest ? { prefetchedManifest: manifest } : {}),
  } as never);
  const client = new Client({ name: 'req-1268-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, stub };
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result: any = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, `${name} returned a text block`).toBeDefined();
  return JSON.parse(textBlock!.text!);
}

// ───────────────────────────────────────────────────────────── AC-1 ──

describe('REQ-1268 AC-1 — compact mode publishes the wire shape in one cheap call', () => {
  it('figpea_describe is discoverable in tools/list, and registering it adds no contract tool', async () => {
    const { client } = await compactClient(fakeBridge({ isTabConnected: () => true }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    // Discoverable: an agent can SEE the tool, so it never has to guess a
    // selector argument (the failure D1 rejects).
    expect(names).toContain('figpea_describe');
    // Still exactly one dispatcher + the 4 baseline tools: no per-method
    // surface leaks into compact mode.
    expect(names.filter((n) => n.startsWith('layer_') || n.startsWith('session_'))).toEqual([]);
    // Zero new startup cost: the contract tools stay unregistered in compact
    // mode, so REQ-1018's toolCount === 0 pin cannot regress.
    const status = await callToolJson(client, 'status', {});
    expect(status.toolCount).toBe(0);
  });

  it('figpea_describe() with no selector returns the group index', async () => {
    const { client } = await compactClient(fakeBridge({ isTabConnected: () => true }));
    const payload = await callToolJson(client, 'figpea_describe', {});
    expect(payload.ok).toBe(true);
    expect(Object.keys(payload.groups ?? payload.group ?? {})).toEqual(expect.arrayContaining(['layer', 'session']));
  });

  it('figpea_describe({group:"layer", method:"batch"}) returns the positional rule and the {method,args} op example', async () => {
    const { client } = await compactClient(fakeBridge({ isTabConnected: () => true }));
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'batch' });
    expect(payload.ok).toBe(true);
    // The two rules the incident violated, learnable WITHOUT a probe call.
    expect(payload.doc).toContain('args must be array (positional), not an object');
    expect(payload.doc).toContain('{method:"create", args:["rect"');
    // And the declared param shape, so an agent can see ops is an array.
    expect(payload.params?.ops?.type).toBe('array');
  });

  it('figpea_describe({group:"layer"}) returns that group subtree; an unknown group fails with the known names', async () => {
    const { client } = await compactClient(fakeBridge({ isTabConnected: () => true }));
    const group = await callToolJson(client, 'figpea_describe', { group: 'layer' });
    expect(group.ok).toBe(true);
    expect(Object.keys(group.methods ?? group.group ?? {})).toEqual(expect.arrayContaining(['create', 'batch']));

    const miss = await callToolJson(client, 'figpea_describe', { group: 'nope' });
    expect(miss.ok).toBe(false);
    expect(miss.code).toBe('unknown_group');
    expect(miss.message).toContain('layer');
  });

  it('degrades like figpea_skill: no manifest → describe_unavailable naming both fallback routes, never a throw', async () => {
    const { client } = await compactClient(fakeBridge({ isTabConnected: () => true }), {
      manifest: undefined,
      deliverManifest: false,
    });
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'batch' });
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('describe_unavailable');
    expect(payload.message).toContain('session');
    expect(payload.message).toContain('contract.json');
  });

  it('the shape learned from describe is enough: the corrected payload then drives successfully', async () => {
    const captured: unknown[][] = [];
    const { client } = await compactClient(
      fakeBridge({
        isTabConnected: () => true,
        callTab: async (_g: string, _m: string, args: unknown[]) => {
          captured.push(args);
          return { ok: true, value: { results: [{ opIndex: 0, ok: true, value: { id: 'L1' } }] } };
        },
      }),
    );
    // 1) learn the shape (no round trip to the editor, no guessing)
    const doc = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'batch' });
    expect(doc.ok).toBe(true);
    // 2) call with the shape the doc teaches
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'batch', args: CORRECT_ARGS });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(Array.isArray(captured[0][0])).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────── AC-2 ──

describe('REQ-1268 AC-2 — the tool itself teaches the nested shape', () => {
  it('figpea_call description carries the verbatim working batch payload', async () => {
    const { client } = await compactClient(fakeBridge({ isTabConnected: () => true }));
    const { tools } = await client.listTools();
    const call = tools.find((t) => t.name === 'figpea_call');
    expect(call).toBeDefined();
    // The AC quotes this exact string; an agent must be able to copy it.
    expect(call!.description).toContain(
      '{"group":"layer","method":"batch","args":[[{"method":"create","args":["page",{"name":"probe","pageWidth":100,"pageHeight":100}]}]]}',
    );
    // …and the rule that generalises past one example.
    expect(call!.description).toMatch(/one element of `?args`?/i);
  });

  it('properties.args advertises array + the nested rule (schema hint only, parse unchanged)', async () => {
    const { client } = await compactClient(fakeBridge({ isTabConnected: () => true }));
    const { tools } = await client.listTools();
    const call = tools.find((t) => t.name === 'figpea_call')!;
    const schema: any = (call as any).inputSchema;
    expect(schema.properties.args.type).toBe('array');
    expect(schema.properties.args.description).toMatch(/one element of `?args`?/i);
  });
});

// ───────────────────────────────────────────────────────────── AC-3 ──

describe('REQ-1268 AC-3 — compact/full coercion parity', () => {
  it('stringified numbers inside a batch payload reach the tab as numbers', async () => {
    const captured: unknown[][] = [];
    const { client } = await compactClient(
      fakeBridge({
        isTabConnected: () => true,
        callTab: async (_g: string, _m: string, args: unknown[]) => {
          captured.push(args);
          return { ok: true, value: { results: [] } };
        },
      }),
    );
    // Correct envelope, harness-stringified numbers — the case AC-3 exists for.
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [[{ method: 'create', args: ['page', { name: 'probe', pageWidth: '100', pageHeight: '100' }] }]],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const ops = captured[0][0] as any[];
    const props = ops[0].args[1];
    expect(typeof props.pageWidth).toBe('number');
    expect(props.pageWidth).toBe(100);
    expect(typeof props.pageHeight).toBe('number');
    expect(props.pageHeight).toBe(100);
  });

  it('stringified numbers in a plain props object are coerced too', async () => {
    const captured: unknown[][] = [];
    const { client } = await compactClient(
      fakeBridge({
        isTabConnected: () => true,
        callTab: async (_g: string, _m: string, args: unknown[]) => {
          captured.push(args);
          return { ok: true, value: { id: 'L1' } };
        },
      }),
    );
    await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', { name: 'probe', pageWidth: '1500', pageHeight: '1050' }],
    });
    const props = captured[0][1] as any;
    expect(props.pageWidth).toBe(1500);
    expect(props.pageHeight).toBe(1050);
  });

  it('false-positive guards: a string value stays a string, and props keep their shape', async () => {
    const captured: unknown[][] = [];
    const { client } = await compactClient(
      fakeBridge({
        isTabConnected: () => true,
        callTab: async (_g: string, _m: string, args: unknown[]) => {
          captured.push(args);
          return { ok: true, value: { id: 'L1' } };
        },
      }),
    );
    await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      // `text` is declared string, and `name` is a string: neither may be
      // coerced into a number just because it looks numeric.
      args: ['text', { name: '1000', text: '1000', item: 'not-an-array' }],
    });
    const props = captured[0][1] as any;
    expect(props.name).toBe('1000');
    expect(props.text).toBe('1000');
    expect(props.item).toBe('not-an-array');
  });
});

// ───────────────────────────────────────────────────────────── AC-5 ──

describe('REQ-1268 AC-5 — the incident payload costs zero round trips and gets an actionable error', () => {
  it('replays the exact incident payload: bridge is NEVER called, and the error names the expected shape', async () => {
    let called = 0;
    const { client } = await compactClient(
      fakeBridge({
        isTabConnected: () => true,
        callTab: async () => {
          called += 1;
          return { ok: true, value: null };
        },
      }),
    );
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: INCIDENT_ARGS,
    });

    // A mangled payload is detectable before the tab is ever asked.
    expect(called).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    const message: string = result.message;
    // (1) which position is wrong…
    expect(message).toMatch(/args\[0\]/);
    // (2) …what it should have been, spelled out for this method…
    expect(message).toContain('[[{');
    expect(message).toMatch(/array/i);
    // (3) …and how to go and learn it.
    expect(message).toContain('figpea_describe');
  });

  it('detects, never repairs: a legitimate object at an object position is forwarded untouched', async () => {
    const captured: unknown[][] = [];
    const { client } = await compactClient(
      fakeBridge({
        isTabConnected: () => true,
        callTab: async (_g: string, _m: string, args: unknown[]) => {
          captured.push(args);
          return { ok: true, value: { id: 'L1' } };
        },
      }),
    );
    // `props` is declared `object`, so a single-key object — even one keyed
    // `item`, which is what the harness collapse looks like — is a legal value
    // here. Flagging it would steal a round trip on a call the editor handles,
    // and unwrapping it would silently reinterpret the payload. (This is the
    // deliberate narrowing of argShape.ts's Rule B: it fires only where the
    // schema declares an array/matrix.)
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['rect', { item: { nested: true } }],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect((captured[0][1] as any).item).toEqual({ nested: true });
  });

  it('a tab-returned invalid_params with no shape hint gets one appended', async () => {
    const { client } = await compactClient(
      fakeBridge({
        isTabConnected: () => true,
        callTab: async () => ({ ok: false, code: 'invalid_params', message: 'batch(): ops must be array (got object)' }),
      }),
    );
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: CORRECT_ARGS,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('figpea_describe');
  });
});
