import { describe, it, expect } from 'vitest';

/**
 * REQ-074 T1 — `buildToolsFromManifest` pure mapping (plan §1, §6; AC-4).
 *
 * `tools.ts` does not exist yet (T3 builds it) — every test below fails at
 * this file's own import statement ("Cannot find module './tools'"), never
 * inside an assertion. That is the intended RED: this file pins the exact
 * data-in/data-out contract T3 must implement.
 *
 * ASSUMPTIONS (the plan pins the *rules*, not exact export names/shapes —
 * best judgment below; a builder either conforms or pushes back to the
 * planner with the concrete shape it needs instead):
 *   - `buildToolsFromManifest(manifest: ManifestLike): GeneratedTool[]` where
 *     `GeneratedTool = { name: string; description: string; inputKeys: string[] }`.
 *     Deliberately NOT the SDK's Zod-schema tool-registration shape — plan
 *     §1 says the *server* (mcpServer.ts) maps `inputKeys` to permissive Zod
 *     schemas at registration time; `tools.ts` itself stays dependency-free
 *     (no zod import), so its output is plain data.
 *   - A second pure export, `resultToContent(result: FigpeaCallResultLike):
 *     { content: McpContentBlockLike[]; isError: boolean }`, implementing
 *     plan §1's runtime result -> MCP content mapping (OQ-D). Content blocks
 *     mirror the MCP SDK's own `TextContent`/`ImageContent` shapes
 *     (`{type:'text',text}` / `{type:'image',data,mimeType}` — verified
 *     against `@modelcontextprotocol/sdk`'s `types.js`) so mcpServer.ts can
 *     pass them straight through to a `CallToolResult`.
 */

interface ManifestMethodDescriptorLike {
  doc: string;
  params?: Record<string, unknown>;
  result?: unknown;
}
type ManifestLike = Record<string, Record<string, ManifestMethodDescriptorLike>>;

interface GeneratedTool {
  name: string;
  description: string;
  inputKeys: string[];
}

type FigpeaCallResultLike =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message?: string };

interface McpTextContentLike {
  type: 'text';
  text: string;
}
interface McpImageContentLike {
  type: 'image';
  data: string;
  mimeType: string;
}
type McpContentBlockLike = McpTextContentLike | McpImageContentLike;

interface MappedToolResultLike {
  content: McpContentBlockLike[];
  isError: boolean;
}

// Import path resolves once T3 creates packages/figpea-mcp/src/tools.ts;
// until then this import itself is the RED (module not found).
import { buildToolsFromManifest, resultToContent } from './tools';

const SAMPLE_MANIFEST: ManifestLike = {
  session: {
    newProject: {
      doc: 'Creates a new, empty design project and makes it the active session.',
      result: { id: 'string' },
    },
    setSelection: {
      doc: "Sets the active session's current selection to the given layer ids.",
      params: { ids: 'string[]' },
      result: 'void',
    },
  },
  layer: {
    move: {
      // Deliberately declared out of alphabetical order (dx before dy before
      // id would sort the same either way, so use a case where "params"
      // declaration order and alphabetical order genuinely diverge) --
      // move(id, dx, dy) is the real REQ-072 layer.descriptor.ts order.
      doc: 'Pans a layer by a local delta (dx, dy).',
      params: { id: 'string', dx: 'number', dy: 'number' },
      result: 'void',
    },
  },
  canvas: {
    screenshot: {
      doc: 'Renders the current canvas/artboard to PNG bytes.',
      params: { id: 'string?', pixelRatio: 'number?' },
      result: { bytes: 'string (base64 png)', mime: "'image/png'", width: 'number', height: 'number' },
    },
  },
};

describe('buildToolsFromManifest (REQ-074 T1, plan §1)', () => {
  it('produces exactly one tool per manifest method, named `${group}_${method}`', () => {
    const tools = buildToolsFromManifest(SAMPLE_MANIFEST);
    const names = tools.map((t: GeneratedTool) => t.name).sort();
    expect(names).toEqual(
      ['session_newProject', 'session_setSelection', 'layer_move', 'canvas_screenshot'].sort(),
    );
  });

  it('is deterministic and total — re-running on the same manifest yields the identical set', () => {
    const first = buildToolsFromManifest(SAMPLE_MANIFEST).map((t: GeneratedTool) => t.name).sort();
    const second = buildToolsFromManifest(SAMPLE_MANIFEST).map((t: GeneratedTool) => t.name).sort();
    expect(second).toEqual(first);
  });

  it("each tool's description embeds the method's doc verbatim", () => {
    const tools = buildToolsFromManifest(SAMPLE_MANIFEST);
    const move = tools.find((t: GeneratedTool) => t.name === 'layer_move');
    expect(move, 'layer_move tool exists').toBeDefined();
    expect(move!.description).toContain(SAMPLE_MANIFEST.layer.move.doc);
  });

  it('input keys equal Object.keys(descriptor.params ?? {}) in declaration order', () => {
    const tools = buildToolsFromManifest(SAMPLE_MANIFEST);
    const move = tools.find((t: GeneratedTool) => t.name === 'layer_move')!;
    // move's descriptor declares params as { id, dx, dy } -- order-sensitive,
    // not re-sorted alphabetically (dx/dy/id would differ from id/dx/dy).
    expect(move.inputKeys).toEqual(['id', 'dx', 'dy']);

    const setSelection = tools.find((t: GeneratedTool) => t.name === 'session_setSelection')!;
    expect(setSelection.inputKeys).toEqual(['ids']);
  });

  it('a method with no params produces an empty inputKeys array (zero-argument call)', () => {
    const tools = buildToolsFromManifest(SAMPLE_MANIFEST);
    const newProject = tools.find((t: GeneratedTool) => t.name === 'session_newProject')!;
    expect(newProject.inputKeys).toEqual([]);
  });

  it('a method whose only params key sorts after others in the alphabet still preserves declaration order', () => {
    // Regression guard against an implementation that (incorrectly) sorts
    // keys instead of preserving Object.keys() insertion order.
    const manifest: ManifestLike = {
      layer: {
        resize: {
          doc: 'Resizes a layer to an absolute local target size.',
          // Declared id, then size -- "size" > "id" alphabetically anyway,
          // so also exercise a case where alphabetical sort would visibly
          // differ: a reversed-name pair.
          params: { zebra: 'string', apple: 'string' },
          result: 'void',
        },
      },
    };
    const tools = buildToolsFromManifest(manifest);
    expect(tools[0].inputKeys).toEqual(['zebra', 'apple']);
  });

  it('every manifest group/method is covered and no extra tools are synthesized', () => {
    const tools = buildToolsFromManifest(SAMPLE_MANIFEST);
    const expectedCount = Object.values(SAMPLE_MANIFEST).reduce(
      (sum, group) => sum + Object.keys(group).length,
      0,
    );
    expect(tools).toHaveLength(expectedCount);
  });

  it('an empty manifest produces an empty tool list (total, never throws)', () => {
    expect(buildToolsFromManifest({})).toEqual([]);
  });
});

/**
 * REQ-093 T1 — AC-4 (docs/plans/REQ-093.md, Use cases -> test mapping:
 * "Generated tools carry enums/required through (schema data +
 * description)"). `GeneratedTool` today is `{name, description, inputKeys}`
 * — no per-param schema data at all, so the manifest's new structured
 * `ParamSchema` values (enum/required, T2) are dropped entirely once T3/T5
 * thread them through. RED today: `paramSchemas` does not exist on the
 * returned tool, and the description embeds only `JSON.stringify(descriptor.params)`
 * verbatim via `describeShape` (tools.ts:38-47) — happens to already
 * mention the enum's string VALUES incidentally (since JSON.stringify of the
 * raw params object includes them), so the description assertion below may
 * already pass; the `paramSchemas` assertion is the one that pins the
 * missing structured carry-through.
 *
 * ASSUMPTIONS (the plan says "extend GeneratedTool to carry per-param schema
 * (enum/required)" but does not pin the exact new field name — this suite's
 * best-judgment contract, mirroring this file's own established convention
 * above; a builder either conforms or pushes back to the planner with the
 * concrete shape it needs instead):
 *   - `GeneratedTool.paramSchemas?: Record<string, { type: string; required: boolean; enum?: string[] }>`
 *     — a new, optional field alongside `inputKeys`, keyed by param name,
 *     carrying each param's real `ParamSchema` object straight through.
 */
interface ParamSchemaLike {
  type: string;
  required: boolean;
  enum?: string[];
}
type GeneratedToolWithSchemas = GeneratedTool & { paramSchemas?: Record<string, ParamSchemaLike> };

describe('REQ-093 AC-4: generated tools carry per-param schema (enum/required) through', () => {
  const MANIFEST_WITH_ENUM: ManifestLike = {
    layer: {
      reorder: {
        doc: 'Moves a layer to a sibling position relative to a target layer (before/on/after).',
        params: {
          id: { type: 'string', required: true },
          targetId: { type: 'string', required: true },
          pos: { type: 'string', required: true, enum: ['before', 'on', 'after'] },
        },
      },
    },
  };

  it("carries each param's structured schema (incl. enum/required) onto the generated tool, keyed by param name", () => {
    const tools = buildToolsFromManifest(MANIFEST_WITH_ENUM) as GeneratedToolWithSchemas[];
    const reorder = tools.find((t) => t.name === 'layer_reorder');
    expect(reorder, 'layer_reorder tool exists').toBeDefined();
    expect(reorder!.paramSchemas, 'GeneratedTool carries a paramSchemas map (REQ-093 T5)').toBeDefined();
    expect(reorder!.paramSchemas!.pos?.enum, 'pos param schema carries its enum through').toEqual([
      'before',
      'on',
      'after',
    ]);
    expect(reorder!.paramSchemas!.pos?.required, 'pos param schema carries its required flag through').toBe(true);
  });

  it("embeds the enum values in the tool's description text", () => {
    const tools = buildToolsFromManifest(MANIFEST_WITH_ENUM) as GeneratedToolWithSchemas[];
    const reorder = tools.find((t) => t.name === 'layer_reorder')!;
    for (const value of ['before', 'on', 'after']) {
      expect(reorder.description, `description mentions enum value "${value}"`).toContain(value);
    }
  });
});

describe('resultToContent — runtime result -> MCP content mapping (plan §1 OQ-D)', () => {
  it('a success result maps to JSON text content with isError:false', () => {
    const mapped = resultToContent({ ok: true, value: { id: 'layer-1' } });
    expect(mapped.isError).toBe(false);
    expect(mapped.content).toHaveLength(1);
    expect(mapped.content[0].type).toBe('text');
    const parsed = JSON.parse((mapped.content[0] as McpTextContentLike).text);
    expect(parsed).toEqual({ ok: true, value: { id: 'layer-1' } });
  });

  it('a structured error result maps to JSON text content with isError:true, preserving code and message', () => {
    const mapped = resultToContent({ ok: false, code: 'not_found', message: 'layer "x" not found' });
    expect(mapped.isError).toBe(true);
    expect(mapped.content).toHaveLength(1);
    expect(mapped.content[0].type).toBe('text');
    const parsed = JSON.parse((mapped.content[0] as McpTextContentLike).text);
    expect(parsed.code).toBe('not_found');
    expect(parsed.message).toBe('layer "x" not found');
  });

  it('a success value shaped {bytes, mime:"image/*"} maps to MCP image content plus a text summary', () => {
    const mapped = resultToContent({
      ok: true,
      value: { bytes: 'QUJDRA==', mime: 'image/png', width: 12, height: 8 },
    });
    expect(mapped.isError).toBe(false);
    const imageBlock = mapped.content.find((c: McpContentBlockLike) => c.type === 'image') as McpImageContentLike | undefined;
    expect(imageBlock, 'an image content block is present').toBeDefined();
    expect(imageBlock!.data).toBe('QUJDRA==');
    expect(imageBlock!.mimeType).toBe('image/png');
    const textBlock = mapped.content.find((c: McpContentBlockLike) => c.type === 'text');
    expect(textBlock, 'a short text summary accompanies the image').toBeDefined();
  });

  it('the image-content rule generalizes across image/* mime types (e.g. image/jpeg), not just png', () => {
    const mapped = resultToContent({
      ok: true,
      value: { bytes: 'Zm9vYmFy', mime: 'image/jpeg' },
    });
    const imageBlock = mapped.content.find((c: McpContentBlockLike) => c.type === 'image') as McpImageContentLike | undefined;
    expect(imageBlock!.mimeType).toBe('image/jpeg');
  });

  it('a plain (non-image) success value never produces an image content block', () => {
    const mapped = resultToContent({ ok: true, value: { id: 'abc' } });
    expect(mapped.content.some((c: McpContentBlockLike) => c.type === 'image')).toBe(false);
  });

  it('passes an optional url field through an {ok:false} result unchanged', () => {
    const mapped = resultToContent({
      ok: false,
      code: 'no_tab',
      message: 'No tab paired',
      url: 'https://editor.figpea.com/?agent=1&bridgePort=1234&bridgeToken=tok',
    });
    expect(mapped.isError).toBe(true);
    const parsed = JSON.parse((mapped.content[0] as McpTextContentLike).text);
    expect(parsed.url).toBe('https://editor.figpea.com/?agent=1&bridgePort=1234&bridgeToken=tok');
  });
});
