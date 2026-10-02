import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * REQ-1443 AC-3 — make "nothing was deleted, skipped, or loosened" a *failing
 * test* rather than something a reviewer has to read a diff to confirm.
 *
 * AC-3's operative clause is "no assertion is deleted, skipped-by-default, or
 * loosened". Satisfying that by inspecting the diff is a claim; satisfying it
 * with a test is a guarantee. Three recorded properties:
 *
 *   1. every test file in the baseline still exists;
 *   2. the declaration count is exact for the three files this REQ edits — a
 *      deleted `it(` fails;
 *   3. no skip/only construct exists anywhere beyond the two pre-existing,
 *      untouched ones.
 *
 * On the numbers: the card's parenthetical ("37 files, 614 passed, 1 skipped")
 * was measured 2026-10-01 and mainline has moved since — 41 files / 581
 * declarations at the branch point — so those literals cannot be a target;
 * pinning them would fail a perfectly correct implementation. The clause they
 * illustrate is what is pinned here, against a baseline re-measured on this
 * branch tip. Both bases are recorded in the dev log.
 *
 * UPDATING THE BASELINE: a future REQ that legitimately deletes a suite, or
 * removes a declaration, updates these constants *in its own commit*, with its
 * own justification in that commit message — exactly how `readme.test.ts`'s
 * existing pins have always been maintained here.
 *
 * There is deliberately **no global declaration total**. A global count turns
 * every future legitimate test addition into a red gate, which reproduces in a
 * new form the exact phantom-failure problem this requirement exists to end:
 * a gate that cries wolf is a gate people wave through. What is pinned is the
 * *narrow* claim AC-3 makes — this diff removed nothing — and it is exact
 * precisely because the diff is narrow.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_ROOT, 'src');

/** UPDATING THE BASELINE — see the note above. Measured at this branch tip. */
const BASELINE_TEST_FILES = [
  // REQ-1444 adds the two suites this requirement's tests live in, extended
  // here in this REQ's own commit with its own justification, exactly as the
  // note above instructs: a new suite must EXTEND the baseline, never bypass
  // it. Both are added by this requirement's T1/T2 and neither removes,
  // skips or loosens anything.
  'argShapeEnvelope.test.ts',
  'bridgeFileEndpoint.test.ts',
  'bridgeServer.test.ts',
  'bridgeServerTolerant.test.ts',
  'cli.test.ts',
  'connectionDiagnosis.test.ts',
  'contract-1.8.0.test.ts',
  'contractFetch.test.ts',
  'describeDrill.test.ts',
  'designfixBatchFilePath.test.ts',
  'mcpServer.test.ts',
  'metadata.test.ts',
  'packedArtifact.test.ts',
  'rawJson.test.ts',
  'readme.test.ts',
  'req1017FileTranslation.test.ts',
  'req1018.test.ts',
  'req1020ReturnAs.test.ts',
  'req1020ReturnPath.test.ts',
  'req1032.test.ts',
  'req1035.test.ts',
  'req1037.test.ts',
  'req1268.test.ts',
  'req1279BinaryReturn.test.ts',
  'req1279ReturnPathBinary.test.ts',
  'req1280.test.ts',
  'req1282BurstDefault.test.ts',
  'req1282TimeoutEnvelope.test.ts',
  'req1282ToolDescription.test.ts',
  'req1283FilePathExtension.test.ts',
  'req1295WireEncoding.test.ts',
  'req1296UnknownParams.test.ts',
  'req1301BridgeHost.test.ts',
  'req1309KindProps.test.ts',
  'req1318StringJson.test.ts',
  'req1337RawJsonFilePath.test.ts',
  'req1394ReadmeDiagnosis.test.ts',
  'req1394StatusDiagnosis.test.ts',
  'req1443BuildGuard.test.ts',
  'req1443SpawnWiring.test.ts',
  'req1443SuiteIntegrity.test.ts',
  'req1444EnvelopeDiagnostics.test.ts',
  'req870.test.ts',
  'skillFetch.test.ts',
  'skillProvenance.test.ts',
  'tools.test.ts',
];

/**
 * Exact declaration counts for the three files this REQ edits. `readme.test.ts`
 * is deliberately absent: this REQ *adds* a pin to it, and a count there would
 * flag the addition rather than any removal.
 */
const BASELINE_DECLARATIONS: Record<string, number> = {
  'cli.test.ts': 5,
  'req1035.test.ts': 21,
  'skillProvenance.test.ts': 6,
};

/** Every declaration form counted: `it(`, `test(`, `it.each(`, … */
const DECLARATION = /\b(?:it|test)(?:\.[A-Za-z]+)*\s*\(/g;
/** Skip/only constructs: the three ways an assertion stops running. */
const SKIP_OR_ONLY = /\b(?:it|test|describe)\s*\.\s*(?:skip|skipIf|only)\b/g;

/**
 * The two pre-existing conditional skips, in `req1301BridgeHost.test.ts`: a
 * mutually-exclusive `skipIf` pair on `EXTERNAL_IPV4`, of which exactly one
 * always runs. That is the card's "1 skipped". Untouched by this REQ.
 */
const ALLOWED_SKIPS: Record<string, number> = { 'req1301BridgeHost.test.ts': 2 };

function testFiles(): string[] {
  return fs
    .readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
}

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

describe('REQ-1443 AC-3 — suite integrity (nothing deleted, skipped, or loosened)', () => {
  it('still has every test file the baseline records', () => {
    const present = new Set(testFiles());
    const missing = BASELINE_TEST_FILES.filter((file) => !present.has(file));

    expect(missing, 'a baseline test file was deleted — restore it, or update the baseline with a reason').toEqual([]);
  });

  it('adds no suite beyond the baseline (a new suite must extend the baseline, not bypass it)', () => {
    const known = new Set(BASELINE_TEST_FILES);
    const added = testFiles().filter((file) => !known.has(file));

    expect(added, 'a new suite appeared without being recorded in the baseline').toEqual([]);
  });

  for (const [file, expected] of Object.entries(BASELINE_DECLARATIONS)) {
    it(`has exactly ${expected} declarations in ${file}`, () => {
      expect(
        countMatches(sourceOf(file), DECLARATION),
        `${file} lost or gained a test declaration — AC-3 forbids deleting or loosening one; `
          + 'adding one is fine but must be reflected in the baseline',
      ).toBe(expected);
    });
  }

  it('has no skip/only construct beyond the two pre-existing conditional ones', () => {
    // This file is excluded from its own scan on purpose: it necessarily names
    // the tokens it is looking for. Everything else is counted, so a third
    // skip — the shape AC-3 forbids and the shape a `describe.skipIf` guard
    // against a missing build would take — fails here.
    const offenders: Array<{ file: string; count: number }> = [];

    for (const file of testFiles()) {
      if (file === path.basename(__filename)) continue;
      const count = countMatches(sourceOf(file), SKIP_OR_ONLY);
      const allowed = ALLOWED_SKIPS[file] ?? 0;
      if (count !== allowed) {
        offenders.push({ file, count });
      }
    }

    expect(
      offenders,
      'a skip/only construct was added or an existing one removed — AC-3: no assertion is '
        + 'skipped-by-default, and a skipped suite is a green gate over an untested surface',
    ).toEqual([]);
  });

  it('keeps the one pre-existing skip in req1301BridgeHost.test.ts (its conditional pair is one-run, one-skip)', () => {
    const skips = countMatches(sourceOf('req1301BridgeHost.test.ts'), SKIP_OR_ONLY);
    expect(skips, 'the pre-existing conditional pair must survive intact').toBe(2);
  });
});