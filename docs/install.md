# Installing @rethunk/mcp-multi-root-git

This package is an MCP **stdio** server. The client starts the process and passes **workspace roots** at `initialize` — **do not** set a fixed working-directory (`cwd`) in the server launch config; roots come from the client session.

**See also:** [mcp-tools.md](mcp-tools.md) (tool ids, JSON, resources, workspace root *resolution*), [HUMANS.md](../HUMANS.md) (preset file, dev, CI, publishing), [AGENTS.md](../AGENTS.md) (contributors).

## Table of contents

- [Prerequisites](#prerequisites)
- [Ways to run the binary](#ways-to-run-the-binary)
- [Configuration shape (stdio)](#configuration-shape-stdio)
- [Cursor](#cursor)
- [Visual Studio Code (GitHub Copilot)](#visual-studio-code-github-copilot)
- [Claude Desktop](#claude-desktop)
- [Zed](#zed)
- [Other clients and CLIs](#other-clients-and-clis)
- [From source (this repository)](#from-source-this-repository)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Git** on `PATH` (`git --version`). The server shells out to `git`; if it is missing, tools return `git_not_found`.
- **Node.js ≥ 22** if you use **`npx`**, or **Bun** if you use **`bunx`** / **`bun`** (see `package.json` `engines` / `packageManager`).

## Ways to run the binary

Use any of these from a terminal to confirm the package runs (each starts the stdio server until EOF):

```bash
npx -y @rethunk/mcp-multi-root-git
bunx @rethunk/mcp-multi-root-git
npm install -g @rethunk/mcp-multi-root-git && mcp-multi-root-git
```

Published entrypoint: **`dist/server.js`** (see npm `bin` / `exports`). Clients typically invoke **`npx`** or **`bunx`** so a global install is optional.

## Configuration shape (stdio)

Across clients you always provide:

- A **command** (e.g. `npx`, `bunx`, `bun`, `node`).
- **Arguments** that resolve to this package’s server (e.g. `["-y", "@rethunk/mcp-multi-root-git"]` for `npx`).

Register the server under a stable name (this documentation uses **`rethunk-git`**). Tools appear as `{serverName}_{toolName}` (e.g. `rethunk-git_git_status`).

**Bun instead of npx**

```json
{
  "command": "bunx",
  "args": ["@rethunk/mcp-multi-root-git"]
}
```

**No `cwd`**

Omit any `cwd` / `workingDirectory` field unless your client requires it for unrelated reasons. This server resolves repos from MCP **roots**, not from the process cwd.

## Cursor

**User scope (all workspaces):** `~/.cursor/mcp.json` on macOS/Linux, or `%USERPROFILE%\.cursor\mcp.json` on Windows.

**Project scope:** `.cursor/mcp.json` in the workspace (often committed for team dogfooding).

Cursor uses a top-level **`mcpServers`** object:

```json
{
  "mcpServers": {
    "rethunk-git": {
      "command": "npx",
      "args": ["-y", "@rethunk/mcp-multi-root-git"]
    }
  }
}
```

After editing, reload MCP (Command Palette: reload / restart MCP). If tools are missing, ensure **`npx`** or **`bun`** is on `PATH`.

## Visual Studio Code (GitHub Copilot)

MCP config lives in **`mcp.json`**: either **`.vscode/mcp.json`** in the workspace or the **user** MCP file (Command Palette: **MCP: Open User Configuration**). See the official [MCP configuration reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration).

VS Code expects a **`servers`** object. For a stdio server set **`type`** to **`stdio`**, then **`command`** / **`args`**:

```json
{
  "servers": {
    "rethunk-git": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@rethunk/mcp-multi-root-git"]
    }
  }
}
```

Use **MCP: List Servers** / **MCP: Reset Cached Tools** if tools do not update after a package upgrade.

## Claude Desktop

Config file (create if missing):

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Top-level key **`mcpServers`** (stdio by default):

```json
{
  "mcpServers": {
    "rethunk-git": {
      "command": "npx",
      "args": ["-y", "@rethunk/mcp-multi-root-git"]
    }
  }
}
```

Restart Claude Desktop after saving; invalid JSON often fails silently.

## Zed

Configure **context servers** in Zed **`settings.json`** (e.g. `~/.config/zed/settings.json` on macOS/Linux). See [Model Context Protocol in Zed](https://zed.dev/docs/ai/mcp.html).

```json
{
  "context_servers": {
    "rethunk-git": {
      "command": "npx",
      "args": ["-y", "@rethunk/mcp-multi-root-git"]
    }
  }
}
```

Use the Agent Panel server status indicator to confirm the server is active.

## Other clients and CLIs

Any MCP host that supports **stdio** and workspace roots can use the same **`command` / `args`** as above. Examples include other editors, team-internal launchers, and **Claude Code**-style environments — follow that product’s MCP docs and map:

- **Command:** `npx` (or `bunx`, `node`, etc.)
- **Args:** e.g. `["-y", "@rethunk/mcp-multi-root-git"]` for `npx`

Official protocol overview: [modelcontextprotocol.io](https://modelcontextprotocol.io/).

## From source (this repository)

For contributors working inside a clone of [mcp-multi-root-git](https://github.com/Rethunk-AI/mcp-multi-root-git):

1. **Dependencies, build, and CI parity:** **[HUMANS.md](../HUMANS.md)** — *Development* (`bun install`, `bun run build`, `bun run check`). Do not duplicate that workflow here.
2. **Run the dev server** (no `dist/` required): from the repo root, **`bun src/server.ts`** (stdio MCP).

**MCP registration for a local checkout:** point your client at that command (or at **`dist/server.js`** via `node` after `bun run build` — see HUMANS). **Cursor:** this repo may ship an example **`.cursor/mcp.json`** using `bun` + `["src/server.ts"]`; open the workspace at the repository root so relative args resolve.

**Reload** the MCP connection after changing server code.

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| `git_not_found` | Install Git and ensure it is on `PATH` in the environment that launches the MCP server. |
| Tools missing / stale | Restart the MCP host or use its “reload MCP / reset tools” action; in VS Code try **MCP: Reset Cached Tools**. |
| `npx` / `bun` not found | Install Node ≥ 22 or Bun; use full paths to the executable in config if `PATH` is minimal. |
| Wrong repo / root | Ensure the client opened the intended workspace so MCP **file roots** match your git work trees; see [mcp-tools.md](mcp-tools.md) — *Workspace root resolution*. |
