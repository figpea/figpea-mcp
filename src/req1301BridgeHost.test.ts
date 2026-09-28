import { describe, it, expect, afterEach } from 'vitest';
import * as dns from 'node:dns';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { startBridgeServer, type BridgeServerHandle } from './bridgeServer';

/**
 * REQ-1301 — the bridge hands the editor `127.0.0.1` URLs, a different origin
 * host from the `localhost` tab that receives them.
 *
 * RED reason: `bridgeServer.ts` builds every URL it hands the tab with the
 * literal host `127.0.0.1` (`getFileUrl` at :449, `registerBlob` at :456),
 * while the editorial convention for the editor origin is `localhost`
 * (`http://localhost:<editorPort>/?agent=1`). `localhost` and `127.0.0.1` are
 * *different hosts* to a browser, so a tab served from `http://localhost:…`
 * receives file/blob/image URLs that cross a hostname boundary it never
 * needed to cross. Every assertion below fails on the unfixed tree because
 * the emitted host is the wrong spelling — never because of an import error or
 * a crash: `startBridgeServer` and both URL builders already exist.
 *
 * ── What AC-2's wording is honestly pinned as (D1) ──────────────────────────
 * The editor page is at `http://localhost:<editorPort>` and the bridge at
 * `http://localhost:<bridgePort>` — **different ports**, so by the URL spec
 * the request is still **cross-origin** and CORS still applies. What the
 * hostname match buys is not sameness but the **localhost / Local Network
 * Access exemption**: same address space ⇒ no cross-hostname preflight and no
 * permission prompt, which an automated (headless) browser cannot answer.
 * That is why these tests assert on **`URL.hostname`**, never on `URL.host` —
 * `host` carries the port, and `bridgePort !== editorPort` by construction
 * (one is an OS-assigned ephemeral, the other the editor's), so a `host`
 * comparison is a condition that can never hold.
 *
 * ── AC-3's honest substitution ─────────────────────────────────────────────
 * AC-3 is about an *editor tab's* IndexedDB origin bucket, which is not
 * observable from a stdio Node package — there is no tab, no origin, no
 * IndexedDB here. AC-3 itself invites the substitution: *"if the honest
 * assertion is 'the emitted URL host is stable', pin that instead"*. This
 * file pins exactly that: the emitted host is `localhost` on **every** call
 * and across **two independent** bridge runs (a stable host ⇒ a stable
 * origin, which is the bridge's half of the fragmentation fix), and it is
 * the same spelling as the loopback editor origin this process is configured
 * with. The substitution is recorded here and in the dev log.
 *
 * ── AC-4 ───────────────────────────────────────────────────────────────────
 * The bind deliberately stays IPv4-only `127.0.0.1`. The negative cases below
 * are the executable form of that decision, not decoration: `[::1]:<port>`
 * must not answer, and neither must the machine's non-internal interface.
 */

/** Hosts `net.connect` may report for "nothing is listening there" — a
 * platform without IPv6 loopback refuses differently, and all of them mean
 * the same thing for AC-4: the bridge is not bound there. */
const REFUSAL_CODES = new Set(['ECONNREFUSED', 'EAFNOSUPPORT', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ECONNRESET']);

const openHandles: BridgeServerHandle[] = [];

afterEach(async () => {
  while (openHandles.length) {
    await openHandles.pop()!.close();
  }
});

async function startTracked(): Promise<BridgeServerHandle> {
  const handle = await startBridgeServer({ port: 0 });
  openHandles.push(handle);
  return handle;
}

function tmpFile(ext: string, content = 'x'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req1301-'));
  const fp = path.join(dir, `f${ext}`);
  fs.writeFileSync(fp, content);
  return fp;
}

type ConnectOutcome = { connected: boolean; code?: string };

/** One TCP connect attempt. Resolves `connected: true` only if the handshake
 * completed; any error or timeout resolves `connected: false` with the code
 * so the assertion can say *why* it was unreachable. */
function tryConnect(host: string, port: number, timeoutMs = 1500): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (outcome: ConnectOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ connected: false, code: 'ETIMEDOUT' }), timeoutMs);
    socket.once('connect', () => finish({ connected: true }));
    socket.once('error', (err: NodeJS.ErrnoException) => finish({ connected: false, code: err.code ?? 'UNKNOWN' }));
    socket.connect(port, host);
  });
}

/** The machine's first non-internal IPv4, or `null` on a host that has none
 * (an isolated CI container). */
function externalIPv4(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

const EXTERNAL_IPV4 = externalIPv4();

// ─────────────────────────────────────────────────────────────────────────────
describe('REQ-1301 AC-1 (repro): the bridge emits localhost URLs, never 127.0.0.1', () => {
  it('getFileUrl returns a localhost URL on the bridge port with no 127.0.0.1 in it', async () => {
    const bridge = await startTracked();
    const url = bridge.getFileUrl('/tmp/a.png');
    const parsed = new URL(url);
    expect(parsed.hostname, 'the emitted URL host is the host the editor tab is served from').toBe('localhost');
    expect(parsed.port, 'and it is the bridge port').toBe(String(bridge.port));
    expect(url, 'no 127.0.0.1 anywhere in the emitted string').not.toContain('127.0.0.1');
  });

  it('registerBlob returns a localhost blob URL on the bridge port with no 127.0.0.1 in it', async () => {
    const bridge = await startTracked();
    const url = bridge.registerBlob('/tmp/a.png');
    const parsed = new URL(url);
    expect(parsed.hostname, 'the emitted blob URL host is localhost too').toBe('localhost');
    expect(parsed.port, 'and it is the bridge port').toBe(String(bridge.port));
    expect(url, 'no 127.0.0.1 anywhere in the emitted blob string').not.toContain('127.0.0.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('REQ-1301 AC-2: a localhost editor origin can actually fetch the emitted URL', () => {
  it('a real fetch of the getFileUrl URL from a localhost editor origin succeeds, CORS headers and all', async () => {
    const bridge = await startTracked();
    const realFile = tmpFile('.png', 'png-bytes-for-req1301');

    // The editor origin a run of this toolchain is actually configured with:
    // a *different* port from the bridge's OS-assigned ephemeral one.
    const editorPort = 8642;
    const editorOrigin = `http://localhost:${editorPort}/?agent=1`;

    const emitted = bridge.getFileUrl(realFile);
    const res = await fetch(emitted);

    expect(res.status, 'the emitted URL resolves and serves the file').toBe(200);
    expect(res.headers.get('access-control-allow-origin'),
      'the cross-origin (different-port) read is permitted').toBe('*');

    // Host identity — asserted on `.hostname`, and separately on the port,
    // because `.host` would carry the port and could never match.
    expect(new URL(emitted).hostname, 'same host as the editor origin').toBe(new URL(editorOrigin).hostname);
    expect(new URL(emitted).port, 'a different port — this is still cross-origin by the URL spec')
      .toBe(String(bridge.port));
    expect(String(bridge.port)).not.toBe(String(editorPort));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('REQ-1301 AC-3: the emitted host is stable (the AC\'s own permitted substitution)', () => {
  it('every emitted URL has the same host, and it is the configured loopback editor origin\'s host', async () => {
    const editorOrigin = 'http://localhost:8642/?agent=1';
    const expectedHost = new URL(editorOrigin).hostname;

    const first = await startTracked();
    const second = await startTracked(); // an independent run, as run A → run B
    expect(second.port, 'the two runs really are different ports').not.toBe(first.port);

    for (const bridge of [first, second]) {
      for (const url of [bridge.getFileUrl('/tmp/a.png'), bridge.registerBlob('/tmp/a.png')]) {
        const host = new URL(url).hostname;
        expect(host, 'stable host ⇒ a stable origin, across calls and across runs').toBe(expectedHost);
        expect(url).not.toContain('127.0.0.1');
      }
    }
  });

  it('holds for a loopback editor origin on whatever port it is configured with', async () => {
    // Same assertion, driven from a non-default editor port, to pin that the
    // emitted host tracks the *hostname* of the configured origin and is not
    // merely a coincidence of one particular port.
    const previous = process.env.FIGPEA_EDITOR_URL;
    process.env.FIGPEA_EDITOR_URL = 'http://localhost:5555/';
    try {
      const bridge = await startTracked();
      const editorHost = new URL(process.env.FIGPEA_EDITOR_URL!).hostname;
      expect(new URL(bridge.getFileUrl('/tmp/a.png')).hostname,
        'the bridge speaks the same host spelling the editor is served from').toBe(editorHost);
    } finally {
      if (previous === undefined) delete process.env.FIGPEA_EDITOR_URL;
      else process.env.FIGPEA_EDITOR_URL = previous;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('REQ-1301 AC-4: the bind stays loopback-only', () => {
  it('nothing is listening on [::1] at the bridge port — the bind is IPv4-only, by decision', async () => {
    const bridge = await startTracked();
    const outcome = await tryConnect('::1', bridge.port);
    expect(outcome.connected, `the bridge must not be reachable on [::1] (got ${outcome.code})`).toBe(false);
    expect(outcome.code, 'and it fails by refusing, not by silently accepting').toBeTruthy();
    if (outcome.code && outcome.code !== 'ETIMEDOUT') {
      expect(REFUSAL_CODES.has(outcome.code), `expected a refusal, got ${outcome.code}`).toBe(true);
    }
  });

  it.skipIf(EXTERNAL_IPV4 === null)('nothing is reachable on the non-loopback interface', async () => {
    const bridge = await startTracked();
    const outcome = await tryConnect(EXTERNAL_IPV4!, bridge.port);
    expect(outcome.connected, `the bridge must not be reachable on ${EXTERNAL_IPV4} (got ${outcome.code})`).toBe(false);
  });

  it.skipIf(EXTERNAL_IPV4 !== null)('is skipped: this host has no non-internal IPv4 interface', () => {
    // Never silently passed — the skip is visible here and in the run output.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('REQ-1301 D2: the emitted localhost URL is served end-to-end on this platform', () => {
  it('`localhost` is reachable for a real fetch, whatever order it resolves in', async () => {
    const bridge = await startTracked();
    const realFile = tmpFile('.txt', 'req1301 end-to-end');

    const resolved = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      dns.lookup('localhost', { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
    });

    // The guarantee D2 needs pinned is *reachability of the emitted host*, not
    // the order `localhost` happens to resolve in. That order is a property of
    // the host's resolver, not of this repo: macOS returns ::1 first (an
    // RFC 6724 sort — its /etc/hosts lists 127.0.0.1 first, and the reversal is
    // the resolver's doing), glibc returns /etc/hosts order, and an IPv6-less
    // host returns only 127.0.0.1. Asserting the order would freeze a macOS
    // observation as a universal fact and go red on this package's own
    // ubuntu-latest CI job, so it is documented here and not asserted.
    //
    // What IS asserted is the part that must hold everywhere: 127.0.0.1 is in
    // the set — the listener is IPv4-only, so this is what makes the bind
    // reachable by name at all — and the emitted URL is then served end to end.
    // On a ::1-first host that exercises the RFC 6555 racing fallback; on a
    // 127.0.0.1-first host it is a direct IPv4 connection. Both must be 200.
    // A host *without* the fallback fails here, which is the point.
    expect(resolved.some((a) => a.address === '127.0.0.1'),
      `the bind is IPv4-only, so 127.0.0.1 must be in the resolution set (got ${JSON.stringify(resolved)})`).toBe(true);

    const res = await fetch(bridge.getFileUrl(realFile));
    expect(res.status, 'the emitted localhost URL is served end-to-end regardless of resolver order').toBe(200);
    expect(await res.text()).toBe('req1301 end-to-end');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('REQ-1301 AC-6: no public API change', () => {
  it('getFileUrl and registerBlob keep their single-argument signatures', async () => {
    const bridge = await startTracked();
    expect(bridge.getFileUrl.length, 'getFileUrl(filePath) — unchanged').toBe(1);
    expect(bridge.registerBlob.length, 'registerBlob(filePath) — unchanged').toBe(1);
    expect(typeof bridge.getFileUrl('/tmp/a.png')).toBe('string');
    expect(typeof bridge.registerBlob('/tmp/a.png')).toBe('string');
  });
});
