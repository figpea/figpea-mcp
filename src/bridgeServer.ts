/**
 * REQ-074 T3 — bridge WebSocket server & session lifecycle (plan §3; AC-3
 * security, OQ-3 multi-tab, OQ-2 loopback). A pure relay: this module owns
 * zero editor logic, only the localhost listener, the per-run pairing-token
 * gate, request/response id-correlation, and newest-wins takeover.
 *
 * REQ-1017 — add loopback HTTP file endpoint GET /file?path=… (+ /blob/<token>)
 * with ACAO:* and MIME, backed by http.createServer + WebSocketServer({server}).
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';
import { BRIDGE_BIND_HOST, BRIDGE_URL_HOST } from './bridgeHost';
import { DEFAULT_CALL_TIMEOUT_MS, stateCheckHint } from './callTimeout';
import { createConnectionLedger, deriveDiagnosis, type ConnectionDiagnosis } from './connectionDiagnosis';
// REQ-1457 — the ONE build-identity ledger, a zero-import leaf. It lives in
// its own module precisely so this file and `mcpServer.ts` can both read it
// without either importing the other: `SERVER_VERSION` moved there for the same
// reason, and this is the other half of that reason.
import { servingBuildStamp } from './buildIdentity';
import type { CallFrame, DescribeFrame } from './protocol';
import { drillManifest, type DescribeFn, type DescribeResultPayload } from './describeDrill';
import { sessionDirFor, removeSessionDir } from './returnPath';

/** Distinct WebSocket close codes for the server-initiated close paths
 * (AC-3, OQ-3) — both >=4000 (RFC 6455 private-use range), unambiguously
 * distinct from normal/protocol closes (1000-2999). */
export const CLOSE_CODE_BAD_TOKEN = 4001;
export const CLOSE_CODE_SUPERSEDED = 4002;

/** REQ-1492 — how many editor tabs one bridge can hold at once in multi-slot
 * mode. A bound on per-tab sockets, pending calls and one `describe` drill each,
 * not an AC and not a policy: past it a connection is refused exactly as a
 * single-slot bridge refuses a second one, with the cap named in the reason. */
export const MAX_SLOTS = 8;

/** REQ-1492 — how many tabs a bridge serves. `single` (the default) is the
 * pre-existing one-tab flow, now with a REFUSAL where it used to have a
 * silent takeover; `multi` gives each tab its own slot and its own document. */
export type BridgeSlotMode = 'single' | 'multi';

/** REQ-1492 — one paired tab, as `status` publishes it (AC-6).
 *
 * `origin` is the WebSocket upgrade request's `Origin` header and NOTHING else:
 * the bridge never reconstructs an origin from the pairing URL or `Host`,
 * because a fabricated origin is worse than a missing one when the whole point
 * is that a caller can *assert* it. `originSource` is therefore always present
 * and says which of the two states the value carries — a caller distinguishes
 * "the browser sent it", "the browser declined to send it", and "this build
 * does not publish the field at all" from one payload. */
export interface BridgeConnection {
  connectionId: string;
  origin: string | null;
  originSource: 'handshake' | 'absent';
  contractVersion: string | null;
  pairedAt: string;
  active: boolean;
}

/** How long a freshly connected socket has to send its `hello` frame before
 * being closed for inactivity — generous, since every real client sends
 * `hello` as its very first frame with no round trip in between. */
const HELLO_TIMEOUT_MS = 5000;

/** REQ-1282 D1 — the relay's per-call deadline is no longer a local
 * constant: it is the same flat floor the MCP layer resolves to, so the two
 * cannot drift (they were 10 s here and "undefined, i.e. whatever this file
 * says" in `mcpServer.ts`, which is how a 12 s create was reported as a
 * failure while the tab applied it). */

/** How long one `describe` frame may go unanswered before the drill gives up
 * on it (REQ-188). A stalled tab must degrade to a skipped group — or, for
 * the bare index, to no contract tools — never to a promise that never
 * settles and wedges the connection's drill forever. */
const DESCRIBE_TIMEOUT_MS = 10_000;

export interface StartBridgeServerOptions {
  /** Bind port; omit (or 0) for an OS-assigned ephemeral port (the normal,
   * parallel-run-safe case — plan §3). */
  port?: number;
  /** REQ-1492: `single` (default) serves one tab and REFUSES a second with a
   * named reason; `multi` gives each tab its own slot. Resolved upstream by
   * `cli.ts`'s `resolveBridgeSlots`, so an invalid value can never reach here. */
  slots?: BridgeSlotMode;
}

export interface BridgeServerHandle {
  /** The bound, OS-assigned (unless overridden) ephemeral port, reachable at
   * 127.0.0.1 only. */
  readonly port: number;
  /** The per-run pairing token a connecting tab must echo back in its
   * `hello` frame. */
  readonly token: string;
  /** Whether a tab is currently connected and past the token gate. */
  isTabConnected(): boolean;
  /** REQ-1492: which slot mode this bridge is serving — `single` (the
   * default) or `multi`. Read by `status` and by the mode gate on
   * `select_tab`; the value cannot change without a restart. */
  getSlotMode(): BridgeSlotMode;
  /** REQ-1492: every paired tab, in pair order, each with its own id, origin
   * (`null` when the browser sent no `Origin` header, with `originSource`
   * saying so), contract version and whether it is the active one. */
  getConnections(): BridgeConnection[];
  /** REQ-1492: moves the active pointer to a paired tab AND re-publishes THAT
   * tab's cached manifest, so the registered tool surface describes the tab
   * calls are about to reach (AC-4). Rejects by name for an unknown id, naming
   * the live ones — silent fallback to the active tab is the defect class. */
  selectConnection(connectionId: string): Promise<void>;
  /**
   * REQ-1394: what this bridge observed about the pairing attempt, as an
   * actionable token plus the counters behind it. Per-process — it says
   * nothing about any previous run, which is what `startedAt` dates.
   *
   * Not a socket inspection and not a verdict: `isTabConnected()` remains
   * authoritative for whether a tab is live RIGHT NOW.
   */
  getConnectionDiagnosis(): ConnectionDiagnosis;
  /** Registers a handler invoked with the connected tab's live
   * `figpea.describe()` manifest, each time one is received (initial connect
   * and every reconnect/takeover). */
  onDescribe(handler: (manifest: unknown) => void): void;
  /** The connected tab's most recently reported `figpea.version`, or `null`
   * if no tab has ever reported one. */
  getContractVersion(): string | null;
  /** Relays a call to the paired tab, resolving with its structured
   * `{ok,...}` result, correlated by a server-assigned id. Rejects if no tab
   * is connected, or once `timeoutMs` elapses with no matching result.
   *
   *  REQ-1492: `connectionId` addresses a specific paired tab; omitting it is
   *  the active one. An unknown or closed id REJECTS naming the live ids — it
   *  never falls back to the active tab. */
  callTab(group: string, method: string, args: unknown[], timeoutMs?: number, connectionId?: string): Promise<unknown>;
  /** Shuts down the listener and rejects any still-pending calls. */
  close(): Promise<void>;
  /** REQ-1017: returns a loopback URL for the given absolute filePath (primary endpoint). */
  getFileUrl(filePath: string): string;
  /** REQ-1017: registers a blob token alias for the filePath and returns its /blob URL. */
  registerBlob(filePath: string): string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * REQ-1492 — one paired editor tab, and everything that is true only of IT.
 *
 * `contractVersion`, `pendingDescribe` and the pending-call map used to be
 * module-scoped, which is safe for exactly one tab and silently wrong for two:
 * a second tab overwrote the first's reported contract version and stole its
 * in-flight `describe` reply. Per-slot state is the whole fix, and it is why
 * "which tab am I addressing" and "whose schema am I holding" can move together.
 */
interface Slot {
  /** `c1`, `c2`, … assigned in pair order and stable for the connection's life. */
  id: string;
  socket: WebSocket;
  origin: string | null;
  originSource: 'handshake' | 'absent';
  contractVersion: string | null;
  pairedAt: string;
  /** Pair order, so promotion on close picks the LONGEST-paired survivor. */
  pairedSeq: number;
  /** This tab's drilled manifest, cached so selecting it needs no round trip. */
  manifest: unknown;
  pendingDescribe: ((payload: DescribeResultPayload) => void) | undefined;
  pending: Map<string, PendingCall>;
  /** The in-flight drill, so a mid-drill `selectConnection` waits for it. */
  drillPromise: Promise<unknown> | undefined;
}

/** Starts the localhost-only bridge WebSocket + HTTP file server (plan §3, REQ-1017). */
export async function startBridgeServer(options?: StartBridgeServerOptions): Promise<BridgeServerHandle> {
  const token = crypto.randomUUID();

  // REQ-1020 D5 — per-session dir for off-band image returns
  // (`<tmpdir>/figpea-mcp/<token>/`, created lazily by the writer on first
  // path-return, removed in `close()` below). Tab takeover under the same
  // token keeps the session, so no cleanup there; a new server run mints a
  // new token and a new dir.
  const sessionDir = sessionDirFor(token);

  // --- REQ-1017 file handling helpers ---
  const blobMap = new Map<string, string>(); // token -> filePath

  function mimeForPath(p: string): string {
    const ext = path.extname(p).toLowerCase();
    switch (ext) {
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.png': return 'image/png';
      case '.webp': return 'image/webp';
      case '.svg': return 'image/svg+xml';
      case '.gif': return 'image/gif';
      case '.pdf': return 'application/pdf';
      case '.fp': return 'application/octet-stream';
      case '.fig': return 'application/octet-stream';
      case '.psd': return 'image/vnd.adobe.photoshop';
      case '.json': return 'application/json';
      case '.txt': return 'text/plain';
      default: return 'application/octet-stream';
    }
  }

  function setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  async function handleFileRequest(res: http.ServerResponse, filePath: string): Promise<void> {
    // Security: absolute, no null byte
    if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
      setCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'invalid_path', message: `invalid filePath: ${filePath}` }));
      return;
    }
    const normalized = path.normalize(filePath);
    // Size guard / existence
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(normalized);
    } catch {
      setCorsHeaders(res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'not_found', message: `file not found: ${filePath}` }));
      return;
    }
    if (!stat.isFile()) {
      setCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'invalid_path', message: `not a file: ${filePath}` }));
      return;
    }
    const MAX_BYTES = 50 * 1024 * 1024;
    if (stat.size > MAX_BYTES) {
      setCorsHeaders(res);
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'too_large', message: `file too large: ${stat.size}` }));
      return;
    }
    const mime = mimeForPath(normalized);
    setCorsHeaders(res);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(normalized);
    stream.on('error', () => {
      try { res.end(); } catch {}
    });
    stream.pipe(res);
  }

  function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Always handle CORS preflight
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }
    // REQ-1301: the parser *base*, not an emitted URL. Over HTTP/1.1 `Host` is
    // always present, so the fallback is unreachable in normal traffic; it is
    // the URL host constant only so this file cannot disagree with itself.
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? BRIDGE_URL_HOST}`);
    if (req.method === 'GET' && url.pathname === '/file') {
      const fp = url.searchParams.get('path');
      if (!fp) {
        setCorsHeaders(res);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'invalid_path', message: 'missing path query' }));
        return;
      }
      void handleFileRequest(res, fp);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/blob/')) {
      const tok = url.pathname.slice('/blob/'.length);
      const fp = blobMap.get(tok);
      if (!fp) {
        setCorsHeaders(res);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'not_found', message: 'unknown blob token' }));
        return;
      }
      void handleFileRequest(res, fp);
      return;
    }
    // Unknown path: 404 with CORS so browser checks don't fail due to missing header
    setCorsHeaders(res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'not_found' }));
  }

  const httpServer = http.createServer(requestHandler);

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    httpServer.once('error', onErr);
    // REQ-1301: a rename, not a behaviour change — the bind stays IPv4-only
    // loopback, which is a security property. See BRIDGE_BIND_HOST for why it
    // does not follow the emitted URL host to `localhost`.
    httpServer.listen(options?.port ?? 0, BRIDGE_BIND_HOST, () => {
      httpServer.removeListener('error', onErr);
      resolve();
    });
  });

  const wss = new WebSocketServer({ server: httpServer });

  // REQ-1394 — one ledger per run, created HERE so `startedAt` dates the run
  // that observed the events rather than the module's load time (which, in a
  // long-lived host process, could be many runs ago).
  const ledger = createConnectionLedger();

  // REQ-1394: every accepted TCP socket, including REQ-1017's `/file` and
  // `/blob` requests, which share this listener. The ledger only reports
  // `transport_only` while nothing has upgraded, so counting them is safe —
  // see the guard in connectionDiagnosis.ts, and the re-check note any change
  // to the file endpoints must make.
  httpServer.on('connection', () => {
    ledger.record('transport_only');
  });

  // Lives for the server's whole lifetime (not just startup) -- logs rather
  // than throwing, since a single bad frame from a tab must never take the
  // bridge down (AC-3's "pure relay" never trusts the far side).
  wss.on('error', (err: Error) => {
    console.error('[figpea-mcp] bridge server error:', err);
  });
  httpServer.on('error', (err: Error) => {
    console.error('[figpea-mcp] http server error:', err);
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('figpea-mcp bridgeServer: failed to determine the bound ephemeral port');
  }
  const port = (address as { port: number }).port;

  // REQ-1492 — the slot registry. One `Slot` per paired tab, each carrying
  // everything that used to be process-scoped and therefore could not survive
  // two tabs honestly: the socket, the contract version it reported, its own
  // `describe` reply slot, its own pending calls, and the manifest it drilled.
  // Before this, `contractVersion` and `pendingDescribe` were per-PROCESS, so a
  // second tab would overwrite the first's reported contract version and steal
  // the other tab's in-flight `describe` reply (replies carry no correlation
  // id and are matched by order only — `protocol.ts`).
  const slots = new Map<string, Slot>();
  /** Which slot unaddressed calls go to, and whose manifest is published.
   * The first tab to pair takes it; a later tab never steals it (AC-3). */
  let activeSlotId: string | undefined;
  let nextSlotId = 1;
  let nextCallId = 1;
  const describeHandlers: Array<(manifest: unknown) => void> = [];
  const slotMode: BridgeSlotMode = options?.slots === 'multi' ? 'multi' : 'single';

  function activeSlot(): Slot | undefined {
    return activeSlotId === undefined ? undefined : slots.get(activeSlotId);
  }

  function isLive(slot: Slot | undefined): slot is Slot {
    return slot !== undefined && slot.socket.readyState === WebSocket.OPEN;
  }

  /** The live slots in pair order — what a refusal reason and a bad-id
   * rejection both name, so neither can leave a caller guessing. */
  function liveIds(): string[] {
    return [...slots.values()].filter(isLive).map((s) => s.id);
  }

  /** The longest-paired live slot — the successor when the active one leaves. */
  function longestPaired(): Slot | undefined {
    let best: Slot | undefined;
    for (const slot of slots.values()) {
      if (!isLive(slot)) continue;
      if (best === undefined || slot.pairedSeq < best.pairedSeq) best = slot;
    }
    return best;
  }

  function publishManifest(manifest: unknown): void {
    for (const handler of describeHandlers) handler(manifest);
  }

  /** How a slot is named inside a refusal reason: its origin when the browser
   * sent one, and the honest "no Origin header" wording when it did not — never
   * a reconstructed origin in a message a reader will act on. */
  function describeOrigin(slot: Slot): string {
    return slot.origin ?? 'no Origin header';
  }

  /** Socket → its slot, so the `close` handler can find the bookkeeping this
   * socket created. A socket that was refused or rejected never appears here,
   * which is what keeps its close from recording a second, wrong event. */
  const slotForSocket = new Map<WebSocket, Slot>();

  /** REQ-1492 AC-7 — refuses one connection, by name, displacing nothing.
   *
   * `4002` is reused deliberately: it is the code the editor already renders as
   * a terminal "another tab holds this" state, and a NEW code with no editor
   * branch would land on the wrong-cause "This one needs you" card with a
   * Connect button that re-dials into the same refusal. The reason string is
   * truncated to the RFC 6455 123-byte payload limit so a long origin cannot
   * turn the close into a protocol error. */
  function refuseSocket(socket: WebSocket, reason: string): void {
    const trimmed = reason.length > 120 ? `${reason.slice(0, 117)}...` : reason;
    ledger.record('slot_refused', { closeCode: CLOSE_CODE_SUPERSEDED, closeReason: trimmed });
    socket.close(CLOSE_CODE_SUPERSEDED, trimmed);
  }

  function rejectSlotPending(slot: Slot, reason: unknown): void {
    for (const entry of slot.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    slot.pending.clear();
  }

  function rejectAllPending(reason: unknown): void {
    for (const slot of slots.values()) rejectSlotPending(slot, reason);
  }

  function sendFrame(socket: WebSocket, frame: unknown): void {
    socket.send(JSON.stringify(frame));
  }

  /** Per-slot frame handler: a `describe_result` and a `result` are only ever
   * matched against THIS socket's own pending work, which is what lets two tabs
   * answer simultaneously without either stealing the other's reply. */
  function makeTabFrameHandler(slot: Slot): (data: WebSocket.RawData) => void {
    return (data: WebSocket.RawData): void => {
      let frame: any;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // Malformed frame from an already-authenticated tab: drop it, never crash the relay.
      }

      if (frame?.type === 'describe_result') {
        slot.contractVersion = typeof frame.version === 'string' ? frame.version : null;
        const resolve = slot.pendingDescribe;
        slot.pendingDescribe = undefined;
        // `manifest` is absent (not null) when the selector missed, so presence
        // is tested on the parsed frame rather than inferred from the value.
        resolve?.({
          hasManifest: Object.prototype.hasOwnProperty.call(frame, 'manifest'),
          manifest: frame.manifest,
          version: slot.contractVersion,
        });
        return;
      }

      if (frame?.type === 'result' && typeof frame.id === 'string') {
        const entry = slot.pending.get(frame.id);
        if (!entry) return; // Stale/unknown id (e.g. already timed out) -- ignore.
        slot.pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.ok) {
          entry.resolve({ ok: true, value: frame.value });
        } else {
          entry.resolve({ ok: false, code: frame.code, message: frame.message });
        }
      }
    };
  }

  /** Issues one `describe` frame on a slot's socket and resolves with its
   * reply.
   *
   * Rejects on timeout, and on the tab's departure. The resolver lives ON THE
   * SLOT (REQ-1492), not on the process: one per slot is enough because
   * `describe_result` frames carry no correlation id and no selector echo (see
   * `protocol.ts`), so a reply can only be matched to its request by ordering —
   * and two tabs each holding their own resolver is what stops one tab's drill
   * from consuming the other's reply. The drill awaits each frame before
   * sending the next, which keeps each slot occupied by at most one request. */
  function describeOnce(slot: Slot): DescribeFn {
    return (selector?: string) =>
      new Promise<DescribeResultPayload>((resolve, reject) => {
        if (!isLive(slot) || slots.get(slot.id) !== slot) {
          reject(new Error('figpea-mcp bridgeServer: tab disconnected before describe completed'));
          return;
        }

        const timer = setTimeout(() => {
          if (slot.pendingDescribe === settle) slot.pendingDescribe = undefined;
          reject(
            new Error(
              // REQ-1457 AC-4 — APPENDED after the existing text, never
              // substituted for it. This is the SECOND authored timeout
              // envelope in this package (the first is `callTab` below), and
              // AC-4 says *every*: stamping the relay while leaving the drill
              // bare would make the guarantee true of one path and false of
              // the other. The stamp is what lets a caller match a stuck drill
              // against the commit it believes is running.
              `figpea-mcp bridgeServer: describe(${selector ?? ''}) timed out after ${DESCRIBE_TIMEOUT_MS}ms; ${servingBuildStamp()}`,
            ),
          );
        }, DESCRIBE_TIMEOUT_MS);

        const settle = (payload: DescribeResultPayload): void => {
          clearTimeout(timer);
          resolve(payload);
        };

        slot.pendingDescribe = settle;
        // `selector` is omitted entirely for the bare index call, keeping
        // that frame byte-identical to the pre-REQ-181 one.
        const frame: DescribeFrame = selector === undefined ? { type: 'describe' } : { type: 'describe', selector };
        sendFrame(slot.socket, frame);
      });
  }

  /**
   * Drills one tab's full manifest, caches it ON THE SLOT, and publishes it to
   * `onDescribe` subscribers — but only when that tab is the one calls are
   * addressed to (REQ-188's once-per-connect contract, REQ-1492's per-slot one).
   *
   * Caching every tab and publishing only the active one is the invariant that
   * lets `selectConnection` hand subscribers the SELECTED tab's descriptions
   * without re-drilling: the manifest is already there, keyed on its own slot,
   * so two tabs on different contract versions can never cross-assign.
   */
  async function runDescribeDrill(slot: Slot): Promise<unknown> {
    const manifest = await drillManifest(describeOnce(slot), (message) => console.error(message));
    if (manifest === undefined) return undefined;
    slot.manifest = manifest;
    // A tab that stopped being the addressed one must not publish its manifest
    // over the tab that is.
    if (activeSlotId !== slot.id) return manifest;
    publishManifest(manifest);
    return manifest;
  }

  /** Runs the drill once per slot and remembers the in-flight promise, so a
   * `selectConnection` arriving mid-drill waits for THAT drill instead of
   * starting a second one that would fight it for the slot's single
   * `describe` resolver. */
  function startDescribeDrill(slot: Slot): Promise<unknown> {
    if (slot.drillPromise) return slot.drillPromise;
    const promise = runDescribeDrill(slot).finally(() => {
      if (slot.drillPromise === promise) slot.drillPromise = undefined;
    });
    slot.drillPromise = promise;
    return promise;
  }

  // REQ-1492 — the upgrade request, captured once here: it is the only honest
  // source of a tab's origin (AC-6) and of nothing else.
  wss.on('connection', (socket: WebSocket, request: http.IncomingMessage) => {
    socket.on('error', () => {
      // A transport-level error on an individual socket must never crash the
      // bridge or leave an unhandled 'error' rejection; 'close' still fires
      // and tears down bookkeeping normally.
    });

    // REQ-1394: the handshake completed. Counted HERE rather than on the
    // `hello` outcome below so a silent socket suppresses `transport_only` the
    // moment it reaches the handshake, not up to 5 s later when the timer fires.
    ledger.recordUpgrade();

    let sawHello = false;
    const helloTimer = setTimeout(() => {
      if (!sawHello) {
        // REQ-1394: recorded at the point the close is INITIATED, not
        // reconstructed from the close code later — three different causes all
        // close with 4001 (no hello / malformed hello / bad token), so the code
        // cannot separate them and the reason must never be re-parsed.
        ledger.record('hello_timeout', {
          closeCode: CLOSE_CODE_BAD_TOKEN,
          closeReason: 'no hello frame received',
        });
        socket.close(CLOSE_CODE_BAD_TOKEN, 'no hello frame received');
      }
    }, HELLO_TIMEOUT_MS);

    function safeDecodeAndTrim(s: string): string {
      let out = s;
      try {
        out = decodeURIComponent(out);
      } catch {}
      return out.trim();
    }

    const onHelloFrame = (data: WebSocket.RawData): void => {
      clearTimeout(helloTimer);
      socket.off('message', onHelloFrame);

      let frame: any;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        ledger.record('hello_rejected', { closeCode: CLOSE_CODE_BAD_TOKEN, closeReason: 'malformed hello frame' });
        socket.close(CLOSE_CODE_BAD_TOKEN, 'malformed hello frame');
        return;
      }

      const receivedRaw = frame?.token == null ? '' : String(frame.token);
      const received = safeDecodeAndTrim(receivedRaw);
      const expected = safeDecodeAndTrim(token);
      if (frame?.type !== 'hello' || !received || received !== expected) {
        ledger.record('hello_rejected', {
          closeCode: CLOSE_CODE_BAD_TOKEN,
          closeReason: 'invalid or missing pairing token',
        });
        socket.close(CLOSE_CODE_BAD_TOKEN, 'invalid or missing pairing token');
        return;
      }

      sawHello = true;

      // REQ-1492 — the refusal REPLACED the newest-wins takeover (OQ-3). The
      // takeover closed the incumbent and left `status` reporting
      // `tabConnected: true`, so the evicted session's next write landed in the
      // other session's document with nothing saying so. A refusal displaces
      // nothing: the incumbent keeps its socket, keeps serving, and the refusal
      // is a named state (`slot_refused`) with the action to take.
      const holder = longestPaired();
      if (slotMode === 'single' && holder) {
        refuseSocket(socket, `slot held by ${holder.id} (${describeOrigin(holder)}) — this bridge serves one tab`);
        return;
      }
      if (slotMode === 'multi' && slots.size >= MAX_SLOTS) {
        refuseSocket(socket, `all ${MAX_SLOTS} bridge slots are taken (${liveIds().join(', ')}) — close a tab, or restart the bridge`);
        return;
      }

      ledger.record('hello_accepted');

      const rawOrigin = typeof request.headers.origin === 'string' ? request.headers.origin.trim() : '';
      const slot: Slot = {
        id: `c${nextSlotId++}`,
        socket,
        // AC-6: the origin is the upgrade request's header and nothing else —
        // never reconstructed from the pairing URL or `Host`, because a
        // fabricated origin is worse than a missing one.
        origin: rawOrigin === '' ? null : rawOrigin,
        originSource: rawOrigin === '' ? 'absent' : 'handshake',
        contractVersion: null,
        pairedAt: new Date().toISOString(),
        pairedSeq: nextSlotId,
        manifest: undefined,
        pendingDescribe: undefined,
        pending: new Map(),
        drillPromise: undefined,
      };
      slots.set(slot.id, slot);
      slotForSocket.set(socket, slot);
      // The first tab to pair is the one calls are addressed to, and a later tab
      // never steals it (AC-3) — in either mode.
      if (activeSlotId === undefined) activeSlotId = slot.id;

      socket.on('message', makeTabFrameHandler(slot));
      void startDescribeDrill(slot);
    };

    socket.on('message', onHelloFrame);

    // REQ-1394: the listener finally TAKES the close code, which it previously
    // discarded at the signature. It records `disconnected` only for the socket
    // that IS the active one — every server-initiated close (bad token, hello
    // timeout, refusal) recorded its own token and its own code at the branch
    // that performed it, so a rejected socket must not overwrite that with a
    // generic "disconnected" a few milliseconds later.
    socket.on('close', (code: number, reason: Buffer) => {
      clearTimeout(helloTimer);
      // A socket refused or rejected before pairing never became a slot.
      const slot = slotForSocket.get(socket);
      if (!slot) return;
      slotForSocket.delete(socket);
      slots.delete(slot.id);
      // This tab's own in-flight calls are rejected NOW, naming it, rather than
      // left to time out against a socket that is already gone.
      rejectSlotPending(slot, new Error(`figpea-mcp bridgeServer: tab ${slot.id} disconnected`));

      if (activeSlotId !== slot.id) return;
      activeSlotId = undefined;
      ledger.record('disconnected', { closeCode: code, closeReason: reason.toString() });

      // REQ-1492 — the addressed tab left. Promote the longest-paired survivor
      // and re-publish ITS cached manifest, so the registered tool surface
      // describes the tab calls now reach instead of the one that just closed.
      const successor = longestPaired();
      if (successor === undefined) return;
      activeSlotId = successor.id;
      if (successor.manifest !== undefined) publishManifest(successor.manifest);
    });
  });

  return {
    port,
    token,
    getSlotMode(): BridgeSlotMode {
      return slotMode;
    },
    getConnections(): BridgeConnection[] {
      return [...slots.values()].map((slot) => ({
        connectionId: slot.id,
        origin: slot.origin,
        originSource: slot.originSource,
        contractVersion: slot.contractVersion,
        pairedAt: slot.pairedAt,
        active: slot.id === activeSlotId,
      }));
    },
    async selectConnection(connectionId: string): Promise<void> {
      const slot = slots.get(connectionId);
      if (!isLive(slot)) {
        // Naming the live ids is the point: silent fallback to the active tab is
        // the defect class this requirement exists to close.
        throw new Error(
          `figpea-mcp bridgeServer: no paired tab ${connectionId} — live connections: ${liveIds().join(', ') || 'none'}`,
        );
      }
      activeSlotId = slot.id;
      // Moving the pointer alone would leave full-mode tools describing the
      // PREVIOUSLY active tab while its calls went here — reachable, and exactly
      // the incident's shape, because its two tabs ran contract 2.59.1 and
      // 2.50.0. The manifest is keyed on THIS slot, so the two can never
      // cross-assign.
      if (slot.manifest === undefined) await startDescribeDrill(slot);
      if (slot.manifest !== undefined) publishManifest(slot.manifest);
    },
    isTabConnected(): boolean {
      return isLive(activeSlot());
    },
    // REQ-1394: a snapshot derived through the one shared derivation, so the
    // token an agent reads is the same token the README documents.
    getConnectionDiagnosis(): ConnectionDiagnosis {
      return deriveDiagnosis(ledger.snapshot());
    },
    onDescribe(handler: (manifest: unknown) => void): void {
      describeHandlers.push(handler);
    },
    getContractVersion(): string | null {
      // The ACTIVE tab's version — identical to the pre-REQ-1492 value whenever
      // one tab is paired (AC-8), and the meaning AC-6 asks for when two are.
      return activeSlot()?.contractVersion ?? null;
    },
    callTab(
      group: string,
      method: string,
      args: unknown[],
      timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
      connectionId?: string,
    ): Promise<unknown> {
      const slot = connectionId === undefined ? activeSlot() : slots.get(connectionId);
      if (!isLive(slot)) {
        if (connectionId !== undefined) {
          return Promise.reject(
            new Error(
              `figpea-mcp bridgeServer: no paired tab ${connectionId} — live connections: ${liveIds().join(', ') || 'none'}`,
            ),
          );
        }
        return Promise.reject(new Error('figpea-mcp bridgeServer: no tab is connected'));
      }
      const target = slot;
      const id = String(nextCallId++);
      const frame: CallFrame = { type: 'call', id, group, method, args };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          target.pending.delete(id);
          // REQ-772 AC-3: a relay timeout is NOT proof the tab failed — the
          // tab keeps executing and the effect (e.g. layer.create) may land
          // anyway. The rejection must say so, so callers check state before
          // blindly retrying non-idempotent mutations.
          //
          // REQ-1282 AC-3: "check state before retrying" is advice with no
          // route attached, and both reactions to it are expensive — trust it
          // and abandon a layer that was created, or retry a `create` and
          // silently duplicate it. So the clause now NAMES the call to run.
          // Everything above the `;` is the REQ-772 wording, kept byte-for-
          // byte because tests pin those three substrings literally; the
          // state check is appended, never substituted for them.
          //
          // REQ-1457 AC-4: the serving build is APPENDED at the very end, for
          // the same reason and one more — a caller who re-issues a call
          // against a process that has been running since before the fix needs
          // to know that before it retries, and the stamp is the only thing in
          // the message that says which code answered.
          reject(
            new Error(
              `figpea-mcp bridgeServer: call ${group}.${method} timed out after ${timeoutMs}ms; the editor may still be executing this call — check state before retrying; ${stateCheckHint(group, method, args)}; ${servingBuildStamp()}`,
            ),
          );
        }, timeoutMs);
        target.pending.set(id, { resolve, reject, timer });
        sendFrame(target.socket, frame);
      });
    },
    getFileUrl(filePath: string): string {
      return `http://${BRIDGE_URL_HOST}:${port}/file?path=${encodeURIComponent(filePath)}`;
    },
    registerBlob(filePath: string): string {
      const tok = crypto.randomUUID();
      blobMap.set(tok, filePath);
      // simple expiry after 5 min
      setTimeout(() => blobMap.delete(tok), 5 * 60 * 1000).unref?.();
      return `http://${BRIDGE_URL_HOST}:${port}/blob/${tok}`;
    },
    async close(): Promise<void> {
      rejectAllPending(new Error('figpea-mcp bridgeServer: server closed'));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      // REQ-1020 D5 (AC-5): the session's temp dir goes with the session.
      removeSessionDir(sessionDir);
    },
  };
}
