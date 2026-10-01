import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { findArgShapeMismatch } from './argShape';
import type { ManifestLike } from './tools';

/**
 * REQ-1318 — a structured parameter may travel as a JSON string, and the
 * server says so everywhere the agent already looks.
 *
 * The spec here is the AC text, not this repo's implementation. What the
 * requirement states, stated independently of any code here:
 *
 *  - AC-1  a parameter whose declared schema is `object`/`array`/`matrix` may
 *          be sent as a JSON string with NO flag; the tab receives a real,
 *          complete, correctly ordered value in ONE round trip, deep-equal to
 *          what the array/object form delivers, and the result is identical.
 *          Proven for `array` (`ops`), `matrix` (`transform`) and an array of
 *          objects (`points`) — the rule is the schema's types, not one
 *          parameter's name. Compact and full mode deliver deep-equal args.
 *  - AC-2  the card's named instance: a stringified `props` carries
 *          `style.dashArray` through as a real array of two real NUMBERS.
 *  - AC-3  nothing that works today changes. A real object/array, a real
 *          number, a JSON-looking string at a `string`-declared position, a
 *          call with no manifest, a call against a legacy free-text manifest —
 *          all forwarded exactly as sent, all returning the tab's result.
 *  - AC-4  a problem is a SOLVABLE error at ZERO round trips: the
 *          `{"item": …}` envelope hint names the escape hatch, and a
 *          JSON-looking string at a structured position that the escape hatch
 *          could not rescue is refused before the round trip, naming both
 *          routes and `figpea_describe`.
 *  - AC-5  the deliberate no-unwrap decision is not quietly reversed.
 *  - AC-6  `_rawJson` still works on both lanes, and REQ-1280 AC-5's
 *          "opt-in only" pin is superseded — the same payload now succeeds
 *          without the flag — with its two assertions replaced in place.
 *  - AC-7  the escape hatch is discoverable: `tools/list`, `figpea_describe`,
 *          the README, and the contract is untouched.
 *
 * Harness: a real MCP SDK `Client` over `InMemoryTransport` around a real
 * `createMcpServer`, with `callTab` stubbed and COUNTED. The stub is not
 * neutral — it applies v3's real `validateArgs` rejection and echoes what it
 * received, so "the tab received a real object" can never be satisfied by a
 * stub that ignores its input, and the round trip a bad payload costs is
 * counted rather than timed.
 *
 * **Both lanes are asserted for every behaviour.** Compact `figpea_call` is
 * the default mode; full mode's per-tool surface is what real MCP clients use.
 *
 * The pure rows import the module under construction DYNAMICALLY, so this file
 * loads on the unfixed tree and the rows that describe behaviour that already
 * works (`(c)`, `(e)`) are observably GREEN on arrival. That is the evidence
 * they are regression pins rather than new behaviour — a static import of a
 * function that does not exist yet would turn the whole file red and destroy
 * exactly the signal the red run has to carry.
 */

/* ------------------------------------------------------------------ *
 * The manifest — real declarations, transcribed, not invented.
 * Every schema here is what `v3` publishes: `ops` is an array of
 * `{method, args}` ops, `create`'s `props` is an object whose shape carries
 * `style.dashArray` (array of number) and `transform` (matrix), `setTransform`
 * takes a `matrix`, `setName` takes a `string`. Transcribed rather than
 * imported because `figpea-mcp` is a standalone package that must build with
 * no sibling `v3/` checkout.
 * ------------------------------------------------------------------ */

const MANIFEST = {
  layer: {
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'line', 'polygon', 'text'] },
        props: {
          type: 'object',
          required: false,
          shape: {
            parentId: { type: 'string', required: false },
            name: { type: 'string', required: false },
            x: { type: 'number', required: false },
            y: { type: 'number', required: false },
            x2: { type: 'number', required: false },
            y2: { type: 'number', required: false },
            text: { type: 'string', required: false },
            pageWidth: { type: 'number', required: false },
            pageHeight: { type: 'number', required: false },
            // v3 declares this a MATRIX inside props (createSchema.ts).
            transform: { type: 'matrix', required: false },
            // …and this an array of {x,y} (createSchema.ts:149-155).
            points: {
              type: 'array',
              required: false,
              of: { type: 'object', required: true, shape: { x: { type: 'number', required: true }, y: { type: 'number', required: true } } },
            },
            style: {
              type: 'object',
              required: false,
              shape: {
                strokeWidth: { type: 'number', required: false },
                dashArray: { type: 'array', required: false, of: { type: 'number', required: true } },
              },
            },
          },
        },
      },
      result: { id: 'string' },
    },
    batch: {
      doc: 'Applies a sequence of layer ops as ONE undo step.',
      params: {
        ops: {
          type: 'array',
          required: true,
          of: {
            type: 'object',
            required: true,
            shape: { method: { type: 'string', required: true }, args: { type: 'array', required: true } },
          },
        },
      },
      result: { results: 'OpResult[]' },
    },
    setTransform: {
      doc: 'Sets a layer transform matrix.',
      params: { id: { type: 'string', required: true }, matrix: { type: 'matrix', required: true } },
      result: 'void',
    },
    setName: {
      doc: 'Renames a layer or page by id.',
      params: { id: { type: 'string', required: true }, name: { type: 'string', required: true } },
      result: 'void',
    },
  },
  session: {
    describe: {
      doc: 'Returns the agent contract surface.',
      params: {},
      result: {},
    },
  },
} as unknown as ManifestLike;

/** A pre-REQ-093 manifest: `params` values are free-text hints, so no param
 *  has a structured schema and the server has no declaration to reason from. */
const LEGACY_MANIFEST = {
  layer: {
    create: {
      doc: 'Creates a layer of the given kind.',
      params: { kind: 'a string: page, rect, line, polygon or text', props: 'an object with pageWidth, pageHeight and name' },
      result: 'the new layer id',
    },
  },
} as unknown as ManifestLike;

/* ------------------------------------------------------------------ *
 * The stub tab — v3's real answer, not a plausible one.
 * ------------------------------------------------------------------ */

/** v3's `receivedTypeName` (validateArgs.ts:35-45). */
function receivedTypeName(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/** v3's `matchesDeclaredType` (validateArgs.ts:48-70) for the top-level types
 *  this fixture declares. */
function matchesDeclaredType(declared: string, v: unknown): boolean {
  switch (declared) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array':
    case 'matrix':
      return Array.isArray(v);
    default:
      return true;
  }
}

/** The fixture's declared positional types, keyed by the BARE method name —
 *  `callTab(group, method, args)` receives `method` unprefixed on both lanes. */
const DECLARED: Record<string, Record<string, string>> = {
  create: { kind: 'string', props: 'object' },
  batch: { ops: 'array' },
  setName: { id: 'string', name: 'string' },
  setTransform: { id: 'string', matrix: 'matrix' },
};

/** v3's `validateArgs`: the FIRST positional argument that does not match its
 *  declared type is rejected — which is the whole bug this REQ is about. */
function editorRejection(method: string, args: unknown[]): { ok: false; code: string; message: string } | undefined {
  const declared = DECLARED[method];
  if (!declared) return undefined;
  const keys = Object.keys(declared);
  for (let i = 0; i < args.length; i++) {
    const key = keys[i];
    if (key === undefined) break;
    const arg = args[i];
    if (arg === undefined) continue;
    if (!matchesDeclaredType(declared[key]!, arg)) {
      return {
        ok: false,
        code: 'invalid_params',
        message: `${method}(): ${key} must be ${declared[key]} (got ${receivedTypeName(arg)})`,
      };
    }
  }
  return undefined;
}

/** A successful editor answer that ECHOES what it was given, so "the tab
 *  received a real object" is never satisfiable by a stub ignoring its input. */
function editorSuccess(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'create': {
      const props = (args[1] ?? {}) as Record<string, unknown>;
      return { id: 'L_probe', kind: args[0], props };
    }
    case 'batch': {
      const ops = args[0] as Array<{ method: string }>;
      return { results: ops.map((op, i) => ({ opIndex: i, ok: true, value: { id: `L_${op.method}_${i}` } })) };
    }
    case 'setTransform':
      return { id: args[0], matrix: args[1] };
    case 'setName':
      return { id: args[0], name: args[1] };
    default:
      return null;
  }
}

interface Capture {
  group: string;
  method: string;
  args: unknown[];
}

function makeStub(opts?: { deliverManifest?: unknown }) {
  const captured: Capture[] = [];
  const deliver = 'deliverManifest' in (opts ?? {}) ? opts!.deliverManifest : MANIFEST;
  const stub = {
    port: 54395,
    token: 'test-token-1318',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      if (deliver !== undefined) h(deliver);
    },
    callTab: async (group: string, method: string, args: unknown[]) => {
      captured.push({ group, method, args: structuredClone(args) });
      return editorRejection(method, args) ?? { ok: true, value: editorSuccess(method, args) };
    },
    close: async () => {},
  };
  return { stub, captured };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

type Mode = 'compact' | 'full';

async function connect(bridge: unknown, mode: Mode, opts?: { prefetchedManifest?: unknown }) {
  const server = createMcpServer(
    bridge as never,
    { toolMode: mode, ...(opts && 'prefetchedManifest' in opts ? { prefetchedManifest: opts.prefetchedManifest } : {}) } as never,
  );
  const client = new Client({ name: 'req-1318-test', version: '0.0.0' });
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
  const text = textBlock!.text ?? '';
  if (!text.trimStart().startsWith('{')) {
    // A handler that throws reaches the client as plain text; surface it as an
    // envelope so the failure reads as the defect, not a JSON parse error here.
    return { ok: false, code: 'non_envelope', message: text };
  }
  return JSON.parse(text);
}

/** True if `key` appears as an own key anywhere in the payload, at any depth. */
function hasKeyAtAnyDepth(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((el) => hasKeyAtAnyDepth(el, key));
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(rec, key)) return true;
    return Object.values(rec).some((v) => hasKeyAtAnyDepth(v, key));
  }
  return false;
}

/** The dynamic import of the module under construction. Called only from the
 *  rows that are RED until it exists, so this file still LOADS without it —
 *  which is what keeps `(c)`/`(e)` observably green on the unfixed tree. */
async function structured(): Promise<typeof import('./rawJson')> {
  return import('./rawJson');
}

// ── the payloads, spelled once ───────────────────────────────────────────────

const OPS = [
  { method: 'create', args: ['page', { name: 'p1', pageWidth: 300, pageHeight: 200 }] },
  { method: 'create', args: ['rect', { parentId: 'P1', rwidth: 100, rheight: 50 }] },
  { method: 'setName', args: ['L_rect', 'hero'] },
];

/** The card's second measured repro, verbatim: the host collapsed `dashArray`,
 *  so the agent moves the WHOLE `props` to a scalar. */
const DASH_ARRAY_PROPS = { x: 0, y: 0, style: { dashArray: [4, 4] }, strokeWidth: 2 };

/** The REQ-1268 incident payload, byte-for-byte from its own fixture. */
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

// ───────────────────────────────────────────────────────────── AC-1 ──

describe('REQ-1318 AC-1 — a structured parameter may travel as a JSON string, with no flag', () => {
  it('ops as a string: the whole batch arrives whole, ordered, in ONE round trip, and the result matches the array form', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [JSON.stringify(OPS)],
    });
    expect(result.ok).toBe(true);
    // ONE callTab — the batch is atomic only if the complete ops array reaches
    // the tab in a single call. This is the round trip the card is about.
    expect(captured).toHaveLength(1);
    const received = captured[0]!.args[0];
    expect(Array.isArray(received)).toBe(true);
    const list = received as Array<{ method: string; args: unknown[] }>;
    // Complete and in order: nothing dropped, reordered or stringified.
    expect(list).toHaveLength(OPS.length);
    expect(list.map((op) => op.method)).toEqual(['create', 'create', 'setName']);
    for (const op of list) {
      expect(typeof op.method).toBe('string');
      expect(Array.isArray(op.args)).toBe(true);
    }
    expect(list[1]!.args[1]).toEqual({ parentId: 'P1', rwidth: 100, rheight: 50 });
    // The tab applied all three, in order.
    expect(result.value.results).toHaveLength(3);
    expect(result.value.results.map((r: any) => r.opIndex)).toEqual([0, 1, 2]);
  });

  it('the string form is DEEP-EQUAL to the array form — the payload, and the result', async () => {
    const asArray = makeStub();
    const viaArray = await callToolJson(await connect(asArray.stub, 'compact'), 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [OPS],
    });
    const asString = makeStub();
    const viaString = await callToolJson(await connect(asString.stub, 'compact'), 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [JSON.stringify(OPS)],
    });
    expect(viaArray.ok).toBe(true);
    expect(viaString.ok).toBe(true);
    expect(asString.captured).toHaveLength(1);
    expect(asString.captured[0]!.args).toEqual(asArray.captured[0]!.args);
    expect(viaString.value).toEqual(viaArray.value);
  });

  it('a matrix-declared param travels as a string: setTransform("[1,0,0,1,0,0]")', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setTransform',
      args: ['L1', '[1,0,0,1,0,0]'],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args).toEqual(['L1', [1, 0, 0, 1, 0, 0]]);
    // Read back by the tab: a real six-number matrix, not a string.
    expect(result.value.matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('an array-of-objects param travels inside a stringified object: polygon.points', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const points = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['polygon', JSON.stringify({ points })],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toEqual({ points });
    // The rule is the schema's `array` type, not one parameter's name.
    expect(Array.isArray((captured[0]!.args[1] as any).points)).toBe(true);
  });

  it('a matrix nested inside a stringified object also survives', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['rect', '{"parentId":"P1","rwidth":100,"rheight":50,"transform":[1,0,0,1,0,0]}'],
    });
    expect(captured).toHaveLength(1);
    const props = captured[0]!.args[1] as any;
    expect(props.parentId).toBe('P1');
    expect(props.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(props.transform.every((n: unknown) => typeof n === 'number')).toBe(true);
  });

  it('compact and full mode deliver DEEP-EQUAL args for the same stringified payload', async () => {
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [JSON.stringify(OPS)],
    });
    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_batch', { ops: JSON.stringify(OPS) });

    expect(compactResult.ok).toBe(true);
    expect(fullResult.ok).toBe(true);
    expect(compactRun.captured).toHaveLength(1);
    expect(fullRun.captured).toHaveLength(1);
    // The same rule, two calling conventions — the drift AC-7 exists to prevent.
    expect(fullRun.captured[0]!.args).toEqual(compactRun.captured[0]!.args);
    expect(fullResult.value).toEqual(compactResult.value);
  });

  it('the flag-less route still needs only ONE round trip for a whole batch', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'batch', args: [JSON.stringify(OPS)] });
    // Counted, not implied: without the parse this call reaches the tab as a
    // string and the tab rejects it, so `ok` is what makes the count mean
    // something. One call either way — the difference is what arrived.
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────── AC-2 ──

describe('REQ-1318 AC-2 — the card\'s named instance: style.dashArray', () => {
  it('a stringified props delivers dashArray as a real 2-number array, asserted on the CAPTURED arg', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', JSON.stringify(DASH_ARRAY_PROPS)],
    });
    expect(result.ok).toBe(true);
    // Asserted on what the TAB received, not on the result: a stub that
    // ignored its input could not satisfy this.
    expect(captured).toHaveLength(1);
    const props = captured[0]!.args[1] as any;
    expect(typeof props).toBe('object');
    expect(Array.isArray(props)).toBe(false);
    expect(Array.isArray(props.style.dashArray)).toBe(true);
    expect(props.style.dashArray).toHaveLength(2);
    expect(props.style.dashArray.every((n: unknown) => typeof n === 'number')).toBe(true);
    // The value nested inside the object survives the string transport — the
    // whole point of moving `props` to a scalar rather than only `dashArray`.
    expect(props.strokeWidth).toBe(2);
    expect(props).toEqual(DASH_ARRAY_PROPS);
  });

  it('the stringified props form is DEEP-EQUAL to the object form', async () => {
    const asObject = makeStub();
    const viaObject = await callToolJson(await connect(asObject.stub, 'compact'), 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', DASH_ARRAY_PROPS],
    });
    const asString = makeStub();
    const viaString = await callToolJson(await connect(asString.stub, 'compact'), 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', JSON.stringify(DASH_ARRAY_PROPS)],
    });
    expect(viaObject.ok).toBe(true);
    expect(viaString.ok).toBe(true);
    expect(asString.captured[0]!.args).toEqual(asObject.captured[0]!.args);
    expect(viaString.value).toEqual(viaObject.value);
  });

  it('the parse happens BEFORE coercion, so string numerics inside the parsed object become real numbers', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', '{"x":0,"y":0,"style":{"strokeWidth":"2"},"transform":[1,0,0,1,0,0]}'],
    });
    expect(captured).toHaveLength(1);
    const props = captured[0]!.args[1] as any;
    // Order is load-bearing: parsed first, then coerced. A route that parsed
    // after `coerceValue` would hand the tab the string "2".
    expect(typeof props.style.strokeWidth).toBe('number');
    expect(props.style.strokeWidth).toBe(2);
  });

  it('the same payload on the full lane, deep-equal to compact', async () => {
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', JSON.stringify(DASH_ARRAY_PROPS)],
    });
    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_create', {
      kind: 'line',
      props: JSON.stringify(DASH_ARRAY_PROPS),
    });
    expect(compactResult.ok).toBe(true);
    expect(fullResult.ok).toBe(true);
    expect(fullRun.captured[0]!.args).toEqual(compactRun.captured[0]!.args);
  });
});

// ───────────────────────────────────────────────────────────── AC-3 ──

describe('REQ-1318 AC-3 — nothing that works today changes', () => {
  it('a real props object and a real ops array are forwarded byte-for-byte', async () => {
    const props = { name: 'probe', pageWidth: 300, pageHeight: 200, style: { dashArray: [4, 4] } };
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const created = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'create', args: ['page', props] });
    expect(created.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args).toEqual(['page', props]);

    const batchRun = makeStub();
    const batchClient = await connect(batchRun.stub, 'compact');
    const batched = await callToolJson(batchClient, 'figpea_call', { group: 'layer', method: 'batch', args: [OPS] });
    expect(batched.ok).toBe(true);
    expect(batchRun.captured[0]!.args[0]).toEqual(OPS);
  });

  it('a number-shaped string where a number is declared is still coerced, and the result is the tab\'s', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', { name: 'probe', pageWidth: '1500', pageHeight: '1050' }],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toEqual({ name: 'probe', pageWidth: 1500, pageHeight: 1050 });
  });

  it('a JSON-looking string at a string-declared position is NEVER parsed: "[Hero]" arrives as sent', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', '[Hero]'],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    // The gate is the DECLARED SCHEMA, not the value: `name` is a string, so
    // this is a name and is forwarded as the six characters it is.
    expect(captured[0]!.args).toEqual(['L1', '[Hero]']);
    expect(typeof captured[0]!.args[1]).toBe('string');
  });

  it('a valid JSON literal at a string-declared position is also left alone: "[1,2,3]"', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setName',
      args: ['L1', '[1,2,3]'],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    // This is the row that separates this REQ's schema-scoped default from
    // REQ-1280's opt-in `_rawJson` flag. A string-position name that happens to
    // be valid JSON must survive intact — and as of REQ-1338 that is true of
    // the flag too, wherever the manifest declares the position. What still
    // distinguishes the two routes is the OTHER direction: with no declaration
    // in memory this route touches nothing, while the flag still parses,
    // because there is nothing to scope a parse to.
    expect(captured[0]!.args).toEqual(['L1', '[1,2,3]']);
  });

  it('with NO manifest in memory the route takes no opinion and the call forwards as today', async () => {
    const { stub, captured } = makeStub({ deliverManifest: undefined });
    const client = await connect(stub, 'compact', { prefetchedManifest: undefined });
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
    });
    // The published-npm standalone case: with no declaration there is nothing
    // to say the value SHOULD have been structured, so the server declines to
    // guess and the call reaches the tab exactly as the agent sent it.
    expect(result.ok).toBe(false);
    expect(result.message).toContain('props must be object (got string)');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toBe('{"name":"probe","pageWidth":300,"pageHeight":200}');
  });

  it('a legacy free-text manifest (no structured params) forwards too', async () => {
    const { stub, captured } = makeStub({ deliverManifest: LEGACY_MANIFEST });
    const client = await connect(stub, 'compact', { prefetchedManifest: LEGACY_MANIFEST });
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toBe('{"name":"probe","pageWidth":300,"pageHeight":200}');
    // Byte-identical to the no-manifest case: no schema ⇒ no opinion.
    expect(result.message).toContain('props must be object (got string)');
  });

  it('the escape hatch itself rejects nothing: a valid stringified payload needs no schema to be accepted', async () => {
    // …and the converse: when the declaration IS present, the same payload is
    // now accepted, so the difference above is the declaration, nothing else.
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toEqual({ name: 'probe', pageWidth: 300, pageHeight: 200 });
  });

  it('pure: the same container identity comes back when nothing parsed', async () => {
    const { applyStructuredStringJson } = await structured();
    const args = ['L1', '[Hero]', { a: 1 }];
    const applied = applyStructuredStringJson(args, {
      schemaAt: (i) => (i === 1 ? ({ type: 'string', required: true } as never) : undefined),
      pathAt: (i) => `args[${i}]`,
    });
    // The common path allocates nothing, so a caller never has to reason about
    // a fresh copy — the same guarantee `applyRawJson` makes.
    expect(applied.value).toBe(args);
  });

  it('pure: only object/array/matrix positions are EVER parsed — the type table', async () => {
    const { applyStructuredStringJson } = await structured();
    // The safety claim, as a table rather than as prose: for every declared
    // type this package knows, a JSON-looking string is parsed exactly when the
    // declaration expects a structured value.
    const table: Array<{ type: string | undefined; payload: string; parsed: unknown }> = [
      { type: 'string', payload: '[Hero]', parsed: undefined },
      { type: 'string', payload: '{"a":1}', parsed: undefined },
      { type: 'number', payload: '[1,2,3]', parsed: undefined },
      { type: 'boolean', payload: '[true]', parsed: undefined },
      { type: 'object', payload: '{"a":1}', parsed: { a: 1 } },
      { type: 'array', payload: '[1,2,3]', parsed: [1, 2, 3] },
      { type: 'matrix', payload: '[1,0,0,1,0,0]', parsed: [1, 0, 0, 1, 0, 0] },
      // No schema at all (legacy free-text / no manifest) ⇒ never parsed.
      { type: undefined, payload: '{"a":1}', parsed: undefined },
    ];
    for (const row of table) {
      const applied = applyStructuredStringJson([row.payload], {
        schemaAt: () => (row.type === undefined ? undefined : ({ type: row.type, required: true } as never)),
        pathAt: () => 'args[0]',
      });
      if (row.parsed === undefined) {
        // Not parsed: the value is the string exactly as the agent sent it.
        expect(applied.value[0], `declared type ${String(row.type)} is never parsed`).toBe(row.payload);
      } else {
        expect(applied.value[0], `declared type ${String(row.type)} is parsed`).toEqual(row.parsed);
      }
    }
  });

  it('pure: a string that parses to the WRONG shape is left exactly as sent', async () => {
    const { applyStructuredStringJson } = await structured();
    const wrongAtObject = applyStructuredStringJson(['[1,2,3]'], {
      schemaAt: () => ({ type: 'object', required: true } as never),
      pathAt: () => 'args[0]',
    });
    expect(wrongAtObject.value[0]).toBe('[1,2,3]');
    const wrongAtArray = applyStructuredStringJson(['{"a":1}'], {
      schemaAt: () => ({ type: 'array', required: true } as never),
      pathAt: () => 'args[0]',
    });
    expect(wrongAtArray.value[0]).toBe('{"a":1}');
  });

  it('pure: a RECORD container works too (full mode\'s shape), and keeps its kind', async () => {
    const { applyStructuredStringJson } = await structured();
    const record = { id: 'L1', matrix: '[1,0,0,1,0,0]' };
    const applied = applyStructuredStringJson(record, {
      keys: ['id', 'matrix'],
      schemaAt: (i) => (i === 1 ? ({ type: 'matrix', required: true } as never) : undefined),
      pathAt: (i) => ['id', 'matrix'][i]!,
    });
    expect(applied.value).toEqual({ id: 'L1', matrix: [1, 0, 0, 1, 0, 0] });
    expect(Array.isArray(applied.value)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────── AC-4 ──

describe('REQ-1318 AC-4 — a problem is a solvable error at zero round trips', () => {
  it('the {"item": …} envelope hint names the escape hatch, with a worked payload', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'batch', args: INCIDENT_ARGS });
    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(0);
    const message: string = result.message;
    // REQ-1268's three points must all survive…
    expect(message).toMatch(/args\[0\]/);
    expect(message).toMatch(/array/i);
    expect(message).toContain('figpea_describe');
    // …and the hint now ends with the route that survives a collapsing host:
    // a scalar. A string is a scalar, which is why it cannot be collapsed.
    expect(message, 'the hint names the JSON-string route').toMatch(/JSON string/i);
    expect(message, 'the hint says why a string is the safe carrier').toMatch(/scalar/i);
    // The payload is asserted in the spelling a JSON string value actually
    // needs — `[{\"method\":\"create\",…}]` — because that is the form an agent
    // must send. Asserting the unescaped form instead would pin a spelling the
    // hint has no reason to use, and would read as "paste this raw" when the
    // quotes still have to be escaped to be a string.
    expect(message, 'the hint carries a payload to copy').toContain('[{\\"method\\":\\"create\\"');
    // …and the call that teaches the shape, so the hint is not a dead end even
    // when the agent does not know the escape hatch exists.
    expect(message).toContain('figpea_describe');
  });

  it('a MALFORMED JSON string at a structured position is refused BEFORE the round trip', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const malformed = '{"x":0,"style":{"dashArray":[4,4]}'; // truncated
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', malformed],
    });
    expect(result.ok).toBe(false);
    // Today this costs a full round trip and returns the editor's bare
    // `props must be object (got string)`, naming neither remedy.
    expect(captured).toHaveLength(0);
    const message: string = result.message;
    expect(message, 'the position is named').toMatch(/args\[1\]/);
    expect(message, 'both routes are named').toMatch(/JSON string/i);
    expect(message, 'the other route is named too').toMatch(/real object|object itself|send a real/i);
    expect(message, 'and the call that teaches the shape').toContain('figpea_describe');
  });

  it('a SHAPE-MISMATCHED string at a structured position is refused before the round trip', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    // Valid JSON that parses, but to the wrong kind for an `object` position.
    // The escape hatch cannot rescue it, so the pre-flight must name the fix.
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', '[1,2,3]'],
    });
    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(0);
    const message: string = result.message;
    expect(message).toMatch(/args\[1\]/);
    expect(message).toMatch(/object/i);
    expect(message).toMatch(/JSON string/i);
    expect(message).toContain('figpea_describe');
  });

  it('the refusal names the offending value, so it is fixable blind', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', '{name: "probe"}'],
    });
    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(0);
    expect(result.message).toContain('{name: "probe"}');
  });

  it('narrow guard: a plain non-JSON string at a structured position is NOT pre-flighted', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    // The negative the guard's narrowness buys. Refusing ANY string at a
    // structured position would be a NEW pre-flight rejection class with a
    // false-rejection risk the editor does not have — so this defers to the
    // tab, exactly as today, and the tab's own answer is relayed.
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', 'not json at all'],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toBe('not json at all');
    expect(result.message).toContain('props must be object (got string)');
  });

  it('pure: findArgShapeMismatch fires on a JSON-looking string at a structured position', () => {
    // The pure rule, called directly — the `argShape.ts` precedent (REQ-1268 T5).
    const declaredArray = { type: 'array', required: true, of: { type: 'object', required: true, shape: {} } } as never;
    const found = findArgShapeMismatch('[1,2,3]', declaredArray, 'args[0]');
    expect(found, 'a JSON-looking string at an array position is a mismatch').toBeDefined();
    expect(found!.path).toBe('args[0]');
    expect(found!.expected).toMatch(/array/i);
    // Both routes, so the error is solvable.
    expect(found!.hint).toMatch(/JSON string/i);
  });

  it('pure: it does NOT fire on a plain string, nor on a string at a scalar position', () => {
    expect(findArgShapeMismatch('not json', { type: 'object', required: true } as never, 'args[1]')).toBeUndefined();
    expect(findArgShapeMismatch('[Hero]', { type: 'string', required: true } as never, 'args[1]')).toBeUndefined();
    expect(findArgShapeMismatch('[1,2,3]', { type: 'number', required: true } as never, 'args[1]')).toBeUndefined();
  });

  it('pure: a real object/array at a structured position is still not a mismatch', () => {
    expect(findArgShapeMismatch({ a: 1 }, { type: 'object', required: true } as never, 'args[1]')).toBeUndefined();
    expect(findArgShapeMismatch([1, 2, 3], { type: 'array', required: true } as never, 'args[0]')).toBeUndefined();
  });

  it('pure: the rule composes with the recursion and stays inside the shared budget', () => {
    // Nested deep inside a real array: found at the nested path, and the
    // budget is the one `argShape.ts` already shares with the other rules.
    const ops = [{ method: 'create', args: ['page', '{"name":"probe"}'] }];
    const schema = {
      type: 'array',
      required: true,
      of: {
        type: 'object',
        required: true,
        shape: {
          method: { type: 'string', required: true },
          args: { type: 'array', required: true, of: { type: 'string', required: true } },
        },
      },
    } as never;
    // The nested `args[1]` inside an op is a string at a `string` position, so
    // there is nothing to report — the guard is narrow by construction.
    expect(findArgShapeMismatch(ops, schema, 'args[0]')).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────── AC-5 ──

describe('REQ-1318 AC-5 — the deliberate no-unwrap decision is not quietly reversed', () => {
  it('the exact REQ-1268 incident payload is still refused at ZERO round trips', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'batch', args: INCIDENT_ARGS });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    expect(captured).toHaveLength(0);
  });

  it('nothing anywhere converts {"item": X} to X, at any depth, on either lane', async () => {
    // A legitimate single-key object at an OBJECT position — including one
    // keyed `item`, which is what the harness collapse looks like. Flagging it
    // would steal a round trip on a call the editor handles; unwrapping it
    // would silently reinterpret the payload. The tab must see it untouched.
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['rect', { item: { nested: true } }],
    });
    expect(compactResult.ok).toBe(true);
    expect(compactRun.captured[0]!.args[1]).toEqual({ item: { nested: true } });

    // And an `item` key nested deep inside a real, accepted batch payload:
    // nothing walks the payload looking for an envelope to unwrap.
    const deepOps = [{ method: 'setName', args: ['L1', 'x'] }, { method: 'create', args: ['rect', { item: { keep: 'me' } }] }];
    const batchRun = makeStub();
    const batchClient = await connect(batchRun.stub, 'compact');
    const batchResult = await callToolJson(batchClient, 'figpea_call', { group: 'layer', method: 'batch', args: [deepOps] });
    expect(batchResult.ok).toBe(true);
    expect(batchRun.captured).toHaveLength(1);
    const forwarded = batchRun.captured[0]!.args[0] as Array<{ args: unknown[] }>;
    expect((forwarded[1]!.args[1] as any).item).toEqual({ keep: 'me' });
    expect(hasKeyAtAnyDepth(forwarded, 'item')).toBe(true);
  });

  it('an envelope is never REPAIRED in full mode either', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const result = await callToolJson(client, 'layer_batch', { ops: INCIDENT_ARGS[0] });
    // The editor is what refuses an envelope in full mode (there is no
    // wire-shape pre-flight on that lane); what must never happen is the
    // server quietly handing the tab the unwrapped array instead.
    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(1);
    const ops = captured[0]!.args[0] as any;
    expect(Array.isArray(ops)).toBe(false);
    expect(ops.item).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────── AC-6 ──

describe('REQ-1318 AC-6 — _rawJson still works, and is no longer the only route', () => {
  it('_rawJson:true still parses, on the compact lane', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [JSON.stringify(OPS)],
      _rawJson: true,
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[0]).toEqual(OPS);
  });

  it('_rawJson never leaks into the forwarded args, and args.length is unchanged by it', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const withFlag = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe"}'],
      _rawJson: true,
    });
    expect(withFlag.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(hasKeyAtAnyDepth(captured[0]!.args, '_rawJson')).toBe(false);
    expect(captured[0]!.args).toHaveLength(2);
  });

  it('_rawJson:false is a no-op — and now the SAME call succeeds without any flag too', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const withFalse = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
      _rawJson: false,
    });
    const withoutFlag = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['page', '{"name":"probe","pageWidth":300,"pageHeight":200}'],
    });
    // The flag is NOT deprecated and NOT removed: absent and explicitly false
    // behave identically, and both now agree because the flag-less route works.
    expect(withFalse).toEqual(withoutFlag);
    expect(withoutFlag.ok).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.args[1]).toEqual(captured[1]!.args[1]);
  });

  it('the flagged loud-failure still refuses a broken string and names _rawJson', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['line', '{name: "probe"}'],
      _rawJson: true,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    expect(result.message).toContain('_rawJson');
    expect(captured).toHaveLength(0);
  });

  it('both lanes deliver deep-equal args for the same flagged payload', async () => {
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub, 'compact');
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [JSON.stringify(OPS)],
      _rawJson: true,
    });
    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_batch', { ops: JSON.stringify(OPS), _rawJson: true });
    expect(compactResult.ok).toBe(true);
    expect(fullResult.ok).toBe(true);
    expect(fullRun.captured[0]!.args).toEqual(compactRun.captured[0]!.args);
  });

  it('a string-declared position is untouched even WITH the flag absent, in full mode too', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const result = await callToolJson(client, 'layer_setName', { id: 'L1', name: '[Hero]' });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args).toEqual(['L1', '[Hero]']);
  });
});
// ───────────────────────────────────────────────────────────── AC-7 ──

describe('REQ-1318 AC-7 — the escape hatch is discoverable where the agent already looks', () => {
  it('tools/list advertises the escape hatch on figpea_call\'s args, in the half the SDK actually prefers', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const { tools } = await client.listTools();
    const call = tools.find((t) => t.name === 'figpea_call');
    expect(call).toBeDefined();
    const schema: any = (call as any).inputSchema;
    // Verify-then-pin: guidance only, ZERO new rejections — the advertised
    // type is still the array `z.array(z.any()).optional()` parses.
    expect(schema.properties.args.type).toBe('array');
    // The nested rule REQ-1268 shipped is still here — this is additive.
    expect(schema.properties.args.description).toMatch(/one element of `?args`?/i);
    // …and the escape hatch, with a payload an agent can copy.
    expect(schema.properties.args.description).toMatch(/JSON string/i);
    expect(schema.properties.args.description).toMatch(/"method":"create"/);
  });

  it('the sentence is carried in BOTH halves of the args field, so neither client loses it', async () => {
    // The SDK's zod→JSON Schema conversion takes `meta` in preference to
    // `.describe()` (mcpServer.ts records the verified evidence), so the
    // REQ-1268 rule is carried in both. The escape hatch must be too — and
    // this is the pin that fails if a later edit drops either half.
    const src = readFileSync(join(__dirname, 'mcpServer.ts'), 'utf8');
    const start = src.indexOf('args: z');
    expect(start, 'the args field is still declared with .describe()/.meta()').toBeGreaterThan(-1);
    const end = src.indexOf('_timeoutMs: z', start);
    const field = src.slice(start, end > start ? end : src.length);
    expect(field).toMatch(/\.describe\(/);
    expect(field).toMatch(/\.meta\(/);
    // Once per half: `.describe()` and `.meta()`.
    expect((field.match(/JSON string/g) ?? []).length).toBe(2);
  });

  it('figpea_describe reports the method\'s own string-capable params, and omits the key when there are none', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const batch = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'batch' });
    expect(batch.ok).toBe(true);
    expect(batch.stringJsonParams).toEqual(['ops']);

    const create = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'create' });
    expect(create.stringJsonParams).toEqual(['props']);

    // A method with no structured param omits the key rather than sending [].
    const none = await callToolJson(client, 'figpea_describe', { group: 'session', method: 'describe' });
    expect(none.ok).toBe(true);
    expect(none.stringJsonParams).toBeUndefined();
  });

  it('figpea_describe omits the key for a legacy free-text params manifest', async () => {
    const { stub } = makeStub({ deliverManifest: LEGACY_MANIFEST });
    const client = await connect(stub, 'compact', { prefetchedManifest: LEGACY_MANIFEST });
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'create' });
    expect(payload.ok).toBe(true);
    // Nothing structured to derive from ⇒ no opinion ⇒ no key.
    expect(payload.stringJsonParams).toBeUndefined();
  });

  it('the figpea_describe tool description names the key an agent reads', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const { tools } = await client.listTools();
    const describe = tools.find((t) => t.name === 'figpea_describe');
    expect(describe).toBeDefined();
    expect(describe!.description).toContain('stringJsonParams');
  });

  it('the derivation names NO method and NO param — it is derived, never enumerated', async () => {
    // REQ-1309's anti-enumeration technique: a hard-coded method or param list
    // is a drift generator the very next contract change has to come back and
    // edit. The helper is pure and manifest-driven, so this scans its body.
    const { structuredParamNames } = (await import('./mcpServer')) as unknown as {
      structuredParamNames: (d: unknown) => string[];
    };
    const src = readFileSync(join(__dirname, 'mcpServer.ts'), 'utf8');
    const start = src.indexOf('function structuredParamNames');
    expect(start, 'the derivation is one named, readable function').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).not.toMatch(/\b(batch|create|setName|setTransform|dashArray|points|ops|props|kind|matrix)\b/);
    // …and it is genuinely derived: a manifest this suite has never seen
    // yields its own structured params, with no edit anywhere.
    expect(
      structuredParamNames({
        params: {
          alpha: { type: 'array', required: true },
          beta: { type: 'string', required: true },
          gamma: { type: 'matrix', required: false },
          delta: { type: 'object', required: false },
          epsilon: { type: 'number', required: false },
        },
      }),
    ).toEqual(['alpha', 'gamma', 'delta']);
    // …and a descriptor with no params, or a legacy free-text one, yields none.
    expect(structuredParamNames({ params: {} })).toEqual([]);
    expect(structuredParamNames({ params: { props: 'an object' } })).toEqual([]);
    expect(structuredParamNames({})).toEqual([]);
  });

  it('the manifest\'s own doc/params/result are passed through untouched', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const payload = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'batch' });
    // This server does not restate the editor's documentation; the additive
    // key sits beside it rather than replacing anything.
    expect(payload.doc).toBe('Applies a sequence of layer ops as ONE undo step.');
    expect(payload.params.ops.type).toBe('array');
    expect(payload.result).toEqual({ results: 'OpResult[]' });
  });
});
