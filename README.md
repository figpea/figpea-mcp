# figpea-mcp

A Model Context Protocol (MCP) server that lets an AI agent open and drive a live Figpea editor — to view, inspect, and export PSD, Adobe XD, Figma, SVG, and PDF files — entirely on your machine.

> **Guided Pairing & Local Network Access (LNA).** When an agent invokes a contract tool before a tab is paired, it receives an actionable `no_tab` error carrying the exact pairing URL:
> ```text
> {"ok":false,"code":"no_tab","message":"No editor tab paired. Open this URL in your browser to connect an editor tab:","url":"https://editor.figpea.com/?agent=1&bridgePort=8080&bridgeToken=abc123token"}
> ```
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

The server starts a bridge on `127.0.0.1:<port>` with a per-run pairing token. The editor tab connects back over that localhost WebSocket carrying the token (`?agent=1&bridgePort=…&bridgeToken=…`). One connected tab at a time — the newest connection always wins over a stale one.

## Mid-session pairing — copy the connection string

You started a design without `?agent=1&bridgePort&bridgeToken` (the normal human flow) and now want agent help mid-session without reloading. Copy **one** paste-ready string — no hand-editing — into the editor's **File → Connect to Agent…** dialog (REQ-1036 consumer, tolerant parser `v3/src/agent/bridge/parsePairing.ts`):

- **From stderr** — copy the exact URL line printed at startup:
  ```text
  [figpea-mcp]   https://editor.figpea.com/?agent=1&bridgePort=54321&bridgeToken=550e8400-e29b-41d4-a716-446655440000
  ```
  (the indented line after `open this URL in a browser…`). Also the two-line pair `127.0.0.1:<port>` + `pairing token: <uuid>` is accepted when pasted together.
- **From `open_editor`** — call the tool, copy its returned `url` (same pairing URL; with `file` it appends `&loader=http&url=<file>`).
- **From `status`** — call the tool, copy its `url` or compose `?agent=1&bridgePort=<port>&bridgeToken=<token>` from `port`/`token`.

All three paste families are accepted byte-for-byte by `parsePairingFromPaste`:

1. **Full URL** `…?agent=1&bridgePort=<port>&bridgeToken=<token>` (any origin, extra surrounding text tolerated, also with `&loader=http&url=…`);
2. **JSON** `{"port":<port>,"token":"<uuid>","url":"https://…?bridgePort=…&bridgeToken=…"}` (as `open_editor` returns);
3. **stderr pair** `127.0.0.1:<port>` + `pairing token: <uuid>` pasted together with whitespace/newline.

Honors `FIGPEA_EDITOR_URL` (default `https://editor.figpea.com`, override for local dev) and `--port=<n>` — the pairing URL embeds whatever origin/port/token the bridge is actually bound to.

## Tool surface

| Tool | Always present | What it does |
|------|-----------------|---------------|
| `open_editor` | yes | Opens/points at an editor tab wired to this bridge. Returns `{port, token, url}`. |
| `status` | yes | Reports the bridge's port, token and pairing URL (`port`, `token`, `url`), whether a tab is connected, the connected tab's contract version, and the live tool count. |
| `figpea_skill` | yes | Returns Figpea's agent skill reference (the craft guidance for using `window.figpea` well), sourced from the editor origin's `/agent/skill.md` at startup — works even with no tab paired. Degrades to a structured `{ok:false, code:"skill_unavailable", message}` (never throws) if the fetch failed or was disabled. |
| `figpea_call` | compact only | Universal dispatcher — `figpea_call({ group, method, args, _timeoutMs })` calls any `group.method` on the paired tab (see below). |
| `group_method` (e.g. `layer_setPosition`, `canvas_screenshot`, `export_project`) | full mode only | One MCP tool per method in the connected tab's `figpea.describe()` manifest. |

In **compact mode (default)** the server advertises only `open_editor`, `status`, `figpea_skill`, and `figpea_call` (~500 tokens vs ~9,500 tokens, ~90–95% reduction). In **full mode** (`--mode=full` or `FIGPEA_TOOL_MODE=full`) it advertises `open_editor`, `status`, `figpea_skill` plus every `group_method` contract tool. See [Tool modes & `figpea_call` dispatcher](#tool-modes--figpea_call-dispatcher) below.

Generated tools (full mode) advertise structured parameter types (string / number / boolean / object / array) derived from the connected tab's contract manifest, so type-respecting MCP clients pass objects and arrays through intact.

The contract-tool list reflects whatever the connected editor advertises — it is not hardcoded here, and grows with the editor's contract. `status` and `tools/list` are the source of truth for what's callable right now; there is no version-lock between this bridge and the editor.

Every call returns `{ok: true, value}` or `{ok: false, code, message}`. Image-shaped results (`canvas.screenshot`, raster exports) come back as MCP image content alongside a text summary.

## Tool modes & `figpea_call` dispatcher

By default `figpea-mcp` runs in **compact mode** — only 4 tools (`open_editor`, `status`, `figpea_skill`, `figpea_call`) are advertised to the MCP client. This trims the baseline context from ~9,500 tokens (35+ granular tools) to ~500 tokens, a ~90–95% reduction, while keeping full capability through the dispatcher. Agents that rarely touch design files pay almost nothing until they actually need to.

### `figpea_call` calling conventions

`figpea_call` is the universal dispatcher for compact mode. It forwards to `bridge.callTab(group, method, args, _timeoutMs?)` and returns the result via the same `resultToContent` mapping (including image + text blocks).

```json
// Create a rect (AC-2)
{ "group": "layer", "method": "create", "args": ["rect", { "rwidth": 100, "rheight": 50 }] }

// Screenshot (AC-3) — returns MCP image content + text summary
{ "group": "canvas", "method": "screenshot", "args": [] }
```

- `group` (string, required) — contract group name (`layer`, `canvas`, `session`, `export`, `history`).
- `method` (string, required) — method within the group (`create`, `screenshot`, `openFile`, …).
- `args` (array, optional, defaults to `[]`) — positional arguments for that method, in the order `describe()` lists them.
- `_timeoutMs` (number, optional) — per-call timeout override, clamped to 120000 ms (same `MAX_CALL_TIMEOUT_MS` and `DEFAULT_TIMEOUT_TABLE_MS` as granular tools).

Image-returning methods (`canvas.screenshot`, raster `export.*`) return both an MCP `image` content block and a `text` summary block.

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

- **Per-call override** — every generated contract tool accepts an optional top-level `_timeoutMs` input key that raises that single call's timeout, e.g. `{ "url": "…", "_timeoutMs": 120000 }`. It is a reserved key: it is never forwarded to the editor-side method (it is not part of any method's arguments) and only affects the relay's own deadline. The documented maximum is **120000 ms (120 seconds)**; values above it are clamped to the cap rather than rejected.
- **Raised defaults for known-slow methods** — methods that legitimately run long get longer default ceilings automatically:

  | Tool | Default timeout |
  |------|-----------------|
  | `session_openFile` | 120000 ms |
  | `session_waitForIdle` | 30000 ms |
  | `export_project` | 120000 ms |
  | `export_specBundle` | 60000 ms |
  | `export_assetHarvest` | 120000 ms |
  | `export_figmaKit` | 60000 ms |

  Everything else keeps the flat 10-second default.

When a call does time out, the error says so honestly — `timed out after Nms; the editor may still be executing this call — check state before retrying`. **Do not blindly retry a failed mutation**: the tab keeps working after the relay gives up, so the effect may have landed anyway (retrying a non-idempotent call like `layer_create` duplicates the layer). Check state first (`status`, `session_layerTree`) and re-issue reads and idempotent setters freely.

Every tool also accepts `_rawJson` (boolean, optional) — when `true`, any top-level param that is a JSON string representing an object or array (e.g. `'{"pageWidth":1500}'` or `'[5,0,0,3.5,0,0]'`) is parsed before forwarding, so a client whose harness stringifies nested numbers can send the whole object as a JSON string and recover real numbers. The server also coerces string numerics inside objects/arrays to numbers defensively (harness stringification tolerance) without requiring `_rawJson`.

## Security model

- The bridge binds **localhost only** (`127.0.0.1`) — never a public interface.
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

## Troubleshooting

- **`no_tab`** — open an editor tab first, via `open_editor` or by visiting the printed pairing URL.
- **Nothing prints on stdout** — that's by design. stdio is the MCP JSON-RPC channel; every diagnostic goes to stderr.
- **Port already in use** — pass `--port=<n>` to bind a specific port instead of an OS-assigned one.

## License

MIT — see [LICENSE](./LICENSE). Originally built inside the Figpea editor repo (`v3/packages/figpea-mcp/`); extracted here for an independent release cycle.
