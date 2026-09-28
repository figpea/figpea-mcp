/**
 * REQ-1301 — the loopback host, as a *decision* rather than a bare literal.
 *
 * `bridgeServer.ts` and `mcpServer.ts` each used to spell the loopback host
 * inline at every site that decides what a bridge URL looks like, and the two
 * spellings in circulation — `127.0.0.1` here, `localhost` everywhere else —
 * are *different hosts* to a browser. A tab served from
 * `http://localhost:<editorPort>` therefore received file/blob/image URLs that
 * crossed a hostname boundary it never needed to cross. The fix is not "swap
 * six literals" but "make the host one fact", so the next host decision cannot
 * half-apply.
 *
 * This module deliberately has **zero imports**. `mcpServer.ts` must not take
 * a runtime dependency on `bridgeServer.ts` — it declares its own structural
 * `BridgeServerHandleLike` precisely so tests can pass a stub without the real
 * server — so the constant lives in a third, neutral module that neither owns.
 */

/**
 * The host the bridge writes into every URL it **emits** to the editor tab.
 *
 * Why `localhost` and not `127.0.0.1`: the editor tab's own origin is
 * `http://localhost:<editorPort>` (that is the convention the whole toolchain
 * uses for the dev server), so emitting `localhost` puts the request back
 * inside the same-address-space exemption. A fetch from a `localhost` page to a
 * `127.0.0.1` URL is *cross-hostname*, which puts it outside the Local
 * Network Access localhost exemption — preflighted and permission-gated, and
 * an automated/headless browser cannot answer a native permission prompt.
 * (The ports still differ, so the request is still cross-origin by the URL
 * spec and CORS still applies; what the hostname match buys is the exemption,
 * on top of the `Access-Control-Allow-Origin: *` the bridge already sends.)
 */
export const BRIDGE_URL_HOST = 'localhost';

/**
 * The host the bridge **binds** to. Unchanged, and deliberately so: the
 * loopback-only bind is a security property and widening it is out of scope.
 *
 * It stays IPv4-only even though {@link BRIDGE_URL_HOST} is `localhost`:
 * `localhost` resolves to `::1` first on the supported platforms (measured on
 * macOS 15 / Node 22), so an emitted `localhost` URL costs one refused `::1`
 * connection before the RFC 6555 connection racing in Node 20+ and every
 * current browser reaches `127.0.0.1`. A real end-to-end fetch in
 * `src/req1301BridgeHost.test.ts` pins that the shipped URL is served
 * end-to-end, so a platform *without* the racing fallback fails the suite
 * loudly instead of failing a user's run. The residual — another process
 * binding `[::1]:<bridgePort>` first — is bounded and accepted, because
 * binding `::1` as well would widen the bind surface.
 */
export const BRIDGE_BIND_HOST = '127.0.0.1';
