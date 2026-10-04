import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { wireEncoding, namedKeyEncodingLine, arraySlotEncodingLine } from './wireShape';
import { buildToolsFromManifest } from './tools';

/**
 * REQ-1498 (AC-5) — nothing in the tool surface says the ops array goes into
 * `args[0]` unwrapped, so the mistake is only visible on the call.
 *
 * `figpea_describe({group:'layer', method:'batch'})` returns `params.ops`
 * declared as `type: "array"`, `wire.callAs: "layer.batch(ops)"` and
 * `wire.args: [{index:0, name:'ops', type:'array', required:true}]`. That is a
 * DECLARATION plus a bare identifier that reads like a keyword argument — and
 * `wireShape.ts`'s whole per-method note speaks only about OBJECT-valued
 * parameters. So an agent that has just paid a describe round trip learns the
 * array's type and none of its encoding, and finds out by being refused with
 * `batch(): ops must be a non-empty array of {method, args} operations`.
 *
 * ⛔ The assertions below are REACHABILITY checks on the response's own rendered
 * text, not on a schema key: AC-5 asks that the sentence be present IN THE TEXT
 * an agent reads, so a key whose value is never rendered to the agent would not
 * satisfy it, and neither would passing while a sentence elsewhere drifts.
 *
 * ⛔ DERIVED. Every fixture that must gain the lesson is built AT THE CALL SITE
 * — a second method this module has never seen — so nothing here can pass on a
 * hard-coded `layer.batch`.
 */

// A fixture manifest carrying four shapes: the method the card is about (a
// single array param), a SECOND array-param method that must gain the lesson
// with no per-method edit, an object-param method (which must keep its existing
// sentence and must NOT gain an array one), and a scalar-only method.
const MANIFEST = {
  layer: {
    batch: {
      doc: 'Applies a sequence of layer ops as ONE undo step, all-or-nothing.',
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
    stylePatch: {
      doc: 'Patches a layer by id.',
      params: {
        id: { type: 'string', required: true },
        patch: { type: 'object', required: true, shape: { x: { type: 'number', required: false }, y: { type: 'number', required: false } } },
      },
      result: 'void',
    },
    setName: {
      doc: 'Renames a layer.',
      params: { id: { type: 'string', required: true }, name: { type: 'string', required: true } },
      result: 'void',
    },
  },
  // A method invented for this file, published the same shape as `layer.batch`:
  // if the sentence is hard-coded per method, this one cannot have it.
  doc: {
    applyPages: {
      doc: 'Applies a sequence of page ops.',
      params: {
        pages: {
          type: 'array',
          required: true,
          of: {
            type: 'object',
            required: true,
            shape: { id: { type: 'string', required: true }, props: { type: 'object', required: true, shape: { name: { type: 'string', required: false } } } },
          },
        },
      },
      result: 'void',
    },
  },
};

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

function makeStub() {
  const stub = {
    port: 54323,
    token: 'test-token-req1498-describe',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      h(MANIFEST);
    },
    callTab: async () => ({ ok: true, value: {} }),
    close: async () => {},
  };
  return stub;
}

async function connect(mode: 'compact' | 'full' = 'compact') {
  const server = createMcpServer(makeStub() as never, { toolMode: mode } as never);
  const client = new Client({ name: 'req1498-describe-encoding-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function describeMethod(client: Client, group: string, method: string): Promise<any> {
  const result: any = await client.callTool({ name: 'figpea_describe', arguments: { group, method } } as any);
  const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
  return JSON.parse(text);
}

async function listDescriptions(client: Client): Promise<Record<string, string>> {
  const listed: any = await client.listTools();
  const out: Record<string, string> = {};
  for (const tool of listed.tools as Array<{ name: string; description?: string }>) out[tool.name] = tool.description ?? '';
  return out;
}

// ── what the sentence must actually say, asserted as behaviour ─────────────

/**
 * The claim AC-5 makes. Deliberately two separate assertions: an agent must be
 * told WHERE the array goes (`args[N]`, this slot's own index) AND that it goes
 * there as itself rather than inside a wrapper.
 */
function expectStatesTheArrayEncoding(text: string, where: string, slotIndex: number): void {
  expect(text, `${where} carries text at all`).toBeTruthy();
  // "…is passed as ONE element of args[0]" — the position, by index.
  expect(text, `${where} names args[${slotIndex}]`).toMatch(new RegExp(`args\\[${slotIndex}\\]`));
  // …and that the ARRAY itself is what goes there.
  expect(text, `${where} says the array itself goes there`).toMatch(/the array itself/i);
  // …unwrapped. A bare identifier that reads like a keyword argument is the
  // defect, so "never inside an object/wrapper" has to be stated too.
  expect(text, `${where} says it is not wrapped`).toMatch(/never .*(wrapper|envelope|object)/i);
}

/** The worked payload: an array literal rendered from the slot's OWN declared
 *  element shape. A rule with no payload to copy is what this card is about. */
function expectCarriesAWorkedPayload(text: string, where: string, elementKeys: string[]): void {
  const arrayLiteral = /\[\{\s*"[A-Za-z_$][\w$]*"\s*:/.exec(text);
  expect(arrayLiteral, `${where} carries an array-of-objects payload to copy`).toBeTruthy();
  const start = arrayLiteral!.index;
  const rendered = text.slice(start, start + 400);
  for (const key of elementKeys) {
    expect(rendered, `${where}'s payload declares "${key}" from the slot's own shape`).toContain(`"${key}"`);
  }
}

// ───────────────────────────────────────────────────────────────────────────

describe('figpea_describe states in its OWN text that an array parameter is args[N] itself', () => {
  it('layer.batch: the per-method response names args[0] and shows a payload to copy', async () => {
    const client = await connect('compact');
    const response = await describeMethod(client, 'layer', 'batch');

    expect(response.ok).toBe(true);
    // The wire block is where the encoding lives…
    expect(response.wire, 'the per-method response carries wire').toBeDefined();
    expectStatesTheArrayEncoding(response.wire.note, 'wire.note', 0);
    // …and it must be reachable in the text the agent actually reads, not only
    // reachable by walking a field.
    expectStatesTheArrayEncoding(JSON.stringify(response), 'the whole per-method response', 0);
    expectCarriesAWorkedPayload(JSON.stringify(response), 'the whole per-method response', ['method', 'args']);
  });

  it('the slot itself is described as holding the array, with its index', async () => {
    const client = await connect('compact');
    const response = await describeMethod(client, 'layer', 'batch');
    const slot = (response.wire?.args ?? []).find((a: any) => a.type === 'array');

    expect(slot, 'wire.args lists the array slot').toBeDefined();
    expect(slot.index).toBe(0);
    expect(slot.name).toBe('ops');
  });

  it('is DERIVED: a second method with an array param states it with no per-method edit', async () => {
    const client = await connect('compact');
    const response = await describeMethod(client, 'doc', 'applyPages');

    expectStatesTheArrayEncoding(response.wire.note, 'wire.note (doc.applyPages)', 0);
    expectStatesTheArrayEncoding(JSON.stringify(response), 'the whole response (doc.applyPages)', 0);
    expectCarriesAWorkedPayload(JSON.stringify(response), 'the whole response (doc.applyPages)', ['id', 'props']);
  });

  it('is ABSENT for a method with no array/matrix slot', async () => {
    const client = await connect('compact');
    const scalars = await describeMethod(client, 'layer', 'setName');
    expect(scalars.wire.note).not.toMatch(/the array itself/i);

    // And an object-param method keeps its own (object) rule without being told
    // about arrays it does not have.
    const objectOnly = await describeMethod(client, 'layer', 'stylePatch');
    expect(objectOnly.wire.note).toMatch(/object-valued parameter IS its positional slot/i);
    expect(objectOnly.wire.note).not.toMatch(/the array itself/i);
  });

  it('one derivation feeds both lanes: the same sentence is in the compact wire note AND full mode\'s tool description', async () => {
    const compact = await connect('compact');
    const compactNote = (await describeMethod(compact, 'layer', 'batch')).wire.note;

    const full = await connect('full');
    const descriptions = await listDescriptions(full);
    const batchDescription = descriptions.layer_batch;
    expect(batchDescription, 'full mode advertises layer_batch').toBeTruthy();

    // Not "both mention arrays" — the ONE sentence, present in both.
    expect(batchDescription).toContain(compactNote);
    expectStatesTheArrayEncoding(batchDescription, 'the generated layer_batch tool description', 0);
    expectCarriesAWorkedPayload(batchDescription, 'the generated layer_batch tool description', ['method', 'args']);

    // And it is a REACHABILITY check on tools/list output, not a helper's return
    // value: what an MCP client reads is this string.
    expect(descriptions.doc_applyPages, 'the derived method also gets it').toBeTruthy();
    expectStatesTheArrayEncoding(descriptions.doc_applyPages, 'the generated doc_applyPages tool description', 0);
    expect(descriptions.layer_setName, 'a scalar-only tool exists').toBeTruthy();
    expect(descriptions.layer_setName).not.toMatch(/the array itself/i);
  });

  it('the exported helpers agree with what the server serves — no second wording', () => {
    const batchDescriptor = MANIFEST.layer.batch;
    const wire = wireEncoding(batchDescriptor, 'layer.batch');
    expect(wire).toBeDefined();
    const line = arraySlotEncodingLine(batchDescriptor);
    expect(line).toBeTruthy();
    // Full mode's line must CONTAIN the compact lane's sentence verbatim.
    expect(line).toContain(wire!.note);

    // A method with no array slot produces no line at all — an empty string
    // would ship as a stray blank line in every generated description.
    expect(arraySlotEncodingLine(MANIFEST.layer.setName)).toBeUndefined();
    expect(arraySlotEncodingLine(MANIFEST.layer.stylePatch)).toBeUndefined();
    expect(arraySlotEncodingLine(undefined)).toBeUndefined();
    // The object line is unchanged and still there for an object-param method.
    expect(namedKeyEncodingLine(MANIFEST.layer.stylePatch)).toBeTruthy();
    expect(namedKeyEncodingLine(batchDescriptor), 'an array-only method has no object slot to warn about').toBeUndefined();
  });

  it('the generated description carries BOTH lines for a method that has both an object and an array slot', () => {
    const both = {
      mixed: {
        doc: 'Has one of each.',
        params: {
          options: { type: 'object', required: false, shape: { scale: { type: 'number', required: false } } },
          items: { type: 'array', required: false, of: { type: 'object', required: true, shape: { id: { type: 'string', required: true } } } },
        },
        result: 'void',
      },
    };
    const tool = buildToolsFromManifest({ g: both } as any).find((t) => t.name === 'g_mixed');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain(namedKeyEncodingLine(both.mixed)!);
    expect(tool!.description).toContain(arraySlotEncodingLine(both.mixed)!);
  });
});