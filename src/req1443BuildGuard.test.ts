import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { requireBuiltCli } from './testSupport/requireBuiltCli.test-helper';

/**
 * REQ-1443 AC-1/AC-2 — the precondition guard's failure contract.
 *
 * The bug this pins: three suites spawn the *built* `dist/cli.js` over real
 * stdio. On a cold `dist/` the child dies before any MCP handshake, and the
 * SDK reports that as `MCP error -32000: Connection closed` — so a build
 * ordering problem is re-reported wearing the costume of a product failure,
 * at 10 call sites across 3 files.
 *
 * What a contributor must be able to act on is therefore not "something
 * failed" but *what* failed and *what to do*: the missing path, the fact that
 * the tests drive the built entry rather than the source, and the remedy. These
 * assertions pin those three facts as observable behaviour of the guard.
 *
 * They are hermetic by construction: the guard takes the entry path as an
 * argument precisely so this suite can point it at a path that is known-absent
 * (or a temp file that is known-present) instead of destructively moving
 * `dist/` aside to observe a failure.
 *
 * Note what is NOT pinned: the exact wording of the message. These are
 * fact-level assertions (the path, the reason, the remedy), so a harmless
 * rewording passes while a message that dropped the remedy — the thing that
 * makes the failure actionable — does not.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const scratchDirs: string[] = [];

function makeScratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1443-guard-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length) {
    fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('REQ-1443 — requireBuiltCli precondition guard', () => {
  describe('when the built entry is missing (the cold-`dist/` case)', () => {
    const missingPath = path.join(makeScratchDir(), 'dist', 'cli.js');

    it('throws — it must never silently skip, or the gate would be green over an untested surface', () => {
      expect(() => requireBuiltCli(missingPath)).toThrow();
    });

    it('names the missing absolute path, so the reader can see which artifact is absent', () => {
      expect(() => requireBuiltCli(missingPath)).toThrow(missingPath);
    });

    it('says the tests drive the BUILT entry, not the source (AC-1: the cause, not just the symptom)', () => {
      let message = '';
      try {
        requireBuiltCli(missingPath);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, 'the message names the built entry that is missing').toMatch(/dist[\\/]cli\.js/);
      expect(
        message,
        'the message says this is a build artifact the tests spawn, rather than leaving the reader to guess',
      ).toMatch(/built|build/i);
    });

    it('carries the exact remedy `npm run build` (AC-1: the failure must be actionable)', () => {
      expect(() => requireBuiltCli(missingPath)).toThrow('npm run build');
    });

    it('never reports the failure as a transport/connection close (AC-2)', () => {
      // AC-2's operative clause: no failure whose cause is the missing build
      // may surface as `Connection closed`. If the guard ever deferred to the
      // transport, this is the assertion that catches it.
      let message = '';
      try {
        requireBuiltCli(missingPath);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message.toLowerCase()).not.toMatch(/connection closed|-32000/);
    });
  });

  describe('when the built entry exists (the ordinary, built case)', () => {
    it('is silent and returns the resolved entry path', () => {
      const built = path.join(makeScratchDir(), 'cli.js');
      fs.writeFileSync(built, '// stand-in for a built entry\n');

      let returned: string | undefined;
      expect(() => {
        returned = requireBuiltCli(built);
      }, 'an existing entry must not throw — this is the path every green run takes').not.toThrow();

      expect(returned, 'the caller gets the path it is about to spawn').toBe(path.resolve(built));
    });

    it('honours a path that only needs resolving, so a relative argument is still checked as absolute', () => {
      const built = path.join(makeScratchDir(), 'cli.js');
      fs.writeFileSync(built, '// stand-in for a built entry\n');

      let returned: string | undefined;
      expect(() => {
        returned = requireBuiltCli(path.relative(process.cwd(), built));
      }).not.toThrow();
      expect(returned).toBe(built);
    });
  });

  describe('the entry it guards by default', () => {
    it('is this package\'s own dist/cli.js — the file the three CLI-spawning suites spawn', () => {
      // Called with no argument, the guard must check the same entry the
      // suites spawn. Asserted through the *behaviour* (a missing default entry
      // throws naming that path) rather than through an exported constant, so
      // the test pins the contract and not the shape.
      const expected = path.join(PACKAGE_ROOT, 'dist', 'cli.js');
      const exists = fs.existsSync(expected);

      if (exists) {
        // Built: the default path is the real one and the guard is silent.
        expect(() => requireBuiltCli()).not.toThrow();
      } else {
        // Cold (the AC-1 state): the default path is the absent one and the
        // guard must name it.
        expect(() => requireBuiltCli()).toThrow(expected);
      }
    });
  });
});