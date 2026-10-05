import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import type { ManifestLike } from './tools';

/**
 * REQ-1294 AC-3 (the relay half) — the contract's typed `stringJson`
 * declaration reaches `figpea_describe` intact, and the split boundary holds.
 *
 * The spec here is the card's AC text. What the card states, independently of
 * any code in this file:
 *
 *  - AC-3  `describe()` for `layer.setTransform` documents the array-free form,
 *          and its `matrix` param is typed as something a host can satisfy
 *          rather than the bare `{type:'matrix'}` — and that declaration must
 *          reach the agent.
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL, given that rows (a)–(c) are GREEN ON ARRIVAL.
 * `figpea_describe` spreads the whole descriptor through (`mcpServer.ts`), so a
 * contract-declared `params.matrix.stringJson` arrives with no figpea-mcp code
 * at all. That is a claim, and a claim decays: the moment someone filters the
 * descriptor, the declaration silently stops arriving — and this codebase has
 * ALREADY made that mistake once. `tools.ts`'s `buildParamSchemas` REBUILDS
 * each schema field-by-field (`type`, `required`, `enum`, then nested `shape`/
 * `of`/`byKind`) and therefore silently drops any key it does not know. An
 * unknown manifest key vanishing from the wire is the exact failure this file
 * is the guard against, and it is invisible: no test fails, no error is
 * raised, the agent simply goes back to discovering the form by failing.
 *
 * So (a)–(c) are REGRESSION PINS — they assert "it already works" so that a
 * future refactor cannot quietly take it away — and (d) is the assertion that
 * makes the SPLIT boundary mechanical rather than aspirational.
 *
 * Row (d) is REQ-1412's subject, not this card's. REQ-1412 is *"full mode is
 * never told about the JSON-string escape hatch"*: advertising it in full mode's
 * `tools/list`, the full-lane shape pre-flight, and `ParamSchemaLike.stringJson`.
 * Those were carved off REQ-1294 on 2026-10-05. This card must not quietly take
 * them, so (d) asserts the seam: a full-mode `tools/list` for `layer_setTransform`
 * advertises `matrix` as a plain array with NO string alternative and NO
 * `stringJson` key. If REQ-1412 lands and makes this file fail, that is the
 * boundary being crossed BY REQ-1412, on purpose and with its own ACs — which is
 * the correct outcome for this assertion to produce. What must never happen is
 * this card taking the work silently, which is why the row is written to fail
 * loudly rather than to tolerate either shape.
 *
 * The manifest is a SYNTHETIC FIXTURE on purpose. It declares the field this
 * card's contract change declares, with a shape no current `v3` build has yet
 * published, so the test proves the relay carries an ARBITRARY declaration
 * rather than proving today's specific one round-trips. A test that read a
 * sibling `v3/` checkout would break `figpea-mcp`'s standalone-degrade invariant
 * (REQ-1309): this package must build and run for someone who cloned it with
 * no sibling editor checkout at all.
 */

const MANIFEST = {
  layer: {
    setTransform: {
      doc: 'Sets a layer transform matrix. A host that cannot nest structures may send the matrix as a JSON string instead, e.g. "[1,0,0,1,48,110]" — a string is a scalar.',
      params: {
        id: { type: 'string', required: true },
        matrix: {
          type: 'matrix',
          required: true,
          doc: 'The affine transform [a,b,c,d,e,f]. May also be sent as a JSON string.',
          stringJson: {
            type: 'string',
            example: '[1,0,0,1,48,110]',
            doc: 'This matrix may also be sent as a JSON string carrying the same six numbers.',
          },
        },
      },
      result: 'void',
    },
    setName: {
      doc: 'Renames a layer by id.',
      params: { id: { type: 'string', required: true }, name: { type: 'string', required: true } },
      result: 'void',
    },
  },
} as unknown as ManifestLike;

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

function makeStub() {
  const stub = {
    port: 54397,
    token: 'test-token-1294-relay',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      h(MANIFEST);
    },
    callTab: async () => ({ ok: true, value: null }),
    close: async () => {},
  };
  return stub;
}

type Mode = 'compact' | 'full';

async function connect(bridge: unknown, mode: Mode) {
  const server = createMcpServer(bridge as never, { toolMode: mode, prefetchedManifest: MANIFEST } as never);
  const client = new Client({ name: 'req-1294-relay-test', version: '0.0.0' });
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

describe('REQ-1294 AC-3 — the relay carries the contract\'s typed string alternative verbatim', () => {
  it('figpea_describe returns params.matrix.stringJson EXACTLY as the manifest declares it', async () => {
    const client = await connect(makeStub(), 'compact');
    const described = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'setTransform' });
    expect(described.ok).toBe(true);

    const declared = (MANIFEST.layer as any).setTransform.params.matrix.stringJson;
    // VERBATIM, as a value — not "a stringJson key exists". A relay that
    // rebuilt the schema field-by-field (as `buildParamSchemas` does for
    // `tools/list`) would drop the whole object, and one that kept only
    // `type` would pass a key-presence check while losing the copyable
    // example — the exact half an agent needs.
    expect((described.params as any).matrix.stringJson).toEqual(declared);
    expect((described.params as any).matrix.stringJson.type).toBe('string');
    // The example survives as a real, copyable payload.
    expect((described.params as any).matrix.stringJson.example).toBe('[1,0,0,1,48,110]');
    // And it parses into a six-number matrix, so an agent copying it sends
    // something the editor accepts rather than something it rejects.
    const parsed = JSON.parse((described.params as any).matrix.stringJson.example);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(6);
    expect(parsed.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))).toBe(true);
  });

  it('the runtime type is reported unchanged beside the alternative — not replaced by it', async () => {
    const client = await connect(makeStub(), 'compact');
    const described = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'setTransform' });
    // AC-3 asks for something a host can satisfy to be PUBLISHED ALONGSIDE the
    // bare type, not for the bare type to be renamed away. A relay that
    // rewrote `type` to "string" would satisfy "a host can satisfy this" while
    // telling every other consumer the runtime type is a string.
    expect((described.params as any).matrix.type).toBe('matrix');
    expect((described.params as any).matrix.required).toBe(true);
    expect((described.params as any).id.type).toBe('string');
    // The param's own doc rides along too — the sentence an agent reads.
    expect((described.params as any).matrix.doc).toBe((MANIFEST.layer as any).setTransform.params.matrix.doc);
  });

  it('stringJsonParams still lists matrix, unchanged and still exact', async () => {
    const client = await connect(makeStub(), 'compact');
    const described = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'setTransform' });
    // REQ-1318's key is what makes the form ADVERTISED rather than merely
    // tolerated, and AC-3 asks for it "still listing matrix beside it". The
    // typed declaration and this list must not become alternatives to each
    // other: one says the param may, the other says how.
    expect(described.stringJsonParams).toEqual(['matrix']);
    // A method with nothing structured still omits the key rather than
    // reporting an empty list.
    const noStructured = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'setName' });
    expect(noStructured.ok).toBe(true);
    expect(noStructured.stringJsonParams).toBeUndefined();
  });

  it("the method doc carrying the array-free sentence reaches describe() untouched", async () => {
    const client = await connect(makeStub(), 'compact');
    const described = await callToolJson(client, 'figpea_describe', { group: 'layer', method: 'setTransform' });
    expect(described.doc).toBe((MANIFEST.layer as any).setTransform.doc);
    // …and it says the two things AC-3's clause (a) asks the contract to say.
    expect(described.doc).toMatch(/JSON string/i);
    expect(described.doc).toMatch(/scalar/i);
  });

  it('SPLIT SEAM — full-mode tools/list for setTransform advertises NO string alternative', async () => {
    // ⚠️ This is REQ-1412's subject, carved off this card on 2026-10-05, and it
    // is asserted as NOT delivered here on purpose. The advertisement, the
    // full-lane pre-flight and `ParamSchemaLike.stringJson` are all REQ-1412's;
    // `figpea_describe` is compact-only, so the contract-side declaration this
    // card ships reaches the agent through THAT tool and not through
    // `tools/list`. Asserting its absence is what keeps the two cards'
    // boundaries checkable from either side — see the header.
    const client = await connect(makeStub(), 'full');
    const { tools } = await client.listTools();
    const setTransform = tools.find((t) => t.name === 'layer_setTransform');
    expect(setTransform, 'layer_setTransform is advertised in full mode').toBeDefined();

    const props: any = (setTransform as any).inputSchema.properties;
    // The parameter is advertised as the plain structure the runtime wants.
    expect(props.matrix.type).toBe('array');
    // …and none of REQ-1412's three artefacts is present.
    expect(props.matrix.stringJson, 'no stringJson key on the advertised schema').toBeUndefined();
    const schemaText = JSON.stringify((setTransform as any).inputSchema);
    expect(schemaText, 'no oneOf/anyOf advertising a string alternative').not.toMatch(/"(oneOf|anyOf)"/);
    expect(schemaText, 'and no copyable example in the advertised schema').not.toContain('[1,0,0,1,48,110]');
    // `matrix.type` is `array` and nothing else: the ADVERTISED schema offers
    // exactly one accepted form, which is what "this card does not do REQ-1412's
    // work" means structurally.
    expect(props.matrix.type).toBe('array');
    expect(Object.keys(props.matrix).sort()).toEqual(['type']);

    // ⚠️ WHAT IS DELIBERATELY NOT ASSERTED HERE, because asserting it would be a
    // false seam. The generated tool's DESCRIPTION is built as the contract's own
    // `doc` + a serialised `Params:` block + this package's wire-encoding
    // guidance, so the contract's array-free sentence rides along verbatim the
    // moment this card's T3 ships it — and that relay is exactly what AC-3 asks
    // for (an agent reading `tools/list` sees the contract's own words). What
    // REQ-1412 owns is the ADVERTISEMENT: a union in the JSON Schema a client
    // parses, or a sentence in the wire guidance telling the client a string is
    // accepted at this slot. Neither is present, and neither is asserted by
    // matching on the description's prose — which would conflate the relay of the
    // contract (this card) with the server's own advertisement (REQ-1412).
  });
});