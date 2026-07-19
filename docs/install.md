# Installing @rethunk/mcp-multi-root-git

This package is an MCP **stdio** server. The client starts the process and passes **workspace roots** at `initialize` — **do not** set a fixed working-directory (`cwd`) in the server launch config; roots come from the client session.

**See also:** [mcp-tools.md](mcp-tools.md) (tool ids, JSON, resources, workspace root *resolution*), [HUMANS.md](../HUMANS.md) (preset file, dev, CI, publishing), [AGENTS.md](../AGENTS.md) (contributors).

## Table of contents

- [Prerequisites](#prerequisites)
- [GitHub Packages](#github-packages)
- [Ways to run the binary](#ways-to-run-the-binary)
- [Configuration shape (stdio)](#configuration-shape-stdio)
- [Environment variables](#environment-variables)
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

## GitHub Packages

Every **version tag** on this repo is published to the **GitHub npm registry** as **`@rethunk-ai/mcp-multi-root-git`** (scope matches the GitHub org). The **npmjs** package name **`@rethunk/mcp-multi-root-git`** is updated **manually** by maintainers and may lag; prefer GitHub Packages for CI-aligned installs.

1. Create a [GitHub personal access token](https://github.com/settings/tokens) with at least **`read:packages`** (and **`repo`** if the package were private).
2. In **`~/.npmrc`** or the project **`.npmrc`** (do not commit secrets):

   ```ini
   @rethunk-ai:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=YOUR_TOKEN_HERE
   ```

3. Install or run, for example:

   ```bash
   npx -y @rethunk-ai/mcp-multi-root-git
   ```

   Or **`bunx @rethunk-ai/mcp-multi-root-git`** with the same registry configuration for that scope.

**`$schema` in preset JSON:** point at the copy under **`node_modules/@rethunk-ai/mcp-multi-root-git/git-mcp-presets.schema.json`** when you install from GitHub Packages; use **`@rethunk/mcp-multi-root-git/...`** when installing from npmjs.

## Ways to run the binary

Use any of these from a terminal to confirm the package runs (each starts the stdio server until EOF). **npmjs** name:

```bash
npx -y @rethunk/mcp-multi-root-git
bunx @rethunk/mcp-multi-root-git
npm install -g @rethunk/mcp-multi-root-git && mcp-multi-root-git
```

**GitHub Packages** name (after configuring **`.npmrc`** as in [GitHub Packages](#github-packages)):

```bash
npx -y @rethunk-ai/mcp-multi-root-git
bunx @rethunk-ai/mcp-multi-root-git
```

Published entrypoint: **`dist/server.js`** (see `bin` / `exports`). Clients typically invoke **`npx`** or **`bunx`** so a global install is optional.

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

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GIT_SUBPROCESS_PARALLELISM` | `4` | Max concurrent git subprocesses for `git_inventory` rows, `git_status` submodule rows, and multi-root fan-out in `git_log` and `git_grep`. Valid range: 1 to 2×CPU count (auto-clamped). Increase on high-core machines to accelerate large fleet scans; decrease if system resources are constrained. |
| `GIT_SUBPROCESS_TIMEOUT_MS` | `120000` | Per-subprocess timeout in milliseconds for async git calls. On expiry the child receives SIGTERM and the call fails. Set `0` (or negative) to disable timeout for intentionally unbounded operations. |
| `RETHUNK_GIT_TOOLS` | _(unset)_ | Comma-separated list of tool names to register. When unset or empty, all 31 tools are registered (default). When set, only the listed tools are exposed — unknown names are warned and ignored. If every name is unknown, **zero** tools are registered and a loud warning is emitted (the restriction is honored literally). The presets resource (`rethunk-git://presets`) is always registered regardless of this setting. Example: `RETHUNK_GIT_TOOLS=git_status,git_diff_summary,git_diff,git_log,batch_commit,git_push`. Full tool-name list: `git_status`, `git_inventory`, `git_parity`, `list_presets`, `git_log`, `git_diff_summary`, `git_diff`, `git_show`, `git_worktree_list`, `git_stash_list`, `git_fetch`, `git_blame`, `git_branch_list`, `git_reflog`, `batch_commit`, `git_push`, `git_merge`, `git_cherry_pick`, `git_cherry_pick_continue`, `git_reset_soft`, `git_tag`, `git_worktree_add`, `git_worktree_remove`, `git_stash_apply`, `git_grep`, `git_conflicts`, `git_remote`, `git_describe`, `git_branch`, `git_revert`, `git_stash_push`. |

Set these in the environment where the MCP client launches the server (e.g. in your shell, in the MCP client config as `env`, or in a startup script).

**MCP client `env` block** (Cursor / Claude Desktop `mcpServers`; VS Code adds `"env"` beside `"command"` / `"args"`):

```json
{
  "mcpServers": {
    "rethunk-git": {
      "command": "npx",
      "args": ["-y", "@rethunk/mcp-multi-root-git"],
      "env": {
        "GIT_SUBPROCESS_PARALLELISM": "8",
        "GIT_SUBPROCESS_TIMEOUT_MS": "120000",
        "RETHUNK_GIT_TOOLS": "git_status,git_log,batch_commit,git_push"
      }
    }
  }
}
```

Example: Running the server with 8 parallel git processes on a 4-core machine:

```bash
GIT_SUBPROCESS_PARALLELISM=8 npx -y @rethunk/mcp-multi-root-git
```

On a 4-core machine (CPU count = 4), the max parallelism is clamped to 8 (2×4). The value requested is used if valid.

## Cursor

**User scope (all workspaces):** `~/.cursor/mcp.json` on macOS/Linux, or `%USERPROFILE%\.cursor\mcp.json` on Windows.

**Project scope:** `.cursor/mcp.json` in the workspace (use when a team wants repo-local MCP wiring).

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

1. **Dependencies, build, and CI parity:** [CONTRIBUTING.md](../CONTRIBUTING.md) — *Development setup* (`bun install`, `bun run build`, `bun run ci`).
2. **Run the dev server** (no `dist/` required): from the repo root, **`bun src/server.ts`** (stdio MCP).

**MCP registration for a local checkout** — set `cwd` to the repository root (exception to the no-`cwd` rule for published packages) so relative `args` resolve, or pass absolute paths in `args`. Open the workspace at the clone root in your client.

**Bun dev server** (no `dist/` build):

```json
{
  "mcpServers": {
    "rethunk-git": {
      "command": "bun",
      "args": ["src/server.ts"],
      "cwd": "/path/to/mcp-multi-root-git"
    }
  }
}
```

**Built entrypoint** (after `bun run build`):

```json
{
  "mcpServers": {
    "rethunk-git": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/path/to/mcp-multi-root-git"
    }
  }
}
```

**Cursor:** add either block to user-scope (`~/.cursor/mcp.json`) or project-scope (`.cursor/mcp.json`). **Reload** the MCP connection after changing server code.

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| `git_not_found` | Install Git and ensure it is on `PATH` in the environment that launches the MCP server. |
| Tools missing / stale | Restart the MCP host or use its “reload MCP / reset tools” action; in VS Code try **MCP: Reset Cached Tools**. |
| `npx` / `bun` not found | Install Node ≥ 22 or Bun; use full paths to the executable in config if `PATH` is minimal. |
| Wrong repo / root | Ensure the client opened the intended workspace so MCP **file roots** match your git work trees; see [mcp-tools.md](mcp-tools.md) — *Workspace root resolution*. |
