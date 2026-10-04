import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import WebSocket from 'ws';

import { requireBuiltCli } from './testSupport/requireBuiltCli.test-helper';

/**
 * REQ-1503 — the property the whole recovery story rests on, pinned before the
 * documentation claims it: **the bridge keeps serving after its MCP stdio
 * channel breaks.**
 *
 * WHY IT NEEDS A PIN AT ALL. `cli.ts` starts the bridge INSIDE the stdio process
 * and shuts down only on SIGINT/SIGTERM, so on the face of it the bridge outlives
 * the channel. But nothing states what happens when the transport's pipes break,
 * and a process whose stdout pipe has closed can die on an unhandled `EPIPE` at
 * its next `console.error` — after which the recovery route this requirement
 * ships is gone in precisely the situation it exists for. "The bridge keeps
 * serving without the MCP channel" was, until this suite, an untested accident.
 *
 * So it is tested the way the failure actually happens: spawn the REAL published
 * entry (`dist/cli.js`) over real stdio, complete a real MCP handshake, pair a
 * real `ws` tab, break BOTH pipes the way a host that dropped the MCP server
 * would, and then ask the bridge — over its own HTTP listener — whether it is
 * still there and whether a relayed call still lands.
 *
 * The handshake is spoken by hand rather than through `StdioClientTransport`,
 * and that is the point rather than a convenience: the SDK client owns the child
 * process and closes it as part of its own teardown, so it cannot also be used to
 * break its pipes underneath it. MCP over stdio is one JSON object per line, so
 * driving it directly is a few lines and leaves the pipes under this suite's
 * control.
 *
 * `beforeAll` BUILDS the package, the way `packedArtifact.test.ts` does. Without
 * it this suite would be a build-ordering failure wearing the costume of a
 * product failure on any checkout whose last action was editing a source file —
 * the exact trap `requireBuiltCli` exists to name. So this suite needs no build
 * step from the reader.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');

let child: ChildProcessWithoutNullStreams | undefined;
let bridgePort = 0;
let bridgeToken = '';
let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

beforeAll(() => {
  // …and the build this suite's child process runs from.
  execFileSync('npm', ['run', 'build'], { cwd: PACKAGE_ROOT, stdio: 'pipe' });
}, 120_000);

afterAll(() => {
  child?.kill('SIGKILL');
});

/** Resolves once the child's stderr banner has named its port and token. */
function waitForBanner(timeoutMs = 15_000): Promise<{ port: number; token: string }> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      const port = /bridge listening on (?:localhost|127\.0\.0\.1):(\d+)/.exec(stderrText)?.[1];
      const token = /pairing token: (\S+)/.exec(stderrText)?.[1];
      if (port && token) {
        bridgePort = Number(port);
        bridgeToken = token;
        resolve({ port: bridgePort, token: bridgeToken });
        return;
      }
      if (Date.now() > deadline) reject(new Error(`startup banner never arrived. stderr:\n${stderrText}`));
      else setTimeout(check, 50);
    };
    check();
  });
}

let stderrText = '';
const pending = new Map<number, (msg: any) => void>();

function send(obj: Record<string, unknown>): void {
  child!.stdin.write(`${JSON.stringify(obj)}\n`);
}

function request(id: number, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} did not answer within 15s`)), 15_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method} → ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

/** Starts the real bin over real stdio and completes a real MCP handshake. */
async function startChildAndHandshake(): Promise<void> {
  child = spawn(process.execPath, [requireBuiltCli()], {
    env: { ...process.env, FIGPEA_DISABLE_CONTRACT_FETCH: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
  });

  let stdoutBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    for (;;) {
      const at = stdoutBuf.indexOf('\n');
      if (at === -1) break;
      const line = stdoutBuf.slice(0, at).trim();
      stdoutBuf = stdoutBuf.slice(at + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // A diagnostic on stdout would be its own bug; the handshake below reports it.
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });

  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.on('error', (err) => {
    exited = { code: -1, signal: null };
    stderrText += `\nspawn error: ${String(err)}`;
  });

  const banner = waitForBanner();
  await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'req-1503-stdio-break', version: '0.0.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await request(2, 'tools/list', {});
  expect((tools.tools ?? []).map((t: { name: string }) => t.name)).toContain('status');
  await banner;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-figpea-token': bridgeToken, 'content-type': 'application/json', ...extra };
}

describe('REQ-1503 — the bridge outlives its own MCP stdio channel', () => {
  it('keeps serving over HTTP once both stdio pipes are gone, and still relays a call', async () => {
    await startChildAndHandshake();

    // --- a real tab, paired over the real handshake ---
    const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const applied: string[] = [];
      ws.on('message', (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString());
        if (frame?.type === 'describe') {
          ws.send(JSON.stringify({ type: 'describe_result', manifest: { version: '1.8.0' }, version: '1.8.0' }));
          return;
        }
        if (frame?.type === 'call') {
          applied.push(`${frame.group}.${frame.method}`);
          ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: { applied: true, via: 'recovery' } }));
        }
      });
      ws.send(JSON.stringify({ type: 'hello', token: bridgeToken }));
      await expect.poll(() => ws.readyState === WebSocket.OPEN, { timeout: 5_000 }).toBe(true);
      // The drill is the last thing the bridge sends unprompted; waiting for it
      // keeps the "no tab round trip" claim of /state true later.
      await new Promise((r) => setTimeout(r, 500));

      // --- BEFORE: the recovery surface answers ---
      const before = await fetch(`http://127.0.0.1:${bridgePort}/state`, { headers: authed() });
      expect(before.status, 'the state route answers while the channel is up').toBe(200);

      // --- BREAK IT: close both pipes the way a host that dropped the MCP
      // server does. `destroy()` rather than `end()`, because a graceful stdin
      // close is a request to shut down and this is not one. ---
      child!.stdin.destroy();
      child!.stdout.destroy();

      // Provoke the write the risk is about: a diagnostic on a closed pipe. If
      // this kills the process, every claim below fails — which is the finding,
      // not a flaky test.
      await fetch(`http://127.0.0.1:${bridgePort}/state`, { method: 'POST', headers: authed(), body: '{}' }).catch(() => {});

      // Give a crash every chance to happen, and give the OS a moment to reap.
      await new Promise((r) => setTimeout(r, 1_500));
      expect(exited, 'the process survives its stdio pipes breaking').toBeNull();

      // --- AFTER: still serving, and a relayed call still lands ---
      const after = await fetch(`http://127.0.0.1:${bridgePort}/state`, { headers: authed() });
      expect(after.status, 'the bridge still answers over HTTP with no MCP channel at all').toBe(200);
      const state = (await after.json()) as any;
      expect(state.port, 'and it is the same bridge').toBe(bridgePort);
      expect(state.tabConnected, 'still holding the tab it was paired with').toBe(true);
      expect(typeof state.liveness?.state, 'still publishing liveness').toBe('string');
      // The token still works after the break, so the file on disk is still the
      // thing a recovery procedure holds.
      expect(state.liveness?.nextStep, 'and the recovery sentence still ships').not.toBe('');

      const call = await fetch(`http://127.0.0.1:${bridgePort}/call`, {
        method: 'POST',
        headers: authed(),
        body: JSON.stringify({ group: 'layer', method: 'create', args: ['rect', { name: 'after-the-break' }] }),
      });
      expect(call.status, 'and a relayed call is relayed').toBe(200);
      expect(await call.json()).toEqual({ ok: true, value: { applied: true, via: 'recovery' } });
      expect(applied, 'the call really reached the tab, not just the route').toEqual(['layer.create']);
    } finally {
      ws.close();
      child?.kill('SIGKILL');
    }
  }, 60_000);
});
