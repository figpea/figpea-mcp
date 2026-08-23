/**
 * REQ-074 T3 — MCP server: static tools & dynamic contract tools (plan §2,
 * OQ-4). Builds an `McpServer` wired to an already-started bridge (the
 * bridge is a dependency, not started here — `cli.ts` owns the one real
 * `startBridgeServer()` call, plan §2), so this module stays unit-testable
 * with a plain stub bridge and no real WebSocket listener.
 */

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
}

const DEFAULT_EDITOR_BASE_URL = 'https://editor.figpea.com';
const SERVER_NAME = 'figpea-mcp';
const SERVER_VERSION = '2.0.1';

/** REQ-772 AC-1 — the documented maximum a per-call `_timeoutMs` override may
 * raise a single bridge call's timeout to. Values above it are clamped (not
 * rejected), per the README's stated semantics. */
export const MAX_CALL_TIMEOUT_MS = 120_000;

/** REQ-772 AC-2 — raised default timeouts for known-slow contract methods,
 * keyed by tool name (`${group}_${method}`). Lives next to the tool
 * registration so docs and code stay in one place; every method NOT listed
 * here keeps `callTab`'s own flat 10s default (AC-4 — the fast path is
 * byte-for-byte unchanged: an `undefined` 4th arg hits callTab's default
 * parameter exactly as before). Mirrored verbatim in README.md ("Call
 * timeouts") and the shipped skill markdown — keep them in sync. */
export const DEFAULT_TIMEOUT_TABLE_MS: Record<string, number> = {
  session_openFile: 120_000,
  session_waitForIdle: 30_000,
  export_project: 120_000,
  export_specBundle: 60_000,
  export_assetHarvest: 120_000,
  export_figmaKit: 60_000,
};

/** REQ-772 — resolves the timeout for one contract-tool call:
 * a usable `_timeoutMs` override (finite, > 0) wins, clamped to the cap;
 * anything else falls through to the method-aware table, then to `undefined`
 * (= `callTab`'s built-in 10s default). Non-number/NaN/≤0 values are ignored
 * rather than rejected — a broken knob must not fail an otherwise-valid call. */
function resolveTimeoutMs(toolName: string, rawOverride: unknown): number | undefined {
  if (typeof rawOverride === 'number' && Number.isFinite(rawOverride) && rawOverride > 0) {
    return Math.min(rawOverride, MAX_CALL_TIMEOUT_MS);
  }
  return DEFAULT_TIMEOUT_TABLE_MS[toolName];
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

function buildInputShape(tool: GeneratedTool): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  // REQ-772 AC-1 — every generated contract tool accepts the reserved
  // `_timeoutMs` key to raise that single call's bridge timeout (capped at
  // MAX_CALL_TIMEOUT_MS, clamped not rejected). Declared in the shape so it
  // survives the SDK's safeParseAsync stripping (see the REQ-769 comment
  // below: undeclared keys never reach the handler); excluded from the
  // manifest-args mapping by construction (`makeContractHandler` maps only
  // `inputKeys`, which never contains `_timeoutMs`), so it is never
  // forwarded to the tab-side method.
  shape['_timeoutMs'] = z.number().optional();
  if (tool.inputKeys.length === 0) return shape;
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
    const advertised = paramSchema ? TYPE_TO_ADVERTISED[paramSchema.type] : undefined;
    if (enumValues && enumValues.length > 0) {
      shape[key] = z.enum(enumValues as [string, ...string[]]).optional();
    } else if (advertised) {
      shape[key] = z.any().meta(advertised).optional();
    } else {
      shape[key] = z.any().optional();
    }
  }
  return shape;
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
        "Reports the bridge's port, whether an editor tab is connected, the connected tab's contract version (null if none), and how many contract tools are currently registered.",
    },
    async () => {
      return jsonTextResult({
        port: bridge.port,
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

  function makeContractHandler(groupName: string, methodName: string, inputKeys: string[]) {
    return async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
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
      // `_timeoutMs` is a reserved top-level key (REQ-772 AC-1), excluded
      // from the manifest-args mapping by construction: only `inputKeys` are
      // forwarded positionally to the tab-side method.
      const effectiveTimeoutMs = resolveTimeoutMs(`${groupName}_${methodName}`, rawArgs['_timeoutMs']);
      const args = inputKeys.map((key) => rawArgs[key]);
      try {
        const result = (await bridge.callTab(groupName, methodName, args, effectiveTimeoutMs)) as FigpeaCallResultLike;
        return toCallToolResult(resultToContent(result));
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
    const handler = makeContractHandler(groupName, methodName, tool.inputKeys);
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

  if (options?.prefetchedManifest) {
    registerContractTools(options.prefetchedManifest);
  }

  bridge.onDescribe((manifest) => {
    registerContractTools(manifest as ManifestLike);
  });

  return server;
}
