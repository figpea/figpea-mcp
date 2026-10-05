import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import type { ManifestLike } from './tools';

/**
 * REQ-1294 — the array-free route, proved FROM the host that collapses arrays.
 *
 * The spec here is the card's AC text, not this file's fixtures. What the card
 * states, independently of any code here:
 *
 *  - AC-1  From a host that collapses nested arrays,
 *          `figpea_call('layer','setTransform',['<id>',[1,0,0,1,48,110]])` delivers
 *          the matrix as `{"item":1}` and the call FAILS with `invalid_params`
 *          naming `args[1]` and "array of numbers"; and
 *          `figpea_call('layer','batch', …)` collapses the same way and is
 *          refused the same way. Both refused BEFORE any tab round trip.
 *  - AC-2  The SAME matrix is expressible in a form containing no nested array,
 *          and applies in ONE round trip with a real six-number array at the
 *          tab; and a 2-op batch (create a rect + setTransform) is issued
 *          ATOMICALLY in one array-free form, both ops landing in one callTab
 *          in order. Both verified from the collapsing host of AC-1.
 *  - AC-4  The `{"item": …}` detection and its error message are UNCHANGED: a
 *          host that collapses nested arrays is still told, never silently
 *          unwrapped, at depth, on either lane.
 *
 * ⛔ WHY THE HARNESS IS CAPTURED FIXTURES AND NOT A `collapse(v)` FUNCTION.
 * Every collapsed payload below is BYTE-EXACT evidence that exists in this
 * repository or in the card — none of it is a modelled collapse rule. Two
 * captures carry it:
 *
 *   • AC-1 itself, which states the matrix arrives as `{"item":1}` (fixture M).
 *   • REQ-1268's own fixture (`req1268.test.ts:91-103`), the doubly-collapsed
 *     `layer.batch` incident that was observed in a real design run
 *     (fixture B).
 *
 * AC-1's BATCH clause carries no captured bytes of its own — it says only "the
 * same for". Fixture C is therefore a stated COMPOSITION of B and M rather than
 * a third capture: B's envelope nesting verbatim, with AC-1's
 * `method:'setTransform'` op pair substituted in and M's collapsed matrix leaf
 * inside it. That composition is sound because the collapse acts on ARRAYS, and
 * every leaf differing between B and C is either a string (which a collapse
 * never touches) or the matrix, whose collapse IS capture M. B — a pure capture
 * — is the PRIMARY refusal row; C exists so AC-1's named `setTransform` batch
 * is exercised too, and no assertion rests on it alone.
 *
 * ⚠️ THE HOST-BOUNDARY ROW IS NOT A TAUTOLOGY. Both captures agree on the
 * load-bearing boundary: the top-level positional `args` array survives intact
 * and only values NESTED inside it are collapsed. Every fixture here is built
 * on that, so the boundary is asserted directly rather than assumed. If a future
 * capture ever shows the outer array collapsing too, that row fails — and it is
 * a finding, not a skip: `args` is `z.array(z.any()).optional()` in compact
 * mode, so a string there is rejected by the MCP SDK's own validation before any
 * handler runs, and no server-side change could rescue it.
 *
 * ⚠️ THE STUB TAB IS DELIBERATELY NOT NEUTRAL INSIDE A BATCH. It applies v3's
 * real `validateTransform` (`layer.impl.ts:1128-1130`: `Array.isArray` + length
 * 6 + every finite) to EVERY batch op's `matrix`, and honours `batch`'s
 * all-or-nothing rule, because nothing in `rawJson.ts`'s parse or in the
 * coercion step descends into a batch op's own `args`. That makes the WRONG
 * encoding — an inner matrix written as a string — visibly rejected instead of
 * silently forwarded, which is what lets this harness distinguish a working
 * proof from a false one. The falsifiability row below is that guard.
 */

/* ------------------------------------------------------------------ *
 * The manifest — real declarations, transcribed, not invented.
 * `setTransform`: `id: string`, `matrix: matrix`. `batch`: `ops: array` whose
 * element is `{method, args}` and whose own `args` is a BARE `array` with no
 * element schema (v3's layer.descriptor.ts:556-569 — which is precisely why
 * nothing in this package recurses into a batch op's args). `create`:
 * `kind: string`, `props: object`. Transcribed rather than imported because
 * `figpea-mcp` is a standalone package that must build with no sibling `v3/`.
 * ------------------------------------------------------------------ */

const MANIFEST = {
  layer: {
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'line', 'text'] },
        props: {
          type: 'object',
          required: false,
          shape: {
            parentId: { type: 'string', required: false },
            rwidth: { type: 'number', required: false },
            rheight: { type: 'number', required: false },
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
  },
  session: {
    describe: {
      doc: 'Returns the agent contract surface.',
      params: {},
      result: {},
    },
  },
} as unknown as ManifestLike;

/* ------------------------------------------------------------------ *
 * The three captured fixtures, each paired with the LOGICAL payload it
 * came from — the payload an agent meant to send. The pair is what makes
 * AC-2's "the same logical payload" a fact rather than an adjective.
 * ------------------------------------------------------------------ */

/** A fixture's shape. `args`/`logical` are `unknown[]` rather than inferred
 *  literal tuples, because the collapsed bytes must stay exactly as captured
 *  and a narrowing annotation over them buys nothing but readonly friction. */
interface Fixture {
  name: string;
  group: string;
  method: string;
  /** The COLLAPSED payload, byte-exact from a capture. */
  args: unknown[];
  /** The LOGICAL payload it came from — what an agent meant to send. */
  logical: unknown[];
}

/** Capture M — AC-1's own words: the matrix arrives as `{"item":1}`. */
const CAPTURE_M: Fixture = {
  name: 'M — setTransform matrix, collapsed (byte-exact from AC-1)',
  group: 'layer',
  method: 'setTransform',
  args: ['L1', { item: 1 }],
  logical: ['L1', [1, 0, 0, 1, 48, 110]],
};

/** Capture B — REQ-1268's incident payload, byte-for-byte from its own
 *  fixture (`req1268.test.ts:91-103`). Both array levels wrapped in
 *  single-key `{"item": …}` envelopes. This is the PRIMARY refusal row. */
const CAPTURE_B: Fixture = {
  name: 'B — layer.batch ops, doubly collapsed (byte-exact from req1268.test.ts)',
  group: 'layer',
  method: 'batch',
  args: [
    {
      item: {
        item: {
          args: { item: { item: ['page', { name: 'probe', pageWidth: '100', pageHeight: '100' }] } },
          method: 'create',
        },
      },
    },
  ],
  logical: [[{ method: 'create', args: ['page', { name: 'probe', pageWidth: 100, pageHeight: 100 }] }]],
};

/** Composition C — B's envelope nesting verbatim, with AC-1's
 *  `setTransform` op pair and M's collapsed matrix leaf substituted in.
 *  A composition of two captures, NOT a third capture. */
const CAPTURE_C: Fixture = {
  name: 'C — layer.batch setTransform op, collapsed (composition of B and M)',
  group: 'layer',
  method: 'batch',
  args: [
    {
      item: {
        item: {
          args: { item: { item: ['L1', { item: 1 }] } },
          method: 'setTransform',
        },
      },
    },
  ],
  logical: [[{ method: 'setTransform', args: ['L1', [1, 0, 0, 1, 0, 0]] }]],
};

const FIXTURES: Fixture[] = [CAPTURE_M, CAPTURE_B, CAPTURE_C];

/** AC-2's 2-op batch: create a rect, then place it. The array form is what a
 *  well-behaved host sends and what the array-free form must deep-equal. */
const TWO_OPS = [
  { method: 'create', args: ['rect', { rwidth: 100, rheight: 50 }] },
  { method: 'setTransform', args: ['L_rect', [1, 0, 0, 1, 48, 110]] },
] as const;

/* ------------------------------------------------------------------ *
 * The stub tab — v3's real answers, not plausible ones.
 * ------------------------------------------------------------------ */

/** v3's `validateTransform` (layer.impl.ts:1128-1130), verbatim in rule. */
function validateTransform(matrix: unknown): boolean {
  return Array.isArray(matrix) && matrix.length === 6 && matrix.every((n) => Number.isFinite(n));
}

function receivedTypeName(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

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
  setTransform: { id: 'string', matrix: 'matrix' },
};

/** v3's `validateArgs` — the first positional argument that does not match its
 *  declared type is rejected. */
function positionalRejection(method: string, args: unknown[]): { ok: false; code: string; message: string } | undefined {
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

/** ⚠️ THE NON-NEUTRAL HALF. `layer.batch` is all-or-nothing, and v3 checks
 *  every op's own `matrix` with `validateTransform`. Nothing in this package
 *  descends into a batch op's `args`, so an inner matrix that stayed a string
 *  reaches the editor as a string and the WHOLE batch rolls back. The stub
 *  models that, which is what makes a wrongly-encoded batch visible. */
function batchOpRejection(args: unknown[]): { ok: false; code: string; message: string } | undefined {
  const ops = args[0];
  if (!Array.isArray(ops)) return undefined;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as { method?: unknown; args?: unknown };
    if (op?.method !== 'setTransform') continue;
    const matrix = Array.isArray(op.args) ? op.args[1] : undefined;
    if (!validateTransform(matrix)) {
      return {
        ok: false,
        code: 'invalid_transform',
        message: `batch(): ops[${i}].args[1] must be an array of numbers (got ${receivedTypeName(matrix)})`,
      };
    }
  }
  return undefined;
}

/** A successful editor answer that ECHOES what it was given, so "the tab
 *  received a real six-number array" is unsatisfiable by a stub that ignores
 *  its input. */
function editorSuccess(method: string, args: unknown[]): unknown {
  switch (method) {
    case 'create':
      return { id: 'L_probe', kind: args[0], props: args[1] };
    case 'batch': {
      const ops = args[0] as Array<{ method: string }>;
      return { results: ops.map((op, i) => ({ opIndex: i, ok: true, value: { id: `L_${op.method}_${i}` } })) };
    }
    case 'setTransform':
      return { id: args[0], matrix: args[1] };
    default:
      return null;
  }
}

interface Capture {
  group: string;
  method: string;
  args: unknown[];
}

function editorRejection(method: string, args: unknown[]): { ok: false; code: string; message: string } | undefined {
  return positionalRejection(method, args) ?? (method === 'batch' ? batchOpRejection(args) : undefined);
}

function makeStub() {
  const captured: Capture[] = [];
  const stub = {
    port: 54396,
    token: 'test-token-1294',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      h(MANIFEST);
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

async function connect(bridge: unknown, mode: Mode) {
  const server = createMcpServer(bridge as never, { toolMode: mode, prefetchedManifest: MANIFEST } as never);
  const client = new Client({ name: 'req-1294-test', version: '0.0.0' });
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
    return { ok: false, code: 'non_envelope', message: text };
  }
  return JSON.parse(text);
}

/** The same call in the form each lane takes: compact `figpea_call` is the
 *  DEFAULT mode, full mode's per-tool surface is what real MCP clients use. */
function laneCall(mode: Mode, fixture: Fixture): [string, Record<string, unknown>] {
  if (mode === 'compact') return ['figpea_call', { group: fixture.group, method: fixture.method, args: fixture.args }];
  const tool = `${fixture.group}_${fixture.method}`;
  const keys = fixture.method === 'batch' ? ['ops'] : ['id', 'matrix'];
  const named: Record<string, unknown> = {};
  keys.forEach((key, i) => {
    if (fixture.args[i] !== undefined) named[key] = fixture.args[i];
  });
  return [tool, named];
}

// ───────────────────────────────────────────── the host boundary ──

describe('REQ-1294 — the host boundary every fixture below relies on', () => {
  it('in all three captures the OUTER args array survives intact; only values nested inside it are collapsed', () => {
    for (const fixture of FIXTURES) {
      // The boundary, stated precisely: the positional `args` container is
      // still an ARRAY. A collapse that had reached it would have replaced it
      // with an `{"item": …}` envelope, and `args` is validated as an array by
      // the SDK before any handler runs.
      expect(Array.isArray(fixture.args), `${fixture.name}: the outer args container survived as an array`).toBe(true);
      // …and a collapse demonstrably DID happen somewhere inside it, or this
      // is not a collapse fixture and would prove nothing.
      expect(JSON.stringify(fixture.args), `${fixture.name}: carries an envelope`).toContain('"item"');
      // The nesting is where the plan says it is: the first POSITIONAL slot is
      // the collapsed value (M's matrix, B's and C's `ops`), never the array
      // that holds them. That is the boundary this harness relies on.
      expect(
        fixture.args[0],
        `${fixture.name}: the collapsed value sits inside the args array, not in place of it`,
      ).not.toBeUndefined();
    }
  });

  it('each fixture is paired with the LOGICAL payload it came from — so "the same payload" is a fact', () => {
    for (const fixture of FIXTURES) {
      expect(Array.isArray(fixture.logical), `${fixture.name}: has a logical payload`).toBe(true);
      // Same METHOD: the logical payload is the call the collapsed one was
      // meant to be, not some other call that happens to work.
      expect(fixture.logical[0], `${fixture.name}: the logical payload keeps the collapsed first slot`).toBeDefined();
      // The array the collapse destroyed is present in the logical payload and
      // absent from the collapsed one — which is the whole difference.
      expect(JSON.stringify(fixture.logical), `${fixture.name}: logical payload has no envelope`).not.toContain('"item"');
      expect(JSON.stringify(fixture.args), `${fixture.name}: collapsed payload has the envelope`).toMatch(/\{"item":/);
    }
    // And the matrices: M and C both collapse a real six-number tuple, which is
    // the value AC-2 must reach array-free.
    expect(CAPTURE_M.logical[1]).toEqual([1, 0, 0, 1, 48, 110]);
    expect((CAPTURE_C.logical[0] as any)[0].args[1]).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

// ───────────────────────────────────────────────────────────── AC-1 ──

describe('REQ-1294 AC-1 — from a collapsing host the call fails, and costs nothing', () => {
  it('capture M: the matrix arrives as {"item":1}, refused naming args[1] and "array of numbers", at ZERO round trips', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setTransform',
      args: ['L1', { item: 1 }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    // AC-1's own error text: `args[1] must be an array of numbers`.
    expect(result.message).toMatch(/args\[1\]/);
    expect(result.message).toMatch(/array of numbers/);
    // Before ANY tab round trip — the count is what makes "before" mean something.
    expect(captured).toHaveLength(0);
  });

  it('capture B (the primary refusal row): the doubly-collapsed batch is refused the same way, at ZERO round trips', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: CAPTURE_B.args,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    expect(result.message).toMatch(/args\[\d+\]/);
    // "array" is the requirement it names, and the worked payload the refusal
    // carries is the positional form an agent can copy.
    expect(result.message).toMatch(/array/i);
    expect(result.message).toContain('[[{');
    expect(captured).toHaveLength(0);
  });

  it('capture C: AC-1\'s named setTransform batch collapses the same way and is refused the same way', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: CAPTURE_C.args,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    expect(result.message).toMatch(/args\[\d+\]/);
    expect(result.message).toMatch(/array/i);
    expect(result.message).toContain('[[{');
    expect(captured).toHaveLength(0);
  });

  it('every captured fixture is refused on BOTH lanes, at zero round trips on the compact one', async () => {
    for (const fixture of FIXTURES) {
      const compactRun = makeStub();
      const compact = await connect(compactRun.stub, 'compact');
      const compactResult = await callToolJson(compact, 'figpea_call', {
        group: fixture.group,
        method: fixture.method,
        args: fixture.args,
      });
      expect(compactResult.ok, `${fixture.name} (compact) is refused`).toBe(false);
      expect(compactResult.code, `${fixture.name} (compact) code`).toBe('invalid_params');
      expect(compactRun.captured, `${fixture.name} (compact) round trips`).toHaveLength(0);

      const fullRun = makeStub();
      const full = await connect(fullRun.stub, 'full');
      const [tool, args] = laneCall('full', fixture);
      const fullResult = await callToolJson(full, tool, args);
      // Full mode relays the editor's own rejection; what AC-1 forbids is the
      // payload being quietly repaired before it gets there.
      expect(fullResult.ok, `${fixture.name} (full) is refused`).toBe(false);
      for (const capture of fullRun.captured) {
        expect(JSON.stringify(capture.args), `${fixture.name} (full) arrived untouched`).toContain('"item"');
      }
    }
  });
});

// ───────────────────────────────────────────────────────────── AC-2 ──

describe('REQ-1294 AC-2 — the same logical payload, array-free, from that same host', () => {
  it('the matrix AC-1 could not send is expressible with no nested array, and applies in ONE round trip', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setTransform',
      // The SAME logical payload as capture M, with the array moved into a
      // string. A string is a scalar, and a scalar is what no host collapses.
      args: ['L1', '[1,0,0,1,48,110]'],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    // Asserted on what the TAB received: a real six-number array, not a string.
    const received: unknown = captured[0]!.args[1];
    expect(Array.isArray(received)).toBe(true);
    expect(received).toHaveLength(6);
    expect((received as unknown[]).every((n: unknown) => typeof n === 'number' && Number.isFinite(n))).toBe(true);
    // …and it is the matrix capture M's logical payload carried.
    expect(received).toEqual(CAPTURE_M.logical[1]);
    expect(Array.isArray(received), 'the captured matrix is an array, typed not unknown').toBe(true);
  });

  it('the array-free matrix is DEEP-EQUAL to the array form — payload and result', async () => {
    const asArray = makeStub();
    const viaArray = await callToolJson(await connect(asArray.stub, 'compact'), 'figpea_call', {
      group: 'layer',
      method: 'setTransform',
      args: CAPTURE_M.logical,
    });
    const asString = makeStub();
    const viaString = await callToolJson(await connect(asString.stub, 'compact'), 'figpea_call', {
      group: 'layer',
      method: 'setTransform',
      args: ['L1', '[1,0,0,1,48,110]'],
    });
    expect(viaArray.ok).toBe(true);
    expect(viaString.ok).toBe(true);
    expect(asString.captured).toHaveLength(1);
    expect(asString.captured[0]!.args).toEqual(asArray.captured[0]!.args);
    expect(viaString.value).toEqual(viaArray.value);
  });

  it('a 2-op batch is issued ATOMICALLY: one ops string, one round trip, both ops in order', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      // The inner matrix is a REAL ARRAY inside the literal: the parse reads
      // `ops` once and never descends into an op's own `args`, so a string
      // there would stay a string. See the falsifiability row below.
      args: [JSON.stringify(TWO_OPS)],
    });
    expect(result.ok).toBe(true);
    // ONE callTab. Atomicity is only real if the complete batch crosses in one.
    expect(captured).toHaveLength(1);
    const received = captured[0]!.args[0] as Array<{ method: string; args: unknown[] }>;
    expect(Array.isArray(received)).toBe(true);
    expect(received).toHaveLength(2);
    // In order, both applied.
    expect(received.map((op) => op.method)).toEqual(['create', 'setTransform']);
    expect(result.value.results.map((r: any) => r.opIndex)).toEqual([0, 1]);
    // The setTransform op carries a real six-number matrix at the tab.
    const innerMatrix: unknown = received[1]!.args[1];
    expect(innerMatrix).toEqual([1, 0, 0, 1, 48, 110]);
    expect((innerMatrix as unknown[]).every((n: unknown) => typeof n === 'number')).toBe(true);
  });

  it('the array-free batch is DEEP-EQUAL to the array form the collapsing host could not send', async () => {
    const asArray = makeStub();
    const viaArray = await callToolJson(await connect(asArray.stub, 'compact'), 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [TWO_OPS as unknown as unknown[]],
    });
    const asString = makeStub();
    const viaString = await callToolJson(await connect(asString.stub, 'compact'), 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [JSON.stringify(TWO_OPS)],
    });
    expect(viaArray.ok).toBe(true);
    expect(viaString.ok).toBe(true);
    expect(asString.captured).toHaveLength(1);
    expect(asString.captured[0]!.args).toEqual(asArray.captured[0]!.args);
    expect(viaString.value).toEqual(viaArray.value);
  });

  it('the same array-free batch is atomic on the FULL lane too, and delivers deep-equal args', async () => {
    const compactRun = makeStub();
    const compactResult = await callToolJson(await connect(compactRun.stub, 'compact'), 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [JSON.stringify(TWO_OPS)],
    });
    const fullRun = makeStub();
    const fullResult = await callToolJson(await connect(fullRun.stub, 'full'), 'layer_batch', {
      ops: JSON.stringify(TWO_OPS),
    });
    expect(compactResult.ok).toBe(true);
    expect(fullResult.ok).toBe(true);
    expect(fullRun.captured).toHaveLength(1);
    expect(fullRun.captured[0]!.args).toEqual(compactRun.captured[0]!.args);
    expect(fullResult.value).toEqual(compactResult.value);
  });
});

// ────────────────────────────── falsifiability — the row that makes T1 a proof ──

describe('REQ-1294 — falsifiability: a WRONGLY encoded batch is visibly rejected', () => {
  it('an inner matrix written as a STRING inside the ops literal is refused by the tab, and the whole batch rolls back', async () => {
    const wrong = [
      { method: 'create', args: ['rect', { rwidth: 100, rheight: 50 }] },
      // The mistake this row exists to catch: `ops` is parsed once at the
      // `ops` position and never recursively, so a matrix the host also
      // collapses can only be saved by being written as a real array INSIDE
      // the literal. A string here reaches the editor as a string.
      { method: 'setTransform', args: ['L_rect', '[1,0,0,1,48,110]'] },
    ];
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [JSON.stringify(wrong)],
    });
    // It DID reach the tab — this is the editor's own refusal relayed, which is
    // what proves the previous row's success came from the encoding, not from a
    // stub that would have accepted anything.
    expect(captured).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/array of numbers/);
    // All-or-nothing: no op result comes back at all.
    expect(result.value).toBeUndefined();
  });

  it('a direct setTransform whose matrix stayed a string is refused too — the same rule, outside a batch', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    // A string at a `matrix` position that the escape hatch does NOT rescue
    // (it is not JSON-looking: no brackets), so the value reaches the tab.
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'setTransform',
      args: ['L1', 'one-zero-zero-one'],
    });
    expect(captured).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/matrix must be matrix/);
  });
});

// ───────────────────────────────────────────────────────────── AC-4 ──

describe('REQ-1294 AC-4 — the {"item": …} detection and its message are unchanged', () => {
  it('a collapse nested DEEP inside a real payload is still found, still refused, never unwrapped', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    // `batch.ops`' element `args` is declared a bare `array`, so an envelope at
    // that position is exactly what Rule B exists to catch — and the payload
    // around it is a perfectly ordinary batch.
    const ops = [{ method: 'create', args: { item: { item: ['rect', { rwidth: 100 }] } } }];
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: [ops],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_params');
    // The path is the NESTED one, not the outer slot — the depth is reported.
    expect(result.message).toMatch(/args\[0\]\[0\]\.args/);
    expect(captured).toHaveLength(0);
  });

  it('nothing anywhere converts {"item": X} to X — the tab still sees the envelope', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'compact');
    // A legitimate single-key object named `item` at an OBJECT position. A
    // blind unwrap would silently reinterpret this payload; nothing does.
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['rect', { item: { keep: 'me' } }],
    });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[1]).toEqual({ item: { keep: 'me' } });
  });

  it('on the FULL lane the envelope is relayed untouched, never repaired', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const result = await callToolJson(client, 'layer_batch', { ops: CAPTURE_B.args[0] });
    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(1);
    const ops = captured[0]!.args[0] as any;
    expect(Array.isArray(ops)).toBe(false);
    expect(ops.item).toBeDefined();
  });

  it('the refusal still names the escape hatch, so the refusal is not a dead end', async () => {
    const { stub } = makeStub();
    const client = await connect(stub, 'compact');
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'batch',
      args: CAPTURE_B.args,
    });
    expect(result.ok).toBe(false);
    const message: string = result.message;
    // The one route a collapsing host can actually take, named by name.
    expect(message).toMatch(/JSON string/i);
    expect(message).toMatch(/scalar/i);
    // …and the call that teaches the shape.
    expect(message).toContain('figpea_describe');
  });
});