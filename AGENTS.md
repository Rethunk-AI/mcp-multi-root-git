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
| [`src/server/git.ts`](src/server/git.ts) | `gateGit`, `spawnGitAsync` (optional `{ timeoutMs, signal }`), `asyncPool`, `GIT_SUBPROCESS_PARALLELISM`, `GIT_SUBPROCESS_TIMEOUT_MS`, `gitTopLevel`, `gitRevParseGitDir`, `gitRevParseHead`, `parseGitSubmodulePaths`, `hasGitMetadata`, `gitStatusSnapshotAsync`, `gitStatusShortBranchAsync`, `fetchAheadBehind`, `isSafeGitUpstreamToken` |
| [`src/server/roots.ts`](src/server/roots.ts) | `requireGitAndRoots` (fan-out `root` resolution: string / string[] / `"*"`), `requireSingleRepo` (`workspaceRoot`), `resolveRootPathList`, `RootPickArgs` — shared tool preludes; session root resolution |
| [`src/server/presets.ts`](src/server/presets.ts) | `PRESET_FILE_PATH`, `loadPresetsFromGitTop`, `presetLoadErrorPayload`, `applyPresetNestedRoots`, `applyPresetParityPairs`; Zod schemas must match [`git-mcp-presets.schema.json`](git-mcp-presets.schema.json) |
| [`src/server/schemas.ts`](src/server/schemas.ts) | `WorkspacePickSchema` (single-repo: `workspaceRoot` + `format`), `RootPickSchema` (fan-out: polymorphic `root` + `format`), `MAX_INVENTORY_ROOTS_DEFAULT`, **`MAX_ROOT_PATHS`** (256) |
| [`src/server/inventory.ts`](src/server/inventory.ts) | `InventoryEntryJson`, `validateRepoPath`, `makeSkipEntry`, `buildInventorySectionMarkdown`, `collectInventoryEntry` |
| [`src/server/git-refs.ts`](src/server/git-refs.ts) | `isProtectedBranch`, `isSafeGitRefToken`, `isSafeGitRangeToken`, `isSafeGitAncestorRef`, `isSafeGitCommitIsh`; `getCurrentBranch`, `resolveRef`, `isWorkingTreeClean`, `isFullyMergedInto`, `isContentEquivalentlyMergedInto`, `commitListBetween`; `listWorktrees`, `worktreeForBranch`; `inferRemoteFromUpstream`; `conflictPaths` |
| [`src/server/error-codes.ts`](src/server/error-codes.ts) | `ERROR_CODES` (centralised error-code registry — the exact `error` field strings on the wire), `ErrorCode` type |
| [`src/server/tools.ts`](src/server/tools.ts) | `registerRethunkGitTools` — dispatches to `register*` below; `selectToolRegistrars(envValue, registrars)` — pure parse/filter fn for `RETHUNK_GIT_TOOLS` (reads env inside `registerRethunkGitTools`, not at module scope); `TOOL_REGISTRARS` ordered array |
| [`src/server/git-status-tool.ts`](src/server/git-status-tool.ts) | `git_status` |
| [`src/server/git-inventory-tool.ts`](src/server/git-inventory-tool.ts) | `git_inventory` |
| [`src/server/git-parity-tool.ts`](src/server/git-parity-tool.ts) | `git_parity` |
| [`src/server/list-presets-tool.ts`](src/server/list-presets-tool.ts) | `list_presets` |
| [`src/server/git-log-tool.ts`](src/server/git-log-tool.ts) | `git_log` — v3 JSON shape: `sha` (full), `workspaceRoot`, no `sha7`/`ageRelative`, optional `email` |
| [`src/server/git-grep-tool.ts`](src/server/git-grep-tool.ts) | `git_grep` — read-only fan-out content search (`git grep -n`); optional `ref` for tree-at-commit search, `filesOnly` for path-only listing |
| [`src/server/git-diff-summary-tool.ts`](src/server/git-diff-summary-tool.ts) | `git_diff_summary` — structured token-efficient diff viewer; read-only |
| [`src/server/git-diff-tool.ts`](src/server/git-diff-tool.ts) | `git_diff` — raw scoped diff text; read-only |
| [`src/server/git-show-tool.ts`](src/server/git-show-tool.ts) | `git_show` — inspect commit message + diff or file content at a ref; read-only |
| [`src/server/git-conflicts-tool.ts`](src/server/git-conflicts-tool.ts) | `git_conflicts` — inspect unresolved merge conflicts (state detection + per-file ours/theirs/base hunk parsing) |
| [`src/server/git-remote-tool.ts`](src/server/git-remote-tool.ts) | `git_remote` — list configured remotes; read-only |
| [`src/server/git-describe-tool.ts`](src/server/git-describe-tool.ts) | `git_describe` — nearest-tag description (tag/distance/sha); read-only |
| [`src/server/git-stash-tool.ts`](src/server/git-stash-tool.ts) | `git_stash_list`, `git_stash_apply`, `git_stash_push` |
| [`src/server/git-fetch-tool.ts`](src/server/git-fetch-tool.ts) | `git_fetch` — fetch remote refs without touching the working tree |
| [`src/server/git-blame-tool.ts`](src/server/git-blame-tool.ts) | `git_blame` — file authorship, run-length grouped by contiguous same-commit line runs; read-only |
| [`src/server/git-branch-list-tool.ts`](src/server/git-branch-list-tool.ts) | `git_branch_list` — list local (and optionally remote-tracking) branches; read-only |
| [`src/server/git-reflog-tool.ts`](src/server/git-reflog-tool.ts) | `git_reflog` — show the reflog for a ref; read-only |
| [`src/server/git-tag-tool.ts`](src/server/git-tag-tool.ts) | `git_tag` — create/delete annotated or lightweight tags |
| [`src/server/git-branch-tool.ts`](src/server/git-branch-tool.ts) | `git_branch` — create/delete/rename local branches; protected-name checks on every action |
| [`src/server/git-worktree-tool.ts`](src/server/git-worktree-tool.ts) | `git_worktree_list`, `git_worktree_add`, `git_worktree_remove` |
| [`src/server/batch-commit-tool.ts`](src/server/batch-commit-tool.ts) | `batch_commit` — sequential multi-commit; mutating; exports `PushReport`, `runPushAfter` |
| [`src/server/git-push-tool.ts`](src/server/git-push-tool.ts) | `git_push` — standalone push with optional upstream tracking |
| [`src/server/git-merge-tool.ts`](src/server/git-merge-tool.ts) | `git_merge` — mutating |
| [`src/server/git-cherry-pick-tool.ts`](src/server/git-cherry-pick-tool.ts) | `git_cherry_pick` — mutating |
| [`src/server/git-reset-soft-tool.ts`](src/server/git-reset-soft-tool.ts) | `git_reset_soft` — soft-reset; mutating |
| [`src/server/git-revert-tool.ts`](src/server/git-revert-tool.ts) | `git_revert` — inverse-commit revert; mutating, non-history-rewriting |
| [`src/server/presets-resource.ts`](src/server/presets-resource.ts) | `rethunk-git://presets` resource |
| [`src/server/tool-parameter-schemas.ts`](src/server/tool-parameter-schemas.ts) | `buildToolParameterSchemaDocument`, `captureToolParameterSchemas`; backs `tool-parameters.schema.json` and published `schemas/*.json` snapshots |
| [`src/repo-paths.ts`](src/repo-paths.ts) | `resolvePathForRepo`, `assertRelativePathUnderTop`, `isStrictlyUnderGitTop` |

## Changing contracts

- **No banner paragraphs** in shipped docs. Use normal titles + cross-links.
- **JSON format version** (currently `"5"`, exported as `MCP_JSON_FORMAT_VERSION` in `src/server.ts` and surfaced via the FastMCP `instructions` field — discoverable from the MCP `initialize` response): bump on incompatible JSON changes (renamed/nested/omitted fields). Document migration here + [docs/mcp-tools.md](docs/mcp-tools.md). v2 removed the `rethunkGitMcp` envelope; payloads are minified; optional fields omitted when empty/null/false. v3 changes in `git_log`: `sha7` → `sha` (full SHA), `workspace_root` → `workspaceRoot`, `ageRelative` removed, `email` omitted when empty. v4 changes: `git_blame` output run-length grouped (`lines[]` → `groups[]`, commit metadata once per contiguous run, `maxLines` cap with `truncated`/`omittedLines`); `git_diff_summary` per-file `truncated` omitted when false. v5 changes: `batch_commit` successful `results[*]` entries drop the echoed `message`/`files` (the caller already supplied both) — failing entries still carry them for diagnosis.
- **Preset file:** keep `presets.ts` Zod schemas aligned with [`git-mcp-presets.schema.json`](git-mcp-presets.schema.json).
- **Public tool surface:** rename/add → update [docs/mcp-tools.md](docs/mcp-tools.md) + [README.md](README.md) (if mentioned), then regenerate the shipped schema artifacts (`tool-parameters.schema.json`, `schemas/index.json`, `schemas/*.json`). Install/client wiring → [docs/install.md](docs/install.md) only.

## Validate + CI

Local: `bun run build` | `bun run lint` | `bun run schema:tools:check` | `bun run test`. CI ([`ci.yml`](.github/workflows/ci.yml)) runs same on PRs + `main` after `bun install --frozen-lockfile`, then `bun run test:coverage` + `bun run coverage:check`, and uploads prerelease `npm pack` artifact. Tag `v*.*.*` matching `package.json` version → [`release.yml`](.github/workflows/release.yml) publishes to GitHub Packages as `@rethunk-ai/mcp-multi-root-git` + cuts GitHub Release. npmjs publish is manual (see [HUMANS.md](HUMANS.md)).

Optional [`.githooks/`](.githooks): `bun run setup-hooks` once per clone. pre-commit=`check`; pre-push=frozen install + build + check + test.

Path confinement: [`src/repo-paths.ts`](src/repo-paths.ts) — extend tests when changing.

## AI constraints

Rules for LLMs operating in or against this repository.

**End-user Git/MCP preference** (status/log/diff/commits): **`~/.claude/CLAUDE.md`** § **Git & GitHub** — same policy when dogfooding this server from a harness.

**One routing param per tool** — the six fan-out read tools (`git_status`, `git_inventory`, `git_parity`, `list_presets`, `git_log`, `git_grep`) take polymorphic **`root`** (string = one repo, string[] = explicit repo list, `"*"` = every MCP root). Every other tool — including all mutating tools (`git_fetch`, `batch_commit`, `git_push`, `git_merge`, `git_cherry_pick`, `git_reset_soft`, `git_revert`, `git_tag`, `git_branch`, `git_stash_apply`, `git_stash_push`, worktree add/remove) — takes only **`workspaceRoot`** (trusted operator input) and resolves via `requireSingleRepo`; multi-repo routing params are not accepted on writes.

**`batch_commit` atomic staging — single call per logical change** — Do NOT attempt incremental staging across multiple `batch_commit` calls. Each call is self-contained: it stages all files in all entries, commits them sequentially, and the moment the call completes, all commits have landed. Include all related files (for all related commit entries) in a single `batch_commit` call. A call cannot be resumed or extended by a later call — each is an independent transaction. If entry N fails, entries before N remain committed; entries after N are skipped (not rolled back).

**Protected branches are enforced by the server** — do not attempt `git_worktree_add` or `git_branch` (create/delete/rename, in any role) with a branch name matching `main`, `master`, `dev`, `develop`, `stable`, `trunk`, `prod`, `production`, `release*`, or `hotfix*`. The server rejects such calls.

**Never force-push** — `git_push` has no force-push mode by design. `git_merge` with `strategy: "ff-only"` will fail cleanly rather than force.

**Contract bumps need documentation** — if a JSON output shape changes incompatibly, bump the `MCP_JSON_FORMAT_VERSION` constant in `src/server.ts` (it is surfaced in the server `instructions` field and discoverable via MCP `initialize`) and document the migration in both this file and [docs/mcp-tools.md](docs/mcp-tools.md).

**Path confinement** — any tool accepting file paths must use `resolvePathForRepo` / `assertRelativePathUnderTop` from [`src/repo-paths.ts`](src/repo-paths.ts) and include escaping-attempt tests.

## Repo MCP entry (contributors)

Dogfood from clone: [docs/install.md](docs/install.md) — *From source*.

Client Git policy is still **`~/.claude/CLAUDE.md`** § Git & GitHub (see **End-user Git/MCP preference** above).

User-level skills may mention README for discovery. Canonical refs: tools/JSON → [docs/mcp-tools.md](docs/mcp-tools.md); install → [docs/install.md](docs/install.md); presets → [HUMANS.md](HUMANS.md).
