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
} from './tools';
import { writeImageReturn, sessionDirFor } from './returnPath';
// REQ-1301 — the one place the loopback host is decided. Imported from a
// neutral module (not from ./bridgeServer) so this file's structural stub seam
// stays a stub seam: `cli.ts` always passes the real handle, which defines
// `getFileUrl`, so the two fallbacks below are a *consistency* backstop for a
// handle that omits it — not a path production traffic takes. They use the
// constant so a fallback can never disagree with the canonical host again.
import { BRIDGE_URL_HOST } from './bridgeHost';
import { groupNamesFromCompactIndex } from './describeDrill';
import { findArgShapeMismatch, findKindPropMismatch, renderSchemaExample } from './argShape';
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
  /** REQ-1018: tool surface mode — compact (default) exposes only 5 tools:
   * `open_editor`, `status`, `figpea_skill`, the `figpea_call` dispatcher, and
   * (REQ-1268) `figpea_describe`; full restores all contract tools instead of
   * the two compact-only ones. */
  toolMode?: 'compact' | 'full';
}

const DEFAULT_EDITOR_BASE_URL = 'https://editor.figpea.com';
const SERVER_NAME = 'figpea-mcp';
const SERVER_VERSION = '2.5.0';

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
 * Builds the `McpServer` for a bridge: `open_editor` + `status` are always
 * registered (OQ-4); contract tools are registered/updated from the bridge's
 * live `describe()` manifest on every connect/reconnect.
 */
export function createMcpServer(bridge: BridgeServerHandleLike, options?: CreateMcpServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const registeredTools = new Map<string, RegisteredTool>();
  const registeredMeta = new Map<string, { description: string; inputKeys: string[] }>();
  let toolCount = 0;
  const toolMode = options?.toolMode ?? 'full';

  function resolveEditorBaseUrl(perCall: string | undefined): string {
    return perCall ?? options?.editorBaseUrl ?? process.env.FIGPEA_EDITOR_URL ?? DEFAULT_EDITOR_BASE_URL;
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
        "Reports the bridge's port, whether an editor tab is connected, the connected tab's contract version (null if none), and how many contract tools are currently registered. Also returns token and url so an LLM can construct the paste-ready pairing string without re-launching (REQ-1035).",
    },
    async () => {
      return jsonTextResult({
        port: bridge.port,
        token: bridge.token,
        url: buildConnectUrl(undefined, undefined),
        tabConnected: bridge.isTabConnected(),
        contractVersion: bridge.getContractVersion ? bridge.getContractVersion() : null,
        toolCount,
      });
    },
  );

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
        "Returns Figpea's agent skill reference -- the craft guidance for using window.figpea well (the authoring loop, recreating a reference faithfully, wiring interactions, the screenshot feedback loop, undo etiquette, entitlement boundaries, and the canonical Tier-1 recipe). Sourced from the editor origin's /agent/skill.md at startup.",
    },
    async () => {
      if (options?.prefetchedSkillBody) {
        return textResult(options.prefetchedSkillBody);
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
          "Returns the agent contract surface for a group or method — the same doc/params/result the editor's own describe() returns, served from the manifest this server already holds in memory (no round trip to the tab). Call it with no arguments for the group index, {group} for one group's methods, or {group, method} for one method's wire shape. In compact mode this is how you learn a method's argument shape instead of probing: e.g. figpea_describe({group:'layer', method:'batch'}) returns the ops shape, whose args is a POSITIONAL array of {method, args} ops. A per-method response also carries stringJsonParams: the names of THIS method's params you may send as a JSON string instead of a real object/array, because the server parses them before the round trip (e.g. [\"[{\\\"method\\\":\\\"create\\\",\\\"args\\\":[\\\"rect\\\",{\\\"rwidth\\\":100}]}]\"] for ops). The key is absent when the method declares no such param, and it is derived from the manifest, so it is right for any method without this description being updated.",
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
            return jsonTextResult({
              ok: true,
              group,
              method,
              ...(stringJson.length > 0 ? { stringJsonParams: stringJson } : {}),
              ...descriptor,
            });
          }
          return jsonTextResult({ ok: true, group, methods });
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
  function contractToolFor(groupName: string, methodName: string): GeneratedTool | undefined {
    const manifest = activeManifest;
    if (!manifest) return undefined;
    if (contractIndex === null || contractIndexFor !== manifest) {
      contractIndex = new Map(buildToolsFromManifest(manifest).map((tool) => [tool.name, tool]));
      contractIndexFor = manifest;
    }
    return contractIndex.get(`${groupName}_${methodName}`);
  }

  // REQ-1018 — figpea_call dispatcher (compact mode only)

  if (toolMode === 'compact') {
    server.registerTool(
      'figpea_call',
      {
        description:
          'Universal dispatcher — calls any group.method on the paired editor tab via bridge.callTab(group, method, args, _timeoutMs?). In compact mode this is the only way to reach contract methods; in full mode the individual tools are also available. group/method are the describe() surface names, and args is the POSITIONAL argument array for that method, in that method\'s own parameter order. FLAT example: ["rect", {rwidth:100}] for layer.create. NESTED example — when a parameter is itself an array (e.g. layer.batch\'s ops), that parameter is passed as ONE element of args, so the element is an array of {method, args} ops: {"group":"layer","method":"batch","args":[[{"method":"create","args":["page",{"name":"probe","pageWidth":100,"pageHeight":100}]}]]}. Each op\'s own args is likewise a positional ARRAY, never an object. Unsure of a method\'s shape? Call figpea_describe({group, method}) first — it returns that method\'s doc and params from the manifest with no round trip to the tab. Image results return MCP image content + a text summary. Pass returnAs:"path" to receive a binary result off-band as a session file path instead of inline base64 — it reaches every binary export, e.g. canvas_screenshot / export_layer / export_artboard for images and export_project for a native .fp. ' + TIMEOUT_KNOB_ADVICE,
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
              'Positional arguments for the method, in that method\'s own parameter order (defaults to []). When a parameter is itself an array (e.g. layer.batch\'s ops), pass it as ONE element of args — that element is an array of {method, args} ops, e.g. [[{method:"create", args:["rect",{rwidth:100}]}]]. Each op\'s args is an array too, never an object. If your harness cannot send a nested object or array, any param the method declares as an object/array may instead be sent as a JSON string with no flag, and this server parses it before the round trip — e.g. "args":["[{\"method\":\"create\",\"args\":[\"rect\",{\"rwidth\":100}]}]"]. A string is a scalar, so nothing collapses it; figpea_describe({group, method}) lists which of this method\'s params accept that as stringJsonParams.',
            )
            .meta({
              type: 'array',
              description:
                'Positional argument array, in the method\'s own parameter order. An array-typed parameter (e.g. layer.batch\'s ops) is passed as ONE element of args, and that element is itself an array of {method, args} ops — e.g. [[{method:"create", args:["rect",{rwidth:100}]}]]. Each op\'s args is an array, never an object. If your harness cannot send a nested object or array, any param the method declares as an object/array may instead be sent as a JSON string with no flag, and this server parses it before the round trip — e.g. "args":["[{\"method\":\"create\",\"args\":[\"rect\",{\"rwidth\":100}]}]"]. A string is a scalar, so nothing collapses it; figpea_describe({group, method}) lists which of this method\'s params accept that as stringJsonParams.',
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
              'Set _rawJson:true on your figpea_call when your harness STRINGIFIED an object or array argument AND the method is unknown or the parameter is not declared as an object/array in the manifest this server holds: every element of args that is a string whose trimmed form starts with { or [ and ends with } or ] is JSON-parsed before it reaches the editor, e.g. {"group":"layer","method":"create","args":["page","{\\"name\\":\\"probe\\",\\"pageWidth\\":300,\\"pageHeight\\":200}"],"_rawJson":true}. NOTE you usually do NOT need this: a param the method DECLARES as an object/array is parsed with no flag at all, which is safer because it only ever touches a value the manifest says was meant to be structured. This flag\'s parse is deliberately schema-blind so it works on a first call with no manifest, which is exactly why it stays opt-in rather than becoming the default. If a value looks like JSON but cannot be parsed, and its parameter is declared an object/array, the call is refused by name (invalid_params) instead of being forwarded — nothing is silently ignored.',
            ),
          returnAs: z.any().optional().describe('Reserved: "inline" (default) or "path" — "path" writes a binary result to a session file and returns {ok, path, mime, width, height, bytes, filename?, url} as text, so a non-image export (e.g. a native .fp project) never crosses the wire as base64'),
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
        // `schemaAt: () => undefined` is deliberate: the declared schema is
        // not reachable until `contractToolFor` below, and a flag that needed
        // a manifest would be dead on exactly the first-call situation an
        // agent is most likely to hit. With no schema, a failed parse is NOT
        // recorded (the guard's safe default), so this step can only ever
        // PARSE, never refuse — the verdict is step 2, below.
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
        // and every statement in it are exactly where they were.
        const contractTool = contractToolFor(group, method);
        if (rawJsonRequested) {
          args = applyRawJson(args, { schemaAt: () => undefined, pathAt: (i) => `args[${i}]` }).value;
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
        if (toolName === 'session_openFile') {
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
            const expectedArgs = contractTool.inputKeys
              .map((k, idx) => {
                const sch = contractTool.paramSchemas?.[k];
                return sch ? renderSchemaExample(sch) : '…';
              })
              .join(', ');
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
          // now with the schema: a value that looks like JSON but does not
          // parse is refused by name ONLY where the schema proves a
          // structured value was intended (AC-8) — which is exactly where the
          // tab would have rejected it after a wasted round trip. The values
          // are already parsed, so this re-run is a cheap no-op on the array;
          // what it supplies is the schema, the only thing the verdict needs.
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
            const expectedArgs = contractTool.inputKeys
              .map((k, idx) => {
                const sch = contractTool.paramSchemas?.[k];
                return sch ? renderSchemaExample(sch) : '…';
              })
              .join(', ');
            return toCallToolResult(
              resultToContent({
                ok: false,
                code: mismatch.code ?? 'invalid_params',
                message:
                  `${toolName}: ${mismatch.path} must be ${mismatch.expected}, but it arrived as ${mismatch.got}. ` +
                  `${mismatch.hint} ` +
                  `Expected ${toolName} args: [${expectedArgs}]. ` +
                  `Learn the exact shape first: figpea_describe({group:"${group}", method:"${method}"}).`,
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
            const expectedArgs = contractTool.inputKeys
              .map((k, idx) => {
                const sch = contractTool.paramSchemas?.[k];
                return sch ? renderSchemaExample(sch) : '…';
              })
              .join(', ');
            return toCallToolResult(
              resultToContent({
                ok: false,
                code: kindMismatch.code ?? 'invalid_params',
                message:
                  `${toolName}: ${kindMismatch.path} must be ${kindMismatch.expected}, but it arrived as ${kindMismatch.got}. ` +
                  `${kindMismatch.hint} ` +
                  `Expected ${toolName} args: [${expectedArgs}]. ` +
                  `Learn the exact shape first: figpea_describe({group:"${group}", method:"${method}"}).`,
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
          return toCallToolResult(
            resultToContent(appendShapeHint(result, `${group}`, `${method}`), returnAsOpts(bridge, toolName, resolvedReturnAs.mode)),
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
      const allowedKeys = new Set<string>([...inputKeys, ...FULL_MODE_RESERVED]);
      if (toolNameForCheck === 'session_openFile') allowedKeys.add('filePath');
      const unknownKeys = findUnknownTopLevelKeys(rawArgs, allowedKeys);
      if (unknownKeys.length > 0) {
        return toCallToolResult(
          resultToContent({
            ok: false,
            code: 'invalid_params',
            message: renderUnknownParameterMessage(toolNameForCheck, unknownKeys, [...inputKeys, ...FULL_MODE_RESERVED]),
          }),
        );
      }

      if (!bridge.isTabConnected()) {
        const connectUrl = buildConnectUrl(undefined, undefined);
        return toCallToolResult(
          resultToContent({
            ok: false,
            code: 'no_tab',
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

      // Helper to validate a local path and return bridge URL or error payload
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

      const toolName = `${groupName}_${methodName}`;
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
        if (inputAny && 'filePath' in inputAny && inputAny.filePath !== undefined && typeof inputAny.filePath !== 'string') {
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
        } else if (source && 'filePath' in source && source.filePath !== undefined && typeof source.filePath !== 'string') {
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
        } else if (kindVal === 'image' && props && 'filePath' in props && props.filePath !== undefined && typeof props.filePath !== 'string') {
          return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'props.filePath must be a string' }));
        } else if (kindVal === 'image' && typeof fp === 'string' && fp.trim() === '') {
          return toCallToolResult(resultToContent({ ok: false, code: 'invalid_image_source', message: 'filePath cannot be empty' }));
        }
      }

      // REQ-1037 T3 — `_rawJson` bypass + auto JSON-parse for stringified objects/arrays.
      // Must run after filePath translation (which may have mutated effectiveRawArgs) but before coercion.
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
        // Position, scope and semantics are unchanged. In particular this lane's
        // parse still runs AFTER the filePath translation, so a stringified
        // `filePath` in full mode is still not translated — a pre-existing gap
        // that belongs to REQ-1337, deliberately not moved here.
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
      // REQ-1309 T4 — the SAME per-kind prop rule the compact lane runs, at
      // the SAME point in the pipeline: after the `filePath`→bridge-URL
      // translation, after the `_rawJson` verdict, after coercion, and before
      // the round trip. This lane had no shape pre-flight of any kind until
      // now, and it is the lane real MCP clients actually use — wiring only the
      // compact one would satisfy the requirement's example in one calling
      // convention and keep billing the round trip in the other.
      //
      // `pathFor` is the bare param name because that is how this lane names
      // things: the caller wrote `{kind, props}`, not `args[1]`.
      const kindValues: Record<string, unknown> = {};
      for (let i = 0; i < inputKeys.length; i++) kindValues[inputKeys[i]] = args[i];
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
        return toCallToolResult(resultToContent(result, returnAsOpts(bridge, toolName, resolvedReturnAs.mode)));
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
