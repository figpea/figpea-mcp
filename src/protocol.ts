/**
 * REQ-074 T3 — dependency-free wire-protocol types (plan §3) shared, by
 * *shape* only, between this package's bridge server and the in-editor
 * bridge client (`src/agent/bridge/`, T4). Zero imports — not even `ws`, the
 * MCP SDK, or `zod` — so this module is importable from both a Node CJS
 * package and a browser bundle without pulling in either side's runtime.
 *
 * The client (T4) cannot import this file directly (webpack never bundles
 * `packages/**`, and the client uses the browser-native `WebSocket` while
 * this package uses Node's `ws` — plan §7 "Layer placement"), so it declares
 * its own independent copy of the frame shapes. `BRIDGE_FRAME_TYPES` is the
 * runtime-observable list of frame `type` discriminants (a plain TS union is
 * erased at compile time and can't be diffed at runtime) that
 * `src/tests/unit/agent/bridgeProtocol.test.ts` diffs against the client's
 * own copy to guard the two declarations from silently drifting apart.
 */

/** Every wire frame's `type` discriminant, exhaustively. */
export const BRIDGE_FRAME_TYPES = ['hello', 'describe', 'describe_result', 'call', 'result'] as const;

export type BridgeFrameType = (typeof BRIDGE_FRAME_TYPES)[number];

/** Tab -> server. Must be the very first frame on a new connection, carrying
 * the per-run pairing token embedded in the `open_editor` URL. A missing or
 * mismatched token closes the socket without ever relaying (AC-3). */
export interface HelloFrame {
  type: 'hello';
  token: string;
}

/** Server -> tab. Asks the now-paired tab for its `figpea.describe(selector)`
 * result (+ `figpea.version`).
 *
 * REQ-188 — mirrors the optional `selector` field REQ-181 added to v3's
 * `src/agent/bridge/protocolTypes.ts`. Since contract 0.16.0 a **bare** call
 * (no `selector`) returns only a compact index — `group -> {method: <doc
 * string>}` plus reserved `version`/`errorCodes` keys — while
 * `selector: "<group>"` returns that group's full typed descriptors. The
 * server therefore sends one bare frame to enumerate, then one per group;
 * see `describeDrill.ts`. Omitting `selector` keeps the pre-REQ-181
 * behavior on both sides. */
export interface DescribeFrame {
  type: 'describe';
  selector?: string;
}

/** Tab -> server, in response to a `DescribeFrame`.
 *
 * ⚠️ `manifest` is **optional on the wire**. An unresolved selector makes
 * v3's `describe()` return `undefined`, and `JSON.stringify` drops an
 * undefined value's key entirely rather than emitting `null` — so a miss
 * arrives as `{type:'describe_result', version:'…'}` with no `manifest` key
 * at all. Consumers must test for the key's presence, not for a null value.
 *
 * There is deliberately **no id and no selector echo** here: the frame is
 * matched to its request purely by ordering over the single socket, so
 * describe requests must never be issued concurrently. */
export interface DescribeResultFrame {
  type: 'describe_result';
  manifest?: unknown;
  version: string;
}

/** Server -> tab. Relays a `window.figpea[group][method](...args)` call,
 * `args` reconstructed positionally from the manifest's `params` key order
 * (plan §0/§1) — never interpreted as a schema. */
export interface CallFrame {
  type: 'call';
  id: string;
  group: string;
  method: string;
  args: unknown[];
}

/** Tab -> server. The structured `{ok,...}` result of a relayed call,
 * correlated back to the `CallFrame` by `id`. Passed through verbatim, never
 * re-wrapped (plan §3). */
export type ResultFrame =
  | { type: 'result'; id: string; ok: true; value: unknown }
  | { type: 'result'; id: string; ok: false; code: string; message?: string };

export type BridgeFrame = HelloFrame | DescribeFrame | DescribeResultFrame | CallFrame | ResultFrame;
