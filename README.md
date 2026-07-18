<h1 align="center">@rethunk/mcp-multi-root-git</h1>

<div align="center">

[![CI](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/ci.yml/badge.svg)](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40rethunk%2Fmcp-multi-root-git.svg)](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

MCP **stdio** server exposing **git** tools to AI clients — status, multi-root inventory, parity checks, presets, logs, search, diffs, commits, push, merge, worktrees, and more. One server process spans every workspace root the client registers at `initialize`.

**Repository:** [github.com/Rethunk-AI/mcp-multi-root-git](https://github.com/Rethunk-AI/mcp-multi-root-git) · **npmjs (manual releases):** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git) · **GitHub Packages (CI on each tag):** [`@rethunk-ai/mcp-multi-root-git`](https://github.com/Rethunk-AI/mcp-multi-root-git/packages) — see [docs/install.md](docs/install.md) and [HUMANS.md#publishing](HUMANS.md#publishing).

## Quick start

```bash
npx -y @rethunk/mcp-multi-root-git
```

Full install, prerequisites, and MCP client wiring: [HUMANS.md](HUMANS.md) and [docs/install.md](docs/install.md).

## Highlights

- **Multi-root fan-out** — `git_status`, `git_inventory`, `git_parity`, `git_log`, and `git_grep` route across one repo, an explicit list, or every MCP root (`"*"`)
- **Structured JSON** — minified tool payloads (format version 5); optional fields omitted when empty
- **Presets** — `.rethunk/git-mcp-presets.json` at the git toplevel for nested roots and parity pairs
- **Read and write git** — diffs, blame, conflicts, stash, fetch, `batch_commit`, push, merge, cherry-pick, revert, branches, tags, and worktrees (writes take a single `workspaceRoot`)
- **Published schemas** — `schemas/index.json` and per-tool JSON Schema files for offline validation

## Documentation

| Doc | Audience |
|-----|----------|
| **[docs/install.md](docs/install.md)** | Single source for prerequisites, running the package, and every supported MCP client (plus from-source and troubleshooting) |
| **[docs/mcp-tools.md](docs/mcp-tools.md)** | Tool ids, client naming, `format` / JSON, resource URI, workspace root resolution (canonical reference) |
| **[schemas/index.json](schemas/index.json)** | Published JSON schemas for all MCP tool parameters (JSON Schema draft 2020-12 format) |
| **[HUMANS.md](HUMANS.md)** | Preset file, dev commands, CI, publishing |
| **[AGENTS.md](AGENTS.md)** | Contributors: implementation map ([`src/server/`](src/server/) + entry [`src/server.ts`](src/server.ts)), contract bumps, CI |
| **[CONTRIBUTING.md](CONTRIBUTING.md)** | Dev setup, hooks, commit conventions, release checks, and how to add tools |
| **[SECURITY.md](SECURITY.md)** | Disclosure policy, threat model, and repository safety guidance |
| **[CHANGELOG.md](CHANGELOG.md)** | Release notes (Keep a Changelog style) |
| **[TODO.md](TODO.md)** | Future backlog and planned work |
| **[specs/README.md](specs/README.md)** | Active / done / parked specification layout used for repo planning |

## License

Copyright (c) 2026 Rethunk Tech. Licensed under the MIT License — see [LICENSE](LICENSE) for details.
