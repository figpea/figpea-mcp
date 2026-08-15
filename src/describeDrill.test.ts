import { describe, it, expect, vi } from 'vitest';

/**
 * REQ-188 — progressive `describe()` drilling (AC-1, AC-2, AC-3).
 *
 * `describeDrill.ts` does not exist yet — every test below fails at this
 * file's own import statement ("Cannot find module './describeDrill'"), never
 * inside an assertion. That is the intended RED: this file pins the exact
 * behavior the implementation must satisfy.
 *
 * WHY THIS MODULE EXISTS AT ALL. Contract 0.16.0 (REQ-181) made bare
 * `figpea.describe()` return a *compact index* — `group -> {method: <one-line
 * doc string>}` — instead of the full typed manifest. `buildToolsFromManifest`
 * needs the full `params`/`byKind`/`result` trees, which now only come back
 * from `describe("<group>")`. So the server has to drill: bare call to
 * enumerate, then one call per group to reassemble.
 *
 * WHY SEQUENTIAL. `describe_result` frames carry **no correlation id** and no
 * echo of the selector that produced them (v3's
 * `src/agent/bridge/client.ts:80` sends `{type, manifest, version}` and
 * nothing else). Responses can therefore only be matched to requests by
 * strict ordering over the single WebSocket. Hence `DescribeFn` is one
 * request/response pair at a time, and the drill awaits each before issuing
 * the next. Do not "optimize" this into parallel requests — there is no way
 * to tell the answers apart.
 *
 * WHY `hasManifest` IS SEPARATE FROM `manifest`. When a selector misses,
 * v3's `describe()` returns `undefined`, and `JSON.stringify` **drops the
 * key entirely** rather than emitting `null` — the frame arrives as
 * `{type:'describe_result', version:'…'}` with no `manifest` at all. The
 * transport reports that as `hasManifest: false` so the drill can tell "the
 * tab said nothing" apart from "the tab said `null`".
 */

import { drillManifest, groupNamesFromCompactIndex, looksLikeFullManifest } from './describeDrill';
import type { DescribeFn, DescribeResultPayload } from './describeDrill';

/** A compact index as contract >=0.16.0's bare `describe()` returns it:
 * reserved `version` + `errorCodes` keys alongside the group entries, whose
 * method values are one-line doc STRINGS, not descriptors. */
const COMPACT_INDEX = {
  version: '1.8.0',
  session: { openFile: 'Opens a design file.' },
  layer: { create: 'Creates a layer.', setPosition: 'Moves a layer.' },
  errorCodes: ['no_session', 'entitlement_required'],
};

/** The full per-group descriptors those groups drill down to. */
const FULL_GROUPS: Record<string, unknown> = {
  session: {
    openFile: { doc: 'Opens a design file.', params: { url: { kind: 'string' } }, result: 'void' },
  },
  layer: {
    create: { doc: 'Creates a layer.', params: { kind: { kind: 'enum', values: ['rect'] } }, result: 'string' },
    setPosition: { doc: 'Moves a layer.', params: { id: { kind: 'string' } }, result: 'void' },
  },
};

/** Builds a `DescribeFn` that answers from `COMPACT_INDEX`/`FULL_GROUPS`,
 * recording every selector it was called with (in order) so the wire
 * behavior itself can be asserted. `overrides` replaces the answer for a
 * given selector — used to simulate misses. */
function makeDescribeFn(overrides: Record<string, DescribeResultPayload> = {}): {
  fn: DescribeFn;
  selectors: Array<string | undefined>;
} {
  const selectors: Array<string | undefined> = [];
  const fn: DescribeFn = async (selector) => {
    selectors.push(selector);
    const key = selector ?? '<bare>';
    if (key in overrides) return overrides[key];
    if (selector === undefined) return { hasManifest: true, manifest: COMPACT_INDEX, version: '1.8.0' };
    if (selector in FULL_GROUPS) return { hasManifest: true, manifest: FULL_GROUPS[selector], version: '1.8.0' };
    // An unresolved selector: v3 returns undefined, which serializes to an
    // absent `manifest` key (never `null`).
    return { hasManifest: false, manifest: undefined, version: '1.8.0' };
  };
  return { fn, selectors };
}

describe('groupNamesFromCompactIndex (AC-1 — enumerate only real groups)', () => {
  it('returns the group keys', () => {
    expect(groupNamesFromCompactIndex(COMPACT_INDEX).sort()).toEqual(['layer', 'session']);
  });

  it('excludes the reserved `errorCodes` key, which is a code catalog and not a group', () => {
    // Drilling it would synthesize bogus `errorCodes_<code>` tools -- the
    // exact failure `buildToolsFromManifest` already guards against.
    expect(groupNamesFromCompactIndex(COMPACT_INDEX)).not.toContain('errorCodes');
  });

  it('excludes the reserved `version` key, which is a string and not a group', () => {
    expect(groupNamesFromCompactIndex(COMPACT_INDEX)).not.toContain('version');
  });

  it('is empty for a non-object index rather than throwing', () => {
    expect(groupNamesFromCompactIndex(undefined)).toEqual([]);
    expect(groupNamesFromCompactIndex(null)).toEqual([]);
    expect(groupNamesFromCompactIndex('nope')).toEqual([]);
  });
});

describe('looksLikeFullManifest (guards a pre-0.16.0 editor from silent corruption)', () => {
  it('is false for a compact index, whose method values are doc strings', () => {
    expect(looksLikeFullManifest(COMPACT_INDEX)).toBe(false);
  });

  it('is true for a full manifest, whose method values are descriptor objects', () => {
    expect(looksLikeFullManifest(FULL_GROUPS)).toBe(true);
  });

  it('ignores the reserved keys when deciding', () => {
    // `version` is a string in both shapes, so a naive check that looked at
    // it first would misclassify every manifest.
    expect(looksLikeFullManifest({ version: '0.15.0', ...FULL_GROUPS })).toBe(true);
  });
});

describe('drillManifest (AC-1 — reassembles the full manifest)', () => {
  it('returns every group with its FULL descriptors, not the compact doc strings', async () => {
    const { fn } = makeDescribeFn();
    const manifest = await drillManifest(fn);

    expect(manifest).toEqual(FULL_GROUPS);
    // The whole point: real schemas survive the round trip.
    expect((manifest as any).layer.create.params).toEqual({ kind: { kind: 'enum', values: ['rect'] } });
  });

  it('omits the reserved keys from the reassembled manifest', async () => {
    const { fn } = makeDescribeFn();
    const manifest = (await drillManifest(fn)) as Record<string, unknown>;

    // Anything left in here is treated as a group by buildToolsFromManifest.
    expect(Object.keys(manifest).sort()).toEqual(['layer', 'session']);
  });

  it('drills bare-first, then once per group (AC-2 — selector on the wire)', async () => {
    const { fn, selectors } = makeDescribeFn();
    await drillManifest(fn);

    // The bare index call carries NO selector; each group call carries its
    // own. This is the v3-side optional `selector` field REQ-181 added.
    expect(selectors[0]).toBeUndefined();
    expect(selectors.slice(1).sort()).toEqual(['layer', 'session']);
    expect(selectors).toHaveLength(3);
  });

  it('passes the group name through verbatim as the selector', async () => {
    const { fn, selectors } = makeDescribeFn();
    await drillManifest(fn);

    // Not "group.method", not a prefixed/escaped form -- v3's selector
    // grammar takes the bare group name for a whole-group drill.
    expect(selectors).toContain('layer');
  });

  it('short-circuits on a pre-0.16.0 editor whose bare call already returns the full manifest', async () => {
    const selectors: Array<string | undefined> = [];
    const fn: DescribeFn = async (selector) => {
      selectors.push(selector);
      return { hasManifest: true, manifest: FULL_GROUPS, version: '0.15.0' };
    };

    const manifest = await drillManifest(fn);

    expect(manifest).toEqual(FULL_GROUPS);
    // Drilling such an editor would be actively harmful: it ignores the
    // argument and returns the WHOLE manifest per group, so each group would
    // be overwritten with a copy of everything.
    expect(selectors).toEqual([undefined]);
  });
});

describe('drillManifest (AC-3 — a relayed miss is handled explicitly)', () => {
  it('skips a group whose describe_result carried no manifest key at all', async () => {
    const { fn } = makeDescribeFn({
      layer: { hasManifest: false, manifest: undefined, version: '1.8.0' },
    });

    const manifest = (await drillManifest(fn)) as Record<string, unknown>;

    // Skipped, not present-but-empty: an empty group would register zero
    // tools while looking like a successful drill.
    expect(Object.keys(manifest)).toEqual(['session']);
    expect(manifest).not.toHaveProperty('layer');
  });

  it('does not crash, and still returns the groups that did resolve', async () => {
    const { fn } = makeDescribeFn({
      layer: { hasManifest: false, manifest: undefined, version: '1.8.0' },
    });

    await expect(drillManifest(fn)).resolves.toBeDefined();
    expect((await drillManifest(fn)) as any).toHaveProperty('session');
  });

  it('logs the skipped group so a degraded tool set is never silent', async () => {
    const log = vi.fn();
    const { fn } = makeDescribeFn({
      layer: { hasManifest: false, manifest: undefined, version: '1.8.0' },
    });

    await drillManifest(fn, log);

    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain('layer');
  });

  it('treats an explicitly null manifest as a miss too', async () => {
    // v3 drops the key rather than sending null, but a defensive relay or a
    // future client must not be able to inject a null group.
    const { fn } = makeDescribeFn({
      layer: { hasManifest: true, manifest: null, version: '1.8.0' },
    });

    const manifest = (await drillManifest(fn)) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual(['session']);
  });

  it('treats a non-object group descriptor as a miss', async () => {
    const { fn } = makeDescribeFn({
      layer: { hasManifest: true, manifest: 'unexpected', version: '1.8.0' },
    });

    const manifest = (await drillManifest(fn)) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual(['session']);
  });

  it('returns undefined when the bare index itself misses, rather than a bogus empty manifest', async () => {
    const { fn } = makeDescribeFn({
      '<bare>': { hasManifest: false, manifest: undefined, version: '1.8.0' },
    });

    // An empty {} would disable every already-registered tool on a reconnect
    // -- strictly worse than reporting the drill failed.
    await expect(drillManifest(fn)).resolves.toBeUndefined();
  });

  it('propagates nothing and returns undefined when the bare call rejects', async () => {
    const fn: DescribeFn = async () => {
      throw new Error('timed out');
    };

    await expect(drillManifest(fn)).resolves.toBeUndefined();
  });

  it('skips a group whose drill rejects, keeping the rest', async () => {
    const fn: DescribeFn = async (selector) => {
      if (selector === undefined) return { hasManifest: true, manifest: COMPACT_INDEX, version: '1.8.0' };
      if (selector === 'layer') throw new Error('timed out');
      return { hasManifest: true, manifest: FULL_GROUPS[selector!], version: '1.8.0' };
    };

    const manifest = (await drillManifest(fn)) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual(['session']);
  });
});
