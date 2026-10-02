import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * REQ-1443 AC-2 — the rot-guard: no spawn site escapes the guard.
 *
 * AC-2's guarantee is "no failure at any of the 10 sites can surface as a
 * transport close", which is only durable while the wiring covers *every* site.
 * Wiring 10 call sites by hand is exactly the kind of bookkeeping that is
 * correct on the day it is written and wrong the day someone adds an eleventh
 * spawn, or copies a block that predates the guard. This suite reads the three
 * suites as source and fails when a `new StdioClientTransport(` of this
 * package's built entry has no `requireBuiltCli(` guard earlier in the same
 * test body.
 *
 * It reads source text rather than executing anything, so it needs no `dist/`,
 * starts in milliseconds, and cannot itself be fooled by a build ordering.
 *
 * Scope — which spawns it governs: the ones that spawn **this package's own
 * `dist/cli.js`**, because those are the ones that can fail on a missing build.
 * A spawn of some *other* built artifact is out of scope by construction, and
 * this repo has one worth naming: `packedArtifact.test.ts` spawns the bin of a
 * freshly-installed tarball that its own `beforeAll` builds and installs, so the
 * `dist/cli.js` precondition does not apply to it — requiring a guard there
 * would check a file the test never spawns and could fail it while the
 * artifact it actually needs is present. `inScope` identifies the distinction
 * from the spawn block itself rather than from a list of files, so a future
 * `dist/cli.js` spawn is covered without being enumerated here.
 *
 * What it does NOT do: pin a total of 10 sites. A hard count would turn the
 * next legitimate spawn site into a red gate for a reason unrelated to the
 * guard, which is precisely the kind of misleading red this requirement exists
 * to end. The assertion is per-site: guarded or it does not ship.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');

/** The suites that spawn the built CLI over real stdio. */
const SPAWNING_SUITES = ['cli.test.ts', 'req1035.test.ts', 'skillProvenance.test.ts'];

const SPAWN = /new\s+StdioClientTransport\s*\(/;
const GUARD = /requireBuiltCli\s*\(/;
/** A test declaration opening a body — `it`, `test`, and their `.each` /
 *  conditional forms. Written so this file contains no literal skip/only token:
 *  `req1443SuiteIntegrity.test.ts` counts those across the suite, and a comment
 *  that merely names one would trip AC-3's "skipped-by-default" pin. */
const BODY_OPEN = /(?:^|[^\w.$])(?:it|test)(?:\.[A-Za-z]+)*\s*\(/;

type Site = { line: number; text: string; inScope: boolean; guarded: boolean };

/** The transport construction spans several lines: `command:`, `args:`, `env:` … */
const SPAWN_BLOCK_LINES = 8;
/** Marks a spawn of *this* package's built entry rather than another artifact. */
const SPAWNS_BUILT_ENTRY = /CLI_ENTRY|dist[\\/]cli\.js/;

/**
 * Every `new StdioClientTransport(` in `source`, each paired with whether a
 * `requireBuiltCli(` guard appears earlier inside the same test body, and
 * whether the spawn targets this package's built `dist/cli.js` at all.
 */
function spawnSites(source: string): Site[] {
  const lines = source.split('\n');
  const sites: Site[] = [];

  // `bodyStart` is the index of the line that opened the body currently being
  // read, or -1 when we are not inside a test body (module scope, a helper
  // function). Reset on each new body so a guard in one test can never vouch
  // for a spawn in the next.
  let bodyStart = -1;
  let guarded = false;

  lines.forEach((text, index) => {
    if (BODY_OPEN.test(text) && !SPAWN.test(text)) {
      bodyStart = index;
      guarded = false;
    }
    if (GUARD.test(text)) {
      guarded = true;
    }
    if (SPAWN.test(text)) {
      const block = lines.slice(index, index + SPAWN_BLOCK_LINES).join('\n');
      sites.push({
        line: index + 1,
        text: text.trim(),
        inScope: SPAWNS_BUILT_ENTRY.test(block),
        guarded: bodyStart >= 0 && guarded && index > bodyStart,
      });
    }
  });

  return sites;
}

/** The sites this rot-guard governs: spawns of this package's built entry. */
function guardedEntrySites(sites: Site[]): Site[] {
  return sites.filter((site) => site.inScope);
}

describe('REQ-1443 AC-2 — every CLI spawn site is guarded', () => {
  for (const suite of SPAWNING_SUITES) {
    describe(suite, () => {
      const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', suite), 'utf8');
      const sites = guardedEntrySites(spawnSites(source));

      it('still spawns the built CLI (so this suite cannot pass vacuously)', () => {
        expect(
          sites.length,
          `${suite} no longer spawns this package's built dist/cli.js over stdio — if that is intentional, this rot-guard's scope needs revisiting`,
        ).toBeGreaterThan(0);
      });

      it('calls requireBuiltCli() before every spawn, inside the same test body', () => {
        const unguarded = sites.filter((site) => !site.guarded);
        expect(
          unguarded.map((site) => `${suite}:${site.line}  ${site.text}`),
          'these spawn sites can still report a missing build as "MCP error -32000: Connection closed". '
            + 'Call requireBuiltCli() in the same test body, before the transport is constructed.',
        ).toEqual([]);
      });
    });
  }

  it('guards every spawn of the built entry in the repo, not only the three known suites', () => {
    // A new suite that spawns dist/cli.js is exactly the 11th site AC-2 has to
    // cover, so the guard is not allowed to be scoped to a list that can go
    // stale while the defect it defends is still live.
    const srcDir = path.join(PACKAGE_ROOT, 'src');
    const allTestFiles = fs
      .readdirSync(srcDir)
      .filter((name) => name.endsWith('.test.ts') && name !== path.basename(__filename))
      .map((name) => path.join(srcDir, name));

    const unguarded = allTestFiles.flatMap((file) =>
      guardedEntrySites(spawnSites(fs.readFileSync(file, 'utf8')))
        .filter((site) => !site.guarded)
        .map((site) => `${path.relative(PACKAGE_ROOT, file)}:${site.line}`),
    );

    expect(unguarded, 'a suite spawning the built dist/cli.js without the guard was added').toEqual([]);
  });
});