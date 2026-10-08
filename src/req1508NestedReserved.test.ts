import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';
import { startBridgeServer } from './bridgeServer';

/**
 * REQ-1508 T1 — failing acceptance tests for the defect the card's Evidence
 * names: `returnAs:"path"` nested inside `args` is silently ignored, and
 * `export.artboard` answers `{ok:true, isError:false}` with the image inline
 * and no `path`.
 *
 * The spec here is the AC text, not this repo's implementation:
 *   - AC-1 the Evidence form — `returnAs:"path"` (and `_rawJson`) nested in
 *     the options object at `args[1]`, plus the same key buried in a
 *     `layer.batch` op's inner args. The closed behaviour is the card's reject
 *     arm: `ok:false`/`invalid_params` naming the key as a figpea_call-level
 *     parameter, with `isError:true` (the REQ-1296 D3 envelope agents already
 *     read). Pre-fix every one of these answers inline success.
 *   - AC-2 the conditioned invariant (plan §Notes): every *path-requested*
 *     binary either lands on disk or fails loud — top-level `path` on artboard
 *     and project, and the nested mistake refused instead of succeeding
 *     silently. The default inline lane is pinned untouched as the control.
 *   - AC-4 the regression pin: `export.project` with top-level
 *     `returnAs:"path"` still returns `{ok:true, path, filename, mime, bytes}`
 *     exactly as REQ-1279 shipped it.
 *
 * Harness: a real MCP SDK `Client` over `InMemoryTransport` around a real
 * `startBridgeServer({port: 0})` with a stubbed `callTab` — the REQ-1279 /
 * REQ-1296 shape. The `.fp` payload is the real `req1279-tiny.fp` fixture.
 */

const FIXTURE = path.join(__dirname, '__fixtures__', 'req1279-tiny.fp');
const FP_BYTES = fs.readFileSync(FIXTURE);
const FP_B64 = FP_BYTES.toString('base64');
const ART_B64 = Buffer.from('req1508-artboard-png').toString('base64');

const MANIFEST: any = {
  export: {
    artboard: {
      doc: 'Exports an artboard as a raster image.',
      params: {
        id: { type: 'string', required: true },
        options: { type: 'object', required: false },
      },
      result: 'image',
    },
    project: {
      doc: 'Exports the whole project as pdf/zip/figpea.',
      params: {
        input: {
          type: 'object',
          required: false,
          shape: { format: { type: 'string', required: false, enum: ['pdf', 'zip', 'figpea'] } },
        },
      },
      result: 'binary',
    },
  },
  layer: {
    batch: {
      doc: 'Applies a batch of ops.',
      params: { ops: { type: 'array', required: true } },
      result: {},
    },
  },
};

/** The payloads the stub tab returns, keyed by `group.method`. */
function payloadFor(group: string, method: string): unknown {
  if (group === 'export' && method === 'artboard') {
    return { bytes: ART_B64, mime: 'image/png', width: 320, height: 240, filename: 'artboard-badge.png' };
  }
  if (group === 'export' && method === 'project') {
    return { bytes: FP_B64, mime: 'application/zip', filename: 'My Design.fp' };
  }
  if (group === 'layer' && method === 'batch') {
    return { applied: 1 };
  }
  throw new Error(`stub tab has no payload for ${group}.${method}`);
}

interface Call {
  name: string;
  args: unknown[];
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function createHarnessedClient() {
  const realBridge: any = await startBridgeServer({ port: 0 });
  const calls: Call[] = [];
  const stub: any = {
    port: realBridge.port,
    token: realBridge.token,
    isTabConnected: () => true,
    onDescribe: (h: any) => h(MANIFEST),
    callTab: async (group: string, method: string, args: unknown[]) => {
      calls.push({ name: `${group}_${method}`, args });
      return { ok: true, value: payloadFor(group, method) };
    },
    close: () => realBridge.close(),
    getFileUrl: (fp: string) => realBridge.getFileUrl(fp),
    registerBlob: (fp: string) => realBridge.registerBlob(fp),
  };
  const server = createMcpServer(stub as any, { toolMode: 'compact' });
  const client = new Client({ name: 'req1508-nested-reserved', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
    await realBridge.close();
  });
  return { client, calls };
}

function textOf(res: any): string {
  const blocks = (res.content as any[]).filter((c: any) => c.type === 'text');
  expect(blocks, 'a text content block is present').toHaveLength(1);
  return blocks[0].text;
}
function payloadOf(res: any): any {
  return JSON.parse(textOf(res));
}
function hasImageBlock(res: any): boolean {
  return (res.content as any[]).some((c: any) => c.type === 'image');
}

describe('REQ-1508 AC-1: a reserved key nested inside args is refused, not silently ignored', () => {
  it('nested returnAs:"path" in args[1] fails naming returnAs as a figpea_call-level parameter', async () => {
    const { client, calls } = await createHarnessedClient();
    const res: any = await client.callTool({
      name: 'figpea_call',
      // The card's Evidence form: the natural spelling of "write this export
      // to disk". Today this answers inline success with no `path`.
      arguments: {
        group: 'export',
        method: 'artboard',
        args: ['page-1', { format: 'png', returnAs: 'path' }],
      } as any,
    });
    expect(res.isError, 'a misplaced figpea_call parameter is an error, never a success').toBe(true);
    expect(hasImageBlock(res), 'no inline image crosses the wire on a refused call').toBe(false);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(false);
    expect(payload.code, 'the failure is a parameter failure').toBe('invalid_params');
    expect(payload.message, 'the message names the offending key').toContain('"returnAs"');
    expect(payload.message, 'the message names the position it was found at').toContain('args[1]');
    expect(payload.message, 'the message teaches the correct form').toContain('sibling of group/method/args');
    expect(calls, 'a refused call costs zero tab round trips').toHaveLength(0);
  });

  it('nested _rawJson in args[1] is refused the same way', async () => {
    const { client, calls } = await createHarnessedClient();
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: {
        group: 'export',
        method: 'artboard',
        args: ['page-1', { format: 'png', _rawJson: true }],
      } as any,
    });
    expect(res.isError, 'the second reserved key is the same failure class').toBe(true);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('invalid_params');
    expect(payload.message, 'the message names the offending key').toContain('"_rawJson"');
    expect(payload.message, 'the message names the position it was found at').toContain('args[1]');
    expect(calls, 'a refused call costs zero tab round trips').toHaveLength(0);
  });

  it('returnAs buried in a layer.batch op inner args is refused too', async () => {
    const { client, calls } = await createHarnessedClient();
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: {
        group: 'layer',
        method: 'batch',
        args: [[{ method: 'create', args: ['rect', { name: 'probe', returnAs: 'path' }] }]],
      } as any,
    });
    expect(res.isError, 'one level down is still inside args').toBe(true);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('invalid_params');
    expect(payload.message, 'the message names the offending key').toContain('"returnAs"');
    expect(payload.message, 'the message names the outer position').toContain('args[0]');
    expect(calls, 'a refused call costs zero tab round trips').toHaveLength(0);
  });
});

describe('REQ-1508 AC-2: no path-requested binary answers inline success', () => {
  it('top-level returnAs:"path" on artboard lands on disk — no image block, isError:false', async () => {
    const { client } = await createHarnessedClient();
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group: 'export', method: 'artboard', args: ['page-1', { format: 'png' }], returnAs: 'path' } as any,
    });
    expect(res.isError, 'path mode is not an error').toBe(false);
    expect(hasImageBlock(res), 'no image block crosses the wire').toBe(false);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(true);
    expect(typeof payload.path, 'a path came back').toBe('string');
    expect(textOf(res), 'no base64 is relayed to the caller').not.toContain(ART_B64);
  });

  it('top-level returnAs:"path" on project lands on disk — no binary block, isError:false', async () => {
    const { client } = await createHarnessedClient();
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group: 'export', method: 'project', args: [{ format: 'figpea' }], returnAs: 'path' } as any,
    });
    expect(res.isError, 'path mode is not an error').toBe(false);
    expect(hasImageBlock(res), 'no binary block crosses the wire').toBe(false);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(true);
    expect(payload.path, 'a .fp path came back').toMatch(/\.fp$/);
    expect(textOf(res), 'no base64 is relayed to the caller').not.toContain(FP_B64);
  });

  it('the inline default is untouched: artboard without returnAs still answers an image block with isError:false', async () => {
    // GREEN ON ARRIVAL — the designed default REQ-1020/REQ-1279 own. Pinned
    // so the fix cannot be read as forbidding inline binaries outright (the
    // literal AC-2 reading the plan conditions away).
    const { client } = await createHarnessedClient();
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group: 'export', method: 'artboard', args: ['page-1', { format: 'png' }] } as any,
    });
    expect(res.isError, 'the default lane stays a success').toBe(false);
    expect(hasImageBlock(res), 'the default lane still carries the image inline').toBe(true);
    expect(payloadOf(res).ok).toBe(true);
  });
});

describe('REQ-1508 AC-4 (pin): export.project with returnAs:"path" keeps its exact payload shape', () => {
  it('returns {ok:true, path, filename, mime, bytes} and the bytes on disk are the payload', async () => {
    const { client } = await createHarnessedClient();
    const res: any = await client.callTool({
      name: 'figpea_call',
      arguments: { group: 'export', method: 'project', args: [{ format: 'figpea' }], returnAs: 'path' } as any,
    });
    expect(res.isError).toBe(false);
    const payload = payloadOf(res);
    expect(payload.ok).toBe(true);
    expect(payload.path, 'the path ends in .fp, never .bin').toMatch(/\.fp$/);
    expect(payload.filename, 'the payload name is reported back').toBe('My Design.fp');
    expect(payload.mime).toBe('application/zip');
    expect(payload.bytes, 'bytes is the decoded payload length').toBe(FP_BYTES.length);
    expect(fs.readFileSync(payload.path).equals(FP_BYTES), 'the bytes on disk are the payload').toBe(true);
  });
});

describe('REQ-1508 AC-1: findNestedReservedKeys — the pure scanner, unit-tested with no bridge', () => {
  // Imported lazily so this block fails on ASSERTIONS (the scanner is absent
  // on the unfixed tree), never on a static import the test-only commit could
  // not compile — the REQ-1296 precedent.
  let findNestedReservedKeys: (args: unknown) => Array<{ path: string; key: string }>;
  let NESTED_RESERVED: readonly string[];

  beforeAll(async () => {
    ({ findNestedReservedKeys, NESTED_RESERVED } = await import('./unknownParams'));
  });

  it('exposes exactly the card-named pair', () => {
    expect([...(NESTED_RESERVED as readonly string[])]).toEqual(['returnAs', '_rawJson']);
  });

  it('finds a reserved key in an options object at args[1]', () => {
    expect(findNestedReservedKeys(['page-1', { format: 'png', returnAs: 'path' }])).toEqual([
      { path: 'args[1].returnAs', key: 'returnAs' },
    ]);
  });

  it('reports every reserved key when both arrive in one object', () => {
    expect(findNestedReservedKeys([{ returnAs: 'path', _rawJson: true }])).toEqual([
      { path: 'args[0].returnAs', key: 'returnAs' },
      { path: 'args[0]._rawJson', key: '_rawJson' },
    ]);
  });

  it('descends into a layer.batch op inner args', () => {
    expect(
      findNestedReservedKeys([[{ method: 'create', args: ['rect', { name: 'probe', returnAs: 'path' }] }]]),
    ).toEqual([{ path: 'args[0][0].args[1].returnAs', key: 'returnAs' }]);
  });

  it('skips non-plain objects: a class instance carrying the key is not caller evidence', () => {
    class Options {
      returnAs = 'path';
    }
    expect(findNestedReservedKeys(['page-1', new Options()])).toEqual([]);
  });

  it('reads own keys only: an inherited key is not a hit', () => {
    expect(findNestedReservedKeys(['page-1', Object.create({ returnAs: 'path' })])).toEqual([]);
  });

  it('judges keys, not values: a VALUE equal to a reserved name is not a hit', () => {
    expect(findNestedReservedKeys(['page-1', { label: 'returnAs' }])).toEqual([]);
    expect(findNestedReservedKeys(['returnAs'])).toEqual([]);
  });

  it('is total over scalars, nullish positions and the empty call', () => {
    expect(findNestedReservedKeys([])).toEqual([]);
    expect(findNestedReservedKeys(['page-1', null, undefined, 1, 'x', true])).toEqual([]);
    expect(findNestedReservedKeys(undefined)).toEqual([]);
  });
});
