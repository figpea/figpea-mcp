/**
 * REQ-074 T3 — pure, dependency-free MCP tool generation from a live
 * `figpea.describe()` manifest (plan §1, §6; AC-4). No `ws`/SDK/zod value
 * imports here — only self-defined types — so this module is importable
 * from the v3 happy-dom test env (`src/tests/unit/meta/mcpToolDrift.test.ts`)
 * with zero runtime cost.
 *
 * `ManifestMethodDescriptorLike.params`/`.result` are deliberately typed
 * `unknown` (not `Record<string, unknown>`): the real descriptors
 * (`src/agent/registry.ts`'s `MethodDescriptor`) type them `unknown` too —
 * they are informal, human-readable shape hints, not a machine schema (plan
 * §0) — so this stays structurally assignable from the real `Manifest` type
 * without a cast at every call site.
 */

export interface ManifestMethodDescriptorLike {
  doc: string;
  params?: unknown;
  result?: unknown;
}

export type ManifestLike = Record<string, Record<string, ManifestMethodDescriptorLike>>;

/**
 * REQ-093 T4/T5 (AC-3/AC-4) — the reserved top-level manifest key `describe()`
 * composes the error-code catalog under (`src/agent/results.ts`'s
 * `ERROR_CODES_MANIFEST_KEY`, `src/agent/index.ts`'s `describe()`). Not a
 * command group -- `buildToolsFromManifest` must skip it or it would
 * misread each catalog entry's one-line meaning as a `ManifestMethodDescriptorLike`
 * and synthesize a bogus `errorCodes_<code>` tool.
 *
 * This is an independent LOCAL MIRROR of the real constant, not an import:
 * verified empirically that `import { ERROR_CODES_MANIFEST_KEY } from
 * '../../../src/agent/results'` breaks this standalone package's own build
 * (`tsc -p packages/figpea-mcp/tsconfig.json`, invoked by root `npm test`'s
 * `pretest` script) with `error TS6059: File '.../src/agent/results.ts' is
 * not under 'rootDir' '.../packages/figpea-mcp/src'` -- the package's
 * `rootDir: "src"` + `declaration: true` forbid any source file outside
 * `packages/figpea-mcp/src/**`. This is the exact same cross-boundary
 * constraint `protocol.ts` already documents and solves for `BRIDGE_FRAME_TYPES`
 * (independent copy + a runtime parity test, `bridgeProtocol.test.ts`'s
 * pattern) -- `errorCodesManifestKeyParity.test.ts` is this constant's
 * equivalent drift guard, diffing this value against the real export.
 */
export const ERROR_CODES_MANIFEST_KEY = 'errorCodes' as const;

/**
 * REQ-093 T5 (AC-4) -- a structurally-compatible local mirror of
 * `../../../src/agent/schema.ts`'s public `ParamSchema` fields (same
 * cross-boundary constraint as `ERROR_CODES_MANIFEST_KEY` above: this
 * package cannot import `src/agent/**` without breaking its own `tsc`
 * build). Carries only what a generated tool needs to advertise: the
 * param's type, whether it's required, and (for constrained strings) its
 * allowed values.
 */
export interface ParamSchemaLike {
  type: string;
  required: boolean;
  enum?: string[];
}

export interface GeneratedTool {
  name: string;
  description: string;
  inputKeys: string[];
  /**
   * REQ-093 T5 (AC-4) -- each param's structured schema (enum/required),
   * keyed by param name, carried straight through from the manifest's
   * structured `ParamSchema` values (T2). Present only when at least one
   * param's value is the newer structured `{type, required, ...}` shape;
   * `undefined` for a method with no params, or one whose params are still
   * the legacy free-text hint strings (pre-REQ-093 manifests, kept
   * structurally readable by this module's own back-compat tests).
   */
  paramSchemas?: Record<string, ParamSchemaLike>;
}

/** Narrows a descriptor's informal `params` hint to its key list, in
 * declaration order — the codebase's positional-argument convention (plan
 * §0), verified across every real method. A method with no `params` takes no
 * arguments. */
function paramKeys(descriptor: ManifestMethodDescriptorLike): string[] {
  return Object.keys((descriptor.params ?? {}) as Record<string, unknown>);
}

/** A param value is the newer structured `ParamSchema` shape (REQ-093 T2) --
 * as opposed to a legacy free-text hint string -- iff it carries the two
 * mandatory `ParamSchema` fields. */
function isStructuredParamSchema(value: unknown): value is ParamSchemaLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { required?: unknown }).required === 'boolean'
  );
}

/** Carries each param's structured schema (enum/required, REQ-093 T5 AC-4)
 * through onto the generated tool, keyed by param name. Returns `undefined`
 * when the descriptor has no params, or when none of its param values are
 * the structured shape (a legacy free-text-hint descriptor has nothing
 * structured to carry). */
function buildParamSchemas(descriptor: ManifestMethodDescriptorLike): Record<string, ParamSchemaLike> | undefined {
  const params = (descriptor.params ?? {}) as Record<string, unknown>;
  let schemas: Record<string, ParamSchemaLike> | undefined;
  for (const [key, value] of Object.entries(params)) {
    if (!isStructuredParamSchema(value)) continue;
    schemas ??= {};
    schemas[key] = {
      type: value.type,
      required: value.required,
      ...(Array.isArray(value.enum) ? { enum: [...value.enum] as string[] } : {}),
    };
  }
  return schemas;
}

/** Renders an informal shape hint (string, or a nested object of hints) as
 * readable text for a tool description — never interpreted as a schema. */
function describeShape(shape: unknown): string {
  if (typeof shape === 'string') return shape;
  try {
    return JSON.stringify(shape);
  } catch {
    return String(shape);
  }
}

function buildDescription(descriptor: ManifestMethodDescriptorLike): string {
  const lines = [descriptor.doc];
  if (descriptor.params !== undefined) {
    lines.push(`Params: ${describeShape(descriptor.params)}`);
  }
  if (descriptor.result !== undefined) {
    lines.push(`Result: ${describeShape(descriptor.result)}`);
  }
  return lines.join('\n');
}

/**
 * One MCP tool per manifest method, named `${group}_${method}` — a
 * deterministic, total, 1:1 mechanical projection of the live surface (plan
 * §1). This is the whole of the drift-avoidance: recomputed from the real
 * descriptors every call, never a hash that can silently go inert.
 */
export function buildToolsFromManifest(manifest: ManifestLike): GeneratedTool[] {
  const tools: GeneratedTool[] = [];
  for (const groupName of Object.keys(manifest)) {
    // REQ-093 T5 (AC-4) -- `errorCodes` is a reserved flat code->meaning
    // catalog living alongside the group descriptors, not itself a group;
    // skip it so it never gets misread as one method-per-key and synthesize
    // bogus `errorCodes_<code>` tools.
    if (groupName === ERROR_CODES_MANIFEST_KEY) continue;
    const group = manifest[groupName];
    for (const methodName of Object.keys(group)) {
      const descriptor = group[methodName];
      const paramSchemas = buildParamSchemas(descriptor);
      tools.push({
        name: `${groupName}_${methodName}`,
        description: buildDescription(descriptor),
        inputKeys: paramKeys(descriptor),
        ...(paramSchemas ? { paramSchemas } : {}),
      });
    }
  }
  return tools;
}

export type FigpeaCallResultLike =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message?: string };

export interface McpTextContentLike {
  type: 'text';
  text: string;
}

export interface McpImageContentLike {
  type: 'image';
  data: string;
  mimeType: string;
}

export type McpContentBlockLike = McpTextContentLike | McpImageContentLike;

export interface MappedToolResultLike {
  content: McpContentBlockLike[];
  isError: boolean;
}

interface ImageValueLike {
  bytes: string;
  mime: string;
  [key: string]: unknown;
}

/** A success value shaped `{bytes:<base64>, mime:"image/*"}` (plan §1 OQ-D) —
 * matches both `canvas.screenshot`'s and raster `export.*`'s result shape
 * with no per-tool special-casing. */
function asImageValue(value: unknown): ImageValueLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.bytes !== 'string') return undefined;
  if (typeof candidate.mime !== 'string' || !candidate.mime.startsWith('image/')) return undefined;
  return candidate as ImageValueLike;
}

/**
 * Runtime-derived result -> MCP content mapping (plan §1 OQ-D): success ->
 * JSON text (`isError:false`); `{ok:false}` -> JSON text preserving
 * `code`/`message` (`isError:true`); an image-shaped success value -> MCP
 * image content plus a short text summary. Never a hardcoded tool-name
 * special case.
 */
export function resultToContent(result: FigpeaCallResultLike): MappedToolResultLike {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ ok: false, code: result.code, message: result.message }) }],
    };
  }

  const imageValue = asImageValue(result.value);
  if (imageValue) {
    const { bytes, mime, ...rest } = imageValue;
    return {
      isError: false,
      content: [
        { type: 'image', data: bytes, mimeType: mime },
        { type: 'text', text: JSON.stringify({ ok: true, mime, ...rest }) },
      ],
    };
  }

  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ok: true, value: result.value }) }],
  };
}
