# AGENTS.md — LLM and developer onboarding

**Scope:** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git) is a single-file MCP **stdio** server: source [`src/server.ts`](src/server.ts), build output [`dist/server.js`](dist/server.js) (see `package.json` `bin` / `exports`).

**Operators and integrators:** install, MCP config, presets, and publishing steps live in **[HUMANS.md](HUMANS.md)** only — do not duplicate long snippets here.

## Tools and resource (registered ids)

| Short id | Cursor-style id (server `rethunk-git`) | Role |
|----------|----------------------------------------|------|
| `git_status` | `rethunk-git_git_status` | Multi-root / submodule status; parallel submodule `git status` |
| `git_inventory` | `rethunk-git_git_inventory` | Per-path inventory + `@{u}` or fixed remote/branch |
| `git_parity` | `rethunk-git_git_parity` | `HEAD` SHA pairs |
| `list_presets` | `rethunk-git_list_presets` | Preset index + load errors |
| — | Resource `rethunk-git://presets` | JSON preset manifest for resolved root |

FastMCP registers **`roots: { enabled: true }`**; workspace paths come from MCP session roots, not a fixed `cwd` in config.

## Implementation map ([`src/server.ts`](src/server.ts))

| Area | Symbols / notes |
|------|-------------------|
| Package / MCP meta | `readPackageVersion()`, `FastMCP` constructor `version` |
| JSON stability | `MCP_JSON_FORMAT_VERSION`, `jsonRespond()` — every tool JSON body ends with `rethunkGitMcp` |
| Git on PATH | `gateGit()` — lazy `git --version`; `gitPathState` |
| MCP roots | `uriToPath`, `listFileRoots`, `resolveWorkspaceRoots`, `resolveRootsForPreset` |
| Presets | `PRESET_FILE_PATH`, `splitPresetFileRaw`, `loadPresetsFromGitTop`, `getPresetEntry`, `presetLoadErrorPayload`; Zod `PresetEntrySchema` / `PresetFileSchema` must match [`git-mcp-presets.schema.json`](git-mcp-presets.schema.json) |
| Path safety | `resolvePathForRepo`, `assertRelativePathUnderTop`, `isStrictlyUnderGitTop`, `realPathOrSelf` |
| Sync git | `gitTopLevel`, `gitRevParseGitDir`, `gitRevParseHead`, `parseGitSubmodulePaths`, `hasGitMetadata` |
| Async / parallel | `spawnGitAsync`, `asyncPool`, `GIT_SUBPROCESS_PARALLELISM`; `gitStatusShortBranchAsync`, `collectInventoryEntry` |

## Changing contracts

- **`rethunkGitMcp.jsonFormatVersion`:** bump **`MCP_JSON_FORMAT_VERSION`** and document the migration in this file and a line in [HUMANS.md](HUMANS.md) when JSON field names or nesting change incompatibly.
- **Preset file:** keep **`splitPresetFileRaw`** + Zod parsing aligned with **`git-mcp-presets.schema.json`**; update the schema when adding keys or shapes.
- **Public tool surface:** if you add/rename tools, update [README.md](README.md) short table, [HUMANS.md](HUMANS.md) full table, and [.cursor/rules/rethunk-git-mcp.mdc](.cursor/rules/rethunk-git-mcp.mdc) pointers.

## Validation and CI

Local: `bun run build` (`rimraf dist && tsc`), `bun run check` (Biome). Same commands run in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) with `bun install --frozen-lockfile`.

There is no `test` script yet; rely on build + Biome for regressions unless you add tests.

## Cursor (this repository)

- [`.cursor/mcp.json`](.cursor/mcp.json) — `bun src/server.ts` for dogfooding.
- [`.cursor/rules/rethunk-git-mcp.mdc`](.cursor/rules/rethunk-git-mcp.mdc) — short “when to call MCP vs shell git”; full tool args and behavior: **this file** and **HUMANS.md**.

## Commits

Use the team’s **conventional commits + batching** skill (or equivalent): small themed commits, why-focused messages, `git add` + `git commit` in one shell invocation per batch.
