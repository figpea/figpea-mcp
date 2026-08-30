/**
 * REQ-074 T3 — MCP server: static tools & dynamic contract tools (plan §2,
 * OQ-4). Builds an `McpServer` wired to an already-started bridge (the
 * bridge is a dependency, not started here — `cli.ts` owns the one real
 * `startBridgeServer()` call, plan §2), so this module stays unit-testable
 * with a plain stub bridge and no real WebSocket listener.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
}

const DEFAULT_EDITOR_BASE_URL = 'https://editor.figpea.com';
const SERVER_NAME = 'figpea-mcp';
const SERVER_VERSION = '2.1.0';

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
  // REQ-1037 — reserved `_rawJson` bypass for harness that stringifies nested numbers.
  // Declared so it survives safeParseAsync, never forwarded (not in inputKeys).
  shape['_rawJson'] = z.any().optional();
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
        return `http://127.0.0.1:${bridge.port}/file?path=${encodeURIComponent(filePath)}`;
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
          if (!newInput.fileName && !newInput.name) newInput.fileName = path.basename(filePathVal);
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
      const rawJsonFlag =
        (effectiveRawArgs as any)['_rawJson'] === true ||
        (effectiveRawArgs as any)['_rawJson'] === 'true' ||
        (effectiveRawArgs as any)['_rawJson'] === 1 ||
        (effectiveRawArgs as any)['_rawJson'] === '1';
      if (rawJsonFlag) {
        for (const key of inputKeys) {
          const v = (effectiveRawArgs as any)[key];
          if (typeof v === 'string') {
            const trimmed = v.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'object' && parsed !== null) {
                  (effectiveRawArgs as any)[key] = parsed;
                }
              } catch {}
            }
          }
        }
      } else {
        // Auto-parse heuristic even without flag: schema expects object/array/matrix but received JSON string
        for (const key of inputKeys) {
          const v = (effectiveRawArgs as any)[key];
          if (typeof v !== 'string') continue;
          const schema = tool?.paramSchemas?.[key];
          if (!schema) continue;
          const expectsStructured = schema.type === 'object' || schema.type === 'array' || schema.type === 'matrix';
          if (!expectsStructured) continue;
          const trimmed = v.trim();
          if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed !== 'object' || parsed === null) continue;
            if (schema.type === 'matrix' && Array.isArray(parsed)) (effectiveRawArgs as any)[key] = parsed;
            else if (schema.type === 'array' && Array.isArray(parsed)) (effectiveRawArgs as any)[key] = parsed;
            else if (schema.type === 'object' && !Array.isArray(parsed)) (effectiveRawArgs as any)[key] = parsed;
          } catch {}
        }
      }
      // Remove reserved keys so they never leak into coercion or logging of effective args
      delete (effectiveRawArgs as any)['_rawJson'];

      // `_timeoutMs` is a reserved top-level key (REQ-772 AC-1), excluded
      // from the manifest-args mapping by construction: only `inputKeys` are
      // forwarded positionally to the tab-side method.
      const effectiveTimeoutMs = resolveTimeoutMs(`${groupName}_${methodName}`, rawArgs['_timeoutMs']);
      const args = inputKeys.map((key) => {
        const raw = (effectiveRawArgs as any)[key];
        const schema = tool?.paramSchemas?.[key];
        return coerceValue(raw, schema);
      });
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

  if (options?.prefetchedManifest) {
    registerContractTools(options.prefetchedManifest);
  }

  bridge.onDescribe((manifest) => {
    registerContractTools(manifest as ManifestLike);
  });

  return server;
}
