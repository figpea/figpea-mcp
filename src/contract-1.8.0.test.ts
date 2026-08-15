import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { drillManifest, type DescribeFn } from './describeDrill';
import { buildToolsFromManifest } from './tools';

/**
 * REQ-188 AC-4 — the drill against the REAL contract 1.8.0 surface.
 *
 * `src/__fixtures__/contract-1.8.0.json` is a genuine capture, not a
 * hand-written mock: it was taken from the live production editor
 * (https://editor.figpea.com/?agent=1, `figpea.version === "1.8.0"`) by
 * calling `describe()` and `describe("layer.stylePatch")` in the page. It
 * holds the bare compact index exactly as the editor returns it, plus one
 * fully drilled descriptor.
 *
 * WHY THE FIXTURE IS PARTIAL. Storing all 75 drilled descriptors would be a
 * ~1MB snapshot of a contract that moves every few days, and keeping it
 * current is REQ-695's job (a drift gate), not a fixture's. So the drilled
 * side is synthesized from the index's REAL group and method names, with the
 * one real descriptor spliced in for the schema assertion. Coverage is
 * therefore checked against real names, and schema fidelity against a real
 * descriptor — neither claim rests on invented data.
 *
 * WHAT THIS PINS that the unit tests can't: the reserved-key handling and the
 * compact-vs-full discriminator against the actual shapes the editor emits,
 * and the actual group/method counts, which a hand-written fixture would only
 * ever confirm back to its own author. (The counts here corrected the REQ
 * doc's own estimate: it said "~78 methods", from a grep over the descriptor
 * sources that overcounted `export` by 3. The real number is 75.)
 */

interface ContractFixture {
  capturedFrom: string;
  contractVersion: string;
  compactIndex: Record<string, any>;
  stylePatchDrilled: Record<string, any>;
}

const FIXTURE: ContractFixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'contract-1.8.0.json'), 'utf8'),
);

const RESERVED = new Set(['version', 'errorCodes']);
const REAL_GROUPS = Object.keys(FIXTURE.compactIndex).filter((k) => !RESERVED.has(k));
const REAL_METHOD_COUNT = REAL_GROUPS.reduce((n, g) => n + Object.keys(FIXTURE.compactIndex[g]).length, 0);

/** Answers exactly as the live editor does: bare -> the real compact index;
 * `<group>` -> that group's descriptors, real for `layer.stylePatch` and
 * name-faithful stand-ins for the rest. */
const liveLikeDescribe: DescribeFn = async (selector) => {
  if (selector === undefined) {
    return { hasManifest: true, manifest: FIXTURE.compactIndex, version: FIXTURE.contractVersion };
  }
  if (!REAL_GROUPS.includes(selector)) {
    return { hasManifest: false, manifest: undefined, version: FIXTURE.contractVersion };
  }
  const group: Record<string, unknown> = {};
  for (const method of Object.keys(FIXTURE.compactIndex[selector])) {
    group[method] =
      selector === 'layer' && method === 'stylePatch'
        ? FIXTURE.stylePatchDrilled
        : { doc: FIXTURE.compactIndex[selector][method], params: {}, result: 'void' };
  }
  return { hasManifest: true, manifest: group, version: FIXTURE.contractVersion };
};

describe('the captured fixture really is contract 1.8.0 (guards the premise)', () => {
  it('was captured at 1.8.0 with the post-0.16.0 compact shape', () => {
    expect(FIXTURE.contractVersion).toBe('1.8.0');
    expect(FIXTURE.compactIndex.version).toBe('1.8.0');
    // Post-0.16.0: methods map to one-line doc STRINGS, and errorCodes is an
    // array of code keys rather than the pre-0.16.0 code->message catalog.
    expect(typeof FIXTURE.compactIndex.layer.create).toBe('string');
    expect(Array.isArray(FIXTURE.compactIndex.errorCodes)).toBe(true);
  });

  it('advertises 8 groups and 75 methods', () => {
    expect(REAL_GROUPS.sort()).toEqual([
      'canvas',
      'component',
      'export',
      'history',
      'interaction',
      'layer',
      'report',
      'session',
    ]);
    expect(REAL_METHOD_COUNT).toBe(75);
  });
});

describe('REQ-188 AC-4 — the drilled tool set covers the whole 1.8.0 surface', () => {
  it('generates exactly one tool per advertised method', async () => {
    const manifest = await drillManifest(liveLikeDescribe);
    const tools = buildToolsFromManifest(manifest as any);

    expect(tools).toHaveLength(REAL_METHOD_COUNT);
    expect(tools).toHaveLength(75);
  });

  it('covers all 8 groups, with per-group counts matching the contract', async () => {
    const manifest = await drillManifest(liveLikeDescribe);
    const tools = buildToolsFromManifest(manifest as any);

    const perGroup: Record<string, number> = {};
    for (const tool of tools) {
      const group = tool.name.slice(0, tool.name.indexOf('_'));
      perGroup[group] = (perGroup[group] ?? 0) + 1;
    }

    expect(perGroup).toEqual({
      session: 8,
      layer: 27,
      history: 2,
      export: 10,
      canvas: 7,
      report: 5,
      interaction: 3,
      component: 13,
    });
  });

  it('synthesizes no errorCodes_* pseudo-tools from the reserved catalog key', async () => {
    const manifest = await drillManifest(liveLikeDescribe);
    const tools = buildToolsFromManifest(manifest as any);

    // 23 real error codes sit in the index; none may become a tool.
    expect(FIXTURE.compactIndex.errorCodes.length).toBe(23);
    expect(tools.filter((t) => t.name.startsWith('errorCodes'))).toEqual([]);
    expect(tools.filter((t) => t.name.startsWith('version'))).toEqual([]);
  });

  it('carries a real post-0.16.0 schema through: stylePatch accepts 1.8.0 `strokes`', async () => {
    const manifest = await drillManifest(liveLikeDescribe);
    const tools = buildToolsFromManifest(manifest as any);
    const stylePatch = tools.find((t) => t.name === 'layer_stylePatch');

    expect(stylePatch).toBeDefined();
    // Real params, from the real descriptor -- not an empty shell.
    expect(stylePatch!.inputKeys).toEqual(['id', 'patch']);
    // The multi-stroke key contract 1.8.0 added (REQ-663), reaching the tool.
    expect(stylePatch!.description).toContain('strokes');
    expect(FIXTURE.stylePatchDrilled.params.patch.shape.strokes).toEqual({ type: 'array', required: false });
  });
});

describe('REQ-188 — the regression this fixes, pinned against real data', () => {
  it('the compact index ALONE yields schema-less tools (the shipped 0.1.0 bug)', () => {
    // This is what figpea-mcp 0.1.0 did against any editor >=0.16.0: it fed
    // the compact index straight to the tool builder. Tools still appear, so
    // nothing errors -- they just lose every parameter, which is exactly why
    // this went unnoticed for 22 contract versions.
    const degraded = buildToolsFromManifest(FIXTURE.compactIndex as any);
    const stylePatch = degraded.find((t) => t.name === 'layer_stylePatch');

    expect(stylePatch).toBeDefined();
    expect(stylePatch!.inputKeys).toEqual([]);
    expect(stylePatch!.description).not.toContain('strokes');
  });

  it('drilling restores what the compact index dropped', async () => {
    const degraded = buildToolsFromManifest(FIXTURE.compactIndex as any);
    const manifest = await drillManifest(liveLikeDescribe);
    const drilled = buildToolsFromManifest(manifest as any);

    const degradedKeys = degraded.find((t) => t.name === 'layer_stylePatch')!.inputKeys;
    const drilledKeys = drilled.find((t) => t.name === 'layer_stylePatch')!.inputKeys;

    expect(degradedKeys).toEqual([]);
    expect(drilledKeys).toEqual(['id', 'patch']);
  });
});
