# AGENTS.md — LLM + dev onboarding

IDEs injecting this as context: do not re-link from rules.

**Package:** [`@rethunk/mcp-multi-root-git`](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git). MCP **stdio** server. Entry [`src/server.ts`](src/server.ts) → FastMCP + `registerRethunkGitTools`. Build output [`dist/server.js`](dist/server.js) (publish ships full `dist/`).

**Canonical docs — do not duplicate:**
- Install + per-client wiring → [docs/install.md](docs/install.md)
- Tools, JSON shape, resources, root resolution → [docs/mcp-tools.md](docs/mcp-tools.md)
- Dev setup, CI, commit conventions → [CONTRIBUTING.md](CONTRIBUTING.md)
- Presets, auth, publish → [HUMANS.md](HUMANS.md)
- Spec layout for repo planning → [specs/README.md](specs/README.md)

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
| [`src/server/git-refs.ts`](src/server/git-refs.ts) | `isProtectedBranch`, `isSafeGitRefToken`, `isSafeGitRangeToken`, `isSafeGitAncestorRef`; `getCurrentBranch`, `resolveRef`, `isWorkingTreeClean`, `isFullyMergedInto`, `isContentEquivalentlyMergedInto`, `commitListBetween`; `listWorktrees`, `worktreeForBranch`; `inferRemoteFromUpstream`; `conflictPaths` |
| [`src/server/tools.ts`](src/server/tools.ts) | `registerRethunkGitTools` — dispatches to `register*` below |
| [`src/server/git-status-tool.ts`](src/server/git-status-tool.ts) | `git_status` |
| [`src/server/git-inventory-tool.ts`](src/server/git-inventory-tool.ts) | `git_inventory` |
| [`src/server/git-parity-tool.ts`](src/server/git-parity-tool.ts) | `git_parity` |
| [`src/server/list-presets-tool.ts`](src/server/list-presets-tool.ts) | `list_presets` |
| [`src/server/git-log-tool.ts`](src/server/git-log-tool.ts) | `git_log` — v3 JSON shape: `sha` (full), `workspaceRoot`, no `sha7`/`ageRelative`, optional `email` |
| [`src/server/git-diff-summary-tool.ts`](src/server/git-diff-summary-tool.ts) | `git_diff_summary` — structured token-efficient diff viewer; read-only |
| [`src/server/git-diff-tool.ts`](src/server/git-diff-tool.ts) | `git_diff` — raw scoped diff text; read-only |
| [`src/server/git-show-tool.ts`](src/server/git-show-tool.ts) | `git_show` — inspect commit message + diff or file content at a ref; read-only |
| [`src/server/git-stash-tool.ts`](src/server/git-stash-tool.ts) | `git_stash_list`, `git_stash_apply` |
| [`src/server/git-fetch-tool.ts`](src/server/git-fetch-tool.ts) | `git_fetch` — fetch remote refs without touching the working tree |
| [`src/server/git-tag-tool.ts`](src/server/git-tag-tool.ts) | `git_tag` — create/delete annotated or lightweight tags |
| [`src/server/git-worktree-tool.ts`](src/server/git-worktree-tool.ts) | `git_worktree_list`, `git_worktree_add`, `git_worktree_remove` |
| [`src/server/batch-commit-tool.ts`](src/server/batch-commit-tool.ts) | `batch_commit` — sequential multi-commit; mutating; exports `PushReport`, `runPushAfter` |
| [`src/server/git-push-tool.ts`](src/server/git-push-tool.ts) | `git_push` — standalone push with optional upstream tracking |
| [`src/server/git-merge-tool.ts`](src/server/git-merge-tool.ts) | `git_merge` — mutating |
| [`src/server/git-cherry-pick-tool.ts`](src/server/git-cherry-pick-tool.ts) | `git_cherry_pick` — mutating |
| [`src/server/git-reset-soft-tool.ts`](src/server/git-reset-soft-tool.ts) | `git_reset_soft` — soft-reset; mutating |
| [`src/server/presets-resource.ts`](src/server/presets-resource.ts) | `rethunk-git://presets` resource |
| [`src/server/tool-parameter-schemas.ts`](src/server/tool-parameter-schemas.ts) | `buildToolParameterSchemaDocument`, `captureToolParameterSchemas`; backs `tool-parameters.schema.json` and published `schemas/*.json` snapshots |
| [`src/repo-paths.ts`](src/repo-paths.ts) | `resolvePathForRepo`, `assertRelativePathUnderTop`, `isStrictlyUnderGitTop` |

## Changing contracts

- **No banner paragraphs** in shipped docs. Use normal titles + cross-links.
- **JSON format version** (currently `"3"`, exported as `MCP_JSON_FORMAT_VERSION` in `src/server.ts` and surfaced via the FastMCP `instructions` field — discoverable from the MCP `initialize` response): bump on incompatible JSON changes (renamed/nested/omitted fields). Document migration here + [docs/mcp-tools.md](docs/mcp-tools.md). v2 removed the `rethunkGitMcp` envelope; payloads are minified; optional fields omitted when empty/null/false. v3 changes in `git_log`: `sha7` → `sha` (full SHA), `workspace_root` → `workspaceRoot`, `ageRelative` removed, `email` omitted when empty.
- **Preset file:** keep `presets.ts` Zod schemas aligned with [`git-mcp-presets.schema.json`](git-mcp-presets.schema.json).
- **Public tool surface:** rename/add → update [docs/mcp-tools.md](docs/mcp-tools.md) + [README.md](README.md) (if mentioned), then regenerate the shipped schema artifacts (`tool-parameters.schema.json`, `schemas/index.json`, `schemas/*.json`). Install/client wiring → [docs/install.md](docs/install.md) only.

## Validate + CI

Local: `bun run build` | `bun run check` | `bun run schema:tools:check` | `bun run test`. CI ([`ci.yml`](.github/workflows/ci.yml)) runs same on PRs + `main` after `bun install --frozen-lockfile`, then `bun run test:coverage` + `bun run coverage:check`, and uploads prerelease `npm pack` artifact. Tag `v*.*.*` matching `package.json` version → [`release.yml`](.github/workflows/release.yml) publishes to GitHub Packages as `@rethunk-ai/mcp-multi-root-git` + cuts GitHub Release. npmjs publish is manual (see [HUMANS.md](HUMANS.md)).

Optional [`.githooks/`](.githooks): `bun run setup-hooks` once per clone. pre-commit=`check`; pre-push=frozen install + build + check + test.

Path confinement: [`src/repo-paths.ts`](src/repo-paths.ts) — extend tests when changing.

## AI constraints

Rules for LLMs operating in or against this repository.

**End-user Git/MCP preference** (status/log/diff/commits): **`~/.claude/CLAUDE.md`** § **Git & GitHub** — same policy when dogfooding this server from a harness.

**Mutating tools use `workspaceRoot` as trusted operator input** — `git_fetch`, `batch_commit`, `git_push`, `git_merge`, `git_cherry_pick`, `git_reset_soft`, `git_tag`, and `git_stash_apply` operate on roots resolved via `requireGitAndRoots` / `requireSingleRepo`. Pass the target repo as `workspaceRoot` (trusted caller input) or via MCP roots. The `absoluteGitRoots` bulk multi-root parameter is not accepted by mutating tools — passing it is rejected.

**`batch_commit` atomic staging — single call per logical change** — Do NOT attempt incremental staging across multiple `batch_commit` calls. Each call is self-contained: it stages all files in all entries, commits them sequentially, and the moment the call completes, all commits have landed. Include all related files (for all related commit entries) in a single `batch_commit` call. A call cannot be resumed or extended by a later call — each is an independent transaction. If entry N fails, entries before N remain committed; entries after N are skipped (not rolled back).

**`absoluteGitRoots` is read-only** — pass it only on read tools (`git_status`, `git_inventory`, `git_parity`, `git_log`, `git_diff_summary`, `list_presets`). Mutating tools reject this parameter.

**Protected branches are enforced by the server** — do not attempt `git_worktree_add` with a branch name matching `main`, `master`, `dev`, `develop`, `stable`, `trunk`, `prod`, `production`, `release*`, or `hotfix*`. The server rejects such calls.

**Never force-push** — `git_push` has no force-push mode by design. `git_merge` with `strategy: "ff-only"` will fail cleanly rather than force.

**Contract bumps need documentation** — if a JSON output shape changes incompatibly, bump the `MCP_JSON_FORMAT_VERSION` constant in `src/server.ts` (it is surfaced in the server `instructions` field and discoverable via MCP `initialize`) and document the migration in both this file and [docs/mcp-tools.md](docs/mcp-tools.md).

**Path confinement** — any tool accepting file paths must use `resolvePathForRepo` / `assertRelativePathUnderTop` from [`src/repo-paths.ts`](src/repo-paths.ts) and include escaping-attempt tests.

## Repo MCP entry (contributors)

Dogfood from clone: [docs/install.md](docs/install.md) — *From source*.

Client Git policy is still **`~/.claude/CLAUDE.md`** § Git & GitHub (see **End-user Git/MCP preference** above).

User-level skills may mention README for discovery. Canonical refs: tools/JSON → [docs/mcp-tools.md](docs/mcp-tools.md); install → [docs/install.md](docs/install.md); presets → [HUMANS.md](HUMANS.md).
