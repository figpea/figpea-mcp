import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { requireBuiltCli } from './testSupport/requireBuiltCli.test-helper';

/**
 * REQ-1516 T7 — the AC-2 deliverable, proven rather than present.
 *
 * AC-2: "one command from figpea-mcp's own README starts a transport the
 * agent can call, and an agent following the README reaches a working
 * layer.create without writing code." So this spec does both halves:
 *
 *  (1) it pins the recipe's command strings as PRESENT in the README (a
 *      documented answer that rots into un-runnable prose is the failure the
 *      card was filed from — the inherited shim's documented argument form
 *      did not work);
 *  (2) it EXECUTES the recipe's commands verbatim against a live `--http`
 *      server: the exact `figpea-mcp --http` start, the exact header the
 *      recipe names, `tools/list`, then a first `layer.create` via
 *      `tools/call` against a paired stub tab — reaching a working create
 *      with no code written beyond what the README prints.
 *
 * Copy guardrails (marketing brief, classification `internal`): no "Figma
 * alternative" framing, no save-back implication, production pairing reads as
 * the warned fallback — never as an equal alternative to the dev-editor
 * opt-in.
 *
 * RED state (before T7): the README has no such section, so every prose pin
 * fails. The live-execution rows already pass on T2's build — they are the
 * proof the documented answer works, not the thing being built.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli.js');
const README_PATH = path.join(PACKAGE_ROOT, 'README.md');

vi.setConfig({ testTimeout: 60_000 });

const children: ChildProcess[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
  }
});

function readme(): string {
  return fs.readFileSync(README_PATH, 'utf8');
}

function sectionLines(heading: string): string[] {
  const lines = readme().split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  expect(start, `README has a "${heading}" section`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

describe('REQ-1516 AC-2 — the README carries the supported answer', () => {
  const SECTION = '## The registered server did not start';

  it('has the fallback section where a stuck reader looks for it', () => {
    const lines = readme().split('\n');
    const at = (h: string) => lines.findIndex((l) => l.trimEnd() === h);
    expect(at(SECTION), 'the section exists').toBeGreaterThan(-1);
    expect(at(SECTION), 'it follows the Quickstart that a stuck setup reads first').toBeGreaterThan(
      at('## Quickstart'),
    );
    expect(at(SECTION), 'and precedes the pairing reference it builds on').toBeLessThan(
      at('## How pairing works'),
    );
  });

  it('names the one command, the header, and the call sequence', () => {
    const body = sectionLines(SECTION).join('\n');
    expect(body, 'the one command').toContain('figpea-mcp --http');
    expect(body, 'the token header').toContain('x-figpea-token');
    expect(body, 'the MCP endpoint path').toContain('/mcp');
    expect(body, 'tools/list is part of the recipe').toContain('tools/list');
    expect(body, 'tools/call is part of the recipe').toContain('tools/call');
    expect(body, 'the recipe ends at a working layer.create').toContain('layer.create');
    expect(body, 'no code is written — curl is the header-less fallback').toContain('curl');
  });

  it('points at a local dev editor with the AC-4 warning named', () => {
    const body = sectionLines(SECTION).join('\n');
    expect(body, 'the dev-editor recipe names FIGPEA_EDITOR_URL').toContain('FIGPEA_EDITOR_URL');
    expect(body, 'and names the production warning the unset env produces').toContain('FIGPEA_EDITOR_URL is unset');
  });

  it('covers two agents at once without sharing a bridge', () => {
    const body = sectionLines(SECTION).join('\n');
    expect(body, 'private bridge per run').toMatch(/own --port|private bridge/i);
    expect(body, 'the multi opt-in is named').toContain('--bridge-slots=multi');
    expect(body, 'pairing URLs are never shared').toMatch(/never share/i);
  });

  it('--help documents the entry point', () => {
    requireBuiltCli(CLI_ENTRY);
    const out = execFileSync(process.execPath, [CLI_ENTRY, '--help'], { encoding: 'utf8' });
    expect(out, '--help names the entry point').toContain('--http');
    expect(out, '--help names the listener-port flag').toContain('--port');
  });
});

describe('REQ-1516 AC-2 — the recipe executes verbatim to a working layer.create', () => {
  it('one README command starts a transport the agent can call, ending at layer.create', async () => {
    requireBuiltCli(CLI_ENTRY);
    // The recipe's one command, verbatim (plus the fetch-disabling env the
    // hermetic suite uses everywhere — the recipe itself needs no env).
    const child = spawn(process.execPath, [CLI_ENTRY, '--http'], {
      env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const stderrLines: string[] = [];
    let stderrBuf = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      const parts = stderrBuf.split('\n');
      stderrBuf = parts.pop() ?? '';
      stderrLines.push(...parts);
    });
    child.stdout!.resume();

    const endpointLine = await waitForLine(stderrLines, /http:\/\/127\.0\.0\.1:\d+\/mcp/);
    const pairingLine = await waitForLine(stderrLines, /\?agent=1&bridgePort=\d+&bridgeToken=\S+/);
    const endpoint = endpointLine.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)![0];
    const token = stderrLines
      .map((l) => l.match(/pairing token:\s*(\S+)/))
      .find((m) => m)![1];
    const bridgePort = Number(pairingLine.match(/bridgePort=(\d+)/)![1]);

    // The recipe's client call: the token header it names, tools/list first.
    const client = new Client({ name: 'req-1516-readme-recipe', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { 'x-figpea-token': token } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name), 'the fallback serves the registered surface').toContain('figpea_call');

      // Pair the tab the recipe pairs (its pairing URL, opened in a browser —
      // here a stub tab speaking the same wire protocol), answering the
      // describe drill and the one relayed create the way an editor would.
      const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
      openSockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      ws.on('message', (data: WebSocket.RawData) => {
        let frame: any;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (frame?.type === 'describe') {
          const manifest =
            frame.selector === undefined
              ? { version: '2.59.1', session: 'session group', layer: 'layer group' }
              : {
                  create: {
                    doc: 'Creates a layer.',
                    params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } },
                    result: 'string',
                  },
                };
          ws.send(JSON.stringify({ type: 'describe_result', manifest, version: '2.59.1' }));
          return;
        }
        if (frame?.type === 'call') {
          ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: { id: 'layer-1' } }));
        }
      });
      ws.send(JSON.stringify({ type: 'hello', token }));

      // The recipe's first authoring call, verbatim in shape.
      const result = await client.callTool({
        name: 'figpea_call',
        arguments: { group: 'layer', method: 'create', args: ['rect', { name: 'recipe-probe' }] },
      });
      const content = (result as any).content as Array<{ type: string; text?: string }>;
      const textBlock = content.find((c) => c.type === 'text');
      expect(textBlock, 'the create answers a text block').toBeDefined();
      const payload = JSON.parse(textBlock!.text!);
      expect(payload.ok, 'the README path reaches a WORKING layer.create').toBe(true);
      expect(JSON.stringify(payload)).toContain('layer-1');
    } finally {
      await client.close().catch(() => {});
    }
  });
});

async function waitForLine(lines: string[], re: RegExp, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = lines.find((l) => re.test(l));
    if (found) return found;
    if (Date.now() >= deadline) {
      throw new Error(`never observed ${re} (stderr so far:\n${lines.join('\n') || '<empty>'})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
