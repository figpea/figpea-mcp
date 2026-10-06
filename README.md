# figpea-mcp

A Model Context Protocol (MCP) server that lets an AI agent open and drive a live Figpea editor — to view, inspect, and export PSD, Adobe XD, Figma, SVG, and PDF files — entirely on your machine.

> **Guided Pairing & Local Network Access (LNA).** When an agent invokes a contract tool before a tab is paired, it receives an actionable `no_tab` error carrying the exact pairing URL, plus a `connection` block naming what this bridge observed — so the cause arrives with the failure instead of costing a second call:
> ```text
> {
>   "ok": false,
>   "code": "no_tab",
>   "message": "No editor tab paired. Open this URL in your browser to connect an editor tab:",
>   "url": "https://editor.figpea.com/?agent=1&bridgePort=8080&bridgeToken=abc123token",
>   "connection": {
>     "lastEvent": "hello_rejected",
>     "nextStep": "the pairing token was rejected — re-read token from this status call and open a freshly minted pairing URL; a token from an earlier server run is always stale",
>     "tcpConnections": 1, "upgrades": 1, "helloAccepted": 0, "helloRejected": 1, "supersededCount": 0,
>     "lastCloseCode": 4001, "lastCloseReason": "invalid or missing pairing token",
>     "startedAt": "2026-10-02T16:23:31.390Z"
>   }
> }
> ```
> Read `connection.lastEvent` — see [Diagnosing a connection](#diagnosing-a-connection) for every state and what to do about it.
> Opening that URL starts the connection on its own: the editor dials the bridge as the page loads, and nothing there waits on a click. Chrome may still ask for Local Network Access permission to reach the local network (accepted once per origin). The in-app notice is a status display, not a gate — it names the bridge address and reports the phase (`Connecting…`, `Retrying…`, or failed), so a stuck pairing names its state instead of only failing. The one manual control left is on a `failed` card: a `Try again` button.

![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## Quickstart

Add this to your MCP client's config:

```json
{
  "mcpServers": {
    "figpea": {
      "command": "npx",
      "args": ["-y", "figpea-mcp"]
    }
  }
}
```

(`-y` suppresses the npx install prompt — needed since the client spawns this non-interactively.)

On start, the server prints a pairing URL (plus its port and token) to stderr. Open that URL in a browser to connect an editor tab — or have the agent call `open_editor`, which returns `{port, token, url}` so it can compose its own.

Optional: the `FIGPEA_EDITOR_URL` env var and `--port=<n>` flag override the editor origin and bridge port; neither is needed for the default flow.

## How pairing works

The server binds a bridge on `127.0.0.1:<port>` — loopback only, never a public interface — and the editor tab connects back over that localhost WebSocket carrying the token (`?agent=1&bridgePort=…&bridgeToken=…`). By default the bridge serves **one tab**: a second connection is **refused by name**, with the close reason saying which tab holds the slot, and the tab already paired keeps its socket and keeps serving. Nothing is displaced.

Two different hosts, on purpose. The **bind** is `127.0.0.1` and stays that way: it is a security property, and the listener is IPv4-only. The **host in the URLs the bridge emits** (and in the `bridge listening on …` line it prints) is `localhost`, which is the host your editor tab is itself served from. Matching it puts the tab and the bridge in the same address space, so a `localhost` page talking to a `127.0.0.1` URL — a *cross-hostname* request, and so outside the Local Network Access localhost exemption, preflighted and permission-gated — no longer happens. That matters most for headless and automated browsers, which cannot answer an LNA prompt. The bind is deliberately not widened to `::1` to match: `localhost` resolves to `::1` first, and IPv4 clients still reach it through connection racing.

### Running two tabs at once

Start the bridge with `--bridge-slots=multi` (or `FIGPEA_BRIDGE_SLOTS=multi`) and each tab takes its own **slot** — its own document, its own socket, its own `connectionId`. `status` lists them all, and the `select_tab` tool (registered **only** in this mode) chooses which one subsequent calls address.

These are **several editor tabs, each with its own document**, on one machine, over loopback — not collaborative editing, and nothing shared: a call addressed to one tab never reaches another, and design files still never leave your machine.

## Mid-session pairing — copy the connection string

You started a design without `?agent=1&bridgePort&bridgeToken` (the normal human flow) and now want agent help mid-session without reloading. Copy **one** paste-ready string — no hand-editing — into the editor's **File → Connect to Agent…** dialog (REQ-1036 consumer, tolerant parser `v3/src/agent/bridge/parsePairing.ts`):

- **From stderr** — copy the exact URL line printed at startup:
  ```text
  [figpea-mcp]   https://editor.figpea.com/?agent=1&bridgePort=54321&bridgeToken=550e8400-e29b-41d4-a716-446655440000
  ```
  (the indented line after `open this URL in a browser…`). Also the two-line pair `localhost:<port>` + `pairing token: <uuid>` is accepted when pasted together — that is the form the server now prints. The older `127.0.0.1:<port>` + `pairing token: <uuid>` pair is still accepted, so a log from an already-installed server still pairs.
- **From `open_editor`** — call the tool, copy its returned `url` (same pairing URL; with `file` it appends `&loader=http&url=<file>`).
- **From `status`** — call the tool, copy its `url` or compose `?agent=1&bridgePort=<port>&bridgeToken=<token>` from `port`/`token`.

All three paste families are accepted byte-for-byte by `parsePairingFromPaste`:

1. **Full URL** `…?agent=1&bridgePort=<port>&bridgeToken=<token>` (any origin, extra surrounding text tolerated, also with `&loader=http&url=…`);
2. **JSON** `{"port":<port>,"token":"<uuid>","url":"https://…?bridgePort=…&bridgeToken=…"}` (as `open_editor` returns);
3. **stderr pair** `localhost:<port>` + `pairing token: <uuid>` pasted together with whitespace/newline (the form the server now prints; the older `127.0.0.1:<port>` + `pairing token: <uuid>` pair is still accepted).

Honors `FIGPEA_EDITOR_URL` (default `https://editor.figpea.com`, override for local dev) and `--port=<n>` — the pairing URL embeds whatever origin/port/token the bridge is actually bound to.

## Tool surface

| Tool | Always present | What it does |
|------|-----------------|---------------|
| `open_editor` | yes | Opens/points at an editor tab wired to this bridge. Returns `{port, token, url}`. |
| `status` | yes | Reports the bridge's port, token and pairing URL (`port`, `token`, `url`), whether a tab is connected, the connected tab's contract version, the live tool count, WHICH TAB it is attached to — a `tab` block (`connectionId`, `origin`, `originSource`, `contractVersion`, `pairedAt`) plus `connections[]` listing every paired tab with its own id, origin, contract version and `active` flag, and `activeConnectionId` — a `connection` block naming why a tab is not connected (see [Diagnosing a connection](#diagnosing-a-connection)) — and a separate `liveness` block naming whether the tab is *answering* (`state`, plus the `inFlight`/`oldestInFlightMs`/`consecutiveTimeouts`/`lastAnswerAt`/`lastTimeoutAt` counters behind it and its own `nextStep`), because a socket can be open to a tab that answers nothing (see [Recovering a lost session](#recovering-a-lost-session)), and WHICH BUILD is answering: a `build` block (`version`, `buildId`, `builtAt`, `servedAt`, `root`) plus a top-level `buildStale` flag (see [Which build is this server running?](#which-build-is-this-server-running)). Also `bridgeSlots` (`single` or `multi`) — how this bridge serves tabs. And `document` — the active design's `{id, name}`, or `null` with no tab, with an older tab, or when the tab does not answer — so you can tell WHICH DESIGN you are pointed at, and notice it changed between two calls, without mutating first (see [Durability](#durability--what-is-and-isnt-saved)). Read `tab.origin` and `tab.contractVersion` before a destructive write: they let you assert you are on the document you expect. |
| `select_tab` | multi-slot mode only | Chooses which paired tab subsequent calls address: `select_tab({connectionId})`, with the ids `status` lists. Registered **only** when the bridge runs with `--bridge-slots=multi` / `FIGPEA_BRIDGE_SLOTS=multi`, and **absent from `tools/list` on the default single-slot bridge**, where there is nothing to select — a second tab is refused by name instead. Selecting a tab also re-publishes that tab's own contract manifest, so the tools you were given describe the document your next call reaches. |
| `figpea_skill` | yes | Returns Figpea's agent skill reference (the craft guidance for using `window.figpea` well), sourced from the editor origin's `/agent/skill.md` at startup — works even with no tab paired. The answer names the URL it fetched from: the body is that origin's own build, so when a tab is paired from a different origin or a different build, get *the tab's* skill instead with `figpea.SKILL()` in the tab or `GET <the tab's origin>/agent/skill.md` (the answer says so when a tab is connected). Degrades to a structured `{ok:false, code:"skill_unavailable", message}` (never throws) if the fetch failed or was disabled. |
| `figpea_call` | compact only | Universal dispatcher — `figpea_call({ group, method, args, _timeoutMs, _opsFile })` calls any `group.method` on the paired tab (see below). `_opsFile` names a JSON file whose content is a method's top-level array argument, read by this server instead of that array. |
| `figpea_describe` | compact only | Returns the contract surface for a group or method — the same `doc`/`params`/`result` the editor's own `describe()` returns, from the manifest this server already holds in memory (no tab round trip). `figpea_describe()` → group index, `{group}` → that group's methods, `{group, method}` → one method's wire shape. `params` is the DECLARATION; the response **states** the encoding beside it, per method, in `wire` — including that an array-valued parameter is its positional slot `args[n]` **as the array itself**, never inside an object or a `{key: …}` envelope, with a worked payload rendered from that slot's own declared element shape. For a host that cannot nest structures, a per-method response also carries **`stringJsonParams`** (which params accept a JSON string) and, where the editor's contract declares it, the param's own typed **`stringJson`** declaration with a copyable `example` — so the array-free form is readable **before** the call rather than after a failure. Degrades to `{ok:false, code:"describe_unavailable"}` (never throws) when the manifest was never fetched. |
| `group_method` (e.g. `layer_setPosition`, `canvas_screenshot`, `export_project`) | full mode only | One MCP tool per method in the connected tab's `figpea.describe()` manifest. |

In **compact mode (default)** the server advertises only `open_editor`, `status`, `figpea_skill`, `figpea_call` and `figpea_describe` — 5 tools, ~600 tokens vs ~9,500 tokens, a ~90–95% reduction. In **full mode** (`--mode=full` or `FIGPEA_TOOL_MODE=full`) it advertises `open_editor`, `status`, `figpea_skill` plus every `group_method` contract tool. In **multi-slot mode** (`--bridge-slots=multi`) it advertises one more, `select_tab`, and only then. See [Tool modes & `figpea_call` dispatcher](#tool-modes--figpea_call-dispatcher) below.

Generated tools (full mode) advertise structured parameter types (string / number / boolean / object / array) derived from the connected tab's contract manifest, so type-respecting MCP clients pass objects and arrays through intact.

The contract-tool list reflects whatever the connected editor advertises — it is not hardcoded here, and grows with the editor's contract. `status` and `tools/list` are the source of truth for what's callable right now; there is no version-lock between this bridge and the editor.

Every call returns `{ok: true, value}` or `{ok: false, code, message}`. Image-shaped results (`canvas.screenshot`, raster exports) come back as MCP image content alongside a text summary.

### Diagnosing a connection

`tabConnected` is one bit: an editor tab is connected, or it is not. It cannot tell you *which* of the ways pairing failed got you there, so an agent that read only that field re-opened a tab, waited, failed again, and did so for as long as it cared to try. `status` therefore returns a `connection` block beside it — a token naming the state this bridge observed, the action that token implies, and the counters behind it.

```json
{
  "port": 8080,
  "token": "abc123token",
  "url": "https://editor.figpea.com/?agent=1&bridgePort=8080&bridgeToken=abc123token",
  "tabConnected": false,
  "contractVersion": null,
  "toolCount": 0,
  "bridgeSlots": "single",
  "activeConnectionId": null,
  "tab": null,
  "connections": [],
  "liveness": {
    "connectionId": null,
    "state": "unpaired",
    "inFlight": 0,
    "oldestInFlightMs": null,
    "consecutiveTimeouts": 0,
    "lastAnswerAt": null,
    "lastTimeoutAt": null,
    "nextStep": "no tab is paired to this bridge — open the pairing URL this status call prints in a browser to pair one; there is no tab to answer a call until then"
  },
  "connection": {
    "lastEvent": "hello_rejected",
    "nextStep": "the pairing token was rejected — re-read token from this status call and open a freshly minted pairing URL; a token from an earlier server run is always stale",
    "tcpConnections": 1,
    "upgrades": 1,
    "helloAccepted": 0,
    "helloRejected": 1,
    "supersededCount": 0,
    "lastCloseCode": 4001,
    "lastCloseReason": "invalid or missing pairing token",
    "startedAt": "2026-10-02T16:23:31.390Z"
  },
  "build": {
    "version": "2.6.0",
    "buildId": "sha256:1a2b3c4d5e6f",
    "builtAt": "2026-10-03T22:04:11.882Z",
    "servedAt": "2026-10-03T01:56:02.113Z",
    "root": "/Users/you/figpea-mcp/dist"
  },
  "buildStale": true
}
```

The `liveness` block in that example asks a **different question** from `connection`, and the difference is the whole point: every one of those eight tokens describes the WebSocket transport, and a live socket to a wedged tab reads `hello_accepted` — correctly, and uselessly. `liveness` asks whether the tab is *answering*. Its vocabulary, what each value does and does not prove, and the procedure for finishing a run whose MCP channel is gone are in [Recovering a lost session](#recovering-a-lost-session).

Read `connection.lastEvent`. `connection.nextStep` is the action that token implies, shipped in the same payload, so nothing has to be mapped by hand:

| `lastEvent` | What it means | What to do next |
|--------------|---------------|-----------------|
| `no_attempt` | Nothing has ever reached this bridge — no socket, no handshake, no tab. | nothing has reached this bridge yet — open the pairing URL from this status call in a browser to start an editor tab |
| `transport_only` | A socket reached this port but no WebSocket handshake ever completed. The common cause is a `bridgePort` that is not this bridge's. | a socket reached this port but no WebSocket handshake ever completed — check you are on the exact bridgePort printed above, then reload the editor tab |
| `hello_timeout` | The handshake completed but no `hello` frame arrived within 5 seconds. | the WebSocket handshake completed but no hello frame arrived within 5s — reload the editor tab, and check nothing (a proxy, an extension) is holding the connection open |
| `hello_rejected` | The pairing token did not match. A token minted by an earlier server run is the usual reason, and this bridge restarts whenever the MCP server restarts. | the pairing token was rejected — re-read token from this status call and open a freshly minted pairing URL; a token from an earlier server run is always stale |
| `hello_accepted` | A tab completed the handshake. Paired. | a tab is paired — proceed; read tabConnected for live truth |
| `slot_refused` | A second tab asked for this bridge's single slot while another held it. The tab already paired is untouched and still serving — nothing was displaced. | another tab already holds this bridge's single slot and is still serving — to pair this one too, close that tab, or restart the bridge with --bridge-slots=multi (or FIGPEA_BRIDGE_SLOTS=multi) |
| `tab_superseded` | A newer tab completed the handshake and took the connection over. Still paired — this is a healthy state, not a fault. Only reachable when an **older** `figpea-mcp` build is the bridge; a current build refuses instead. | a newer tab took over the connection — paired, proceed; if you expected the older tab, close the newer one |
| `disconnected` | The paired tab went away after pairing. | the paired tab has gone away — open a fresh pairing URL from this status call to pair again |

That table is authoritative **in both directions**, the same way the per-method timeout table above is: `connection.nextStep` is read from the same map this table is written from, and the package's own test fails if the two ever disagree.

The counters (`tcpConnections`, `upgrades`, `helloAccepted`, `helloRejected`, `supersededCount`) are **per-process**: they cover this MCP server process only, they begin at zero every time it starts, and they are not a historical record — they say nothing about any previous run and are never persisted. `connection.startedAt` is the ISO-8601 instant this run started, and it is how you tell this run's numbers from an earlier one's. `supersededCount` counts **connections that asked for the serving slot and did not get it** — refused by a current build (`slot_refused`), or displaced by an older one (`tab_superseded`). Pairing a second tab in multi-slot mode is not a supersession and does not touch it.

### Which tab am I talking to

`tabConnected` is one bit, so it cannot say *which* tab answered — and with two tabs paired, "which tab" and "which document" stop being the same question. `status` therefore names the tab it is attached to in a `tab` block and lists every paired tab in `connections[]`:

```json
{
  "activeConnectionId": "c1",
  "tab": {
    "connectionId": "c1",
    "origin": "https://editor.figpea.com",
    "originSource": "handshake",
    "contractVersion": "2.59.1",
    "pairedAt": "2026-10-04T11:02:33.114Z"
  },
  "connections": [
    { "connectionId": "c1", "origin": "https://editor.figpea.com", "originSource": "handshake", "contractVersion": "2.59.1", "pairedAt": "2026-10-04T11:02:33.114Z", "active": true },
    { "connectionId": "c2", "origin": "http://localhost:8080", "originSource": "handshake", "contractVersion": "2.50.0", "pairedAt": "2026-10-04T11:05:12.008Z", "active": false }
  ]
}
```

`tab` is the tab a call is answered for; `activeConnectionId` names it in `connections[]`. Each tab has its own contract version, so two tabs can legitimately differ — which is why `select_tab` re-publishes the *selected* tab's manifest when it moves the pointer, so the tools you hold describe the document your next call reaches. **Assert `tab.origin` and `tab.contractVersion` before a destructive write** rather than assuming which document you are in.

`origin` is the `Origin` header of that tab's WebSocket handshake and **nothing else**. It is never reconstructed from the pairing URL or from `Host`, because a fabricated origin is worse than a missing one when the point is that you can assert it. `originSource` is therefore always present and says which of the two states you have: `handshake` when the browser sent the header, `absent` when it did not. So one payload distinguishes a known origin (`"origin": "https://editor.figpea.com"`), an origin the browser declined to send (`"origin": null, "originSource": "absent"`), and a build too old to publish the field at all (the key is simply absent).

**A wrong port is the one case no token can name, and this is why.** The card's fifth state — a pairing URL pointing at an address nothing is listening on — is defined relative to an address that is *not* the bridge answering your question, so from inside, "no tab was ever opened" and "you used the wrong port" are the same silence. What separates them is the identity published beside the diagnosis: compare the `bridgePort` and `bridgeToken` in the URL you are holding against the `port` and `token` this call returned. If they do not match, you are talking to a run that no longer exists — open a URL minted by a live `status` call.

A `no_tab` refusal carries the same `connection` block on the failing call itself — on `figpea_call` in compact mode and on every contract tool in full mode — so the cause arrives with the failure instead of costing a second round trip.

None of this prevents a connection failure or fixes one. It makes whatever happened legible to whoever is trying to pair: the bridge reports what *this process* observed, never why the failure occurred.

### Which build is this server running?

Every other field on `status` describes what this process can *see* — the tab, the contract, the tool list. None of them describes the code doing the answering. `status` therefore also returns a `build` block and a top-level `buildStale` flag.

The flag exists for one reason. Your MCP client owns this stdio process and does **not** restart it when a newer build lands on disk, so a fix can merge to `figpea-mcp` while the process answering you has been running since before it. Nothing about that shows up in a `port` or a `toolCount`; a call the current build handles correctly simply fails, and it reads as a bug in the design file rather than as a server that predates the fix.

| Field | What it is |
|---|---|
| `build.version` | The `figpea-mcp` version this process is running. |
| `build.buildId` | A content hash of the `figpea-mcp/dist` build on the machine running this server, as `sha256:<12 hex>`. Match it against your own checkout's build to answer "am I talking to the code I am reading?" — identical bytes give an identical id, which is exactly why it is a content hash and not a timestamp. |
| `build.builtAt` | When that `dist` build was written (the newest file mtime in it). |
| `build.servedAt` | When **this process** loaded it. Compare the two: `builtAt` later than `servedAt` means the code answering you is older than what is on disk. |
| `build.root` | The `dist` directory that was compared, so you can tell which checkout you are looking at. |
| `buildStale` | `true` when the `dist` build on disk is **not** the one this process loaded. |

**Read `buildStale` before spending time on a failure that looks like a product bug.** It is computed against `figpea-mcp/dist` **on the machine running this MCP server** — nothing else. It says nothing about the connected editor tab, which is a different process on a different origin, and `false` does not mean your build is current in any general sense: it means nothing newer is sitting in that directory.

**One honest false positive: a rebuild with no code change reports `buildStale: true` with the SAME `buildId`.** The flag is a file-fingerprint comparison (size, mtime and inode), because the alternative — content only — cannot see a `touch` at all. So `npm run build` after no source edit rewrites the timestamps and the flag moves even though the code is provably identical. That is the whole point of `buildId`: `stale: true` with a `buildId` you recognise means the directory was rewritten, and `stale: true` with a `buildId` you do **not** recognise means newer code is waiting.

**The remedy is restarting the MCP server.** This package does not respawn or hot-reload its own process, and cannot — the host owns it. `buildStale: true` is a diagnosis, not a fix. The same identity is stamped onto every `bridge_error` timeout message, so a timeout can be matched against your checkout without a second call.

### Off-band binary returns (`returnAs: "path"`)

A full-page screenshot runs 500 KB – 2 MB raw → ~500K – 2M tokens when inlined as base64. For large captures — and for large exports generally — pass the reserved `returnAs: "path"` key on any tool (full mode) or on `figpea_call` (compact mode): the bytes are written to a per-session file under `<tmpdir>/figpea-mcp/<session>/` and the result is a single `text` block `{ok: true, path, mime, width, height, bytes, filename, url}` — no `image` block crosses the wire.

It reaches **every** binary result, not just images: any payload shaped `{bytes, mime, filename}` qualifies. For images that is `canvas_screenshot`, `export_layer`, `export_artboard`; for the native project file it is `export_project` with `{input: {format: "figpea"}}` — a 66 KB `.fp` is ~88 KB of base64, and an agent's context is the wrong place for a deliverable. The written file is named from the payload's own filename, so that export lands as `export_project-<stamp>-<uuid>-My_Design.fp` — never `.bin`; the `filename` key appears in the result only when the payload carried one (`canvas.screenshot` does not, so its result is unchanged).

Open the file with your host's own file-reading tool (the `url` is the bridge's token-gated `/blob/<token>` alias; the `path` is also fetchable via the existing `GET /file?path=` loopback endpoint). Omit `returnAs` (or pass `"inline"`) for today's behavior, byte-identical. Any other value fails loud with `invalid_params`; a write failure returns `{ok: false, code: "return_path_write_failed"}` with `isError: true` and never partial bytes. The session's temp dir is removed when the bridge session ends (`close()`). Rule of thumb: for >1 MB screenshots, pass `returnAs: "path"` and read the file with your host's file tool; saves ~1.3 tokens/raw byte.

**The mirror image of `returnAs` is `opsFile`, and it is a different thing.** `returnAs: "path"` moves a **result** out of the reply; `opsFile` moves a **payload** into the call — a method's top-level array argument is read from a JSON file you name, so a long batch never has to be pasted into the tool call. Both are loopback-local reads and writes on the machine running this server, neither sends anything anywhere. See [Batch payloads from a file](#batch-payloads-from-a-file-opsfile) below.

**There is no other way to put a result on disk, and an invented parameter is an error, not a no-op.** A parameter this server does not recognise is never dropped: it comes back as `{ok: false, code: "invalid_params", message: "<tool>: unknown parameter \"…\". Accepted parameters: …"}` naming the offending key, before the call reaches the editor and without spending a tab round trip. Passing `filePath` to `canvas_screenshot` used to be silently ignored — the call still answered `ok: true`, nothing was written anywhere, and an agent could report a capture as saved evidence that did not exist. So: to get a capture or an export onto disk, pass `returnAs: "path"` and read the returned path with your host's own file tool; never pass a file path as a parameter. The same rule holds through `figpea_call` in compact mode, where an extra positional argument past the method's declared arity is rejected by the same code.

**A prop the requested kind does not accept is refused before the tab is reached too.** `layer_create` with `{kind: "text", props: {…, x: 120, y: 250}}` is answered `{ok: false, code: "invalid_transform"}` naming `x, y` and listing what `"text"` does accept — `create("text", {…, x, y})` positions nothing, and the editor would have said exactly this one round trip later. The applicable set is not a list baked into this package: it is read per call from the same manifest `figpea_describe` returns, as `params.props.shape` merged with `params.props.byKind[kind]`, so a kind that later gains a field is accepted with no upgrade here. The code is the editor's own, relayed rather than renamed, so an agent that hits this path and the tab path reads one rule. Nothing is forwarded and no tab round trip is spent. Geometry, in short, goes top-level and every visual property goes inside `style{}` — see `layer_create`'s own doc, which states the same rule with the worked examples.

## Tool modes & `figpea_call` dispatcher

By default `figpea-mcp` runs in **compact mode** — only 5 tools (`open_editor`, `status`, `figpea_skill`, `figpea_call`, `figpea_describe`) are advertised to the MCP client. This trims the baseline context from ~9,500 tokens (35+ granular tools) to ~600 tokens, a ~90–95% reduction, while keeping full capability through the dispatcher. Agents that rarely touch design files pay almost nothing until they actually need to.

### `figpea_call` calling conventions

`figpea_call` is the universal dispatcher for compact mode. It forwards to `bridge.callTab(group, method, args, _timeoutMs?)` and returns the result via the same `resultToContent` mapping (including image + text blocks).

```json
// Create a rect (AC-2)
{ "group": "layer", "method": "create", "args": ["rect", { "rwidth": 100, "rheight": 50 }] }

// Screenshot (AC-3) — returns MCP image content + text summary
{ "group": "canvas", "method": "screenshot", "args": [] }

// NESTED — layer.batch's `ops` is itself an array, so it is passed as ONE
// element of `args`, and each op's own `args` is an array too (never an object)
{ "group": "layer", "method": "batch", "args": [[{ "method": "create", "args": ["page", { "name": "probe", "pageWidth": 100, "pageHeight": 100 }] }]] }
```

**Nesting rule.** `args` is the positional array in the method's own parameter order. When a parameter is itself an array — `layer.batch`'s `ops` is the one that bites — that parameter goes in as **one element of `args`**, and the element is an array of `{method, args}` ops. Each op's `args` is a positional array as well. So `ops` is `[[{…}]]`, never `{ops: […]}` and never `{"item": […]}` (the latter is what some host harnesses produce when they collapse a nested array; `figpea_call` answers that with an `invalid_params` naming the path and the expected shape, without spending a tab round trip). When in doubt, call `figpea_describe({ group: "layer", method: "batch" })` first — it returns the authoritative shape from the manifest, and its `wire` block **states** this rule for you: each parameter's positional index, and for an array-valued one a worked payload to copy. If the payload is long enough that pasting it into the call is the problem rather than the nesting, `opsFile` takes it as a file instead — see [Batch payloads from a file](#batch-payloads-from-a-file-opsfile) below.

**Object-valued parameters — the object IS the positional slot.** When a parameter is a plain object, that object occupies `args[n]` *on its own*; you never wrap it in a second envelope keyed by the parameter's own name. This is the shape that bites hardest, precisely because several parameters are **named** `input` or `patch` — so writing that name into your payload is the mistake, not the fix. `figpea_describe({ group, method })` is the authority on which is which: it returns each parameter's name, type and shape in that method's own positional order, so a parameter's *name* tells you nothing about how to nest it. One consequence worth stating outright, because it is what turns a wrong call into a filesystem hunt: retrying a wrong shape here fails **identically** every time, because the argument — not the message — is what is wrong, so a clearer error on the next try cannot help. Change the shape.

The one wrapper that IS legal is a **single** object as the whole of `args`, keyed by the method's own parameter names — the editor expands it to positional order. That expansion needs the call to carry exactly one argument, so the moment a positional argument goes in front of it — `stylePatch`'s layer id, `setPosition`'s layer id — it stops expanding, and the wrapper arrives as the object itself. Your keys were fine; the envelope was the mistake.

```json
// session.openFile(input) — `input` IS args[0]. figpea-mcp maps a `filePath`
// here to http://localhost:<port>/file?path=… so the editor can fetch it.
{ "group": "session", "method": "openFile", "args": [{ "filePath": "/abs/path/design.fp" }] }
// WRONG — a BARE PATH where the object belongs. This is the call that reported success
// while opening nothing: every pre-flight here declines a string at an object slot, so the
// path was forwarded verbatim and whatever came back was the tab's answer, relayed.
// Now it is refused BEFORE the round trip with an invalid_params naming args[0] and the key
// it wanted — {"filePath": "<absolute path>"}, the first line above. A path to a file that is
// not there instead answers open_failed: file not found or not readable: <path>, the same as
// the object form: a missing file is missing whatever shape it arrived in.
{ "group": "session", "method": "openFile", "args": ["/abs/path/design.fp"] }
// WRONG — the file-path translation reads args[0].filePath, and this envelope puts
// it one level too deep, so the call is REFUSED BEFORE ANY FETCH with an
// invalid_params naming args[0] as where filePath belongs — no tab round trip spent.
// Inverted, if you see open_fetch_failed: HTTP 404 Not Found for
// "/abs/path/design.fp" then you did NOT send this envelope: the shape above was
// used, the path really was forwarded, and the file exists, so look at the path,
// the file, or the bridge — not at your argument shape.
// Either way retrying fails identically, so the argument is what has to change.
{ "group": "session", "method": "openFile", "args": [{ "input": { "filePath": "/abs/path/design.fp" } }] }

// layer.stylePatch(id, patch) — the style keys go in FLAT, with no `style` wrapper
{ "group": "layer", "method": "stylePatch", "args": ["L_kicker", { "fontFamily": "Inter", "fontSize": 26, "fill": "#1A1A1A" }] }
// WRONG — and here the wrapper IS the mistake: the id in front of it means the call no
// longer carries exactly one argument, so nothing expands it, the wrapper object is
// received AS the patch, and `patch` fails the style whitelist.
// unsupported_style_key: patch — read that as "you sent the descriptor's named
// declaration instead of its contents". `patch` is not a style key.
{ "group": "layer", "method": "stylePatch", "args": ["L_kicker", { "patch": { "fontFamily": "Inter", "fontSize": 26, "fill": "#1A1A1A" } }] }
// …while the SAME wrapper is CORRECT on its own, as the whole of args:
{ "group": "layer", "method": "stylePatch", "args": [{ "id": "L_kicker", "patch": { "fontFamily": "Inter", "fontSize": 26, "fill": "#1A1A1A" } }] }
// create() nests them and stylePatch does NOT — that asymmetry is real:
// { "style": { … } } is answered unsupported_style_key: "style" — "style" is a
// create() top-level prop, not a style key — and the message now also names the
// flat form to send instead: stylePatch(id, {fontSize: 26}).
{ "group": "layer", "method": "create", "args": ["text", { "text": "Counterform", "style": { "fontSize": 26 } }] }

// layer.setPageFill(pageId, patch) — a scalar, then an object, positionally
{ "group": "layer", "method": "setPageFill", "args": ["P_1", { "fill": "#EFEBE3", "fillType": "solid" }] }
// WRONG — the wrapper below is NOT the mistake: a single object keyed by a method's own
// parameter names is a legal `args`, and it expands to positional order — and only while it
// is the whole of `args`. The mistake is
// `patch` itself — a stringified object NESTED INSIDE a real object is never parsed, so it
// stays a string: invalid_params: setPageFill(): patch must be object (got string)
// …and the message now adds both ways out: send it positionally as
// setPageFill(pageId, {…}), and know why stringifying did not save it — the JSON-string
// route visits whole positional slots and never descends into an object.
{ "group": "layer", "method": "setPageFill", "args": [{ "pageId": "P_1", "patch": "{\"fill\":\"#EFEBE3\"}" }] }
```

Two conventions meet here, and mixing them is the trap. In **full mode** a generated tool takes its parameters **by name**, so the same `input` object really is `session_openFile({ "input": { … } })` and `export_project({ "input": { "format": "figpea" } })`. **`figpea_call` positions them**, so the very same object is `{ … }` and not `{ "input": { … } }`. Both spellings are correct; each mode's spelling, used in the other, is the bug. `figpea_describe({ group, method })` settles it without a round trip: it returns each parameter's name, type and shape **in the method's own positional order**, so the first entry is `args[0]`, the second is `args[1]`, and the name a parameter happens to have tells you nothing about how to nest it. `params` is the **declaration**, not the **encoding**: a param whose type is `object` occupies its slot with its contents flat, so `stylePatch`'s `args[1]` is the patch itself, never `{patch: …}`. A per-method response also carries `wire` — this method's parameters as the positional slots they occupy, derived from the same manifest `params` is read from, so it is right for any method.

**If your harness cannot send a nested object or array.** Some host harnesses serialise nested arrays into `{"item": …}` envelopes, and one that does that may not survive being told to send a real nested array. The one thing such a host cannot damage is a **scalar** — so any parameter the method declares as an `object`, `array` or `matrix` may be sent as a **JSON string** instead, and this server parses it before the round trip. **No flag is required**, and a string position is never touched, so `setName(id, "[Hero]")` is still the name `[Hero]`. **The string must be the whole positional slot**: the parse visits `args[0]`, `args[1]`, … as complete positions and never descends into an object you also sent, so the `setPageFill` call above is *not* rescued by stringifying its `patch`. No flag, key or spelling makes a nested string parse:

```json
// the batch above, as one string — note the escaped quotes
{ "group": "layer", "method": "batch", "args": ["[{\"method\":\"create\",\"args\":[\"page\",{\"name\":\"probe\",\"pageWidth\":100,\"pageHeight\":100}]}]"] }
{ "group": "layer", "method": "setTransform", "args": ["L_rect", "[1,0,0,1,0,0]"] }
{ "group": "layer", "method": "create", "args": ["line", "{\"x\":0,\"y\":0,\"style\":{\"dashArray\":[4,4]}}"] }
// an object-valued parameter stringified into its OWN slot — the only place the route applies.
// `input` is still args[0] here; the string is the object, not an envelope around it.
{ "group": "session", "method": "openFile", "args": ["{\"filePath\":\"/abs/path/design.fp\"}"] }
```

A string that does not parse, or that parses to the wrong kind for its declared type, is **refused before the round trip** with an `invalid_params` naming the position and both ways out — never silently forwarded. `figpea_describe({ group, method })` lists this method's own string-capable params under `stringJsonParams`, derived from the manifest, so you do not have to guess.

**The form is NAMED, not merely tolerated.** `stringJsonParams` tells you *which* parameters accept a string; the contract now tells you *what to send*, before you have to fail. Where the editor's manifest declares it, `figpea_describe` carries a typed `stringJson` declaration on the parameter itself, with a copyable example:

```jsonc
// figpea_describe({ group: "layer", method: "setTransform" }) — params.matrix, as published:
{
  "type": "matrix",
  "required": true,
  "doc": "…may also be sent as a JSON string…",
  "stringJson": { "type": "string", "example": "[1,0,0,1,48,110]" }
}
```

`type` stays `matrix` — that is the runtime type, and it is not replaced. `stringJson` is an **alternative** declaration beside it: it exists so an agent can read a six-number tuple it has no way to nest and see the one form it *can* send. Read it from `figpea_describe`, which returns the manifest's own declaration verbatim and costs no round trip to the editor.

**Two limits worth knowing before you rely on it.** A `matrix` sent this way is parsed at its own positional slot, so `figpea_call('layer', 'setTransform', ['L_rect', '[1,0,0,1,48,110]'])` works; but inside a `batch`, the string is parsed **once, at the `ops` position**, and the parse never descends into an op's own `args`. So write the matrix as a real array *inside* the `ops` literal rather than as a nested string — a string there reaches the editor as a string and the editor rejects it, rolling the whole batch back:

```jsonc
// CORRECT — the inner matrix is a real array inside the ops literal
{ "group": "layer", "method": "batch",
  "args": ["[{\"method\":\"create\",\"args\":[\"rect\",{\"rwidth\":100,\"rheight\":50}]}, {\"method\":\"setTransform\",\"args\":[\"L_rect\",[1,0,0,1,48,110]]}]"] }
```

**The refusal is unchanged, and deliberate.** A `{"item": …}` envelope is still refused by name rather than silently unwrapped, because the collapse is lossy and a legitimate single-key argument object that happens to be named `item` would be silently reinterpreted. What changed is that the refusal now names this route as the way out.

⚠️ **Full mode is a different story, on purpose.** The route *works* on both lanes — the same schema-scoped parse runs either way, and both lanes deliver identical arguments for the same payload. What full mode does **not** do is *advertise* it: a full-mode `tools/list` describes `matrix` as the plain array it is and says nothing about a string alternative. That advertisement is a separate piece of work, so do not read this section as a promise about the tool descriptions you were handed in full mode — read `figpea_describe` instead, which is where the declaration lives.

#### Batch payloads from a file (`opsFile`)

The string route above is the answer when your harness **cannot send** a nested value. This one is the answer when the nested value is **too long to send at all** — a 52-layer plate is ~87,000 characters of ops, and every one of them has to exist twice (once to write the file, once as the tool-call argument) because the tool-call argument is the only channel in. So name a JSON file instead: this server reads it and substitutes its array for the payload before the round trip.

Two spellings, one per lane, because that is how everything else in this document works:

| Lane | Tool | Key | How it is declared |
|------|------|-----|--------------------|
| full mode | the generated `layer_batch` | `opsFile` | a per-tool key beside `ops`, advertised in `tools/list` for any tool whose method declares a top-level array parameter |
| compact mode (default) | `figpea_call` | `_opsFile` | a reserved dispatcher key beside `_rawJson` and `_timeoutMs` |

Either one, **not** the array itself — sending both is refused as ambiguous rather than silently resolved one way:

```json
// full mode
{ "opsFile": "/abs/path/plate-ops.json" }
// compact mode — the array is simply left out of `args`
{ "group": "layer", "method": "batch", "args": [], "_opsFile": "/abs/path/plate-ops.json" }
// …whose file content is the ops array itself, with no wrapper of any kind
[{"method":"create","args":["rect",{"name":"probe","parentId":"P_1","rwidth":100,"rheight":60}]}]
```

Any path works — no extension, directory or naming convention is required, and it is read as given. The substitution happens here, before the round trip, so the editor measures the array **exactly** as it would have measured one you pasted in.

**The editor's per-call argument budget is unchanged.** `opsFile` moves where the characters come from, not how many there may be: the editor measures the substituted array against the same limit and refuses an over-budget one whole, exactly as before. Read the live number at `figpea_describe({ selector: "limits" })`, aim for roughly two-thirds of it, and split the op list across several files if one does not fit — each chunk is its own undo step. There is no new ceiling and no bypass.

Every failure is `invalid_params` and costs no round trip, and the message names the file rather than the payload:

| What you sent | What you get back |
|---------------|--------------------|
| a path to nothing (or to a directory) | `file not found or not readable: <path>` |
| content that is not parseable JSON | `opsFile: cannot parse <path> — <the JSON error's own message>` |
| content that parses but is not an array | `opsFile: <path> must contain a JSON array … got an object / a string / a number / null` |
| `[]` | `opsFile: <path> contains an empty array; "ops" must be a non-empty array` |
| a file over 2 MiB | `opsFile: <path> is <n> bytes, which exceeds the 2097152-byte read limit` (refused before the bytes are read) |
| a non-string or empty value | `opsFile must be a string` / `opsFile cannot be empty` |
| the array AND the path | `opsFile and "ops" were both sent, so this server cannot tell which payload you meant` |

The 2 MiB figure is a **read** guard — it bounds what is loaded into memory before anything else happens — and it is nowhere near the editor's own limit, so nothing that could have succeeded is refused by it.

**No editor behaviour changed.** `describe()`, the contract version and the error codes are as they were; what changed is that this relay can now read one file you name on the machine it already runs on, the same trust boundary its existing local-file translations and `returnAs: "path"` operate inside. Nothing is uploaded and nothing leaves your machine.

- `group` (string, required) — contract group name (`layer`, `canvas`, `session`, `export`, `history`).
- `method` (string, required) — method within the group (`create`, `screenshot`, `openFile`, …).
- `args` (array, optional, defaults to `[]`) — positional arguments for that method, in the order `describe()` lists them. Leave the array-valued slot out when you send `_opsFile`.
- `_timeoutMs` (number, optional) — per-call timeout override, clamped to 120000 ms (same `MAX_CALL_TIMEOUT_MS` and `DEFAULT_TIMEOUT_TABLE_MS` as granular tools).
- `_opsFile` (string, optional) — absolute path to a JSON file whose content is this method's top-level array argument (compact mode only; full mode's generated tool takes the same key unprefixed as `opsFile`). Send it **or** the array, never both.
- `returnAs` (string, optional) — `"inline"` (default) or `"path"`; `"path"` writes a binary result to a session file and returns `{ok, path, mime, width, height, bytes, filename, url}` as text (see "Off-band binary returns" above). Reaches every binary export, images and non-images alike. Typos fail with `invalid_params`.

Image-returning methods (`canvas.screenshot`, raster `export.*`) return both an MCP `image` content block and a `text` summary block.

#### Per-call argument budget

Every call carries **one** budget: the **total serialized size of `args`** is capped, and over the cap the call is refused with `arg_size_exceeded` and **nothing is applied** — there is no partial result to recover from.

This is a limit on **every** call, whatever the payload. It is not an image-only footnote: `layer.batch` is the method where large `args` are normal, and a dense page of shape and text ops reaches the cap at well under 90 ops.

| | |
|---|---|
| Read the live value | `figpea_describe({ selector: "limits" })` → `{ "argsChars": 22000 }`, or `limits.argsChars` on the bare `figpea.describe()` index |
| Unit | **characters** — UTF-16 code units of `JSON.stringify(args)`, not bytes |
| Aim for | roughly **two-thirds** of the limit per call |
| Over the cap | `arg_size_exceeded`; nothing applied |
| Remedy | split the op list across calls of that size, passing ids from earlier results literally |

Two things worth knowing before you size a call:

- **Non-ASCII payloads reach the cap earlier.** The limit counts characters, but the transport caps *bytes*. A payload carrying emoji or other multi-unit characters can measure under `argsChars` while its wire size is several times that, so budget lower for those.
- **Image bytes are the fastest way to hit it.** An inline `data:image/png;base64,…` URI for a 200×200 PNG is already 20–40 KB. For anything larger, stage the bytes on a local CORS origin (`http://127.0.0.1:<port>` with `Access-Control-Allow-Origin: *`) and pass that `http://…` URL — this server fetches it and embeds the bytes, so the tool call itself stays small. This server relays the editor's refusal verbatim, so the remedy it names depends on whether your payload actually carried image bytes.
- **A payload read from a file is measured the same.** `opsFile` / `_opsFile` (see [Batch payloads from a file](#batch-payloads-from-a-file-opsfile)) changes where the characters come from, not how many there may be. The limit is enforced in the editor, against the array it receives, and it applies unchanged to a payload read from a file: over the cap, that call is refused whole with `arg_size_exceeded` and nothing is applied, exactly as for a pasted-in array. There is no new ceiling, no bypass, and nothing that used to be refused is now accepted — split across several files or several calls as before.

Do not hardcode today's number: the editor owns the threshold and publishes it, and a threshold move is then a read rather than a guess. Each chunk is its own undo step, so splitting a batch trades one atomic undo for a correctly sized call.

### Configuration

| Flag / Env var | Values | Default | Precedence |
|----------------|--------|---------|------------|
| `--mode=compact\|full` | `compact` or `full` | `compact` | CLI wins over env |
| `FIGPEA_TOOL_MODE=compact\|full` | `compact` or `full` (case-insensitive) | `compact` | fallback if no CLI flag |
| `--bridge-slots=single\|multi` | `single` or `multi` | `single` | CLI wins over env |
| `FIGPEA_BRIDGE_SLOTS=single\|multi` | `single` or `multi` (case-insensitive) | `single` | fallback if no CLI flag |

Invalid values are ignored (not rejected) with a `stderr` hint — a typo never crashes the stdio channel.

`--bridge-slots` decides how many tabs one bridge serves. `single` is the default and the safe one: a second tab is refused by name and the tab already paired keeps serving. `multi` gives each tab its own slot and its own document, adds the `select_tab` tool, and caps out at 8 paired tabs.

### When to use full mode

Use **full mode** when your agent harness hardcodes individual tool names (e.g. calls `layer_create` directly) and cannot be updated to use `figpea_call`. Restart the server with `--mode=full` or `FIGPEA_TOOL_MODE=full` to restore the full `group_method` surface (`open_editor`, `status`, `figpea_skill` plus all contract tools). Otherwise stay in compact for the token win. Switching modes requires a restart — it is not a live toggle.

## Call timeouts

Every relayed call has a bridge timeout. Two knobs control it:

- **Per-call override** — every generated contract tool accepts an optional top-level `_timeoutMs` input key that sets that single call's timeout, e.g. `{ "url": "…", "_timeoutMs": 120000 }`. It is a reserved key: it is never forwarded to the editor-side method (it is not part of any method's arguments) and only affects the relay's own deadline. The documented maximum is **120000 ms (120 seconds)**; values above it are clamped to the cap rather than rejected. Smaller values are honoured too, so a caller that wants a fast failure can still ask for one.
- **Per-method defaults for known-slow methods** — a method that legitimately runs long gets its own default, and a method that must not hold a call open gets a shorter one:

  | Tool | Default timeout |
  |------|-----------------|
  | `session_openFile` | 120000 ms |
  | `session_waitForIdle` | 30000 ms |
  | `export_project` | 120000 ms |
  | `export_specBundle` | 60000 ms |
  | `export_assetHarvest` | 120000 ms |
  | `export_figmaKit` | 60000 ms |

  That table is authoritative per method **in both directions**: `session_waitForIdle` deliberately stays at 30000 ms, *below* the flat default, so waiting on the editor can never hold a call open for a minute.

  Everything else gets a flat 60-second default.

The flat default is 60 s rather than 10 s because the editor's render-settle window after a burst of mutations on a large project is longer than 10 s. A 10 s deadline reported `layer_create` calls that had already been applied as failures, and the obvious retry silently duplicated the layer. It is deliberately *below* the 120000 ms cap: your MCP host has its own request timeout that `_timeoutMs` cannot raise, so a floor at the cap would let the host's ceiling fire first and hand you a transport error with no envelope at all.

**During a burst of mutations, pass `_timeoutMs` deliberately** — 90000 is a legal value — rather than rediscovering the limit by timing out. The same advice is in the tools' own descriptions, so an agent that only ever reads `tools/list` sees it too.

When a call does time out, the error says so honestly — `timed out after Nms; the editor may still be executing this call — check state before retrying` — and then **names the call to run**: `session.find({name})` for a create (the check that stops a retry from duplicating the layer), `session.layerById(<id>)` for a patch whose id you already have, `session.layerTree()` when there is no name or id to check by, and a plain "re-issue is safe" for a read. **Do not blindly retry a failed mutation**: the tab keeps working after the relay gives up, so the effect may have landed anyway.

### Which failure was it? Branch on `code`

The message above is advice, and advice is what an automated retry policy cannot read. The `code` field says which of these you have, and it is the field every consumer should branch on:

| `code` | What happened | What to do |
|--------|---------------|------------|
| `bridge_timeout_maybe_applied` | This relay's own deadline fired. The tab keeps working, so the change **may have landed** and this bridge will never know for certain | Run the state check the message names. Do **not** re-issue a non-idempotent call — see the refusal below |
| `bridge_previous_call_unresolved` | An identical re-issue of a call already in doubt was **refused**; nothing was sent to the tab, so nothing was applied twice | The state check the message names. The refusal says whether the earlier call is recorded as applied or still unknown |
| `bridge_error` | The call was never delivered: no tab paired, the socket went away, the frame was malformed | Re-pair or reconnect. Nothing was in doubt about this one — it never ran |
| the tab's own codes (`no_tab`, `invalid_params`, …) | The tab **answered**, and refused. A successful relay of a failed call, delivered with the tab's code | Act on the tab's message; nothing was half-applied |

`bridge_timeout_maybe_applied` is a different fact from `bridge_error`, not a softer version of the same one. It does not mean the change failed; it means the bridge stopped waiting.

**A late answer is no longer thrown away.** A result frame that arrives within a grace window of 120000 ms after the deadline is matched to the call it belongs to, and its outcome recorded — which is how a later identical re-issue can be told that the earlier one was already applied. The bridge still cannot tell you what happened; it can only stop discarding the evidence, and it names the code rather than claiming the ambiguity is gone.

**Re-issuing a timed-out mutation is refused, not merely discouraged.** A second identical `layer.create` or `layer.setText` while the first is still unresolved is answered with `bridge_previous_call_unresolved` and never reaches the tab — so a retry cannot duplicate a layer, whatever the caller believed about the first call. Two cases are relayed normally on purpose, because both are known rather than guessed: the earlier call is **recorded as failed** (the tab answered with an error, so it demonstrably did not land), and the call is an audited **read or export** (it cannot half-apply anything in the design, so re-issuing it is free — those two audited sets fail closed, and an unaudited method gets the conservative refusal). In every other case the state check named in the message is the route forward.

That envelope also ends with the serving build identity — `served by figpea-mcp <version> build <buildId> (built …, loaded …)` — so a timeout can be matched against the commit you believe is running without a second `status` call; when the served build has changed on disk since the process loaded it, the message says so and names the restart ([Which build is this server running?](#which-build-is-this-server-running)).

### Host request timeout

`_timeoutMs` raises *this package's* deadline only. Your MCP host has its own request timeout on top of it, which `_timeoutMs` cannot raise. When the host's ceiling fires first you get a transport-level error (e.g. `MCP error -32001: Request timed out`) and **no envelope at all** — no message, no named state check, nothing telling you whether the mutation applied. That is the one case where the advice above is not delivered for you, and it is also the one case where the outcome table does not reach you: no envelope was produced at all, so there is no `code` to branch on. What you are missing is specifically the `bridge_timeout_maybe_applied` envelope described in [Which failure was it?](#which-failure-was-it-branch-on-code) — the host's error carries no hint that it is standing in for that, and a transport-level timeout is indistinguishable from every other transport-level failure. Run the state check yourself, and prefer passing `_timeoutMs` up front to waiting under the host's ceiling.

Every tool also accepts `_rawJson` (boolean, optional) — the escape hatch for a host harness that stringifies a nested object or array instead of sending it as one. Set it to `true` and a JSON-looking string is JSON-parsed before forwarding at any position this build's manifest **declares** `object`/`array`/`matrix`, or at any position it declares nothing about at all — so the whole object can travel as a string and arrive as a real object with real numbers.

A parameter the manifest **declares** a `string`, `number` or `boolean` is left exactly as you sent it, even when its text happens to be valid JSON: `setName(id, '[1,2,3]')` still names the layer `[1,2,3]`, and a code sample or a fake API response travels as the text it is.

The positions the manifest says nothing about are where the flag earns its keep — an unknown method, a legacy free-text manifest, or a call made before the contract has been fetched. There is nothing there to scope a parse to, which is what the flag is for.

It works on **both** tool modes, on the two different surfaces each mode gives you:

- **Full mode** — a top-level param of any generated tool: `figpea_layer_create({ "kind": "page", "props": "{\"pageWidth\":1500}", "_rawJson": true })` parses `props`.
- **Compact mode (the default)** — any **element** of `figpea_call`'s positional `args` array, including nested payloads like a `layer.batch` ops array: `figpea_call({ "group": "layer", "method": "batch", "args": ["[{\"method\":\"create\",\"args\":[\"rect\",{\"rwidth\":100}]}]"], "_rawJson": true })` delivers `ops` as a real array, so the whole batch arrives in one call.

It is **opt-in**, and deliberately so. Where this build's manifest does declare a position, the flag is scoped the same way the default is: both routes are declaration-scoped, so **both routes** leave a `string`/`number`/`boolean` position exactly as you sent it. What the flag adds is the positions nothing declares. So there are **two routes**, and the narrower one is the default:

- **No flag (the default)** — a parameter the manifest **declares** as an `object`/`array`/`matrix` may travel as a JSON string, and the server parses it. Schema-scoped, so a `string`-declared value is provably never touched. This is the route to reach for when you know the method. **Where to read which params and what to send:** `figpea_describe({ group, method })` — its `stringJsonParams` names them, and any param the contract declares `stringJson` on carries the typed declaration and a copyable `example` (see [If your harness cannot send a nested object or array](#figpea_call-calling-conventions)). Note the advertisement is scoped to that tool: a **full-mode** `tools/list` does not describe the string alternative, and this row is not a claim that it does.
- **`_rawJson: true`** (opt-in) — the route for a position you cannot scope: an unknown method, a parameter this build's manifest does not declare as structured, or no manifest fetched at all, where there is nothing to scope a parse to and the flag is the only thing that makes the value usable. At a position the manifest *does* declare as structured you need neither it nor anything else — the default parses a JSON string there and checks the parsed shape against the declaration too — and all the flag adds there is a refusal that names `_rawJson` instead of the position.

If a value *looks* like JSON but cannot be parsed, and the parameter is declared an `object`, `array` or `matrix`, the call is refused up front with `invalid_params` naming `_rawJson` and the parameter, instead of being silently forwarded — so the flag never lies about having been honoured. The server also coerces string numerics inside objects/arrays to numbers defensively (harness stringification tolerance) without requiring `_rawJson`.

## Recovering a lost session

Two different things can go, and they look identical from the outside — your agent stops making progress, calls stop coming back — so they are kept apart here:

| What is gone | What still answers | What to do |
|--------------|--------------------|------------|
| **The MCP channel** — the host stopped driving the stdio server, or dropped it | **The bridge process.** It binds loopback, holds a token-gated relay to the tab, and keeps serving with no MCP server in the picture | The numbered procedure below |
| **The bridge process itself** | Nothing | Nothing in this package can help — start a fresh `figpea-mcp` and pair a tab again. See *When the process is gone* |

The bridge is started **inside** the stdio process and closed with it, so the second row is a real limit and not a hedge: nothing here outlives its own process.

### 1. Read the bridge-info file

Each run publishes how to reach itself while it runs, so an agent holding nothing but a shell can still find it. It is written at start and removed when the process exits:

```bash
ls "$TMPDIR"/figpea-mcp/bridge-*.json
cat "$TMPDIR"/figpea-mcp/bridge-*.json
```

```json
{
  "port": 49394,
  "token": "7406b5f5-d4d7-4934-a70a-63b925556623",
  "pid": 23508,
  "startedAt": "2026-10-04T20:59:44.772Z"
}
```

The path is `<os.tmpdir()>/figpea-mcp/bridge-<port>.json`, mode `0600` (owner-only), holding `{port, token, pid, startedAt}`. It sits beside the per-token session directories rather than inside one, because every entry in a token directory is charged against that session's return-bytes cap.

More than one file means more than one bridge is running; `pid` and `startedAt` tell them apart. A file left by a dead run is inert — the token it names matches no live bridge.

### 2. Ask whether the tab is answering — `GET /state`

`GET /state` is a read-only probe that answers from ledgers the bridge already holds, so it costs **zero tab round trips** — which is what makes it usable at all, since a probe that had to ask the tab would be useless exactly when the tab is the thing in question. It never returns the token.

```bash
curl -s -H "x-figpea-token: $TOKEN" "http://127.0.0.1:$PORT/state"
```

A real response, pretty-printed (it arrives as one line on the wire):

```json
{
  "port": 49394,
  "tabConnected": true,
  "liveness": {
    "connectionId": "c1",
    "state": "responsive",
    "inFlight": 0,
    "oldestInFlightMs": null,
    "consecutiveTimeouts": 0,
    "lastAnswerAt": "2026-10-04T20:59:45.610Z",
    "lastTimeoutAt": null,
    "nextStep": "the last call this bridge sent this tab was answered — proceed; a call still in flight is published as inFlight/oldestInFlightMs, and on a large project that is usually a render still settling rather than a failure"
  },
  "connection": {
    "lastEvent": "hello_accepted",
    "nextStep": "a tab is paired — proceed; read tabConnected for live truth",
    "tcpConnections": 3,
    "upgrades": 1,
    "helloAccepted": 1,
    "helloRejected": 0,
    "supersededCount": 0,
    "lastCloseCode": null,
    "lastCloseReason": null,
    "startedAt": "2026-10-04T20:59:44.772Z"
  }
}
```

The same `liveness` block is on the `status` payload, so this is a second door to one field rather than a second field. Read **`liveness.state`** here, not `connection.lastEvent`: both routes open a TCP socket on the shared listener, so a request to either one before any tab pairs leaves `lastEvent` reading `transport_only` — exactly as a `/file` fetch already does. That state is honest (a socket did reach the port and never handshook) and its `nextStep` points at reloading a tab, which is the wrong advice for a reader who has just proved they are on the right port.

### 3. Drive the tab — `POST /call`

`POST /call` relays one call through **the same relay and the same timeout ladder** the MCP tools use, so the envelope you get back is the envelope the tools produce, not a lookalike. Body: `{group, method, args?, timeoutMs?}`.

```bash
curl -s -X POST "http://127.0.0.1:$PORT/call" \
  -H "x-figpea-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"group":"layer","method":"create","args":["rect",{"name":"RecoveredCard"}]}'
```

```json
{"ok": true, "value": {"id": "12:9", "name": "RecoveredCard"}}
```

A refusal the editor made is a **successful relay of a failed call**, so it arrives as HTTP 200 carrying the tab's own envelope — the code you need to branch on, not flattened into a 5xx:

```json
{"ok": false, "code": "not_found", "message": "no layer named \"RecoveredCard\""}
```

The status codes are facts rather than categories: `200` answered (including the tab's own `{ok:false}`), `400` a body that cannot be addressed (nothing is relayed), `401` the token gate, `409` no tab is paired, `413` past the 32 MB body cap, `504` the relay deadline — carrying the relay's own envelope, so the state check and the recovery clause below reach this caller too — and `502` a relay failure that is not a deadline. Every non-200 body is `{ok: false, code, message}`, the package's one failure shape, and its `code` is the same vocabulary the MCP tools emit: a `504` body carries `bridge_timeout_maybe_applied`, so this route does not hand a caller a second, private set of words to learn.

Both routes require the per-run pairing token in the **`x-figpea-token` header** — never a query string, because a query string lands in a URL, in a pasted shell history and in an access log. Neither route is reachable from a browser page: no CORS headers are sent on either and `Access-Control-Allow-Methods` stays `GET, OPTIONS`, so a browser can neither read them nor preflight the POST. Call them with `curl`, `node`, or any local process.

### What the timeout envelope already told you

A timed-out call has always named the state check to run ([Call timeouts](#call-timeouts)). It now also names the two routes that survive a lost channel, appended after the state-check hint and before the serving-build stamp. Quoted verbatim from `recoveryHint()` in `src/tabLiveness.ts` — the same string the relay emits, not a paraphrase:

> if your next call to this tab also times out, this tab is not answering — layer.create timed out unanswered, and it is the streak that separates a busy tab from a wedged one. Read `status.liveness`, then drive the tab through the bridge's own `POST /call` route (README → Recovering a lost session); the bridge keeps serving without the MCP channel.

The clause is **conditional on the streak** because one unanswered call is not evidence: the tab keeps executing after the relay gives up and the effect may land anyway.

**What the envelope's `code` adds.** The prose in a timeout has always been the same for every kind of deadline, and it always will be — it is what a reader of English needs. The `code` is for the machine beside it, and it now distinguishes what used to be one indistinguishable value:

- `bridge_timeout_maybe_applied` — the relay's own deadline fired. The call may have landed; this bridge stopped waiting and its late answer, if one arrives, is recorded rather than discarded.
- `bridge_previous_call_unresolved` — this call was **refused**, not relayed, because an identical earlier call is still in doubt. Nothing reached the tab, so nothing was applied twice.
- `bridge_error` — the call was never delivered (no tab, socket gone, malformed frame). Unchanged in meaning from earlier versions: a relay that cannot say which failure it was reports the generic code rather than guessing.

Full table, with what to do in each case, in [Which failure was it?](#which-failure-was-it-branch-on-code).

### The `liveness` vocabulary

`status.liveness` (and `GET /state`) report **what this bridge observed**, and never why. A non-answer is a real answer, not a failure — a large project mid-render and a frozen tab look identical from out here, so the honest report is the ambiguity and **no value is proof the tab is dead**. A caller that reads "dead" on a merely-busy tab abandons live work.

| Liveness | What this bridge observed | What to do — the payload's own `nextStep`, quoted from `NEXT_STEP` in `src/tabLiveness.ts` | What it does NOT prove |
|----------|--------------------------|------------------------------------------------------------------------|------------------------|
| `unpaired` | no tab | no tab is paired to this bridge — open the pairing URL this status call prints in a browser to pair one; there is no tab to answer a call until then | that a tab is broken; it may simply never have paired |
| `unknown` | a tab paired, with no answered call and no timeout yet | a tab is paired but nothing has been observed on it yet — this bridge has seen no answered call and no timeout, which is not the same as healthy: make one call and read this block again | that the tab is healthy: nothing has been proven |
| `responsive` | the last call sent was answered | the last call this bridge sent this tab was answered — proceed; a call still in flight is published as inFlight/oldestInFlightMs, and on a large project that is usually a render still settling rather than a failure | that the bridge *process* is alive — a different process, with a different failure mode |
| `unresponsive` | two calls in a row went unanswered (or one, on a tab that had never answered) | two calls in a row went unanswered on this tab (or one, on a tab that had never answered) — that is what this bridge observed, not why: a large project mid-render and a frozen tab look identical from here, so it is not proof the tab failed. Look at the editor tab — if it is still working, wait for it; if it is not, the tab is what needs attention. With the MCP channel gone, drive the tab through the bridge's own call route (README → Recovering a lost session). | that the tab failed; a mid-render project looks the same from here |

The third column is quoted from the same map (`NEXT_STEP` in `src/tabLiveness.ts`) the server sends, so the sentence you read here is the sentence the agent gets — the table is a *reader* of that map, not a fourth copy of it. `unresponsive` needs **two** consecutive unanswered calls — or one on a tab that has never answered — because a single timeout after a successful answer is explicitly not that.

Two limits worth knowing before you read a field: `liveness` describes **the tab your calls are addressed to**, so in `--bridge-slots=multi` it follows `select_tab`; and the counters are per bridge, not persisted — a fresh run starts from zero.

### When the process is gone

If no bridge-info file answers, or the `pid` in it is gone, the bridge process died with the channel and **nothing in this package can reach your tab** — the routes are doors into that process, not a resurrection. What to do instead:

1. Start a fresh `figpea-mcp`, and open the pairing URL it prints to pair a tab again.
2. **Re-open your last export or checkpoint.** A fresh pair cannot re-adopt a tab that was paired to the dead bridge, so work that lived only in that tab's document is not reachable from the new one.

Re-pairing is the way out of a dead process, not a step inside the procedure above — the two are not interchangeable, and this section does not claim the procedure covers them.

## Security model

- The bridge binds **localhost only** (`127.0.0.1`) — never a public interface. The listener is IPv4-only and stays that way; the `localhost` host in emitted URLs and in the printed banner line is a separate decision, described under *How pairing works*.
- A **per-run pairing token** is regenerated on every start; a connection without the correct token is closed without ever being relayed.
- A **single active session by default** — a second valid connection is REFUSED by name rather than displacing the tab already paired, so no session can be silently evicted mid-task. `--bridge-slots=multi` opts into several paired tabs, each with its own slot and document.
- **One token, several slots, one machine** — a paired connection needs the same per-run token as any other, and multi-slot mode changes which documents are addressable, never who may connect: it is a correctness guard, not an authentication or transport change.
- At startup, the server performs two GET requests to the editor origin — `/agent/contract.json` (tool definitions) and `/agent/skill.md` (the agent skill reference, backing the `figpea_skill` tool) — to prefetch both before any tab pairs. This reveals only your client IP and startup timing to the editor origin; no usage telemetry is shipped. You can disable both fetches by setting `FIGPEA_DISABLE_CONTRACT_FETCH=1`.
- The server holds **no credentials other than its own per-run pairing token**, which it writes to the bridge-info file (`<tmpdir>/figpea-mcp/bridge-<port>.json`, mode `0600`, owner-only) so an agent that has lost its MCP channel can still reach it — per-run, owner-only, and removed when it exits. A leftover file from a dead run is inert: the token it names matches no live bridge ([Recovering a lost session](#recovering-a-lost-session)).
- `POST /call` and `GET /state` are gated on that same token, compared in constant time and read from the `x-figpea-token` header only — never a query string. A request without it is refused with `401`. The token is authority to drive the document in your open tab, which is exactly what holding the stdio pipe already allowed: a second door to the same room, not a new capability. Neither route is CORS-reachable — no browser page can read them or preflight the POST.
- Your design files are opened in your own browser tab and **never leave your machine**.

## Configuration & Environment Variables

- `FIGPEA_EDITOR_URL` — overrides the default editor origin (`https://editor.figpea.com`) for contract prefetching, skill prefetching (`figpea_skill`), and `open_editor` links.
- `FIGPEA_DISABLE_CONTRACT_FETCH=1` — disables BOTH the startup contract prefetch and the startup skill prefetch, falling back to cold-start static tools, drill-on-connect, and a degraded `figpea_skill` result.
- `--port=<n>` — binds the bridge server to a specific port.
- `--mode=compact|full` — selects the tool surface mode (default `compact`; `full` restores all `group_method` tools). See [Tool modes & `figpea_call` dispatcher](#tool-modes--figpea_call-dispatcher).
- `FIGPEA_TOOL_MODE=compact|full` — environment-variable fallback for `--mode` (same values, case-insensitive). CLI wins over env, both default to `compact`.
- `--bridge-slots=single|multi` — how many editor tabs this bridge serves (default `single`: a second tab is refused by name and the first keeps serving; `multi` gives each tab its own slot and document, and registers `select_tab`). See [Running two tabs at once](#running-two-tabs-at-once).
- `FIGPEA_BRIDGE_SLOTS=single|multi` — environment-variable fallback for `--bridge-slots` (same values, case-insensitive). CLI wins over env, both default to `single`.

## Durability — what is and isn't saved

**A project that exists only in the live editor tab is not durable.** Everything you build through this server lives in that one browser tab's memory: close the tab, refresh it, or let the editor reload a file and the project is gone, with nothing written anywhere on your machine.

**An exported `.fp` checkpoint is the only durable form.** `export.project({ format: "figpea" })` (and `session.openFile`'s inverse) writes a self-contained archive holding the project's layers, styles and structure; that file is what survives. Treat every other step as in-flight work.

Figpea **does not write back** to the file you opened. Opening a `.psd`, `.xd`, `.fig`, `.svg` or `.pdf` gives you an editable layer model, but your edits live in the tab — there is no save-back to the original format, and no mechanism that merges your changes into it. To keep your work, export a `.fp` and reopen that. This is a deliberate boundary, not a missing feature: those formats are read-only sources, and a lossy round-trip through a design tool is how original files get damaged.

If you want a mutation to be refused rather than silently applied to the wrong design, capture the identity first and pin it:

```
status()                          → { document: { id, name } }        // which design am I on?
figpea_call({ group: "session", method: "expectDocument", args: [document.id] })
// …mutations now refuse with document_mismatch if the tab switches designs…
figpea_call({ group: "session", method: "expectDocument", args: [] })  // clear when done
```

`document` is `null` when no tab is paired, when the tab is an older build without the method, or when it does not answer in time — so read `tabConnected` and `document` together. The guard covers a mutation **given** an expected identifier; with none armed, every method behaves exactly as it always did.

## Entitlement boundary

Authoring is free — opening, inspecting, and editing a file costs nothing. Export tools honor the signed-in user's plan exactly as the Figpea UI does: a call that isn't entitled returns `{ok: false, code: "entitlement_required"}`, never a silent partial result. The bridge doesn't unlock anything the editor UI wouldn't.

## Automated Browser & Agent Harness Pairing

Automated or headless browsers cannot answer native Local Network Access permission prompts. To pair in automated test or agent harness environments:
1. **Grant LNA permission** via CDP (`Browser.grantPermissions`), a pre-granted browser profile, or Chrome's `LocalNetworkAccessAllowedForUrls` enterprise policy.
2. **Localhost exemption**: Editors served from `http://localhost` are same-address-space and exempt from LNA entirely.

## Testing

Build before you test — this package's tests run against the **built** server, not the TypeScript source:

```bash
npm install
npm run build   # required first — see below
npm test
```

Three suites (`src/cli.test.ts`, `src/req1035.test.ts`, `src/skillProvenance.test.ts`) spawn `dist/cli.js` as a real child process over stdio, the same way an agent runs it, so they exercise the actual published entry point rather than importing it. `dist/` is a build artifact and is not in a fresh clone, which means those tests need `npm run build` to have run first. On a cold checkout they fail and say so, naming the missing `dist/cli.js` and this remedy — they are not a green suite over untested code.

The remaining suites exercise the server in-process and do not need a build.

## Troubleshooting

- **`no_tab`** — the refusal carries a `connection` block naming what happened; read `connection.lastEvent` and its `nextStep` before trying again ([Diagnosing a connection](#diagnosing-a-connection)). In the ordinary case it is `no_attempt` and the fix is to open an editor tab, via `open_editor` or by visiting the printed pairing URL. If `lastEvent` is `hello_rejected`, the pairing token is stale — re-read `token` from a fresh `status` call and open the URL that call prints, because a token from an earlier server run never matches. If it is `transport_only` or `hello_timeout`, the handshake never completed: check you are on the `bridgePort` this run reports, then reload the tab.
- **Nothing prints on stdout** — that's by design. stdio is the MCP JSON-RPC channel; every diagnostic goes to stderr.
- **`buildStale: true`** — the `figpea-mcp/dist` build on disk is not the one this process loaded, so the code answering you predates a merge. This is what a stale server looks like from the outside: a call the current source handles correctly comes back as a failure, and it reads as a bug in the design file. Restart the MCP server; it cannot restart itself, because your MCP client owns the process. Before you go hunting for a product bug, compare `build.buildId` with your own build — an unchanged `buildId` means the directory was simply rebuilt, not that newer code is waiting ([Which build is this server running?](#which-build-is-this-server-running)). Nothing else on `status` is affected, and it says nothing about the editor tab's build.
- **The MCP namespace vanished mid-session** — the tools are simply gone from a session that had them a minute ago, because the host stopped driving (or dropped) the stdio server. This package cannot bring that channel back; the host owns the process. What it can still do is finish the run: the bridge is likely still listening, so follow [Recovering a lost session](#recovering-a-lost-session) — read the bridge-info file, `GET /state` to see whether the tab is answering, then `POST /call` for the calls you still owe. If no bridge-info file answers, the process is gone too, and the answer is a fresh `figpea-mcp` plus a re-pair.
- **Every call times out while `tabConnected` is still `true`** — that bit describes the socket, not the tab, so a wedged tab keeps reading `true` while nothing answers. Read `liveness.state`: `unknown` means nothing has been observed yet, `responsive` means the last call came back, and `unresponsive` means two calls in a row went unanswered — which is what the bridge observed, not proof the tab failed, so look at the editor tab before you abandon work ([Recovering a lost session](#recovering-a-lost-session)).
- **`bridge_timeout_maybe_applied`** — the relay's own deadline fired, and the call **may have landed**: the tab keeps working after the bridge stops waiting. This is not a failure report. Run the state check the message names (`session.find({name})`, `session.layerById(<id>)` or `session.layerTree()`) before doing anything else, and do not re-issue a non-idempotent call — a duplicate is refused anyway, but the state check is the faster answer. A slow tab still looks slow: the code names what the bridge observed, not why the tab was late ([Which failure was it?](#which-failure-was-it-branch-on-code)).
- **`bridge_previous_call_unresolved`** — your re-issue of a timed-out call was **refused** and never reached the tab, so nothing was applied twice. This is the expected outcome of retrying a mutation that timed out, not a new failure. The message says whether the earlier call is recorded as applied or still unknown, and names the state check to run instead.
- **Port already in use** — pass `--port=<n>` to bind a specific port instead of an OS-assigned one.

## License

MIT — see [LICENSE](./LICENSE). Originally built inside the Figpea editor repo (`v3/packages/figpea-mcp/`); extracted here for an independent release cycle.
