import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { startBridgeServer } from './bridgeServer';
import { createMcpServer } from './mcpServer';
import { readBuildSnapshot, servingBuildStamp, type BuildSnapshot } from './buildIdentity';

/**
 * REQ-1457 T5 — every authored timeout envelope carries the serving build
 * identity (AC-4).
 *
 * AC-4 says *every* `bridge_error` timeout message. There are exactly TWO
 * authored timeout envelopes in this package — the `callTab` relay and the
 * `describe` drill — and stamping one while leaving the other alone would make
 * the guarantee true of one path and false of the other, which is the
 * half-wired-surface defect in miniature. Both are driven here.
 *
 * Harness is `req1282TimeoutEnvelope.test.ts`'s, deliberately not an invention:
 * a REAL relay behind a REAL `ws` tab that describes itself and then never
 * answers a relayed call. Every message asserted is the one an agent receives.
 *
 * ── WHAT THIS FILE IS NOT ALLOWED TO BREAK ──────────────────────────────────
 * The stamp is **appended**, never substituted for the existing text. Three
 * clause families are pinned byte-for-byte below and they belong to other
 * requirements: REQ-772's `timed out after Nms` / `may still be executing this
 * call`, REQ-1282's `check state before retrying` and its named state check. If
 * a future edit reshapes any of them to make room for the stamp, this file goes
 * red — which is the point.
 */

interface BridgeHandle {
  readonly port: number;
  readonly token: string;
  isTabConnected(): boolean;
  onDescribe(handler: (manifest: unknown) => void): void;
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

const DRILL_INDEX = {
  version: '1.8.0',
  session: { find: 'Finds layers.' },
  layer: { create: 'Creates a layer.' },
  errorCodes: ['no_session'],
};

const DRILL_GROUPS: Record<string, unknown> = {
  session: { find: { doc: 'Finds layers by selector.', params: { selector: { type: 'object', required: true } }, result: 'void' } },
  layer: {
    create: {
      doc: 'Creates a layer.',
      params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } },
      result: 'void',
    },
  },
};

/** REQ-772 / REQ-1282 wording that must survive this requirement byte-for-byte. */
const PINNED_SUBSTRINGS = [
  'may still be executing this call',
  'check state before retrying',
] as const;

/** The shape AC-4 asks for: a version, a content identifier, and two instants. */
const STAMP_RE =
  /served by figpea-mcp \d+\.\d+\.\d+ build sha256:[0-9a-f]{12} \(built \d{4}-\d{2}-\d{2}T[^)]*, loaded \d{4}-\d{2}-\d{2}T[^)]*\)/;
const STALE_CLAUSE = 'the served file has changed on disk since this process loaded it';

let activeHandle: BridgeHandle | undefined;
const openSockets: WebSocket[] = [];
const cleanups: Array<() => Promise<void>> = [];
const scratchRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  openSockets.length = 0;
  if (activeHandle) {
    await activeHandle.close();
    activeHandle = undefined;
  }
  for (const fn of cleanups.splice(0)) await fn();
  for (const root of scratchRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A tab that describes itself on demand (so the drill completes and no drill
 * timer is left outstanding) and then never answers a relayed call — a stuck
 * editor, which is the only thing a relay deadline is for.
 */
async function connectStuckTab(bridge: BridgeHandle): Promise<WebSocket> {
  const described = new Promise<void>((resolve) => {
    bridge.onDescribe(() => resolve());
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('message', (data: WebSocket.RawData) => {
    const frame = JSON.parse(data.toString());
    if (frame?.type !== 'describe') return;
    ws.send(
      JSON.stringify(
        frame.selector === undefined
          ? { type: 'describe_result', manifest: DRILL_INDEX, version: '1.8.0' }
          : { type: 'describe_result', manifest: DRILL_GROUPS[frame.selector], version: '1.8.0' },
      ),
    );
  });
  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);
  await described;
  return ws;
}

/** A tab that completes the handshake and then says nothing at all — so even
 *  the `describe` drill, not just relayed calls, runs out its deadline. */
async function connectSilentTab(bridge: BridgeHandle): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  await expect.poll(() => bridge.isTabConnected(), { timeout: 3000 }).toBe(true);
  return ws;
}

async function connectedClient(bridge: BridgeHandle, toolMode: 'compact' | 'full') {
  const server = createMcpServer(bridge, { toolMode });
  const client = new Client({ name: 'req-1457-timeout-stamp-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((c) => c.type === 'text')!.text!);
}

async function timeoutMessageFor(
  bridge: BridgeHandle,
  group: string,
  method: string,
  args: unknown[],
  timeoutMs = 60,
): Promise<string> {
  let message = '';
  try {
    await bridge.callTab(group, method, args, timeoutMs);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message, `${group}.${method} rejects when the tab never answers`).toContain('timed out');
  return message;
}

describe('REQ-1457 AC-4 — the callTab relay envelope names the serving build', () => {
  it('carries the version, the content identifier and both instants', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const message = await timeoutMessageFor(bridge, 'layer', 'create', ['text', { name: 'cat-label' }]);

    expect(message, 'AC-4: a timed-out call can be matched against the commit the caller believes is running').toMatch(
      STAMP_RE,
    );
    // The three pre-existing clause families, byte-for-byte.
    expect(message, 'the timeout form is unchanged').toContain('timed out after 60ms');
    for (const pinned of PINNED_SUBSTRINGS) {
      expect(message, `the pinned clause "${pinned}" survives verbatim`).toContain(pinned);
    }
    expect(message, 'and the named state check is still named').toContain('session.find({name:"cat-label"})');

    // APPENDED, not substituted: the stamp comes after the envelope, so the
    // envelope a caller has been matching on is untouched.
    expect(
      message.indexOf('served by figpea-mcp'),
      'the stamp is appended after the existing text, never substituted into it',
    ).toBeGreaterThan(message.indexOf('check state before retrying'));
  });

  it('omits the stale clause while this build is the one on disk', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;
    await connectStuckTab(bridge);

    const message = await timeoutMessageFor(bridge, 'layer', 'create', ['text', { name: 'cat-label' }]);

    // Nothing has changed under this process, so claiming it has would be a
    // lie an agent would act on — restarting a server that is already current.
    expect(message).not.toContain(STALE_CLAUSE);
  });
});

describe('REQ-1457 AC-4 — both calling lanes carry the stamp', () => {
  it('compact figpea_call and a full-mode contract tool both surface it, with every pin intact', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;

    // The relay publishes its manifest ONCE, when the drill completes, so both
    // servers are created BEFORE the tab pairs — a real ordering constraint of
    // the relay, not a test artefact.
    const fullClient = await connectedClient(bridge, 'full');
    const compactClient = await connectedClient(bridge, 'compact');
    await connectStuckTab(bridge);

    for (const [lane, result] of [
      [
        'full mode',
        await callToolJson(fullClient, 'layer_create', { kind: 'text', props: { name: 'cat-label' }, _timeoutMs: 60 }),
      ],
      [
        'compact mode',
        // REQ-1522 AC-4: a different layer KIND from the full-mode row above, so
        // the two lanes are not the same call — an identical re-issue of an
        // unresolved call is refused, and this test is about the envelope
        // reaching both lanes, not about a retry. The kind is not interpolated
        // into the hint, so every message assertion below is unchanged.
        await callToolJson(compactClient, 'figpea_call', {
          group: 'layer',
          method: 'create',
          args: ['rect', { name: 'cat-label' }],
          _timeoutMs: 60,
        }),
      ],
    ] as const) {
      expect(result.ok, `${lane}: a timed-out call is a failed envelope`).toBe(false);
      // REQ-1522 AC-2: the deadline now carries its own code. Every `message`
      // assertion below is untouched — the envelope is appended to, never
      // substituted — which is exactly what this requirement's own pins say.
      expect(result.code).toBe('bridge_timeout_maybe_applied');
      expect(result.message, `AC-4, ${lane}: the serving build reaches the agent there too`).toMatch(STAMP_RE);
      for (const pinned of PINNED_SUBSTRINGS) {
        expect(result.message, `${lane}: "${pinned}" survives verbatim`).toContain(pinned);
      }
      expect(result.message, `${lane}: and the named state check still reaches it`).toContain(
        'session.find({name:"cat-label"})',
      );
    }
  });
});

describe('REQ-1457 AC-4 — the SECOND authored envelope, the describe drill', () => {
  it('carries the stamp too, so "every timeout" is true of both sites', async () => {
    const bridge = await startBridgeServer();
    activeHandle = bridge;

    // A tab that never answers anything, so the drill's own deadline fires. The
    // drill reports through `console.error` (it has no caller to reject to),
    // so the envelope is observed exactly where the product emits it.
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    });
    await connectSilentTab(bridge);

    // `expect.poll` takes no message argument in Vitest 4, so the label lives
    // in the assertion below rather than here.
    await expect
      .poll(
        () => logged.find((line) => line.includes('describe(') && line.includes('timed out')) ?? '',
        { timeout: 20_000, interval: 100 },
      )
      .not.toBe('');

    const line = logged.find((l) => l.includes('describe(') && l.includes('timed out'))!;
    expect(line, 'AC-4: the drill envelope names the serving build as well').toMatch(STAMP_RE);
    expect(line, 'and the timeout form is unchanged').toMatch(/timed out after \d+ms/);
  }, 30_000);
});

describe('REQ-1457 AC-4 — the stale clause is present when, and only when, it is true', () => {
  /** A scratch build this test owns, so the repo's own dist is never touched. */
  function scratchBuild(): { dir: string; snapshot: BuildSnapshot } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figpea-mcp-req1457-stamp-'));
    scratchRoots.push(dir);
    fs.writeFileSync(path.join(dir, 'cli.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'mcpServer.js'), 'module.exports = {}');
    return { dir, snapshot: readBuildSnapshot(dir) };
  }

  it('is absent for a build that has not changed', () => {
    const { snapshot } = scratchBuild();
    const stamp = servingBuildStamp(snapshot);
    expect(stamp, 'no claim nobody needs to act on').not.toContain(STALE_CLAUSE);
  });

  it('is present once the build on disk is not the one recorded', () => {
    const { dir, snapshot } = scratchBuild();
    fs.writeFileSync(path.join(dir, 'cli.js'), 'console.log(2)');
    const stamp = servingBuildStamp(snapshot);
    expect(stamp, 'the remedy is named rather than left to be worked out').toContain(STALE_CLAUSE);
    expect(stamp, 'and the identity is still there beside it').toMatch(STAMP_RE);
  });
});