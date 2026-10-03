import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import WebSocket from 'ws';

import { startBridgeServer } from './bridgeServer';
import { createMcpServer } from './mcpServer';
import { resultToContent, type McpTextContentLike } from './tools';

/**
 * REQ-1394 T3 — the published payload, driven the way a consumer drives it
 * (AC-1, AC-2, AC-4, AC-5, AC-6).
 *
 * Harness is the package's own established one, at its strongest tier: a REAL
 * `startBridgeServer()` listener on an OS-assigned port, a REAL `ws` client
 * standing in for the editor tab, a REAL `McpServer` reached through a REAL
 * `@modelcontextprotocol/sdk` `Client` over `InMemoryTransport`. There is no
 * browser and no Playwright suite in this repo, so this is the top tier
 * available — and the assertions below are about wire payloads, which is
 * exactly what it can speak to.
 *
 * WHAT IS BEING PINNED, in the ACs' words:
 *
 *  - AC-1 — after a pairing attempt fails, an agent reading `status` can tell
 *    WHICH failure it was, and the five named states report pairwise-distinct
 *    values. Driven here against real listeners, not against a stub.
 *  - AC-2 — every field `status` returns today means and reads exactly what it
 *    did. So the key set is the old six plus the new one, in both tool modes,
 *    and compact mode's `toolCount === 0` is untouched.
 *  - AC-4 — a `no_tab` refusal carries the same diagnosis on the failing call
 *    itself (no second `status` round trip), on BOTH refusal sites, while its
 *    existing `ok`/`code`/`message`/`url` are unchanged. `resultToContent`
 *    rebuilds the failure object from a whitelist, so the pass-through is
 *    asserted directly too — a call-site-only change would look correct and
 *    ship nothing.
 *  - AC-5 — the counters are per-process: two live bridges hold independent
 *    ledgers.
 *  - AC-3 — the `status` tool description names the field, because a field an
 *    agent is never told about is a field nobody reads.
 *  - AC-6 — the package still stands alone: every import under `src/` is
 *    relative or a declared dependency, so a clone with no sibling `v3/`
 *    builds.
 *
 * State 5 of AC-1 ("wrong port / nothing listening there") is asserted as a
 * COMPOUND difference, and that is the honest form rather than a shortcut: a
 * socket aimed at a dead or foreign address never reaches the process being
 * asked, so nothing observable from inside can separate it from "no tab was
 * ever opened". What separates them is the identity published beside the
 * diagnosis — `port`, `token`, `startedAt` — which an agent compares against
 * the pairing URL it is holding. Hence a second real bridge standing in for
 * the wrong address, and the tab sent to it with the first bridge's token.
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

/** A contract manifest small enough to register one full-mode tool. */
const FIXTURE_MANIFEST = {
  layer: {
    setPosition: {
      doc: 'Move a layer',
      params: { id: { type: 'string', required: true }, pos: { type: 'object', required: true } },
      result: {},
    },
  },
};

const openBridges: Array<{ close(): Promise<void> }> = [];
const openSockets: WebSocket[] = [];
const openRawSockets: net.Socket[] = [];
const cleanupFns: Array<() => Promise<void>> = [];

async function liveBridge(): Promise<Awaited<ReturnType<typeof startBridgeServer>>> {
  const bridge = await startBridgeServer();
  openBridges.push(bridge);
  return bridge;
}

afterEach(async () => {
  // Order matters: the bridge's `close()` waits for its connections to end, so
  // every socket is destroyed BEFORE the listener is asked to close — otherwise
  // a deliberately silent socket would hang its own teardown.
  for (const raw of openRawSockets) raw.destroy();
  openRawSockets.length = 0;
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
  const client = new Client({ name: 'req-1394-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanupFns.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, `${name} returns a text content block`).toBeDefined();
  return JSON.parse(textBlock!.text!);
}

/** The whole `status` payload, exactly as an agent receives it. */
async function statusOf(client: Client): Promise<any> {
  return callToolJson(client, 'status');
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

function waitForClose(ws: WebSocket, timeout = 8000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForClose: timed out')), timeout);
    ws.once('close', (code: number, reasonBuf: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reasonBuf.toString() });
    });
  });
}

/** A real tab that completes the handshake with the bridge's own token. */
async function connectTab(bridge: { port: number; token: string }, helloToken?: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await waitForOpen(ws);
  ws.send(JSON.stringify({ type: 'hello', token: helloToken ?? bridge.token }));
  return ws;
}

/** A raw TCP socket that reaches the port and then says nothing at all. */
function connectSilentSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    openRawSockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** The identity + diagnosis pair an agent actually compares. */
function identityOf(status: any) {
  return { port: status.port, token: status.token, startedAt: status.connection?.startedAt };
}

describe('REQ-1394 AC-1 — the five pairing states report pairwise-distinct values', () => {
  it('no tab was ever opened, a socket never opened, a token rejected, a superseded tab and a wrong address are all told apart', async () => {
    // --- state 1: nothing ever reached this bridge ---
    const bridgeIdle = await liveBridge();
    const idleClient = await connectedClient(bridgeIdle, { toolMode: 'compact' });
    const state1 = await statusOf(idleClient);
    expect(state1.connection.lastEvent, 'nothing was ever attempted').toBe('no_attempt');

    // --- state 2: a socket reached the port and never completed a handshake ---
    const bridgeSilent = await liveBridge();
    await connectSilentSocket(bridgeSilent.port);
    const silentClient = await connectedClient(bridgeSilent, { toolMode: 'compact' });
    const state2 = await eventually(
      async () => {
        const s = await statusOf(silentClient);
        expect(s.connection.lastEvent).toBe('transport_only');
        return s;
      },
      'a silent TCP socket is reported as transport_only',
    );

    // --- state 3: the tab completed the handshake and the token was wrong ---
    const bridgeRejected = await liveBridge();
    const rejectedClient = await connectedClient(bridgeRejected, { toolMode: 'compact' });
    const rejectedTab = await connectTab(bridgeRejected, 'not-the-right-token');
    await expect(waitForClose(rejectedTab)).resolves.toMatchObject({ code: 4001 });
    const state3 = await eventually(
      async () => {
        const s = await statusOf(rejectedClient);
        expect(s.connection.lastEvent).toBe('hello_rejected');
        return s;
      },
      'a rejected token is reported as hello_rejected',
    );

    // --- state 4: a newer tab superseded the first one ---
    const bridgeSuperseded = await liveBridge();
    const supersededClient = await connectedClient(bridgeSuperseded, { toolMode: 'compact' });
    const firstTab = await connectTab(bridgeSuperseded);
    await eventually(
      async () => {
        const s = await statusOf(supersededClient);
        expect(s.connection.lastEvent).toBe('hello_accepted');
        return s;
      },
      'the first tab is accepted',
    );
    await connectTab(bridgeSuperseded);
    await expect(waitForClose(firstTab), 'the older tab is closed as superseded').resolves.toMatchObject({
      code: 4002,
    });
    const state4 = await statusOf(supersededClient);
    expect(state4.connection.lastEvent).toBe('tab_superseded');

    // --- state 5 (compound): the agent was pointed at the wrong address ---
    // A second REAL bridge stands in for the address the tab was actually
    // sent to, and it receives the tab carrying the FIRST bridge's token.
    const bridgePointedAt = await liveBridge();
    const actuallyReached = await liveBridge();
    const pointedClient = await connectedClient(bridgePointedAt, { toolMode: 'compact' });
    const wrongAddressTab = await connectTab(actuallyReached, bridgePointedAt.token);
    await expect(waitForClose(wrongAddressTab)).resolves.toMatchObject({ code: 4001 });
    const state5 = await eventually(
      async () => {
        const s = await statusOf(pointedClient);
        expect(s.connection.lastEvent).toBe('no_attempt');
        return s;
      },
      'the bridge the agent was pointed at reports no attempt',
    );
    const reached = await statusOf(await connectedClient(actuallyReached, { toolMode: 'compact' }));

    // (a) the bridge the agent was pointed at: silent, and its OWN identity.
    expect(state5.connection.upgrades).toBe(0);
    expect(state5.connection.helloRejected).toBe(0);
    expect(identityOf(state5).port).toBe(bridgePointedAt.port);
    expect(identityOf(state5).token).toBe(bridgePointedAt.token);
    expect(typeof identityOf(state5).startedAt, 'it names which run is live').toBe('string');
    // (b) the bridge that actually received the tab: a rejected token, on a
    //     different port.
    expect(reached.connection.lastEvent).toBe('hello_rejected');
    expect(reached.port).not.toBe(state5.port);
    expect(reached.token).not.toBe(state5.token);

    // (c) all five reports are pairwise distinct. The pair that shares a
    //     token (states 1 and 5) is separated by the identity the payload
    //     publishes, which is the whole point of publishing it.
    const fingerprint = (label: string, s: any) =>
      `${label} ${JSON.stringify({ ...s.connection, port: s.port })}`;
    const reports = [
      fingerprint('state1', state1),
      fingerprint('state2', state2),
      fingerprint('state3', state3),
      fingerprint('state4', state4),
      fingerprint('state5', state5),
    ];
    expect(new Set(reports).size, `the five states must be distinguishable:\n${reports.join('\n')}`).toBe(5);
  });

  it('a tab that upgrades and then says nothing is reported as a hello timeout, not as a raw socket (AC-1)', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const tab = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    openSockets.push(tab);
    await waitForOpen(tab); // handshake done, `hello` never sent
    await expect(waitForClose(tab)).resolves.toMatchObject({ code: 4001 });
    const s = await eventually(
      async () => {
        const status = await statusOf(client);
        expect(status.connection.lastEvent).toBe('hello_timeout');
        return status;
      },
      'a silent-but-upgraded socket is reported as hello_timeout',
      20_000,
    );
    expect(s.connection.upgrades, 'the handshake is still counted as an upgrade').toBe(1);
    expect(s.connection.lastCloseCode).toBe(4001);
  }, 30_000);

  it('a tab that disconnects after pairing is reported as disconnected (AC-1)', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const tab = await connectTab(bridge);
    await eventually(
      async () => {
        const s = await statusOf(client);
        expect(s.connection.lastEvent).toBe('hello_accepted');
        return s;
      },
      'the tab pairs',
    );
    tab.close();
    await eventually(
      async () => {
        const s = await statusOf(client);
        expect(s.connection.lastEvent).toBe('disconnected');
        return s;
      },
      'the disconnect is reported',
    );
    const s = await statusOf(client);
    expect(s.tabConnected, 'the pre-existing boolean is still authoritative and still false').toBe(false);
  });

  it('lastEvent is a documented token carrying an actionable next step, whatever the state (AC-3)', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const s = await statusOf(client);
    expect(typeof s.connection.lastEvent, 'the token is a string an agent can branch on').toBe('string');
    expect(typeof s.connection.nextStep, 'and the action is shipped with it').toBe('string');
    expect(s.connection.nextStep.length).toBeGreaterThan(0);
  });
});

describe('REQ-1394 AC-2 — nothing that `status` means today changed', () => {
  const OLD_KEYS = ['port', 'token', 'url', 'tabConnected', 'contractVersion', 'toolCount'];

  for (const toolMode of ['compact', 'full'] as const) {
    it(`the key set in ${toolMode} mode is the old six plus the diagnosis, and no field changed meaning`, async () => {
      const bridge = await liveBridge();
      const client = await connectedClient(bridge, { toolMode });
      const s = await statusOf(client);
      // REQ-1457 grows this set by exactly two named fields (`build`, `buildStale`)
      // — a deliberate re-pin of a collection this requirement is approved to
      // grow. It stays EXACT: a future removal, or a key nobody declared, still
      // fails here. Do not loosen it to `toContain`.
      expect(Object.keys(s).sort(), `status key set in ${toolMode} mode`).toEqual(
        [...OLD_KEYS, 'connection', 'build', 'buildStale'].sort(),
      );
    });
  }

  it('compact mode still reports toolCount 0 and contractVersion null with no tab (AC-2)', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const s = await statusOf(client);
    expect(s.toolCount).toBe(0);
    expect(s.contractVersion).toBeNull();
    expect(s.tabConnected).toBe(false);
    expect(s.url).toContain(`bridgePort=${bridge.port}`);
    expect(s.token).toBe(bridge.token);
  });

  it('tabConnected is still a boolean with its old meaning, and agrees with a live pairing (AC-2)', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    expect(typeof (await statusOf(client)).tabConnected, 'still a boolean, not a widened string').toBe('boolean');
    const tab = await connectTab(bridge);
    const s = await eventually(
      async () => {
        const status = await statusOf(client);
        expect(status.tabConnected).toBe(true);
        return status;
      },
      'the boolean flips when a tab pairs',
    );
    expect(s.connection.lastEvent).toBe('hello_accepted');
    tab.close();
  });

  it('a bridge that cannot report a diagnosis still emits the field, from the legacy boolean alone (AC-2)', async () => {
    const stub: BridgeLike = {
      port: 5555,
      token: 'stub-token',
      isTabConnected: () => false,
      onDescribe: () => {},
      callTab: async () => ({ ok: true, value: null }),
      close: async () => {},
      // deliberately NO getConnectionDiagnosis
    };
    const client = await connectedClient(stub, { toolMode: 'compact' });
    const s = await statusOf(client);
    expect(s.connection, 'the field is never missing').toBeDefined();
    expect(s.connection.lastEvent).toBe('no_attempt');
    expect(s.connection.startedAt, 'and claims nothing about a run it cannot see').toBeNull();
    expect(s.connection.nextStep.length).toBeGreaterThan(0);
  });
});

describe('REQ-1394 AC-4 — the failing call itself carries the cause', () => {
  it('the compact `figpea_call` refusal carries the same diagnosis a `status` call would report (AC-4)', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const tab = await connectTab(bridge, 'wrong-token');
    await expect(waitForClose(tab)).resolves.toMatchObject({ code: 4001 });

    const refusal = await eventually(
      async () => {
        const r = await callToolJson(client, 'figpea_call', { group: 'layer', method: 'setPosition', args: ['a', {}] });
        expect(r.connection).toBeDefined();
        expect(r.connection.lastEvent).toBe('hello_rejected');
        return r;
      },
      'the refusal names the rejected token without a second round trip',
    );
    // The pre-existing fields are untouched — this is additive.
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe('no_tab');
    expect(refusal.message).toBe('No editor tab paired. Open this URL in your browser to connect an editor tab:');
    expect(refusal.url).toBe(`https://editor.figpea.com/?agent=1&bridgePort=${bridge.port}&bridgeToken=${bridge.token}`);
    // ...and it is the identical diagnosis `status` publishes.
    expect(refusal.connection).toEqual((await statusOf(client)).connection);
  });

  it('the full-mode contract-tool refusal carries it too (AC-4)', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, {
      toolMode: 'full',
      prefetchedManifest: FIXTURE_MANIFEST as never,
    });
    const refusal = await callToolJson(client, 'layer_setPosition', { id: 'a', pos: { x: 0, y: 0 } });
    expect(refusal.code).toBe('no_tab');
    expect(refusal.ok).toBe(false);
    expect(refusal.url).toContain(`bridgePort=${bridge.port}`);
    expect(refusal.connection, 'both refusal sites carry it, not just the compact one').toBeDefined();
    expect(refusal.connection.lastEvent).toBe('no_attempt');
    expect(refusal.connection).toEqual((await statusOf(client)).connection);
  });

  it('a `connection` key added at the call site actually reaches the wire (AC-4)', async () => {
    // The guard, asserted at the layer that would otherwise eat it: the failure
    // branch of `resultToContent` REBUILDS the object from a
    // {ok, code, message, url} whitelist, so a field added only at the call
    // site is dropped on the wire while the call-site test still goes green.
    const connection = { lastEvent: 'hello_rejected', nextStep: 'do the thing' };
    const mapped = resultToContent({
      ok: false,
      code: 'no_tab',
      message: 'No editor tab paired.',
      url: 'https://editor.figpea.com/?agent=1&bridgePort=1234&bridgeToken=abc123token',
      connection: connection as never,
    });
    expect(mapped.isError).toBe(true);
    const parsed = JSON.parse((mapped.content[0] as McpTextContentLike).text);
    expect(parsed.connection, 'the diagnosis survives the failure whitelist').toEqual(connection);
    // ...and the fields the whitelist already carried are still carried.
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('no_tab');
    expect(parsed.url).toBe('https://editor.figpea.com/?agent=1&bridgePort=1234&bridgeToken=abc123token');
  });

  it('a failure result with no diagnosis still maps exactly as it did before (AC-2/AC-4)', async () => {
    const mapped = resultToContent({ ok: false, code: 'invalid_params', message: 'bad key' });
    const parsed = JSON.parse((mapped.content[0] as McpTextContentLike).text);
    expect(parsed).toEqual({ ok: false, code: 'invalid_params', message: 'bad key', url: undefined });
  });
});

describe('REQ-1394 AC-5 — the counters belong to THIS process', () => {
  it('two live bridges hold entirely independent ledgers (AC-5)', async () => {
    const bridgeA = await liveBridge();
    const bridgeB = await liveBridge();
    const clientA = await connectedClient(bridgeA, { toolMode: 'compact' });
    const clientB = await connectedClient(bridgeB, { toolMode: 'compact' });

    // Only A ever sees anything.
    const tab = await connectTab(bridgeA, 'wrong-token');
    await expect(waitForClose(tab)).resolves.toMatchObject({ code: 4001 });

    const a = await eventually(
      async () => {
        const s = await statusOf(clientA);
        expect(s.connection.lastEvent).toBe('hello_rejected');
        return s;
      },
      "A records the rejected token",
    );
    const b = await statusOf(clientB);

    expect(b.connection.lastEvent, 'B saw nothing, so B reports nothing').toBe('no_attempt');
    expect(b.connection.upgrades).toBe(0);
    expect(b.connection.helloRejected).toBe(0);
    expect(a.connection.helloRejected).toBe(1);
    // `startedAt` dates B's OWN run rather than labelling A's ledger: it is a
    // real instant no later than now. It is deliberately NOT asserted to
    // differ from A's — two servers started in the same millisecond legitimately
    // share one, and the counters' independence is what AC-5 is about.
    expect(Number.isNaN(Date.parse(identityOf(b).startedAt))).toBe(false);
    expect(Date.parse(identityOf(b).startedAt)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a restart is a new process, so its counters begin at zero again (AC-5)', async () => {
    const first = await liveBridge();
    const client = await connectedClient(first, { toolMode: 'compact' });
    const tab = await connectTab(first, 'wrong-token');
    await expect(waitForClose(tab)).resolves.toMatchObject({ code: 4001 });
    await eventually(
      async () => {
        const s = await statusOf(client);
        expect(s.connection.helloRejected).toBe(1);
        return s;
      },
      'the first run counted the rejection',
    );

    // A second server on a new port stands in for the restart.
    const second = await liveBridge();
    const restarted = await statusOf(await connectedClient(second, { toolMode: 'compact' }));
    expect(restarted.connection.helloRejected, 'nothing is carried over from a previous run').toBe(0);
    expect(restarted.connection.lastEvent).toBe('no_attempt');
  });
});

describe('REQ-1394 AC-3 — an agent is told the field exists', () => {
  it('the `status` tool description names the diagnosis field (AC-3)', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const { tools } = await client.listTools();
    const statusTool = tools.find((t) => t.name === 'status');
    expect(statusTool, 'status is registered').toBeDefined();
    const description = (statusTool as { description?: string }).description ?? '';
    expect(description, 'the tool description names the field').toContain('lastEvent');
  });

  it('the diagnosis block is nested, not flattened into the top level (AC-2)', async () => {
    const bridge = await liveBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const s = await statusOf(client);
    const keys = Object.keys(s.connection);
    expect(keys).toContain('lastEvent');
    expect(keys).toContain('nextStep');
    expect(keys).toContain('startedAt');
    for (const key of keys) {
      expect(Object.prototype.hasOwnProperty.call(s, key), `${key} lives inside the connection block`).toBe(false);
    }
  });
});

describe('REQ-1394 AC-6 — the package stands alone', () => {
  it('every import under src/ is relative or a declared dependency (AC-6)', () => {
    const packageRoot = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const declared = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    const files: string[] = [];
    (function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    })(path.join(packageRoot, 'src'));

    expect(files.length, 'there are source files to check').toBeGreaterThan(0);

    // Anchored to the START of a line, so prose in a docblock is never read as
    // an import — a sentence like "Ordered from \"nothing happened yet\" to …"
    // is not a dependency, and a guard that trips on it is a guard nobody runs.
    const importPattern =
      /^[ \t]*(?:import|export)[^;]*?from[ \t]*['"]([^'"]+)['"]|^[ \t]*import[ \t]*['"]([^'"]+)['"]|\b(?:require|import)\([ \t]*['"]([^'"]+)['"][ \t]*\)/gm;
    let scanned = 0;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? match[2] ?? match[3];
        scanned++;
        if (specifier.startsWith('.')) continue; // in-package
        if (specifier.startsWith('node:')) continue; // Node builtin
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        expect(
          declared.has(packageName),
          `${path.relative(packageRoot, file)} imports undeclared "${specifier}" — the package must build with no sibling checkout`,
        ).toBe(true);
      }
    }
    expect(scanned, 'the scan found import statements to check').toBeGreaterThan(10);
  });
});