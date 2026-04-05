# AGENTS.md — LLM and developer onboarding

**Scope:** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git) is a single-file MCP **stdio** server: source [`src/server.ts`](src/server.ts), build output [`dist/server.js`](dist/server.js) (see `package.json` `bin` / `exports`).

**Operators and integrators:** **[docs/install.md](docs/install.md)** is the **only** place for prerequisites, how to launch the server, and per-client MCP configuration — do not duplicate that in README, HUMANS, rules, or here. Preset file, dev workflow, CI, and publishing: **[HUMANS.md](HUMANS.md)**.

**Tool ids, client naming, `format` / JSON envelopes, resource URI, workspace root order:** **[docs/mcp-tools.md](docs/mcp-tools.md)** — canonical; do not duplicate those tables in this file or HUMANS.

## Implementation map ([`src/server.ts`](src/server.ts))

| Area | Symbols / notes |
|------|-------------------|
| Package / MCP meta | `readPackageVersion()`, `FastMCP` constructor `version` |
| JSON stability | `MCP_JSON_FORMAT_VERSION`, `jsonRespond()` — every tool JSON body ends with `rethunkGitMcp` |
| Git on PATH | `gateGit()` — lazy `git --version`; `gitPathState` |
| MCP roots | `uriToPath`, `listFileRoots`, `resolveWorkspaceRoots`, `resolveRootsForPreset`; FastMCP `roots: { enabled: true }` — session roots only (client wiring: [docs/install.md](docs/install.md)) |
| Presets | `PRESET_FILE_PATH`, `splitPresetFileRaw`, `loadPresetsFromGitTop`, `getPresetEntry`, `presetLoadErrorPayload`; Zod `PresetEntrySchema` / `PresetFileSchema` must match [`git-mcp-presets.schema.json`](git-mcp-presets.schema.json) |
| Path safety | `resolvePathForRepo`, `assertRelativePathUnderTop`, `isStrictlyUnderGitTop`, `realPathOrSelf` |
| Sync git | `gitTopLevel`, `gitRevParseGitDir`, `gitRevParseHead`, `parseGitSubmodulePaths`, `hasGitMetadata` |
| Async / parallel | `spawnGitAsync`, `asyncPool`, `GIT_SUBPROCESS_PARALLELISM`; `gitStatusShortBranchAsync`, `collectInventoryEntry` |

## Changing contracts

- **Documentation layout:** do not add top-of-file **banner** paragraphs (bold blocks such as “Canonical doc for… / link here only”) to `docs/install.md` or other shipped docs. Use normal titles, TOC, and cross-links from README / this file / HUMANS.
- **`rethunkGitMcp.jsonFormatVersion`:** bump **`MCP_JSON_FORMAT_VERSION`** and document the migration in this file and in [docs/mcp-tools.md](docs/mcp-tools.md) when JSON field names or nesting change incompatibly.
- **Preset file:** keep **`splitPresetFileRaw`** + Zod parsing aligned with **`git-mcp-presets.schema.json`**; update the schema when adding keys or shapes.
- **Public tool surface:** if you add/rename tools, update [docs/mcp-tools.md](docs/mcp-tools.md) and [README.md](README.md) if the landing page still mentions tools; update [docs/install.md](docs/install.md) if install or client-specific wiring changes — **never** copy install steps into other docs; update [.cursor/rules/rethunk-git-mcp.mdc](.cursor/rules/rethunk-git-mcp.mdc) only if *when-to-use MCP vs shell* wording must change (that rule links `docs/install.md`, [HUMANS.md](HUMANS.md), and `docs/mcp-tools.md` without duplicating them).

## Validation and CI

Local: `bun run build` (`rimraf dist && tsc`), `bun run check` (Biome), `bun run test` (`bun test` for [`src/repo-paths.test.ts`](src/repo-paths.test.ts)). CI runs the same after `bun install --frozen-lockfile` (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

Optional [`.githooks/`](.githooks): run **`bun run setup-hooks`** once per clone (`core.hooksPath` → `.githooks`). **pre-commit** = `check`; **pre-push** = frozen install + build + check. See [HUMANS.md](HUMANS.md) Development.

Path confinement helpers live in [`src/repo-paths.ts`](src/repo-paths.ts); extend tests when changing that logic.

## Repository MCP entry (contributors)

Dogfooding from a clone: **[docs/install.md](docs/install.md)** — *From source (this repository)* only.

This repo may ship **`.cursor/`** config (example MCP entry + **alwaysApply** rule [`.cursor/rules/rethunk-git-mcp.mdc`](.cursor/rules/rethunk-git-mcp.mdc)). The rule covers *when* to call these tools vs shell git and links **`docs/install.md`**, **[HUMANS.md](HUMANS.md)**, and **`docs/mcp-tools.md`** without duplicating their bodies; it does not re-link this file when it is already injected as project context.

User-level skills may still mention the GitHub **README** for discovery. Canonical references: **tools / JSON** — **[docs/mcp-tools.md](docs/mcp-tools.md)**; **install / client wiring** — **[docs/install.md](docs/install.md)** (link it; do not paste per-client JSON into skills); **preset file** — **[HUMANS.md](HUMANS.md)**.

## Commits

Use the team’s **conventional commits + batching** skill (or equivalent): small themed commits, why-focused messages, `git add` + `git commit` in one shell invocation per batch.
