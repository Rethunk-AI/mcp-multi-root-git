# Changelog

All notable changes to `@rethunk/mcp-multi-root-git` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com); the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- Regenerated **`tool-parameters.schema.json`** so `schema:tools:check` matches registered tools (CI).

## [2.3.4] — 2026-04-26

Publication-prep patch for the `absoluteGitRoots` line.

### Added

- **`tool-parameters.schema.json`** — generated JSON Schema snapshot for every registered tool parameter surface, plus `bun run schema:tools` / `bun run schema:tools:check`.
- **`git_parity` absolute-root regression coverage** — sibling clone batches are now covered directly.

### Fixed

- **CI coverage gate** now checks `% Lines` from Bun's coverage table instead of accidentally reading `% Funcs`.

### Documentation

- **`HUMANS.md`** — added sibling-clone `absoluteGitRoots` examples for `git_status` and `git_parity`.
- **`docs/mcp-tools.md`** — clarified direct `git_push` use for already-committed work and `git_parity` sibling-clone batches.

## [2.3.3] — 2026-04-21

### Added

- **`absoluteGitRoots`** on the workspace pick schema: pass absolute paths to many independent git clones in one MCP call for **`git_status`**, **`git_inventory`**, **`git_log`**, **`git_parity`**, **`git_diff_summary`** (single distinct toplevel only), and **`list_presets`**. Mutating tools omit this parameter from their Zod surface. See **`docs/mcp-tools.md`** (*Workspace root resolution*).

### Changed

- **`requireGitAndRoots`** / **`requireSingleRepo`**: new prelude **`resolveAbsoluteGitRootsList`** with dedupe, fail-fast on invalid paths, and mutual exclusion with `workspaceRoot` / `rootIndex` / `allWorkspaceRoots` / `preset` (and `nestedRoots`+`preset` guarded in **`git_inventory`**).

## [2.3.2] — 2026-04-21

### CI

- Coverage gate added: `bun run test:coverage` enforces an 80% line-coverage minimum in CI (`check` job).

### Documentation

- **`CONTRIBUTING.md`** — new file; consolidates dev setup, hook table, commit conventions, CI description, PR checklist, path-confinement guidance, and how-to-add-a-tool guidance for mutating tools.
- **`HUMANS.md`** — Development section replaced with a pointer to `CONTRIBUTING.md`; preset file, `git_not_found`, install reference, and publishing steps remain.
- **`AGENTS.md`** — corrected pre-push hook description (missing `test` step) and updated canonical-docs link for dev/CI content.
- **`.cursor/rules/rethunk-git-mcp.mdc`** — removed stale "shell is fine for `git diff` / `git cherry-pick`" examples; both now have MCP tool equivalents (`git_diff_summary`, `git_cherry_pick`).

## [2.3.1] — 2026-04-21

Documentation-only patch following the 2.3.0 release.

### Documentation

- **`README.md`** — one-liner description updated to include `git_log`, `git_push`, `git_worktree_*`, and `git_reset_soft`.
- **`HUMANS.md`** — opening line corrected from "Read-only MCP git tools" to "MCP git tools" (mutating operations have been present since v2.2.0).
- **`docs/mcp-tools.md`** — overview table expanded from 9 to 14 rows, adding all tools introduced in v2.3.0; **Read-only** / **Mutating** annotations added to every row consistently.

## [2.3.0] — 2026-04-21

Five new tools, a token-efficiency sweep, a targeted breaking change to the `git_log` JSON contract, and test coverage raised from 70% to 89%.

### Added

- **`git_push`** — push the current branch to its configured upstream. Accepts explicit `remote` / `branch` overrides and a `setUpstream: true` flag for first-push (`git push -u`). Refuses on detached HEAD; does not force-push.
- **`git_worktree_list`** — list all git worktrees (`git worktree list --porcelain`); annotated `readOnlyHint: true`.
- **`git_worktree_add`** — create a new linked worktree, creating the branch from `baseRef` if it does not yet exist. Refuses on protected branch names (`main`, `master`, `dev`, `release*`, `hotfix*`, …).
- **`git_worktree_remove`** — remove a registered worktree; refuses to remove the main worktree. Optional `force: true` for dirty trees.
- **`git_reset_soft`** — soft-reset the current branch to a ref (`HEAD~1`, `HEAD~N`, SHA, branch name). Preserves rewound changes in the staging index — the canonical way to re-split an already-committed chunk. Requires a clean working tree.

### Changed — breaking (`git_log` JSON, `MCP_JSON_FORMAT_VERSION` → `"3"`)

Consumers using `format: "json"` with `git_log` must update field names. All other tools are unaffected.

- `sha7` removed — was always derivable as `sha.slice(0, 7)`.
- `ageRelative` removed — was human-readable noise in machine output.
- `workspace_root` renamed to `workspaceRoot` — consistent camelCase with all other fields.
- `email` is now omitted when empty rather than always present.
- Error code `not_a_git_repo` corrected to `not_a_git_repository` — consistent with all other tools.

### Changed — non-breaking

- **Token efficiency:** `readOnlyHint: true` added to `git_status`, `git_inventory`, `git_parity`, and `list_presets`. "See docs/mcp-tools.md" suffix dropped from all 9 tool descriptions; descriptions are now self-contained.
- **`WorkspacePickSchema`** — `rootIndex` and `allWorkspaceRoots` parameters carry inline descriptions so LLMs can pick them without consulting external docs.
- **`git_merge`** — protected-branch list in the description collapsed to a single canonical reference (was duplicated inline).

### Internal

- `requireSingleRepo` helper extracted to `roots.ts`; replaces copy-paste preludes across `batch_commit`, `git_diff_summary`, `git_merge`, `git_cherry_pick`, `git_push`, `git_reset_soft`, and all `git_worktree_*`.
- `conflictPaths` extracted from `git-merge-tool.ts` to `git-refs.ts`; shared by `git_merge` and `git_cherry_pick`.
- `inferRemoteFromUpstream` extracted to `git-refs.ts`; shared by `runPushAfter` (`batch_commit`) and `git_push`.
- `isWorkingTreeClean` used consistently everywhere (was inlined in `git_reset_soft`).

### Tests

- Coverage: **88.6% lines / 92.8% functions** (up from 69.9% / 71.4%).
- 262 tests across 15 files (up from 134 across 7 files).
- New test files: `presets.test.ts`, `inventory.test.ts`, `git-utils.test.ts`, `json.test.ts`, `git-reset-soft-tool.test.ts`, `git-push-tool.test.ts`, `git-worktree-tool.test.ts`, `roots.test.ts`. `git-refs.test.ts` extended with `isSafeGitAncestorRef` cases.

### Documentation

- `docs/mcp-tools.md` — all new tools documented with parameter tables, JSON shapes, and error-code tables.
- `AGENTS.md` — implementation map updated with all new and refactored modules.

## [2.2.0] — 2026-04-17

Mutating git operations: merge, cherry-pick, and optional push-after for `batch_commit`.

### Added

- **`git_merge`** tool — merge one or more source branches into a destination. Default strategy `auto` cascades fast-forward → rebase → merge-commit per source, preferring linear history. Refuses on dirty tree; stops on first conflict with structured path report. Optional `deleteMergedBranches` / `deleteMergedWorktrees` cascade cleanup, always skipping protected names (`main`, `master`, `dev`, `develop`, `stable`, `trunk`, `prod`, `production`, `release*`, `hotfix*`).
- **`git_cherry_pick`** tool — play commits from one or more sources onto a destination. Sources may be SHAs, `A..B` ranges, or branch names (expanded to `onto..<branch>`, oldest-first). Uses `--empty=drop` so patch-equivalent re-applies add nothing. Refuses on dirty tree; stops on first conflict, aborting cleanly. Same protected-name cleanup flags as `git_merge`.
- **`batch_commit`** `push: "after"` — push the current branch to its upstream once every commit in the batch lands. Omitted by default; no behavior change for existing callers.

### Changed

- **Internal** — shared ref/branch helpers extracted to a common module; merge/cherry-pick/batch-commit implementations now reuse the same dirty-tree guards, protected-name checks, and upstream detection.
- **Tooling** — Biome upgraded to 2.4.11; dev dependency refresh.

### Documentation

- `docs/mcp-tools.md` — `git_merge` and `git_cherry_pick` sections with parameters, JSON shape, and error codes; `batch_commit` `push: "after"` option documented.

## [2.1.0] — prior

- Added `git_log` — path-filtered, time-windowed log across workspace roots.
- Added `git_diff_summary` — structured, token-efficient diff viewer with per-file truncation and default exclusions (lock files, `dist`, vendor).
- Added `batch_commit` — sequential multi-commit tool. Mutating, not idempotent.
- Test harness: fake-server duck-type lets unit tests drive the full FastMCP execute path without a live transport.

## [2.0.1] — prior

- Bug fixes and internal cleanup; no public tool-surface change.

## [2.0.0] — prior

- **Breaking:** JSON response envelope removed. `MCP_JSON_FORMAT_VERSION` now `"2"`; payloads are minified, and optional fields are omitted when empty / `null` / `false` (consumers test for presence, not equality to `null`).
- Initial preset file schema (`.rethunk/git-mcp-presets.json`) with wrapped and legacy-map layouts.

## [1.0.0] — prior

- Initial release: `git_status`, `git_inventory`, `git_parity`, `list_presets`.

[2.3.4]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.3.4
[2.3.3]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.3.3
[2.3.2]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.3.2
[2.3.1]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.3.1
[2.3.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.3.0
[2.2.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.2.0
[2.1.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.1.0
[2.0.1]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.0.1
[2.0.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.0.0
[1.0.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v1.0.0
