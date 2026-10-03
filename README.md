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
> Opening that URL opens the editor with an LNA connect notice and explicit **Connect** consent gate button. Chrome may ask permission to reach the local network (accepted once per origin). Once granted, clicking Connect attaches the session safely.

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

The server binds a bridge on `127.0.0.1:<port>` — loopback only, never a public interface — and the editor tab connects back over that localhost WebSocket carrying the token (`?agent=1&bridgePort=…&bridgeToken=…`). One connected tab at a time: the newest connection always wins over a stale one.

Two different hosts, on purpose. The **bind** is `127.0.0.1` and stays that way: it is a security property, and the listener is IPv4-only. The **host in the URLs the bridge emits** (and in the `bridge listening on …` line it prints) is `localhost`, which is the host your editor tab is itself served from. Matching it puts the tab and the bridge in the same address space, so a `localhost` page talking to a `127.0.0.1` URL — a *cross-hostname* request, and so outside the Local Network Access localhost exemption, preflighted and permission-gated — no longer happens. That matters most for headless and automated browsers, which cannot answer an LNA prompt. The bind is deliberately not widened to `::1` to match: `localhost` resolves to `::1` first, and IPv4 clients still reach it through connection racing.

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
| `status` | yes | Reports the bridge's port, token and pairing URL (`port`, `token`, `url`), whether a tab is connected, the connected tab's contract version, the live tool count, a `connection` block naming why a tab is not connected (see [Diagnosing a connection](#diagnosing-a-connection)), and WHICH BUILD is answering — a `build` block (`version`, `buildId`, `builtAt`, `servedAt`, `root`) plus a top-level `buildStale` flag (see [Which build is this server running?](#which-build-is-this-server-running)). |
| `figpea_skill` | yes | Returns Figpea's agent skill reference (the craft guidance for using `window.figpea` well), sourced from the editor origin's `/agent/skill.md` at startup — works even with no tab paired. The answer names the URL it fetched from: the body is that origin's own build, so when a tab is paired from a different origin or a different build, get *the tab's* skill instead with `figpea.SKILL()` in the tab or `GET <the tab's origin>/agent/skill.md` (the answer says so when a tab is connected). Degrades to a structured `{ok:false, code:"skill_unavailable", message}` (never throws) if the fetch failed or was disabled. |
| `figpea_call` | compact only | Universal dispatcher — `figpea_call({ group, method, args, _timeoutMs })` calls any `group.method` on the paired tab (see below). |
| `figpea_describe` | compact only | Returns the contract surface for a group or method — the same `doc`/`params`/`result` the editor's own `describe()` returns, from the manifest this server already holds in memory (no tab round trip). `figpea_describe()` → group index, `{group}` → that group's methods, `{group, method}` → one method's wire shape. Degrades to `{ok:false, code:"describe_unavailable"}` (never throws) when the manifest was never fetched. |
| `group_method` (e.g. `layer_setPosition`, `canvas_screenshot`, `export_project`) | full mode only | One MCP tool per method in the connected tab's `figpea.describe()` manifest. |

In **compact mode (default)** the server advertises only `open_editor`, `status`, `figpea_skill`, `figpea_call` and `figpea_describe` — 5 tools, ~600 tokens vs ~9,500 tokens, a ~90–95% reduction. In **full mode** (`--mode=full` or `FIGPEA_TOOL_MODE=full`) it advertises `open_editor`, `status`, `figpea_skill` plus every `group_method` contract tool. See [Tool modes & `figpea_call` dispatcher](#tool-modes--figpea_call-dispatcher) below.

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

Read `connection.lastEvent`. `connection.nextStep` is the action that token implies, shipped in the same payload, so nothing has to be mapped by hand:

| `lastEvent` | What it means | What to do next |
|--------------|---------------|-----------------|
| `no_attempt` | Nothing has ever reached this bridge — no socket, no handshake, no tab. | nothing has reached this bridge yet — open the pairing URL from this status call in a browser to start an editor tab |
| `transport_only` | A socket reached this port but no WebSocket handshake ever completed. The common cause is a `bridgePort` that is not this bridge's. | a socket reached this port but no WebSocket handshake ever completed — check you are on the exact bridgePort printed above, then reload the editor tab |
| `hello_timeout` | The handshake completed but no `hello` frame arrived within 5 seconds. | the WebSocket handshake completed but no hello frame arrived within 5s — reload the editor tab, and check nothing (a proxy, an extension) is holding the connection open |
| `hello_rejected` | The pairing token did not match. A token minted by an earlier server run is the usual reason, and this bridge restarts whenever the MCP server restarts. | the pairing token was rejected — re-read token from this status call and open a freshly minted pairing URL; a token from an earlier server run is always stale |
| `hello_accepted` | A tab completed the handshake. Paired. | a tab is paired — proceed; read tabConnected for live truth |
| `tab_superseded` | A newer tab completed the handshake and took the connection over. Still paired — this is a healthy state, not a fault. | a newer tab took over the connection — paired, proceed; if you expected the older tab, close the newer one |
| `disconnected` | The paired tab went away after pairing. | the paired tab has gone away — open a fresh pairing URL from this status call to pair again |

That table is authoritative **in both directions**, the same way the per-method timeout table above is: `connection.nextStep` is read from the same map this table is written from, and the package's own test fails if the two ever disagree.

The counters (`tcpConnections`, `upgrades`, `helloAccepted`, `helloRejected`, `supersededCount`) are **per-process**: they cover this MCP server process only, they begin at zero every time it starts, and they are not a historical record — they say nothing about any previous run and are never persisted. `connection.startedAt` is the ISO-8601 instant this run started, and it is how you tell this run's numbers from an earlier one's.

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

**Nesting rule.** `args` is the positional array in the method's own parameter order. When a parameter is itself an array — `layer.batch`'s `ops` is the one that bites — that parameter goes in as **one element of `args`**, and the element is an array of `{method, args}` ops. Each op's `args` is a positional array as well. So `ops` is `[[{…}]]`, never `{ops: […]}` and never `{"item": […]}` (the latter is what some host harnesses produce when they collapse a nested array; `figpea_call` answers that with an `invalid_params` naming the path and the expected shape, without spending a tab round trip). When in doubt, call `figpea_describe({ group: "layer", method: "batch" })` first — it returns the authoritative shape from the manifest.

**Object-valued parameters — the object IS the positional slot.** When a parameter is a plain object, that object occupies `args[n]` *on its own*; you never wrap it in a second envelope keyed by the parameter's own name. This is the shape that bites hardest, precisely because several parameters are **named** `input` or `patch` — so writing that name into your payload is the mistake, not the fix. `figpea_describe({ group, method })` is the authority on which is which: it returns each parameter's name, type and shape in that method's own positional order, so a parameter's *name* tells you nothing about how to nest it. One consequence worth stating outright, because it is what turns a wrong call into a filesystem hunt: retrying a wrong shape here fails **identically** every time, because the argument — not the message — is what is wrong, so a clearer error on the next try cannot help. Change the shape.

The one wrapper that IS legal is a **single** object as the whole of `args`, keyed by the method's own parameter names — the editor expands it to positional order. That expansion needs the call to carry exactly one argument, so the moment a positional argument goes in front of it — `stylePatch`'s layer id, `setPosition`'s layer id — it stops expanding, and the wrapper arrives as the object itself. Your keys were fine; the envelope was the mistake.

```json
// session.openFile(input) — `input` IS args[0]. figpea-mcp maps a `filePath`
// here to http://localhost:<port>/file?path=… so the editor can fetch it.
{ "group": "session", "method": "openFile", "args": [{ "filePath": "/abs/path/design.fp" }] }
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

- `group` (string, required) — contract group name (`layer`, `canvas`, `session`, `export`, `history`).
- `method` (string, required) — method within the group (`create`, `screenshot`, `openFile`, …).
- `args` (array, optional, defaults to `[]`) — positional arguments for that method, in the order `describe()` lists them.
- `_timeoutMs` (number, optional) — per-call timeout override, clamped to 120000 ms (same `MAX_CALL_TIMEOUT_MS` and `DEFAULT_TIMEOUT_TABLE_MS` as granular tools).
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

Do not hardcode today's number: the editor owns the threshold and publishes it, and a threshold move is then a read rather than a guess. Each chunk is its own undo step, so splitting a batch trades one atomic undo for a correctly sized call.

### Configuration

| Flag / Env var | Values | Default | Precedence |
|----------------|--------|---------|------------|
| `--mode=compact\|full` | `compact` or `full` | `compact` | CLI wins over env |
| `FIGPEA_TOOL_MODE=compact\|full` | `compact` or `full` (case-insensitive) | `compact` | fallback if no CLI flag |

Invalid values are ignored (not rejected) with a `stderr` hint — a typo never crashes the stdio channel.

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

That envelope also ends with the serving build identity — `served by figpea-mcp <version> build <buildId> (built …, loaded …)` — so a timeout can be matched against the commit you believe is running without a second `status` call; when the served build has changed on disk since the process loaded it, the message says so and names the restart ([Which build is this server running?](#which-build-is-this-server-running)).

### Host request timeout

`_timeoutMs` raises *this package's* deadline only. Your MCP host has its own request timeout on top of it, which `_timeoutMs` cannot raise. When the host's ceiling fires first you get a transport-level error (e.g. `MCP error -32001: Request timed out`) and **no envelope at all** — no message, no named state check, nothing telling you whether the mutation applied. That is the one case where the advice above is not delivered for you: run the state check yourself, and prefer passing `_timeoutMs` up front to waiting under the host's ceiling.

Every tool also accepts `_rawJson` (boolean, optional) — the escape hatch for a host harness that stringifies a nested object or array instead of sending it as one. Set it to `true` and a JSON-looking string is JSON-parsed before forwarding at any position this build's manifest **declares** `object`/`array`/`matrix`, or at any position it declares nothing about at all — so the whole object can travel as a string and arrive as a real object with real numbers.

A parameter the manifest **declares** a `string`, `number` or `boolean` is left exactly as you sent it, even when its text happens to be valid JSON: `setName(id, '[1,2,3]')` still names the layer `[1,2,3]`, and a code sample or a fake API response travels as the text it is.

The positions the manifest says nothing about are where the flag earns its keep — an unknown method, a legacy free-text manifest, or a call made before the contract has been fetched. There is nothing there to scope a parse to, which is what the flag is for.

It works on **both** tool modes, on the two different surfaces each mode gives you:

- **Full mode** — a top-level param of any generated tool: `figpea_layer_create({ "kind": "page", "props": "{\"pageWidth\":1500}", "_rawJson": true })` parses `props`.
- **Compact mode (the default)** — any **element** of `figpea_call`'s positional `args` array, including nested payloads like a `layer.batch` ops array: `figpea_call({ "group": "layer", "method": "batch", "args": ["[{\"method\":\"create\",\"args\":[\"rect\",{\"rwidth\":100}]}]"], "_rawJson": true })` delivers `ops` as a real array, so the whole batch arrives in one call.

It is **opt-in**, and deliberately so. Where this build's manifest does declare a position, the flag is scoped the same way the default is: both routes are declaration-scoped, so **both routes** leave a `string`/`number`/`boolean` position exactly as you sent it. What the flag adds is the positions nothing declares. So there are **two routes**, and the narrower one is the default:

- **No flag (the default)** — a parameter the manifest **declares** as an `object`/`array`/`matrix` may travel as a JSON string, and the server parses it. Schema-scoped, so a `string`-declared value is provably never touched. This is the route to reach for when you know the method.
- **`_rawJson: true`** (opt-in) — the route for a position you cannot scope: an unknown method, a parameter this build's manifest does not declare as structured, or no manifest fetched at all, where there is nothing to scope a parse to and the flag is the only thing that makes the value usable. At a position the manifest *does* declare as structured you need neither it nor anything else — the default parses a JSON string there and checks the parsed shape against the declaration too — and all the flag adds there is a refusal that names `_rawJson` instead of the position.

If a value *looks* like JSON but cannot be parsed, and the parameter is declared an `object`, `array` or `matrix`, the call is refused up front with `invalid_params` naming `_rawJson` and the parameter, instead of being silently forwarded — so the flag never lies about having been honoured. The server also coerces string numerics inside objects/arrays to numbers defensively (harness stringification tolerance) without requiring `_rawJson`.

## Security model

- The bridge binds **localhost only** (`127.0.0.1`) — never a public interface. The listener is IPv4-only and stays that way; the `localhost` host in emitted URLs and in the printed banner line is a separate decision, described under *How pairing works*.
- A **per-run pairing token** is regenerated on every start; a connection without the correct token is closed without ever being relayed.
- **Single active session** — the newest valid connection always supersedes the previous one.
- At startup, the server performs two GET requests to the editor origin — `/agent/contract.json` (tool definitions) and `/agent/skill.md` (the agent skill reference, backing the `figpea_skill` tool) — to prefetch both before any tab pairs. This reveals only your client IP and startup timing to the editor origin; no usage telemetry is shipped. You can disable both fetches by setting `FIGPEA_DISABLE_CONTRACT_FETCH=1`.
- The server holds no credentials.
- Your design files are opened in your own browser tab and **never leave your machine**.

## Configuration & Environment Variables

- `FIGPEA_EDITOR_URL` — overrides the default editor origin (`https://editor.figpea.com`) for contract prefetching, skill prefetching (`figpea_skill`), and `open_editor` links.
- `FIGPEA_DISABLE_CONTRACT_FETCH=1` — disables BOTH the startup contract prefetch and the startup skill prefetch, falling back to cold-start static tools, drill-on-connect, and a degraded `figpea_skill` result.
- `--port=<n>` — binds the bridge server to a specific port.
- `--mode=compact|full` — selects the tool surface mode (default `compact`; `full` restores all `group_method` tools). See [Tool modes & `figpea_call` dispatcher](#tool-modes--figpea_call-dispatcher).
- `FIGPEA_TOOL_MODE=compact|full` — environment-variable fallback for `--mode` (same values, case-insensitive). CLI wins over env, both default to `compact`.

## Entitlement boundary

Authoring is free — opening, inspecting, and editing a file costs nothing. Export tools honor the signed-in user's plan exactly as the Figpea UI does: a call that isn't entitled returns `{ok: false, code: "entitlement_required"}`, never a silent partial result. The bridge doesn't unlock anything the editor UI wouldn't.

## Automated Browser & Agent Harness Pairing

Automated or headless browsers cannot answer native Local Network Access permission prompts. To pair in automated test or agent harness environments:
1. **Grant LNA permission** via CDP (`Browser.grantPermissions`), a pre-granted browser profile, or Chrome's `LocalNetworkAccessAllowedForUrls` enterprise policy.
2. **Programmatically click Connect** on the editor notice.
3. **Localhost exemption**: Editors served from `http://localhost` are same-address-space and exempt from LNA entirely.

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
- **Port already in use** — pass `--port=<n>` to bind a specific port instead of an OS-assigned one.

## License

MIT — see [LICENSE](./LICENSE). Originally built inside the Figpea editor repo (`v3/packages/figpea-mcp/`); extracted here for an independent release cycle.
