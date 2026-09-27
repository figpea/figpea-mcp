/**
 * REQ-1020 T1 / REQ-1279 T3 — off-band binary-return writer.
 *
 * `canvas.screenshot` / `export.layer` / `export.artboard` / every other
 * binary export already hand `figpea-mcp` the decoded bytes; this module is
 * the *write* half of the `returnAs:"path"` mode: it persists one result
 * under a per-session temp dir and returns the absolute path + raw size for
 * the text payload.
 *
 * REQ-1279: the writer was image-only end to end — the on-disk extension came
 * from a five-entry image mime table, so a `.fp` project export could only
 * ever land as `.bin`. It now takes the payload's own `filename` and derives
 * both the extension and a recognisable stem from it (see `resolveName`).
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

/** Fallback extension by mime, used when the payload carries no usable name of
 *  its own. REQ-1279 added the three non-image mimes the v3 export contract
 *  actually declares, so a *known* mime never reaches `.bin`; `.bin` stays
 *  reachable for a genuinely unknown one. */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/zip': 'zip',
  'application/pdf': 'pdf',
  'application/json': 'json',
};

/** Longest stem kept from a tab-supplied filename. */
const MAX_STEM = 80;

export interface WriteImageReturnArgs {
  bytesB64: string;
  mime: string;
  width: number;
  height: number;
  /** Originating tool name (e.g. `canvas_screenshot`) — filename prefix only. */
  tool: string;
  /** Session-scoped dir, from `sessionDirFor(token)` — created on demand. */
  sessionDir: string;
  /**
   * REQ-1279 — the payload's own filename, when it has one. The v3 export
   * contract declares `{bytes, mime, filename}` on every binary export, so
   * this is what makes a `.fp` land as `.fp` instead of `.bin`. Absent for
   * `canvas.screenshot`, the one binary result that carries no filename.
   */
  filename?: string;
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
 * REQ-1279 — the on-disk name for one off-band return.
 *
 * `<tool>-<stamp>-<uuid>` keeps REQ-1020's per-call uniqueness (two exports of
 * the same project in one session must not collide), and the payload's own
 * `filename` contributes:
 *
 *   - `ext`  — the payload filename's own extension when it is a sane token
 *              (`x.fp` → `fp`), else `MIME_TO_EXT[mime]`, else `bin`.
 *   - `stem` — its basename without that extension, so the written file is
 *              recognisable (`My Design.fp` → `…-My_Design.fp`).
 *
 * **The stem is also the path-traversal guard.** `filename` is tab-supplied and
 * reaches this module untrusted. It is taken through `path.basename` and then
 * reduced to `[A-Za-z0-9._-]`, so it can never contain a separator and can
 * never be `..`; a stem left with no alphanumeric character is dropped
 * entirely. The result is always one path segment inside `sessionDir`.
 *
 * A payload with no usable name gets no stem segment at all — which is what
 * keeps `canvas.screenshot` (the one binary result with no `filename`)
 * byte-identical on disk to what REQ-1020 wrote.
 */
function resolveName(tool: string, mime: string, filename: string | undefined): string {
  const safeTool = tool.replace(/[^A-Za-z0-9_-]/g, '_') || 'image';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `${safeTool}-${stamp}-${crypto.randomUUID()}`;

  let stem = '';
  let ext = MIME_TO_EXT[mime] ?? 'bin';
  if (typeof filename === 'string' && filename.length > 0) {
    const base = path.basename(filename);
    const rawExt = path.extname(base);
    if (/^[A-Za-z0-9]{1,8}$/.test(rawExt.replace(/^\./, ''))) ext = rawExt.replace(/^\./, '');
    const sanitized = base
      .slice(0, base.length - rawExt.length)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, MAX_STEM);
    if (/[A-Za-z0-9]/.test(sanitized)) stem = sanitized;
  }

  return `${prefix}${stem ? `-${stem}` : ''}.${ext}`;
}

/**
 * Persists one binary result and returns its path + raw size (plan D3).
 *
 * Filename `<tool>-<isoTimestamp>-<uuid>[-<stem>].<ext>` (per-call UUID:
 * concurrent calls in one session never collide). Exclusive create (`'wx'`)
 * into a temp name + rename, so a failed write can never leave partial bytes
 * behind (temp is unlinked on error). Every failure path throws an Error
 * carrying `code: 'return_path_write_failed'` (AC-4).
 */
export function writeImageReturn(args: WriteImageReturnArgs): WrittenImageReturn {
  const { bytesB64, mime, width, height, tool, sessionDir } = args;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(bytesB64, 'base64');
  } catch (e) {
    throw codedError(`cannot decode result bytes: ${e instanceof Error ? e.message : String(e)}`);
  }

  const name = resolveName(tool, mime, args.filename);

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
