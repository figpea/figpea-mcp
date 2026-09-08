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
  shape?: Record<string, ParamSchemaLike>;
  byKind?: Record<string, Record<string, ParamSchemaLike>>;
  of?: ParamSchemaLike;
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
    const raw = value as unknown as Record<string, unknown>;
    const schema: ParamSchemaLike = {
      type: value.type,
      required: value.required,
      ...(Array.isArray(value.enum) ? { enum: [...value.enum] as string[] } : {}),
    };
    // Preserve nested shape/byKind/of for detailed JSON Schema advertisement and coercion (REQ-769 follow-up)
    if (raw.shape !== undefined && typeof raw.shape === 'object' && raw.shape !== null) {
      const shape = raw.shape as Record<string, unknown>;
      const nested: Record<string, ParamSchemaLike> = {};
      let hasNested = false;
      for (const [k, v] of Object.entries(shape)) {
        if (isStructuredParamSchema(v)) {
          // Recursively preserve nested schemas (handle one level of nesting for object shapes)
          const inner = v as unknown as Record<string, unknown>;
          const innerSchema: ParamSchemaLike = {
            type: (v as ParamSchemaLike).type,
            required: (v as ParamSchemaLike).required,
            ...(Array.isArray((v as ParamSchemaLike).enum) ? { enum: [...(v as ParamSchemaLike).enum!] } : {}),
          };
          if (inner.shape && typeof inner.shape === 'object') {
            const innerShape = inner.shape as Record<string, unknown>;
            const innerNested: Record<string, ParamSchemaLike> = {};
            let hasInnerNested = false;
            for (const [ik, iv] of Object.entries(innerShape)) {
              if (isStructuredParamSchema(iv)) {
                innerNested[ik] = { type: (iv as ParamSchemaLike).type, required: (iv as ParamSchemaLike).required, ...(Array.isArray((iv as ParamSchemaLike).enum) ? { enum: [...(iv as ParamSchemaLike).enum!] } : {}) };
                hasInnerNested = true;
              }
            }
            if (hasInnerNested) (innerSchema as any).shape = innerNested;
          }
          if (inner.of && isStructuredParamSchema(inner.of as unknown)) {
            (innerSchema as any).of = { type: (inner.of as unknown as ParamSchemaLike).type, required: (inner.of as unknown as ParamSchemaLike).required, ...(Array.isArray((inner.of as unknown as ParamSchemaLike).enum) ? { enum: [...(inner.of as unknown as ParamSchemaLike).enum!] } : {}) };
            // Handle of.shape for array of objects (e.g., polygon points)
            const ofShape = (inner.of as unknown as any).shape;
            if (ofShape && typeof ofShape === 'object') {
              const ofNested: Record<string, ParamSchemaLike> = {};
              let hasOfNested = false;
              for (const [ok, ov] of Object.entries(ofShape as Record<string, unknown>)) {
                if (isStructuredParamSchema(ov)) {
                  ofNested[ok] = { type: (ov as ParamSchemaLike).type, required: (ov as ParamSchemaLike).required, ...(Array.isArray((ov as ParamSchemaLike).enum) ? { enum: [...(ov as ParamSchemaLike).enum!] } : {}) };
                  hasOfNested = true;
                }
              }
              if (hasOfNested) ((innerSchema as any).of as any).shape = ofNested;
            }
          }
          nested[k] = innerSchema;
          hasNested = true;
        }
      }
      if (hasNested) schema.shape = nested;
      // Preserve top-level shape even if no nested structured entries, to indicate object shape exists
      if (!hasNested && Object.keys(shape).length > 0) {
        // Still mark as having shape for advertisement purposes (empty shape means generic object)
        // We keep it undefined to avoid empty advertisement, but the type is already object
      }
    }
    if (raw.byKind !== undefined && typeof raw.byKind === 'object' && raw.byKind !== null) {
      const byKind = raw.byKind as Record<string, Record<string, unknown>>;
      const byKindSchemas: Record<string, Record<string, ParamSchemaLike>> = {};
      let hasByKind = false;
      for (const [kindName, kindFields] of Object.entries(byKind)) {
        const kindSchema: Record<string, ParamSchemaLike> = {};
        let hasKindFields = false;
        for (const [fk, fv] of Object.entries(kindFields as Record<string, unknown>)) {
          if (isStructuredParamSchema(fv)) {
            kindSchema[fk] = { type: (fv as ParamSchemaLike).type, required: (fv as ParamSchemaLike).required, ...(Array.isArray((fv as ParamSchemaLike).enum) ? { enum: [...(fv as ParamSchemaLike).enum!] } : {}) };
            hasKindFields = true;
          }
        }
        if (hasKindFields) {
          byKindSchemas[kindName] = kindSchema;
          hasByKind = true;
        }
      }
      if (hasByKind) schema.byKind = byKindSchemas;
    }
    if (raw.of !== undefined && isStructuredParamSchema(raw.of)) {
      const ofVal = raw.of as ParamSchemaLike;
      const ofSchema: ParamSchemaLike = {
        type: ofVal.type,
        required: ofVal.required,
        ...(Array.isArray(ofVal.enum) ? { enum: [...ofVal.enum] } : {}),
      };
      // Handle of.shape
      const ofShape = (raw.of as any).shape;
      if (ofShape && typeof ofShape === 'object') {
        const ofNested: Record<string, ParamSchemaLike> = {};
        let hasOfNested = false;
        for (const [ok, ov] of Object.entries(ofShape as Record<string, unknown>)) {
          if (isStructuredParamSchema(ov)) {
            ofNested[ok] = { type: (ov as ParamSchemaLike).type, required: (ov as ParamSchemaLike).required, ...(Array.isArray((ov as ParamSchemaLike).enum) ? { enum: [...(ov as ParamSchemaLike).enum!] } : {}) };
            hasOfNested = true;
          }
        }
        if (hasOfNested) (ofSchema as any).shape = ofNested;
      }
      schema.of = ofSchema;
    }
    schemas[key] = schema;
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
  | { ok: false; code: string; message?: string; url?: string };

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
 * REQ-1020 T2 (AC-1/AC-2/AC-4, plan D2) — off-band return options.
 *
 * `tools.ts` stays dependency-free (see the module header): the writer is
 * injected, never imported — production passes `returnPath.ts`'s
 * `writeImageReturn`, tests pass fakes. `tool`/`sessionDir` are forwarded to
 * the writer for filename + placement; `fileUrlFor` builds the token-gated
 * fetch URL for the written bytes (plan D4: the bridge's `registerBlob()`).
 * A `url` returned by the writer itself wins over `fileUrlFor` (lets fakes
 * stay one-function).
 */
export interface ReturnAsOptions {
  returnAs?: string;
  tool?: string;
  sessionDir?: string;
  writeImage?: (args: {
    bytesB64: string;
    mime: string;
    width: number;
    height: number;
    tool: string;
    sessionDir: string;
  }) => { path: string; mime: string; width: number; height: number; bytes: number; url?: string };
  fileUrlFor?: (absPath: string) => string;
}

/** figpea-mcp-only write-failure code (plan D3, AC-6) — mirrored here (not
 * imported) so this module keeps its zero-runtime-cost importability. */
const RETURN_PATH_WRITE_FAILED = 'return_path_write_failed';

/**
 * Runtime-derived result -> MCP content mapping (plan §1 OQ-D): success ->
 * JSON text (`isError:false`); `{ok:false}` -> JSON text preserving
 * `code`/`message` (`isError:true`); an image-shaped success value -> MCP
 * image content plus a short text summary. Never a hardcoded tool-name
 * special case.
 *
 * REQ-1020: with `opts.returnAs === "path"` an image-shaped success value is
 * instead written off-band and mapped to a single text block
 * `{ok:true, path, mime, width, height, bytes, url?}` (AC-1/AC-2). A
 * non-image result ignores the key (no-op, never an error); an unknown value
 * fails loud with `invalid_params` (a typo must not silently inline
 * megabytes); a write failure maps to `return_path_write_failed` with
 * `isError:true` (AC-4). Default/`"inline"` is byte-identical to before
 * (AC-3).
 */
export function resultToContent(result: FigpeaCallResultLike, opts?: ReturnAsOptions): MappedToolResultLike {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ ok: false, code: result.code, message: result.message, url: result.url }) }],
    };
  }

  const imageValue = asImageValue(result.value);
  const mode = opts?.returnAs ?? 'inline';
  if (imageValue && mode !== 'inline') {
    if (mode !== 'path') {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'invalid_params', message: `returnAs must be "inline" or "path", got ${JSON.stringify(mode)}` }) }],
      };
    }
    try {
      const writer = opts?.writeImage;
      if (!writer) {
        throw Object.assign(new Error('no image writer wired for returnAs:"path"'), { code: RETURN_PATH_WRITE_FAILED });
      }
      const written = writer({
        bytesB64: imageValue.bytes,
        mime: imageValue.mime,
        width: typeof imageValue.width === 'number' ? imageValue.width : 0,
        height: typeof imageValue.height === 'number' ? imageValue.height : 0,
        tool: opts?.tool ?? 'image',
        sessionDir: opts?.sessionDir ?? '',
      });
      const url = written.url ?? opts?.fileUrlFor?.(written.path);
      return {
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ ok: true, path: written.path, mime: written.mime, width: written.width, height: written.height, bytes: written.bytes, ...(url !== undefined ? { url } : {}) }) }],
      };
    } catch (e) {
      const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : RETURN_PATH_WRITE_FAILED;
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, code, message: e instanceof Error ? e.message : String(e) }) }],
      };
    }
  }

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
