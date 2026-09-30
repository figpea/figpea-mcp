import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * REQ-1282 T5 — AC-5: the shipped tool descriptions have to carry the advice.
 *
 * The knob is not the hard part. `_timeoutMs` has existed since REQ-772 and
 * works; what is missing is that nobody learns it exists, let alone that the
 * default is *sometimes* too low. `buildInputShape` declares the reserved key
 * with no description at all, so in full mode every generated contract tool
 * advertises the knob blind, and `figpea_call`'s description never mentions a
 * burst. An agent that cannot see the problem cannot pass the fix for it, and
 * rediscovers the wall by timing out — which is the outcome AC-5 exists to
 * prevent.
 *
 * WHAT IS ASSERTED, AND WHERE FROM. Everything is read out of a REAL
 * `tools/list` over the SDK's `InMemoryTransport`, never out of the zod shape.
 * That distinction is load-bearing and was verified in this repo rather than
 * assumed (REQ-1268, `mcpServer.ts`): the SDK's zod→JSON Schema conversion
 * takes a `meta` description in PREFERENCE to `.describe()`, so a description
 * that only lives in `.describe()` is the half that does not ship. A test
 * against the zod shape would pass while `tools/list` stayed empty — which is
 * the exact half of the bug this task fixes.
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

/** A manifest wide enough that "every generated contract tool" is a real
 * sweep: two groups, a zero-param method, a mutator and a read. */
const MANIFEST = {
  version: '1.8.0',
  session: {
    layerTree: { doc: 'Returns the layer tree.', params: {}, result: {} },
    find: { doc: 'Finds layers by selector.', params: { selector: { type: 'object', required: true } }, result: {} },
  },
  layer: {
    create: {
      doc: 'Creates a layer.',
      params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } },
      result: {},
    },
    setPosition: {
      doc: 'Places a layer visible box at world coords.',
      params: { id: { type: 'string', required: true }, pos: { type: 'object', required: true } },
      result: {},
    },
  },
  canvas: {
    screenshot: { doc: 'Captures a canvas region.', params: { artboardId: { type: 'string', required: false } }, result: {} },
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
  const client = new Client({ name: 'req-1282-tool-description-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** The text a description must carry for AC-5: the default is sometimes too
 * low, the situation where that happens is named, the knob is named, and the
 * cap keeps its digits so it matches the README and the code. */
function expectBurstAdvice(description: string | undefined, where: string): void {
  expect(description, `${where} carries a description at all`).toBeTruthy();
  const text = description!;
  expect(text, `${where}: names the burst in which the default is too low`).toMatch(/burst of mutations/i);
  expect(text, `${where}: says the default can be too low, so the agent knows it is a real risk`).toMatch(
    /default[^.]*can be too low/i,
  );
  expect(text, `${where}: names the knob as the deliberate fix`).toContain('_timeoutMs');
  expect(text, `${where}: the cap keeps its digits, matching MAX_CALL_TIMEOUT_MS and the README`).toContain('120000');
}

describe('REQ-1282 AC-5 — figpea_call tells the agent when to reach for _timeoutMs', () => {
  it('its own description states the burst case, from a real tools/list dump', async () => {
    const client = await connectedClient('compact');
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'figpea_call');
    expect(tool, 'figpea_call is registered in compact mode').toBeDefined();
    expectBurstAdvice(tool!.description, 'figpea_call description');
  });

  it('its _timeoutMs key is advertised in the .meta() half the SDK actually serves', async () => {
    const client = await connectedClient('compact');
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'figpea_call') as any;
    const property = tool?.inputSchema?.properties?._timeoutMs;
    expect(property, 'figpea_call advertises the reserved _timeoutMs key').toBeDefined();
    // Not "the description is nice" — the exact claim AC-5 makes, on the half
    // of the schema a type-respecting client reads.
    expectBurstAdvice(property?.description, 'figpea_call _timeoutMs (tools/list)');
  });
});

describe('REQ-1282 AC-5 — every generated contract tool carries the same advice (full mode)', () => {
  /** The generated tool names, derived from the manifest by the server's own
   * rule (`${group}_${method}`, minus the reserved flat keys) rather than
   * hardcoded — so "every generated contract tool" is a real sweep, and the
   * static tools (`open_editor` and friends, which also contain an
   * underscore) are not mistaken for contract tools. */
  const generatedToolNames = Object.entries(MANIFEST)
    .filter(([group]) => group !== 'version' && group !== 'errorCodes')
    .flatMap(([group, methods]) => Object.keys(methods as Record<string, unknown>).map((method) => `${group}_${method}`))
    .sort();

  it('the sweep really covers every generated contract tool, and all of them describe _timeoutMs usefully', async () => {
    const client = await connectedClient('full');
    const { tools } = await client.listTools();
    const contractTools = tools.filter((t) => generatedToolNames.includes(t.name));
    expect(
      contractTools.map((t) => t.name).sort(),
      'the sweep is every generated contract tool, not a convenient subset',
    ).toEqual(generatedToolNames);
    expect(
      contractTools.map((t) => t.name),
      'and it covers mutators, reads and a zero-param method',
    ).toEqual(
      expect.arrayContaining(['session_layerTree', 'session_find', 'layer_create', 'layer_setPosition', 'canvas_screenshot']),
    );

    for (const tool of contractTools) {
      const property = (tool as any)?.inputSchema?.properties?._timeoutMs;
      expect(property, `${tool.name} advertises the reserved _timeoutMs key`).toBeDefined();
      expectBurstAdvice(property?.description, `${tool.name} _timeoutMs (tools/list)`);
    }
  });

  it('the cap in the advertised text is the real cap, so an agent can compute a legal value', async () => {
    const client = await connectedClient('full');
    const { tools } = await client.listTools();
    const described = tools
      .map((t) => (t as any)?.inputSchema?.properties?._timeoutMs?.description as string | undefined)
      .filter((d): d is string => typeof d === 'string');
    expect(described.length, 'at least one _timeoutMs description was advertised').toBeGreaterThan(0);
    for (const description of described) {
      const numbers = (description.match(/\d+/g) ?? []).map(Number);
      expect(
        numbers.length,
        `the advice quotes at least one concrete millisecond value to copy: ${description}`,
      ).toBeGreaterThan(0);
      expect(
        numbers.every((n) => n <= 120_000),
        `every number offered is a legal value, i.e. not above the cap: ${description}`,
      ).toBe(true);
      expect(description, 'the cap is spelled with digits, as the README and the code spell it').toContain('120000');
    }
  });
});
