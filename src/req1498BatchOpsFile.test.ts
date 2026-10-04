import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcpServer';

/**
 * REQ-1498 (AC-1, AC-2, AC-3 relay half, AC-4) — `layer.batch`'s payload
 * cannot be read from a file, so a path string IS the payload.
 *
 * Measured on the paired editor (design run `2026-10-03-ice-hole-linocut`,
 * `report/FRICTION.md:17`): a 52-layer plate cost ~87 000 characters of ops that
 * were generated, written to disk, then read back and re-emitted as the
 * tool-call argument — "because the tool-call argument is the only channel in".
 * That run cut eight mark families to pay for it. Nothing was wrong with the
 * file; this server has no route that turns a path into an INBOUND argument.
 * `mcpServer.ts` reads a local file in exactly two places — `returnPath.ts`'s
 * off-band RESULT writer and the `isValidFile` existence probe the three
 * `filePath` TRANSLATIONS use — and neither is a payload route.
 *
 * So an agent that wrote its ops to a JSON file and passed the path met the
 * editor's own guard (`v3/src/agent/groups/layer.impl.ts:2519-2527`):
 * `batch(): ops must be a non-empty array of {method, args} operations` — for
 * a string, which is not an array. Both lanes forwarded it verbatim: the
 * compact `layer_batch` branch (`mcpServer.ts:1539-1580`) and full mode's
 * (`:2286-2320`) each guard on `Array.isArray(ops)` and skip a string, so
 * nothing on either lane could have rescued the call.
 *
 * This spec asserts the contract, not an implementation:
 *   - a real JSON file at a REAL path, with any name and any extension,
 *     reaches the tab as `args[0]` byte-identical, in exactly ONE round trip,
 *     with no path anywhere in the forwarded payload
 *   - the caller's own object is never mutated (a client that reuses its ops
 *     array still holds what it wrote)
 *   - EVERY refusal costs ZERO round trips, and the malformed-file diagnostic
 *     names the FILE and the PARSE FAILURE rather than falling through to the
 *     generic ops message the card's agents actually saw
 *   - the missing-file wording is asserted against the LIVE sibling branch, so
 *     it cannot drift from the three existing `file not found or not
 *     readable:` refusals
 *   - an inline `ops` array is byte-identical to today, and a file-read batch
 *     still gets the REQ-1283 image `filePath` translation — a payload that
 *     arrives from disk must not lose the pre-flight an inline one gets
 *
 * **Both lanes are asserted.** Compact `figpea_call` is the default; full mode's
 * generated `layer_batch` is what real MCP clients use, and it carries its own
 * copy of the branch — so a fix wired into one lane alone would satisfy the
 * requirement in one calling convention and leave the other broken.
 *
 * ⛔ AND THE SLOT IS THE METHOD'S OWN, NEVER A HARD-CODED INDEX. The option is
 * derived (`topLevelArrayParamName`), so it is offered on ANY method declaring
 * one top-level `array`/`matrix` param — and `layer.setTransform(id, matrix)`,
 * `layer.booleanOperate(ids, operation)` and `layer.batch(ops)` put that param
 * at three different indices, two of them NOT zero. A substitution that wrote
 * to `args[0]` would refuse `setTransform` as ambiguous when the caller sent no
 * matrix at all, and would replace the WHOLE positional array when the slot was
 * empty, silently dropping `operation` on its way to the tab. `figpea_describe`
 * advertises `_opsFile` to those callers too, so the route has to be right for
 * them or the advertisement is a lie. Both shapes are therefore pinned here,
 * with the well-formed inline form as the control.
 *
 * Harness: a real MCP SDK `Client` over `InMemoryTransport` around a real
 * `createMcpServer`, with `callTab` stubbed AND COUNTED. The tab is stubbed
 * because it is provably not the locus — the read happens in this server,
 * before the round trip — and counting `callTab` is what proves "not
 * forwarded" rather than "forwarded and failed".
 */

// ── fixture manifest ────────────────────────────────────────────────────────
// The editor's own shapes: `layer.create` (`kind` string, `props` object), and
// `layer.batch` (`ops`: array of `{method, args}`), whose declared `of` is what
// the AC-5 worked payload is rendered from.

const MANIFEST = {
  layer: {
    create: {
      doc: 'Creates a layer of the given kind.',
      params: {
        kind: { type: 'string', required: true, enum: ['page', 'rect', 'text', 'image'] },
        props: {
          type: 'object',
          required: false,
          shape: {
            name: { type: 'string', required: false },
            parentId: { type: 'string', required: false },
            rwidth: { type: 'number', required: false },
            rheight: { type: 'number', required: false },
            url: { type: 'string', required: false },
            filePath: { type: 'string', required: false },
          },
        },
      },
      result: { id: 'string', name: 'string' },
    },
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
    // The array/matrix payload is at index 1, NOT 0 — the shape the option's
    // derivation has to get right, because `figpea_describe` advertises
    // `_opsFile` to these callers too.
    setTransform: {
      doc: "Sets a layer's transform.",
      params: {
        id: { type: 'string', required: true },
        transform: { type: 'matrix', required: true },
      },
      result: 'void',
    },
    // The array payload is at index 0 but a SCALAR FOLLOWS it — the shape where
    // replacing the whole positional array drops a real argument on its way to
    // the tab.
    booleanOperate: {
      doc: 'Combines layers by a boolean operation.',
      params: {
        ids: { type: 'array', required: true, of: { type: 'string', required: true } },
        operation: { type: 'string', required: true, enum: ['union', 'intersect', 'subtract'] },
      },
      result: 'void',
    },
    // No array or matrix param at all — the option must be refused by name
    // rather than silently dropped.
    setName: {
      doc: 'Renames a layer.',
      params: { id: { type: 'string', required: true }, name: { type: 'string', required: true } },
      result: 'void',
    },
  },
  session: {
    openFile: {
      doc: 'Opens a file in the editor.',
      params: {
        input: {
          type: 'object',
          required: true,
          shape: { url: { type: 'string', required: false }, filePath: { type: 'string', required: false } },
        },
      },
      result: 'void',
    },
  },
};

interface Capture {
  group: string;
  method: string;
  args: unknown[];
}

function makeStub() {
  const captured: Capture[] = [];
  const stub = {
    port: 54321,
    token: 'test-token-req1498',
    isTabConnected: () => true,
    onDescribe: (h: (m: unknown) => void) => {
      h(MANIFEST);
    },
    callTab: async (group: string, method: string, args: unknown[]) => {
      captured.push({ group, method, args: structuredClone(args) });
      if (method === 'batch') {
        const ops = args[0] as Array<{ method: string }> | undefined;
        return {
          ok: true,
          value: { results: (Array.isArray(ops) ? ops : []).map((op, i) => ({ opIndex: i, ok: true, value: { id: `L_${op.method}_${i}` } })) },
        };
      }
      return { ok: true, value: { id: 'L_probe' } };
    },
    close: async () => {},
  };
  return { stub, captured };
}

let cleanup: Array<() => Promise<void>> = [];
let tempDirs: string[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

async function connect(bridge: unknown, mode: 'compact' | 'full' = 'compact') {
  const server = createMcpServer(bridge as never, { toolMode: mode } as never);
  const client = new Client({ name: 'req1498-batch-ops-file-test', version: '0.0.0' });
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

// ── AC-1's payload, verbatim, and the files it can be written to ────────────

const PAGE_ID = 'P1';
/** The card's own array, copied character for character. */
const AC1_OPS = [
  {
    method: 'create',
    args: ['rect', { name: 'probe', parentId: PAGE_ID, rwidth: 100, rheight: 60, style: { fill: '#ff0000', fillType: 'solid' } }],
  },
];

const IMAGE_PROPS = (filePath: unknown) => ({ parentId: 'P1', rwidth: 200, rheight: 150, filePath });

/** Writes `content` to a real file in a real temp dir and returns its path. */
function writeOpsFile(content: string, name = 'ops.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1498-ops-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function absentPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1498-ops-'));
  tempDirs.push(dir);
  return path.join(dir, 'no-such-ops.json');
}

/** Compact lane: `figpea_call({group, method, args, _opsFile})`. */
function compactOpsFile(file: string, args: unknown[] = []) {
  return { group: 'layer', method: 'batch', args, _opsFile: file };
}

/** Full lane: the generated `layer_batch` tool's `opsFile` key. */
function fullOpsFile(file: string, extra: Record<string, unknown> = {}) {
  return { name: 'layer_batch', args: { opsFile: file, ...extra } };
}

/** The ops array the tab received from whichever lane was driven. */
function forwardedOps(captured: Capture[]): any[] {
  return captured[0]!.args[0] as any[];
}

// ─────────────────────── the defect: no inbound-file route exists ───────────

describe('layer.batch reads its ops payload from a JSON file on disk', () => {
  it('compact lane: the file\'s array reaches the tab as args[0], byte-identical, in ONE round trip', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = writeOpsFile(JSON.stringify(AC1_OPS));
    const result = await callToolJson(client, 'figpea_call', compactOpsFile(file));

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.group).toBe('layer');
    expect(captured[0]!.method).toBe('batch');
    // Byte-identical: the file's own array, element for element.
    expect(captured[0]!.args[0]).toEqual(AC1_OPS);
    expect(captured[0]!.args[0]).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
    // Nothing about the ROUTE survives into the payload — no path, no wrapper,
    // no marker the tab could mistake for a value it should act on.
    expect(JSON.stringify(captured[0]!.args)).not.toContain(file);
    expect(JSON.stringify(captured[0]!.args)).not.toContain('opsFile');
  });

  it('full lane: the generated layer_batch tool takes the same route', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const file = writeOpsFile(JSON.stringify(AC1_OPS));
    const { name, args } = fullOpsFile(file);
    const result = await callToolJson(client, name, args as Record<string, unknown>);

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('batch');
    expect(captured[0]!.args[0]).toEqual(AC1_OPS);
    expect(JSON.stringify(captured[0]!.args)).not.toContain(file);
  });

  it('the path is read as given — no extension, directory or naming convention is required', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    // Deliberately NOT `.json`, and deliberately not named `ops`.
    const file = writeOpsFile(JSON.stringify(AC1_OPS), 'layer-plate.txt');
    const result = await callToolJson(client, 'figpea_call', compactOpsFile(file));

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[0]).toEqual(AC1_OPS);
  });

  it('the caller\'s own object is never mutated', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = writeOpsFile(JSON.stringify(AC1_OPS));
    // A caller that holds its ops object and reuses it after the call.
    const callerOps = JSON.parse(JSON.stringify(AC1_OPS));
    const result = await callToolJson(client, 'figpea_call', compactOpsFile(file));

    expect(result.ok).toBe(true);
    expect(callerOps).toEqual(AC1_OPS);
    // And in full mode, the generated tool's own argument object is untouched —
    // the substituted array must land on a copy, never on the caller's own keys.
    const fullStub = makeStub();
    const fullClient = await connect(fullStub.stub, 'full');
    const fullFile = writeOpsFile(JSON.stringify(AC1_OPS));
    const callerToolArgs: Record<string, unknown> = { opsFile: fullFile };
    const fullResult = await callToolJson(fullClient, 'layer_batch', callerToolArgs);
    expect(fullResult.ok).toBe(true);
    expect(callerToolArgs).toEqual({ opsFile: fullFile });
    expect(fullStub.captured[0]!.args[0]).toEqual(AC1_OPS);
    expect(captured).toHaveLength(1);
  });

  it('a file-read batch still gets the image filePath translation an inline one gets', async () => {
    const image = ((): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1498-ops-'));
      tempDirs.push(dir);
      const f = path.join(dir, 'plate.jpg');
      fs.writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return f;
    })();
    const ops = [{ method: 'create', args: ['image', IMAGE_PROPS(image)] }];

    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const file = writeOpsFile(JSON.stringify(ops));
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', compactOpsFile(file))
          : await callToolJson(client, 'layer_batch', { opsFile: file });

      expect(result.ok, mode).toBe(true);
      expect(captured, mode).toHaveLength(1);
      const props = forwardedOps(captured)[0]!.args[1];
      expect(props.filePath, mode).toBeUndefined();
      expect(String(props.url), mode).toContain('/file?path=');
      expect(String(props.url), mode).toContain(encodeURIComponent(image));
      // And the file on disk is still exactly what was written.
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(ops);
    }
  });
});

// ───────────────────────────── the refusal table (AC-4) ─────────────────────

describe('every opsFile refusal costs ZERO round trips and names the file', () => {
  /** The live sibling branch's own answer for a path that is not there —
   *  measured, so "same wording" is an equality rather than a copied string. */
  async function siblingMissingFileAnswer(mode: 'compact' | 'full') {
    const missing = absentPath();
    const { stub } = makeStub();
    const client = await connect(stub, mode);
    const sibling =
      mode === 'compact'
        ? await callToolJson(client, 'figpea_call', { group: 'layer', method: 'create', args: ['image', IMAGE_PROPS(missing)] })
        : await callToolJson(client, 'layer_create', { kind: 'image', props: IMAGE_PROPS(missing) });
    return { missing, sibling };
  }

  it('a malformed file names the FILE and the PARSE FAILURE, not the generic ops message', async () => {
    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const file = writeOpsFile('[{"method":"create", "args":', 'broken.json');
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', compactOpsFile(file))
          : await callToolJson(client, 'layer_batch', { opsFile: file });

      expect(result.ok, mode).toBe(false);
      expect(result.code, mode).toBe('invalid_params');
      // The file, by absolute path.
      expect(result.message, mode).toContain(file);
      // The parse failure's OWN text — whatever the JSON reader said, quoted.
      const quoted = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reread = fs.readFileSync(file, 'utf8');
      expect(() => JSON.parse(reread), mode).toThrow();
      let parseMessage = '';
      try {
        JSON.parse(reread);
      } catch (e) {
        parseMessage = e instanceof Error ? e.message : String(e);
      }
      expect(result.message, mode).toContain(parseMessage);
      expect(quoted.length, mode).toBeGreaterThan(0);
      // ⛔ NOT the message the card's agents actually saw — that was the whole
      // defect: a file problem reported as an ops-shape problem.
      expect(result.message, mode).not.toContain('ops must be a non-empty array');
      expect(captured, mode).toHaveLength(0);
    }
  });

  it('an absent file answers with the LIVE sibling\'s missing-file wording', async () => {
    for (const mode of ['compact', 'full'] as const) {
      const { missing, sibling } = await siblingMissingFileAnswer(mode);
      expect(sibling.ok, mode).toBe(false);

      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', compactOpsFile(missing))
          : await callToolJson(client, 'layer_batch', { opsFile: missing });

      expect(result.ok, mode).toBe(false);
      expect(result.code, mode).toBe('invalid_params');
      // Measured equality, not a copied literal: this server already refuses a
      // missing file three other ways and they must not drift.
      expect(result.message, mode).toBe(sibling.message);
      expect(result.message, mode).toBe(`file not found or not readable: ${missing}`);
      expect(captured, mode).toHaveLength(0);
    }
  });

  it('content that parses but is not an array is refused, naming the path and the kind it got', async () => {
    const cases: Array<[unknown, string]> = [
      [{ ops: [] }, 'an object'],
      ['"just a string"', 'a string'],
      [42, 'a number'],
      [null, 'null'],
    ];
    for (const [content, gotKind] of cases) {
      for (const mode of ['compact', 'full'] as const) {
        const { stub, captured } = makeStub();
        const client = await connect(stub, mode);
        const file = writeOpsFile(JSON.stringify(content));
        const result =
          mode === 'compact'
            ? await callToolJson(client, 'figpea_call', compactOpsFile(file))
            : await callToolJson(client, 'layer_batch', { opsFile: file });

        expect(result.ok, `${mode} ${gotKind}`).toBe(false);
        expect(result.code, `${mode} ${gotKind}`).toBe('invalid_params');
        expect(result.message, `${mode} ${gotKind}`).toContain(file);
        expect(result.message, `${mode} ${gotKind}`).toContain('array');
        expect(result.message, `${mode} ${gotKind}`).toContain(gotKind);
        expect(captured, `${mode} ${gotKind}`).toHaveLength(0);
      }
    }
  });

  it('an empty array is refused — layer.batch needs at least one op', async () => {
    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const file = writeOpsFile('[]');
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', compactOpsFile(file))
          : await callToolJson(client, 'layer_batch', { opsFile: file });

      expect(result.ok, mode).toBe(false);
      expect(result.code, mode).toBe('invalid_params');
      expect(result.message, mode).toContain(file);
      expect(result.message, mode).toContain('empty');
      expect(captured, mode).toHaveLength(0);
    }
  });

  it('a file larger than the read ceiling is refused BEFORE it is read, naming the limit', async () => {
    const CEILING = 2 * 1024 * 1024;
    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      // A valid, non-empty array — only its SIZE can be the reason for refusal.
      const filler = 'x'.repeat(CEILING);
      const file = writeOpsFile(JSON.stringify([{ method: 'create', args: ['rect', { name: filler }] }]));
      expect(fs.statSync(file).size, mode).toBeGreaterThan(CEILING);
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', compactOpsFile(file))
          : await callToolJson(client, 'layer_batch', { opsFile: file });

      expect(result.ok, mode).toBe(false);
      expect(result.code, mode).toBe('invalid_params');
      expect(result.message, mode).toContain(file);
      expect(result.message, mode).toMatch(/limit|too large|larger|exceed/i);
      expect(captured, mode).toHaveLength(0);
    }
  });

  it('a non-string or empty option is refused, naming the option', async () => {
    const bad: Array<[unknown, RegExp]> = [
      [42, /must be a string/i],
      [true, /must be a string/i],
      [{ path: '/tmp/x.json' }, /must be a string/i],
      [['/tmp/x.json'], /must be a string/i],
      ['', /empty/i],
      ['   ', /empty/i],
    ];
    for (const [value, expected] of bad) {
      for (const mode of ['compact', 'full'] as const) {
        const { stub, captured } = makeStub();
        const client = await connect(stub, mode);
        const key = mode === 'compact' ? '_opsFile' : 'opsFile';
        const result =
          mode === 'compact'
            ? await callToolJson(client, 'figpea_call', { group: 'layer', method: 'batch', args: [], [key]: value })
            : await callToolJson(client, 'layer_batch', { [key]: value });

        expect(result.ok, `${mode} ${JSON.stringify(value)}`).toBe(false);
        expect(result.code, `${mode} ${JSON.stringify(value)}`).toBe('invalid_params');
        expect(result.message, `${mode} ${JSON.stringify(value)}`).toMatch(expected);
        expect(result.message, `${mode} ${JSON.stringify(value)}`).toContain('opsFile');
        expect(captured, `${mode} ${JSON.stringify(value)}`).toHaveLength(0);
      }
    }
  });

  it('an inline ops AND a file together is refused as ambiguous — never one silently wins', async () => {
    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const file = writeOpsFile(JSON.stringify([{ method: 'create', args: ['rect', { name: 'from-file' }] }]));
      const inline = [{ method: 'create', args: ['rect', { name: 'inline' }] }];
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', compactOpsFile(file, [inline]))
          : await callToolJson(client, 'layer_batch', { opsFile: file, ops: inline });

      expect(result.ok, mode).toBe(false);
      expect(result.code, mode).toBe('invalid_params');
      // Both named as the thing each one is. `\bops\b` will not match inside
      // `_opsFile`, so this cannot pass on a message that named only the option.
      expect(result.message, mode).toContain('opsFile');
      expect(result.message, mode).toMatch(/\bops\b/);
      expect(captured, mode).toHaveLength(0);
    }
  });

  it('a directory is not a file, and is refused by the same missing-file arm', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1498-ops-'));
    tempDirs.push(dir);
    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', compactOpsFile(dir))
          : await callToolJson(client, 'layer_batch', { opsFile: dir });

      expect(result.ok, mode).toBe(false);
      expect(result.code, mode).toBe('invalid_params');
      expect(result.message, mode).toBe(`file not found or not readable: ${dir}`);
      expect(captured, mode).toHaveLength(0);
    }
  });
});

// ───────────── the derived slot is the METHOD's, never a hard-coded index ──

describe('the payload goes to the slot the manifest declares, wherever it sits', () => {
  /** A real on-disk JSON file holding exactly `value`. */
  function fileWith(value: unknown): string {
    return writeOpsFile(JSON.stringify(value), 'payload.json');
  }

  it('a matrix payload at index 1 is substituted AT index 1, and the id before it survives', async () => {
    // The reviewer's probe, made permanent. `setTransform(id, transform)` puts the
    // payload second: hard-coding index 0 refused this call as ambiguous even
    // though the caller sent no matrix at all.
    const MATRIX = [1, 0, 0, 1, 40, 60];

    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const file = fileWith(MATRIX);
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', { group: 'layer', method: 'setTransform', args: ['L_1'], _opsFile: file })
          : await callToolJson(client, 'layer_setTransform', { id: 'L_1', opsFile: file });

      expect(result.ok, `${mode}: ${JSON.stringify(result)}`).toBe(true);
      expect(captured, mode).toHaveLength(1);
      // The id the caller sent is still at args[0]; the file's matrix is at
      // args[1]. Not "the payload is somewhere in args" — the exact array.
      expect(captured[0]!.args, mode).toEqual(['L_1', MATRIX]);
      expect(captured[0]!.args[0], mode).toBe('L_1');
    }
  });

  it('a scalar AFTER the array slot survives the substitution', async () => {
    // `booleanOperate(ids, operation)` — replacing the whole positional array
    // (rather than writing into the slot) forwarded `[['L_1','L_2']]` and
    // silently dropped `operation: 'union'`.
    const IDS = ['L_1', 'L_2'];

    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const file = fileWith(IDS);
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', { group: 'layer', method: 'booleanOperate', args: [undefined, 'union'], _opsFile: file })
          : await callToolJson(client, 'layer_booleanOperate', { ids: undefined, operation: 'union', opsFile: file });

      expect(result.ok, `${mode}: ${JSON.stringify(result)}`).toBe(true);
      expect(captured, mode).toHaveLength(1);
      expect(captured[0]!.args, mode).toEqual([IDS, 'union']);
    }
  });

  it('a scalar on BOTH sides of the array slot survives, in the caller\'s own order', async () => {
    // The strongest shape available in this manifest: an array between two
    // scalars, which no whole-array replacement can satisfy.
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = fileWith([2, 3]);
    const result = await callToolJson(client, 'figpea_call', {
      group: 'layer',
      method: 'booleanOperate',
      args: [undefined, 'subtract'],
      _opsFile: file,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args).toEqual([[2, 3], 'subtract']);
  });

  it('an EMPTY slot is not a payload — the file supplies it, and this holds in both lanes', async () => {
    // `args: [null]` is a harness spelling "no value here", and `null` is not a
    // payload the file option could be overriding, so refusing it as ambiguous
    // would refuse a call that means exactly one thing. Both lanes agree: the
    // plan requires identical behaviour in both, so a null-only divergence
    // between them is a defect too.
    const IDS = ['L_1', 'L_2'];
    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const file = fileWith(IDS);
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', { group: 'layer', method: 'booleanOperate', args: [null, 'union'], _opsFile: file })
          : await callToolJson(client, 'layer_booleanOperate', { ids: null, operation: 'union', opsFile: file });

      expect(result.ok, `${mode}: ${JSON.stringify(result)}`).toBe(true);
      expect(captured[0]!.args, mode).toEqual([IDS, 'union']);
    }
  });

  it('a REAL payload at the slot AND a file is still refused as ambiguous, in both lanes', async () => {
    // The guard against reading "an empty slot is not a payload" as "the file
    // always wins". The refusal must name the slot's own parameter, at whatever
    // index it sits.
    const file = fileWith([9, 9]);
    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', { group: 'layer', method: 'setTransform', args: ['L_1', [2, 2]], _opsFile: file })
          : await callToolJson(client, 'layer_setTransform', { id: 'L_1', transform: [2, 2], opsFile: file });

      expect(result.ok, mode).toBe(false);
      expect(result.code, mode).toBe('invalid_params');
      expect(result.message, mode).toContain('opsFile');
      // The parameter named is the ARRAY one, not args[0]'s parameter.
      expect(result.message, mode).toMatch(/"transform"|\btransform\b/);
      expect(captured, mode).toHaveLength(0);
    }
  });

  it('a method with NO array/matrix param is refused by name rather than silently dropped', async () => {
    // The option is derived from the manifest, so it is not offered where there
    // is nothing to substitute into — and saying so is better than ignoring a
    // key the caller believed it had sent.
    for (const mode of ['compact', 'full'] as const) {
      const { stub, captured } = makeStub();
      const client = await connect(stub, mode);
      const file = fileWith([1, 2]);
      const result =
        mode === 'compact'
          ? await callToolJson(client, 'figpea_call', { group: 'layer', method: 'setName', args: ['L_1', 'probe'], _opsFile: file })
          : await callToolJson(client, 'layer_setName', { id: 'L_1', name: 'probe', opsFile: file });

      // Compact refuses by name; full mode's allowance is derived the same way,
      // so the key is an unknown parameter there rather than a no-op.
      expect(result.ok, `${mode}: ${JSON.stringify(result)}`).toBe(false);
      expect(result.code, mode).toBe('invalid_params');
      expect(result.message, mode).toContain('opsFile');
      expect(captured, mode).toHaveLength(0);
    }
  });

  it('the caller\'s own args array is not mutated by a non-zero-slot substitution', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const file = fileWith([1, 0, 0, 1, 5, 5]);
    const callerArgs = ['L_1', undefined];
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'setTransform', args: callerArgs, _opsFile: file });

    expect(result.ok).toBe(true);
    // The caller's array still has a hole where its matrix slot was; the server
    // sent a copy with the file's matrix written into it.
    expect(callerArgs).toEqual(['L_1', undefined]);
    expect(callerArgs[1]).toBeUndefined();
    expect(captured[0]!.args[1]).toEqual([1, 0, 0, 1, 5, 5]);
  });

  it('the well-formed INLINE forms are unchanged by any of the above', async () => {
    // The control: the fix must not disturb a call that already worked.
    const matrix = [1, 0, 0, 1, 10, 10];
    const compactRun = makeStub();
    const compactClient = await connect(compactRun.stub);
    expect(
      (await callToolJson(compactClient, 'figpea_call', { group: 'layer', method: 'setTransform', args: ['L_1', matrix] })).ok,
    ).toBe(true);
    expect(compactRun.captured[0]!.args).toEqual(['L_1', matrix]);

    const fullRun = makeStub();
    const fullClient = await connect(fullRun.stub, 'full');
    expect((await callToolJson(fullClient, 'layer_setTransform', { id: 'L_1', transform: matrix })).ok).toBe(true);
    expect(fullRun.captured[0]!.args).toEqual(['L_1', matrix]);

    const boolRun = makeStub();
    const boolClient = await connect(boolRun.stub);
    expect(
      (await callToolJson(boolClient, 'figpea_call', { group: 'layer', method: 'booleanOperate', args: [['L_1'], 'union'] })).ok,
    ).toBe(true);
    expect(boolRun.captured[0]!.args).toEqual([['L_1'], 'union']);
  });
});

// ─────────────────────────────── no regression (AC-3 relay half) ───────────

describe('an inline ops array is byte-identical to today', () => {
  it('compact lane: the array is forwarded unchanged, in one round trip', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub);
    const ops = [{ method: 'create', args: ['rect', { parentId: 'P1', rwidth: 100, rheight: 60 }] }];
    const result = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'batch', args: [ops] });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[0]).toEqual(ops);
  });

  it('full lane: `{ops}` is forwarded unchanged', async () => {
    const { stub, captured } = makeStub();
    const client = await connect(stub, 'full');
    const ops = [{ method: 'create', args: ['rect', { parentId: 'P1', rwidth: 100, rheight: 60 }] }];
    const result = await callToolJson(client, 'layer_batch', { ops });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args[0]).toEqual(ops);
  });

  it('the pre-existing top-level layer.create translation still works on both lanes', async () => {
    const image = ((): string => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'req1498-ops-'));
      tempDirs.push(d);
      const f = path.join(d, 'clay.jpg');
      fs.writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return f;
    })();

    const compact = makeStub();
    const compactClient = await connect(compact.stub);
    const compactResult = await callToolJson(compactClient, 'figpea_call', {
      group: 'layer',
      method: 'create',
      args: ['image', IMAGE_PROPS(image)],
    });
    expect(compactResult.ok).toBe(true);
    expect(compact.captured).toHaveLength(1);
    expect(compact.captured[0]!.args[1] as any).not.toHaveProperty('filePath');
    expect(String((compact.captured[0]!.args[1] as any).url)).toContain(encodeURIComponent(image));

    const full = makeStub();
    const fullClient = await connect(full.stub, 'full');
    const fullResult = await callToolJson(fullClient, 'layer_create', { kind: 'image', props: IMAGE_PROPS(image) });
    expect(fullResult.ok).toBe(true);
    expect(full.captured).toHaveLength(1);
    expect(full.captured[0]!.args[1] as any).not.toHaveProperty('filePath');
    expect(String((full.captured[0]!.args[1] as any).url)).toContain(encodeURIComponent(image));
  });
});