# AGENTS.md — LLM + dev onboarding

IDEs injecting this as context: do not re-link from rules.

**Package:** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git). MCP **stdio** server. Entry [`src/server.ts`](src/server.ts) → FastMCP + `registerRethunkGitTools`. Build output [`dist/server.js`](dist/server.js) (publish ships full `dist/`).

**Canonical docs — do not duplicate:**
- Install + per-client wiring → [docs/install.md](docs/install.md)
- Tools, JSON shape, resources, root resolution → [docs/mcp-tools.md](docs/mcp-tools.md)
- Dev setup, CI, commit conventions → [CONTRIBUTING.md](CONTRIBUTING.md)
- Presets, auth, publish → [HUMANS.md](HUMANS.md)

## Implementation map

| File | Symbols |
|------|---------|
| [`src/server.ts`](src/server.ts) | `FastMCP` + `roots: { enabled: true }`; `readMcpServerVersion()`; `registerRethunkGitTools` |
| [`src/server/json.ts`](src/server/json.ts) | `jsonRespond()` (minified, no envelope), `spreadWhen`, `spreadDefined` |
| [`src/server/git.ts`](src/server/git.ts) | `gateGit`, `spawnGitAsync`, `asyncPool`, `GIT_SUBPROCESS_PARALLELISM`, `gitTopLevel`, `gitRevParseGitDir`, `gitRevParseHead`, `parseGitSubmodulePaths`, `hasGitMetadata`, `gitStatusSnapshotAsync`, `gitStatusShortBranchAsync`, `fetchAheadBehind`, `isSafeGitUpstreamToken` |
| [`src/server/roots.ts`](src/server/roots.ts) | `requireGitAndRoots`, `requireSingleRepo`, `resolveAbsoluteGitRootsList`, `GitRootPickArgs` — shared tool preludes; session root resolution; optional `absoluteGitRoots` bulk pick |
| [`src/server/presets.ts`](src/server/presets.ts) | `PRESET_FILE_PATH`, `loadPresetsFromGitTop`, `presetLoadErrorPayload`, `applyPresetNestedRoots`, `applyPresetParityPairs`; Zod schemas must match [`git-mcp-presets.schema.json`](git-mcp-presets.schema.json) |
| [`src/server/schemas.ts`](src/server/schemas.ts) | `WorkspacePickSchema`, `MAX_INVENTORY_ROOTS_DEFAULT`, **`MAX_ABSOLUTE_GIT_ROOTS`** (256), optional **`absoluteGitRoots`** on workspace pick |
| [`src/server/inventory.ts`](src/server/inventory.ts) | `InventoryEntryJson`, `validateRepoPath`, `makeSkipEntry`, `buildInventorySectionMarkdown`, `collectInventoryEntry` |
| [`src/server/git-refs.ts`](src/server/git-refs.ts) | `isProtectedBranch`, `isSafeGitRefToken`, `isSafeGitRangeToken`, `isSafeGitAncestorRef`; `getCurrentBranch`, `resolveRef`, `isWorkingTreeClean`, `isFullyMergedInto`, `commitListBetween`; `listWorktrees`, `worktreeForBranch`; `conflictPaths` |
| [`src/server/tools.ts`](src/server/tools.ts) | `registerRethunkGitTools` — dispatches to `register*` below |
| [`src/server/git-status-tool.ts`](src/server/git-status-tool.ts) | `git_status` |
| [`src/server/git-inventory-tool.ts`](src/server/git-inventory-tool.ts) | `git_inventory` |
| [`src/server/git-parity-tool.ts`](src/server/git-parity-tool.ts) | `git_parity` |
| [`src/server/list-presets-tool.ts`](src/server/list-presets-tool.ts) | `list_presets` |
| [`src/server/git-log-tool.ts`](src/server/git-log-tool.ts) | `git_log` — v3 JSON shape: `sha` (full), `workspaceRoot`, no `sha7`/`ageRelative`, optional `email` |
| [`src/server/git-diff-summary-tool.ts`](src/server/git-diff-summary-tool.ts) | `git_diff_summary` — structured token-efficient diff viewer; read-only |
| [`src/server/git-worktree-tool.ts`](src/server/git-worktree-tool.ts) | `git_worktree_list`, `git_worktree_add`, `git_worktree_remove` |
| [`src/server/batch-commit-tool.ts`](src/server/batch-commit-tool.ts) | `batch_commit` — sequential multi-commit; mutating; exports `PushReport`, `runPushAfter` |
| [`src/server/git-push-tool.ts`](src/server/git-push-tool.ts) | `git_push` — standalone push with optional upstream tracking |
| [`src/server/git-merge-tool.ts`](src/server/git-merge-tool.ts) | `git_merge` — mutating |
| [`src/server/git-cherry-pick-tool.ts`](src/server/git-cherry-pick-tool.ts) | `git_cherry_pick` — mutating |
| [`src/server/git-reset-soft-tool.ts`](src/server/git-reset-soft-tool.ts) | `git_reset_soft` — soft-reset; mutating |
| [`src/server/presets-resource.ts`](src/server/presets-resource.ts) | `rethunk-git://presets` resource |
| [`src/server/tool-parameter-schemas.ts`](src/server/tool-parameter-schemas.ts) | `buildToolParameterSchemaDocument`, `captureToolParameterSchemas`; backs `tool-parameters.schema.json` |
| [`src/repo-paths.ts`](src/repo-paths.ts) | `resolvePathForRepo`, `assertRelativePathUnderTop`, `isStrictlyUnderGitTop` |

## Changing contracts

- **No banner paragraphs** in shipped docs. Use normal titles + cross-links.
- **JSON format version** (currently `"3"`, discoverable via MCP `initialize`): bump on incompatible JSON changes (renamed/nested/omitted fields). Document migration here + [docs/mcp-tools.md](docs/mcp-tools.md). v2 removed the `rethunkGitMcp` envelope; payloads are minified; optional fields omitted when empty/null/false. v3 changes in `git_log`: `sha7` → `sha` (full SHA), `workspace_root` → `workspaceRoot`, `ageRelative` removed, `email` omitted when empty.
- **Preset file:** keep `presets.ts` Zod schemas aligned with [`git-mcp-presets.schema.json`](git-mcp-presets.schema.json).
- **Public tool surface:** rename/add → update [docs/mcp-tools.md](docs/mcp-tools.md) + [README.md](README.md) (if mentioned). Install/client wiring → [docs/install.md](docs/install.md) only. `.cursor/rules/rethunk-git-mcp.mdc` → only when *MCP-vs-shell* guidance changes.

## Validate + CI

Local: `bun run build` | `bun run check` | `bun run schema:tools:check` | `bun run test`. CI ([`ci.yml`](.github/workflows/ci.yml)) runs same on PRs + `main` after `bun install --frozen-lockfile`, then `bun run test:coverage` + `bun run coverage:check`, and uploads prerelease `npm pack` artifact. Tag `v*.*.*` matching `package.json` version → [`release.yml`](.github/workflows/release.yml) publishes to GitHub Packages as `@rethunk-ai/mcp-multi-root-git` + cuts GitHub Release. npmjs publish is manual (see [HUMANS.md](HUMANS.md)).

Optional [`.githooks/`](.githooks): `bun run setup-hooks` once per clone. pre-commit=`check`; pre-push=frozen install + build + check + test.

Path confinement: [`src/repo-paths.ts`](src/repo-paths.ts) — extend tests when changing.

## AI constraints

Rules for LLMs operating in or against this repository.

**Prefer MCP tools over shell git** — use `rethunk-git_git_status`, `rethunk-git_git_log`, `rethunk-git_git_diff_summary`, etc. instead of shelling out to `git status`, `git log`, `git diff`. Shell git is acceptable only for operations the MCP tools do not cover (`git fetch`, `git stash`, `git rebase`) or when the MCP connection is unavailable.

**Mutating tools require workspace-root confirmation** — `batch_commit`, `git_push`, `git_merge`, `git_cherry_pick`, `git_reset_soft` operate only on roots confirmed by `requireGitAndRoots` / `requireSingleRepo`. Never pass caller-supplied absolute paths to mutating tools; use `workspaceRoot` or MCP roots.

**`absoluteGitRoots` is read-only** — pass it only on read tools (`git_status`, `git_inventory`, `git_parity`, `git_log`, `git_diff_summary`, `list_presets`). Mutating tools reject this parameter.

**Protected branches are enforced by the server** — do not attempt `git_worktree_add` with a branch name matching `main`, `master`, `dev`, `develop`, `stable`, `trunk`, `prod`, `production`, `release*`, or `hotfix*`. The server rejects such calls.

**Never force-push** — `git_push` has no force-push mode by design. `git_merge` with `strategy: "ff-only"` will fail cleanly rather than force.

**Contract bumps need documentation** — if a JSON output shape changes incompatibly, bump `MCP_JSON_FORMAT_VERSION` in `src/server.ts` and document the migration in both this file and [docs/mcp-tools.md](docs/mcp-tools.md).

**Path confinement** — any tool accepting file paths must use `resolvePathForRepo` / `assertRelativePathUnderTop` from [`src/repo-paths.ts`](src/repo-paths.ts) and include escaping-attempt tests.

Cursor rule covering MCP-vs-shell selection: [`.cursor/rules/rethunk-git-mcp.mdc`](.cursor/rules/rethunk-git-mcp.mdc) (injected automatically via `alwaysApply: true`).

## Repo MCP entry (contributors)

Dogfood from clone: [docs/install.md](docs/install.md) — *From source*.

Repo ships `.cursor/` with alwaysApply rule [`.cursor/rules/rethunk-git-mcp.mdc`](.cursor/rules/rethunk-git-mcp.mdc) covering MCP-vs-shell usage. Rule does not re-link this file (already injected).

User-level skills may mention README for discovery. Canonical refs: tools/JSON → [docs/mcp-tools.md](docs/mcp-tools.md); install → [docs/install.md](docs/install.md); presets → [HUMANS.md](HUMANS.md).
