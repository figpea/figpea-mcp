import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

import { startBridgeServer } from './bridgeServer';
import { sessionDirFor } from './returnPath';

/**
 * REQ-1503 T5 — the bridge's own recovery surface: a token-gated call route, a
 * read-only state route, and the file that makes them discoverable.
 *
 * WHY THIS EXISTS. The bridge has exactly one control surface — the MCP stdio
 * channel — and that channel belongs to the host's process manager, not to the
 * agent. When the host drops the MCP server the agent cannot even ask what is
 * happening, and the documented answer to "how do I finish this run" was "there
 * isn't one". So the bridge, which already binds loopback, already answers
 * unauthenticated HTTP and already holds a token-gated relay to the tab, grows
 * the two routes that make it usable without the channel.
 *
 * The pins are deliberately heavy on the NEGATIVE side, because this change
 * adds a WRITE-capable route to a published MIT package whose entire HTTP surface
 * used to be two GETs:
 *
 *  - the token gate, on both routes, and the token is read from a HEADER only —
 *    a token in a query string lands in a URL, a shell history and an access
 *    log, which is why `?token=` is asserted to be refused even when correct;
 *  - no browser can reach either route (no ACAO, and the allowed methods stay
 *    `GET, OPTIONS`, so a preflight cannot approve a POST);
 *  - `/file` and `/blob` are UNCHANGED — ungated reads, a real pre-existing
 *    exposure that is a different requirement's finding. Their behaviour is
 *    pinned here so this diff provably did not move them, which is also why a
 *    reviewer who wants that exposure closed in this REQ can see it was not
 *    quietly absorbed.
 *
 * The bridge-info file is pinned outside the per-token session dir, and that is
 * not cosmetic: `returnPath.sessionBytes()` charges EVERY entry in that dir
 * against the per-session return-bytes cap, so a file written inside one would
 * eat a user's export budget with a few hundred bytes.
 *
 * Harness is the package's top tier: a REAL listener on an OS-assigned port and
 * a REAL `ws` tab standing in for the editor, driven over real HTTP with real
 * headers and real bodies.
 */

type Bridge = Awaited<ReturnType<typeof startBridgeServer>>;

const openBridges: Bridge[] = [];
const openSockets: WebSocket[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  for (const bridge of openBridges.splice(0)) await bridge.close().catch(() => {});
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function liveBridge(): Promise<Bridge> {
  const bridge = await startBridgeServer();
  openBridges.push(bridge);
  return bridge;
}

/** Where the bridge publishes how to reach itself. Documented as a discovery
 *  step, so the path is asserted rather than recomputed by the reader. */
function bridgeInfoPath(port: number): string {
  return path.join(os.tmpdir(), 'figpea-mcp', `bridge-${port}.json`);
}

const DRILL_INDEX = { version: '1.8.0', layer: { create: 'Creates a layer.' } };
const DRILL_GROUPS: Record<string, unknown> = {
  layer: {
    create: {
      doc: 'Creates a layer.',
      params: { kind: { type: 'string', required: true }, props: { type: 'object', required: false } },
      result: 'void',
    },
  },
};

interface AnswerOptions {
  /** What the tab replies with on a successful call. */
  reply?: unknown;
  /** Answer with the tab's OWN error instead — a refusal the editor made, which
   *  is a successful relay of a failed call and the distinction the route must
   *  keep: it is not a 504, because the tab did answer. */
  refuse?: { code: string; message: string };
  /** Never answer a `call` frame at all — a wedged tab. */
  silent?: boolean;
}

/** A real tab that completes the handshake, drills, and then answers (or not). */
async function connectTab(bridge: Bridge, options: AnswerOptions = {}): Promise<{ ws: WebSocket; frames: () => number }> {
  let frames = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  openSockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('message', (data: WebSocket.RawData) => {
    frames += 1;
    const frame = JSON.parse(data.toString());
    if (frame?.type === 'describe') {
      ws.send(
        JSON.stringify({
          type: 'describe_result',
          manifest: frame.selector === undefined ? DRILL_INDEX : (DRILL_GROUPS[frame.selector] ?? {}),
          version: '1.8.0',
        }),
      );
      return;
    }
    if (frame?.type === 'call') {
      if (options.silent) return;
      if (options.refuse) {
        ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: false, ...options.refuse }));
        return;
      }
      ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: options.reply ?? { applied: true } }));
    }
  });
  ws.send(JSON.stringify({ type: 'hello', token: bridge.token }));
  await expect.poll(() => bridge.isTabConnected(), { timeout: 5000 }).toBe(true);
  // Let the drill finish so a frame-count measurement taken later is steady.
  await new Promise((r) => setTimeout(r, 300));
  return { ws, frames: () => frames };
}

function base(bridge: Bridge): string {
  return `http://127.0.0.1:${bridge.port}`;
}

function authed(bridge: Bridge): Record<string, string> {
  return { 'x-figpea-token': bridge.token, 'content-type': 'application/json' };
}

/** `POST /call` with the bridge's own token, the one route a recovery caller uses. */
function postCall(bridge: Bridge, body: unknown, headers: Record<string, string> = authed(bridge)): Promise<Response> {
  return fetch(`${base(bridge)}/call`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('REQ-1503 — POST /call is the token-gated way back to the tab', () => {
  it('refuses a request with no token, and one with the wrong token', async () => {
    const bridge = await liveBridge();
    await connectTab(bridge);

    for (const [label, headers] of [
      ['no token at all', { 'content-type': 'application/json' }],
      ['a token that is not this run\'s', { 'x-figpea-token': 'not-the-token', 'content-type': 'application/json' }],
      ['an empty token', { 'x-figpea-token': '', 'content-type': 'application/json' }],
    ] as const) {
      const res = await postCall(bridge, { group: 'layer', method: 'create', args: ['rect'] }, headers);
      expect(res.status, `${label}: a mutating route is never ungated`).toBe(401);
      const body = (await res.json()) as any;
      // The package's own failure shape, never a bare status line.
      expect(body.ok, `${label}: failures use the shipped envelope`).toBe(false);
      expect(typeof body.code, `${label}: with a code`).toBe('string');
      expect(typeof body.message, `${label}: and a message`).toBe('string');
    }
  });

  it('reads the token from a header only — a correct token in the query string is still refused', async () => {
    const bridge = await liveBridge();
    const tab = await connectTab(bridge);
    const framesBefore = tab.frames();

    const res = await fetch(`${base(bridge)}/call?token=${encodeURIComponent(bridge.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group: 'layer', method: 'create', args: ['rect'] }),
    });

    // A query string lands in the URL, in any pasted shell history and in any
    // access log. Accepting it would make the header-only rule a convention
    // rather than a property, and a per-run token in a log is a real credential
    // even though it dies with the process.
    expect(res.status, 'the token is not read from the URL').toBe(401);
    expect(tab.frames(), 'and nothing was relayed on the strength of a URL token').toBe(framesBefore);
  });

  it('relays a real call to a real tab and returns the answer as the call\'s own envelope', async () => {
    const bridge = await liveBridge();
    await connectTab(bridge, { reply: { layerId: 'layer-42' } });

    const res = await postCall(bridge, { group: 'layer', method: 'create', args: ['text', { name: 'recovered' }] });

    expect(res.status, 'a relayed call succeeds with 200').toBe(200);
    const body = (await res.json()) as any;
    // Verbatim, not re-wrapped: this is the same envelope the MCP tools return,
    // so a caller finishing a run over HTTP sees exactly what it would have seen.
    expect(body).toEqual({ ok: true, value: { layerId: 'layer-42' } });
  });

  it('returns 200 for a call the tab REFUSED — an answered failure is a successful relay', async () => {
    const bridge = await liveBridge();
    await connectTab(bridge, { refuse: { code: 'entitlement_required', message: 'exports need a plan' } });

    const res = await postCall(bridge, { group: 'export', method: 'project', args: [] });

    // The distinction matters and is easy to lose: `{ok:false}` from the tab
    // means the editor answered with an error the caller must read, while a
    // relay that never got an answer is a 504. Flattening the first into the
    // second would tell a caller "the tab did not answer" about a tab that
    // answered perfectly well — and would lose the editor's own code, which is
    // the whole reason the caller asked.
    expect(res.status, 'the tab answered, so the relay did its job').toBe(200);
    expect(await res.json(), "the tab's own envelope, verbatim").toEqual({
      ok: false,
      code: 'entitlement_required',
      message: 'exports need a plan',
    });
  });

  it('rejects a malformed body with 400, naming the problem, before anything is relayed', async () => {
    const bridge = await liveBridge();
    const tab = await connectTab(bridge);
    const before = tab.frames();

    const cases: Array<[string, unknown]> = [
      ['not JSON at all', '{ this is not json'],
      ['a JSON array', '[]'],
      ['no group', { method: 'create' }],
      ['no method', { group: 'layer' }],
      ['a non-string group', { group: 7, method: 'create' }],
      ['a non-string method', { group: 'layer', method: null }],
      ['args that is not an array', { group: 'layer', method: 'create', args: { kind: 'rect' } }],
    ];
    for (const [label, body] of cases) {
      const res = await postCall(bridge, body);
      expect(res.status, `${label}: a body the relay cannot address is refused`).toBe(400);
      const parsed = (await res.json()) as any;
      expect(parsed.ok, `${label}: with the shipped failure shape`).toBe(false);
      expect(typeof parsed.code, `${label}: and a code`).toBe('string');
    }
    expect(tab.frames(), 'and no frame was ever sent to the tab for a body it could not read').toBe(before);
  });

  it('reports 409 when no tab is paired, rather than pretending a relay happened', async () => {
    const bridge = await liveBridge();

    const res = await postCall(bridge, { group: 'layer', method: 'create', args: ['rect'] });

    expect(res.status, 'there is nothing to relay to').toBe(409);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    // And it says what to do, because a bare code is the advice-with-no-route
    // REQ-1282 exists to end.
    expect(String(body.message)).toMatch(/tab/i);
  });

  it('reports 504 on a relay timeout, carrying the relay envelope so the reason is not lost', async () => {
    const bridge = await liveBridge();
    await connectTab(bridge, { silent: true });

    const res = await postCall(bridge, { group: 'layer', method: 'create', args: ['rect'], timeoutMs: 200 });

    expect(res.status, 'the tab did not answer inside the deadline').toBe(504);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    // The informative envelope — including its own state check and the recovery
    // clause — reaches the HTTP caller, not a bare "timed out". This route IS
    // the recovery surface, so a timeout here must not be the one place the
    // agent is told nothing.
    expect(String(body.message), 'the relay envelope reaches this caller intact').toContain(
      'the editor may still be executing this call',
    );
  });

  it('routes the caller\'s timeoutMs through the shipped ladder, and reports it in the envelope', async () => {
    const bridge = await liveBridge();
    await connectTab(bridge, { silent: true });

    const res = await postCall(bridge, { group: 'layer', method: 'create', args: ['rect'], timeoutMs: 120 });

    expect(res.status).toBe(504);
    // The RESOLVED number appears in the relay's own envelope, which is the
    // observable proof that the route went through `resolveTimeoutMs` and the
    // shared relay rather than inventing a deadline of its own. A second
    // deadline implementation would be indistinguishable here by accident, so
    // this is the check that matters: the caller asked for 120 and the message
    // says 120.
    expect(String((await res.json() as any).message)).toContain('timed out after 120ms');
    // The clamp itself is `resolveTimeoutMs`'s own behaviour, already pinned for
    // the MCP lane at `req1282BurstDefault.test.ts` ("an over-cap override clamps
    // to the cap instead of being rejected"). Waiting for the 120s ceiling here
    // would buy nothing this does not already have.
  });

  it('refuses an oversized body rather than buffering it — this listener now accepts writes', async () => {
    const bridge = await liveBridge();
    const tab = await connectTab(bridge);
    const before = tab.frames();

    // Uncapped, a request body on a loopback listener is an unbounded local
    // allocation reachable by anything on the machine. The cap is a ceiling, not
    // a policy: one relayed call is orders of magnitude smaller.
    const cap = 32 * 1024 * 1024;
    const res = await postCall(bridge, `{${'"pad":"'.padEnd(cap + 16, 'x')}`);

    expect(res.status, 'past the cap the body is refused, not read').toBe(413);
    const body = (await res.json().catch(() => null)) as any;
    expect(body?.ok, 'with the shipped failure shape').toBe(false);
    expect(tab.frames(), 'and nothing was relayed').toBe(before);
  });
});

describe('REQ-1503 — GET /state is the read-only probe', () => {
  it('is gated on the same token, and never echoes it', async () => {
    const bridge = await liveBridge();
    await connectTab(bridge);

    for (const [label, headers] of [
      ['no token', {}],
      ['the wrong token', { 'x-figpea-token': 'not-the-token' }],
    ] as const) {
      const res = await fetch(`${base(bridge)}/state`, { headers });
      expect(res.status, `${label}: even a read-only probe is gated`).toBe(401);
    }

    const res = await fetch(`${base(bridge)}/state`, { headers: authed(bridge) });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw, 'a state probe that echoes the token hands it to anything that can ask').not.toContain(bridge.token);
    expect(JSON.parse(raw), 'and it parses as the block it claims to be').toMatchObject({
      port: bridge.port,
      tabConnected: true,
    });
  });

  it('reports liveness with no tab round trip at all', async () => {
    const bridge = await liveBridge();
    const tab = await connectTab(bridge);
    // Let the drill finish so the frame count is steady before the measurement.
    await new Promise((r) => setTimeout(r, 300));
    const before = tab.frames();

    const res = await fetch(`${base(bridge)}/state`, { headers: authed(bridge) });
    const body = (await res.json()) as any;

    // Zero, not "few". This route exists to let a recovery procedure CHECK the
    // tab before mutating anything, so a probe that itself drove the tab would
    // be useless exactly when the tab is the thing in question.
    expect(tab.frames(), 'the probe reads ledgers this process already holds').toBe(before);
    expect(body.liveness, 'and it publishes the same liveness block status does').toBeTruthy();
    expect(typeof body.liveness.state).toBe('string');
    expect(typeof body.liveness.nextStep).toBe('string');
    // The pairing diagnosis rides along, so one probe answers "is it paired" and
    // "is it answering" without a second round trip.
    expect(body.connection, 'beside the connection diagnosis, for the same reason').toBeTruthy();
  });

  it('says `unpaired` when no tab is, rather than reporting an empty block', async () => {
    const bridge = await liveBridge();

    const body = (await (await fetch(`${base(bridge)}/state`, { headers: authed(bridge) })).json()) as any;

    expect(body.tabConnected).toBe(false);
    expect(body.liveness.state, 'no tab is the one state that needs no observation').toBe('unpaired');
    expect(body.liveness.nextStep, 'and it still carries the action').not.toBe('');
  });
});

describe('REQ-1503 — neither new route is reachable from a browser', () => {
  it('sends no ACAO on either route, and leaves the allowed methods at GET, OPTIONS', async () => {
    const bridge = await liveBridge();
    await connectTab(bridge);

    for (const [label, res] of [
      ['GET /state', await fetch(`${base(bridge)}/state`, { headers: authed(bridge) })],
      ['POST /call', await postCall(bridge, { group: 'layer', method: 'create', args: ['rect'] })],
    ] as const) {
      expect(
        res.headers.get('access-control-allow-origin'),
        `${label}: no browser origin may read this response`,
      ).toBeNull();
    }

    // A browser cannot send POST without a preflight, and a preflight that
    // answers with `GET, OPTIONS` refuses it. The intended caller is a local
    // process — curl, node, the recovery script — and the tab already has its own
    // WebSocket for anything a page would want to do.
    const preflight = await fetch(`${base(bridge)}/call`, { method: 'OPTIONS' });
    expect(preflight.headers.get('access-control-allow-methods'), 'POST is never preflightable').toBe('GET, OPTIONS');
    expect(preflight.headers.get('access-control-allow-methods')).not.toMatch(/POST/);
  });
});

describe('REQ-1503 — the bridge-info file makes the routes discoverable', () => {
  it('exists at start with the identity a lost-channel caller needs, owner-only', async () => {
    const bridge = await liveBridge();

    const file = bridgeInfoPath(bridge.port);
    expect(fs.existsSync(file), 'the file an agent with no tools looks for is there').toBe(true);

    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as any;
    expect(info.port, 'the port to call').toBe(bridge.port);
    expect(info.token, 'and the token that route requires').toBe(bridge.token);
    expect(info.pid, 'plus this process, so a caller can tell a live run from a leftover').toBe(process.pid);
    expect(String(info.startedAt), 'dated, the way connection.startedAt is').toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Owner-only, so the docs may say so. A per-run token is a real credential
    // for as long as the process lives.
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode, 'the file is readable by its owner only').toBe(0o600);
  });

  it('lives beside the session dirs, never inside one', async () => {
    const bridge = await liveBridge();

    const file = bridgeInfoPath(bridge.port);
    const tokenDir = sessionDirFor(bridge.token);
    // `returnPath.sessionBytes()` charges EVERY entry of the token dir against
    // the per-session return-bytes cap, so a few hundred bytes of JSON written
    // inside one would eat a user's export budget — and a "tidy-up" that moved
    // this file in would look like a plausible cleanup.
    expect(fs.existsSync(tokenDir), 'the per-token session dir may not even exist yet').toBe(false);
    expect(path.dirname(file), 'and the file sits in the shared root').toBe(path.dirname(tokenDir));
    expect(path.basename(file)).not.toBe(bridge.token);
  });

  it('is gone after close(), because the token it names belongs to a dead run', async () => {
    const bridge = await startBridgeServer();
    const file = bridgeInfoPath(bridge.port);
    expect(fs.existsSync(file), 'it is there while the bridge serves').toBe(true);

    await bridge.close();

    expect(fs.existsSync(file), 'and removed with the process that wrote it').toBe(false);
  });

  it('is discovered by the documented glob, so the documented procedure is real', async () => {
    const bridge = await liveBridge();

    // Exactly the command the README tells a reader to run. Pinned as the command
    // rather than as the API, because a procedure that names a glob the code does
    // not satisfy is the defect this file exists to prevent.
    const root = path.join(os.tmpdir(), 'figpea-mcp');
    const matches = fs.readdirSync(root).filter((name) => /^bridge-\d+\.json$/.test(name));
    expect(matches, 'the documented glob finds this run').toContain(path.basename(bridgeInfoPath(bridge.port)));

    openBridges.push(bridge);
  });
});

describe('REQ-1503 — /file and /blob are untouched by this change', () => {
  function tmpFile(ext: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1503-'));
    scratchDirs.push(dir);
    const fp = path.join(dir, `sample${ext}`);
    fs.writeFileSync(fp, content);
    return fp;
  }

  it('GET /file still serves a local file, CORS-open, as it always has', async () => {
    const bridge = await liveBridge();
    const fp = tmpFile('.jpg', 'fake-jpeg-bytes');

    const res = await fetch(`${base(bridge)}/file?path=${encodeURIComponent(fp)}`);

    // Pinned AS IT IS, gate and all: this is a pre-existing ungated local read,
    // it is a real exposure, and it is a different requirement's finding rather
    // than something this change may quietly absorb or quietly tighten.
    expect(res.status, 'the file endpoint still serves').toBe(200);
    expect(res.headers.get('access-control-allow-origin'), 'and is still browser-reachable').toBe('*');
    expect(res.headers.get('content-type')).toMatch(/image\/jpeg/);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('GET /file and /blob keep their own failure codes and their CORS headers', async () => {
    const bridge = await liveBridge();

    const noPath = await fetch(`${base(bridge)}/file`);
    expect(noPath.status, 'a missing path query is still a 400').toBe(400);
    expect(noPath.headers.get('access-control-allow-origin'), 'with CORS, as before').toBe('*');

    const missing = await fetch(`${base(bridge)}/file?path=${encodeURIComponent('/tmp/req1503-nope-xyz.jpg')}`);
    expect(missing.status, 'a missing file is still a 404').toBe(404);
    expect(missing.headers.get('access-control-allow-origin')).toBe('*');

    const relative = await fetch(`${base(bridge)}/file?path=relative.jpg`);
    expect(relative.status, 'a non-absolute path is still refused').toBe(400);

    const unknownBlob = await fetch(`${base(bridge)}/blob/no-such-blob-token`);
    expect(unknownBlob.status, 'an unknown blob token is still a 404').toBe(404);
    expect(unknownBlob.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('an unknown path is still a bare CORS 404, and a registered blob still resolves', async () => {
    const bridge = await liveBridge();
    const fp = tmpFile('.fp', '{"fake":"fp"}');

    const unknown = await fetch(`${base(bridge)}/state-not-a-route`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('access-control-allow-origin'), 'browser checks still get their header').toBe('*');

    const blobUrl = bridge.registerBlob(fp);
    const blob = await fetch(blobUrl);
    expect(blob.status, 'the blob alias still serves the file it registered').toBe(200);
    expect((await blob.text()).length).toBeGreaterThan(0);
  });
});
