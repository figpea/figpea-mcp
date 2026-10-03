import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';

/**
 * REQ-1430 T1 — AC-1 / AC-2 / AC-3, observed through the RELAY hop.
 *
 * ## What is missing, and why these ACs are not already covered
 *
 * The editor's per-call argument budget and its `arg_size_exceeded` refusal
 * shipped and are proven by REQ-1432's e2e, which drives `figpea.layer.batch()`
 * **in-page**. That proof stops at the tab. The card's actual repro went the
 * other way — `figpea_call({group:'layer', method:'batch', args:[[...ops]]})`,
 * the NESTED-OPS POSITIONAL shape, i.e. through this server — and on that path
 * the refusal crosses four append-only relay hints before an agent reads it.
 *
 * So the hop nobody had tested is the one the card tripped, and the failure it
 * could hide is specific: `appendShapeHint` / `appendWrapperHint` /
 * `appendCreatePropHint` / `appendNestedStringHint` (`mcpServer.ts:1712-1727`)
 * each APPEND a sentence to a failing result's message. The code comment above
 * them states *"Every one of them appends only; none rewrites a code or a
 * message."* That comment is the contract under test. If a hint ever began
 * rewriting — or began firing on a code it has no business explaining — an
 * image-free refusal could pick up a CORS/`projectImages` clause, which is
 * precisely AC-2's defect, and nothing in the tree would go red.
 *
 * ## The ACs, as tests read
 *
 *  - AC-1: an over-budget batch sent in the card's nested `args:[[...ops]]`
 *    shape comes back `{ok:false, code:'arg_size_exceeded'}` — through the
 *    relay, in BOTH calling conventions.
 *  - AC-2: the message an agent reads names the per-call budget AND the remedy
 *    (split the batch), and mentions NONE of `data:` URIs, CORS origins,
 *    `projectImages` or `placeProjectImage` — for a payload with no bytes on it.
 *    Plus the CONVERSE: an image-bearing payload KEEPS the staging clause, so
 *    the first half cannot be satisfied by silencing the advice everywhere.
 *  - AC-3: `layer.batch`'s own doc string carries an op-count and an approximate
 *    serialized-size budget, so an agent can size a batch from
 *    `figpea_describe('layer.batch')` alone — asserted as REACHABILITY through
 *    this relay, which is the part this repo owns.
 *
 * ## Why the tab is stubbed, and how honestly
 *
 * The tab is stubbed because it is provably NOT the locus: the guard, its
 * threshold and its two message shapes are the editor's, already covered by
 * REQ-1432's e2e. The stub is therefore seeded with the editor's REAL refusal,
 * transcribed from `v3/src/agent/argLimits.ts` (`buildArgSizeExceeded` +
 * `payloadCarriesImageBytes`) and from `v3/src/agent/groups/layer.descriptor.ts`
 * (`BATCH_ARGS_BUDGET_DOC`) — read what actually ships, never the zod shape.
 * Transcribing rather than importing is the standing rule here: `figpea-mcp` is
 * a published standalone package that must build with no sibling `v3/` checkout
 * (REQ-1309 established the pattern).
 *
 * The stub applies the editor's own predicate to the FORWARDED args, so the
 * image-free and image-bearing lanes are driven by the payload the test really
 * sends rather than by a flag the test sets. What a test here can newly see is
 * therefore exactly one thing: what the relay does to a refusal on the way out.
 *
 * **BOTH LANES, ALWAYS.** Compact `figpea_call` is this server's default mode;
 * per-tool full mode is what real MCP clients use. A rule wired into one lane
 * satisfies the card's example in one calling convention only (REQ-1309's rule).
 */

/* ------------------------------------------------------------------ *
 * The editor's guard, transcribed. See the provenance note above.
 * `v3/src/agent/argLimits.ts` — AGENT_ARGS_MAX_CHARS / _BATCH_BUDGET_TEXT.
 * ------------------------------------------------------------------ */
const LIMIT_CHARS = 22_000;
const LIMIT_TEXT = '22,000';
const BUDGET_TEXT = '~14,000';

/** `v3/src/agent/argLimits.ts` — `payloadCarriesImageBytes`. */
function payloadCarriesImageBytes(serialized: string): boolean {
  return serialized.includes('data:image/') || /"bytes"\s*:/.test(serialized);
}

/** `v3/src/agent/argLimits.ts` — the image-only staging sentence. */
const IMAGE_STAGING_ADVICE =
  'If the payload carries image bytes, stage them on a local CORS origin ' +
  '(http://127.0.0.1:<port> with ACAO:*) or reuse projectImages + placeProjectImage instead of a data: URI.';

/** `v3/src/agent/argLimits.ts` — `buildArgSizeExceeded`. */
function editorArgSizeRefusal(measuredChars: number, serialized: string) {
  const lead =
    `Serialized argument size is ${measuredChars.toLocaleString('en-US')} characters, over the ` +
    `${LIMIT_TEXT}-character per-call limit for this tool. Nothing was applied — this call is all-or-nothing, ` +
    `so there is no partial result. Split it into smaller calls of at most ` +
    `${BUDGET_TEXT} characters each.`;
  return {
    ok: false as const,
    code: 'arg_size_exceeded',
    message: payloadCarriesImageBytes(serialized) ? `${lead} ${IMAGE_STAGING_ADVICE}` : lead,
  };
}

/**
 * The seeded "editor". Mirrors `v3/src/agent/registry.ts`'s guard: measure the
 * serialized args, refuse over the limit, apply nothing. Under-limit calls
 * answer a well-formed success, so an un-refused call is visibly a pass-through
 * and never an accident of a shared error stub.
 */
function editorTab(args: unknown[]) {
  const serialized = JSON.stringify(args);
  if (serialized.length <= LIMIT_CHARS) return { ok: true, value: { results: [] } };
  return editorArgSizeRefusal(serialized.length, serialized);
}

/**
 * `v3/src/agent/groups/layer.descriptor.ts` — `BATCH_ARGS_BUDGET_DOC`,
 * transcribed with its two template interpolations resolved. This is the text
 * AC-3 is about, so it is carried here verbatim rather than paraphrased.
 */
const SHIPPED_BATCH_BUDGET_DOC =
  ` Per-call argument budget: this call's ops are serialized together with the enclosing args and refused with arg_size_exceeded once that serialization exceeds ${LIMIT_TEXT} characters (UTF-16 code units of JSON.stringify(args) — read the live value at describe().limits.argsChars). Aim for at most ${BUDGET_TEXT} characters per call: a dense page of shape and text ops reaches the limit at well under 90 ops, and nothing is applied when it is exceeded, so there is no partial page to recover. Chunk by splitting the op list across calls of that size and re-using ids from earlier results — each chunk is its own undo step, so undo() steps back through them in order. A payload carrying image bytes reaches the limit far sooner; see setImageFill and the projectImages/placeProjectImage workaround for those.`;

const MANIFEST = {
  version: '2.63.0',
  layer: {
    batch: {
      doc: `Applies a sequence of layer ops as ONE undo step, all-or-nothing.${SHIPPED_BATCH_BUDGET_DOC}`,
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
};

interface BridgeStub {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

interface Call {
  group: string;
  method: string;
  args: unknown[];
}

/** Every reply the seeded editor actually returned, in order — SNAPSHOTTED.
 *
 * The relay's hints mutate the very result object they are handed, so a
 * reference kept here would be mutated with it and the byte-for-byte
 * comparison below would compare the mutation against itself and pass for
 * ever. Proven: a mutation probe that let `appendShapeHint` fire on
 * `arg_size_exceeded` left this suite green until the seed was snapshotted. */
interface Session {
  client: Client;
  calls: Call[];
  replies: Array<{ ok: boolean; code?: string; message?: string }>;
}

async function session(toolMode: 'compact' | 'full'): Promise<Session> {
  const calls: Call[] = [];
  const replies: Array<{ ok: boolean; code?: string; message?: string }> = [];
  const stub: BridgeStub = {
    port: 54321,
    token: 'req-1430-token',
    isTabConnected: () => true,
    onDescribe: (handler) => handler(MANIFEST),
    callTab: async (group: string, method: string, args: unknown[]) => {
      calls.push({ group, method, args });
      const reply = editorTab(args);
      // SNAPSHOT, never the reference: see `Session` above. Copying the three
      // fields by hand rather than `structuredClone`/`JSON.parse` so a reply
      // that ever gains a non-cloneable member fails loudly here instead of
      // silently weakening the comparison it exists to make.
      replies.push({
        ok: reply.ok,
        code: (reply as { code?: string }).code,
        message: (reply as { message?: string }).message,
      });
      return reply;
    },
    close: async () => {},
  };
  const server = createMcpServer(stub, { toolMode });
  const client = new Client({ name: 'req-1430-batch-arg-budget-relay', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, calls, replies };
}

/** The single text block a refusal comes back in, parsed. */
function payloadOf(res: any): { ok: boolean; code?: string; message?: string } {
  const blocks = (res.content as any[]).filter((c: any) => c.type === 'text');
  expect(blocks, 'a text content block is present').toHaveLength(1);
  return JSON.parse(blocks[0].text);
}

/**
 * An over-budget batch in the card's shape: `layer.batch` ops of path + text
 * geometry, no bytes on any of them. Sized by construction, not by a flag —
 * `overBudgetPayload` asserts the serialization really is over the limit.
 */
function overBudgetOps(): Array<{ method: string; args: unknown[] }> {
  const ops: Array<{ method: string; args: unknown[] }> = [];
  for (let i = 0; i < 90; i++) {
    ops.push({
      method: 'create',
      args: [
        'text',
        {
          parentId: 'page-1',
          name: `row-${i}`,
          text: `Section ${i} — `.padEnd(220, 'lorem ipsum dolor sit amet '),
          x: 40 + i,
          y: 24 * i,
          rwidth: 320,
          rheight: 18,
        },
      ],
    });
  }
  return ops;
}

/** The same batch with one op carrying an inline image — the CONVERSE lane. */
function overBudgetOpsWithImageBytes(): Array<{ method: string; args: unknown[] }> {
  const ops = overBudgetOps();
  ops.push({
    method: 'create',
    args: [
      'image',
      {
        parentId: 'page-1',
        name: 'hero',
        url: `data:image/png;base64,${'A'.repeat(300)}`,
        x: 0,
        y: 0,
      },
    ],
  });
  return ops;
}

type Lane = {
  readonly name: string;
  /** True when the lane takes the card's nested-ops positional `args` shape. */
  readonly nestedPositional: boolean;
  call(s: Session, ops: Array<{ method: string; args: unknown[] }>): Promise<any>;
};

const LANES: readonly Lane[] = [
  {
    name: "compact figpea_call — the card's nested-ops positional shape",
    nestedPositional: true,
    call: (s, ops) =>
      s.client.callTool({
        name: 'figpea_call',
        // THE CARD'S SHAPE: the ops array is ONE positional element of `args`.
        arguments: { group: 'layer', method: 'batch', args: [ops] },
      } as any) as Promise<any>,
  },
  {
    name: 'full mode layer_batch — the per-tool lane real MCP clients use',
    nestedPositional: false,
    call: (s, ops) =>
      s.client.callTool({ name: 'layer_batch', arguments: { ops } } as any) as Promise<any>,
  },
];

/* ================================================================== *
 * AC-1 — the refusal arrives intact through the relay, in both lanes.
 * ================================================================== */

describe('REQ-1430 AC-1 — an over-budget batch is refused with arg_size_exceeded THROUGH the relay', () => {
  for (const lane of LANES) {
    describe(lane.name, () => {
      it('the batch really is over the per-call budget, so the lane above is not vacuous', async () => {
        const s = await session(lane.nestedPositional ? 'compact' : 'full');
        const ops = overBudgetOps();
        const serialized = JSON.stringify(lane.nestedPositional ? [ops] : [ops]);
        expect(
          serialized.length,
          'the fixture is genuinely over the 22,000-character per-call limit',
        ).toBeGreaterThan(LIMIT_CHARS);
        expect(serialized, 'and carries no image bytes, which is the card\'s case').not.toContain('data:image/');
        // Nothing was called — this assertion is about the fixture, not the relay.
        expect(s.calls).toHaveLength(0);
      });

      it('comes back ok:false with the editor\'s own code, not a relay invention', async () => {
        const s = await session(lane.nestedPositional ? 'compact' : 'full');
        const res = await lane.call(s, overBudgetOps());
        const payload = payloadOf(res);
        expect(payload.ok, 'the agent is told the call did not succeed').toBe(false);
        expect(payload.code, 'the editor\'s own error code survives the hop verbatim').toBe('arg_size_exceeded');
        expect(res.isError, 'and it is surfaced as an error result').toBe(true);
      });

      it('costs exactly ONE round trip — the relay does not retry a refusal', async () => {
        const s = await session(lane.nestedPositional ? 'compact' : 'full');
        await lane.call(s, overBudgetOps());
        expect(s.calls, 'one forwarded call, no relay-side retry storm').toHaveLength(1);
        expect(s.calls[0].group).toBe('layer');
        expect(s.calls[0].method).toBe('batch');
      });

      it('the refusal message reaches the agent byte-for-byte — no relay hint grafted onto it', async () => {
        const s = await session(lane.nestedPositional ? 'compact' : 'full');
        const payload = payloadOf(await lane.call(s, overBudgetOps()));
        const seeded = s.replies[0];
        expect(
          payload.message,
          'the relay relays the editor\'s message unchanged; the four append-only hints ' +
            '(appendShapeHint / appendWrapperHint / appendCreatePropHint / appendNestedStringHint) ' +
            'must not append to — or rewrite — a refusal they cannot explain',
        ).toBe(seeded.message);
      });
    });
  }
});

/* ================================================================== *
 * AC-2 — what the message an agent actually reads says, and does not say.
 * ================================================================== */

describe('REQ-1430 AC-2 — the image-free refusal names the budget and the split remedy, and no image advice', () => {
  for (const lane of LANES) {
    describe(lane.name, () => {
      it('names the per-call budget it exceeded, so the agent can size the next call', async () => {
        const s = await session(lane.nestedPositional ? 'compact' : 'full');
        const payload = payloadOf(await lane.call(s, overBudgetOps()));
        const message = payload.message ?? '';
        expect(message, 'names a per-call character limit').toMatch(/per-call limit/i);
        expect(message, 'quotes a concrete character budget to aim at').toMatch(/\d[\d,]*\s*characters?/);
        expect(message, 'and points at the authoritative value an agent can read live')
          .toMatch(/limit for this tool/i);
      });

      it('offers the remedy — split the batch — and says nothing was applied', async () => {
        const s = await session(lane.nestedPositional ? 'compact' : 'full');
        const payload = payloadOf(await lane.call(s, overBudgetOps()));
        const message = payload.message ?? '';
        expect(message, 'offers the split remedy').toMatch(/split|chunk/i);
        expect(message, 'and says the refusal applied nothing, so splitting is safe').toMatch(/nothing was applied/i);
      });

      it('carries NO image-staging advice — the payload had no bytes on it', async () => {
        const s = await session(lane.nestedPositional ? 'compact' : 'full');
        const payload = payloadOf(await lane.call(s, overBudgetOps()));
        const message = payload.message ?? '';
        expect(
          message,
          'an image-free refusal must not tell the caller to stage bytes on a CORS origin — ' +
            'that is what sent the card\'s run chasing a phantom image problem',
        ).not.toMatch(/ACAO|127\.0\.0\.1|projectImages|placeProjectImage|data:\s*URI/i);
        expect(message, 'nor name a CORS origin by its long form').not.toMatch(/Access-Control-Allow-Origin/i);
      });
    });
  }

  it('CONVERSE — an image-bearing payload KEEPS the staging clause, so the fix is not over-corrected', async () => {
    for (const lane of LANES) {
      const s = await session(lane.nestedPositional ? 'compact' : 'full');
      const payload = payloadOf(await lane.call(s, overBudgetOpsWithImageBytes()));
      const message = payload.message ?? '';
      expect(message, `${lane.name}: the image remedy is still there for a payload that has bytes`).toMatch(
        /ACAO|127\.0\.0\.1|projectImages|placeProjectImage|data:\s*URI/i,
      );
      expect(message, `${lane.name}: and it still names the budget too`).toMatch(/per-call limit/i);
    }
  });
});

/* ================================================================== *
 * AC-3 — `layer.batch`'s own doc is REACHABLE through the relay, and the
 * doc itself carries an op-count and an approximate serialized-size budget.
 * ================================================================== */

describe('REQ-1430 AC-3 — an agent can size a batch from layer.batch\'s own describe, through the relay', () => {
  it("figpea_describe relays layer.batch's doc verbatim — the budget sentence is not lost in transit", async () => {
    const s = await session('compact');
    const res = (await s.client.callTool({
      name: 'figpea_describe',
      arguments: { group: 'layer', method: 'batch' },
    } as any)) as any;
    const payload = payloadOf(res);
    expect(payload.ok, 'the describe drill succeeds').toBe(true);
    expect(
      (payload as any).doc,
      'the doc string reaches the agent with the shipped budget sentence intact',
    ).toContain(SHIPPED_BATCH_BUDGET_DOC);
    expect(s.calls, 'and it costs no round trip at all').toHaveLength(0);
  });

  it('the relayed doc states BOTH an op-count and an approximate serialized-size budget', async () => {
    const s = await session('compact');
    const res = (await s.client.callTool({
      name: 'figpea_describe',
      arguments: { group: 'layer', method: 'batch' },
    } as any)) as any;
    const doc = String((payloadOf(res) as any).doc ?? '');
    expect(doc, 'names the refusal code, so the doc and the refusal agree').toContain('arg_size_exceeded');
    expect(doc, 'states an approximate serialized-SIZE budget').toMatch(/character/i);
    expect(doc, 'names a concrete budget an agent can aim at').toMatch(/\d[\d,]*\s*characters?/i);
    expect(doc, 'states an op-count for the dense-page case').toMatch(/under\s+\d+\s+ops/i);
    expect(doc, 'and points at the live value rather than only quoting a number')
      .toMatch(/describe\(\)\.limits\.argsChars/);
  });
});
