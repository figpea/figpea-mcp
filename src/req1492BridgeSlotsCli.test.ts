import { describe, it, expect, vi } from 'vitest';

import { parseBridgeSlotsArg, resolveBridgeSlots } from './cli';

/**
 * REQ-1492 — the `--bridge-slots` knob is the ONLY documented route to multi-slot
 * mode, and every claim the README and the site docs make about it rests on this
 * resolver answering correctly.
 *
 * F2 from code-review round 1: the design promised "the same precedence, same
 * invalid-value warning, unit-tested", `cli.ts` even carries the comment "Exported
 * for unit tests", and REQ-1032's `resolveBridgePort` is the worked precedent — yet
 * nothing imported either function, so the route the docs tell a reader to take was
 * entirely uncovered. A reader who typos `--bridge-slots=mult` would silently get the
 * default single-slot bridge and a refused second tab, and no test would have noticed.
 *
 * The precedence under test, from the plan's § *The design* item 6:
 *   `--bridge-slots=` > `FIGPEA_BRIDGE_SLOTS` > `single`
 * with an invalid value warned about and falling back to `single` — never rejected,
 * because a typo must not crash the stdio channel (the same contract
 * `resolveToolMode` and `resolveBridgePort` keep).
 */

type Resolver = (argv: string[], env?: NodeJS.ProcessEnv) => 'single' | 'multi';

describe('REQ-1492 — --bridge-slots precedence, exactly as the docs state it', () => {
  it('the resolver is exported, so the documented route is reachable and testable', () => {
    expect(typeof resolveBridgeSlots, 'cli.ts must export resolveBridgeSlots').toBe('function');
    expect(typeof parseBridgeSlotsArg, 'and the flag parser beside it').toBe('function');
  });

  it('defaults to single with neither a flag nor an env var — AC-7 names the current default as the default', () => {
    const resolve = resolveBridgeSlots as Resolver;
    expect(resolve([], {}), 'no flag and no env is the one-tab default').toBe('single');
    expect(resolve([], {} as NodeJS.ProcessEnv), 'an empty env behaves the same').toBe('single');
  });

  it('CLI --bridge-slots wins over the env var', () => {
    const resolve = resolveBridgeSlots as Resolver;
    expect(resolve(['--bridge-slots=multi'], { FIGPEA_BRIDGE_SLOTS: 'single' } as NodeJS.ProcessEnv)).toBe('multi');
    expect(resolve(['--bridge-slots=single'], { FIGPEA_BRIDGE_SLOTS: 'multi' } as NodeJS.ProcessEnv)).toBe('single');
  });

  it('the env var applies when no CLI flag is given', () => {
    const resolve = resolveBridgeSlots as Resolver;
    expect(resolve([], { FIGPEA_BRIDGE_SLOTS: 'multi' } as NodeJS.ProcessEnv)).toBe('multi');
    expect(resolve([], { FIGPEA_BRIDGE_SLOTS: 'single' } as NodeJS.ProcessEnv)).toBe('single');
  });

  it('is case-insensitive and whitespace-tolerant, like --mode and the env sibling', () => {
    const resolve = resolveBridgeSlots as Resolver;
    expect(resolve(['--bridge-slots=MULTI'], {})).toBe('multi');
    expect(resolve(['--bridge-slots= multi '], {})).toBe('multi');
    expect(resolve([], { FIGPEA_BRIDGE_SLOTS: ' MULTI ' } as NodeJS.ProcessEnv)).toBe('multi');
  });

  it('last flag wins when the knob is repeated, mirroring parseModeArg', () => {
    const resolve = resolveBridgeSlots as Resolver;
    expect(resolve(['--bridge-slots=multi', '--bridge-slots=single'], {})).toBe('single');
    expect(resolve(['--bridge-slots=single', '--bridge-slots=multi'], {})).toBe('multi');
  });

  it('an INVALID flag value is ignored with a stderr warning and falls back to single', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const resolve = resolveBridgeSlots as Resolver;
      // A typo must not crash the stdio channel, and must not silently opt a user
      // into multi-slot either — the safe default is the one that refuses loudly.
      expect(resolve(['--bridge-slots=mult'], {})).toBe('single');
      expect(warn.mock.calls.flat().join(' '), 'the typo is named on stderr').toContain('--bridge-slots');
    } finally {
      warn.mockRestore();
    }
  });

  it('an INVALID env value is ignored with a stderr warning and falls back to single', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const resolve = resolveBridgeSlots as Resolver;
      expect(resolve([], { FIGPEA_BRIDGE_SLOTS: 'several' } as NodeJS.ProcessEnv)).toBe('single');
      expect(warn.mock.calls.flat().join(' '), 'the bad value is named on stderr').toContain('FIGPEA_BRIDGE_SLOTS');
    } finally {
      warn.mockRestore();
    }
  });

  it('an invalid FLAG does not mask a valid env value, and vice versa — invalid is ignored, not fatal', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const resolve = resolveBridgeSlots as Resolver;
      // `resolveToolMode`'s exact contract: an unusable flag is skipped, so the next
      // source in the chain still gets its say.
      expect(resolve(['--bridge-slots=nope'], { FIGPEA_BRIDGE_SLOTS: 'multi' } as NodeJS.ProcessEnv)).toBe('multi');
      expect(resolve([], { FIGPEA_BRIDGE_SLOTS: '' } as NodeJS.ProcessEnv)).toBe('single');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('REQ-1492 — parseBridgeSlotsArg reads the flag list on its own', () => {
  it('returns the last valid value, or undefined when there is none', () => {
    const parse = parseBridgeSlotsArg as (argv: string[]) => string | undefined;
    expect(parse([]), 'no flag at all').toBeUndefined();
    expect(parse(['--mode=full']), 'an unrelated flag is not this knob').toBeUndefined();
    expect(parse(['--bridge-slots=multi'])).toBe('multi');
    expect(parse(['--bridge-slots=multi', '--bridge-slots=single'])).toBe('single');
  });

  it('is case-insensitive, so --bridge-slots=MULTI is the documented value', () => {
    const parse = parseBridgeSlotsArg as (argv: string[]) => string | undefined;
    expect(parse(['--bridge-slots=MULTI'])).toBe('multi');
    expect(parse(['--bridge-slots=Single'])).toBe('single');
  });

  it('does not mistake a prefix or a different flag for this one', () => {
    const parse = parseBridgeSlotsArg as (argv: string[]) => string | undefined;
    expect(parse(['--bridge-slots-multi'])).toBeUndefined();
    expect(parse(['--bridge-port=multi'])).toBeUndefined();
  });
});