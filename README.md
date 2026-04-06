# @rethunk/mcp-multi-root-git

[![CI](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/ci.yml)
[![Release](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/release.yml/badge.svg)](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/Rethunk-AI/mcp-multi-root-git?logo=github&label=release)](https://github.com/Rethunk-AI/mcp-multi-root-git/releases/latest)
[![npm version](https://img.shields.io/npm/v/%40rethunk%2Fmcp-multi-root-git.svg)](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git)
[![npm downloads](https://img.shields.io/npm/dm/%40rethunk%2Fmcp-multi-root-git.svg?label=npm%20downloads)](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git)
[![GitHub Packages](https://img.shields.io/badge/github%20packages-%40rethunk--ai%2Fmcp--multi--root--git-24292f?logo=github)](https://github.com/Rethunk-AI/mcp-multi-root-git/pkgs/npm/mcp-multi-root-git)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://github.com/Rethunk-AI/mcp-multi-root-git/blob/main/package.json)

Read-only **git** tools over MCP (status, multi-root inventory, `HEAD` parity, presets). **Install and MCP client wiring:** **[docs/install.md](docs/install.md)** only — do not duplicate those steps elsewhere.

**Repository:** [github.com/Rethunk-AI/mcp-multi-root-git](https://github.com/Rethunk-AI/mcp-multi-root-git) · **npmjs (manual releases):** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git) · **GitHub Packages (CI on each tag):** [`@rethunk-ai/mcp-multi-root-git`](https://github.com/Rethunk-AI/mcp-multi-root-git/pkgs/npm/mcp-multi-root-git) — see [docs/install.md](docs/install.md) and [HUMANS.md](HUMANS.md) Publishing.

## Documentation

| Doc | Audience |
|-----|----------|
| **[docs/install.md](docs/install.md)** | Single source for prerequisites, running the package, and every supported MCP client (plus from-source and troubleshooting) |
| **[docs/mcp-tools.md](docs/mcp-tools.md)** | Tool ids, client naming, `format` / JSON, resource URI, workspace root resolution (canonical reference) |
| **[HUMANS.md](HUMANS.md)** | Preset file, dev commands, CI, publishing |
| **[AGENTS.md](AGENTS.md)** | Contributors: implementation map ([`src/server/`](src/server/) + entry [`src/server.ts`](src/server.ts)), contract bumps, CI (IDEs that inject this file as project context should not re-link it from rules) |

**Tools at a glance:** see the table in **[docs/mcp-tools.md](docs/mcp-tools.md)**.
