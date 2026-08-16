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

## Tool surface

| Tool | Always present | What it does |
|------|-----------------|---------------|
| `open_editor` | yes | Opens/points at an editor tab wired to this bridge. Returns `{port, token, url}`. |
| `status` | yes | Reports the bridge's port, whether a tab is connected, the connected tab's contract version, and the live tool count. |
| `group_method` (e.g. `layer_setPosition`, `canvas_screenshot`, `export_project`) | generated live | One MCP tool per method in the connected tab's `figpea.describe()` manifest. |

The contract-tool list reflects whatever the connected editor advertises — it is not hardcoded here, and grows with the editor's contract. `status` and `tools/list` are the source of truth for what's callable right now; there is no version-lock between this bridge and the editor.

Every call returns `{ok: true, value}` or `{ok: false, code, message}`. Image-shaped results (`canvas.screenshot`, raster exports) come back as MCP image content alongside a text summary.

## Security model

- The bridge binds **localhost only** (`127.0.0.1`) — never a public interface.
- A **per-run pairing token** is regenerated on every start; a connection without the correct token is closed without ever being relayed.
- **Single active session** — the newest valid connection always supersedes the previous one.
- At startup, the server performs a single GET request to the editor origin (`/agent/contract.json`) to prefetch the latest tool definitions. This reveals only your client IP and startup timing to the editor origin; no usage telemetry is shipped. You can disable this fetch entirely by setting `FIGPEA_DISABLE_CONTRACT_FETCH=1`.
- The server holds no credentials.
- Your design files are opened in your own browser tab and **never leave your machine**.

## Configuration & Environment Variables

- `FIGPEA_EDITOR_URL` — overrides the default editor origin (`https://editor.figpea.com`) for both contract prefetching and `open_editor` links.
- `FIGPEA_DISABLE_CONTRACT_FETCH=1` — disables the startup contract prefetch, falling back to cold-start static tools and drill-on-connect.
- `--port=<n>` — binds the bridge server to a specific port.

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
