/**
 * REQ-1020 T1 — off-band image-return writer (plan D3).
 *
 * `canvas.screenshot` / `export.layer` / `export.artboard` already hand
 * `figpea-mcp` the decoded bytes; this module is the *write* half of the
 * `returnAs:"path"` mode: it persists one image result under a per-session
 * temp dir and returns the absolute path + raw size for the text payload.
 *
 * Deliberately dependency-free apart from node builtins (`fs`/`os`/`path`/
 * `crypto`): `bridgeServer.ts` and `mcpServer.ts` already depend on those.
 * `tools.ts` does NOT import this module — it stays importable from the v3
 * happy-dom test env with zero runtime cost (see its header); the writer is
 * injected into `resultToContent` via options, and `mcpServer` wires the real
 * one (plan D2).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** figpea-mcp-only failure code (plan D3, AC-4/AC-6): never added to the v3
 * contract, never bumps `VERSION` — same standing as mcpServer's existing
 * local codes (`no_tab`, `bridge_error`, `open_failed`). */
export const RETURN_PATH_WRITE_FAILED = 'return_path_write_failed';

/** Per-session disk cap (plan D3): past it the write is refused with the
 * coded error rather than filling the disk. */
export const MAX_SESSION_BYTES = 500 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

export interface WriteImageReturnArgs {
  bytesB64: string;
  mime: string;
  width: number;
  height: number;
  /** Originating tool name (e.g. `canvas_screenshot`) — filename prefix only. */
  tool: string;
  /** Session-scoped dir, from `sessionDirFor(token)` — created on demand. */
  sessionDir: string;
}

export interface WrittenImageReturn {
  path: string;
  mime: string;
  width: number;
  height: number;
  /** Raw (decoded) byte size. */
  bytes: number;
}

export type ImageWriter = (args: WriteImageReturnArgs) => WrittenImageReturn;

/** `<os.tmpdir()>/figpea-mcp/<token>/` (plan D5) — `token` is the bridge
 * server's per-run UUID, so concurrent bridges never share a dir. */
export function sessionDirFor(token: string): string {
  return path.join(os.tmpdir(), 'figpea-mcp', token);
}

/** Best-effort recursive removal for `bridgeServer.close()` (plan D5, AC-5):
 * never throws — a cleanup failure must not fail server shutdown. */
export function removeSessionDir(sessionDir: string): void {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // Best effort only (see above).
  }
}

function codedError(message: string): Error {
  return Object.assign(new Error(message), { code: RETURN_PATH_WRITE_FAILED });
}

function sessionBytes(sessionDir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return 0; // Dir does not exist yet — nothing counted against the cap.
  }
  for (const entry of entries) {
    try {
      total += fs.statSync(path.join(sessionDir, entry)).size;
    } catch {
      // Raced deletion — ignore.
    }
  }
  return total;
}

/**
 * Persists one image result and returns its path + raw size (plan D3).
 *
 * Filename `<tool>-<isoTimestamp>-<uuid>.<ext>` (per-call UUID: concurrent
 * calls in one session never collide). Exclusive create (`'wx'`) into a
 * temp name + rename, so a failed write can never leave partial bytes behind
 * (temp is unlinked on error). Every failure path throws an Error carrying
 * `code: 'return_path_write_failed'` (AC-4).
 */
export function writeImageReturn(args: WriteImageReturnArgs): WrittenImageReturn {
  const { bytesB64, mime, width, height, tool, sessionDir } = args;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(bytesB64, 'base64');
  } catch (e) {
    throw codedError(`cannot decode image bytes: ${e instanceof Error ? e.message : String(e)}`);
  }

  const safeTool = tool.replace(/[^A-Za-z0-9_-]/g, '_') || 'image';
  const ext = MIME_TO_EXT[mime] ?? 'bin';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${safeTool}-${stamp}-${crypto.randomUUID()}.${ext}`;

  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    if (sessionBytes(sessionDir) + bytes.length > MAX_SESSION_BYTES) {
      throw codedError(`per-session cap of ${MAX_SESSION_BYTES} bytes exceeded`);
    }
    const tmpPath = path.join(sessionDir, `${name}.part-${crypto.randomUUID()}`);
    const finalPath = path.join(sessionDir, name);
    try {
      const fd = fs.openSync(tmpPath, 'wx');
      try {
        fs.writeFileSync(fd, bytes);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, finalPath);
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Already gone — nothing partial remains, which is the point.
      }
      throw e;
    }
    return { path: finalPath, mime, width, height, bytes: bytes.length };
  } catch (e) {
    if ((e as { code?: unknown })?.code === RETURN_PATH_WRITE_FAILED) throw e;
    throw codedError(`cannot write image return file: ${e instanceof Error ? e.message : String(e)}`);
  }
}
