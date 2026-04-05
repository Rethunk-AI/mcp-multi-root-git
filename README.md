# @rethunk/mcp-multi-root-git

MCP **stdio** server: read-only **git** tools (status, multi-root inventory, `HEAD` parity, presets) for any workspace. Workspace roots come from the MCP client at **`initialize`** — no fixed `cwd` in server config.

**Repository:** [github.com/Rethunk-AI/mcp-multi-root-git](https://github.com/Rethunk-AI/mcp-multi-root-git) · **npm:** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git)

## Documentation

| Doc | Audience |
|-----|----------|
| **[docs/mcp-tools.md](docs/mcp-tools.md)** | Tool ids, client naming, `format` / JSON, resource URI, workspace root resolution (canonical reference) |
| **[HUMANS.md](HUMANS.md)** | Install (`npx` / `bunx`), Cursor `mcp.json`, preset file, dev commands, CI, publishing (not auto-loaded in Cursor—open when needed) |
| **[AGENTS.md](AGENTS.md)** | Contributors: [`src/server.ts`](src/server.ts) map, contract bumps, CI. In Cursor, typically **project agent context** (rules should not re-link it). |

**Tools at a glance:** see the table in **[docs/mcp-tools.md](docs/mcp-tools.md)**.
