# Changelog

All notable changes to `@rethunk/mcp-multi-root-git` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com); the project uses [Semantic Versioning](https://semver.org).

## [2.6.0] — 2026-05-22

Security-hardening and correctness release surfaced by a full-repo critical review.

### Security

- **Argument-injection hardening** — `git_show`, `git_log`, and `git_fetch` passed caller-supplied ref/branch/remote values straight into git argv. A value beginning with `-` is parsed by git as an option (`--output=<path>` writes an arbitrary file; `--upload-pack=<cmd>` on fetch runs a command). These read tools now validate those tokens against the argv-safe subset before invoking git, returning `unsafe_ref_token`, `unsafe_remote_token`, or `path_escapes_repo` on rejection — the same gate already applied to the mutating tools.
- **`isProtectedBranch` normalization** — input is now normalized (trim, strip leading `refs/heads/`, lowercase) before matching, so `refs/heads/main`, `Main`, and `MAIN` are all recognized as protected. Previously the exact-name set was case-sensitive and a `refs/heads/` prefix evaded it entirely.

### Fixed

- **`batch_commit` linked worktrees** — hunk-level staging wrote its scratch patch under `${gitTop}/.git/`, which fails with `ENOTDIR` in a linked worktree (where `.git` is a file). The scratch path is now resolved via `git rev-parse --absolute-git-dir`, correct for both normal repos and worktrees.
- **`batch_commit` dry run** — preview cleanup ran an unconditional `git reset HEAD --` over every touched path, silently unstaging work the caller had staged before invoking. A pre-staged snapshot is now taken first; cleanup resets only paths the dry run itself staged.
- **`git_stash_list` index** — `index` was taken from the loop counter, so a malformed entry dropped by the parse guard shifted every later index and `git_stash_apply` could target the wrong stash. The index is now parsed from the canonical `stash@{N}` ref.
- **`git_diff_summary` rename parsing** — the new path of a rename whose path contained the substring ` b/` was mis-reported because the greedy `diff --git` header regex split at the wrong point; the authoritative `rename to` body line is now used.
- **`.gitmodules` parser** — `parseGitSubmodulePaths` matched any `path =` line regardless of INI section and ignored comments; it now tracks `[submodule]` sections and strips `;`/`#` comments.
- **`git_inventory` / `git_parity` v3 JSON** — `workspace_root` field corrected to `workspaceRoot` (camelCase), completing the v3 contract rename already applied to `git_log`.

### Changed

- **`git_tag` error codes renamed** — `tag_empty` → `empty_tag_name`, `tag_unsafe` → `unsafe_tag_token`, `ref_unsafe` → `unsafe_ref_token`; consistent with the server-wide naming convention.
- **`git_diff` multi-root parameters removed** — `absoluteGitRoots` and `allWorkspaceRoots` are no longer accepted by `git_diff`; it is now a pure single-repo tool (identical posture to `git_show`). Use `workspaceRoot` or `rootIndex` to select the target repo. `git_diff_summary` keeps single-entry `absoluteGitRoots` and drops only `allWorkspaceRoots`.
- **`MCP_JSON_FORMAT_VERSION` constant** — `"3"` is now an exported constant in `src/server.ts` and surfaced in the FastMCP `instructions` field, making the format version discoverable from the MCP `initialize` response.
- **CI** — the 20 published per-tool `schemas/*.json` artifacts are now drift-checked on every PR via a new `schema:individual:check` step; previously only `tool-parameters.schema.json` was gated.

## [2.5.0] — 2026-05-15

Bug-fix and documentation release; includes one new `git_log` output format.

### Added

- **`git_log` `format: "oneline"`** — minimal `<sha7> <subject>` output per commit for low-token post-commit verification. Multi-root output uses `### repo (branch)` separators; single-root output emits one line per commit with no headers.

### Fixed

- **`git_stash_list`**: format string used for-each-ref placeholders (`%(subject)`, `%(objectname:short)`) instead of git-log format (`%s`, `%h`), printing literal placeholder text as the stash message.
- **`git_stash_list`**: stash message containing `|` caused the SHA field to be parsed as a mid-message fragment; SHA is now always the last pipe-separated field.
- **`batch_commit`**: deleted tracked files (missing on disk) could not be staged; now staged via `git rm --cached`. Combining `{ path, lines }` with a deleted file is validated as an error.
- **`batch_commit` hunk-level staging**: `newCount=0` pure-deletion hunks were excluded from line ranges that included the deletion point (`hunkEnd` was `newStart-1`); now `hunkEnd = newStart` for zero-count hunks.
- **`git_diff_summary`**: diff header regex mis-parsed file paths containing ` b/` (e.g. `src/b/file.ts`), reporting wrong path and zero stats; now uses midpoint-symmetry split for non-renames, falls back to regex for renames.
- **`git_diff_summary`**: `git diff --stat` bar-graph character counting is scaled to terminal width and under-reports for large files; replaced with `git diff --numstat` for exact addition/deletion counts.
- **`git_cherry_pick`**: branch deletion after cherry-pick now uses patch-id equivalence by default so source branches with differing SHAs but identical content are correctly detected as merged. Pass `strictMergedRefEquality: true` for strict SHA-reachability semantics.
- **`parseGitSubmodulePaths`**: non-regular files at `.gitmodules` (character devices, sockets — common in Claude Code / sandbox environments) are now rejected via `lstatSync().isFile()` before `readFileSync`, preventing `EACCES` errors.

### Tests

- Integration tests added for `git_stash_list`, `git_stash_apply`, `git_fetch`, `git_status`, `git_inventory`, and `git_parity` execute paths.
- `isContentEquivalentlyMergedInto` integration tests via real git repos with cherry-picked and diverged histories.
- `batch_commit` dryRun tests covering deleted-file unstaging.

### Documentation

- **`git_status`, `git_inventory`, `git_parity`, `list_presets`** now have complete parameter tables, JSON shape examples, and error code tables in `docs/mcp-tools.md`.
- **`git_cherry_pick`** `strictMergedRefEquality` parameter added to docs; `deleteMergedBranches` description corrected (default is patch-id equivalence, not SHA-reachability).
- **`batch_commit`** `files` parameter and `stage_failed` error code updated to document deleted-file staging path.

## [2.4.0] — 2026-05-07

New git MCP tools, better `batch_commit` ergonomics, published schema coverage for the full tool surface, and a broad docs/test refresh since `v2.3.4`.

### Added

- **New tools:** `git_fetch`, `git_diff`, `git_show`, `git_tag`, `git_stash_list`, and `git_stash_apply`.
- **`batch_commit` enhancements:** `dryRun: true` preview mode plus hunk-level staging via `{ path, lines: { from, to } }`.
- **Published per-tool schema artifacts:** `schemas/index.json` plus one JSON Schema file per tool alongside `tool-parameters.schema.json`.

### Changed

- **`GIT_SUBPROCESS_PARALLELISM`** is now configurable via environment and clamps to a safe `2×CPU` maximum.
- **`git_show`**, **`git_fetch`**, and **`git_tag`** now use the standard single-repo workspace pick (`workspaceRoot` / `rootIndex`) and omit multi-root-only parameters.
- **Build / release tooling** now aligns on Bun `1.3.13`, updated dev dependencies, and the current prerelease tarball flow.

### Fixed

- **MCP roots** — workspace root collection now scans active MCP sessions and dedupes `file://` roots instead of relying on a fixed server `cwd`.
- **`git_push`** and **`batch_commit`** now surface raw git stdout/stderr on failure for easier recovery.
- **Published schema snapshots** are now complete and in sync with the registered tool surface, including `schema:tools:check`.
- **`publish:preflight`** now writes temporary coverage output under the platform temp directory instead of a hard-coded `/tmp` path.

### Documentation

- **README / HUMANS / AGENTS / CONTRIBUTING / install docs** refreshed for the current tool surface, shipped schema artifacts, and contributor workflow.
- **`SECURITY.md`** added with repository access, git-operation risk, and disclosure guidance.
- **`docs/mcp-tools.md`** now documents the full tool surface, `batch_commit` atomic staging semantics, and the shipped schema artifacts.
- **`TODO.md`** backlog entries now reflect genuine remaining gaps instead of listing already-implemented tools as missing.
- **`specs/` scaffold** added with standard `active`, `done`, and `parked` layout for repo planning.
- **CHANGELOG references** for `v2.3.2`–`v2.3.4` were restored.

### Tests

- Coverage expanded across `list_presets`, `git_parity`, `git_cherry_pick`, `git_merge`, `git_show`, schema generation, and roots handling.
- The shared git test harness now reuses repo-init / commit helpers and speeds up fixture setup.

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

[2.4.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.4.0
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
