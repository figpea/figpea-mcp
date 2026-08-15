# figpea-mcp

A Model Context Protocol (MCP) server that lets an AI agent open and drive a live Figpea editor — to view, inspect, and export PSD, Adobe XD, Figma, SVG, and PDF files — entirely on your machine.

> **Status: pre-release.** Published to npm under the **`next`** dist-tag only, so plain `npx figpea-mcp` deliberately resolves to nothing for now. To try it, pin the tag — use `"figpea-mcp@next"` in place of `"figpea-mcp"` in the `args` array below, or `npm install figpea-mcp@next`.
>
> `latest` is held back on purpose: connecting an editor tab needs your browser's permission to reach the local network, and the current flow neither asks for it clearly nor tells you when it was denied. Until that lands, a first run can look like it simply hangs. *(This note is replaced when `latest` is promoted.)*

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
- The server is a **pure localhost relay**: it holds no credentials and ships no telemetry.
- Your design files are opened in your own browser tab and **never leave your machine**.

## Entitlement boundary

Authoring is free — opening, inspecting, and editing a file costs nothing. Export tools honor the signed-in user's plan exactly as the Figpea UI does: a call that isn't entitled returns `{ok: false, code: "entitlement_required"}`, never a silent partial result. The bridge doesn't unlock anything the editor UI wouldn't.

## Troubleshooting

- **`no_tab`** — open an editor tab first, via `open_editor` or by visiting the printed pairing URL.
- **Nothing prints on stdout** — that's by design. stdio is the MCP JSON-RPC channel; every diagnostic goes to stderr.
- **Port already in use** — pass `--port=<n>` to bind a specific port instead of an OS-assigned one.

## License

MIT — see [LICENSE](./LICENSE). Originally built inside the Figpea editor repo (`v3/packages/figpea-mcp/`); extracted here for an independent release cycle.
