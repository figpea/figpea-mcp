import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * REQ-1443 AC-1/AC-2/AC-4 — the build precondition guard.
 *
 * Three suites (`cli.test.ts`, `req1035.test.ts`, `skillProvenance.test.ts`)
 * spawn the *built* `dist/cli.js` over real stdio, by absolute path. Nothing
 * established the build-before-test ordering, so on a fresh clone, a new
 * worktree, or any checkout whose last action was editing a source file, the
 * child died before the MCP handshake and the SDK reported that as
 * `MCP error -32000: Connection closed` — a build ordering problem wearing the
 * costume of a product failure, at 10 call sites across 3 files.
 *
 * This guard turns that into the failure the reader can act on. It is called at
 * each spawn site, and it deliberately **throws** rather than skipping:
 * AC-1 requires the cold run to fail, AC-3 forbids assertions that are
 * "skipped-by-default", and a skipped suite is a green gate over an untested
 * surface — the same wolf-cry in a new costume.
 *
 * It is called per spawn site rather than from a `beforeAll` on purpose.
 * `packedArtifact.test.ts` runs `npm run build` in its own `beforeAll`, so on a
 * cold `dist/` a file-level guard could fail a test whose build is in fact
 * current. Checking at the moment of the spawn honours a build that legitimately
 * happened, and still names the remedy when it did not.
 *
 * It imports only `node:fs` and `node:path` — this package must keep building
 * and testing when cloned standalone, with no sibling `v3/` (AC-6).
 *
 * The filename ends in `.test-helper.ts` so `vitest.config.ts`'s
 * suite glob (`src` + any-depth `.test.ts`) never collects it as a suite, and
 * so `tsconfig.build.json`'s `exclude` keeps it out of `dist/` and therefore out
 * of the published tarball — while `tsconfig.json`, whose include is `src` plus
 * any-depth `.ts`, still type-checks it (AC-4).
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/** The entry the shipped bin points at (package.json `"bin": "dist/cli.js"`). */
export const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli.js');

/**
 * Assert that the built CLI entry exists, or throw a failure that names the
 * missing artifact, the reason and the remedy.
 *
 * @param entryPath the entry to check; defaults to this package's `dist/cli.js`.
 * @returns the resolved entry path, ready to spawn.
 */
export function requireBuiltCli(entryPath: string = CLI_ENTRY): string {
  const resolved = path.resolve(entryPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(
      [
        `Missing built CLI entry: ${resolved}`,
        '',
        'This suite spawns the BUILT dist/cli.js over real stdio rather than the',
        'TypeScript source, so nothing has been built yet -- this is a build',
        'precondition failure, not a product failure.',
        '',
        'Fix: run `npm run build` first, then run the tests.',
        '',
        '  npm run build',
        '  npm test',
      ].join('\n'),
    );
  }

  return resolved;
}