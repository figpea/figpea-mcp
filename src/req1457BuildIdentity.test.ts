import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * REQ-1457 T3 — the staleness semantics, hermetically (AC-1, AC-2, AC-3).
 *
 * Every row of the semantics table in the plan is pinned here, against a
 * throwaway build directory this suite owns. The REQ-1443 discipline: take the
 * directory as an ARGUMENT so the suite can point at a temp dir, rather than
 * destructively moving the repo's own `dist/` aside — three other suites spawn
 * the real `dist/cli.js` concurrently, and `dist/` is gitignored, so in-place
 * damage never shows up in a diff.
 *
 * The import is DEFERRED and cast, deliberately: `buildIdentity` does not exist
 * yet, so a static import of a missing module fails the whole file at load and
 * hides the assertion-level red this file is here to produce. Deferred, each
 * test fails on its own assertion and the shape of the failure is readable.
 *
 * WHY THE ROWS ARE THIS WAY — the two that are easy to get wrong:
 *
 *  - **`touch` must move the payload** (AC-1's parenthetical). A `touch`
 *    changes mtime and nothing else, so a content-only comparison reports
 *    "unchanged" for it — which is the exact symptom the requirement was filed
 *    to remove, rebuilt inside its own fix.
 *  - **a rebuild with identical sources is `stale: true` WITH an unchanged
 *    `buildId`**. That is a real false positive and it is the price of
 *    covering the AC as written. It is pinned as a *documented* behaviour, not
 *    engineered away, because the two fields together are what let a reader
 *    tell "newer code is waiting" from "the directory was rebuilt".
 */

interface BuildEntry {
  name: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

interface BuildSnapshot {
  root: string;
  entries: BuildEntry[];
  buildId: string | null;
  loadedAt: string;
}

interface BuildIdentity {
  version: string;
  buildId: string | null;
  builtAt: string | null;
  servedAt: string;
  root: string;
}

interface BuildIdentityModule {
  readBuildSnapshot(dir?: string): BuildSnapshot;
  buildStale(snapshot?: BuildSnapshot): boolean;
  buildIdentity(snapshot?: BuildSnapshot): BuildIdentity;
  servingBuild(): { build: BuildIdentity; stale: boolean };
  servingBuildStamp(): string;
  SERVER_VERSION: string;
}

/** Deferred + cast: see the header. Never a top-level await — `tsconfig.json`
 *  compiles to CommonJS, where that is a type error that outlives the fix. */
const load = () => import('./buildIdentity') as Promise<BuildIdentityModule>;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A scratch build directory holding the two files AC-1 names, plus one more. */
function scratchBuild(files: Record<string, string> = { 'cli.js': 'a', 'mcpServer.js': 'b', 'bridgeServer.js': 'c' }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figpea-mcp-req1457-identity-'));
  roots.push(dir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

/** Moves every member's mtime to an explicit instant, so assertions on
 *  timestamps are deterministic rather than racing filesystem granularity. */
function setAllMtimes(dir: string, at: Date): void {
  for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), at, at);
}

describe('REQ-1457 AC-3 — staleness is a comparison over the whole build, not one file', () => {
  it('the covered set is the directory: a NEW file landing in it reads stale', async () => {
    const { readBuildSnapshot, buildStale } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);
    expect(loaded.entries.length, 'the snapshot covers every entry, not a chosen file').toBe(3);

    // A rebuild that adds a module changes nothing a one-file anchor would
    // notice — and the running process still holds the OLD module, which is
    // the whole defect.
    fs.writeFileSync(path.join(dir, 'brandNewModule.js'), 'd');
    expect(buildStale(loaded), 'a new member of the build is a changed build').toBe(true);
  });

  it('a member other than cli.js changing reads stale — the set is the build, not the file the card named', async () => {
    const { readBuildSnapshot, buildStale, buildIdentity } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);

    fs.writeFileSync(path.join(dir, 'bridgeServer.js'), 'CHANGED');

    expect(buildStale(loaded), 'AC-3 is computed over the whole dist build, so every module counts').toBe(true);
    expect(
      buildIdentity(loaded).buildId,
      'and genuinely different bytes are a different content identifier',
    ).not.toBe(loaded.buildId);
  });

  it('rewriting cli.js reads stale, with a different buildId (AC-1 primary)', async () => {
    const { readBuildSnapshot, buildStale, buildIdentity } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);
    fs.writeFileSync(path.join(dir, 'cli.js'), 'NEWER BUILD');
    expect(buildStale(loaded)).toBe(true);
    expect(buildIdentity(loaded).buildId).not.toBe(loaded.buildId);
  });

  it('a MEMBER REMOVED reads stale, and never throws', async () => {
    const { readBuildSnapshot, buildStale } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);
    fs.rmSync(path.join(dir, 'bridgeServer.js'));
    expect(typeof buildStale(loaded), 'a diagnostic must not become an outage').toBe('boolean');
    expect(buildStale(loaded), 'a file that vanished is a change, not an absence of one').toBe(true);
  });

  it('an untouched build reads false — the honest "nothing has landed under this process"', async () => {
    const { readBuildSnapshot, buildStale } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);
    expect(buildStale(loaded)).toBe(false);
    expect(buildStale(loaded), 'and it stays false — nothing is drifting on its own').toBe(false);
  });
});

describe('REQ-1457 AC-1 — the touch variant, which a content-only comparison would miss', () => {
  it('touching a member with unchanged bytes reads stale, with an UNCHANGED buildId', async () => {
    const { readBuildSnapshot, buildStale, buildIdentity } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);
    const target = path.join(dir, 'mcpServer.js');

    // AC-1's parenthetical, exactly: a touch changes mtime and nothing else.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(target, future, future);

    expect(buildStale(loaded), 'a touched member reads stale — this is the case the whole-directory anchor exists for').toBe(true);
    expect(
      buildIdentity(loaded).buildId,
      'the CONTENT identifier is deliberately unchanged, so the two fields together separate the two cases',
    ).toBe(loaded.buildId);
  });

  it('a member rewritten to the same size with its mtime restored still reads stale', async () => {
    const { readBuildSnapshot, buildStale, buildIdentity } = await load();
    const dir = scratchBuild({ 'cli.js': 'AAAA', 'mcpServer.js': 'BBBB', 'bridgeServer.js': 'CCCC' });
    const loaded = readBuildSnapshot(dir);
    const target = path.join(dir, 'mcpServer.js');
    const original = fs.statSync(target);

    // Same byte count and the mtime explicitly restored, so size and mtime are
    // both useless here. Written through a temp file and renamed — how an
    // atomic replace actually lands, and why the fingerprint carries the inode.
    const replacement = path.join(dir, '.mcpServer.replacement');
    fs.writeFileSync(replacement, 'DDDD');
    fs.utimesSync(replacement, original.mtime, original.mtime);
    fs.renameSync(replacement, target);

    expect(buildStale(loaded), 'a rebuild that keeps size and mtime is still a rebuild').toBe(true);
    expect(buildIdentity(loaded).buildId, 'and the content identifier catches it too').not.toBe(loaded.buildId);
  });
});

describe('REQ-1457 AC-3/AC-7 — both directions of the comparison are true', () => {
  it('a dist OLDER than the recorded build reads true (AC-7’s literal direction)', async () => {
    const { readBuildSnapshot, buildStale } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);

    // AC-7's own wording: the on-disk dist is older than the build this
    // process recorded. AC-3 words the same fact the other way round, so a
    // strictly directional comparison would satisfy one and silently fail the
    // other. The comparison is inequality, so both wordings are true.
    setAllMtimes(dir, new Date(Date.now() - 60_000));
    expect(buildStale(loaded), 'AC-7: an older dist than the record reads true').toBe(true);
  });

  it('a rebuild with IDENTICAL sources reads stale while buildId stays the same — the documented false positive', async () => {
    const { readBuildSnapshot, buildStale, buildIdentity } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);

    // Byte-identical content with fresh mtimes is exactly what `npm run build`
    // with no source change does. Pinned as a behaviour because the README owes
    // the reader this sentence rather than letting them read `stale: true` as
    // "the fix I am reading is missing".
    const later = new Date(Date.now() + 5000);
    setAllMtimes(dir, later);

    expect(buildStale(loaded), 'the directory was rewritten, so it is stale').toBe(true);
    expect(
      buildIdentity(loaded).buildId,
      'and yet the code is provably the same code — that is what makes this legible rather than alarming',
    ).toBe(loaded.buildId);
    expect(
      buildIdentity(loaded).builtAt,
      'the write instant moved, and it is the pair (builtAt, servedAt) a reader compares',
    ).toBe(later.toISOString());
  });
});

describe('REQ-1457 — an unreadable or absent build degrades, it never throws', () => {
  it('an absent directory answers with nulls and a boolean, not an exception', async () => {
    const { readBuildSnapshot, buildStale, buildIdentity } = await load();
    const missing = path.join(os.tmpdir(), `figpea-mcp-req1457-absent-${Date.now()}`);
    const loaded = readBuildSnapshot(missing);

    expect(typeof buildStale(loaded), 'buildStale stays a boolean even with nothing to compare').toBe('boolean');
    expect(buildIdentity(loaded).buildId, 'the identifier degrades to null rather than a fabricated one').toBeNull();
    expect(buildIdentity(loaded).builtAt).toBeNull();
    expect(buildIdentity(loaded).version, 'the version is baked in, so it survives an unreadable directory').toBeTruthy();
    expect(buildIdentity(loaded).servedAt, 'and so does the load instant').toBeTruthy();
  });

  it('a directory removed AFTER the snapshot reads stale rather than throwing', async () => {
    const { readBuildSnapshot, buildStale } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => buildStale(loaded), 'a build that vanished under the process must not become an outage').not.toThrow();
    expect(buildStale(loaded)).toBe(true);
  });

  it('an unreadable member is treated as changed rather than skipped', async () => {
    const { readBuildSnapshot, buildStale } = await load();
    const dir = scratchBuild();
    const loaded = readBuildSnapshot(dir);
    const target = path.join(dir, 'mcpServer.js');
    fs.chmodSync(target, 0o000);
    try {
      // A shell running as root (or a permissive CI user) can still read a
      // 0000 file, so the test states what it could observe rather than
      // assuming: always a boolean, and — only when the file really is
      // unreadable here — a `true`.
      const unreadable = ((): boolean => {
        try {
          fs.readFileSync(target);
          return false;
        } catch {
          return true;
        }
      })();
      expect(typeof buildStale(loaded), 'never throws, whatever the mode bits say').toBe('boolean');
      if (unreadable) {
        expect(buildStale(loaded), 'an unreadable member is a change, not a member to skip').toBe(true);
      }
    } finally {
      fs.chmodSync(target, 0o644);
    }
  });
});

describe('REQ-1457 — the identity this process serves', () => {
  it('servingBuild() reports the loaded snapshot, and its buildId matches the short content form', async () => {
    const { servingBuild, SERVER_VERSION } = await load();
    const status = servingBuild();
    expect(String(status.build.buildId)).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(status.build.version, 'the baked constant, kept byte-identical for metadata.test.ts').toBe(SERVER_VERSION);
    expect(status.build.root, 'the root is named, so an agent can tell which checkout it is looking at').toBeTruthy();
    expect(typeof status.stale).toBe('boolean');
  });

  it('the timeout stamp carries version, identifier and both instants in one line', async () => {
    const { servingBuildStamp, SERVER_VERSION } = await load();
    const stamp = servingBuildStamp();
    expect(stamp, 'one line, no newlines').not.toContain('\n');
    expect(stamp).toContain(SERVER_VERSION);
    expect(stamp).toMatch(/sha256:[0-9a-f]{12}/);
    expect(stamp).toMatch(/built \d{4}-\d{2}-\d{2}T/);
    expect(stamp).toMatch(/loaded \d{4}-\d{2}-\d{2}T/);
  });
});