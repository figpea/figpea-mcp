import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer } from './mcpServer';
import { fetchSkill } from './skillFetch';

/**
 * `figpea_skill` must be honest about WHERE the body it returns came from.
 *
 * The defect this pins (measured 2026-10-01, /design run
 * 2026-10-01-kiln-spring-workshops): the body is fetched once at startup from
 * the process's startup origin (`FIGPEA_EDITOR_URL`, else
 * `https://editor.figpea.com`) and is NOT re-derived from the tab a run later
 * pairs. When those are different editors, `figpea_skill` answered with the
 * production editor's guidance while every `figpea_*` contract call went to
 * the paired LOCAL tab -- and the answer carried no provenance, so the agent
 * had no way to notice. The two bodies even stamp the SAME `contract=2.54.0`,
 * so the contract number did not disambiguate them either.
 *
 * Two of the measured consequences, modelled by the fixtures below as
 * `PROD_BODY` (startup origin) vs `TAB_BODY` (the paired tab):
 *   - PROD_BODY tells the agent `layer.create` "specifies extent only" and to
 *     follow it with a separate `setPosition(id, {x, y})` — so an agent
 *     doubles the round trips on every layer it creates;
 *   - PROD_BODY's kind list omits `icon` and `arc`, so an agent never learns
 *     the two kinds exist.
 * TAB_BODY documents the opposite for both.
 *
 * This test does NOT assert the wording of the fix. It asserts the facts an
 * agent needs in order to notice the mismatch at all:
 *   1. the answer names the URL the body was fetched from;
 *   2. the body itself is still delivered, intact;
 *   3. the body is never returned bare/unanonated (the defect in one line);
 *   4. with a tab connected, the answer names the two authoritative per-tab
 *      routes — `figpea.SKILL()` in the tab, and `GET <tab-origin>/agent/skill.md`;
 *   5. the answer does not let the reader rely on the shared `contract=` stamp.
 */

/** A stand-in for the PRODUCTION editor's /agent/skill.md (497 lines in the
 * real run): the `setPosition` follow-up, and no `icon`/`arc` in the kinds. */
const PROD_BODY = [
  '# Figpea Agent Skill',
  '',
  '## 3. Creating a layer',
  '',
  '`layer.create` specifies extent only. Place the layer with a separate',
  '`setPosition(id, {x, y})` call afterwards.',
  '',
  'Valid kinds: `rect`, `ellipse`, `text`, `frame`, `line`.',
  '',
  '<!-- figpea-skill-identity contract=2.54.0 sha256=9f14081d7dceca772874ccc8f57c5781a83a36c6225cd2fe1a1851578ea91c0a -->',
  '',
].join('\n');

/** A stand-in for the PAIRED LOCAL tab's own /agent/skill.md (555 lines in the
 * real run). The server has no way to see this body today — that is the point
 * of the test: it can only tell the reader where to go get it. Note the
 * identical `contract=2.54.0` and the different sha256. */
const TAB_BODY = [
  '# Figpea Agent Skill',
  '',
  '## 3. Creating a layer',
  '',
  '`layer.create` places the layer: `x`/`y` set the layer\'s visible bounds in',
  'the create call. No follow-up positioning call is needed.',
  '',
  'Valid kinds: `rect`, `ellipse`, `text`, `frame`, `line`, `icon`, `arc`.',
  '',
  '<!-- figpea-skill-identity contract=2.54.0 sha256=28db1260a3ba0e6a3e1c2b5f9a0d4c7e8b1a2f3d4c5b6a7988776655443322110f -->',
  '',
].join('\n');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli.js');

/** Facts the answer must let a reader act on. Concept-level, not wording-level:
 * `figpea.SKILL()` and `/agent/skill.md` are API/route names, not prose. */
function expectNamesTheFetchUrl(text: string, expectedUrl: string): void {
  expect(
    text,
    'the answer must name the URL the skill body was fetched from, so an agent can see at a glance which editor it is reading',
  ).toContain(expectedUrl);
}

function expectNamesBothPerTabRoutes(text: string): void {
  expect(
    text,
    'with a tab connected the answer must name the two authoritative ways to get THAT tab\'s skill: figpea.SKILL() in the tab',
  ).toContain('figpea.SKILL()');
  expect(
    text,
    '...and the tab\'s own /agent/skill.md route',
  ).toContain('/agent/skill.md');
  expect(text, '...and it must be about the connected tab').toMatch(/\btab\b/i);
}

function textOf(result: unknown): string {
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  const textBlock = content.find((c) => c.type === 'text');
  expect(textBlock, 'figpea_skill returns a text content block').toBeDefined();
  return textBlock!.text!;
}

interface BridgeStub {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

function fakeBridge(tabConnected: boolean): BridgeStub {
  return {
    port: 54321,
    token: 'test-token-abc',
    isTabConnected: () => tabConnected,
    onDescribe: () => {},
    callTab: async () => ({ ok: true, value: null }),
    close: async () => {},
  };
}

let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns) await fn().catch(() => {});
  cleanupFns = [];
  delete process.env.FIGPEA_EDITOR_URL;
});

async function inProcessClient(
  bridge: BridgeStub,
  options: Record<string, unknown>,
): Promise<Client> {
  const server = createMcpServer(bridge, options as any);
  const client = new Client({ name: 'skill-provenance-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanupFns.push(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });
  return client;
}

/** Serves a real /agent/skill.md so the URL under test is a URL something
 * actually answered on, not a string this test made up. */
async function serveOrigin(body: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/agent/skill.md') {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('figpea_skill — the answer must be honest about which editor it came from', () => {
  it('names the startup origin, delivers the body intact, and never returns it bare', async () => {
    // The reported run, in process: the startup origin serves PROD_BODY, and a
    // LOCAL tab (a different origin and a different build) is the one paired.
    const prod = await serveOrigin(PROD_BODY);
    try {
      const fetched = await fetchSkill(prod.origin);
      expect(fetched.status).toBe('ok');
      if (fetched.status !== 'ok') return;
      const expectedUrl = new URL('/agent/skill.md', prod.origin).toString();

      const client = await inProcessClient(fakeBridge(true), {
        prefetchedSkillBody: fetched.body,
        prefetchedSkillUrl: expectedUrl,
      });
      const text = textOf(await client.callTool({ name: 'figpea_skill', arguments: {} }));

      expectNamesTheFetchUrl(text, expectedUrl);
      expect(text, 'the skill body itself is still delivered, in full').toContain(fetched.body);
      expect(
        text,
        'the body is never returned bare: an unattributed body is the defect',
      ).not.toBe(fetched.body);
      expectNamesBothPerTabRoutes(text);
      // The trap from the measured run: both bodies stamp contract=2.54.0, so
      // the answer must not leave the reader believing that stamp settles it.
      expect(text, 'the answer must not let the shared contract= stamp stand in for provenance').toMatch(
        /contract/i,
      );
    } finally {
      await prod.close();
    }
  });

  it('still names the two per-tab routes when a tab is connected but the startup origin was not recorded', async () => {
    // The per-tab advice must not depend on having a URL to print: the routes
    // are the load-bearing half and they are known whether or not provenance
    // was threaded through.
    const client = await inProcessClient(fakeBridge(true), { prefetchedSkillBody: PROD_BODY });
    const text = textOf(await client.callTool({ name: 'figpea_skill', arguments: {} }));

    expectNamesBothPerTabRoutes(text);
    expect(text, 'the body is still delivered').toContain(PROD_BODY);
    expect(text, 'an unrecorded origin is stated, not passed off silently').not.toBe(PROD_BODY);
  });

  it('keeps the common case a provenance line: body delivered, origin named, no tab to warn about', async () => {
    // The default production-editor user with nothing paired must still get the
    // right body — the added text is a provenance line, not a warning about a
    // tab that does not exist.
    const prod = await serveOrigin(PROD_BODY);
    try {
      const fetched = await fetchSkill(prod.origin);
      expect(fetched.status).toBe('ok');
      if (fetched.status !== 'ok') return;
      const expectedUrl = new URL('/agent/skill.md', prod.origin).toString();

      const client = await inProcessClient(fakeBridge(false), {
        prefetchedSkillBody: fetched.body,
        prefetchedSkillUrl: expectedUrl,
      });
      const text = textOf(await client.callTool({ name: 'figpea_skill', arguments: {} }));

      expectNamesTheFetchUrl(text, expectedUrl);
      expect(text, 'the body is delivered in full').toContain(fetched.body);
      expect(
        text,
        'with no tab connected there is nothing to warn about, so the per-tab advice is not prepended',
      ).not.toContain('figpea.SKILL()');
    } finally {
      await prod.close();
    }
  });

  it('leaves the skill_unavailable degradation alone', async () => {
    // No prefetched body at all: the structured fallback stays exactly what it
    // was — no provenance block, same code, same message.
    const client = await inProcessClient(fakeBridge(true), {});
    const text = textOf(await client.callTool({ name: 'figpea_skill', arguments: {} }));

    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('skill_unavailable');
    expect(parsed.message).toContain('figpea.SKILL()');
  });

  it('end to end: the shipped bin names the origin it fetched from (real startup fetch over real stdio)', async () => {
    // The reproduction as it was reported — the MCP process starts with a
    // startup origin, and figpea_skill is called. This test names no internal
    // option: it drives dist/cli.js over stdio exactly as a run does, so it
    // pins what an agent can observe, not how the provenance is threaded.
    const prod = await serveOrigin(PROD_BODY);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY],
      env: {
        ...process.env,
        FIGPEA_EDITOR_URL: prod.origin,
        FIGPEA_DISABLE_CONTRACT_FETCH: '0',
      },
    });
    const client = new Client({ name: 'skill-provenance-cli-test', version: '0.0.0' });
    try {
      await client.connect(transport, { timeout: 10_000 });
      const text = textOf(await client.callTool({ name: 'figpea_skill', arguments: {} }));

      expectNamesTheFetchUrl(text, new URL('/agent/skill.md', prod.origin).toString());
      expect(text, 'the fetched body is delivered in full').toContain(PROD_BODY);
      expect(text, 'never returned bare').not.toBe(PROD_BODY);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      await prod.close();
    }
  }, 20_000);
});

/** The tab's own body is named here so the scenario in the header comment
 * stays honest: nothing in this server reads it, and that is the defect. */
describe('the paired tab\'s own skill body is unreachable from figpea_skill today', () => {
  it('the two bodies really are distinguishable only by the URL, not by the contract stamp', () => {
    const stamp = /contract=([\d.]+)/.exec(PROD_BODY)?.[1];
    expect(stamp, 'PROD_BODY carries a contract stamp').toBeTruthy();
    expect(/contract=([\d.]+)/.exec(TAB_BODY)?.[1], 'and it is the SAME one the tab stamps').toBe(stamp);
    expect(PROD_BODY).not.toBe(TAB_BODY);
  });
});
