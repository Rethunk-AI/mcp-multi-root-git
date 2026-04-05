# @rethunk/mcp-multi-root-git

MCP **stdio** server: read-only **git** tools (status, multi-root inventory, `HEAD` parity, presets) for any workspace. Workspace roots come from the MCP client at **`initialize`** — no fixed `cwd` in server config.

**Repository:** [github.com/Rethunk-AI/mcp-multi-root-git](https://github.com/Rethunk-AI/mcp-multi-root-git) · **npm:** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git)

## Documentation

| Doc | Audience |
|-----|----------|
| **[HUMANS.md](HUMANS.md)** | Install (`npx` / `bunx`), Cursor `mcp.json`, presets, workspace roots, JSON output summary, dev commands, CI, publishing |
| **[AGENTS.md](AGENTS.md)** | LLMs and contributors: [`src/server.ts`](src/server.ts) map, tool/resource ids, contract bumps, CI, Cursor layout |

## Tools (skim)

Clients expose `{serverName}_{toolName}` (e.g. `rethunk-git_git_status`). Short ids:

| id | One-line |
|----|----------|
| `git_status` | Status + submodules per MCP root |
| `git_inventory` | Status + ahead/behind vs `@{u}` or fixed remote/branch |
| `git_parity` | Compare `HEAD` across path pairs |
| `list_presets` | List / validate `.rethunk/git-mcp-presets.json` |

Details, **`format: "json"`**, resource URI, and **`rethunkGitMcp`** stability fields: **[HUMANS.md](HUMANS.md)**.
