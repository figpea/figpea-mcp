/**
 * REQ-188 — progressive `describe()` drilling.
 *
 * Contract 0.16.0 (REQ-181) made bare `figpea.describe()` return a *compact
 * index* — `group -> {method: <one-line doc string>}` plus the reserved
 * `version` and `errorCodes` keys — instead of the full typed manifest.
 * `buildToolsFromManifest` needs the full `params`/`byKind`/`result` trees,
 * which now only come back from `describe("<group>")`. So the server drills:
 * one bare call to enumerate the groups, then one call per group to
 * reassemble the manifest. Full cost paid once per connect.
 *
 * v3 deliberately exposes no privileged full-manifest accessor (REQ-181 Q2),
 * so drilling is the only path.
 *
 * This module is pure sequencing over an injected `DescribeFn` — no `ws`, no
 * frames, no timers — so it is testable without sockets and the transport
 * details stay in `bridgeServer.ts`.
 */

/** One `describe_result`, normalized for the drill.
 *
 * `hasManifest` is deliberately separate from `manifest`. When a selector
 * misses, v3's `describe()` returns `undefined` and `JSON.stringify` **drops
 * the key entirely** rather than emitting `null` — the frame arrives as
 * `{type:'describe_result', version:'…'}` with no `manifest` at all. Carrying
 * the distinction lets the drill tell "the tab said nothing" apart from "the
 * tab said `null`", instead of inferring it from a value that cannot
 * represent it. */
export interface DescribeResultPayload {
  hasManifest: boolean;
  manifest: unknown;
  version: string | null;
}

/** Issues one `describe` frame and resolves with its reply.
 *
 * Strictly one request/response pair at a time. `describe_result` frames
 * carry **no correlation id** and no echo of the selector that produced them
 * (v3's `src/agent/bridge/client.ts:80` sends `{type, manifest, version}` and
 * nothing more), so replies can only be matched to requests by ordering over
 * the single WebSocket. Never issue these concurrently — there would be no
 * way to tell the answers apart. */
export type DescribeFn = (selector?: string) => Promise<DescribeResultPayload>;

/** Keys the compact index carries alongside its group entries, neither of
 * which is a group.
 *
 * `errorCodes` is a flat code catalog (an array of keys in the compact index,
 * the full catalog when drilled). Treating it as a group would synthesize
 * bogus `errorCodes_<code>` tools — the exact failure `buildToolsFromManifest`
 * and `registerContractTools` already guard against downstream. `version` is
 * a plain string, whose own keys are character indices. */
const RESERVED_INDEX_KEYS: ReadonlySet<string> = new Set(['version', 'errorCodes']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The real group names in a compact index — reserved keys removed. Total:
 * a non-object index yields `[]` rather than throwing, since it arrives from
 * across the wire and is never trusted. */
export function groupNamesFromCompactIndex(index: unknown): string[] {
  if (!isPlainRecord(index)) return [];
  return Object.keys(index).filter((key) => !RESERVED_INDEX_KEYS.has(key));
}

/** Whether a bare `describe()` payload is already a FULL manifest — i.e. the
 * connected editor predates contract 0.16.0.
 *
 * Discriminator: in a compact index a method maps to its one-line doc
 * **string**; in a full manifest it maps to a descriptor **object**. Reserved
 * keys are skipped first — `version` is a string in both shapes, so checking
 * it would misclassify everything.
 *
 * This matters because such an editor's `describe()` takes no argument and
 * ignores the one we would send, returning the whole manifest for every
 * selector. Drilling it would overwrite each group with a copy of everything
 * — silent corruption rather than a visible failure. */
export function looksLikeFullManifest(payload: unknown): boolean {
  if (!isPlainRecord(payload)) return false;
  for (const groupName of groupNamesFromCompactIndex(payload)) {
    const group = payload[groupName];
    if (!isPlainRecord(group)) continue;
    for (const methodValue of Object.values(group)) {
      // First real method entry decides: object => full, string => compact.
      return isPlainRecord(methodValue);
    }
  }
  return false;
}

/** Reassembles the full manifest by drilling per group.
 *
 * Returns `undefined` when the bare index itself can't be obtained — an empty
 * `{}` would be strictly worse, since `registerContractTools` disables every
 * tool absent from the manifest it is handed, so an empty one silently
 * disables the entire tool set on a reconnect.
 *
 * A group that misses is **skipped and logged**, never included as an empty
 * object: an empty group registers zero tools while still looking like a
 * successful drill (AC-3).
 */
export async function drillManifest(
  describe: DescribeFn,
  log: (message: string) => void = () => {},
): Promise<Record<string, unknown> | undefined> {
  let index: DescribeResultPayload;
  try {
    index = await describe();
  } catch (err) {
    log(`[figpea-mcp] describe() failed; no contract tools registered: ${String(err)}`);
    return undefined;
  }

  if (!index.hasManifest || !isPlainRecord(index.manifest)) {
    log('[figpea-mcp] describe() returned no usable manifest; no contract tools registered');
    return undefined;
  }

  // Pre-0.16.0 editor: the bare call already carries the full schemas, and
  // drilling it would corrupt the result. Use it as-is.
  if (looksLikeFullManifest(index.manifest)) {
    return index.manifest;
  }

  const groupNames = groupNamesFromCompactIndex(index.manifest);
  const manifest: Record<string, unknown> = {};

  for (const groupName of groupNames) {
    let result: DescribeResultPayload;
    try {
      result = await describe(groupName);
    } catch (err) {
      log(`[figpea-mcp] describe("${groupName}") failed; that group's tools are unavailable: ${String(err)}`);
      continue;
    }

    // An unresolved selector arrives as an ABSENT `manifest` key, not null
    // (see DescribeResultPayload). Both are refused, plus any non-object, so
    // nothing downstream has to re-validate what a group is.
    if (!result.hasManifest || !isPlainRecord(result.manifest)) {
      log(`[figpea-mcp] describe("${groupName}") returned no descriptor; that group's tools are unavailable`);
      continue;
    }

    manifest[groupName] = result.manifest;
  }

  return manifest;
}
