/**
 * REQ-1516 T2 — the loopback HTTP door into the same `McpServer`.
 *
 * `figpea-mcp --http` starts the same bridge and the same
 * `createMcpServer(bridge, sameOptions)` as the stdio entry, and serves it
 * over loopback HTTP via the SDK's `StreamableHTTPServerTransport`. AC-3's
 * "identical tools/list and identical envelope" then holds by construction:
 * there is one `McpServer`, one tool surface, one relay — this module owns no
 * tools, no envelope and no relay of its own.
 *
 * STATEFUL transport (one instance, `sessionIdGenerator` set), not stateless —
 * and that is load-bearing, verified against the pinned SDK 1.29.0 rather
 * than assumed from the option name. A stateless transport refuses its second
 * request outright (`webStandardStreamableHttp.js`: "each request must use a
 * fresh transport"), while `Protocol.connect` refuses its second transport
 * ("Already connected to a transport") — so one shared `McpServer` can only
 * serve many requests through ONE stateful transport, whose `mcp-session-id`
 * the SDK client carries automatically. Sessions live in memory beside the
 * bridge, which is exactly their lifetime: a restart ends both.
 *
 * Security posture mirrors `POST /call` (`bridgeServer.ts`):
 *  - the token gate reads `x-figpea-token` from the HEADER only, with the
 *    same 401 `{ok:false, code, message}` shape — a token in a query string
 *    lands in shell history and access logs;
 *  - bind is `BRIDGE_BIND_HOST` (IPv4 loopback only, a security property);
 *  - no CORS headers — the caller is a local process, the tab has its own
 *    WebSocket, and a page on any origin must not drive the document.
 *
 * This module imports no bridge internals: the bridge arrives as a minimal
 * structural handle (port + token + close), the way `mcpServer.ts` declares
 * `BridgeServerHandleLike` rather than importing `bridgeServer.ts`.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BRIDGE_BIND_HOST } from './bridgeHost';

/** The bridge facts this entry needs: where the tab pairs, and the secret. */
export interface HttpMcpBridgeLike {
  readonly port: number;
  readonly token: string;
}

export interface StartHttpMcpEntryOptions {
  /** HTTP listener port; omit (or 0) for an OS-assigned ephemeral port. */
  port?: number;
}

export interface HttpMcpEntry {
  /** The bound listener port, reachable at 127.0.0.1 only. */
  readonly port: number;
  /** Shuts down the listener and the MCP transport. */
  close(): Promise<void>;
}

/**
 * REQ-1503's ceiling, applied to the MCP request body for the same reason:
 * this listener accepts WRITES, so an uncapped body is an unbounded local
 * allocation reachable by anything on the machine.
 */
const MAX_MCP_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Serves an already-connected `McpServer` over loopback HTTP (`POST /mcp`).
 * The server is connected here — `cli.ts` builds it exactly as the stdio
 * path does and hands it over, so the two entries cannot drift.
 */
export async function startHttpMcpEntry(
  server: McpServer,
  bridge: HttpMcpBridgeLike,
  options?: StartHttpMcpEntryOptions,
): Promise<HttpMcpEntry> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  await server.connect(transport);

  function tokenMatches(req: http.IncomingMessage): boolean {
    const presented = req.headers['x-figpea-token'];
    if (typeof presented !== 'string' || presented === '') return false;
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(bridge.token, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    // NO CORS headers here, and that omission is the security property — see
    // the module docblock.
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  function sendUnauthorized(res: http.ServerResponse): void {
    sendJson(res, 401, {
      ok: false,
      code: 'unauthorized',
      message:
        'this route requires the per-run pairing token in the x-figpea-token header — read it from ' +
        'the server’s stderr banner (the “pairing token” line).',
    });
  }

  function readJsonBody(
    req: http.IncomingMessage,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; status: number; code: string; message: string }
  > {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (
        result:
          | { ok: true; value: unknown }
          | { ok: false; status: number; code: string; message: string },
      ): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_MCP_BODY_BYTES) {
          finish({ ok: false, status: 413, code: 'too_large', message: `request body exceeds the ${MAX_MCP_BODY_BYTES}-byte cap for POST /mcp` });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          finish({ ok: false, status: 400, code: 'invalid_body', message: 'the request body is not valid JSON' });
          return;
        }
        finish({ ok: true, value });
      });
      req.on('error', () => {
        finish({ ok: false, status: 400, code: 'invalid_body', message: 'the request body could not be read' });
      });
    });
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname === '/mcp') {
      // The whole MCP method family lives here: POST carries every JSON-RPC
      // message, while GET opens the SSE stream and DELETE ends the session —
      // all three belong to the transport, so all three pass the same gate.
      if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
        sendJson(res, 405, {
          ok: false,
          code: 'method_not_allowed',
          message: 'POST JSON-RPC to /mcp with Content-Type: application/json and the x-figpea-token header',
        });
        return;
      }
      if (!tokenMatches(req)) {
        sendUnauthorized(res);
        return;
      }
      let parsedBody: unknown = undefined;
      if (req.method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { ok: false, code: parsed.code, message: parsed.message });
          return;
        }
        parsedBody = parsed.value;
      }
      try {
        await transport.handleRequest(req, res, parsedBody);
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(res, 500, {
            ok: false,
            code: 'bridge_error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }
    sendJson(res, 404, { ok: false, code: 'not_found' });
  }

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  httpServer.on('error', (err: Error) => {
    console.error('[figpea-mcp] http mcp server error:', err);
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    httpServer.once('error', onErr);
    httpServer.listen(options?.port ?? 0, BRIDGE_BIND_HOST, () => {
      httpServer.removeListener('error', onErr);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('figpea-mcp httpEntry: failed to determine the bound ephemeral port');
  }
  const port = (address as { port: number }).port;

  return {
    port,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await transport.close().catch(() => {});
    },
  };
}
