import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * REQ-1432 T5 — AC-1: `figpea_call` must state the TOTAL serialized size limit
 * on args for EVERY call, with a working per-call budget.
 *
 * The card's evidence: a run authoring a page through `figpea_call` had a ~28 KB
 * `layer.batch` payload refused outright, and rebuilt the page in ~6 smaller
 * calls. The limit is real and was hit three times in one run. What made it
 * expensive is that nothing advertised it — so the only way to learn the budget
 * was to be refused, and the refusal named image staging for a payload with no
 * bytes on it.
 *
 * AC-1 is about what an agent can READ, so this reads what actually ships.
 *
 * WHAT IS ASSERTED, AND WHERE FROM. Everything comes out of a REAL `tools/list`
 * over the SDK's `InMemoryTransport`, never out of the zod shape — the same
 * distinction REQ-1282 made and verified in this repo (REQ-1268,
 * `mcpServer.ts`): the SDK's zod→JSON Schema conversion prefers a `meta`
 * description over `.describe()`, so a sentence that only lives in
 * `.describe()` is the half that does NOT reach a client. Both halves are
 * therefore asserted separately below.
 *
 * THE LIMIT ITSELF IS NOT ASSERTED AS A LITERAL. Today's number is quoted so an
 * agent reading only the tool description can size a call today, but the pin is
 * that the description carries the AUTHORITATIVE POINTER
 * (`describe().limits.argsChars`) — the editor owns the number and this
 * description is prose. A future threshold move is then a one-line edit here
 * rather than a silent lie, and the number quoted here can never disagree with
 * the guard while the pointer is present.
 */

import { createMcpServer } from './mcpServer';

interface BridgeStub {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

const MANIFEST = {
  version: '2.60.0',
  session: {
    layerTree: { doc: 'Returns the layer tree.', params: {}, result: {} },
  },
  layer: {
    create: {
      doc: 'Creates a layer.',
      params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } },
      result: {},
    },
    batch: {
      doc: 'Applies a sequence of layer ops as ONE undo step, all-or-nothing.',
      params: { ops: { type: 'array', required: true } },
      result: {},
    },
  },
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function fakeBridge(): BridgeStub {
  return {
    port: 54321,
    token: 'test-token-abc',
    isTabConnected: () => true,
    onDescribe: (handler) => handler(MANIFEST),
    callTab: async () => ({ ok: true, value: null }),
    close: async () => {},
  };
}

async function connectedClient(toolMode: 'compact' | 'full') {
  const server = createMcpServer(fakeBridge(), { toolMode });
  const client = new Client({ name: 'req-1432-tool-description-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** Every integer the text states. */
function numbersIn(text: string): number[] {
  return (text.match(/\d[\d,]*/g) ?? []).map((n) => Number(n.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

/**
 * The text AC-1 requires of an advertised `figpea_call` description.
 *
 * - states that the limit is on the TOTAL args size, for EVERY call, so an
 *   agent does not read it as applying to image payloads alone (the card's
 *   complaint, and what the previous image-only text implied);
 * - carries a concrete per-call budget to aim at;
 * - points at the authoritative source (`describe().limits.argsChars`) so the
 *   quoted number cannot silently outlive the real one;
 * - offers the chunk remedy, and says a chunk is its own undo step — the honest
 *   answer for a caller who wanted one atomic call.
 */
function expectArgsBudget(description: string | undefined, where: string): void {
  expect(description, `${where} carries a description at all`).toBeTruthy();
  const text = description!;

  expect(
    text,
    `${where}: states the limit is on the TOTAL serialized args size`,
  ).toMatch(/total[^.]*(serialized|serialised|args|argument)/i);
  expect(
    text,
    `${where}: says it applies to every call, not only image payloads`,
  ).toMatch(/every call|any call|all calls|regardless of/i);

  // The authoritative pointer — the live value, owned by the editor.
  expect(
    text,
    `${where}: points at describe().limits.argsChars so the quoted number cannot outlive the real one`,
  ).toMatch(/describe\(\)[\s\S]{0,40}limits[\s\S]{0,20}argsChars/);

  // A concrete budget, and a chunk recipe with the honest undo consequence.
  expect(text, `${where}: offers the chunk remedy`).toMatch(/split|chunk/i);
  expect(
    text,
    `${where}: says each chunk is its own undo step, so the caller is not promised one atomic call`,
  ).toMatch(/undo step/i);
  expect(
    numbersIn(text).length,
    `${where}: quotes at least one concrete character budget to aim at`,
  ).toBeGreaterThan(0);
}

describe('REQ-1432 AC-1 — figpea_call advertises the total args size limit and a per-call budget', () => {
  it('the tool description states it, from a real tools/list dump', async () => {
    const client = await connectedClient('compact');
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'figpea_call');
    expect(tool, 'figpea_call is registered in compact mode').toBeDefined();
    expectArgsBudget(tool!.description, 'figpea_call description');
  });

  it('the args param description states it too — the .meta() half the SDK actually serves', async () => {
    const client = await connectedClient('compact');
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'figpea_call') as any;
    const property = tool?.inputSchema?.properties?.args;
    expect(property, 'figpea_call advertises an `args` parameter').toBeDefined();
    // Not "the description is nice" — the exact claim AC-1 makes, on the half
    // of the schema a type-respecting client actually reads. Asserting only
    // `.describe()` would leave the advertised half silent (REQ-1268/REQ-1282).
    expectArgsBudget(property?.description, 'figpea_call args (tools/list)');
  });

  it('the description is not scoped to images — the card ran this with no bytes on it', async () => {
    const client = await connectedClient('compact');
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'figpea_call') as any;
    const text = `${tool?.description ?? ''}\n${tool?.inputSchema?.properties?.args?.description ?? ''}`;
    expect(text, 'the budget text exists at all').toBeTruthy();
    // An image-only caveat is fine to KEEP alongside the general limit (REQ-871's
    // advice is still correct for an image payload); what must not happen is the
    // general limit being reachable only through it.
    const general = /total[^.]*(serialized|serialised|args|argument)/i;
    expect(
      general.test(text),
      'the general limit is stated in its own right, not only under an image caveat',
    ).toBe(true);
  });
});