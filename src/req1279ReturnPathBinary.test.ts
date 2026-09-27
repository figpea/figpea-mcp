import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeImageReturn, MAX_SESSION_BYTES, RETURN_PATH_WRITE_FAILED } from './returnPath';

/**
 * REQ-1279 T2 (test-first) — the writer units for a payload that names itself.
 *
 * `returnAs:"path"` derived the on-disk name from the mime alone, through a
 * five-entry image table, so a non-image export could only ever land as `.bin`.
 * The rules these tests pin are the AC's, not an implementation's:
 *   - a payload carrying its own `filename` is written under that name's
 *     extension (AC-2/AC-9): a `.fp` export lands as `.fp`, never `.bin`;
 *   - the payload's own name contributes a sanitised stem, so the written file
 *     is recognisable — and a tab-supplied name can never escape the session
 *     directory (AC-2, and the safety property the naming rule depends on);
 *   - a payload with no usable name still writes something rather than throwing
 *     (AC-9);
 *   - the existing guarantees REQ-1020 established — per-call uniqueness, the
 *     session cap, the coded failure, and no partial bytes — are unchanged.
 *
 * NOTE on the cast below: `filename` is not an accepted argument on the
 * unfixed writer, so a literal would be a compile error in the test-only commit.
 * The cast is deliberate (this repo's `req1020ReturnAs.test.ts` precedent) so
 * the file compiles today and fails on ASSERTIONS, never on setup.
 */

const B64 = Buffer.from('req1279-writer-bytes').toString('base64');

interface PlannedWriteArgs {
  bytesB64: string;
  mime: string;
  width: number;
  height: number;
  tool: string;
  sessionDir: string;
  filename?: string;
}

/** Calls the writer with the planned signature on any tree. */
function write(args: PlannedWriteArgs) {
  return (writeImageReturn as unknown as (a: PlannedWriteArgs) => ReturnType<typeof writeImageReturn>)(args);
}

function sessionDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'req1279-w-')), 'sess');
}

describe('REQ-1279 AC-9: a payload that names itself is written under its own extension', () => {
  it('writes a .fp payload as .fp, never .bin', () => {
    const dir = sessionDir();
    const out = write({ bytesB64: B64, mime: 'application/zip', width: 0, height: 0, tool: 'export_project', sessionDir: dir, filename: 'x.fp' });
    expect(out.path, 'the extension comes from the payload, not the mime table').toMatch(/\.fp$/);
    expect(out.path, 'never .bin').not.toMatch(/\.bin$/);
    expect(path.basename(out.path), 'the written name carries the payload stem').toContain('x');
  });

  it('an unknown mime with no filename still writes a file rather than throwing', () => {
    const dir = sessionDir();
    const out = write({ bytesB64: B64, mime: 'application/x-not-a-real-thing', width: 0, height: 0, tool: 'export_flowPoster', sessionDir: dir });
    expect(out.path).toMatch(/\.bin$/);
    expect(fs.existsSync(out.path), 'a file exists').toBe(true);
    expect(out.bytes, 'bytes is the decoded length').toBe(fs.statSync(out.path).size);
    expect(out.bytes).toBe(Buffer.from(B64, 'base64').length);
  });

  it('the filename-less image companions keep deriving their extension from the mime', () => {
    const dir = sessionDir();
    expect(write({ bytesB64: B64, mime: 'image/jpeg', width: 1, height: 1, tool: 'export_layer', sessionDir: dir }).path).toMatch(/\.jpg$/);
    expect(write({ bytesB64: B64, mime: 'image/svg+xml', width: 1, height: 1, tool: 'export_artboard', sessionDir: dir }).path).toMatch(/\.svg$/);
  });

  it('the non-image mimes the export contract declares are known even without a filename', () => {
    const dir = sessionDir();
    expect(write({ bytesB64: B64, mime: 'application/zip', width: 0, height: 0, tool: 'export_originals', sessionDir: dir }).path).toMatch(/\.zip$/);
    expect(write({ bytesB64: B64, mime: 'application/pdf', width: 0, height: 0, tool: 'export_contactSheet', sessionDir: dir }).path).toMatch(/\.pdf$/);
    expect(write({ bytesB64: B64, mime: 'application/json', width: 0, height: 0, tool: 'figpea_describe', sessionDir: dir }).path).toMatch(/\.json$/);
  });
});

describe('REQ-1279 AC-2: the written name carries a sanitised stem', () => {
  it('a payload name with spaces and punctuation is sanitised but recognisable', () => {
    const dir = sessionDir();
    const out = write({ bytesB64: B64, mime: 'application/pdf', width: 0, height: 0, tool: 'export_contactSheet', sessionDir: dir, filename: 'My Design-contact-sheet.pdf' });
    expect(out.path, 'the extension is still .pdf').toMatch(/\.pdf$/);
    const base = path.basename(out.path);
    expect(base, 'no space survives into the on-disk name').not.toContain(' ');
    expect(base, 'the sanitised stem is still recognisable').toContain('My_Design-contact-sheet');
  });

  it('a payload name that tries to traverse escapes nothing: the write stays in the session dir', () => {
    const dir = sessionDir();
    const out = write({ bytesB64: B64, mime: 'application/zip', width: 0, height: 0, tool: 'export_project', sessionDir: dir, filename: '../../../etc/passwd.fp' });
    expect(path.dirname(fs.realpathSync(out.path)), 'the file lands inside the session dir').toBe(fs.realpathSync(dir));
    expect(path.basename(out.path), 'no separator survives into the name').not.toContain('/');
    expect(path.basename(out.path)).not.toContain('..');
    expect(out.path).toMatch(/\.fp$/);
  });
});

describe('REQ-1279: the REQ-1020 guarantees survive the naming change', () => {
  it('concurrent writes never collide (per-call unique names)', () => {
    const dir = sessionDir();
    const a = write({ bytesB64: B64, mime: 'image/png', width: 1, height: 1, tool: 'canvas_screenshot', sessionDir: dir });
    const b = write({ bytesB64: B64, mime: 'image/png', width: 1, height: 1, tool: 'canvas_screenshot', sessionDir: dir });
    expect(a.path).not.toBe(b.path);
  });

  it('two exports of the same project in one session do not collide', () => {
    const dir = sessionDir();
    const a = write({ bytesB64: B64, mime: 'application/zip', width: 0, height: 0, tool: 'export_project', sessionDir: dir, filename: 'My Design.fp' });
    const b = write({ bytesB64: B64, mime: 'application/zip', width: 0, height: 0, tool: 'export_project', sessionDir: dir, filename: 'My Design.fp' });
    expect(a.path, 'same payload name, two distinct files').not.toBe(b.path);
    expect(fs.readdirSync(dir).length).toBe(2);
  });

  it('a write past the per-session cap is refused with the coded failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1279-cap-'));
    // Sparse (truncated, never written) — the cap is checked against the size
    // the session dir already reports, so no real disk is consumed.
    const sparse = path.join(dir, 'sparse.bin');
    fs.writeFileSync(sparse, '');
    fs.truncateSync(sparse, MAX_SESSION_BYTES);
    let code: string | undefined;
    try {
      write({ bytesB64: B64, mime: 'application/zip', width: 0, height: 0, tool: 'export_project', sessionDir: dir, filename: 'My Design.fp' });
    } catch (e: any) {
      code = e?.code;
    }
    expect(code).toBe(RETURN_PATH_WRITE_FAILED);
    expect(fs.readdirSync(dir), 'nothing partial was created').toEqual(['sparse.bin']);
  });

  it('an unwritable session dir throws the coded failure, never a raw one', () => {
    let code: string | undefined;
    try {
      write({ bytesB64: B64, mime: 'application/zip', width: 0, height: 0, tool: 'export_project', sessionDir: '/proc/req1279-unwritable-xyz', filename: 'x.fp' });
    } catch (e: any) {
      code = e?.code;
    }
    expect(code).toBe(RETURN_PATH_WRITE_FAILED);
  });

  it('a failed write leaves no partial file behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1279-w-'));
    const fileAsDir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'original');
    let code: string | undefined;
    try {
      write({ bytesB64: B64, mime: 'application/zip', width: 0, height: 0, tool: 'export_project', sessionDir: fileAsDir, filename: 'x.fp' });
    } catch (e: any) {
      code = e?.code;
    }
    expect(code).toBe(RETURN_PATH_WRITE_FAILED);
    expect(fs.readFileSync(fileAsDir, 'utf8'), 'original bytes untouched').toBe('original');
    expect(fs.readdirSync(dir), 'no partial file created').toEqual(['not-a-dir']);
  });
});
