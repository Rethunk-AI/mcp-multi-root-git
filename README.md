# @rethunk/mcp-multi-root-git

[![CI](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40rethunk%2Fmcp-multi-root-git.svg)](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**git** tools over MCP: read-only status, multi-root inventory, `HEAD` parity, presets, structured diff viewer, log, push, worktrees, soft-reset, batch commit, merge, and cherry-pick. **Install and MCP client wiring:** **[docs/install.md](docs/install.md)** only — do not duplicate those steps elsewhere.

**Repository:** [github.com/Rethunk-AI/mcp-multi-root-git](https://github.com/Rethunk-AI/mcp-multi-root-git) · **npmjs (manual releases):** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git) · **GitHub Packages (CI on each tag):** [`@rethunk-ai/mcp-multi-root-git`](https://github.com/Rethunk-AI/mcp-multi-root-git/packages) — see [docs/install.md](docs/install.md) and [HUMANS.md](HUMANS.md) Publishing.

## Documentation

| Doc | Audience |
|-----|----------|
| **[docs/install.md](docs/install.md)** | Single source for prerequisites, running the package, and every supported MCP client (plus from-source and troubleshooting) |
| **[docs/mcp-tools.md](docs/mcp-tools.md)** | Tool ids, client naming, `format` / JSON, resource URI, workspace root resolution (canonical reference) |
| **[schemas/index.json](schemas/index.json)** | Published JSON schemas for all MCP tool parameters (JSON Schema draft-07 format) |
| **[HUMANS.md](HUMANS.md)** | Preset file, dev commands, CI, publishing |
| **[AGENTS.md](AGENTS.md)** | Contributors: implementation map ([`src/server/`](src/server/) + entry [`src/server.ts`](src/server.ts)), contract bumps, CI |

**Tools at a glance:** see the table in **[docs/mcp-tools.md](docs/mcp-tools.md)**.

## JSON Schemas

All MCP tool parameters are published as JSON Schema (draft-07) documents in the **[`schemas/`](schemas/)** directory. Tools and validators can use these schemas to validate tool input arguments without reading source code.

**Schema files:**
- `schemas/index.json` — Index of all 14 tool schemas with file paths
- `schemas/{tool_name}.json` — Individual schema for each tool (e.g., `schemas/batch_commit.json`, `schemas/git_status.json`)

For programmatic use, read `schemas/index.json` to discover available tools and their schema files.
