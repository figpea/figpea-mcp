/**
 * REQ-1457 — the ONE build-identity ledger: the version this process runs, the
 * artifact it loaded, and whether that artifact is still the artifact on disk.
 *
 * The defect this module exists to close is not that the information is
 * unavailable — it is that the information is not about anything. Every field
 * `figpea_status` published before this was either *connection* state (`port`,
 * `token`, `url`, `tabConnected`, `connection`) or *manifest* state
 * (`contractVersion`, `toolCount`), and the manifest is fetched from the editor
 * at startup, so it is entirely independent of the code in this process. The
 * stdio process is owned by the MCP host and is never restarted, so a `dist/`
 * rebuild landing *underneath* a running process leaves zero observable trace.
 *
 * The consequence was filed as a bug and it is worth naming in the card's own
 * words: a `layer.batch` `filePath` fix merged, the serving process had started
 * seventeen hours earlier, and a 404 read as *"the file is missing"* rather than
 * *"this process predates the fix"*. Nothing on the payload could tell those two
 * apart. A class of failure — stale infrastructure mistaken for broken product —
 * that recurs on every long-lived MCP session after any merge.
 *
 * It stays a leaf, in the shape `connectionDiagnosis.ts`, `callTimeout.ts` and
 * `rawJson.ts` already establish in this package. Deliberately: `mcpServer.ts`
 * (status) and `bridgeServer.ts` (the AC-4 timeout stamp) both need this, and
 * neither may import the other.
 *
 * ── THE ANCHOR IS THE WHOLE `dist/`, NOT ONE FILE ───────────────────────────
 * The obvious first version snapshotted `dist/cli.js` alone. That is wrong, and
 * AC-1 names why in its own parenthetical — *"or touch `dist/mcpServer.js`"* —
 * which one file cannot see: touching any other file leaves the flag false and
 * the payload byte-identical, which is the exact symptom this requirement was
 * filed to remove, rebuilt inside its own fix. So the unit of comparison is the
 * BUILD. In production `__dirname` is `<pkg>/dist` (tsconfig.build.json sets
 * `rootDir: src` / `outDir: dist` with no nesting), so every entry is covered —
 * both files AC-1 names and every module they load — **by construction, not by
 * assertion**. Running from source, the covered set is this module's own file
 * alone, which keeps the unit suites hermetic: editing an unrelated source file
 * must not flip staleness in a test that never asked about it.
 *
 * ── TWO IDENTITIES, DELIBERATELY DIFFERENT ─────────────────────────────────
 * AC-2 offers "mtime **or** content hash" as if they were interchangeable. They
 * are not, and one of them cannot do the job the other can:
 *
 *  - `buildId` — a sha256 over the `.js` members' bytes, read from the build on
 *    disk. It answers *"which build is this?"*, the string a reader matches
 *    against a commit, and it is deliberately STABLE across a rebuild that
 *    changed no code.
 *  - `buildStale` — a `(size, mtimeMs, ino)` fingerprint per entry, compared
 *    against the one recorded at load. It answers *"has the build changed since
 *    I loaded it?"*, and it MUST include mtime: AC-1 explicitly offers *touching*
 *    a file as a trigger, and a content-only comparison would report `false` for
 *    it.
 *
 * The price is a real, documented false positive — `npm run build` with no
 * source change reports `buildStale: true` — and the mitigation is that
 * `buildId` is UNCHANGED in that case, so the two fields together separate
 * *"newer code is waiting"* from *"the directory was rebuilt"*. The README owes
 * the reader that sentence rather than letting `stale: true` read as "the fix I
 * am reading is missing".
 *
 * ── WHY `buildId` IS READ LIVE RATHER THAN FROZEN AT LOAD ───────────────────
 * Only one reading makes the mitigation above real. If `buildId` were the value
 * frozen when this process loaded, it could never change, "unchanged" would be a
 * tautology, and a reader would have no way at all to tell the two cases apart.
 * Read from disk it is provably the build this process loaded whenever
 * `buildStale` is false (nothing has moved), and diverges from it exactly when
 * something has. That is the property the whole field rests on, so it is stated
 * here rather than left for a reader to infer.
 *
 * ── WHAT IT DOES NOT CLAIM ─────────────────────────────────────────────────
 * `buildStale: false` does not mean "your build is current". It compares against
 * `figpea-mcp/dist` on the machine running this MCP server, and says nothing at
 * all about the editor tab's build — a different process on a different origin.
 * And this module does not fix the incident it was filed from: the stdio process
 * is owned by the host and never restarted, so `buildStale: true` is a
 * DIAGNOSIS, and the remedy is restarting the MCP server.
 *
 * Nothing here throws. A diagnostic must not become an outage: an absent or
 * unreadable build degrades to `null` identifiers and a `true` staleness flag,
 * because "I cannot prove it is unchanged" and "it is unchanged" are different
 * answers and only the first one is safe to report.
 *
 * `import.meta.url` is NOT available here — `tsconfig.json` sets
 * `"module": "CommonJS"`. The anchor is `__dirname`-relative with an
 * `__filename` fallback, both of which this package already uses.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * The version this build reports, baked rather than read from `package.json`.
 *
 * A runtime read of `<pkg>/package.json` can fail, and it is less honest than
 * this constant: after rebuilding `dist` from newer source without a version
 * bump, `package.json` describes the *installed* release while this describes the
 * *running code*, and the running code is what this field exists to answer for.
 * `metadata.test.ts` pins the two equal.
 *
 * REQ-1457 MOVED this from `mcpServer.ts`, because `bridgeServer.ts` needs it for
 * the AC-4 timeout stamp and reaching it from there would import the heavier
 * module into this leaf. That test's regex is unchanged — only the file it reads
 * moved — so the DECLARATION's literal form is load-bearing: a type annotation,
 * which reads the same and means the same, breaks the match and turns an
 * unrelated suite red for a reason nobody would connect to that requirement. (For
 * the same reason this docblock deliberately never spells the declaration out
 * inline: `metadata.test.ts` takes the FIRST match of its regex in this file,
 * and a commented-out copy would answer for the real one.)
 */
export const SERVER_VERSION = '2.9.0';

/** One covered file, as a fingerprint. `ino` catches an atomic replace. */
export interface BuildEntry {
  name: string;
  size: number;
  mtimeMs: number;
  ino: number;
  /** False for a directory — a directory is covered by fingerprint, not hashed. */
  isFile: boolean;
  /** False when the entry could not be stat'd — treated as CHANGED. */
  readable: boolean;
}

/** The build as this process found it. A fact about the past, recorded once. */
export interface BuildSnapshot {
  /** The compared root: the `dist/` directory in a build, or this file in source. */
  root: string;
  entries: BuildEntry[];
  /** Content identifier at load. Null when the whole set was unreadable. */
  buildId: string | null;
  /** ISO-8601 instant this process loaded the build. */
  loadedAt: string;
  /** False when some entry could not be read at snapshot time. */
  complete: boolean;
}

/** What `status` publishes, and what the timeout stamp reads. */
export interface BuildIdentity {
  version: string;
  buildId: string | null;
  builtAt: string | null;
  servedAt: string;
  root: string;
}

export interface BuildStatus {
  build: BuildIdentity;
  stale: boolean;
}

/** Short enough to read out loud and paste into a search; long enough to be a hash. */
const BUILD_ID_CHARS = 12;

/** The compared root, decided once from where this module itself was loaded. */
function defaultRoot(): string {
  return path.basename(__dirname) === 'dist' ? __dirname : __filename;
}

/** Fingerprints two entry lists, order-independently. */
function sameEntries(a: BuildEntry[], b: BuildEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.name !== y.name || x.size !== y.size || x.mtimeMs !== y.mtimeMs || x.ino !== y.ino) return false;
  }
  return true;
}

/**
 * Reads `dir` right now: every entry's fingerprint plus the content identifier.
 *
 * PURE and exported so the suite can point it at a temp dir instead of
 * destructively moving the repo's own `dist/` aside. Never throws — an absent
 * directory, an unreadable entry and an unreadable `.js` body all degrade.
 */
export function readBuildSnapshot(dir: string = defaultRoot()): BuildSnapshot {
  const entries: BuildEntry[] = [];
  let complete = true;
  let isDirectory = false;

  try {
    isDirectory = fs.statSync(dir).isDirectory();
  } catch {
    complete = false;
  }

  if (isDirectory) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      complete = false;
    }
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(dir, name));
        entries.push({ name, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, isFile: st.isFile(), readable: true });
      } catch {
        complete = false;
        entries.push({ name, size: -1, mtimeMs: -1, ino: -1, isFile: true, readable: false });
      }
    }
  } else if (complete) {
    // Not a directory, so `dir` is a single file (the source-run case).
    try {
      const st = fs.statSync(dir);
      entries.push({ name: path.basename(dir), size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, isFile: st.isFile(), readable: true });
    } catch {
      complete = false;
    }
  }

  return {
    root: dir,
    entries,
    buildId: hashMembers(dir, entries, isDirectory),
    loadedAt: new Date().toISOString(),
    complete,
  };
}

/**
 * One sha256 over every regular file in the covered set, in name order so the
 * result does not depend on directory iteration order.
 *
 * NOT a `.js`-only hash, and the reason is the source-run case: running from
 * source the covered set is this module's own `.ts` file, and an
 * extension-filtered hash would find nothing to read and degrade to `null` in
 * exactly the environment where the unit suites need a real identifier. In a
 * build the extra members are the `.d.ts` and `.js.map` that ship beside the
 * code — part of the published artifact, and they change whenever the code does.
 *
 * Null when NO member could be read — a fabricated identifier is worse than an
 * absent one, because it is indistinguishable from a real answer.
 */
function hashMembers(dir: string, entries: BuildEntry[], isDirectory: boolean): string | null {
  const hashed = entries.filter((e) => e.isFile);
  const hash = crypto.createHash('sha256');
  let read = 0;
  for (const entry of hashed) {
    // In the single-file case `dir` IS the file, so joining the name onto it
    // would look for `<file>/<name>` and read nothing — which is exactly how a
    // source-run buildId silently became `null`.
    const target = isDirectory ? path.join(dir, entry.name) : dir;
    try {
      const bytes = fs.readFileSync(target);
      // Length-prefixed, so no two different file sets can concatenate to the
      // same digest input ("ab" + "c" must not read as "a" + "bc").
      const digest = crypto.createHash('sha256').update(bytes).digest();
      hash.update(`${entry.name}:${bytes.length}:`).update(digest);
      read++;
    } catch {
      // A member we cannot read contributes nothing; the caller cannot then
      // prove the build is unchanged, which is the safe direction.
    }
  }
  if (read === 0) return null;
  return `sha256:${hash.digest('hex').slice(0, BUILD_ID_CHARS)}`;
}

/** The build as this process loaded it, re-read against what is on disk now. */
function statusFor(snapshot: BuildSnapshot): BuildStatus {
  const live = readBuildSnapshot(snapshot.root);
  const stale =
    !live.complete ||
    live.buildId !== snapshot.buildId ||
    !sameEntries(live.entries, snapshot.entries);

  const newestMtime = live.entries.reduce((max, e) => (e.readable && e.mtimeMs > max ? e.mtimeMs : max), Number.NEGATIVE_INFINITY);

  return {
    build: {
      version: SERVER_VERSION,
      buildId: live.buildId,
      builtAt: Number.isFinite(newestMtime) ? new Date(newestMtime).toISOString() : null,
      servedAt: snapshot.loadedAt,
      root: snapshot.root,
    },
    stale,
  };
}

/**
 * `buildStale === true` iff the covered set is not the set this process loaded —
 * a newer build landing underneath it (AC-3), a `touch` (AC-1's parenthetical),
 * a rollback to an older `dist` (AC-7's literal wording), or a member that
 * vanished. That is a superset of AC-3's directional reading, not a narrowing of
 * it: a strict `disk.mtime > served.mtime` comparison would return `false` for
 * AC-7's own case, so it cannot be what both ACs mean.
 *
 * Re-read PER CALL. Staleness is a live fact, not a load-time constant — a
 * provider frozen at startup answers `false` forever, which is the bug in a
 * different costume.
 */
export function buildStale(snapshot: BuildSnapshot = LOADED_SNAPSHOT): boolean {
  return statusFor(snapshot).stale;
}

/** The identity block alone, on the same live read `buildStale` uses. */
export function buildIdentity(snapshot: BuildSnapshot = LOADED_SNAPSHOT): BuildIdentity {
  return statusFor(snapshot).build;
}

/** Both facts from ONE directory read — what `status` publishes. */
export function servingBuild(snapshot: BuildSnapshot = LOADED_SNAPSHOT): BuildStatus {
  return statusFor(snapshot);
}

/**
 * The one-line stamp AC-4 appends to an authored timeout envelope.
 *
 * Appended AFTER the existing text, never substituted for it: REQ-772's and
 * REQ-1282's clauses are pinned by other suites and must survive byte-for-byte.
 *
 * The `snapshot` parameter exists for the suite and for nothing else. The
 * production call sites pass none, so they always stamp THIS process's own
 * build; taking one is the only honest way to observe the stale form without a
 * test editing the repo's `dist/` (which three other suites spawn concurrently,
 * and which is gitignored, so the damage would never show in a diff).
 */
export function servingBuildStamp(snapshot: BuildSnapshot = LOADED_SNAPSHOT): string {
  const { build, stale } = statusFor(snapshot);
  const stamp =
    `served by figpea-mcp ${build.version} build ${build.buildId ?? 'unavailable'} ` +
    `(built ${build.builtAt ?? 'unknown'}, loaded ${build.servedAt})`;
  return stale ? `${stamp} — the served file has changed on disk since this process loaded it` : stamp;
}

/**
 * The snapshot THIS process loaded, recorded once at module load.
 *
 * It is a fact about the process's past, so it must never be re-derived later —
 * a staleness flag compared against a freshly-taken "load" snapshot would be
 * identically true and permanently false of anything.
 */
const LOADED_SNAPSHOT: BuildSnapshot = readBuildSnapshot();