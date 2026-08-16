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
}

const DEFAULT_EDITOR_BASE_URL = 'https://editor.figpea.com';
const SERVER_NAME = 'figpea-mcp';
const SERVER_VERSION = '1.8.1';

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

function buildInputShape(tool: GeneratedTool): Record<string, z.ZodTypeAny> | undefined {
  if (tool.inputKeys.length === 0) return undefined;
  const shape: Record<string, z.ZodTypeAny> = {};
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
    const enumValues = tool.paramSchemas?.[key]?.enum;
    shape[key] =
      enumValues && enumValues.length > 0 ? z.enum(enumValues as [string, ...string[]]).optional() : z.any().optional();
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
      const args = inputKeys.map((key) => rawArgs[key]);
      try {
        const result = (await bridge.callTab(groupName, methodName, args)) as FigpeaCallResultLike;
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
    const registeredTool = inputShape
      ? server.registerTool(tool.name, { description: tool.description, inputSchema: inputShape }, (args) =>
          handler(args as Record<string, unknown>),
        )
      : server.registerTool(tool.name, { description: tool.description }, () => handler({}));

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
