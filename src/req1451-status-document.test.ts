import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import WebSocket from 'ws';

import { startBridgeServer } from './bridgeServer';
import { createMcpServer } from './mcpServer';

/**
 * REQ-1451 T5/T6 — `figpea_status` reports the active document (AC-1's status
 * half, AC-4, AC-6, AC-7's README half is in `readme.test.ts`).
 *
 * WHY THIS FILE AND NOT A v3 PLAYWRIGHT SPEC. `figpea_status` is registered
 * solely in `figpea-mcp/src/mcpServer.ts`; `figpea-mcp` is absent from
 * `v3/package.json` and `v3/playwright.config.ts` serves only `./static`, so no
 * v3 spec can reach this tool. The card's AC-1 is therefore SPLIT: the tab-side
 * observable is proven by `v3/src/tests/browser/req-1451-document-identity.spec.ts`
 * and this file proves the status side. Both halves are recorded; neither is
 * dropped.
 *
 * HARNESS — the package's own top-tier one, the REQ-1394 shape: a REAL
 * `startBridgeServer()` listener on an OS-assigned port, a REAL `ws` client
 * standing in for the editor tab (which answers `session.document` frames
 * itself, so the relay path is real too), and a REAL `McpServer` reached
 * through a REAL SDK `Client` over `InMemoryTransport`. There is no browser and
 * no Playwright suite in this repo, so this is the strongest tier available,
 * and every assertion below is about a wire payload, which is exactly what it
 * can speak to.
 *
 * AC-4's own words: "figpea_status() reports the active document identifier,
 * so a caller can detect a swap that happened between two calls WITHOUT issuing
 * a mutation first." The `without a mutation first` clause is the load-bearing
 * one, so the swap case below is driven by the FAKE TAB changing what it
 * answers and nothing else — no contract call happens between the two `status`
 * reads except the status call's own document read.
 *
 * DEGRADATION IS TOTAL AND SILENT (the plan's AC-4 decision). `document` is
 * `null` — never an error, never a hang — with no tab paired, with a tab that
 * predates `session.document` (a NORMAL state: this package self-syncs its
 * contract at runtime by origin fetch, so a newer MCP against an older editor
 * is ordinary), and on a bounded-call timeout. Each of those three is a real
 * harness state below, not a mock.
 *
 * RED on the unfixed tree: `status` carries no `document` key at all, so every
 * assertion in the first two describes fails as a plain mismatch
 * (`undefined` where `{id,name}` is expected) and the key-set assertions fail
 * on the missing member. T6 makes it green.
 */

interface BridgeLike {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
  getContractVersion?(): string | null;
  getConnectionDiagnosis?(): unknown;
}

const openBridges: Array<{ close(): Promise<void> }> = [];
const openSockets: WebSocket[] = [];
const cleanupFns: Array<() => Promise<void>> = [];

async function liveBridge(): Promise<Awaited<ReturnType<typeof startBridgeServer>>> {
  const bridge = await startBridgeServer();
  openBridges.push(bridge);
  return bridge;
}

afterEach(async () => {
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  openSockets.length = 0;
  for (const bridge of openBridges.splice(0)) {
    await bridge.close().catch(() => {});
  }
  for (const fn of cleanupFns.splice(0)) await fn().catch(() => {});
});

async function connectedClient(bridge: BridgeLike, options?: Record<string, unknown>): Promise<Client> {
  const server = createMcpServer(bridge as never, options as never);
  const client = new Client({ name: 'req-1451-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanupFns.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function statusOf(client: Client): Promise<any> {
  const result = await client.callTool({ name: 'status', arguments: {} });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, 'status returns a text content block').toBeDefined();
  return JSON.parse(textBlock!.text!);
}

/** Polls until `probe` stops throwing, so no assertion depends on a sleep. */
async function eventually<T>(probe: () => Promise<T>, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await probe();
    } catch (err) {
      lastError = err;
      if (Date.now() > deadline) throw new Error(`${label}: ${String(lastError)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

/** What the fake tab reports, and whether/how it answers at all. */
interface TabBehaviour {
  /** Answered document identity; `undefined` means "this tab has no session.document". */
  document?: { documentId: string; documentName: string };
  /** Never answer a `session.document` call at all (the wedged-tab case). */
  silent?: boolean;
  /** Calls this tab received, so a test can assert what did and did not happen. */
  readonly calls: string[];
}

/**
 * A REAL paired tab. It completes the handshake with the bridge's own token
 * and then answers `session.document` frames itself, so the assertion exercises
 * the whole relay path (frame out, id correlation, frame back) rather than a
 * stubbed `callTab`.
 */
async function connectTab(
  bridge: { port: number; token: string },
  behaviour: TabBehaviour,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await waitForOpen(ws);
  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  ws.on('message', (raw) => {
    let frame: any;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame?.type !== 'call') return;
    const name = `${frame.group}.${frame.method}`;
    behaviour.calls.push(name);
    if (frame.group === 'session' && frame.method === 'document') {
      if (behaviour.silent) return; // wedged: never answer
      if (!behaviour.document) {
        // A tab that predates the method: it has no such contract method.
        ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: false, code: 'not_found', message: 'no such method' }));
        return;
      }
      ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: behaviour.document }));
    }
  });
  return ws;
}

/** Waits until the fake tab has paired (so `tabConnected` is true). */
async function pairedStatus(client: Client): Promise<any> {
  return eventually(
    async () => {
      const s = await statusOf(client);
      expect(s.tabConnected, 'the tab has paired').toBe(true);
      return s;
    },
    'the tab pairs',
  );
}

// ── AC-4 — the identity is reported ─────────────────────────────────────────

describe('REQ-1451 AC-4 — status names the active document', () => {
  it('reports the active document identity, and a swap changes it with no mutation in between', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'full' });
    const behaviour: TabBehaviour = {
      document: { documentId: 'doc-a', documentName: 'Design A' },
      calls: [],
    };
    await connectTab(bridge, behaviour);

    const inA = await pairedStatus(client);
    expect(inA.document, 'AC-4: status carries the active document').toEqual({
      id: 'doc-a',
      name: 'Design A',
    });

    // THE SWAP. The tab starts answering with a different design, and nothing
    // else happens: no contract mutation is issued, which is precisely the
    // "without issuing a mutation first" clause of AC-4.
    behaviour.document = { documentId: 'doc-b', documentName: 'Design B' };
    const inB = await statusOf(client);

    expect(inB.document, 'AC-4: the swap is visible on the next status call').toEqual({
      id: 'doc-b',
      name: 'Design B',
    });
    expect(inB.document.id, 'and it genuinely differs').not.toBe(inA.document.id);
    // The only tab calls this whole test caused are the document reads.
    expect([...new Set(behaviour.calls)], 'no mutation was issued between the two reads').toEqual([
      'session.document',
    ]);
  });

  it('the tool description names the field — a field an agent is never told about is one nobody reads', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const listed = await client.listTools();
    const status = listed.tools.find((t) => t.name === 'status');
    expect(status, 'status is registered').toBeDefined();
    expect(status!.description ?? '', 'the description documents the new field').toMatch(/\bdocument\b/);
  });
});

// ── AC-4's degradation clause — total, silent, never a hang ─────────────────

describe('REQ-1451 AC-4 — document is null, never an error and never a hang', () => {
  it('null with no tab paired, and every pre-existing key keeps its meaning', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const s = await statusOf(client);
    expect(s.tabConnected, 'no tab').toBe(false);
    expect(s.document, 'AC-4: null, exactly as contractVersion is null with no tab').toBeNull();
    expect(s.contractVersion, 'the pre-existing null convention is untouched').toBeNull();
    expect(typeof s.port, 'port still a number').toBe('number');
    expect(typeof s.url, 'url still a string').toBe('string');
    expect(s.connection, 'REQ-1394 diagnosis still present').toBeTruthy();
  });

  it('null against an OLDER tab that has no session.document — a normal state, not an error', async () => {
    // `figpea-mcp` self-syncs its contract at runtime by origin fetch, so a
    // newer MCP paired with an older editor is ORDINARY. Treating it as a
    // failure would break a supported combination.
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const behaviour: TabBehaviour = { calls: [] }; // no `document` → predates it
    await connectTab(bridge, behaviour);

    const s = await pairedStatus(client);
    expect(s.document, 'AC-4: degrades to null rather than erroring').toBeNull();
    expect(behaviour.calls, 'and it did try — this is not a silent skip').toContain('session.document');
  });

  it('null on a bounded-call timeout: status never blocks on a wedged tab', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const behaviour: TabBehaviour = { document: { documentId: 'doc-a', documentName: 'Design A' }, silent: true, calls: [] };
    await connectTab(bridge, behaviour);
    await pairedStatus(client);

    // The tab never answers. `status` must still come back, and promptly — the
    // plan's requirement is a SHORT bounded call, not the 60 s flat default,
    // because status is what an agent calls when something is already wrong.
    const started = Date.now();
    const s = await statusOf(client);
    const elapsed = Date.now() - started;
    expect(s.document, 'AC-4: null on timeout, never an error').toBeNull();
    expect(s.tabConnected, 'and the pre-existing boolean still reports the pairing').toBe(true);
    expect(elapsed, `bounded: the call returned in ${elapsed}ms, not after the 60s default`).toBeLessThan(15_000);
  }, 30_000);
});

// ── AC-6 — the six pre-existing keys keep their REQ-1394 meanings ────────────

describe('REQ-1451 AC-6 — status is additive', () => {
  for (const toolMode of ['compact', 'full'] as const) {
    it(`the key set in ${toolMode} mode is REQ-1394's plus document, and no field changed meaning`, async () => {
      const bridge = await liveBridge();
      const client = await connectedClient(bridge, { toolMode });
      const s = await statusOf(client);
      // REQ-1394 AC-2's promise — "no existing field changed meaning" — is
      // preserved: the same six keys plus its own `connection` diagnosis, plus
      // this requirement's one additive key.
      //
      // The set is EXACT, and an EXACT set has to name every real member. Keys
      // this requirement did not add are listed anyway, each with the REQ that
      // added it, and dropping one would make this row pass for the wrong reason
      // — a key nobody declared must fail, not quietly go unasserted:
      //   connection                            REQ-1394
      //   build, buildStale                     REQ-1457
      //   bridgeSlots, activeConnectionId,
      //     tab, connections                   REQ-1492
      //   liveness                              REQ-1503
      //   document                              this requirement
      // All three copies of this pin —
      // `req1394StatusDiagnosis.test.ts`, `req1457BuildStatus.test.ts` and this
      // file — must name the same keys, or one of them is red for a reason that
      // has nothing to do with the requirement it belongs to.
      expect(Object.keys(s).sort(), `status key set in ${toolMode} mode`).toEqual(
        [
          'port',
          'token',
          'url',
          'tabConnected',
          'contractVersion',
          'toolCount',
          'connection',
          'build',
          'buildStale',
          'bridgeSlots',
          'activeConnectionId',
          'tab',
          'connections',
          'liveness',
          'document',
        ].sort(),
      );
      // …and each still means what it meant.
      expect(typeof s.port).toBe('number');
      expect(typeof s.token).toBe('string');
      expect(typeof s.url).toBe('string');
      expect(typeof s.tabConnected, 'still a boolean, not widened').toBe('boolean');
      expect(typeof s.connection.lastEvent).toBe('string');
      if (toolMode === 'compact') expect(s.toolCount, 'compact mode still 0').toBe(0);
    });
  }

  it('the payload stays JSON-serializable with a document attached', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'full' });
    await connectTab(bridge, { document: { documentId: 'doc-a', documentName: 'Design A' }, calls: [] });
    const s = await pairedStatus(client);
    expect(() => JSON.parse(JSON.stringify(s)), 'no live references cross the boundary').not.toThrow();
    expect(s.document).toEqual({ id: 'doc-a', name: 'Design A' });
  });
});
