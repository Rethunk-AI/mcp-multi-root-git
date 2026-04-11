# AGENTS.md — LLM and developer onboarding

Note for IDEs that inject this file as project context: do not re-link it from rules.

**Scope:** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git) is an MCP **stdio** server: entry [`src/server.ts`](src/server.ts) (FastMCP + `registerRethunkGitTools`), supporting modules under [`src/server/`](src/server/), build output [`dist/server.js`](dist/server.js) (see `package.json` `bin` / `exports`; publish ships the full `dist/` tree).

**Operators and integrators:** **[docs/install.md](docs/install.md)** is the **only** place for prerequisites, how to launch the server, and per-client MCP configuration — do not duplicate that in README, HUMANS, rules, or here. Preset file, dev workflow, CI, and publishing: **[HUMANS.md](HUMANS.md)**.

**Tool ids, client naming, `format` / JSON envelopes, resource URI, workspace root order:** **[docs/mcp-tools.md](docs/mcp-tools.md)** — canonical; do not duplicate those tables in this file or HUMANS.

## Implementation map

| File | Symbols / notes |
|------|-------------------|
| [`src/server.ts`](src/server.ts) | `FastMCP` + `roots: { enabled: true }`; `readMcpServerVersion()`; `registerRethunkGitTools` |
| [`src/server/json.ts`](src/server/json.ts) | `MCP_JSON_FORMAT_VERSION`, `jsonRespond()`, `spreadWhen`, `spreadDefined` — every tool JSON body ends with `rethunkGitMcp` |
| [`src/server/git.ts`](src/server/git.ts) | `gateGit()` — lazy `git --version`; `spawnGitAsync`, `asyncPool`, `GIT_SUBPROCESS_PARALLELISM`; `gitTopLevel`, `gitRevParseGitDir`, `gitRevParseHead`, `parseGitSubmodulePaths`, `hasGitMetadata`; `gitStatusSnapshotAsync`, `gitStatusShortBranchAsync`, `fetchAheadBehind`, `isSafeGitUpstreamToken` |
| [`src/server/roots.ts`](src/server/roots.ts) | `uriToPath`, `listFileRoots`, `pathMatchesWorkspaceRootHint`, `resolveWorkspaceRoots`, `resolveRootsForPreset`, `requireGitAndRoots` — session roots only (client wiring: [docs/install.md](docs/install.md)) |
| [`src/server/presets.ts`](src/server/presets.ts) | `PRESET_FILE_PATH`, `splitPresetFileRaw`, `loadPresetsFromGitTop`, `getPresetEntry`, `presetLoadErrorPayload`, `applyPresetNestedRoots`, `applyPresetParityPairs`; Zod `PresetEntrySchema` / `PresetFileSchema` must match [`git-mcp-presets.schema.json`](git-mcp-presets.schema.json) |
| [`src/server/schemas.ts`](src/server/schemas.ts) | `WorkspacePickSchema`, `MAX_INVENTORY_ROOTS_DEFAULT` |
| [`src/server/inventory.ts`](src/server/inventory.ts) | `validateRepoPath`, `makeSkipEntry`, `buildInventorySectionMarkdown`, `collectInventoryEntry` (uses repo-paths + git) |
| [`src/server/tools.ts`](src/server/tools.ts) | `registerRethunkGitTools` — calls per-surface `register*` below |
| [`src/server/git-status-tool.ts`](src/server/git-status-tool.ts) | `registerGitStatusTool` — `git_status` |
| [`src/server/git-inventory-tool.ts`](src/server/git-inventory-tool.ts) | `registerGitInventoryTool` — `git_inventory` |
| [`src/server/git-parity-tool.ts`](src/server/git-parity-tool.ts) | `registerGitParityTool` — `git_parity` |
| [`src/server/list-presets-tool.ts`](src/server/list-presets-tool.ts) | `registerListPresetsTool` — `list_presets` |
| [`src/server/presets-resource.ts`](src/server/presets-resource.ts) | `registerPresetsResource` — `rethunk-git://presets` resource |
| [`src/repo-paths.ts`](src/repo-paths.ts) | `resolvePathForRepo`, `assertRelativePathUnderTop`, `isStrictlyUnderGitTop`, `realPathOrSelf` |

## Changing contracts

- **Documentation layout:** do not add top-of-file **banner** paragraphs (bold blocks such as “Canonical doc for… / link here only”) to `docs/install.md` or other shipped docs. Use normal titles, TOC, and cross-links from README / this file / HUMANS.
- **`rethunkGitMcp.jsonFormatVersion`:** bump **`MCP_JSON_FORMAT_VERSION`** and document the migration in this file and in [docs/mcp-tools.md](docs/mcp-tools.md) when JSON field names or nesting change incompatibly.
- **Preset file:** keep **`splitPresetFileRaw`** + Zod parsing aligned with **`git-mcp-presets.schema.json`**; update the schema when adding keys or shapes.
- **Public tool surface:** if you add/rename tools, update [docs/mcp-tools.md](docs/mcp-tools.md) and [README.md](README.md) if the landing page still mentions tools; update [docs/install.md](docs/install.md) if install or client-specific wiring changes — **never** copy install steps into other docs; update [.cursor/rules/rethunk-git-mcp.mdc](.cursor/rules/rethunk-git-mcp.mdc) only if *when-to-use MCP vs shell* wording must change (that rule links `docs/install.md`, [HUMANS.md](HUMANS.md), and `docs/mcp-tools.md` without duplicating them).

## Validation and CI

Local: `bun run build` (`rimraf dist && tsc`), `bun run check` (Biome), `bun run test` (`bun test` for [`src/repo-paths.test.ts`](src/repo-paths.test.ts)). GitHub Actions runs the same after `bun install --frozen-lockfile` on PRs and `main` ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), then uploads a **prerelease `npm pack` artifact**. Pushes of tag **`v*.*.*`** matching `package.json` `version` run [`.github/workflows/release.yml`](.github/workflows/release.yml) (**GitHub Packages** npm publish under **`@rethunk-ai/mcp-multi-root-git`** + **GitHub Release** with tarball); **npmjs** is manual only — see [HUMANS.md](HUMANS.md) Publishing.

Optional [`.githooks/`](.githooks): run **`bun run setup-hooks`** once per clone (`core.hooksPath` → `.githooks`). **pre-commit** = `check`; **pre-push** = frozen install + build + check. See [HUMANS.md](HUMANS.md) Development.

Path confinement helpers live in [`src/repo-paths.ts`](src/repo-paths.ts); extend tests when changing that logic.

## Repository MCP entry (contributors)

Dogfooding from a clone: **[docs/install.md](docs/install.md)** — *From source (this repository)* only.

This repo may ship **`.cursor/`** config (example MCP entry + **alwaysApply** rule [`.cursor/rules/rethunk-git-mcp.mdc`](.cursor/rules/rethunk-git-mcp.mdc)). The rule covers *when* to call these tools vs shell git and links **`docs/install.md`**, **[HUMANS.md](HUMANS.md)**, and **`docs/mcp-tools.md`** without duplicating their bodies; it does not re-link this file when it is already injected as project context.

User-level skills may still mention the GitHub **README** for discovery. Canonical references: **tools / JSON** — **[docs/mcp-tools.md](docs/mcp-tools.md)**; **install / client wiring** — **[docs/install.md](docs/install.md)** (link it; do not paste per-client JSON into skills); **preset file** — **[HUMANS.md](HUMANS.md)**.

## Commits

Use the team’s **conventional commits + batching** skill (or equivalent): small themed commits, why-focused messages, `git add` + `git commit` in one shell invocation per batch.
