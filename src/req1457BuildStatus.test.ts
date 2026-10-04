import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer, type CreateMcpServerOptions } from './mcpServer';

/**
 * REQ-1457 T2 — the published `status` payload (AC-2, AC-3, AC-5, AC-6, AC-7).
 *
 * Driven the way a consumer drives it: a real `@modelcontextprotocol/sdk`
 * `Client` over `InMemoryTransport` around a real `createMcpServer`, with a
 * stub bridge. There is no browser and no Playwright suite in this package, so
 * this is the top tier available — and every assertion below is about a wire
 * payload, which is exactly what it can speak to.
 *
 * **BOTH TOOL MODES, and that is not belt-and-braces.** REQ-1394 established
 * the rule: a rule wired into one mode satisfies the example in one convention
 * only. `status` is registered in both, so both are driven here.
 *
 * **THROUGH THE INJECTABLE SEAM, so no test ever touches the repo's own
 * `dist/`.** `CreateMcpServerOptions.buildStatus` is optional precisely so a
 * test can decide what the build facts are. That is also the only honest way to
 * pin AC-7 deterministically: a unit test must not have to `touch` the repo to
 * observe a stale build. The DEFAULT provider (the real module) is exercised
 * separately below, against the real published field shapes — AC-2 and AC-6's
 * "there is no new runtime dependency" both need a real answer, and neither can
 * come from a stub.
 *
 * The seam is asserted for what it is: a *substitution* of the facts, never a
 * way to make the field optional. Every test below requires `buildStale` to be
 * present and boolean, including the ones that pass no seam at all.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/** The key set `status` returned before this REQ added anything. */
const OLD_KEYS = ['port', 'token', 'url', 'tabConnected', 'contractVersion', 'toolCount'];

interface BridgeLike {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
  getContractVersion?(): string | null;
}

const cleanups: Array<() => Promise<void>> = [];
const bridges: BridgeLike[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn().catch(() => {});
  bridges.length = 0;
});

function stubBridge(overrides: Partial<BridgeLike> = {}): BridgeLike {
  const bridge: BridgeLike = {
    port: 17706,
    token: 'b3f1c2d4-0000-4000-8000-1234567890ab',
    isTabConnected: () => false,
    onDescribe: () => {},
    callTab: async () => ({}),
    close: async () => {},
    ...overrides,
  };
  bridges.push(bridge);
  return bridge;
}

async function connectedClient(bridge: BridgeLike, options?: CreateMcpServerOptions): Promise<Client> {
  const server = createMcpServer(bridge as never, options);
  const client = new Client({ name: 'req-1457-build-status-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function statusOf(client: Client): Promise<any> {
  const result = await client.callTool({ name: 'status', arguments: {} });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  const block = content.find((c) => c.type === 'text');
  expect(block, 'status returns a text content block').toBeDefined();
  return JSON.parse(block!.text!);
}

const TOOL_MODES = ['compact', 'full'] as const;

describe('REQ-1457 AC-2 — status names the serving build', () => {
  for (const toolMode of TOOL_MODES) {
    it(`publishes the package version and a dist build identifier in ${toolMode} mode, from the real module`, async () => {
      // No seam: this is the shipped default, so it must answer without any
      // test-supplied fiction.
      const client = await connectedClient(stubBridge(), { toolMode });
      const s = await statusOf(client);

      expect(
        s.build,
        `status.build exists in ${toolMode} mode — the payload has to describe the code that answered`,
      ).toBeTruthy();
      expect(typeof s.build, 'a nested block, matching the REQ-1394 precedent for a multi-field payload').toBe('object');
      expect(s.build.version, 'the version the server actually runs, not package.json read at runtime').toBe(pkg.version);
      expect(
        String(s.build.buildId),
        'a CONTENT identifier, short enough to read out loud and paste into a search',
      ).toMatch(/^sha256:[0-9a-f]{12}$/);
      expect(s.build.root, 'the build root is named, so an agent can tell which checkout it is looking at').toBeTruthy();
      expect(String(s.build.builtAt), 'when the build was written').toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(
        String(s.build.servedAt),
        'and when THIS process loaded it — the pair is the discriminator a stale process needs',
      ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  }

  it('two servers of different vintages are distinguishable from one status call, not only by handshake', async () => {
    // AC-2's stated purpose. The MCP handshake does publish a version, but a
    // handshake is a one-time event an agent cannot re-read mid-session — which
    // is why this field exists at all.
    const client = await connectedClient(stubBridge(), { toolMode: 'compact' });
    const { tools } = await client.listTools();
    const status = tools.find((t) => t.name === 'status');
    expect(status, 'status is advertised').toBeDefined();
    expect(status!.description ?? '', 'and its description is the only thing tools/list can say').toContain('build');
  });
});

describe('REQ-1457 AC-3 — buildStale is a single boolean over the whole dist build', () => {
  for (const toolMode of TOOL_MODES) {
    it(`is a boolean in ${toolMode} mode — never missing, never a string`, async () => {
      const client = await connectedClient(stubBridge(), { toolMode });
      const s = await statusOf(client);
      expect('buildStale' in s, `the field is present in ${toolMode} mode, not omitted`).toBe(true);
      expect(typeof s.buildStale, 'AC-3: a SINGLE BOOLEAN').toBe('boolean');
    });
  }

  it('reports false while the build on disk is the one this process loaded', async () => {
    const client = await connectedClient(stubBridge(), { toolMode: 'compact' });
    expect((await statusOf(client)).buildStale, 'nothing has changed under the process').toBe(false);
  });

  it('is computed over the covered set the seam reports, read once per call rather than frozen at startup', async () => {
    // Staleness is a LIVE fact. A provider read once at server construction
    // would answer "false" forever, which is the bug in a different costume.
    let stale = false;
    const client = await connectedClient(stubBridge(), {
      toolMode: 'compact',
      buildStatus: () => ({
        build: {
          version: '2.6.0',
          buildId: 'sha256:aaaaaaaaaaaa',
          builtAt: null,
          servedAt: '2026-10-03T00:00:00.000Z',
          root: '/x',
        },
        stale,
      }),
    });
    expect((await statusOf(client)).buildStale).toBe(false);
    stale = true;
    expect((await statusOf(client)).buildStale, 'the next call sees the change').toBe(true);
  });
});

describe('REQ-1457 AC-7 — a build that is not the one recorded reads stale', () => {
  it('with the served build older than what is recorded, status returns it true', async () => {
    // AC-7 in its own words. Pinned through the seam so the direction is a
    // fact of the test rather than a fact about this machine's mtimes.
    const client = await connectedClient(stubBridge(), {
      toolMode: 'compact',
      buildStatus: () => ({
        build: {
          version: '2.6.0',
          buildId: 'sha256:bbbbbbbbbbbb',
          builtAt: null,
          servedAt: '2026-10-03T00:00:00.000Z',
          root: '/x',
        },
        stale: true,
      }),
    });
    const s = await statusOf(client);
    expect(s.buildStale, 'AC-7').toBe(true);
    expect(s.build, 'and the build block is still there — stale is not a replacement for the identity').toBeTruthy();
  });
});

describe('REQ-1457 AC-5 — the six pre-existing fields keep their names and meanings', () => {
  for (const toolMode of TOOL_MODES) {
    it(`the key set in ${toolMode} mode is the old six plus every field a shipped REQ declared`, async () => {
      const client = await connectedClient(stubBridge(), { toolMode });
      const s = await statusOf(client);
      // EXACT, not `toContain`: the point of this assertion is that a key
      // nobody declared still fails. The collection grows on purpose here, and
      // it grows by exactly the named fields below.
      //
      // This REQ added `connection` (REQ-1394) and `build`/`buildStale`.
      // REQ-1492 (c919286) added `bridgeSlots`, `activeConnectionId`, `tab` and
      // `connections` — four more additive keys, each documented in the tool
      // description and each already re-pinned in REQ-1394's own copy of this
      // exact assertion (`req1394StatusDiagnosis.test.ts`), which goes green with
      // them. Declaring them here keeps this row the mechanical net it was
      // written to be; it stays exact, so a future removal, a rename, or a key
      // nobody declared still fails. Do not loosen it to `toContain`.
      expect(Object.keys(s).sort(), `status key set in ${toolMode} mode`).toEqual(
        [
          ...OLD_KEYS,
          'connection',
          'build',
          'buildStale',
          'bridgeSlots',
          'activeConnectionId',
          'tab',
          'connections',
        ].sort(),
      );
    });
  }

  it('every old field still carries its old type and value', async () => {
    const bridge = stubBridge();
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const s = await statusOf(client);
    for (const key of OLD_KEYS) {
      expect(key in s, `${key} is still published`).toBe(true);
    }
    expect(s.port, 'port is the bridge port').toBe(bridge.port);
    expect(s.token, 'token is still the bridge token').toBe(bridge.token);
    expect(s.url, 'url still composes the pairing URL from the bridge port').toContain(`bridgePort=${bridge.port}`);
    expect(typeof s.tabConnected, 'tabConnected is still a boolean, not widened').toBe('boolean');
    expect(s.contractVersion, 'contractVersion is still null with no tab paired').toBeNull();
    expect(s.toolCount, 'compact mode still reports 0 contract tools').toBe(0);
    expect(s.connection, 'REQ-1394’s block is untouched').toBeTruthy();
  });

  it('with a tab paired, contractVersion is still reported from the bridge rather than invented', async () => {
    const bridge = stubBridge({ isTabConnected: () => true, getContractVersion: () => '1.8.0' });
    const client = await connectedClient(bridge, { toolMode: 'compact' });
    const s = await statusOf(client);
    expect(s.contractVersion, 'the pre-existing field still reads through the bridge').toBe('1.8.0');
    expect(s.tabConnected).toBe(true);
  });
});

describe('REQ-1457 — the `status` description names the fields (discoverability)', () => {
  it('tells an agent, from tools/list alone, that build identity is there and when to read it', async () => {
    // `tools/list` is what a model reads when deciding what a tool is for; the
    // README is what a developer reads once something has already gone wrong.
    // A field an agent is never told about is a field nobody reads — the
    // principle REQ-1394 already applied to `connection`.
    const client = await connectedClient(stubBridge(), { toolMode: 'compact' });
    const { tools } = await client.listTools();
    const status = tools.find((t) => t.name === 'status');
    expect(status!.description ?? '', 'the build identity is named').toMatch(/build/);
    expect(status!.description ?? '', 'the staleness flag is named').toContain('buildStale');
    expect(
      status!.description ?? '',
      'and it says WHEN to read it, not just what it is',
    ).toMatch(/stale|older|newer|restart/i);
    expect(
      status!.description ?? '',
      'REQ-1394’s connection clause is preserved, not replaced',
    ).toMatch(/connection|diagnos/i);
  });
});

describe('REQ-1457 AC-6 — the package adds no runtime dependency', () => {
  it('still declares exactly the three runtime dependencies it declared before', () => {
    // A pin, not a hope: everything this REQ adds is a `node:` builtin
    // (`fs`, `path`, `crypto`), so a fourth entry here means a runtime
    // dependency was introduced and the standalone-clone promise is gone.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      ['@modelcontextprotocol/sdk', 'ws', 'zod'].sort(),
    );
  });

  it('the build entry the package ships is unchanged', () => {
    expect(pkg.bin['figpea-mcp']).toBe('dist/cli.js');
    expect(pkg.files, 'only dist is published').toEqual(['dist']);
  });
});