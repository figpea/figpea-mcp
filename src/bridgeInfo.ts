/**
 * REQ-1503 — the bridge-info file: how an agent that has LOST its MCP channel
 * finds the bridge that is still serving.
 *
 * The defect this closes is discoverability, not capability. The bridge is on
 * loopback with a token-gated relay to the tab, and it is running — but its port
 * and token exist in exactly one place a reader can reach: the MCP tools, which
 * are what went missing. An agent holding nothing but a shell has no way to learn
 * that a recovery route exists, let alone which port to call, so the whole
 * recovery is theory.
 *
 * So each run publishes `{port, token, pid, startedAt}` to a predictable path,
 * owner-only, and removes it on the way out. The filename is per-PORT rather than
 * per-token for one reason: `port` is what a caller needs first, and it is the
 * only field that can be found without already holding the token.
 *
 * ⛔ THE FILE IS DELIBERATELY OUTSIDE THE PER-TOKEN SESSION DIR.
 * `<os.tmpdir()>/figpea-mcp/<token>/` exists so off-band binary returns have
 * somewhere to land, and `returnPath.sessionBytes()` charges **every** entry in
 * it against `MAX_SESSION_BYTES`. A few hundred bytes of JSON written inside one
 * would silently eat a user's export budget, and a later "tidy that up" that
 * moved it in would look like a perfectly reasonable cleanup. It therefore sits
 * beside the token dirs, in the shared `figpea-mcp/` root, and is discovered with
 * `ls "$TMPDIR"/figpea-mcp/bridge-*.json`.
 *
 * Node builtins only (`fs`/`os`/`path`), never anything from the package — the
 * standalone-clone degrade invariant (`figpea-mcp` is published MIT) plus the
 * rule that this and `tabLiveness.ts` stay importable from either side without
 * either module importing the other.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The shared root every per-run artefact lives under. */
export const BRIDGE_INFO_ROOT = path.join(os.tmpdir(), 'figpea-mcp');

/**
 * Owner-only (`0600`). A per-run pairing token is a real credential for as long
 * as the process lives — it grants the ability to DRIVE the user's open document
 * — so the file that names it is not world-readable even on a single-user
 * machine, and the documentation may claim the mode because this is the code that
 * enforces it.
 */
export const BRIDGE_INFO_MODE = 0o600;

/** `<os.tmpdir()>/figpea-mcp/bridge-<port>.json`. */
export function bridgeInfoPath(port: number): string {
  return path.join(BRIDGE_INFO_ROOT, `bridge-${port}.json`);
}

/** What a recovery caller reads out of the file. */
export interface BridgeInfo {
  /** The bound port, on IPv4 loopback. */
  port: number;
  /** The per-run pairing token the two new routes require. */
  token: string;
  /** This process, so a leftover file from a dead run is recognisable. */
  pid: number;
  /** ISO-8601 instant this bridge run started. */
  startedAt: string;
}

/**
 * Writes the file, creating the shared root if it is not there yet.
 *
 * **Best effort, and deliberately silent about failure.** A bridge whose
 * filesystem cannot take the file must still serve: every route it gates is
 * reachable by an agent that still has its tools, so failing to start over an
 * optional convenience would trade a real capability for a documented one. The
 * cost of a failure is that the recovery procedure's first step finds nothing —
 * which the caller sees as "no bridge running", the honest reading of a file
 * that is not there.
 *
 * The mode is set explicitly rather than left to `writeFileSync`'s `mode`, which
 * only applies when the file is CREATED — so a port whose file survived from a
 * dead run would otherwise keep whatever mode that run left.
 */
export function writeBridgeInfo(info: BridgeInfo): string | null {
  const file = bridgeInfoPath(info.port);
  try {
    fs.mkdirSync(BRIDGE_INFO_ROOT, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8' });
    fs.chmodSync(file, BRIDGE_INFO_MODE);
    return file;
  } catch (err) {
    console.error('[figpea-mcp] could not write the bridge-info file:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Best-effort removal for `bridgeServer.close()`, beside `removeSessionDir` and
 * for the same reason: never throw, because a cleanup failure must not fail
 * server shutdown — and a file left behind is inert by construction, since the
 * token it names matches no bridge that is still listening.
 */
export function removeBridgeInfo(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort only (see above).
  }
}
