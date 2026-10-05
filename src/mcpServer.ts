/**
 * REQ-074 T3 — MCP server: static tools & dynamic contract tools (plan §2,
 * OQ-4). Builds an `McpServer` wired to an already-started bridge (the
 * bridge is a dependency, not started here — `cli.ts` owns the one real
 * `startBridgeServer()` call, plan §2), so this module stays unit-testable
 * with a plain stub bridge and no real WebSocket listener.
 */

import * as fs from 'node:fs';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  buildToolsFromManifest,
  resultToContent,
  ERROR_CODES_MANIFEST_KEY,
  type FigpeaCallResultLike,
  type GeneratedTool,
  type ManifestLike,
  type McpContentBlockLike,
  type ParamSchemaLike,
} from './tools';
import { writeImageReturn, sessionDirFor } from './returnPath';
// REQ-1498's payload-from-file READER, in its own module so this file owns no
// `JSON.parse` at all — REQ-1280 AC-7's structural guarantee, which pins that
// the `_rawJson` flag's parse has exactly one home and cannot be forked. The
// parse that moved is a file's contents, not a call's argument; what stays here
// is every decision about WHERE a payload lands.
import { readArrayPayloadFromFile } from './opsFile';
// REQ-1301 — the one place the loopback host is decided. Imported from a
// neutral module (not from ./bridgeServer) so this file's structural stub seam
// stays a stub seam: `cli.ts` always passes the real handle, which defines
// `getFileUrl`, so the two fallbacks below are a *consistency* backstop for a
// handle that omits it — not a path production traffic takes. They use the
// constant so a fallback can never disagree with the canonical host again.
import { BRIDGE_URL_HOST } from './bridgeHost';
import { groupNamesFromCompactIndex } from './describeDrill';
import { findArgShapeMismatch, findKindPropMismatch, findDeclaredWrapperMismatch, renderSchemaExample, findFilePathEnvelopeMismatch, findSingularFilePathMismatch, findNestedStructuredStringMismatch, createPropStyleHint, nestedStringHint, type ArgShapeMismatch } from './argShape';
import { wireEncoding, groupEncodingNote } from './wireShape';
// REQ-1280 — the single `_rawJson` implementation, called by BOTH relay paths
// (full mode's contract handler and compact mode's `figpea_call`) so they
// cannot drift (AC-7).
import {
  isRawJsonFlag,
  applyRawJson,
  applyStructuredStringJson,
  rawJsonFailureMessage,
  expectsStructuredValue,
  type RawJsonSchemaLike,
} from './rawJson';
import { resolveTimeoutMs } from './callTimeout';
// REQ-1394 — the one connection-diagnosis vocabulary and its actionable
// sentences, imported from the same zero-import leaf the bridge records into.
// `getConnectionDiagnosis` is OPTIONAL below, so the ~45 test files that build a
// stub bridge keep compiling untouched; when it is absent, `legacyDiagnosis`
// derives an honest fallback from the legacy boolean rather than omitting the
// field.
import { legacyConnections, legacyDiagnosis, type ConnectionDiagnosis } from './connectionDiagnosis';
// REQ-1503 — the one tab-liveness vocabulary, imported from the same zero-import
// leaf the bridge records into. `getLiveness` is OPTIONAL below for exactly the
// reason `getConnectionDiagnosis` is: this interface is a structural stand-in
// ~45 test files satisfy with their own stub, and a required member would edit
// all of them for no behavioural gain. Absent ⇒ `legacyLiveness`, which reports
// the honest reading of the one bit such a bridge has rather than omitting the
// key.
import { legacyLiveness, type TabLiveness } from './tabLiveness';
// REQ-1283 — the single extension-preserving name resolver, called by BOTH
// relay paths (compact `figpea_call` and full mode's `session_openFile`) for
// the same reason as `_rawJson` above: one rule, two call sites, no drift.
import { resolveOpenFileName } from './openFileName';
// REQ-1296 — the pure "did I understand every key I was given?" predicate and
// the two reserved-key sets. Ordered below REQ-1280's import because this
// branch is rebased on top of it; the two are independent helpers and neither
// shadows the other. The one region both REQs touched is `figpea_call`'s
// schema literal, where REQ-1280 rewrote the `_rawJson` description and
// REQ-1296 wraps the whole literal in `z.looseObject` — REQ-1280's text is
// preserved verbatim inside REQ-1296's wrapper, which is the correct merge.
import { findUnknownTopLevelKeys, FULL_MODE_RESERVED, COMPACT_RESERVED } from './unknownParams';
// REQ-1457 — the one build-identity ledger: the version this process runs, the
// artifact it loaded, and whether that artifact is still the artifact on disk.
// It is a leaf precisely so BOTH sides can read it — `bridgeServer.ts` stamps
// the AC-4 timeout envelope from the same source, which is the only way the two
// surfaces can be guaranteed to name the same build. `SERVER_VERSION` lives
// there too, and is re-exported below so any existing importer keeps working.
import { servingBuild, SERVER_VERSION, type BuildStatus } from './buildIdentity';
export { SERVER_VERSION } from './buildIdentity';

/** What this module needs from a started bridge (bridgeServer.ts's real
 * `BridgeServerHandle` is a superset — `getContractVersion` is optional here
 * so a minimal test stub lacking it still satisfies this type). */
export interface BridgeServerHandleLike {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
  getContractVersion?(): string | null;
  getFileUrl?(filePath: string): string;
  registerBlob?(filePath: string): string;
  /** REQ-1394: what the bridge observed about the pairing attempt. Optional
   *  DELIBERATELY — this interface is a structural stand-in that ~45 test
   *  files satisfy with their own stub, and making it required would edit all
   *  of them for no behavioural gain. Absent ⇒ the legacy fallback. */
  getConnectionDiagnosis?(): ConnectionDiagnosis;
  /** REQ-1503: what this bridge observed about whether the tab calls are
   *  addressed to is ANSWERING. Optional for the same reason
   *  `getConnectionDiagnosis` is — a structural stand-in ~45 test files satisfy
   *  with their own stub. Absent ⇒ `legacyLiveness`, which reads `tabConnected`
   *  and reports `unknown` rather than the `responsive` that bit cannot support. */
  getLiveness?(): TabLiveness;
  /** REQ-1492: `single` (the default) or `multi`. Optional for the same reason
   *  `getConnectionDiagnosis` is — this interface is a structural stand-in that
   *  ~45 test files satisfy with their own stub, and a required member would edit
   *  all of them. Absent ⇒ treated as `single`, and `select_tab` is not
   *  registered (there is nothing to select on a one-slot bridge). */
  getSlotMode?(): 'single' | 'multi';
  /** REQ-1492: every paired tab, in pair order. Absent ⇒ the legacy
   *  single-connection shape from `legacyConnections`. */
  getConnections?(): BridgeConnectionLike[];
  /** REQ-1492: moves the active pointer and re-publishes that tab's cached
   *  manifest. Absent on a stub ⇒ `select_tab` is simply not registered. */
  selectConnection?(connectionId: string): Promise<void>;
}

/** REQ-1492 — the published shape of one paired tab (AC-6). Mirrors
 *  `bridgeServer.ts`'s `BridgeConnection` structurally, the way
 *  `BridgeServerHandleLike` mirrors its handle: the two modules must not import
 *  each other, so the seam is the shape, not the type. */
export interface BridgeConnectionLike {
  connectionId: string;
  origin: string | null;
  originSource: 'handshake' | 'absent';
  contractVersion: string | null;
  /** `null` only on a bridge that cannot report its slots at all — see
   *  `legacyConnections`, where "when did this tab pair" is not a fact it has. */
  pairedAt: string | null;
  active: boolean;
}

export interface CreateMcpServerOptions {
  /** Overrides both the env var and the built-in default for every
   * `open_editor` call on this server, unless a call supplies its own. */
  editorBaseUrl?: string;
  /** Prefetched contract manifest to register tools immediately on startup. */
  prefetchedManifest?: ManifestLike;
  /** REQ-705: prefetched `/agent/skill.md` body (fetched once in `cli.ts`'s
   * `main()`, alongside `prefetchedManifest`). Absent when the fetch failed
   * or was disabled -- the `figpea_skill` tool degrades gracefully rather
   * than being omitted from `tools/list`. */
  prefetchedSkillBody?: string;
  /** The exact URL `fetchSkill` read `prefetchedSkillBody` from (cli.ts
   * forwards `FetchSkillResult.url`). Carried so the `figpea_skill` answer can
   * name its own provenance: the tab a run pairs is frequently a DIFFERENT
   * origin/build than the one fetched here, and an unattributed body reads as
   * authoritative for whatever tab happens to be connected. */
  prefetchedSkillUrl?: string;
  /** REQ-1018: tool surface mode — compact (default) exposes only 5 tools:
   * `open_editor`, `status`, `figpea_skill`, the `figpea_call` dispatcher, and
   * (REQ-1268) `figpea_describe`; full restores all contract tools instead of
   * the two compact-only ones. */
  toolMode?: 'compact' | 'full';
  /** REQ-1457: the build facts `status` publishes. Read ONCE PER `status`
   *  CALL, never cached at construction — staleness is a live fact, and a
   *  provider frozen at startup would answer `false` forever.
   *
   *  Optional DELIBERATELY, for exactly the reason `getConnectionDiagnosis` is:
   *  `CreateMcpServerOptions` is a structural stand-in that ~45 test files
   *  satisfy with their own stub, so a required member would edit all of them
   *  for zero behavioural gain. Absent ⇒ the real module. It is also the only
   *  honest way to pin AC-7 deterministically: a unit test must not have to
   *  `touch` the repo to observe a stale build. */
  buildStatus?: () => BuildStatus;
}

const DEFAULT_EDITOR_BASE_URL = 'https://editor.figpea.com';
const SERVER_NAME = 'figpea-mcp';
// REQ-1457 moved `SERVER_VERSION` to `./buildIdentity` (see that module's
// docblock): the bridge needs it for the timeout stamp, and this leaf must not
// import the heavier module. Re-exported above, and the literal form kept
// byte-identical because `metadata.test.ts` regexes it out of its source file.

/** REQ-772 AC-1 — the documented maximum a per-call `_timeoutMs` override may
 * raise a single bridge call's timeout to. Values above it are clamped (not
 * rejected), per the README's stated semantics.
 *
 * REQ-1282 D1 — the cap, the known-slow table and the resolver now live in
 * `callTimeout.ts`, a zero-import leaf that also owns the flat floor
 * `bridgeServer.ts` uses as its own default, so the relay's deadline and this
 * layer's resolved deadline are the same number by construction. Re-exported
 * here so anything that imported them from this module keeps working. */
export { MAX_CALL_TIMEOUT_MS, DEFAULT_TIMEOUT_TABLE_MS } from './callTimeout';

/** REQ-1282 AC-5 — the one sentence that makes the timeout knob discoverable,
 * carried at EVERY site that advertises `_timeoutMs` (this dispatcher, and
 * `buildInputShape`'s shared key for every generated contract tool) so the
 * three can never disagree.
 *
 * The knob has worked since REQ-772; what was missing is that nobody could
 * learn it existed, let alone that the default is *sometimes* too low. An
 * agent that cannot see the problem cannot pass the fix for it, so the wall
 * gets rediscovered by timing out — which is what the card's incident was.
 * Stated as a fact about a situation the agent can recognise (a burst of
 * mutations on a large project), not as a warning to be careful.
 *
 * `120000` is spelled with digits on purpose: the README, `readme.test.ts` and
 * the other `_timeoutMs` descriptions all use the digits, and a copyable
 * number beats a formatted one for an agent computing a legal value. It names
 * the key by name, which reads slightly self-referentially inside the key's own
 * property description — the price of ONE string at all three sites, which is
 * the whole point of extracting it.
 */
const TIMEOUT_KNOB_ADVICE =
  'The default can be too low during a burst of mutations, where the editor is still settling after the relay has already given up — pass _timeoutMs deliberately (90000 is a legal value) rather than discovering the limit by timing out. Clamped to 120000, not rejected.';

/**
 * REQ-1432 T6 — the per-call args budget, on `figpea_call`'s own description
 * AND its `args` meta description.
 *
 * The card's evidence is a run authoring a page through this tool: a ~28 KB
 * `layer.batch` payload was refused outright and the page had to be rebuilt in
 * ~6 smaller calls, and the refusal named image staging for a payload with no
 * bytes on it. So the limit was real, common, and advertised nowhere on the tool
 * an agent is actually calling — the only way to learn it was to be refused.
 *
 * Stated as a GENERAL limit on the total serialized `args` of every call, not as
 * an image footnote: this server relays the editor's refusal verbatim and the
 * editor now branches its message on whether the payload carries image bytes, so
 * the caller-facing statement has to match that shape.
 *
 * Today's number is quoted so an agent reading only the description can size a
 * call without a round trip, but it is stated ALONGSIDE the authoritative
 * pointer `describe().limits.argsChars` — the editor owns the value, and this is
 * prose. No live value is interpolated into the description: registration order
 * vs. the contract fetch makes that fragile, and the pointer is the honest
 * construction. A future threshold move is therefore a one-line edit here.
 *
 * Guidance only — parse behaviour is unchanged and no call is newly rejected
 * (the `TIMEOUT_KNOB_ADVICE` precedent).
 */
const ARGS_BUDGET_ADVICE =
  'Every call carries one budget: the TOTAL serialized size of args is capped (currently ~22000 characters — ' +
  'read the live value at describe().limits.argsChars, or figpea_describe({selector:"limits"}), and do not ' +
  'hardcode it). This applies to EVERY call, whatever the payload — not only image data URIs. A dense ' +
  'layer.batch of shape and text ops reaches the cap at well under 90 ops, and image bytes reach it far ' +
  'sooner. Over the cap the call is refused with arg_size_exceeded and NOTHING is applied, so there is no ' +
  'partial result to recover from. Chunk instead: aim for roughly two-thirds of the limit per call and split ' +
  'the op list across calls of that size, passing ids from earlier results literally. Each chunk is its own ' +
  'undo step. The limit is measured in characters (UTF-16 code units of JSON.stringify(args)), not bytes, ' +
  'so a payload carrying emoji or other multi-unit characters reaches the transport cap earlier than the ' +
  'number suggests — budget lower for those.';

/** REQ-1020 — the three tools whose off-band return is *documented* as an image
 * return, and the worked example set the README uses. This used to gate the
 * `returnAs` declaration in `buildInputShape`; REQ-1279 removed that gate,
 * because a gate over three image names made `returnAs:"path"` unreachable in
 * full mode for every other binary export — the key was stripped by
 * `safeParseAsync` before the handler ran, one layer *above* the payload
 * predicate. Kept as a named set because the docs, and anyone reading them,
 * still need to know which tools the image framing describes. */
export const IMAGE_PATH_TOOLS: ReadonlySet<string> = new Set([
  'canvas_screenshot',
  'export_layer',
  'export_artboard',
]);

/** REQ-1020 — validates one `returnAs` value, failing loud (plan D1): a typo
 * must error, never silently inline megabytes. Returns the normalized mode or
 * an error payload. */
function resolveReturnAs(raw: unknown): { mode: 'inline' | 'path' } | { error: { ok: false; code: string; message: string } } {
  if (raw === undefined) return { mode: 'inline' };
  if (raw === 'inline' || raw === 'path') return { mode: raw };
  return { error: { ok: false, code: 'invalid_params', message: `returnAs must be "inline" or "path", got ${JSON.stringify(raw)}` } };
}

/** REQ-1296 D3 — the fail-loud message for a key this server does not
 *  understand.
 *
 *  Deliberately the same `{ok:false, code, message}` envelope (and NOT an MCP
 *  protocol-level throw) that `resolveReturnAs` above, the REQ-1268 shape
 *  pre-flight below and every other figpea-mcp validation failure already use:
 *  an agent has to be able to READ the body and learn from it. A raw SDK
 *  `-32602` would be the opposite — an opaque path array naming a position in
 *  a payload the agent never wrote.
 *
 *  Wording mirrors v3's own `openFile()` (`session.impl.ts:141-147`:
 *  `openFile() received unknown parameter "${key}"` + `ERR_CODES.INVALID_PARAMS`)
 *  so one failure class reads the same on both sides of the wire, then adds
 *  the two things a caller can act on without spending a second round trip:
 *  what IS accepted, and the lane that actually persists a file. The second
 *  half is the point — an agent that guessed `filePath` because it wanted the
 *  bytes on disk has to be told the real way in the same breath, or it invents
 *  a third key. */
function renderUnknownParameterMessage(toolName: string, unknownKeys: string[], accepted: string[]): string {
  const one = unknownKeys.length === 1;
  const named = unknownKeys.map((k) => `"${k}"`).join(', ');
  return (
    `${toolName}: unknown parameter${one ? '' : 's'} ${named}. Accepted parameters: ${accepted.join(', ')}. ` +
    `To get a result onto disk, pass returnAs:"path" — the bytes are written to a per-session file and its path is returned. ` +
    `Never pass a file path as a parameter.`
  );
}

/** REQ-1020 — builds the `resultToContent` off-band options for one image
 * tool call: real writer + session dir + token-gated fetch URL (plan D4:
 * the bridge's existing `registerBlob()`, falling back to `getFileUrl()`). */
function returnAsOpts(bridge: BridgeServerHandleLike, toolName: string, mode: 'inline' | 'path'): Parameters<typeof resultToContent>[1] {
  return {
    returnAs: mode,
    tool: toolName,
    sessionDir: sessionDirFor(bridge.token),
    writeImage: writeImageReturn,
    fileUrlFor: bridge.registerBlob
      ? (p: string) => bridge.registerBlob!(p)
      : bridge.getFileUrl
        ? (p: string) => bridge.getFileUrl!(p)
        : undefined,
  };
}

function toCallToolResult(mapped: { content: McpContentBlockLike[]; isError: boolean }): CallToolResult {
  // `McpContentBlockLike` mirrors the SDK's own TextContent/ImageContent
  // shapes exactly (plan §1) but is declared independently in the
  // dependency-free tools.ts -- structurally compatible, not literally the
  // same declared type, hence the bridging cast.
  return { content: mapped.content, isError: mapped.isError } as unknown as CallToolResult;
}

function jsonTextResult(payload: unknown): CallToolResult {
  return toCallToolResult({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false });
}

/** REQ-705: unlike jsonTextResult, returns `text` verbatim rather than
 * JSON.stringify-ing it -- figpea_skill's successful result is the raw
 * markdown reference body, not a JSON-wrapped string. */
function textResult(text: string): CallToolResult {
  return toCallToolResult({ content: [{ type: 'text', text }], isError: false });
}

/** Prepended to `figpea_skill`'s answer so the body is never returned
 * unattributed.
 *
 * The body is fetched ONCE at startup from the process's startup origin
 * (`FIGPEA_EDITOR_URL`, else `https://editor.figpea.com`) and is never
 * re-derived from the tab a run later pairs. Those are routinely two different
 * editors -- a local `v3/static` build paired against a process started on the
 * production origin, as in the 2026-10-01 design run. There the answer was
 * production guidance (a `setPosition` call after every `layer.create`, and no
 * `icon`/`arc` in the kind list) presented as if it described the local tab the
 * agent was actually driving, which doubled the round trips on a ~200-element
 * build. The bodies even carry the same `figpea-skill-identity
 * contract=2.54.0` stamp, so that stamp does not tell a reader which editor it
 * is holding -- which is why the URL, not the contract, is what gets named.
 *
 * This server cannot detect or fix the mismatch (the bridge does not learn the
 * tab's origin, and `SKILL()` is not one of the eight contract groups), so the
 * honest move is to say where the body came from and point at the two
 * authoritative per-tab routes. `tabConnected` is read at call time, not
 * construction time: a tab pairs long after startup, so the warning has to
 * reflect the moment the answer is produced.
 *
 * A blockquote, because the body is markdown and an agent reads the top of it
 * first -- the one sentence that could change how it builds has to be above the
 * 500 lines it might otherwise follow.
 */
export function skillWithProvenance(body: string, sourceUrl: string | undefined, tabConnected: boolean): string {
  const provenance =
    sourceUrl
      ? `**Provenance.** The body below was fetched once at server startup from \`${sourceUrl}\`. It is that editor build's own skill — not a query of any paired tab, and two builds can carry the same \`contract=\` stamp, so that stamp does not tell them apart.`
      : `**Provenance.** The body below was fetched once at server startup, and this server did not record which origin it came from, so treat it as unattributed: it is some editor build's own skill, not a query of any paired tab, and two builds can carry the same \`contract=\` stamp, so that stamp does not tell them apart.`;

  const tabWarning = tabConnected
    ? `\n>\n> **A tab is connected, and it may be a different origin or a different build than the one above** — this server cannot see the tab's origin, so it cannot tell you which. For the connected tab's own skill — the one that matches the contract its methods actually accept — either evaluate \`figpea.SKILL()\` in that tab, or \`GET\` \`<the tab's origin>/agent/skill.md\`. Prefer those over the body below whenever they disagree.`
    : '';

  return `> ${provenance}${tabWarning}\n\n${body}`;
}

/** REQ-1296 D1 — the argument shape every contract tool registers.
 *
 * The return value is a **loose** zod object, and the looseness is the whole
 * point. `registerTool` wraps a raw shape with `objectFromShape` →
 * `z4mini.object(shape)`, and zod v4's `object()` STRIPS every undeclared key
 * before `validateToolInput` hands `parseResult.data` to the handler. So with
 * a bare shape this server was structurally unable to know that a caller sent
 * a key it did not understand: the evidence was destroyed one layer above the
 * handler, which is why an evidence-persistence param like `filePath` on
 * `canvas.screenshot` could never be named, only silently dropped, and the
 * answer was `ok:true` either way (REQ-1296 AC-1/AC-3).
 *
 * Verified against the installed @modelcontextprotocol/sdk 1.29.0 + zod
 * 4.4.3, driving a real `McpServer` and a real SDK `Client` over
 * `InMemoryTransport` (REQ-769 style verify-then-pin):
 *   - raw shape, called `{options, filePath}` → handler saw `["options"]`.
 *   - `z.looseObject(shape)` → the SDK's `normalizeObjectSchema` returns the
 *     schema instance unchanged (it is already a v4 object), and the handler
 *     saw `["options","filePath"]` WITH the value intact.
 *   - a call with no unknown key is byte-for-byte unchanged either way.
 *   - the `tools/list` advertisement gains exactly one thing, a permissive
 *     top-level `additionalProperties: {}`; every `properties` entry is
 *     identical. That addition is load-bearing, not cosmetic: a strict
 *     `false` here would make a schema-respecting client refuse to SEND the
 *     bad key at all, and the agent would get an opaque client-side error
 *     instead of our named one.
 *   - a `z.enum` key inside the loose object still rejects an invalid value,
 *     so REQ-093's enum advertising/validation is not weakened.
 *
 * The looseness alone is a real (brief) widening: an unknown key now reaches
 * the handler instead of dying in the parse, and the handler is the only thing
 * between it and a silently-dropped argument. That is why the rejection in
 * `makeContractHandler` is part of the same change, not a follow-up.
 */
function buildInputShape(tool: GeneratedTool): z.ZodType {
  const shape: Record<string, z.ZodTypeAny> = {};
  // REQ-772 AC-1 — every generated contract tool accepts the reserved
  // `_timeoutMs` key to raise that single call's bridge timeout (capped at
  // MAX_CALL_TIMEOUT_MS, clamped not rejected). Declared in the shape so it
  // survives the SDK's safeParseAsync stripping (see the REQ-769 comment
  // below: undeclared keys never reach the handler); excluded from the
  // manifest-args mapping by construction (`makeContractHandler` maps only
  // `inputKeys`, which never contains `_timeoutMs`), so it is never
  // forwarded to the tab-side method.
  //
  // REQ-1282 AC-5 — it used to carry NO description at all, so in full mode
  // every generated contract tool advertised the knob blind: an agent could
  // not learn from `tools/list` that the key exists, let alone that the
  // default is sometimes too low. Carried in `.describe()` AND `.meta()` for
  // the reason recorded at TIMEOUT_KNOB_ADVICE above: the SDK's zod→JSON Schema conversion takes the meta description in PREFERENCE to
  // `.describe()`, so `.describe()` alone is the half that does not ship.
  shape['_timeoutMs'] = z
    .number()
    .optional()
    .describe(`Optional per-call timeout override in ms. ${TIMEOUT_KNOB_ADVICE}`)
    .meta({ description: `Optional per-call timeout override in ms. ${TIMEOUT_KNOB_ADVICE}` });
  // REQ-1037 — reserved `_rawJson` bypass for harness that stringifies nested numbers.
  // Declared so it survives safeParseAsync, never forwarded (not in inputKeys).
  shape['_rawJson'] = z.any().optional();
  // REQ-1020 / REQ-1279 — reserved `returnAs` on EVERY generated contract
  // tool: declared (permissive `z.any`, like every other hint-mapped key) so
  // it survives safeParseAsync; advertised via meta; validated manually in the
  // handler so a typo fails loud with `invalid_params`. Never in inputKeys, so
  // never forwarded to the tab — it follows the REQ-772 `_timeoutMs`
  // reserved-key pattern exactly.
  //
  // REQ-1020 declared it only for `IMAGE_PATH_TOOLS`. That was correct while
  // the feature was image-only, and it became a second, independent gate the
  // moment any non-image binary needed the key: in full mode `export_project`
  // with `returnAs:"path"` was not merely ignored downstream, the key never
  // reached the server at all. Every tool is a no-op for the key when its
  // result is not a binary payload, so declaring it everywhere costs nothing
  // and removes the class of "works on three tools" surprise.
  shape['returnAs'] = z.any().meta({ type: 'string', enum: ['inline', 'path'] }).optional();
  // REQ-1498 — the payload-from-file option, DECLARED for any tool whose
  // manifest declares a top-level array/matrix param, so `tools/list` advertises
  // it. Derived from `tool.paramSchemas`, so no method name appears here and a
  // method published this way gains it with no edit.
  //
  // Declared (like every reserved key above) rather than merely permitted,
  // because an undeclared key is stripped by the SDK's `safeParseAsync` before
  // the handler runs — which is REQ-1282 AC-5's exact lesson in the other
  // direction: a knob that exists but is unadvertised is undiscoverable, and a
  // knob advertised blind is a defect.
  //
  // Permissive (`z.any().meta({type:'string'})`), for the REQ-769 reason: this
  // advertises the type while parse stays literal, so a bad VALUE still reaches
  // the handler and is refused there by name rather than by an opaque SDK
  // parse error.
  //
  // `topLevelArrayParamName` returns a name only when exactly one top-level
  // array/matrix param is declared; with zero or several there is no slot to
  // substitute into, so the key is not declared at all.
  if (topLevelArrayParamName(tool.paramSchemas)) {
    shape['opsFile'] = z
      .any()
      .meta({ type: 'string' })
      .optional()
      .describe(OPS_FILE_ADVICE)
      .meta({ description: OPS_FILE_ADVICE });
  }
  if (tool.inputKeys.length === 0) return z.looseObject(shape);
  // REQ-1296 D1 — the early return above carries the same loose wrap, so a
  // zero-param method's unrecognised key is observable too (and not merely
  // reserved-key-visible, which is what REQ-772's removal of the no-schema
  // branch had achieved for `_timeoutMs`).
  // REQ-769 — the type mapping below rests on one mechanic of the MCP SDK,
  // verified empirically against the installed @modelcontextprotocol/sdk +
  // zod v4 (plan REQ-769 §Tech design): every registered zod shape serves
  // TWO roles. On `tools/list` the SDK advertises the shape as JSON Schema
  // (`toJsonSchemaCompat`, server/mcp.js ~L75-90); on every `tools/call` it
  // VALIDATES the arguments with `safeParseAsync` (~L430). The only construct
  // satisfying both AC-1 (real types advertised) and AC-2 (zero new
  // rejections) is `z.any().meta({ type })`: `.meta()` flows a `type` into
  // the JSON-Schema advertisement, while parse remains literally z.any() —
  // mismatched and omitted values still pass exactly as before. Plain typed
  // schemas (z.string(), z.record(), …) would add server-side rejections;
  // `z.record(...).catch(ctx => ctx.input)` parses permissively but
  // `z.toJSONSchema` throws "Dynamic catch values are not supported in JSON
  // Schema", so it cannot serve the advertisement role at all.
  const TYPE_TO_ADVERTISED: Record<string, Record<string, unknown>> = {
    object: { type: 'object', additionalProperties: true },
    string: { type: 'string' },
    number: { type: 'number' },
    boolean: { type: 'boolean' },
    array: { type: 'array' },
    matrix: { type: 'array' }, // affine transform tuple — advertised as an array (AC-1)
  };

  /** Converts a ParamSchemaLike (with nested shape/byKind/of) to its JSON Schema advertisement fragment.
   *  Used to advertise inner number/object/array fields so LLMs generate correct types. */
  function paramSchemaToAdvertised(schema: import('./tools').ParamSchemaLike): Record<string, unknown> {
    // Enum takes precedence (already handled at top level, but handle here for nested)
    if (schema.enum && schema.enum.length > 0) {
      return { type: 'string', enum: [...schema.enum] };
    }
    if (schema.type === 'object') {
      const properties: Record<string, unknown> = {};
      let hasProps = false;
      if (schema.shape) {
        for (const [k, sub] of Object.entries(schema.shape)) {
          properties[k] = paramSchemaToAdvertised(sub);
          hasProps = true;
        }
      }
      if (schema.byKind) {
        const seen = new Set<string>(Object.keys(properties));
        for (const kindFields of Object.values(schema.byKind)) {
          for (const [k, sub] of Object.entries(kindFields)) {
            if (!seen.has(k)) {
              properties[k] = paramSchemaToAdvertised(sub);
              seen.add(k);
              hasProps = true;
            }
          }
        }
      }
      if (hasProps) {
        return { type: 'object', properties, additionalProperties: true };
      }
      // Check for nested shape inside array's of
      return { type: 'object', additionalProperties: true };
    }
    if (schema.type === 'array') {
      if (schema.of) {
        return { type: 'array', items: paramSchemaToAdvertised(schema.of) };
      }
      return { type: 'array' };
    }
    if (schema.type === 'matrix') {
      return { type: 'array' };
    }
    const adv = TYPE_TO_ADVERTISED[schema.type];
    if (adv) return { ...adv };
    return { type: schema.type };
  }

  for (const key of tool.inputKeys) {
    // Permissive by design (plan §1): descriptor params are informal,
    // human-readable hints, not a machine schema -- z.any() is the faithful
    // mapping, with the hint itself surfaced in the tool description instead.
    //
    // REQ-074 T5 found (empirically, via the real dev-lane AC-2 e2e): Zod v4's
    // `z.any()` alone still requires the key to be *present* in the call
    // arguments -- a call omitting it entirely fails with "expected
    // nonoptional, received undefined", even though `z.any()` happily accepts
    // `undefined` as a *value*. Every pre-existing descriptor's sole/only
    // params happened to always be supplied by every real caller, so this
    // never surfaced until `canvas.screenshot(options?)` -- the surface's
    // first genuinely-optional top-level param (a caller may omit `options`
    // entirely). `.optional()` makes a missing key equivalent to an explicit
    // `undefined` value, matching the "permissive hint, not enforcement"
    // intent above and fixing the latent bug for every group, not just
    // `canvas`.
    //
    // REQ-093 T5 (AC-4, Q1): a param whose structured schema (T2) carries an
    // `enum` gets a `z.enum(values)` instead -- advertising the allowed
    // values to MCP clients, a genuine "better-typed tools for free" win.
    // Required-ness is advertised via `paramSchemas`/the tool description,
    // NEVER enforced here as a rejection -- the key stays `.optional()`
    // regardless, preserving the same permissive default above (Q1's
    // decision, and the `canvas.screenshot(options?)` fix's intent).
    //
    // REQ-769 (AC-1): a structured schema carrying a known `type` advertises
    // that type via meta-typed z.any() (see the two-role comment above) so
    // type-respecting MCP clients stop stringifying object/array arguments.
    // Precedence: enum first — an enum param is by definition a constrained
    // string; unknown/absent types keep today's bare `z.any().optional()`
    // byte-for-byte (legacy pre-REQ-093 free-text-hint descriptors included).
    const paramSchema = tool.paramSchemas?.[key];
    const enumValues = paramSchema?.enum;
    let advertised: Record<string, unknown> | undefined;
    if (paramSchema) {
      if (enumValues && enumValues.length > 0) {
        // Enum case handled separately, but still need advertised for completeness
        advertised = { type: 'string', enum: [...enumValues] };
      } else {
        advertised = paramSchemaToAdvertised(paramSchema);
      }
    }
    if (enumValues && enumValues.length > 0) {
      shape[key] = z.enum(enumValues as [string, ...string[]]).optional();
    } else if (advertised) {
      shape[key] = z.any().meta(advertised).optional();
    } else {
      shape[key] = z.any().optional();
    }
  }
  return z.looseObject(shape);
}

/**
 * REQ-1318 — the params of one method that may be sent as a JSON STRING,
 * because the server parses it before the round trip.
 *
 * ⛔ DERIVE, NEVER ENUMERATE, for the REQ-1309 reason: a hard-coded method or
 * param list is a drift generator that the very next contract change has to
 * come back and edit. So this walks the descriptor's OWN declared params and
 * asks the same `expectsStructuredValue` predicate the parse itself is gated
 * on — which is the point. The list `figpea_describe` advertises and the list
 * the server acts on are the same predicate, so they cannot disagree.
 *
 * A legacy free-text manifest's params are hint STRINGS, not schemas, so they
 * are skipped and the caller omits the key entirely: with nothing structured
 * declared, there is no string-capable param to advertise, and an empty list
 * would read as "this method has none" rather than "this server cannot tell".
 *
 * Pure and module-level so it is testable in isolation, like `argShape.ts`'s
 * rules — which is the only honest way to pin "no method and no param is named
 * in here" without pinning prose.
 */
export function structuredParamNames(descriptor: { params?: unknown } | undefined): string[] {
  const params = descriptor?.params as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object') return [];
  const names: string[] = [];
  for (const [name, schema] of Object.entries(params)) {
    if (expectsStructuredValue(schema as RawJsonSchemaLike)) names.push(name);
  }
  return names;
}

/**
 * The positional array re-keyed by the method's own declared parameter names —
 * the SAME correspondence both lanes use to build the array the tab receives.
 *
 * REQ-1295 needs it because a pre-flight and a relay-side hint both have to
 * ask "what did this server send under the parameter named X", and in this
 * server that question is asked positionally: an agent writes
 * `figpea_call({group, method, args: [...]})` or `{id, patch}`, while the
 * manifest speaks only in names. Deriving the map once, from one helper, is
 * what keeps the two lanes and the two halves of the fix from disagreeing.
 */
function positionalValues(inputKeys: readonly string[], args: readonly unknown[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (let i = 0; i < inputKeys.length; i++) {
    const key = inputKeys[i];
    if (key !== undefined) values[key] = args[i];
  }
  return values;
}

/**
 * This method's expected positional args, rendered from its own declared
 * schemas — `["…", { … }]` — for the `Expected … args: […]` clause every
 * pre-flight refusal ends with.
 *
 * REQ-1444: this was written out four times, once per pre-flight site, and a
 * fourth copy is exactly how two sites end up saying the same thing in two
 * different ways. `req1295WireEncoding.test.ts:563` and `:594` assert the
 * resulting text, so the extraction had to be byte-identical — which is why it
 * is a lift of the existing expression and not a rewording.
 */
function expectedArgsExample(contractTool: GeneratedTool | undefined): string {
  if (!contractTool) return '…';
  return contractTool.inputKeys
    .map((k) => {
      const sch = contractTool.paramSchemas?.[k];
      return sch ? renderSchemaExample(sch) : '…';
    })
    .join(', ');
}

/**
 * THE one sentence grammar a pre-flight refusal is written in: what arrived,
 * where, what to send instead, what this method takes, and the one call that
 * teaches the shape.
 *
 * REQ-1444 (AC-6/AC-7): this template existed three times and the envelope
 * pre-flight needed a fourth. An agent that trips two different pre-flights
 * must read one grammar, not two — and `req1295WireEncoding.test.ts` asserts
 * this exact text for the existing sites, so it is byte-identical to what those
 * three produced. `code` is deliberately NOT here: the per-kind rule carries
 * the editor's `invalid_transform` and the wire rules carry ours, and the
 * caller owns that choice because it is the caller's rule.
 */
function refusalMessage(
  toolName: string,
  group: string,
  method: string,
  mismatch: ArgShapeMismatch,
  expectedArgs: string,
): string {
  return (
    `${toolName}: ${mismatch.path} must be ${mismatch.expected}, but it arrived as ${mismatch.got}. ` +
    `${mismatch.hint} ` +
    `Expected ${toolName} args: [${expectedArgs}]. ` +
    `Learn the exact shape first: figpea_describe({group:"${group}", method:"${method}"}).`
  );
}

/* ------------------------------------------------------------------ *
 * REQ-1498 — the PAYLOAD-FROM-A-FILE route, one reader for both lanes.
 *
 * The defect: this server read a local file in exactly two places —
 * `returnPath.ts`'s off-band RESULT writer and the `isValidFile` existence
 * probe the three `filePath` translations use — and neither is an INBOUND
 * route. So an agent that wrote `layer.batch`'s ops to a JSON file and passed
 * the path met the editor's own guard instead
 * (`v3/src/agent/groups/layer.impl.ts:2519-2527`): `ops must be a non-empty
 * array of {method, args} operations` — for a string, which is not an array.
 * Both lanes forwarded it verbatim, because both `layer_batch` branches guard
 * on `Array.isArray(ops)` and skip a string.
 *
 * ⛔ DERIVE, NEVER ENUMERATE. Nothing below names a method. The key is offered
 * on, and honoured for, any method whose manifest declares a TOP-LEVEL
 * `array`/`matrix` param — the same predicate `structuredParamNames` already
 * asks — so a method published that way is covered with no edit here.
 *
 * ⛔ EVERY REFUSAL COSTS ZERO ROUND TRIPS, and every one of them reuses
 * `invalid_params`, already this server's pre-flight code. The published
 * error-code vocabulary is therefore unchanged.
 * ------------------------------------------------------------------ */

/** The option's advertised description. One string, declared in BOTH
 *  `.describe()` and `.meta()` — the SDK's zod→JSON-Schema conversion takes the
 *  META description in preference to `.describe()`, so a `.describe()`-only
 *  declaration ships the knob blind (REQ-1282's recorded lesson). */
const OPS_FILE_ADVICE =
  'Optional. Absolute path to a JSON file whose content is this parameter\'s array — read by this server and ' +
  'substituted for it before the call reaches the editor, so a long payload never has to be pasted into the ' +
  'tool call. Send this parameter EITHER as a real array OR as this path, never both. The editor\'s per-call ' +
  'argument budget still applies to the array read from the file, unchanged: read the live value at ' +
  'describe().limits.argsChars and chunk as usual. A missing file, unreadable file, unparseable JSON, or content ' +
  'that is not a non-empty array is refused with invalid_params naming the file and the reason.';

/**
 * The name of this method's TOP-LEVEL `array`/`matrix` parameter, or
 * `undefined` when it declares none — so this server has no opinion about
 * where a payload-from-file would land.
 *
 * ⛔ `undefined` (never a guess) when more than one such parameter is declared:
 * a file could go in either slot, and picking one would silently discard the
 * caller's other payload.
 */
export function topLevelArrayParamName(paramSchemas: Record<string, ParamSchemaLike> | undefined): string | undefined {
  if (!paramSchemas) return undefined;
  const arrayParams = Object.entries(paramSchemas)
    .filter(([, schema]) => schema?.type === 'array' || schema?.type === 'matrix')
    .map(([name]) => name);
  return arrayParams.length === 1 ? arrayParams[0] : undefined;
}

/**
 * The positional index this method's top-level array/matrix parameter occupies,
 * or `undefined` when the manifest does not declare one.
 *
 * ⚠️ THIS FUNCTION EXISTS BECAUSE A HARD-CODED `0` WAS A REAL DEFECT (code-review
 * round 1). The option is DERIVED, so it is offered on every method declaring a
 * top-level `array`/`matrix` param — and those sit at different indices:
 * `layer.batch(ops)` at 0, `layer.setTransform(id, transform)` at 1. Reading the
 * index out of `inputKeys` is what keeps the derivation honest; a literal `0`
 * made `setTransform` refuse as ambiguous when the caller had sent no matrix,
 * and made an empty slot drop the arguments after it (`operation` silently lost
 * with `ok:true`).
 */
function opsFileSlotIndex(contractTool: GeneratedTool | undefined, paramName: string | undefined): number | undefined {
  if (!contractTool || !paramName) return undefined;
  const index = contractTool.inputKeys.indexOf(paramName);
  return index >= 0 ? index : undefined;
}

/**
 * Is the value at the payload slot a payload — i.e. is the file option actually
 * competing with something the caller sent?
 *
 * `undefined` and `null` are BOTH "no value here": `null` is the JSON spelling of
 * the same thing a host produces when it drops a key, and neither is an array,
 * so there is nothing for the file to override. Refusing `args:[null]` as
 * ambiguous refused a call that means exactly one thing.
 */
function opsFileSlotOccupied(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** The refusal when a call sends the payload AND a file carrying it. Refused
 *  rather than resolved: silently preferring one would discard half the call. */
function opsFileAmbiguityRefusal(optionKey: string, paramName: string): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: 'invalid_params',
    message:
      `${optionKey} and "${paramName}" were both sent, so this server cannot tell which payload you meant. ` +
      `Send "${paramName}" as a real array OR set ${optionKey} to a file — never both.`,
  };
}

/** And when the call names the option for a method that has no array payload
 *  to substitute it into. */
function opsFileNoArrayParamRefusal(optionKey: string): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: 'invalid_params',
    message: `${optionKey} is only meaningful for a method whose top-level payload is an array, and this one has no array parameter. figpea_describe({group, method}) lists its params.`,
  };
}

/**
 * Builds the `McpServer` for a bridge: `open_editor` + `status` are always
 * registered (OQ-4); contract tools are registered/updated from the bridge's
 * live `describe()` manifest on every connect/reconnect.
 */
/**
 * REQ-1451 T6 (AC-4) — the bounded deadline for `status`'s one tab-side
 * document read.
 *
 * Deliberately far below `DEFAULT_CALL_TIMEOUT_MS` (60 s, `callTimeout.ts`).
 * That default is right for a call that may CREATE something, where a slow
 * answer beats a false failure. `status` is the opposite: it is the diagnostic
 * an agent reaches for when something is already wrong, and it is called
 * repeatedly, so it must not stall on a tab that will never answer. 2 s is the
 * honest trade:
 *
 *  - Long enough that a busy-but-healthy tab answers inside it. The read is two
 *    property reads off the live project — no tree walk, no serialization —
 *    which is exactly why AC-4 needed a dedicated `session.document` method
 *    rather than reusing `layerTree()`. A tab that cannot answer two property
 *    reads in 2 s is wedged, not busy.
 *  - Short enough that the degradation is reached while the agent still cares
 *    about the answer. Every `status` call pays this at most once, so a wedged
 *    tab costs a 2 s stall per call rather than a 60 s one — and `status` is
 *    precisely the call an agent makes repeatedly while something is wrong, so
 *    the difference between 2 s and 60 s is the difference between a usable
 *    diagnostic loop and an unusable one.
 *
 * This is the cost of the `document` key, stated rather than hidden: against a
 * tab that ignores the call, `status` is now bounded by this deadline instead
 * of answering instantly. It is paid only in that state, and it buys the swap
 * detection AC-4 asks for in every healthy state.
 */
const DOCUMENT_READ_TIMEOUT_MS = 2_000;

export function createMcpServer(bridge: BridgeServerHandleLike, options?: CreateMcpServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const registeredTools = new Map<string, RegisteredTool>();
  const registeredMeta = new Map<string, { description: string; inputKeys: string[] }>();
  let toolCount = 0;
  const toolMode = options?.toolMode ?? 'full';

  function resolveEditorBaseUrl(perCall: string | undefined): string {
    return perCall ?? options?.editorBaseUrl ?? process.env.FIGPEA_EDITOR_URL ?? DEFAULT_EDITOR_BASE_URL;
  }

  /**
   * REQ-1394 — the bridge's connection diagnosis, or the honest fallback.
   *
   * Read ONCE per call and shared by every publisher (`status` and both
   * `no_tab` refusals), so the two can never disagree about what the bridge
   * observed. The fallback exists so the field is never MISSING: an agent
   * reading a payload with no `connection` key cannot tell "nothing happened"
   * from "this build does not report it", and `legacyDiagnosis` renders the one
   * bit such a bridge has in the same vocabulary rather than inventing
   * counters it never counted.
   */
  function connectionDiagnosis(): ConnectionDiagnosis {
    return bridge.getConnectionDiagnosis
      ? bridge.getConnectionDiagnosis()
      : legacyDiagnosis(bridge.isTabConnected());
  }

  /**
   * REQ-1503 — whether the tab is ANSWERING, or the honest fallback.
   *
   * Read once per call beside `connectionDiagnosis`, and deliberately a SEPARATE
   * axis rather than another `connection.lastEvent` token: all eight of those
   * describe the WebSocket transport, and a live socket to a wedged tab reports
   * `hello_accepted` — correctly, and uselessly. So `status` publishes this
   * beside `tabConnected`, which keeps its own old meaning untouched: the socket
   * is open. An agent needs both, and only one of them can see a frozen tab.
   */
  function liveness(): TabLiveness {
    return bridge.getLiveness ? bridge.getLiveness() : legacyLiveness(bridge.isTabConnected());
  }

  /** REQ-1492 — which slot mode this bridge serves. Read once per call, beside
   * `connectionDiagnosis`, so `status.bridgeSlots` and whether `select_tab` was
   * registered can never disagree. */
  function slotMode(): 'single' | 'multi' {
    return bridge.getSlotMode ? bridge.getSlotMode() : 'single';
  }

  /**
   * REQ-1492 — the paired tabs, as `status` publishes them (AC-6).
   *
   * A bridge that cannot report them (a stub in a test, or any caller passing a
   * handle without `getConnections`) gets the LEGACY shape rather than a missing
   * key: the one bit such a bridge has, rendered in the same vocabulary, with
   * `origin: null` + `originSource: "absent"` because such a bridge genuinely
   * cannot tell where its tab came from. Same reasoning as `legacyDiagnosis`
   * beside it — an agent reading a payload with no `connections` key cannot
   * distinguish "nothing paired" from "this build does not report it".
   */
  function connections(): BridgeConnectionLike[] {
    if (bridge.getConnections) return bridge.getConnections();
    return legacyConnections(bridge.isTabConnected(), bridge.getContractVersion ? bridge.getContractVersion() : null);
  }

  /** The tab `status` answers for: the active one, or `null` when none is. */
  function activeConnection(): BridgeConnectionLike | null {
    return connections().find((c) => c.active) ?? null;
  }

  /**
   * REQ-1457 — which build is answering, and is it still the one on disk.
   *
   * Read once per call through the optional seam, defaulting to the real module.
   * `buildStale` stays a TOP-LEVEL scalar because that is the shape an agent can
   * branch on without reading a nested key, while the multi-field identity sits
   * in a nested block — the shape REQ-1394's `connection` established on this
   * exact tool. Loose flat keys would bloat a payload six other keys share.
   */
  function buildFacts(): BuildStatus {
    return options?.buildStatus ? options.buildStatus() : servingBuild();
  }

  /**
   * REQ-1451 T6 (AC-4) — the active document's `{id, name}`, or `null`.
   *
   * This is the ONE tab-side call `status` makes, and it is bounded on purpose.
   * `status` is the call an agent makes when something is already wrong, so it
   * must never block: a wedged tab answers `null` after
   * `DOCUMENT_READ_TIMEOUT_MS` rather than holding the tool open for the flat
   * 60 s contract-call default, which would be the worst possible trade for a
   * diagnostic read.
   *
   * DEGRADATION IS TOTAL AND SILENT in all four cases, and every one of them is
   * a normal state rather than a fault:
   *   - no tab paired (matching `contractVersion: null`);
   *   - a tab that predates `session.document` — ORDINARY, because this package
   *     self-syncs its contract at runtime by origin fetch, so a newer MCP
   *     paired with an older editor is a supported combination, not a version
   *     error to surface;
   *   - a tab that answers something unusable (a non-object, a missing id, a
   *     `{ok:false}` envelope) — never passed through raw;
   *   - a bounded-call timeout.
   *
   * Never an error and never a throw: a status call that fails to learn the
   * document is still a status call that answers everything else.
   */
  async function activeDocument(): Promise<{ id: string; name: string } | null> {
    if (!bridge.isTabConnected()) return null;
    try {
      const raw = await bridge.callTab('session', 'document', [], DOCUMENT_READ_TIMEOUT_MS);
      // The relay resolves the tab's `{ok, value}` envelope; an older tab that
      // has no such method rejects or answers `{ok:false}`, so the shape is
      // checked rather than trusted.
      const value = (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)
        ? (raw as Record<string, unknown>).value
        : raw) as Record<string, unknown> | undefined;
      if (!value || typeof value !== 'object') return null;
      const id = value.documentId;
      const name = value.documentName;
      if (typeof id !== 'string' || !id) return null;
      return { id, name: typeof name === 'string' ? name : '' };
    } catch {
      // No tab (it disconnected mid-call), an older tab without the method, or
      // the bounded deadline. All are `null`; none is worth failing `status`
      // over, and none may surface as a raw bridge error to the agent.
      return null;
    }
  }


  function buildConnectUrl(perCallBaseUrl?: string, fileArg?: string): string {
    const url = new URL(resolveEditorBaseUrl(perCallBaseUrl));
    url.searchParams.set('agent', '1');
    url.searchParams.set('bridgePort', String(bridge.port));
    url.searchParams.set('bridgeToken', bridge.token);
    if (fileArg) {
      url.searchParams.set('loader', 'http');
      url.searchParams.set('url', fileArg);
    }
    return url.toString();
  }

  server.registerTool(
    'open_editor',
    {
      description:
        'Opens a Figpea editor tab wired to connect back to this bridge. Returns {port, token, url} -- open `url` in a browser to connect an editor tab; the returned port/token also let a caller compose its own URL.',
      inputSchema: {
        file: z.string().optional().describe('Optional design-file URL to load via the ?loader=http seam.'),
        editorBaseUrl: z.string().optional().describe('Overrides the editor origin for this call only.'),
      },
    },
    async (args) => {
      const fileArg = typeof args.file === 'string' ? args.file : undefined;
      const baseArg = typeof args.editorBaseUrl === 'string' ? args.editorBaseUrl : undefined;
      const urlStr = buildConnectUrl(baseArg, fileArg);
      return jsonTextResult({ port: bridge.port, token: bridge.token, url: urlStr });
    },
  );

  server.registerTool(
    'status',
    {
      description:
        "Reports the bridge's port, whether an editor tab is connected, the connected tab's contract version (null if none), and how many contract tools are currently registered. Also returns token and url so an LLM can construct the paste-ready pairing string without re-launching (REQ-1035). Returns a `connection` block naming WHY a tab is not connected — `lastEvent` (no_attempt, transport_only, hello_timeout, hello_rejected, hello_accepted, slot_refused, tab_superseded, disconnected) with the `nextStep` it implies, plus per-process counters and the run's `startedAt`; read it instead of re-trying a pairing blindly. Returns `document` — the active design's `{id, name}`, or null with no tab, with an older tab, or when the tab does not answer — so you can tell WHICH design you are pointed at, and notice that it changed between two calls, without issuing a mutation first. Pair it with the tab's `session.expectDocument` to make a mutation refuse itself against the wrong design. `slot_refused` means a second tab asked for this bridge's single slot and did not get it — the tab already paired is untouched and still serving; open it with --bridge-slots=multi (or FIGPEA_BRIDGE_SLOTS=multi) to pair both at once. Also returns WHICH BUILD is answering: a `build` block (`version`, `buildId`, `builtAt`, `servedAt`, `root`) and a top-level `buildStale` boolean. Read `buildStale` BEFORE spending time on a call that fails in a way the current source would not — your MCP host owns this process and does not restart it when a newer build lands on disk, so a stale process answers with code from before the fix and the failure reads as a bug in the design file. `buildStale: true` means restart the MCP server; when it is false, `build.buildId` is provably the build this process loaded, so match it against the commit you are reading the source of. It says nothing about the connected editor tab's build (REQ-1457). REQ-1492 adds WHICH TAB it is attached to: a `tab` block (`connectionId`, `origin`, `originSource`, `contractVersion`, `pairedAt`) naming the tab this call is answered for, a `connections[]` list of every paired tab with its own id/origin/contract version and `active` flag, `activeConnectionId`, and `bridgeSlots` ('single' or 'multi' — how this bridge serves tabs). Read `tab.origin` and `tab.contractVersion` BEFORE a destructive write: assert you are on the document you expect. `originSource` is 'handshake' when the tab's connection carried an Origin header and 'absent' when it did not, so origin null means the browser declined to send one, never a value this server guessed. REQ-1503 adds a `liveness` block beside `tabConnected`, naming whether the TAB is ANSWERING: `state` (unpaired, unknown, responsive, unresponsive) with the `nextStep` that token implies, plus `connectionId`, `inFlight`, `oldestInFlightMs`, `consecutiveTimeouts`, `lastAnswerAt` and `lastTimeoutAt`. `tabConnected` keeps its own meaning — the socket is open — and cannot see a wedged tab, because a frozen tab holds its socket open forever while every call times out; read `liveness` BEFORE retrying a timed-out call. It reports what this bridge OBSERVED, never why: `unresponsive` is two calls in a row going unanswered, or one on a tab that had never answered, and it is NOT proof the tab failed — a large project mid-render and a frozen tab look identical from here, and a timed-out call may still land. `unknown` means nothing has been observed yet, not that the tab is healthy; in-flight age is published as `inFlight`/`oldestInFlightMs` rather than folded into the state, because a slow `session.openFile` runs 120000ms by its own documented default. It describes the tab calls are ADDRESSED TO — read `activeConnectionId` to know which one that is, and `select_tab` to change it. With the MCP channel gone, the same facts are readable over the bridge's own `GET /state` and a call can be relayed over its token-gated `POST /call`, so a run can be finished without this server: the bridge keeps serving without the MCP channel (README → Recovering a lost session).",
    },
    async () => {
      const { build, stale } = buildFacts();
      const paired = connections();
      const active = paired.find((c) => c.active) ?? null;
      return jsonTextResult({
        port: bridge.port,
        token: bridge.token,
        url: buildConnectUrl(undefined, undefined),
        tabConnected: bridge.isTabConnected(),
        // --- REQ-1503, additive and beside `tabConnected`, whose meaning is
        // UNCHANGED (the socket is open). `liveness` is the other question: is
        // the tab answering. It reports what this bridge OBSERVED, never why —
        // `unresponsive` is two calls in a row going unanswered (or one on a tab
        // that had never answered), which is not proof the tab failed, because a
        // timed-out call may still land.
        liveness: liveness(),
        // Unchanged key, unchanged type: with one tab paired this is the same
        // value it has always been (AC-8); with two it is the ACTIVE tab's,
        // which is the meaning AC-6 asks for.
        contractVersion: bridge.getContractVersion ? bridge.getContractVersion() : null,
        toolCount,
        // --- REQ-1492, all additive ---
        bridgeSlots: slotMode(),
        activeConnectionId: active?.connectionId ?? null,
        tab: active,
        connections: paired,
        connection: connectionDiagnosis(),
        build,
        buildStale: stale,
        document: await activeDocument(),
      });
    },
  );

  /**
   * REQ-1492 — `select_tab`, registered ONLY when the bridge runs in multi-slot
   * mode.
   *
   * The gate is the honest shape (in single-slot mode there is nothing to
   * select: the second tab is refused by name instead) and a free regression net:
   * six exact tool-list assertions across `cli.test.ts`, `mcpServer.test.ts`,
   * `packedArtifact.test.ts` and `req1018.test.ts` all use a default
   * single-slot bridge and stay green untouched. If any of them ever moves, the
   * mode leaked.
   *
   * Its own description states the condition, because an agent that reads only
   * `tools/list` must not be told the tool is unconditional.
   */
  if (slotMode() === 'multi' && bridge.selectConnection) {
    server.registerTool(
      'select_tab',
      {
        description:
          'Chooses which paired editor tab subsequent figpea_call / contract-tool calls address, in a bridge running multi-slot mode (registered only when this bridge was started with --bridge-slots=multi or FIGPEA_BRIDGE_SLOTS=multi; a default single-slot bridge serves one tab and does not register this tool). Read status first: `connections[]` lists every paired tab with its own connectionId, origin and contract version, and `activeConnectionId` names the one calls currently reach. Selecting a tab moves that pointer AND re-publishes that tab\'s own contract manifest, so the tools you were given describe the document your next call reaches — two tabs can run different contract versions. Each tab keeps its own document: calls addressed here never reach another tab.',
        inputSchema: {
          connectionId: z.string().describe('The connectionId to address, exactly as status lists it (e.g. "c2").'),
        },
      },
      async (rawArgs) => {
        const wanted = (rawArgs as { connectionId?: unknown }).connectionId;
        if (typeof wanted !== 'string' || wanted === '') {
          return jsonTextResult({
            ok: false,
            code: 'invalid_connection_id',
            message:
              'connectionId is required. Read status first — `connections[]` lists every paired tab with its own connectionId.',
          });
        }
        try {
          await bridge.selectConnection!(wanted);
          const active = activeConnection();
          return jsonTextResult({
            ok: true,
            connectionId: wanted,
            activeConnectionId: active?.connectionId ?? null,
            origin: active?.origin ?? null,
            originSource: active?.originSource ?? 'absent',
            contractVersion: active?.contractVersion ?? null,
          });
        } catch (e) {
          return jsonTextResult({
            ok: false,
            code: 'unknown_connection',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
    );
  }

  // REQ-705 — `figpea_skill`: always-registered (mirrors `open_editor`/
  // `status`, not manifest-derived), no input schema (mirrors `status`'s
  // no-argument shape). Sourced from `options.prefetchedSkillBody` (set
  // once in cli.ts's main() via skillFetch.ts's fetchSkill(), alongside the
  // existing fetchContract() call) -- NOT tab-derived, so unlike the
  // contract tools it needs no `bridge.onDescribe` re-registration and is
  // visible in `tools/list` regardless of tab state.
  server.registerTool(
    'figpea_skill',
    {
      description:
        "Returns Figpea's agent skill reference -- the craft guidance for using window.figpea well (the authoring loop, recreating a reference faithfully, wiring interactions, the screenshot feedback loop, undo etiquette, entitlement boundaries, and the canonical Tier-1 recipe). Sourced from the editor origin's /agent/skill.md at startup, and the answer NAMES that origin: the body is that origin's own build, so if a tab is paired from a different origin or build, get the tab's skill with figpea.SKILL() in the tab or GET <the tab's origin>/agent/skill.md.",
    },
    async () => {
      if (options?.prefetchedSkillBody) {
        return textResult(
          skillWithProvenance(options.prefetchedSkillBody, options.prefetchedSkillUrl, bridge.isTabConnected()),
        );
      }
      return jsonTextResult({
        ok: false,
        code: 'skill_unavailable',
        message:
          'The skill body was not available at startup (fetch failed, or disabled via FIGPEA_DISABLE_CONTRACT_FETCH). ' +
          'Get it another way: call figpea.SKILL() from a connected editor tab, or GET <editor-origin>/agent/skill.md directly.',
      });
    },
  );

  // REQ-1268 T2 (AC-1) — `figpea_describe`: a describe-equivalent for
  // COMPACT mode, which is the default (cli.ts:79) and otherwise the only way
  // to reach a contract method. Before this, the descriptor knowledge was in
  // memory (the prefetched manifest) but nothing published it: the agent had
  // to blind-guess `figpea_call(group:"session", method:"describe")` or read
  // a Markdown doc, so `layer.batch`'s nested positional shape was
  // undiscoverable — the exact cause of the REQ-1268 incident payload.
  //
  // Registered in compact mode ONLY. In full mode every generated tool's
  // description already carries `doc + Params: + Result:` (tools.ts
  // buildDescription), so a describe tool there would be dead surface, and
  // registering it in both modes would churn the full-mode tool-list pins for
  // no benefit. Compact-only also keeps full mode byte-identical.
  //
  // It is a real tool rather than a selector argument on `figpea_call` on
  // purpose: a tool is discoverable in `tools/list`, whereas a selector has to
  // be guessed — which is the failure being fixed.
  if (toolMode === 'compact') {
    server.registerTool(
      'figpea_describe',
      {
        description:
          "Returns the agent contract surface for a group or method — the same doc/params/result the editor's own describe() returns, served from the manifest this server already holds in memory (no round trip to the tab). Call it with no arguments for the group index, {group} for one group's methods, or {group, method} for one method's wire shape. In compact mode this is how you learn a method's argument shape instead of probing: e.g. figpea_describe({group:'layer', method:'batch'}) returns the ops shape, whose args is a POSITIONAL array of {method, args} ops. A per-method response also carries stringJsonParams: the names of THIS method's params you may send as a JSON string instead of a real object/array, because the server parses them before the round trip (e.g. [\"[{\\\"method\\\":\\\"create\\\",\\\"args\\\":[\\\"rect\\\",{\\\"rwidth\\\":100}]}]\"] for ops). The key is absent when the method declares no such param, and it is derived from the manifest, so it is right for any method without this description being updated. A per-method response also carries wire: this method's parameters as the POSITIONAL slots they occupy — encoding, a callAs line showing e.g. layer.stylePatch(id, patchContents), and each slot's index, name, type, an object slot's legal contents, and the one envelope not to send. Read it because params is the DECLARATION and not the encoding: an object-valued parameter IS its positional slot, so its contents go flat and never inside an envelope keyed by the parameter's name. A group listing states the same thing once for every method it holds, as encodingNote. The wire key is absent when the method declares no positional arguments, and it is derived from the same manifest params is read from, so it is right for any method without this description being updated.",
        inputSchema: {
          group: z.string().optional().describe("Contract group name (e.g. layer, canvas, session, export). Omit for the index of all groups."),
          method: z.string().optional().describe('Method name within the group (e.g. create, batch). Requires group.'),
        },
      },
      async (rawArgs) => {
        const manifest = activeManifest;
        if (!manifest) {
          // Degrade exactly like figpea_skill: a named failure with both
          // alternative routes, never a throw and never an empty object.
          return jsonTextResult({
            ok: false,
            code: 'describe_unavailable',
            message:
              'The contract manifest is not available (the startup fetch failed, or was disabled via FIGPEA_DISABLE_CONTRACT_FETCH, and no editor tab has described itself yet). ' +
              'Get it another way: call figpea_call with group "session" and method "describe" from a connected editor tab, or GET <editor-origin>/agent/contract.json directly.',
          });
        }

        const group = (rawArgs as { group?: unknown }).group;
        const method = (rawArgs as { method?: unknown }).method;
        const knownGroups = groupNamesFromCompactIndex(manifest);

        if (typeof group === 'string' && group !== '') {
          if (!knownGroups.includes(group)) {
            return jsonTextResult({
              ok: false,
              code: 'unknown_group',
              message: `Unknown group "${group}". Known groups: ${knownGroups.join(', ')}`,
            });
          }
          const methods = manifest[group];
          if (typeof method === 'string' && method !== '') {
            const descriptor = methods[method];
            if (!descriptor) {
              return jsonTextResult({
                ok: false,
                code: 'unknown_method',
                message: `Unknown method "${group}.${method}". Known methods in ${group}: ${Object.keys(methods).join(', ')}`,
              });
            }
            // REQ-1318 (AC-7) — the additive key. An agent deciding HOW to
            // encode a value needs to know, at the moment it decides, which of
            // this method's params may travel as a JSON string; today the only
            // way to learn that is to try it and read an error. Derived from
            // the descriptor's own declared params by the same predicate the
            // parse is gated on, so the advertised list and the acted-on list
            // cannot drift. Absent when empty (a method with nothing
            // structured, or a legacy free-text manifest with no schemas at
            // all) rather than sent as `[]`, which would read as "this method
            // has none" instead of "this server cannot tell".
            //
            // Everything the editor documented is spread through untouched
            // below — this server does not restate the editor's docs, it only
            // adds the one fact the manifest itself cannot express.
            const stringJson = structuredParamNames(descriptor);
            // REQ-1295 (AC-2/AC-4) — the sibling additive key, and the one the
            // declaration itself cannot express. `params` publishes a NAMED
            // DECLARATION while `figpea_call` takes its arguments POSITIONALLY,
            // so for a method whose argument is an object the shape an agent
            // reads and the shape it must send are two different things and
            // nothing on this surface said which was which — the one fact that
            // turned `unsupported_style_key: patch` into a dead end.
            //
            // Absent when this server has no opinion (no declared schemas, or a
            // method with no parameters) rather than sent as a partial listing,
            // and additive beside everything the editor documented: this server
            // does not restate the editor's docs, it adds the one thing the
            // manifest cannot express.
            const wire = wireEncoding(descriptor, `${group}.${method}`);
            return jsonTextResult({
              ok: true,
              group,
              method,
              ...(stringJson.length > 0 ? { stringJsonParams: stringJson } : {}),
              ...(wire ? { wire } : {}),
              ...descriptor,
            });
          }
          // REQ-1295 — the group listing states the encoding ONCE for every
          // method it holds, so the rule is learnable before a drill rather
          // than one describe round trip per method.
          return jsonTextResult({ ok: true, group, encodingNote: groupEncodingNote(), methods });
        }

        // Bare index, mirroring the editor's own compact index: a reserved
        // `version` string plus one doc-string entry per method, so an agent
        // can see what exists before paying for a drill.
        const index: Record<string, unknown> = {};
        if (typeof (manifest as Record<string, unknown>)['version'] === 'string') {
          index['version'] = (manifest as Record<string, unknown>)['version'];
        }
        for (const name of knownGroups) {
          const perGroup: Record<string, string> = {};
          for (const [methodName, descriptor] of Object.entries(manifest[name])) {
            perGroup[methodName] = descriptor?.doc ?? '';
          }
          index[name] = perGroup;
        }
        return jsonTextResult({ ok: true, groups: index });
      },
    );
  }

  // REQ-1268 T4 (AC-3) — compact/full coercion parity.
  //
  // `coerceValue` had exactly ONE call site, inside `makeContractHandler`,
  // which only exists in FULL mode. So in compact mode — the default, and the
  // only way to reach a contract method — `pageWidth:"100"` reached the tab as
  // a string, and the identical call succeeded in full mode. That is the
  // "correct envelope but still fails" half of the incident.
  //
  // This reuses the SAME function on the default path rather than writing a
  // second coercion: one lazy index over the manifest we already hold, looked
  // up by `group_method`, and the same positional↔schema correspondence
  // `makeContractHandler` already relies on (`paramKeys()` is
  // `Object.keys(descriptor.params)` in declaration order).
  //
  // Lazy, never at startup: the index is built on first use and rebuilt only
  // when the manifest identity changes (a new describe() event). It is built
  // SEPARATELY from `registerContractTools` and never assigns `toolCount`, so
  // compact mode's `status.toolCount === 0` is untouched.
  let contractIndex: Map<string, GeneratedTool> | null = null;
  let contractIndexFor: ManifestLike | undefined;
  /** REQ-1444 (AC-4) — every create-shaped params declaration in the manifest
   *  this server holds, memoized on the same manifest identity (and so the same
   *  invalidation signal) as `contractIndex` above. */
  let createPropsIndex: ParamSchemaLike[] | null = null;
  let createPropsIndexFor: ManifestLike | undefined;

  /** REQ-1268 T5 — belt-and-braces half of AC-5.
   *
   * The pre-flight above catches every shape the declared schema can
   * classify. This catches the rest: when the tab itself rejects the call and
   * the relayed message teaches nothing, append the route to the descriptor
   * instead of leaving the agent with a bare editor error. It never rewrites
   * the code or the original message — only adds the missing next step — and
   * it is idempotent, so a message that already carries a hint is untouched. */
  function appendShapeHint<T>(result: T, group: string, method: string): T {
    const r = result as { ok?: unknown; code?: unknown; message?: unknown };
    if (r?.ok !== false) return result;
    if (r.code !== 'invalid_params') return result;
    if (typeof r.message !== 'string') return result;
    if (r.message.includes('figpea_describe')) return result;
    r.message =
      `${r.message} — to see this method's exact argument shape, call figpea_describe({group:"${group}", method:"${method}"}).`;
    return result;
  }

  /**
   * REQ-1295 T4 (AC-3) — the belt-and-braces half of the DECLARED-WRAPPER
   * lesson, extending `appendShapeHint` above with the case that rule cannot
   * reach.
   *
   * A pre-flight derives its verdict from declared schemas, so it declines
   * whenever there is nothing to derive from: a legacy free-text manifest, an
   * object parameter with no declared `shape`, a wrapper nested inside an op's
   * own `args` (that method declares only `ops`, so the op's parameter names
   * are not THIS method's). In each of those the payload is forwarded and the
   * editor answers `unsupported_style_key: <paramName>` — naming an internal
   * key the caller never sent, which is the misleading lesson this REQ exists
   * to remove.
   *
   * ⛔ It appends only. It never rewrites the editor's code and never rewrites
   * the editor's message — those are the editor's, and they are right about
   * what it actually received. It is idempotent, and it fires only when BOTH
   * facts hold: the offending key is a declared parameter name of the called
   * method AND the value this server sent under that key was a plain object.
   * Any other `unsupported_style_key` is left exactly as it arrived, because
   * appending a wrapper lesson to a genuine style-key problem would be the same
   * error one word later.
   *
   * KNOWN RESIDUAL, stated rather than papered over: inside `layer.batch` the
   * called method IS `batch` (params `{ops}`), so a wrapper inside an op's own
   * `args` has no declared parameter name to match and BOTH halves decline. The
   * tab still answers, and REQ-1268's `invalid_params` hint above still applies
   * to the stringified case. Teaching the batch-nested wrapper would mean
   * resolving each op's own method against the manifest — real work, which no
   * acceptance criterion asks for. Deliberate non-goal, recorded here so the
   * next reader does not read the gap as an oversight.
   */
  function appendWrapperHint<T>(result: T, paramNames: ReadonlySet<string>, values: Record<string, unknown> | undefined): T {
    const r = result as { ok?: unknown; code?: unknown; message?: unknown };
    if (r?.ok !== false) return result;
    if (r.code !== 'unsupported_style_key') return result;
    if (typeof r.message !== 'string') return result;
    if (r.message.includes('the declaration is not the encoding')) return result; // idempotent
    const offending = /unsupported style key "([^"]+)"/.exec(r.message)?.[1];
    if (offending === undefined) return result;
    if (!paramNames.has(offending)) return result;
    const sent = values?.[offending];
    if (sent === null || typeof sent !== 'object' || Array.isArray(sent)) return result;
    r.message =
      `${r.message} — read that key as this method's own DECLARATION arriving where its contents were due, ` +
      `not as a style key you may not send: ${offending} IS its positional slot here, so send its contents flat ` +
      `with no "${offending}" wrapper. ` +
      `Expected ${offending} contents: ${Object.keys(sent as Record<string, unknown>).join(', ') || '…'}.`;
    return result;
  }
  function contractToolFor(groupName: string, methodName: string): GeneratedTool | undefined {
    const manifest = activeManifest;
    if (!manifest) return undefined;
    if (contractIndex === null || contractIndexFor !== manifest) {
      contractIndex = new Map(buildToolsFromManifest(manifest).map((tool) => [tool.name, tool]));
      contractIndexFor = manifest;
    }
    return contractIndex.get(`${groupName}_${methodName}`);
  }

  /**
   * REQ-1444 (AC-4) — every create-shaped params declaration the manifest
   * holds: an object param that publishes PER-KIND entries.
   *
   * ⛔ DERIVED, NEVER ENUMERATED. Nothing here names `layer.create`, a kind, or
   * a prop. A method published the same way upstream is covered with no edit
   * here, and a manifest this build has never seen answers correctly for free.
   * The structural signature is the one REQ-1309's own rule already keys on,
   * so the two agree on what "create-shaped" means.
   *
   * The set is the union of those declarations' COMMON props, so the lesson
   * fires when the offending key is a common prop of something the editor can
   * create — and is silent when it is not, which is what keeps the hint off an
   * error it does not explain.
   */
  function createPropsSchemas(): readonly ParamSchemaLike[] {
    const manifest = activeManifest;
    if (!manifest) return [];
    if (createPropsIndex === null || createPropsIndexFor !== manifest) {
      const found: ParamSchemaLike[] = [];
      for (const tool of buildToolsFromManifest(manifest)) {
        for (const schema of Object.values(tool.paramSchemas ?? {})) {
          if (schema.byKind && Object.keys(schema.byKind).length > 0) found.push(schema);
        }
      }
      createPropsIndex = found;
      createPropsIndexFor = manifest;
    }
    return createPropsIndex;
  }

  /**
   * REQ-1444 T4 (AC-4) — the third relay-side lesson, beside the two above.
   *
   * A `create()` prop sent where style keys go: `layer.create` NESTS them
   * (`{style:{fontSize:26}}`) because geometry and appearance live in props,
   * while `layer.stylePatch` takes them FLAT. An agent that learned the first
   * and called the second is answered `unsupported_style_key: "style"` — which
   * is accurate about what arrived and points at the wrong thing to change.
   *
   * ⛔ IT APPENDS ONLY. The editor's code and message are the ones that have to
   * survive: the card asks for a message naming the flat form "not only
   * `unsupported_style_key`", which only has meaning if that code is still
   * there. Replacing a message this server does not own would also break the
   * coherence pin in `readme.test.ts`, which requires the editor's own clause
   * verbatim on the counter-example and forbids relaxing it.
   *
   * ⛔ NOT A PRE-FLIGHT, and that is a decision rather than an oversight. A
   * pre-flight would have to PROVE the editor would reject the payload, and a
   * false rejection of a call the editor accepts is the expensive direction; an
   * append cannot reject anything, because the call has already happened.
   *
   * Exclusive with `appendWrapperHint` above by construction: a key that is a
   * declared parameter name is REQ-1295's declaration mistake, and that lesson
   * must win.
   */
  function appendCreatePropHint<T>(
    result: T,
    group: string,
    method: string,
    contractTool: GeneratedTool | undefined,
    createPropsSchemas: readonly ParamSchemaLike[],
    values: Record<string, unknown> | undefined,
  ): T {
    const r = result as { ok?: unknown; code?: unknown; message?: unknown };
    if (r?.ok !== false) return result;
    if (r.code !== 'unsupported_style_key') return result;
    if (typeof r.message !== 'string') return result;
    if (r.message.includes('figpea_describe')) return result; // idempotent
    const offending = /unsupported style key "([^"]+)"/.exec(r.message)?.[1];
    if (offending === undefined) return result;
    // A declared parameter name is REQ-1295's case, and that lesson wins.
    if (contractTool?.inputKeys.includes(offending)) return result;
    const hint = createPropStyleHint(
      group,
      method,
      createPropsSchemas,
      contractTool?.paramSchemas,
      values,
      offending,
      values ? values[contractTool!.inputKeys[0] ?? ''] : undefined,
    );
    if (!hint) return result;
    r.message = `${r.message} — ${hint}`;
    return result;
  }

  /**
   * REQ-1444 T4 (AC-5) — the fourth relay-side lesson.
   *
   * The JSON-string escape hatch is real and correct — a string is a scalar and
   * this server parses a JSON-looking string at any position the manifest
   * declares as `object`/`array`/`matrix`. But the parse iterates the
   * container's TOP-LEVEL positions (`rawJson.ts:263-306`), so a string nested
   * INSIDE a real object is never visited: at `args:[{pageId, patch:"…"}]`
   * position 0's schema is `pageId`, declared a string, and the gate is false.
   * The editor's `setPageFill(): patch must be object (got string)` is then a
   * dead end — it names what arrived and nothing about what to send.
   *
   * Runs BEFORE `appendShapeHint` in the composed pass, because the appended
   * sentence carries its own `figpea_describe` clause and `appendShapeHint`
   * declines on that — which is how the agent reads ONE appended sentence
   * rather than two (REQ-1295's rule, applied to the new half).
   *
   * ⛔ IT APPENDS ONLY, for the same reason as its sibling above.
   */
  function appendNestedStringHint<T>(
    result: T,
    group: string,
    method: string,
    contractTool: GeneratedTool | undefined,
    args: readonly unknown[],
  ): T {
    const r = result as { ok?: unknown; code?: unknown; message?: unknown };
    if (r?.ok !== false) return result;
    if (r.code !== 'invalid_params') return result;
    if (typeof r.message !== 'string') return result;
    if (r.message.includes('figpea_describe')) return result; // idempotent
    // The editor's own clause is the load-bearing evidence that this IS the
    // stringified case, so nothing here fires without it.
    if (!/\(\): \w+ must be (?:object|array|matrix) \(got string\)/.test(r.message)) return result;
    const inputKeys = contractTool?.inputKeys ?? [];
    const paramSchemas = contractTool?.paramSchemas;
    const mismatch = findNestedStructuredStringMismatch(
      paramSchemas,
      args,
      (name) => `args[${inputKeys.indexOf(name)}]`,
    );
    if (!mismatch) return result;
    const paramName = inputKeys[Number(/^args\[(\d+)\]/.exec(mismatch.path)?.[1] ?? -1)];
    if (paramName === undefined) return result;
    const hint = nestedStringHint(group, method, inputKeys, paramSchemas, paramName);
    if (!hint) return result;
    r.message = `${r.message} — ${hint}`;
    return result;
  }

  // REQ-1018 — figpea_call dispatcher (compact mode only)

  if (toolMode === 'compact') {
    server.registerTool(
      'figpea_call',
      {
        description:
          'Universal dispatcher — calls any group.method on the paired editor tab via bridge.callTab(group, method, args, _timeoutMs?). In compact mode this is the only way to reach contract methods; in full mode the individual tools are also available. group/method are the describe() surface names, and args is the POSITIONAL argument array for that method, in that method\'s own parameter order. FLAT example: ["rect", {rwidth:100}] for layer.create. NESTED example — when a parameter is itself an array (e.g. layer.batch\'s ops), that parameter is passed as ONE element of args, so the element is an array of {method, args} ops: {"group":"layer","method":"batch","args":[[{"method":"create","args":["page",{"name":"probe","pageWidth":100,"pageHeight":100}]}]]}. Each op\'s own args is likewise a positional ARRAY, never an object. Unsure of a method\'s shape? Call figpea_describe({group, method}) first — it returns that method\'s doc and params from the manifest with no round trip to the tab. Image results return MCP image content + a text summary. Pass returnAs:"path" to receive a binary result off-band as a session file path instead of inline base64 — it reaches every binary export, e.g. canvas_screenshot / export_layer / export_artboard for images and export_project for a native .fp. ' + TIMEOUT_KNOB_ADVICE + ' ' + ARGS_BUDGET_ADVICE,
        // REQ-1296 D1 — loose for the SAME reason as buildInputShape, and it is
        // load-bearing rather than cosmetic here: `figpea_call` is the ONLY way
        // to reach a contract method in compact mode, so if its schema keeps
        // stripping, AC-3's blanket rule ("no contract method accepts an
        // unrecognised param and returns ok:true") is simply false in the
        // default mode — the agent's `{group, method, args, filePath}` would be
        // answered with a success, in the mode ~90–95% of agents run in.
        inputSchema: z.looseObject({
          group: z.string().describe('Contract group name (e.g. layer, canvas, session, export)'),
          method: z.string().describe('Method name within the group (e.g. create, screenshot)'),
          // REQ-1268 T3 (AC-2): the rule that generalises past the one nested
          // example above. `.describe()` because that is the mechanism already
          // proven in this file (and asserted in mcpServer.test.ts), and
          // `.meta()` in the REQ-769 idiom so a type-respecting client sees
          // the array-of-array shape in the advertised JSON Schema.
          //
          // VERIFIED, not assumed (plan D2's verify-then-pin): the SDK's
          // zod→JSON Schema conversion takes the `meta` description in
          // PREFERENCE to `.describe()` — a scratch dump of `tools/list` showed
          // the meta text winning outright. So the nested rule is carried in
          // BOTH, or the advertised half (the half AC-2 actually asserts, and
          // the half a type-respecting client reads) would be the one that lost
          // it. req1268.test.ts pins what `tools/list` really advertises.
          //
          // Parse behaviour is deliberately UNCHANGED — still `z.array(z.any())`
          // — so this adds guidance and zero new rejections.
          args: z
            .array(z.any())
            .optional()
            .describe(
              'Positional arguments for the method, in that method\'s own parameter order (defaults to []). When a parameter is itself an array (e.g. layer.batch\'s ops), pass it as ONE element of args — that element is an array of {method, args} ops, e.g. [[{method:"create", args:["rect",{rwidth:100}]}]]. Each op\'s args is an array too, never an object. If your harness cannot send a nested object or array, any param the method declares as an object/array may instead be sent as a JSON string with no flag, and this server parses it before the round trip — e.g. "args":["[{\"method\":\"create\",\"args\":[\"rect\",{\"rwidth\":100}]}]"]. A string is a scalar, so nothing collapses it; figpea_describe({group, method}) lists which of this method\'s params accept that as stringJsonParams. REQ-1498: when the payload is too long to paste into the call at all, set _opsFile to the absolute path of a JSON file whose content is that array and leave the array out of args entirely — this server reads it and substitutes it before the round trip; the editor\'s per-call argument budget still applies to the array read from the file. ' + ARGS_BUDGET_ADVICE,
            )
            .meta({
              type: 'array',
              description:
                'Positional argument array, in the method\'s own parameter order. An array-typed parameter (e.g. layer.batch\'s ops) is passed as ONE element of args, and that element is itself an array of {method, args} ops — e.g. [[{method:"create", args:["rect",{rwidth:100}]}]]. Each op\'s args is an array, never an object. If your harness cannot send a nested object or array, any param the method declares as an object/array may instead be sent as a JSON string with no flag, and this server parses it before the round trip — e.g. "args":["[{\"method\":\"create\",\"args\":[\"rect\",{\"rwidth\":100}]}]"]. A string is a scalar, so nothing collapses it; figpea_describe({group, method}) lists which of this method\'s params accept that as stringJsonParams. REQ-1498: when the payload is too long to paste into the call at all, set _opsFile to the absolute path of a JSON file whose content is that array and leave the array out of args entirely — this server reads it and substitutes it before the round trip; the editor\'s per-call argument budget still applies to the array read from the file. ' + ARGS_BUDGET_ADVICE,
            }),
          // REQ-1282 AC-5 — the advice an agent needs at the moment it decides
          // whether to pass this at all, carried in BOTH halves for the reason
          // recorded at TIMEOUT_KNOB_ADVICE: the SDK advertises the `meta`
          // description in preference to `.describe()`, so `.describe()` alone
          // would leave the shipped schema silent. The PARSE behaviour is
          // unchanged (`z.number().optional()`), so this adds guidance and
          // zero new rejections.
          _timeoutMs: z
            .number()
            .optional()
            .describe(`Optional per-call timeout override in ms. ${TIMEOUT_KNOB_ADVICE}`)
            .meta({ description: `Optional per-call timeout override in ms. ${TIMEOUT_KNOB_ADVICE}` }),
          // REQ-1280 T3 — this flag was advertised as a "reserved passthrough"
          // on the ONE tool compact mode registers, and was inert here: an
          // agent that set it got the editor's own rejection back with nothing
          // connecting the error to the flag. It is now a real, working escape
          // hatch, and REQ-1268 measured this exact failure mode for this exact
          // tool — an agent that does not know the flag works never sets it.
          // The worked example is the REQ-1268 idiom: a payload to copy, not
          // an abstract rule. It promises what the guard delivers (stringified
          // objects/arrays are parsed) and no more (it does not claim every
          // string is parsed). The zod TYPE stays `z.any().optional()`, so
          // this adds zero new safeParseAsync rejections.
          _rawJson: z
            .any()
            .optional()
            .describe(
              'Set _rawJson:true on your figpea_call when your harness STRINGIFIED an object or array argument AND this server cannot tell what that position expects — the method is unknown, the parameter is not declared as an object/array/matrix in the manifest this server holds, or no manifest has been fetched yet. At such a position, and at any position the manifest DOES declare as an object/array/matrix, every element of args that is a string whose trimmed form starts with { or [ and ends with } or ] is JSON-parsed before it reaches the editor, e.g. {"group":"layer","method":"create","args":["page","{\\"name\\":\\"probe\\",\\"pageWidth\\":300,\\"pageHeight\\":200}"],"_rawJson":true}. A position the manifest declares a string/number/boolean is NEVER parsed, even when its text is valid JSON: setName(id, \'[1,2,3]\') still names the layer [1,2,3], and a code sample or a fake API response stays the text you sent. NOTE you usually do NOT need this: a param the method DECLARES as an object/array/matrix is parsed with no flag at all, and the parsed shape is checked against the declaration too, so reach for _rawJson when you cannot scope the position, not as a general-purpose parse. If a value looks like JSON but cannot be parsed, and its position is declared an object/array/matrix, the call is refused by name (invalid_params) instead of being forwarded — nothing is silently ignored.',
            ),
          returnAs: z.any().optional().describe('Reserved: "inline" (default) or "path" — "path" writes a binary result to a session file and returns {ok, path, mime, width, height, bytes, filename?, url} as text, so a non-image export (e.g. a native .fp project) never crosses the wire as base64'),
          // REQ-1498 — declared on the dispatcher too, for the same
          // `buildInputShape` reason: undeclared keys are stripped before the
          // handler runs. `.describe()` AND `.meta()`, so `tools/list` actually
          // carries it (the SDK's zod→JSON-Schema conversion takes the META
          // description in preference to `.describe()` — REQ-1282 AC-5).
          _opsFile: z
            .any()
            .optional()
            .describe(`Reserved, for a method whose top-level payload is an array (e.g. layer.batch's ops). ${OPS_FILE_ADVICE}`)
            .meta({ description: `Reserved, for a method whose top-level payload is an array (e.g. layer.batch's ops). ${OPS_FILE_ADVICE}` }),
        }),
      },
      async (rawArgs) => {
        // REQ-1296 D4 (AC-3) — the compact half of the same rule, and the
        // half that matters most: `figpea_call` is the ONLY way to reach a
        // contract method in compact mode, so "no contract method accepts an
        // unrecognised param and returns ok:true" is false in the default mode
        // unless it is enforced here.
        //
        // FIRST, for the same reason and with the same trade-off as the
        // full-mode check in makeContractHandler: an unrecognised top-level
        // key is a defect in the call, true regardless of connection state, and
        // `COMPACT_RESERVED` is the whole surface here — there is no
        // `inputKeys` to union it with and no REQ-1017 exemption to make,
        // because the dispatcher's own `filePath` lives inside `args[0]`
        // (nested, and out of scope by this requirement's stated decision).
        const unknownTopLevelKeys = findUnknownTopLevelKeys(rawArgs as Record<string, unknown>, new Set<string>(COMPACT_RESERVED));
        if (unknownTopLevelKeys.length > 0) {
          return toCallToolResult(
            resultToContent({
              ok: false,
              code: 'invalid_params',
              message: renderUnknownParameterMessage('figpea_call', unknownTopLevelKeys, [...COMPACT_RESERVED]),
            }),
          );
        }
        if (!bridge.isTabConnected()) {
          const connectUrl = buildConnectUrl(undefined, undefined);
          return toCallToolResult(
            resultToContent({
              ok: false,
              code: 'no_tab',
              // REQ-1394 AC-4: the CAUSE arrives with the failure, so an agent
              // does not have to spend a second round trip on `status` to learn
              // that its token was stale. `ok`/`code`/`message`/`url` above are
              // byte-identical — this is additive, and their existing pins stay
              // untouched.
              connection: connectionDiagnosis(),
              message: 'No editor tab paired. Open this URL in your browser to connect an editor tab:',
              url: connectUrl,
            }),
          );
        }
        const group = (rawArgs as any).group;
        const method = (rawArgs as any).method;
        if (typeof group !== 'string' || typeof method !== 'string' || !group || !method) {
          return toCallToolResult(
            resultToContent({ ok: false, code: 'invalid_params', message: 'group and method are required strings' }),
          );
        }
        let args: unknown[] = (rawArgs as any).args as unknown[] | undefined ?? [];
        const rawJsonRequested = isRawJsonFlag((rawArgs as any)._rawJson);
        if (!Array.isArray(args)) {
          return toCallToolResult(
            resultToContent({
              ok: false,
              code: 'invalid_params',
              // AC-8: with the flag set, this is a path where the escape hatch
              // provably CANNOT apply, so it is named — a flag that is
              // silently dropped here is the defect this REQ exists to close.
              message: rawJsonRequested
                ? 'args must be an array — _rawJson parses each element of the positional args array, so it cannot apply when args is not one'
                : 'args must be an array',
            }),
          );
        }
        // REQ-1280 T3 STEP 1 — honour the flag, EARLY.
        //
        // It runs here, before the file-path translation below and before
        // `coerceValue`, because both read the value structurally:
        //  - `findArgShapeMismatch` fires on a plain OBJECT at an array/matrix
        //    position and lets a string through untouched, which is why
        //    today's failure reaches the editor at all;
        //  - the `session_openFile` / `layer_setImageFill` / `layer_create`
        //    blocks read `args[0]`/`args[1]` as `{filePath}`, so parsing after
        //    them would mean a stringified `{"filePath":"/tmp/x.png"}` never
        //    gets translated and the editor is handed a local path it cannot
        //    fetch. On this path the flag is the ONLY way a structured value
        //    can arrive, so it has to compose with the translation rather
        //    than shadow it.
        //
        // `schemaAt` is the REAL declared schema, which REQ-1318's hoist made
        // reachable here (the lookup above runs before this block). REQ-1338
        // is what put it to use: the flag skips a position the manifest declares
        // a `string`/`number`/`boolean`, so a JSON literal a caller meant as
        // TEXT is forwarded as the text it is. Before that, step 1 was
        // deliberately schema-blind (`schemaAt: () => undefined`) and the
        // comment here claimed the schema was unreachable until
        // `contractToolFor` below — which had been stale since the hoist, and
        // false about the design.
        //
        // `undefined` is still the flag's remaining purpose, and it is not an
        // accident of ordering: an unknown method, a compact-mode first call
        // before any `describe()`, a legacy free-text manifest or
        // `FIGPEA_DISABLE_CONTRACT_FETCH=1` all reach `applyRawJson` with no
        // schema, and there the flag PARSES. A flag that needed a manifest
        // would be dead on exactly the first-call situation an agent is most
        // likely to hit. With no schema, a failed parse is also NOT recorded
        // (the guard's safe default), so this step can only ever PARSE, never
        // refuse — the verdict is step 2, below.
        //
        // AC-6, structurally: `_rawJson` is read from `rawArgs` and never
        // merged into `args`, so it cannot reach the tab — there is no strip
        // statement to add here, and adding one would be a lie about a leak
        // that cannot happen.
        //
        // REQ-1318 — the LOOKUP is hoisted above the translation block because
        // the flag-LESS branch beside it needs the declared schema, and the
        // schema is the only thing that can make a parse safe to do by
        // default. Nothing else moved: `contractToolFor` is a memoised pure
        // lookup on `activeManifest` (contractIndex is rebuilt only when the
        // manifest identity changes), and the `if (contractTool)` block below
        // and every statement in it are exactly where they were. REQ-1338 then
        // gave the same hoisted lookup to the flag branch, which is why steps 1
        // and 2 cannot disagree about whether a position is a parse candidate.
        const contractTool = contractToolFor(group, method);
        if (rawJsonRequested) {
          args = applyRawJson(args, {
            schemaAt: (i) => contractTool?.paramSchemas?.[contractTool.inputKeys[i] ?? ''],
            pathAt: (i) => `args[${i}]`,
          }).value;
        } else if (contractTool) {
          // REQ-1318 — a structured parameter may travel as a JSON string,
          // with NO flag. Same placement as the flag's step 1, for the same
          // reason: before the file-path translation (a stringified
          // `{"filePath":…}` must be parsed before the blocks below read it
          // structurally), before `coerceValue` (so string numerics inside the
          // parsed object still become real numbers), and before the REQ-1296
          // arity check — provably harmless there, because `schemaAt(i)`
          // yields `undefined` past the declared arity, so no surplus argument
          // is ever parsed and the arity error still fires first.
          //
          // What it costs when no manifest is in memory: with nothing to say
          // the value SHOULD have been structured, the route takes no opinion
          // and the call forwards exactly as today (the published-npm
          // standalone case — and the flag's remaining reason to exist).
          args = applyStructuredStringJson(args, {
            schemaAt: (i) => contractTool.paramSchemas?.[contractTool.inputKeys[i] ?? ''],
            pathAt: (i) => `args[${i}]${contractTool.inputKeys[i] ? ` (${contractTool.inputKeys[i]})` : ''}`,
          }).value;
        }

        // Remove reserved keys so they never leak
        // args already extracted, now handle _timeoutMs
        const rawTimeout = (rawArgs as any)._timeoutMs;

        // File-path translation parity (reuse makeContractHandler logic for the three file methods)
        // Work on a mutable copy of args for translation
        const toolName = `${group}_${method}`;
        const toBridgeUrl = (filePath: string): string => {
          if (bridge.getFileUrl) return bridge.getFileUrl(filePath);
          return `http://${BRIDGE_URL_HOST}:${bridge.port}/file?path=${encodeURIComponent(filePath)}`;
        };
        const isValidFile = async (fp: string): Promise<boolean> => {
          try {
            const st = await fs.promises.stat(fp);
            return st.isFile();
          } catch {
            return false;
          }
        };

        // Clone args shallowly for mutation
        let effectiveArgs: unknown[] = [...args];

        /**
         * REQ-1444 (AC-1/AC-2) — THE PRE-FLIGHT, shared by the three sites
         * below that read a local `filePath` POSITIONALLY.
         *
         * The defect: an agent sends `describe()`'s named declaration
         * (`{input:{filePath}}`) instead of the contents, so the key sits one
         * level too deep for the translation on the very next line, nothing is
         * translated, and the bare local path is forwarded to the editor AS A
         * URL — which answers `open_fetch_failed: HTTP 404 Not Found` about a
         * file that exists, and fails identically on every retry.
         *
         * Why one helper for three sites rather than one per method: the
         * translation is implemented at exactly three places here, an envelope
         * defeats all three identically, and a rule keyed on a method name
         * would be the drift generator this module's every other rule is
         * written to avoid — while leaving two reachable copies of the exact
         * defect. Detection is derived from the manifest by `argShape.ts`; the
         * ONE thing that is not derivable is which code a missing file should
         * answer with, and that is this site's own business, so it is passed in
         * and used exactly as the sibling branch below already uses it.
         *
         * ⛔ THE PEEK IS DIAGNOSTIC ONLY. Nothing is unwrapped and nothing is
         * forwarded differently: the unwrapped call is refused either way, so
         * this never becomes a second accepted spelling of anything. That is
         * what makes it safe to check for the missing-file case at all.
         */
        const refuseFilePathEnvelope = async (missingCode: string): Promise<CallToolResult | undefined> => {
          if (!contractTool) return undefined;
          const mismatch = findFilePathEnvelopeMismatch(
            contractTool.paramSchemas,
            effectiveArgs,
            (name) => `args[${contractTool.inputKeys.indexOf(name)}]`,
            effectiveArgs.length,
          );
          if (typeof mismatch?.offendingValue !== 'string') return undefined;
          // A file that is not there is not there whatever shape it arrived in,
          // and reshaping the argument will not conjure it — so the answer is
          // the missing-file answer, naming the path the caller actually sent.
          if (!(await isValidFile(mismatch.offendingValue))) {
            return toCallToolResult(
              resultToContent({ ok: false, code: missingCode, message: `file not found or not readable: ${mismatch.offendingValue}` }),
            );
          }
          return toCallToolResult(
            resultToContent({
              ok: false,
              code: 'invalid_params',
              message: refusalMessage(toolName, group, method, mismatch, expectedArgsExample(contractTool)),
            }),
          );
        };

        /**
         * REQ-1498 (AC-6/AC-7) — the SINGULAR wrong-shape family, run beside
         * the envelope rule above and at the same three call sites, because a
         * bare path and a wrapped path are the same mistake told two ways.
         *
         * The measured pre-fix behaviour (REQ-1498's T3 red run): every
         * pre-flight DECLINED the bare string, it was forwarded verbatim, and
         * the `ok:true` was the TAB's answer relayed back. So this is not a
         * repair of a relay that swallowed the editor's own refusal — it is a
         * refusal that costs ZERO round trips and holds against ANY paired
         * editor build, including one that answers `ok:true` to a path.
         *
         * The missing-file arm reuses this site's own code and wording, for
         * the reason `refuseFilePathEnvelope` does: a file that is not there is
         * not there whatever shape it arrived in, and reshaping the argument
         * will not conjure it.
         */
        const refuseBareFilePath = async (missingCode: string): Promise<CallToolResult | undefined> => {
          if (!contractTool) return undefined;
          const mismatch = findSingularFilePathMismatch(
            contractTool.paramSchemas,
            (name) => effectiveArgs[contractTool.inputKeys.indexOf(name)],
            (name) => `args[${contractTool.inputKeys.indexOf(name)}]`,
          );
          if (typeof mismatch?.offendingValue !== 'string') return undefined;
          if (!(await isValidFile(mismatch.offendingValue))) {
            return toCallToolResult(
              resultToContent({ ok: false, code: missingCode, message: `file not found or not readable: ${mismatch.offendingValue}` }),
            );
          }
          return toCallToolResult(
            resultToContent({
              ok: false,
              code: 'invalid_params',
              message: refusalMessage(toolName, group, method, mismatch, expectedArgsExample(contractTool)),
            }),
          );
        };

        /**
         * The two wrong-shape rules in ONE call, so the three sites below stay
         * three lines and an agent that trips either reads the same refusal
         * grammar (`refusalMessage`) rather than two.
         */
        const refuseFilePathShapes = async (missingCode: string): Promise<CallToolResult | undefined> => {
          const enveloped = await refuseFilePathEnvelope(missingCode);
          if (enveloped) return enveloped;
          return refuseBareFilePath(missingCode);
        };

        // REQ-1498 — the payload-from-file route, COMPACT lane's half. FIRST in
        // this pre-flight region and before the `layer_batch` translation loop
        // below, so a payload that arrives from disk gets the same `filePath`
        // handling an inline one does — and before any round trip, so every
        // refusal here costs zero.
        //
        // Read from `rawArgs`, never merged into `args`: there is no strip
        // statement for it because the tab receives only `effectiveArgs`, and
        // `effectiveArgs` is already a copy (`let effectiveArgs = [...args]`),
        // so substituting into it cannot mutate the caller's own array.
        //
        // ⚠️ The slot is the manifest's, never a literal: see `opsFileSlotIndex`
        // (code-review round 1). Both the ambiguity judgement AND the write go
        // through it, so a method whose payload is not first is neither refused
        // nor has its other arguments dropped.
        const compactArrayParam = topLevelArrayParamName(contractTool?.paramSchemas);
        const compactArraySlot = opsFileSlotIndex(contractTool, compactArrayParam);
        if ((rawArgs as any)._opsFile !== undefined) {
          if (!compactArrayParam || compactArraySlot === undefined) {
            return toCallToolResult(resultToContent(opsFileNoArrayParamRefusal('_opsFile')));
          }
          if (opsFileSlotOccupied(effectiveArgs[compactArraySlot])) {
            return toCallToolResult(resultToContent(opsFileAmbiguityRefusal('_opsFile', compactArrayParam)));
          }
          const fromFile = await readArrayPayloadFromFile(
            (rawArgs as any)._opsFile,
            '_opsFile',
            compactArrayParam,
            contractTool?.paramSchemas?.[compactArrayParam],
          );
          if (!fromFile.ok) {
            return toCallToolResult(resultToContent({ ok: false, code: fromFile.code, message: fromFile.message }));
          }
          // INTO the slot, never over the array: the parameters on either side
          // of it are the caller's own and are none of this option's business.
          effectiveArgs[compactArraySlot] = fromFile.value;
        }

        if (toolName === 'session_openFile') {
          // FIRST in the branch, before `input.filePath` is read below, so the
          // refusal lands before any fetch and before any bridge round trip.
          const envelopeRefusal = await refuseFilePathShapes('open_failed');
          if (envelopeRefusal) return envelopeRefusal;
          // args[0] is expected to be input object {filePath?, url?, ...}
          const input = effectiveArgs[0] as Record<string, unknown> | undefined;
          const filePathVal = (input as any)?.filePath as string | undefined;
          if (typeof filePathVal === 'string' && filePathVal) {
            const okFile = await isValidFile(filePathVal);
            if (!okFile) {
              return toCallToolResult(resultToContent({ ok: false, code: 'open_failed', message: `file not found or not readable: ${filePathVal}` }));
            }
            const bridgeUrl = toBridgeUrl(filePathVal);
            const newInput: Record<string, unknown> = { ...(input ?? {}) };
            newInput.url = bridgeUrl;
            // REQ-1283: the basename default alone dropped the extension whenever
            // the caller supplied `name` — the documented alias for `fileName` —
            // and the editor, which selects a decoder from the name it is given,
            // reported a valid `.fp` as corrupt. `fileName` is set (not `name`)
            // because v3 reads `fileName ?? name`.
            const resolvedName = resolveOpenFileName({ filePath: filePathVal, fileName: newInput.fileName, name: (newInput as any).name });
            if (resolvedName !== undefined) newInput.fileName = resolvedName;
            delete (newInput as any).filePath;
            effectiveArgs[0] = newInput;
          } else if (typeof filePathVal === 'string' && filePathVal.trim() === '') {
            return toCallToolResult(resultToContent({ ok: false, code: 'open_failed', message: 'filePath cannot be empty' }));
          } else if (input !== null && typeof input === 'object' && 'filePath' in input && (input as any).filePath !== undefined && typeof (input as any).filePath !== 'string') {
            return toCallToolResult(resultToContent({ ok: false, code: 'open_failed', message: 'input.filePath must be a string' }));
          }
        } else if (toolName === 'layer_setImageFill') {
          // Same envelope, same defect, this site's own missing-file code.
          const envelopeRefusal = await refuseFilePathShapes('invalid_image_source');
          if (envelopeRefusal) return envelopeRefusal;
          const source = effectiveArgs[0] as Record<string, unknown> | undefined;
          // Actually layer_setImageFill signature is (id, source) — source is args[1] if id is args[0]
          // Handle both single-arg and two-arg forms defensively: look for any arg that looks like {filePath}
          let sourceIdx = -1;
          let sourceObj: Record<string, unknown> | undefined;
          for (let i = 0; i < effectiveArgs.length; i++) {
            const cand = effectiveArgs[i] as Record<string, unknown> | undefined;
            if (cand && typeof cand === 'object' && 'filePath' in cand) {
              sourceIdx = i;
              sourceObj = cand;
              break;
            }
          }
          if (sourceObj) {
            const fp = sourceObj.filePath as string | undefined;
            if (typeof fp === 'string' && fp) {
              const okFile = await isValidFile(fp);
              if (!okFile) {
                return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: `file not found or not readable: ${fp}` }));
              }
              const bridgeUrl = toBridgeUrl(fp);
              const newSource: Record<string, unknown> = { ...sourceObj };
              newSource.url = bridgeUrl;
              delete (newSource as any).filePath;
              effectiveArgs[sourceIdx] = newSource;
            } else if (fp !== undefined && typeof fp !== 'string') {
              return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'source.filePath must be a string' }));
            }
          }
        } else if (toolName === 'layer_create') {
          // Third and last site. `layer_batch` is deliberately NOT covered: an
          // op's `filePath` lives inside an array at `args[0][i].args[1]`, so
          // catching it means resolving each op's own method against the
          // manifest — real work, no acceptance criterion asks for it, and the
          // same KNOWN RESIDUAL `argShape.ts` records. Recorded so the gap does
          // not read as an oversight.
          const envelopeRefusal = await refuseFilePathShapes('invalid_image_source');
          if (envelopeRefusal) return envelopeRefusal;
          // args: [kind, props] — props may contain filePath when kind==='image'
          const kindVal = effectiveArgs[0] as string | undefined;
          const props = effectiveArgs[1] as Record<string, unknown> | undefined;
          const fp = props?.filePath as string | undefined;
          if (kindVal === 'image' && typeof fp === 'string' && fp) {
            const okFile = await isValidFile(fp);
            if (!okFile) {
              return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: `file not found or not readable: ${fp}` }));
            }
            const bridgeUrl = toBridgeUrl(fp);
            const newProps: Record<string, unknown> = { ...props };
            newProps.url = bridgeUrl;
            delete (newProps as any).filePath;
            effectiveArgs[1] = newProps;
          } else if (kindVal === 'image' && props !== null && typeof props === 'object' && 'filePath' in props && (props as any).filePath !== undefined && typeof (props as any).filePath !== 'string') {
            return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'props.filePath must be a string' }));
          }
        } else if (toolName === 'layer_batch') {
          // /design run 2026-10-01-kiln-spring-workshops-d3. `layer.batch`'s
          // `ops` is `args[0]`, and per the editor's own descriptor each op's
          // `args` is "the same array the direct figpea_layer_<method> call
          // would take" — so an op's image `filePath` lives at
          // `args[0][i].args[1].filePath`, which NO branch above reads. It was
          // forwarded verbatim, the editor's image loader treated the absolute
          // filesystem path as a URL, and the fetch failed with a 404 that
          // quoted the path — so the obvious reading was "the file is missing"
          // for a file the bridge had just served. Since `batch` is
          // all-or-nothing, ONE untranslated op rolled back a complete
          // 12-layer build.
          //
          // Scoped to this ONE method on purpose: the op shape is read
          // positionally (`method`, then `args[0]` the kind, then `args[1]` the
          // props) rather than by walking for any key named `filePath`, because
          // a blanket deep rewrite would also mangle values that legitimately
          // carry that key as ordinary data — a `setName` op whose name is the
          // string "filePath", or a non-image create's props.
          //
          // Every outcome below is the sibling `layer_create` branch's own, and
          // the refusals RETURN EARLY for the same reason it does: a batch is
          // all-or-nothing, so forwarding half a translated batch would trade
          // one all-or-nothing failure for another. The wording is asserted
          // against the sibling's live answer in
          // src/designfixBatchFilePath.test.ts, so the two cannot drift.
          const ops = effectiveArgs[0];
          if (Array.isArray(ops)) {
            let rewritten: unknown[] | undefined;
            for (let i = 0; i < ops.length; i++) {
              const op = ops[i];
              // `in` REJECTS a primitive, so the object guard is load-bearing
              // — an ops array holding a bare string must not throw here.
              if (op === null || typeof op !== 'object' || Array.isArray(op)) continue;
              const opRecord = op as Record<string, unknown>;
              if (opRecord.method !== 'create') continue;
              const opArgs = opRecord.args;
              if (!Array.isArray(opArgs) || opArgs[0] !== 'image') continue;
              const opProps = opArgs[1];
              if (opProps === null || typeof opProps !== 'object' || Array.isArray(opProps)) continue;
              const opPropsRecord = opProps as Record<string, unknown>;
              const opFp = opPropsRecord.filePath;
              if (typeof opFp === 'string' && opFp) {
                const okOpFile = await isValidFile(opFp);
                if (!okOpFile) {
                  return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: `file not found or not readable: ${opFp}` }));
                }
                const newOpProps: Record<string, unknown> = { ...opPropsRecord };
                newOpProps.url = toBridgeUrl(opFp);
                delete newOpProps.filePath;
                // Copy-on-write, once: the first rewritten op snapshots the
                // array, and every op — rewritten or not — is then edited on the
                // snapshot, so a caller's own array is never mutated.
                if (!rewritten) rewritten = ops.slice();
                const newOpArgs = [...opArgs];
                newOpArgs[1] = newOpProps;
                rewritten[i] = { ...opRecord, args: newOpArgs };
              } else if (opFp !== undefined && typeof opFp !== 'string') {
                // Parity with the sibling's non-string refusal. An EMPTY string
                // is deliberately NOT refused: `layer_create`'s guard is
                // `typeof fp !== 'string'`, so it forwards one unchanged, and
                // inventing a rejection here would be precisely the drift the
                // shared wording exists to prevent.
                return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'props.filePath must be a string' }));
              }
            }
            if (rewritten) effectiveArgs[0] = rewritten;
          }
        }

        const effectiveTimeoutMs = resolveTimeoutMs(toolName, rawTimeout);
        // REQ-1268 T4 (AC-3) — parity pass, applied AFTER the file-path
        // translation above (so a translated bridge URL is never re-coerced)
        // and BEFORE the round trip (so a coercion problem costs no bridge
        // call). Same `coerceValue`, same positional mapping as full mode.
        if (contractTool) {
          // REQ-1296 D4 (AC-3) — the SURPLUS POSITIONAL argument, the second
          // spelling of the very same defect and the one the loop below used
          // to walk straight past. The pre-flight `break`s the instant
          // `inputKeys[i]` is undefined, so everything past the declared arity
          // went unvalidated AND unmentioned: the handler forwards
          // `effectiveArgs` whole, the tab's own parameter list simply ends
          // first, and the agent gets `ok:true` for an argument that was never
          // read. An agent that miscounts `canvas.screenshot`'s single
          // `options` parameter is asking for a second capture and silently
          // getting the first.
          //
          // Guarded on `contractTool` being defined, deliberately: an unknown
          // METHOD is the tab's error to name (as today), because this server
          // has no `inputKeys` to compare an arity against, and guessing one
          // would report a surplus argument for a call that is wrong in a more
          // fundamental way.
          if (effectiveArgs.length > contractTool.inputKeys.length) {
            const surplusIndex = contractTool.inputKeys.length;
            const arity = contractTool.inputKeys.length;
            const expectedArgs = expectedArgsExample(contractTool);
            return toCallToolResult(
              resultToContent({
                ok: false,
                code: 'invalid_params',
                message:
                  `${toolName}: args[${surplusIndex}] has no matching parameter — ${toolName} takes ${arity} positional argument${arity === 1 ? '' : 's'}: [${expectedArgs}]. ` +
                  `Expected ${toolName} args: [${expectedArgs}]. ` +
                  `Learn the exact shape first: figpea_describe({group:"${group}", method:"${method}"}).`,
              }),
            );
          }
          // REQ-1280 T3 STEP 2 — the VERDICT, late, where the declared schema
          // finally is reachable. Same `applyRawJson` as step 1 and full mode,
          // and since REQ-1338 the same `schemaAt` too, so this is a cheap
          // no-op on the array: every value step 1 was allowed to parse is
          // already parsed, and every position step 1 skipped is skipped again
          // here for the same reason. What this re-run supplies is the schema
          // the verdict needs: a value that looks like JSON but does not parse
          // is refused by name ONLY where the schema proves a structured value
          // was intended (AC-8) — which is exactly where the tab would have
          // rejected it after a wasted round trip. The scalar half of the rule
          // is now shared with step 1, so a declared `string` is provably never
          // parsed on either.
          //
          // Rebase note: this now runs AFTER the REQ-1296 arity check above,
          // and the order is deliberate rather than incidental. An arity error
          // is the more fundamental finding — it names a position that does
          // not exist, so every per-value complaint about that position is
          // downstream of it. REQ-1280's own guard is safe either way
          // (`inputKeys[i]` is `undefined` past the declared arity, so
          // `schemaAt` yields no schema and no failure is recorded), so this
          // is about which error an agent reads first, not about correctness.
          if (rawJsonRequested) {
            const verdict = applyRawJson(effectiveArgs, {
              schemaAt: (i) => contractTool.paramSchemas?.[contractTool.inputKeys[i] ?? ''],
              pathAt: (i) => `args[${i}]${contractTool.inputKeys[i] ? ` (${contractTool.inputKeys[i]})` : ''}`,
            });
            const failure = verdict.structuredFailures[0];
            if (failure) {
              return toCallToolResult(
                resultToContent({ ok: false, code: 'invalid_params', message: rawJsonFailureMessage(toolName, failure.path, failure.raw) }),
              );
            }
          }
          effectiveArgs = effectiveArgs.map((value, i) =>
            coerceValue(value, contractTool.paramSchemas?.[contractTool.inputKeys[i]]),
          );
          // REQ-1295 T3 — the DECLARED-WRAPPER pre-flight, immediately after
          // coercion and BEFORE both the shape loop and the per-kind rule. That
          // order is load-bearing, not stylistic: `layer.create`'s `props`
          // carries a `byKind`, so a wrapped `props` would otherwise be answered
          // by REQ-1309's rule as `invalid_transform` naming the wrapper key as
          // an INAPPLICABLE PROP — a second, equally misleading message about
          // the one mistake, one rule earlier than the right one.
          //
          // `positionalLength` is `effectiveArgs.length`, the very array the tab
          // is about to receive, so "the editor cannot expand this" is a proof
          // rather than a heuristic (see the rule for the narrowing).
          const wrapperMismatch = findDeclaredWrapperMismatch(
            contractTool.paramSchemas,
            positionalValues(contractTool.inputKeys, effectiveArgs),
            (name) => `args[${contractTool.inputKeys.indexOf(name)}]`,
            effectiveArgs.length,
          );
          if (wrapperMismatch) {
            return toCallToolResult(
              resultToContent({
                ok: false,
                code: wrapperMismatch.code ?? 'invalid_params',
                message: refusalMessage(toolName, group, method, wrapperMismatch, expectedArgsExample(contractTool)),
              }),
            );
          }
          // REQ-1268 T5 (AC-5) — shape pre-flight, AFTER coercion and BEFORE
          // the round trip, so a mangled payload costs zero bridge calls. The
          // message has to be actionable on its own: it names the offending
          // path, renders the expected positional shape for THIS method, and
          // points at the one call that teaches it.
          for (let i = 0; i < effectiveArgs.length; i++) {
            const key = contractTool.inputKeys[i];
            if (key === undefined) break;
            const mismatch = findArgShapeMismatch(effectiveArgs[i], contractTool.paramSchemas?.[key], `args[${i}]`);
            if (!mismatch) continue;
            return toCallToolResult(
              resultToContent({
                ok: false,
                code: mismatch.code ?? 'invalid_params',
                message: refusalMessage(toolName, group, method, mismatch, expectedArgsExample(contractTool)),
              }),
            );
          }
          // REQ-1309 T4 — the PER-KIND prop rule, same placement as the wire
          // shape above (after the filePath translation, after the `_rawJson`
          // verdict, after coercion, before the round trip) and calling the
          // SAME message wrapper, so an agent that trips either pre-flight
          // reads one sentence grammar. It carries its own code — the editor's
          // `invalid_transform`, relayed rather than invented — which is why
          // the wrapper reads `mismatch.code ?? 'invalid_params'` instead of
          // hardcoding one code for two rules.
          //
          // `values` is keyed by param name and built from the COERCED array,
          // which is what makes the verdict the tab's own: `coerceValue` never
          // rebuilds an object from schema keys, so the post-coercion props
          // are byte-for-byte the object the tab would have been handed.
          const kindValues: Record<string, unknown> = {};
          for (let i = 0; i < contractTool.inputKeys.length; i++) {
            const key = contractTool.inputKeys[i];
            if (key !== undefined) kindValues[key] = effectiveArgs[i];
          }
          const kindMismatch = findKindPropMismatch(
            contractTool.paramSchemas,
            kindValues,
            (name) => `args[${contractTool.inputKeys.indexOf(name)}]`,
          );
          if (kindMismatch) {
            return toCallToolResult(
              resultToContent({
                ok: false,
                code: kindMismatch.code ?? 'invalid_params',
                message: refusalMessage(toolName, group, method, kindMismatch, expectedArgsExample(contractTool)),
              }),
            );
          }
        }
        try {
          // REQ-1020 — reserved `returnAs` (plan D1/D2): validated fail-loud
          // like the full-mode handler above; top-level so never forwarded.
          const resolvedReturnAs = resolveReturnAs((rawArgs as any).returnAs);
          if ('error' in resolvedReturnAs) {
            return toCallToolResult(resultToContent(resolvedReturnAs.error));
          }
          const result = (await bridge.callTab(group, method, effectiveArgs, effectiveTimeoutMs)) as FigpeaCallResultLike;
          // REQ-1295 T4 / REQ-1444 T4 (AC-5) — ALL FOUR relay-side halves, in
          // ONE pass, so the agent sees one appended sentence rather than two
          // appended sentences. `appendNestedStringHint` runs FIRST because its
          // sentence carries its own `figpea_describe` clause, which makes
          // `appendShapeHint` decline — and `appendCreatePropHint` sits inside
          // `appendWrapperHint` because the two are exclusive by the offending
          // key: a declared parameter name is REQ-1295's lesson and must win.
          // Every one of them appends only; none rewrites a code or a message.
          const relayedValues = contractTool ? positionalValues(contractTool.inputKeys, effectiveArgs) : undefined;
          const composed = appendShapeHint(
            appendWrapperHint(
              appendCreatePropHint(
                appendNestedStringHint(result, group, method, contractTool, effectiveArgs),
                `${group}`,
                `${method}`,
                contractTool,
                createPropsSchemas(),
                relayedValues,
              ),
              new Set(contractTool?.inputKeys ?? []),
              relayedValues,
            ),
            `${group}`,
            `${method}`,
          );
          return toCallToolResult(
            resultToContent(
              composed,
              returnAsOpts(bridge, toolName, resolvedReturnAs.mode),
            ),
          );
        } catch (e) {
          return toCallToolResult(
            resultToContent({ ok: false, code: 'bridge_error', message: e instanceof Error ? e.message : String(e) }),
          );
        }
      },
    );
  }

  /** Coerces a string numeric value to a real number when the declared schema expects a number.
   *  Handles "1000" and "1000.0" (and other finite numeric strings) that LLMs or JSON-literal UIs
   *  may produce as strings despite the schema saying number. Leaves non-numeric strings untouched. */
  function coerceNumericString(value: unknown, schema: { type: string } | undefined): unknown {
    if (schema?.type === 'number' && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '') {
        const num = Number(trimmed);
        if (Number.isFinite(num) && String(num) === trimmed) {
          return num;
        }
        // Accept "1000.0" -> 1000, "  1000  " -> 1000, scientific, etc., where Number parses finite but String(num) may differ
        // Use a looser check: if Number is finite and the trimmed string is a valid number literal, coerce
        if (Number.isFinite(num) && !isNaN(num) && /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) {
          return num;
        }
      }
    }
    return value;
  }

  function coerceValue(value: unknown, schema: import('./tools').ParamSchemaLike | undefined): unknown {
    if (value === null || value === undefined) return value;
    if (!schema) {
      // No schema (legacy free-text manifest): still try generic numeric coercion for objects
      if (typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const GENERIC_NUMERIC_KEYS = new Set([
          'pageWidth', 'pageHeight', 'rwidth', 'rheight', 'rx', 'ry', 'x2', 'y2', 'x', 'y', 'width', 'height', 'dx', 'dy', 'deg', 'index', 'itemSpacing', 'top', 'right', 'bottom', 'left',
          'count', 'radius', 'startAngle', 'stepAngle', 'rows', 'cols', 'gap', 'spacing',
          'tolerance', 'fontSize', 'letterSpacing', 'lineHeight', 'opacity', 'cornerRadius', 'strokeWidth', 'fixWidth', 'fixHeight',
        ]);
        let result: Record<string, unknown> | undefined;
        for (const [k, v] of Object.entries(obj)) {
          if (GENERIC_NUMERIC_KEYS.has(k) && typeof v === 'string') {
            const coerced = coerceNumericString(v, { type: 'number' });
            if (coerced !== v) {
              if (!result) result = { ...obj };
              result[k] = coerced;
            }
          } else if (typeof v === 'object' && v !== null) {
            // Recurse for nested objects/arrays without schema — covers batch args deep nests
            const coerced = coerceValue(v, undefined);
            if (coerced !== v) {
              if (!result) result = { ...obj };
              result[k] = coerced;
            }
          } else if (Array.isArray(v)) {
            const coerced = coerceValue(v, undefined);
            if (coerced !== v) {
              if (!result) result = { ...obj };
              result[k] = coerced;
            }
          }
        }
        return result ?? value;
      }
      if (Array.isArray(value)) {
        let changed = false;
        const coercedArr = (value as unknown[]).map((el) => {
          const c = coerceValue(el, undefined);
          if (c !== el) changed = true;
          return c;
        });
        return changed ? coercedArr : value;
      }
      return value;
    }
    // Direct number coercion
    if (schema.type === 'number') {
      return coerceNumericString(value, schema);
    }
    // Object with shape/byKind: walk its properties
    if (schema.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      let result: Record<string, unknown> | undefined;
      const ensureResult = () => {
        if (!result) result = { ...obj };
        return result;
      };
      if (schema.shape) {
        for (const [k, sub] of Object.entries(schema.shape)) {
          if (k in obj) {
            const coerced = coerceValue(obj[k], sub);
            if (coerced !== obj[k]) ensureResult()[k] = coerced;
            // Also handle nested array case via recursive call (sub may be array)
          }
        }
      }
      if (schema.byKind) {
        // Union of all byKind fields for coercion (kind-agnostic, safe: numeric strings for pageWidth etc.)
        const byKindUnion: Record<string, import('./tools').ParamSchemaLike> = {};
        for (const kindFields of Object.values(schema.byKind)) {
          for (const [fk, fv] of Object.entries(kindFields)) {
            if (!(fk in byKindUnion)) byKindUnion[fk] = fv;
          }
        }
        for (const [k, sub] of Object.entries(byKindUnion)) {
          if (k in obj && !(schema.shape && k in schema.shape)) {
            const coerced = coerceValue(obj[k], sub);
            if (coerced !== obj[k]) ensureResult()[k] = coerced;
          }
        }
      }
      // For generic object without detailed shape, still try to coerce known numeric geometry keys as fallback
      // This handles legacy manifests where shape wasn't captured
      if (!schema.shape && !schema.byKind) {
        const GENERIC_NUMERIC_KEYS = new Set([
          'pageWidth',
          'pageHeight',
          'rwidth',
          'rheight',
          'rx',
          'ry',
          'x2',
          'y2',
          'x',
          'y',
          'width',
          'height',
          'rwidth',
          'rheight',
          'dx',
          'dy',
          'deg',
          'index',
          'itemSpacing',
          'top',
          'right',
          'bottom',
          'left',
        ]);
        for (const [k, v] of Object.entries(obj)) {
          if (GENERIC_NUMERIC_KEYS.has(k) && typeof v === 'string') {
            const coerced = coerceNumericString(v, { type: 'number' });
            if (coerced !== v) ensureResult()[k] = coerced;
          } else if (typeof v === 'object' && v !== null) {
            const coerced = coerceValue(v, undefined);
            if (coerced !== v) ensureResult()[k] = coerced;
          }
        }
      } else {
        // REQ-1037 T2 — schema-aware object but may contain schema-opaque nests
        // (e.g. layer_batch.ops[0].args[1] = {rwidth:"100"} where args is array without of).
        // Walk remaining keys not covered by shape/byKind via generic deep walk.
        const declaredKeys = new Set<string>();
        if (schema.shape) for (const k of Object.keys(schema.shape)) declaredKeys.add(k);
        if (schema.byKind) for (const kindFields of Object.values(schema.byKind)) for (const k of Object.keys(kindFields)) declaredKeys.add(k);
        for (const [k, v] of Object.entries(obj)) {
          if (declaredKeys.has(k)) continue;
          if (typeof v === 'object' && v !== null) {
            const coerced = coerceValue(v, undefined);
            if (coerced !== v) ensureResult()[k] = coerced;
          } else if (Array.isArray(v)) {
            const coerced = coerceValue(v, undefined);
            if (coerced !== v) ensureResult()[k] = coerced;
          }
        }
        // Also deep-walk already-handled array-typed fields that had no `of` schema
        // (e.g. ops[].args). Those were not recursed above because no `of`.
        if (schema.shape) {
          for (const [k, sub] of Object.entries(schema.shape)) {
            if (sub.type === 'array' && !sub.of && Array.isArray((obj as any)[k])) {
              const arrVal = (obj as any)[k] as unknown[];
              const coercedArr = coerceValue(arrVal, undefined);
              if (coercedArr !== arrVal) ensureResult()[k] = coercedArr as any;
            }
          }
        }
      }
      // Handle nested shape's array/of recursively via already-handled sub schemas
      // For props.style etc., leave as is
      return result ?? value;
    }
    if (schema.type === 'array' && Array.isArray(value) && schema.of) {
      let changed = false;
      const arr = value as unknown[];
      const coercedArr = arr.map((el) => {
        const c = coerceValue(el, schema.of!);
        if (c !== el) changed = true;
        return c;
      });
      return changed ? coercedArr : value;
    }
    if (schema.type === 'array' && Array.isArray(value) && !schema.of) {
      // REQ-1037 T2 — array without item schema (e.g. batch args): deep generic walk
      let changed = false;
      const coercedArr = (value as unknown[]).map((el) => {
        const c = coerceValue(el, undefined);
        if (c !== el) changed = true;
        return c;
      });
      return changed ? coercedArr : value;
    }
    // For matrix (array of numbers) where elements may be string numbers
    if (schema.type === 'matrix' && Array.isArray(value)) {
      let changed = false;
      const coerced = (value as unknown[]).map((el) => {
        if (typeof el === 'string') {
          const c = coerceNumericString(el, { type: 'number' });
          if (c !== el) changed = true;
          return c;
        }
        return el;
      });
      return changed ? coerced : value;
    }
    return value;
  }

  function makeContractHandler(groupName: string, methodName: string, inputKeys: string[], tool?: GeneratedTool) {
    return async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
      // REQ-1296 D3 (AC-1/AC-3) — "did I understand every key I was given?",
      // asked FIRST, before anything consumes the payload and before any
      // bridge round trip. Reachable only because `buildInputShape` now keeps
      // undeclared keys (REQ-1296 D1); before that the evidence was gone by
      // the time this ran, which is the whole reason the defect was possible.
      //
      // It deliberately precedes the `no_tab` gate below. An unrecognised key
      // is a defect in the call itself, true regardless of connection state,
      // and naming it is deterministic — whereas `no_tab` sends the agent off
      // to pair a tab for a call that was malformed to begin with. Both
      // orders satisfy AC-3 (it asks that a bad key never answer `ok:true`,
      // not which of two errors wins); this one never makes an agent pay for
      // a pairing round trip against a call it has to rewrite anyway.
      //
      // The allowed set is `inputKeys` ∪ the reserved keys, PLUS a top-level
      // `filePath` for `session_openFile` alone — REQ-1017's compatibility
      // shim, which reads exactly that key at :1009 (a key the manifest does
      // not declare) and deletes it before relaying. It is the one tool with a
      // legitimate undeclared key, and excluding it would break a shipped
      // feature; it is the reason the exemption is named per tool rather than
      // folded into the reserved set.
      const toolNameForCheck = `${groupName}_${methodName}`;
      // REQ-1498 — `opsFile` joins `filePath` below as a DERIVED per-tool
      // allowance, for the same reason and the same reason it is NOT in
      // `FULL_MODE_RESERVED`: the key means something only where the manifest
      // declares a top-level array/matrix param, so advertising or accepting it
      // on a tool that has no such slot would be a knob that cannot work.
      const fullArrayParam = topLevelArrayParamName(tool?.paramSchemas);
      const allowedKeys = new Set<string>([...inputKeys, ...FULL_MODE_RESERVED]);
      if (toolNameForCheck === 'session_openFile') allowedKeys.add('filePath');
      if (fullArrayParam) allowedKeys.add('opsFile');
      const unknownKeys = findUnknownTopLevelKeys(rawArgs, allowedKeys);
      if (unknownKeys.length > 0) {
        const acceptedNames = [...inputKeys, ...FULL_MODE_RESERVED];
        if (fullArrayParam) acceptedNames.push('opsFile');
        return toCallToolResult(
          resultToContent({
            ok: false,
            code: 'invalid_params',
            message: renderUnknownParameterMessage(toolNameForCheck, unknownKeys, acceptedNames),
          }),
        );
      }

      if (!bridge.isTabConnected()) {
        const connectUrl = buildConnectUrl(undefined, undefined);
        return toCallToolResult(
          resultToContent({
            ok: false,
            code: 'no_tab',
            // REQ-1394 AC-4: the same block the compact `figpea_call` refusal
            // carries (mcpServer.ts:~851). Both refusal sites, because an agent
            // in either tool mode is on the same failure path.
            connection: connectionDiagnosis(),
            message: 'No editor tab paired. Open this URL in your browser to connect an editor tab:',
            url: connectUrl,
          }),
        );
      }

      // REQ-1017: filePath → bridge HTTP URL translation (reserved key, not in inputKeys)
      // This mirrors _timeoutMs's reserved-key pattern — we read rawArgs even when the
      // manifest's inputKeys don't declare filePath, so stale manifests still work.
      // We mutate a shallow copy of rawArgs for the translation so the original map
      // remains intact for logging, but inputKeys.map below sees the URLified value.
      const effectiveRawArgs: Record<string, unknown> = { ...rawArgs };

      // REQ-1337 T3 — the REQ-1037 `_rawJson` bypass + auto JSON-parse for
      // stringified objects/arrays (both branches, flag set and flag-less)
      // now runs HERE, ABOVE the `filePath`→bridge-URL translation below,
      // mirroring the compact lane's REQ-1280 D3 step 1 (:833-846) and for
      // exactly the reason recorded there: the `session_openFile` /
      // `layer_setImageFill` / `layer_create` blocks read `.input` /
      // `.source` / `.props` as `{filePath}`, so parsing after them meant a
      // stringified `{"filePath":"/tmp/x.png"}` was never translated and the
      // editor was handed a local path it cannot fetch — the same payload
      // with the opposite outcome per lane, which is the drift REQ-1280's
      // AC-7 exists to prevent. BOTH branches move, not just the flagged one:
      // the flag-less schema-scoped parse is what rescues an unflagged
      // stringified `filePath`, and moving only the flag branch would have
      // traded that divergence for its mirror image.
      //
      // It still runs BEFORE `coerceValue`, so a string numeric inside a
      // parsed object still becomes a real number, and before the REQ-1309
      // kind-prop check and the round trip.
      //
      // What still runs above it, and must: the unknown-top-level-key
      // rejection and the `no_tab` refusal are about the CALL rather than
      // about how its arguments are encoded. `toolName` is hoisted to here
      // because the refusal message below reads it, and it reads nothing else
      // between its old position and this one.
      const toolName = `${groupName}_${methodName}`;
      const rawJsonFlag = isRawJsonFlag((effectiveRawArgs as any)['_rawJson']);
      if (rawJsonFlag) {
        // REQ-1280 T2 — the flag's parse now lives in the ONE shared
        // implementation (rawJson.ts) that compact mode calls too, so the two
        // paths cannot drift (AC-7). `keys: inputKeys` is load-bearing: the
        // loop visits the DECLARED positions in order, which is what makes
        // `schemaAt`/`pathAt` line up, and it keeps the reserved keys
        // (`_rawJson`/`_timeoutMs`/`returnAs`) out of the parse — exactly the
        // key set the inline loop this replaced visited.
        //
        // A failed parse is now RECORDED, not swallowed, and the caller
        // refuses it below — but only where the declared schema expects a
        // structured value. That guard is the safety claim: at a
        // `string`/`number`/`boolean` position, or with no schema at all, a
        // JSON-looking string that does not parse is still forwarded verbatim
        // (the `setName(id, '[Hero]')` class), so no call that works today
        // changes. It also makes the failure LOUD and FREE: today such a value
        // is forwarded and the tab rejects it after a wasted round trip.
        //
        // REQ-1338 — this call site is unchanged and stays so: it already
        // passed the real declared schema, so the whole of full mode's half of
        // the fix lives inside the shared loop. There is deliberately no second
        // implementation to drift (that is AC-7's guarantee, and this REQ does
        // not weaken it).
        const applied = applyRawJson(effectiveRawArgs, {
          keys: inputKeys,
          schemaAt: (i) => tool?.paramSchemas?.[inputKeys[i] ?? ''],
          pathAt: (i) => inputKeys[i] ?? `arg[${i}]`,
        });
        for (const [key, value] of Object.entries(applied.value)) {
          (effectiveRawArgs as any)[key] = value;
        }
        const failure = applied.structuredFailures[0];
        if (failure) {
          return toCallToolResult(
            resultToContent({ ok: false, code: 'invalid_params', message: rawJsonFailureMessage(toolName, failure.path, failure.raw) }),
          );
        }
      } else {
        // REQ-1318 T2 — the flag-less parse was an inline re-implementation of
        // exactly the rule the shared module now owns, so it is REPLACED by a
        // call to that same function rather than left to drift. This is a
        // de-duplication, not a behaviour change: the inline loop's five guards
        // (declared structured, so schema present, so JSON-looking, so it
        // parses, so the shape matches) are the module's steps 1-3 one for one
        // in the same order, and its swallowed `catch` is the module's
        // `if (!parsed.ok) continue` — silent in both, because a failed parse
        // is left exactly as sent and the editor is what names it.
        //
        // `keys: inputKeys` is load-bearing for the same reason it is on the
        // flag branch above: the loop visits the DECLARED positions in order,
        // which is what makes `schemaAt`/`pathAt` line up, and it keeps the
        // reserved keys (`_rawJson`/`_timeoutMs`/`returnAs`) out of the parse.
        //
        // Position, scope and semantics are unchanged — but not the position's
        // ORDER: REQ-1337 moved this branch above the `filePath` translation
        // (see the note at the top of it), which closes the gap this comment
        // used to reserve by name. A stringified `filePath` in full mode is now
        // translated like it is on the compact lane, and the behaviour it
        // changes is only ever a value the editor would otherwise have
        // rejected with a local path it cannot fetch.
        const applied = applyStructuredStringJson(effectiveRawArgs, {
          keys: inputKeys,
          schemaAt: (i) => tool?.paramSchemas?.[inputKeys[i] ?? ''],
          pathAt: (i) => inputKeys[i] ?? `arg[${i}]`,
        });
        for (const [key, value] of Object.entries(applied.value)) {
          (effectiveRawArgs as any)[key] = value;
        }
      }
      // Remove reserved keys so they never leak into coercion or logging of effective args
      delete (effectiveRawArgs as any)['_rawJson'];

      // REQ-1017 helper to validate a local path and return bridge URL or error payload
      const toBridgeUrl = (filePath: string): string => {
        if (bridge.getFileUrl) return bridge.getFileUrl(filePath);
        return `http://${BRIDGE_URL_HOST}:${bridge.port}/file?path=${encodeURIComponent(filePath)}`;
      };
      const isValidFile = async (fp: string): Promise<boolean> => {
        try {
          const st = await fs.promises.stat(fp);
          return st.isFile();
        } catch {
          return false;
        }
      };

      // REQ-1498 — the payload-from-file route, FULL lane's half, and the twin of
      // the compact block above for REQ-1283's reason: this is a different
      // handler on a different tool surface, so wiring only the compact one
      // would fix the default calling convention and leave the one real MCP
      // clients use broken.
      //
      // Placed BEFORE the file-translation chain below, so a payload read from
      // disk is translated exactly like an inline one, and after the reserved
      // `_rawJson` strip, so the two reserved keys sit side by side.
      //
      // Only `inputKeys` are mapped into the positional array further down, so
      // substituting the declared param here can neither leak the path to the
      // tab nor reach a log line.
      if ((effectiveRawArgs as any)['opsFile'] !== undefined) {
        if (!fullArrayParam) {
          return toCallToolResult(resultToContent(opsFileNoArrayParamRefusal('opsFile')));
        }
        // REQ-1498 round 1 — the SAME predicate the compact lane uses, so a
        // `null` slot cannot mean "substitute" here and "refuse" there: the plan
        // requires identical behaviour in both lanes. Nothing ELSE about this
        // lane changed — it already keyed on the parameter's own NAME rather than
        // an index, which is why `setTransform`/`booleanOperate` worked here and
        // not in the compact lane.
        if (opsFileSlotOccupied((effectiveRawArgs as any)[fullArrayParam])) {
          return toCallToolResult(resultToContent(opsFileAmbiguityRefusal('opsFile', fullArrayParam)));
        }
        const fromFile = await readArrayPayloadFromFile(
          (effectiveRawArgs as any)['opsFile'],
          'opsFile',
          fullArrayParam,
          tool?.paramSchemas?.[fullArrayParam],
        );
        if (!fromFile.ok) {
          return toCallToolResult(resultToContent({ ok: false, code: fromFile.code, message: fromFile.message }));
        }
        (effectiveRawArgs as any)[fullArrayParam] = fromFile.value;
      }
      // Stripped whatever the outcome, matching `_rawJson` above, so the key can
      // never reach the coercion or the positional mapping.
      delete (effectiveRawArgs as any)['opsFile'];

      // REQ-1498 (AC-6/AC-7) — the SINGULAR wrong-shape rule, this lane's half.
      // Run beside the three file-translation branches below rather than inside
      // one of them, because it is DERIVED from the manifest rather than from a
      // method name: any tool whose declared object param has a `filePath` key
      // gets it, so there is no `if (toolName === …)` to hang it on. Placed
      // before all three, so the refusal lands before any fetch and before any
      // round trip.
      //
      // `pathFor` is the bare param name because that is how this lane names
      // things: the caller wrote `{input}`, not `args[0]`.
      const barePathRefusal = async (missingCode: string): Promise<CallToolResult | undefined> => {
        const mismatch = findSingularFilePathMismatch(
          tool?.paramSchemas,
          (name) => (effectiveRawArgs as any)[name],
          (name) => name,
        );
        if (typeof mismatch?.offendingValue !== 'string') return undefined;
        if (!(await isValidFile(mismatch.offendingValue))) {
          return toCallToolResult(
            resultToContent({ ok: false, code: missingCode, message: `file not found or not readable: ${mismatch.offendingValue}` }),
          );
        }
        return toCallToolResult(
          resultToContent({
            ok: false,
            code: 'invalid_params',
            message: refusalMessage(toolName, groupName, methodName, mismatch, expectedArgsExample(tool)),
          }),
        );
      };
      // This lane's own missing-file code per site, exactly as the branches
      // below use it — the code is the site's business, not the rule's.
      const barePathCode = toolNameForCheck === 'session_openFile' ? 'open_failed' : 'invalid_image_source';
      const barePathOutcome = await barePathRefusal(barePathCode);
      if (barePathOutcome) return barePathOutcome;

      if (toolName === 'session_openFile') {
        // input may be at rawArgs.input or rawArgs itself (some callers pass filePath top-level)
        const inputAny = (effectiveRawArgs as any).input as Record<string, unknown> | undefined;
        const filePathVal = (inputAny?.filePath as string | undefined) ?? (effectiveRawArgs as any).filePath as string | undefined;
        if (typeof filePathVal === 'string' && filePathVal) {
          if (typeof filePathVal !== 'string') {
            return toCallToolResult(resultToContent({ ok: false, code: 'open_failed', message: `filePath must be a string: ${String(filePathVal)}` }));
          }
          const okFile = await isValidFile(filePathVal);
          if (!okFile) {
            return toCallToolResult(resultToContent({ ok: false, code: 'open_failed', message: `file not found or not readable: ${filePathVal}` }));
          }
          const bridgeUrl = toBridgeUrl(filePathVal);
          // Build new input with url, preserve fileName/type/name if caller gave them
          const newInput: Record<string, unknown> = { ...(inputAny ?? {}) };
          newInput.url = bridgeUrl;
          // REQ-1283 — the same rule as the compact dispatcher above, and
          // deliberately a second call site rather than a shared branch: this
          // is full mode's generated `session_openFile` tool, a different
          // handler, and a one-site fix would leave the default (compact) path
          // broken or the non-default one broken, depending which was chosen.
          const resolvedName = resolveOpenFileName({ filePath: filePathVal, fileName: newInput.fileName, name: newInput.name });
          if (resolvedName !== undefined) newInput.fileName = resolvedName;
          delete (newInput as any).filePath;
          delete (effectiveRawArgs as any).filePath;
          effectiveRawArgs.input = newInput;
          // Ensure inputKeys includes 'input' mapping — already does, but if rawArgs had top-level filePath we cleared it
        } else if (typeof filePathVal === 'string' && filePathVal.trim() === '') {
          return toCallToolResult(resultToContent({ ok: false, code: 'open_failed', message: 'filePath cannot be empty' }));
        } else if ((effectiveRawArgs as any).filePath !== undefined && typeof (effectiveRawArgs as any).filePath !== 'string') {
          return toCallToolResult(resultToContent({ ok: false, code: 'open_failed', message: 'filePath must be a string' }));
        }
        // Also handle filePath inside input that is non-string
        //
        // REQ-1337 T2 — the `!== null && typeof … === 'object'` guard is the
        // compact twin's, verbatim and in the same textual order (`:936`).
        // `in` REJECTS a primitive, so the un-guarded `inputAny &&` threw
        // `TypeError: Cannot use 'in' operator …` straight out of this handler
        // — the only `try` on this lane wraps `callTab` — and reached the agent
        // as plain text with no `code` to branch on.
        //
        // ⛔ The guard is NOT dead code, and the parse now running above does
        // not make it so: a value that does not look like JSON, one that does
        // not parse, one whose parsed shape contradicts its declaration, and
        // every position on a manifest with no structured schema (a legacy
        // free-text `params` block, the published-npm "no describe() yet"
        // case) all reach this line as the string the caller sent. The
        // `src/req1337RawJsonFilePath.test.ts` rows for exactly those cases
        // fail if this guard is deleted.
        if (inputAny !== null && typeof inputAny === 'object' && 'filePath' in inputAny && inputAny.filePath !== undefined && typeof inputAny.filePath !== 'string') {
          return toCallToolResult(resultToContent({ ok: false, code: 'open_failed', message: 'input.filePath must be a string' }));
        }
      } else if (toolName === 'layer_setImageFill') {
        const source = (effectiveRawArgs as any).source as Record<string, unknown> | undefined;
        const fp = source?.filePath as string | undefined;
        if (typeof fp === 'string' && fp) {
          const okFile = await isValidFile(fp);
          if (!okFile) {
            return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: `file not found or not readable: ${fp}` }));
          }
          const bridgeUrl = toBridgeUrl(fp);
          const newSource: Record<string, unknown> = { ...source };
          newSource.url = bridgeUrl;
          delete (newSource as any).filePath;
          effectiveRawArgs.source = newSource;
        } else if (fp !== undefined && fp !== null && (typeof fp !== 'string' || (fp as string).trim() === '')) {
          // fp is present but invalid type/empty
          if (typeof fp !== 'string') {
            return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'source.filePath must be a string' }));
          }
        } else if (source !== null && typeof source === 'object' && 'filePath' in source && source.filePath !== undefined && typeof source.filePath !== 'string') {
          // REQ-1337 T2 — the `typeof … === 'object'` test is the compact
          // lane's, verbatim (`:947`, where the same lookup runs over the
          // positional args). ⛔ Load-bearing, not dead: a non-JSON-looking
          // string, an unparseable one, one whose parsed shape contradicts its
          // declaration, and any position on a schema-less legacy manifest all
          // reach this line as the string the caller sent — see the REQ-1337
          // rows in src/req1337RawJsonFilePath.test.ts, which fail without it.
          return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'source.filePath must be a string' }));
        }
      } else if (toolName === 'layer_create') {
        // rawArgs.kind is the kind string, rawArgs.props contains image props
        const kindVal = (effectiveRawArgs as any).kind;
        const props = (effectiveRawArgs as any).props as Record<string, unknown> | undefined;
        const fp = props?.filePath as string | undefined;
        if (kindVal === 'image' && typeof fp === 'string' && fp) {
          const okFile = await isValidFile(fp);
          if (!okFile) {
            return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: `file not found or not readable: ${fp}` }));
          }
          const bridgeUrl = toBridgeUrl(fp);
          const newProps: Record<string, unknown> = { ...props };
          newProps.url = bridgeUrl;
          delete (newProps as any).filePath;
          effectiveRawArgs.props = newProps;
        } else if (kindVal === 'image' && props !== null && typeof props === 'object' && 'filePath' in props && props.filePath !== undefined && typeof props.filePath !== 'string') {
          // REQ-1337 T2 — the compact lane's guard for this exact condition,
          // verbatim and in the same textual order (`:984`). ⛔ Load-bearing,
          // not dead: see the note at the `session_openFile` guard above — the
          // values that reach this line as a non-object are the ones the parse
          // deliberately leaves alone, and the REQ-1337 rows in
          // src/req1337RawJsonFilePath.test.ts fail without this.
          return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'props.filePath must be a string' }));
        } else if (kindVal === 'image' && typeof fp === 'string' && fp.trim() === '') {
          return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'filePath cannot be empty' }));
        }
      } else if (toolName === 'layer_batch') {
        // /design run 2026-10-01-kiln-spring-workshops-d3 — the full-mode twin
        // of the compact lane's `layer_batch` branch, and deliberately a second
        // call site rather than a shared one, for the reason REQ-1283 gave for
        // `session_openFile`: this is full mode's generated `layer_batch` tool,
        // a different handler, so wiring only the compact one would fix the
        // default calling convention and leave the one real MCP clients use
        // forwarding a local path to the editor — which fetches it as a URL,
        // fails, and (batch being all-or-nothing) rolls back the whole build.
        // Measured before this branch existed: the tab received
        // `[{"method":"create","args":["image",{"filePath":"/abs/plate.jpg"}]}]`.
        //
        // Same method, same positional op shape, same refusal wording as this
        // lane's `layer_create` above — including its extra EMPTY-string
        // refusal, which this lane has and the compact one does not. Both are
        // asserted against the live sibling in
        // src/designfixBatchFilePath.test.ts so neither pair can drift.
        const ops = (effectiveRawArgs as any).ops;
        if (Array.isArray(ops)) {
          let rewritten: unknown[] | undefined;
          for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            // `in` REJECTS a primitive, so the object guard is load-bearing.
            if (op === null || typeof op !== 'object' || Array.isArray(op)) continue;
            const opRecord = op as Record<string, unknown>;
            if (opRecord.method !== 'create') continue;
            const opArgs = opRecord.args;
            if (!Array.isArray(opArgs) || opArgs[0] !== 'image') continue;
            const opProps = opArgs[1];
            if (opProps === null || typeof opProps !== 'object' || Array.isArray(opProps)) continue;
            const opPropsRecord = opProps as Record<string, unknown>;
            const opFp = opPropsRecord.filePath;
            if (typeof opFp === 'string' && opFp) {
              const okOpFile = await isValidFile(opFp);
              if (!okOpFile) {
                return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: `file not found or not readable: ${opFp}` }));
              }
              const newOpProps: Record<string, unknown> = { ...opPropsRecord };
              newOpProps.url = toBridgeUrl(opFp);
              delete newOpProps.filePath;
              if (!rewritten) rewritten = ops.slice();
              const newOpArgs = [...opArgs];
              newOpArgs[1] = newOpProps;
              rewritten[i] = { ...opRecord, args: newOpArgs };
            } else if (opFp !== undefined && typeof opFp !== 'string') {
              return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'props.filePath must be a string' }));
            } else if (typeof opFp === 'string' && opFp.trim() === '') {
              return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'filePath cannot be empty' }));
            }
          }
          if (rewritten) (effectiveRawArgs as any).ops = rewritten;
        }
      }


      // REQ-1020 — reserved `returnAs` (plan D1/D2): validated here (fail
      // loud on typos, before spending a bridge round trip), stripped like
      // `_rawJson` above — it is not in `inputKeys`, so the positional
      // mapping below can never forward it to the tab.
      const returnAsRaw = (effectiveRawArgs as any)['returnAs'];
      delete (effectiveRawArgs as any)['returnAs'];
      const resolvedReturnAs = resolveReturnAs(returnAsRaw);
      if ('error' in resolvedReturnAs) {
        return toCallToolResult(resultToContent(resolvedReturnAs.error));
      }

      // `_timeoutMs` is a reserved top-level key (REQ-772 AC-1), excluded
      // from the manifest-args mapping by construction: only `inputKeys` are
      // forwarded positionally to the tab-side method.
      const effectiveTimeoutMs = resolveTimeoutMs(`${groupName}_${methodName}`, rawArgs['_timeoutMs']);
      const args = inputKeys.map((key) => {
        const raw = (effectiveRawArgs as any)[key];
        const schema = tool?.paramSchemas?.[key];
        return coerceValue(raw, schema);
      });
      // REQ-1295 T3 — the same declared-wrapper rule the compact lane runs, at
      // the same point in the pipeline (after coercion, before the round trip)
      // and AHEAD of the per-kind rule, for the same ordering reason: on
      // `layer.create` the wrapped `props` would otherwise be answered
      // `invalid_transform` naming the wrapper key as an inapplicable prop.
      //
      // `positionalLength` is `args.length`, which is `inputKeys.length` by
      // construction — this lane maps declared keys to a full-length positional
      // array, `undefined` for an omitted one. So a two-parameter method always
      // presents 2 (and is checked), while a ONE-parameter method always
      // presents 1 and is correctly declined: a single object alone in `args`
      // is the form the editor expands.
      const fullKindValues = positionalValues(inputKeys, args);
      const wrapperMismatch = findDeclaredWrapperMismatch(
        tool?.paramSchemas,
        fullKindValues,
        (name) => name,
        args.length,
      );
      if (wrapperMismatch) {
        return toCallToolResult(
          resultToContent({
            ok: false,
            code: wrapperMismatch.code ?? 'invalid_params',
            message:
              `${toolName}: ${wrapperMismatch.path} must be ${wrapperMismatch.expected}, but it arrived as ${wrapperMismatch.got}. ` +
              `${wrapperMismatch.hint} ` +
              `Learn the exact shape first: figpea_describe({group:"${groupName}", method:"${methodName}"}).`,
          }),
        );
      }
      // REQ-1309 T4 — the SAME per-kind prop rule the compact lane runs, at
      // the SAME point in the pipeline: after the `_rawJson` verdict and after
      // coercion — and, since REQ-1337 moved that parse, BEFORE the
      // `filePath`→bridge-URL translation, where this lane used to run it.
      // The relative order of those first two is deliberately reversed (the
      // translation has to see a PARSED payload to find a `filePath` in it);
      // what this check needs from them is unchanged, since a `props` that
      // failed to parse is refused above and a `props` that parsed is still
      // forwarded, translated, as the same value. It still runs before the
      // round trip. This lane had no shape pre-flight of any kind until
      // now, and it is the lane real MCP clients actually use — wiring only the
      // compact one would satisfy the requirement's example in one calling
      // convention and keep billing the round trip in the other.
      //
      // `pathFor` is the bare param name because that is how this lane names
      // things: the caller wrote `{kind, props}`, not `args[1]`.
      const kindValues: Record<string, unknown> = fullKindValues;
      const kindMismatch = findKindPropMismatch(tool?.paramSchemas, kindValues, (name) => name);
      if (kindMismatch) {
        return toCallToolResult(
          resultToContent({
            ok: false,
            code: kindMismatch.code ?? 'invalid_params',
            message:
              `${toolName}: ${kindMismatch.path} must be ${kindMismatch.expected}, but it arrived as ${kindMismatch.got}. ` +
              `${kindMismatch.hint} ` +
              `Learn the exact shape first: figpea_describe({group:"${groupName}", method:"${methodName}"}).`,
          }),
        );
      }
      try {
        const result = (await bridge.callTab(groupName, methodName, args, effectiveTimeoutMs)) as FigpeaCallResultLike;
        // REQ-1295 T4 — this lane did not call `appendShapeHint` at all before,
        // a genuine gap for this whole failure class: the very sentence a caller
        // needs after a wrong shape is the one it never got here. Same function,
        // not a new one, so the two lanes cannot state the remedy differently.
        return toCallToolResult(
          resultToContent(
            appendWrapperHint(
              appendShapeHint(result, `${groupName}`, `${methodName}`),
              new Set(inputKeys),
              fullKindValues,
            ),
            returnAsOpts(bridge, toolName, resolvedReturnAs.mode),
          ),
        );
      } catch (e) {
        return toCallToolResult(
          resultToContent({ ok: false, code: 'bridge_error', message: e instanceof Error ? e.message : String(e) }),
        );
      }
    };
  }

  function isUnchanged(name: string, tool: GeneratedTool): boolean {
    const previous = registeredMeta.get(name);
    return (
      previous !== undefined &&
      previous.description === tool.description &&
      previous.inputKeys.length === tool.inputKeys.length &&
      previous.inputKeys.every((key, i) => key === tool.inputKeys[i])
    );
  }

  function registerOrRefreshContractTool(groupName: string, methodName: string, tool: GeneratedTool): void {
    if (isUnchanged(tool.name, tool)) {
      registeredTools.get(tool.name)?.enable();
      return; // Identical surface -- no churn (plan §2).
    }

    registeredTools.get(tool.name)?.remove();

    const inputShape = buildInputShape(tool);
    const handler = makeContractHandler(groupName, methodName, tool.inputKeys, tool);
    // REQ-772: buildInputShape now ALWAYS returns a shape (it carries the
    // reserved `_timeoutMs` key even for zero-param methods), so the former
    // no-schema zero-param registration branch — which dropped ALL arguments
    // and made `_timeoutMs` unreachable for those tools — is removed. Every
    // contract tool registers with a schema and receives its rawArgs.
    const registeredTool = server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: inputShape },
      (args) => handler(args as Record<string, unknown>),
    );

    registeredTools.set(tool.name, registeredTool);
    registeredMeta.set(tool.name, { description: tool.description, inputKeys: tool.inputKeys });
  }

  function registerContractTools(manifest: ManifestLike): void {
    const generated = buildToolsFromManifest(manifest);
    const toolByName = new Map(generated.map((tool) => [tool.name, tool]));

    for (const groupName of Object.keys(manifest)) {
      // REQ-093 T5 (AC-4) -- `errorCodes` is a reserved flat code->meaning
      // catalog living alongside the group descriptors (agent/index.ts's
      // describe()), not itself a group; skip it here too so no
      // errorCodes_* contract tool ever gets registered (buildToolsFromManifest
      // already excludes it, so toolByName has no entries for it -- this
      // skip just avoids the wasted iteration over its catalog entries).
      if (groupName === ERROR_CODES_MANIFEST_KEY) continue;
      for (const methodName of Object.keys(manifest[groupName])) {
        const tool = toolByName.get(`${groupName}_${methodName}`);
        if (!tool) continue; // Unreachable: buildToolsFromManifest is total over every real group.
        registerOrRefreshContractTool(groupName, methodName, tool);
      }
    }

    // A method absent from this describe() (a reconnecting tab on an older
    // or narrower surface) is disabled, not removed -- the tool list stays
    // stable (plan §2 OQ-4) and can re-enable cleanly if the method
    // reappears on a later reconnect.
    for (const [name, registeredTool] of registeredTools) {
      if (!toolByName.has(name)) {
        registeredTool.disable();
      }
    }

    toolCount = generated.length;
  }

  if (toolMode === 'full' && options?.prefetchedManifest) {
    registerContractTools(options.prefetchedManifest);
  }

  // REQ-1268 T2 (AC-1) — the manifest ref that `figpea_describe` reads.
  // Seeded from the startup prefetch (already in memory, so this costs
  // nothing) and refreshed on every describe event. Compact mode registers NO
  // contract tool from it, which is what keeps `status.toolCount === 0` in
  // compact mode (REQ-1018's pin) exactly as before.
  let activeManifest: ManifestLike | undefined = options?.prefetchedManifest;

  bridge.onDescribe((manifest) => {
    // The assignment comes BEFORE the full-mode early return on purpose: a
    // compact-mode session also learns the manifest when a tab describes
    // itself, and must not be the one surface that throws that knowledge away.
    activeManifest = manifest as ManifestLike;
    if (toolMode !== 'full') return;
    registerContractTools(manifest as ManifestLike);
  });

  return server;
}
