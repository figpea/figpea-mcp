import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeImageReturn } from './returnPath';

/**
 * REQ-1020 T1 (test-first) — `src/returnPath.ts` session writer unit tests
 * (AC-2 file layout, AC-4 failure semantics).
 *
 * `returnPath.ts` does not exist yet (T1 builds it) — every test below fails
 * at this file's own import statement, never inside an assertion. That is the
 * intended RED, per this repo's own precedent (`src/tools.test.ts` REQ-074 T1:
 * "fails at this file's own import statement ... That is the intended RED").
 *
 * ASSUMPTIONS (the plan pins the *rules*, not exact export names — best
 * judgment below; the builder either conforms or pushes back with the concrete
 * shape it needs instead):
 *   - `writeImageReturn(args: { bytesB64: string; mime: string; width: number;
 *     height: number; tool: string; sessionDir: string }): { path, mime, width,
 *     height, bytes }` — writes decoded bytes under sessionDir, returns the
 *     absolute path + raw byte size.
 *   - Filename `<tool>-<timestamp>-<uuid>.<ext>`, ext from mime
 *     (image/png→png, image/jpeg→jpg, image/webp→webp, image/gif→gif,
 *     image/svg+xml→svg); exclusive create (`wx`) + write-temp-then-rename.
 *   - Per-session cap 500 MB (sum of sessionDir); past it, or on any I/O
 *     failure, throws an Error carrying `code: 'return_path_write_failed'`
 *     and leaves no partial file behind.
 */

const B64 = Buffer.from('req1020-writer-bytes').toString('base64');

function sessionDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'req1020-w-')), 'sess');
}

describe('REQ-1020 T1: writeImageReturn file layout (AC-2)', () => {
  it('writes decoded bytes under the session dir and returns path + raw size', () => {
    const dir = sessionDir();
    const out = writeImageReturn({ bytesB64: B64, mime: 'image/png', width: 4, height: 2, tool: 'canvas_screenshot', sessionDir: dir });
    expect(path.isAbsolute(out.path)).toBe(true);
    expect(out.path.startsWith(dir + path.sep)).toBe(true);
    expect(out.mime).toBe('image/png');
    expect(out.width).toBe(4);
    expect(out.height).toBe(2);
    const onDisk = fs.readFileSync(out.path);
    expect(onDisk.equals(Buffer.from(B64, 'base64'))).toBe(true);
    expect(out.bytes).toBe(onDisk.length);
  });

  it('derives the extension from the mime type', () => {
    const dir = sessionDir();
    expect(writeImageReturn({ bytesB64: B64, mime: 'image/jpeg', width: 1, height: 1, tool: 'export_layer', sessionDir: dir }).path).toMatch(/\.jpg$/);
    expect(writeImageReturn({ bytesB64: B64, mime: 'image/svg+xml', width: 1, height: 1, tool: 'export_artboard', sessionDir: dir }).path).toMatch(/\.svg$/);
  });

  it('concurrent writes never collide (per-call unique names)', () => {
    const dir = sessionDir();
    const a = writeImageReturn({ bytesB64: B64, mime: 'image/png', width: 1, height: 1, tool: 'canvas_screenshot', sessionDir: dir });
    const b = writeImageReturn({ bytesB64: B64, mime: 'image/png', width: 1, height: 1, tool: 'canvas_screenshot', sessionDir: dir });
    expect(a.path).not.toBe(b.path);
  });
});

describe('REQ-1020 T1: writeImageReturn failure semantics (AC-4)', () => {
  it('an unwritable session dir throws return_path_write_failed', () => {
    let code: string | undefined;
    try {
      writeImageReturn({ bytesB64: B64, mime: 'image/png', width: 1, height: 1, tool: 'canvas_screenshot', sessionDir: '/proc/req1020-unwritable-xyz' });
    } catch (e: any) {
      code = e?.code;
    }
    expect(code).toBe('return_path_write_failed');
  });

  it('a failed write leaves no partial file behind', () => {
    // A session dir that is an existing regular file makes every write fail
    // deterministically (mkdir/stat/write all reject it) — the observable
    // AC-4 contract: coded throw, original bytes untouched, no new files.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1020-w-'));
    const fileAsDir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'original');
    let code: string | undefined;
    try {
      writeImageReturn({ bytesB64: B64, mime: 'image/png', width: 1, height: 1, tool: 'canvas_screenshot', sessionDir: fileAsDir });
    } catch (e: any) {
      code = e?.code;
    }
    expect(code).toBe('return_path_write_failed');
    expect(fs.readFileSync(fileAsDir, 'utf8'), 'original bytes untouched').toBe('original');
    expect(fs.readdirSync(dir), 'no partial file created').toEqual(['not-a-dir']);
  });
});
