import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requireBuiltCli } from './testSupport/requireBuiltCli.test-helper';

/**
 * REQ-1457 T1 — the card's repro, run FIRST and expected RED on the unfixed
 * tree (AC-1).
 *
 * The card, verbatim: *"Start a figpea-mcp server process. Note its PID and
 * start time. Without stopping it, replace `figpea-mcp/dist/cli.js` with a
 * build from a newer commit (**or touch `dist/mcpServer.js`**). Call
 * `figpea_status`. Expected: the response identifies which build answered.
 * Actual today: byte-identical before and after the swap, with nothing that
 * changed."*
 *
 * So this file executes the steps rather than paraphrasing them. It is a real
 * stdio spawn of the real BUILT artifact — the strongest evidence this repo can
 * produce, and stronger than a headless browser would be, because AC-1 is about
 * *which files a Node process loaded*. There is no Playwright suite here: this
 * package is a Node stdio server (no `playwright.config.ts`, no e2e dir), so
 * this is its e2e.
 *
 * ── BOTH HALVES OF STEP 3 ARE THE AC ────────────────────────────────────────
 * The parenthetical — *"or touch `dist/mcpServer.js`"* — is not a restatement
 * of the primary variant, it is the case a single-file anchor cannot see. An
 * implementation that fingerprinted only `dist/cli.js` would report an
 * unchanged payload for the touch, which is the exact symptom this requirement
 * exists to remove, rebuilt inside its own fix. Both variants are pinned here as
 * separate tests so neither can be dropped without a red.
 *
 * ── WHY A SCRATCH COPY, NOT THE REPO'S `dist/` ──────────────────────────────
 * Not a convenience. Vitest runs test FILES in parallel workers and three
 * existing suites (`cli.test.ts`, `req1035.test.ts`, `skillProvenance.test.ts`)
 * spawn the real `dist/cli.js` concurrently, so an in-place edit is a
 * cross-suite flake generator — and `dist/` is gitignored, so the damage would
 * never appear in a diff.
 *
 * The scratch dir is laid out as `<tmp>/…/dist/` with a `node_modules`
 * SYMLINK beside it, because Node resolves dependencies by walking *up* from
 * the requiring file's own directory: a bare copy of `dist/` dies
 * `MODULE_NOT_FOUND` on `@modelcontextprotocol/sdk` / `ws` / `zod`. Keeping the
 * directory named `dist` is also load-bearing for the REQ — production
 * `__dirname` IS `<pkg>/dist`, and the covered build set is derived from it.
 *
 * REQ-1443: `requireBuiltCli()` is called inside each test body, before the
 * transport, so a missing build fails by name instead of surfacing as
 * `MCP error -32000: Connection closed` and being read as a product failure.
 * This suite is registered in `req1443SpawnWiring.test.ts`'s `SPAWNING_SUITES`
 * so that guard governs this spawn site too.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli.js');
const BUILT_DIR = path.join(PACKAGE_ROOT, 'dist');
const NODE_MODULES = path.join(PACKAGE_ROOT, 'node_modules');

const scratchRoots: string[] = [];

/** A throwaway `dist/` copy with its dependencies resolvable beside it. */
function scratchBuild(): { root: string; dist: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figpea-mcp-req1457-'));
  scratchRoots.push(root);
  const dist = path.join(root, 'dist');
  fs.cpSync(BUILT_DIR, dist, { recursive: true });
  // A symlink, not a copy: the SDK/ws/zod tree is ~140 packages and nothing
  // here mutates it.
  fs.symlinkSync(NODE_MODULES, path.join(root, 'node_modules'), 'dir');
  return { root, dist };
}

/** The whole `status` payload, exactly as an agent receives it. */
async function statusOf(client: Client): Promise<any> {
  const result = await client.callTool({ name: 'status', arguments: {} });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  const block = content.find((c) => c.type === 'text');
  expect(block, 'status returns a text content block').toBeDefined();
  return JSON.parse(block!.text!);
}

async function stopChild(transport: StdioClientTransport, client: Client): Promise<void> {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

afterAll(() => {
  for (const root of scratchRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  scratchRoots.length = 0;
});

describe('REQ-1457 AC-1 — status names the build that answered, after dist changes underneath the process', () => {
  it('step 1-2: the process starts, reports its own identity, and is a real PID with a start time', async () => {
    requireBuiltCli(CLI_ENTRY);
    const { dist } = scratchBuild();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(dist, path.basename(CLI_ENTRY))],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
    });
    const client = new Client({ name: 'req-1457-repro-identity', version: '0.0.0' });

    try {
      await client.connect(transport, { timeout: 15_000 });

      // Step 2, literally: the repro is only meaningful if there IS a process
      // to be stale, so the suite proves it has one and that `status` can say
      // when it loaded its build.
      expect(typeof transport.pid, 'a real OS process answered (step 1: a process exists)').toBe('number');

      const s = await statusOf(client);
      expect(typeof s.build, 'the payload describes the build that answered (step 4)').toBe('object');
      expect(s.build.servedAt, 'and dates the moment this process loaded it').toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(
        s.buildStale,
        'nothing has changed on disk yet, so the honest answer is false — not missing, not a string',
      ).toBe(false);
    } finally {
      await stopChild(transport, client);
    }
  }, 30_000);

  it('step 3a: replacing dist/cli.js with a newer build changes what the SAME process answers', async () => {
    requireBuiltCli(CLI_ENTRY);
    const { dist } = scratchBuild();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(dist, path.basename(CLI_ENTRY))],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
    });
    const client = new Client({ name: 'req-1457-repro-swap', version: '0.0.0' });

    try {
      await client.connect(transport, { timeout: 15_000 });
      const before = await statusOf(client);

      // Step 3a, on the SCRATCH copy — the running process is never stopped.
      const cliFile = path.join(dist, 'cli.js');
      const beforeBytes = fs.readFileSync(cliFile);
      fs.writeFileSync(cliFile, `// rebuilt from a newer commit\n${beforeBytes.toString()}`);

      const after = await statusOf(client);

      // The AC's own expectation, stated before this REQ's own field names:
      // the response must not be the same answer twice.
      expect(
        after,
        'AC-1: a newer build landing under a running process changes what status answers',
      ).not.toEqual(before);
      expect(after.buildStale, 'and says so on the boolean').toBe(true);
      expect(
        after.build.buildId,
        'a genuinely different build is a different identifier, not the same string re-reported',
      ).not.toBe(before.build.buildId);
    } finally {
      await stopChild(transport, client);
    }
  }, 30_000);

  it('step 3b: merely TOUCHING dist/mcpServer.js also changes what the SAME process answers', async () => {
    requireBuiltCli(CLI_ENTRY);
    const { dist } = scratchBuild();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(dist, path.basename(CLI_ENTRY))],
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
    });
    const client = new Client({ name: 'req-1457-repro-touch', version: '0.0.0' });

    try {
      await client.connect(transport, { timeout: 15_000 });
      const before = await statusOf(client);

      // Step 3b, the parenthetical variant. Content is untouched — only the
      // mtime moves — which is precisely the case an implementation that
      // fingerprinted one file, or compared content only, would report as
      // unchanged. `utimesSync` is given an explicit future instant so the
      // change cannot be lost to filesystem mtime granularity.
      const mcpServerFile = path.join(dist, 'mcpServer.js');
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(mcpServerFile, future, future);

      const after = await statusOf(client);

      expect(
        after,
        'AC-1 (parenthetical): touching dist/mcpServer.js changes what status answers',
      ).not.toEqual(before);
      expect(after.buildStale, 'and says so on the boolean').toBe(true);
      expect(
        after.build.buildId,
        'a touch changes no bytes, so the content identifier is deliberately UNCHANGED — the two fields are what separate the two cases',
      ).toBe(before.build.buildId);
    } finally {
      await stopChild(transport, client);
    }
  }, 30_000);
});