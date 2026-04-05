# AGENTS.md — LLM and developer onboarding

**Scope:** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git) is a single-file MCP **stdio** server: source [`src/server.ts`](src/server.ts), build output [`dist/server.js`](dist/server.js) (see `package.json` `bin` / `exports`).

**Operators and integrators:** install, MCP config, presets, and publishing live in **[HUMANS.md](HUMANS.md)** only (that file is not auto-loaded in Cursor; link it from rules and README when humans need the runbook).

**Tool ids, client naming, `format` / JSON envelopes, resource URI, workspace root order:** **[docs/mcp-tools.md](docs/mcp-tools.md)** — canonical; do not duplicate those tables in this file or HUMANS.

## Implementation map ([`src/server.ts`](src/server.ts))

| Area | Symbols / notes |
|------|-------------------|
| Package / MCP meta | `readPackageVersion()`, `FastMCP` constructor `version` |
| JSON stability | `MCP_JSON_FORMAT_VERSION`, `jsonRespond()` — every tool JSON body ends with `rethunkGitMcp` |
| Git on PATH | `gateGit()` — lazy `git --version`; `gitPathState` |
| MCP roots | `uriToPath`, `listFileRoots`, `resolveWorkspaceRoots`, `resolveRootsForPreset`; FastMCP `roots: { enabled: true }` — paths from session roots, not fixed `cwd` |
| Presets | `PRESET_FILE_PATH`, `splitPresetFileRaw`, `loadPresetsFromGitTop`, `getPresetEntry`, `presetLoadErrorPayload`; Zod `PresetEntrySchema` / `PresetFileSchema` must match [`git-mcp-presets.schema.json`](git-mcp-presets.schema.json) |
| Path safety | `resolvePathForRepo`, `assertRelativePathUnderTop`, `isStrictlyUnderGitTop`, `realPathOrSelf` |
| Sync git | `gitTopLevel`, `gitRevParseGitDir`, `gitRevParseHead`, `parseGitSubmodulePaths`, `hasGitMetadata` |
| Async / parallel | `spawnGitAsync`, `asyncPool`, `GIT_SUBPROCESS_PARALLELISM`; `gitStatusShortBranchAsync`, `collectInventoryEntry` |

## Changing contracts

- **`rethunkGitMcp.jsonFormatVersion`:** bump **`MCP_JSON_FORMAT_VERSION`** and document the migration in this file and in [docs/mcp-tools.md](docs/mcp-tools.md) when JSON field names or nesting change incompatibly.
- **Preset file:** keep **`splitPresetFileRaw`** + Zod parsing aligned with **`git-mcp-presets.schema.json`**; update the schema when adding keys or shapes.
- **Public tool surface:** if you add/rename tools, update [docs/mcp-tools.md](docs/mcp-tools.md) and [README.md](README.md) if the landing page still mentions tools; update [.cursor/rules/rethunk-git-mcp.mdc](.cursor/rules/rethunk-git-mcp.mdc) only if *when-to-use MCP vs shell* wording must change (that rule must not duplicate tool docs; it points at HUMANS + `docs/mcp-tools.md`).

## Validation and CI

Local: `bun run build` (`rimraf dist && tsc`), `bun run check` (Biome). Same commands run in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) with `bun install --frozen-lockfile`.

There is no `test` script yet; rely on build + Biome for regressions unless you add tests.

## Cursor (this repository)

- [`.cursor/mcp.json`](.cursor/mcp.json) — `bun src/server.ts` for dogfooding.
- [`.cursor/rules/rethunk-git-mcp.mdc`](.cursor/rules/rethunk-git-mcp.mdc) — **alwaysApply** “when to call MCP vs shell git” only. It links **[HUMANS.md](HUMANS.md)** for operational detail and **does not** link this file (you already have **AGENTS.md** in context).

User-level skills (e.g. conventional commits + batching) may still mention the GitHub **README**; canonical **tool / resource / JSON** reference is **[docs/mcp-tools.md](docs/mcp-tools.md)**; preset **file** layout and install remain **[HUMANS.md](HUMANS.md)**.

## Commits

Use the team’s **conventional commits + batching** skill (or equivalent): small themed commits, why-focused messages, `git add` + `git commit` in one shell invocation per batch.
