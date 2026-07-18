# Changelog

All notable changes to `@rethunk/mcp-multi-root-git` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com); the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

Additive JSON / behavior only — `MCP_JSON_FORMAT_VERSION` stays at `"5"`.

### Added

- **`RETHUNK_GIT_TOOLS=*`** — bare `*` is now an all-tools sentinel (registers every tool) instead of an unrecognized name that emptied the allowlist.
- **`git_grep` `pickaxe`** — optional `{ mode: "S"|"G", term }` history search (`git log -S`/`-G`) returning `commits[]` per root; `pattern` optional when pickaxe is set (`pattern_or_pickaxe_required` when neither is provided).
- **`git_log` `follow`** — optional rename-aware history (`git log --follow`); requires exactly one `paths` entry else `invalid_paths`.
- **`git_inventory` `compareRefs`** — optional `{ left, right }` ahead/behind between arbitrary local refs (independent of upstream); bad tokens → `unsafe_ref_token`.
- **`git_diff` `maxBytes`** — optional UTF-8 byte cap on returned diff text (default `512000`, range 1024–10000000); oversized output sets `truncated: true`.
- **Subprocess bounds** — `spawnGitAsync` stdout/stderr capped (default 16 MiB, `GIT_SUBPROCESS_MAX_BUFFER_BYTES`); overflow kills the child and returns `truncated: true`. Hung children escalate SIGTERM → SIGKILL after 2s. Sync helpers gain `GIT_SYNC_TIMEOUT_MS` (30s).
- **`stash_apply_failed`** — registered in the central error-code registry and emitted on failed stash apply/pop.

### Changed

- **CI** — `ci.yml` check job runs `bun run ci` so workflow gates stay aligned with the local script (including coverage `pipefail` and schema checks).
- **CI** — workflow Bun pin aligned to `packageManager` **1.3.14**; GitHub Actions third-party action pins bumped (`5fa33af`).
- **Release** — tag publish workflow no longer duplicates build or test after `bun run ci`; verifies a `CHANGELOG.md` section exists for the tagged version before publish.
- **Release / CI pack** — workflows use `npm pack --ignore-scripts` and `npm publish --ignore-scripts` so `prepublishOnly` does not re-run the full CI suite.
- **Publish preflight** — coverage threshold checks delegate to `bun run coverage:check` instead of duplicating parser logic.
- **Schema artifacts** — capture now drives `registerRethunkGitTools` (same path as the live server) instead of a parallel `register*` list, so published parameter schemas cannot silently omit a newly added tool; `schema:individual` / `--check` hard-fails on missing capture schemas and rejects orphan `schemas/*.json` files left after renames/removals.
- **`root: "*"` fan-out** — capped at `MAX_ROOT_PATHS` (256); oversize sessions return `{ error: root_list_too_many, max, count }` like explicit root arrays. `RootPickSchema` no longer Zod-`.max`s the array (execute-path structured error instead of FastMCP `too_big`).
- **Docs** — align `docs/mcp-tools.md` with wire contracts: fan-out feature params (`pickaxe` / `follow` / `compareRefs`), `git_diff` `maxBytes`, merge/cherry-pick abort-failure codes, stash apply `conflictPaths` + `destructiveHint`, worktree path argv safety, `batch_commit` index isolation, and related error-table cleanups (`MCP_JSON_FORMAT_VERSION` unchanged).
- **`SECURITY.md`** — refresh threat model to the full 30-tool surface (read + mutate), including previously omitted mutators; disclose trusted-operator `workspaceRoot` / explicit `root` paths (no MCP-session whitelist this release); document shipped controls (realpath confinement, protected-branch enforcement, no force-push, argv-array spawn + ref validators); correct aspirational claims; add `RETHUNK_GIT_TOOLS` hardening, read-tool content-exfil risk, and soft-reset vs revert rewrite matrix.
- **`git_stash_apply`** — on failure emits `error: stash_apply_failed` plus optional `conflictPaths`; sets `destructiveHint: true` (pop can delete a stash entry).
- **`git_merge` / `git_cherry_pick`** — abort helpers surface `--abort` failure (`merge_abort_failed` / `rebase_abort_failed` / `cherry_pick_abort_failed`) instead of claiming a cleaned tree when abort itself failed. `git_cherry_pick` hard-caps expanded picks at 100 (`cherry_pick_too_many_commits`). `git_merge` `auto`/`rebase` rewrite the **source** branch tip when rebasing (documented; behavior unchanged). `deleteMergedWorktrees` skips protected **source branch names**.
- **`git_diff_summary`** — `totalFiles` / `totalAdditions` / `totalDeletions` count the post-filter set; `excludedFiles` includes exclude-pattern hits and `fileFilter` drops; `truncatedFiles` is the `maxFiles` omit count.
- **`git_show`** — `git_show_failed` includes `detail` (stderr/stdout trim).
- **`git_tag`** — tag names use `isSafeGitRefToken`; create `ref` uses `isSafeGitCommitIsh`; tool description is create/delete only.

### Fixed

- **Path confinement** — fail closed when `realpath` cannot resolve a path used for repo bounds checks (no ENOENT false-accept via intermediate symlinks outside the git toplevel); missing leaves under a symlink alias of the same toplevel still resolve correctly for deletion staging.
- **`isSafeGitAncestorRef`** — now delegates to `isSafeGitCommitIsh`, rejecting `..` ranges, `.lock` suffixes, `//`, trailing `/`/`.`, mid-name `~`/`^`, and leading `+` (previously accepted by a looser charset-only check).
- **`isSafeGitRefToken`** — rejects leading `+` (git force-update refspec); closes force-push/fetch via `branch=+name` when callers use this validator.
- **`listWorktrees`** — returns `{ ok:false, detail }` on git failure instead of an empty array.
- **`batch_commit` index isolation** — unrelated pre-staged paths are temporarily unstaged around an index-based `git commit` (avoids pathspec/`--only`, which would squash hunk staging); mid-entry `stage_failed` unstages that entry's paths; dryRun restores the pre-call index via `write-tree`/`read-tree`; rejects `.` / repo-root / directory pathspecs (`invalid_paths`); line-range staging uses `git diff --` / `--no-index` for untracked and rejects `from > to` (`invalid_line_range`).
- **`git_log` path confinement** — each `paths` entry gated with `resolvePathForRepo` / `assertRelativePathUnderTop`; escaping paths yield `path_escapes_repo` per root.
- **`git_parity` / `git_inventory` non-git wording** — `pairs[*].error` and inventory `skipReason` use plain description strings (no nested minified JSON).
- **`git_diff` / `git_diff_summary` / `git_conflicts`** — honor docs precedence (`base` over `staged`; ignore `head` without `base`); emit bare `unsafe_range_token`; fix rename numstat counts; report `path_escapes_repo` on escaped conflict paths; flag incomplete conflict markers as `truncated`.
- **`git_push` / `git_fetch`** — reject leading `+` force-update refspecs on branch args.
- **`git_worktree_add` / `git_worktree_remove`** — reject leading-dash and NUL paths; pass path after `--`; trim `branch`/`baseRef` before spawn; sibling worktrees outside toplevel remain allowed.

## [3.2.0] — 2026-07-10

Feature release: seven new tools (23 → 30 registered; content search, conflict inspection, remote/describe read access, branch lifecycle, revert, and stash push), plus argv-safety and range-validation fixes across the diff/blame/show/diff-summary family. The **`root`** fan-out routing param now applies to **six** read tools (see 3.0.0 migration — `git_grep` joins `git_status`, `git_inventory`, `git_parity`, `list_presets`, and `git_log`). Additive JSON changes only — `MCP_JSON_FORMAT_VERSION` stays at `"5"`.

### Added

- **`git_grep`** — read-only fan-out content search (`git grep -n -e <pattern>`) across one or more roots. Optional `ref` searches the tree at a commit/branch instead of the working tree; `paths` scopes the search (confined to the repo root); `ignoreCase`/`filesOnly`/`maxMatches` tune output. A clean "no matches" `git grep` exit is treated as success with an empty result set, not an error. Pickaxe/history content search (`-S`/`-G`) is out of scope.
- `git_conflicts` — read-only inspection of unresolved merge conflicts after `git_merge`/`git_cherry_pick` reports them: detects the in-progress operation (merge/cherry-pick/revert/rebase) and parses each conflicted file's `<<<<<<</|||||||/=======/>>>>>>>` markers into structured ours/theirs/base hunks with line numbers and branch labels, so an agent can resolve conflicts without a raw file read. `withHunks`/`maxLinesPerFile` control cost.
- `git_remote` — list configured git remotes (`git remote -v`), returning name/fetchUrl/pushUrl (pushUrl omitted when identical to fetchUrl).
- `git_describe` — describe a commit relative to the nearest reachable tag (`git describe --long`), returning parsed tag/distance/sha.
- `git_branch` — create, delete, or rename a local branch (`action: "create"|"delete"|"rename"`), with protected-branch rejection on every action (source, target, and rename endpoints) and `force` for `-D` deletes of unmerged branches.
- `git_revert` — creates new commit(s) that undo one or more source commits (`git revert`), applied in listed order; never rewrites history, unlike `git_reset_soft`. Refuses on a dirty tree; on conflict aborts and leaves the tree clean, reporting structured conflict paths. `noCommit` stages the revert(s) without committing; `mainline` selects the parent when reverting a merge commit.
- **`git_stash_push`** — stash working-tree changes (`git stash push`). Optional `message`, `includeUntracked` (-u), `keepIndex` (--keep-index), and `paths` to scope the stash. Returns the new stash ref/SHA/subject, or `{ stashed: false, reason: "no_local_changes" }` when there is nothing to stash.

### Changed

- PR CI (`ci.yml`) now runs each gate exactly once (build/lint/typecheck/schema-check/test were previously duplicated between `bun run ci` and separate CI steps); the local `ci` script gained the `schema:individual:check` step CI already ran, so the two stay in sync. The tag release workflow (`release.yml`) still duplicated build and tests until the fixes documented under `[Unreleased]`.
- `git_fetch` moved from the read-only registrar group to the head of the mutating group (it updates refs) — the registration order now matches `tool-parameter-schemas.ts` and the docs table, which already classified it as mutating.
- Added test coverage for `presets-resource.ts`'s `rethunk-git://presets` resource load handler (valid preset, invalid JSON, missing file) — it previously had none.

### Fixed

- **`git_diff`/`git_blame`/`git_show`** — `base`/`head`/`ref` now accept ancestor notation (`HEAD~3`, `main^2`, `v1.0.0~2^1`) consistently across all three tools via a shared `isSafeGitCommitIsh` validator. Previously `git_diff` and `git_blame` rejected the documented `HEAD~3` example outright; `git_show` accepted ancestor notation but via a looser validator that lacked the `..`/`.lock`/`//`/`@{` guards the other tools had (now hardened to match).
- **`git_diff_summary`/`git_cherry_pick` range endpoints** — `isSafeGitRangeToken` validated each side of an `A..B`/`A...B` range with the base ref-token check (no `~`/`^` support), so `git_diff_summary`'s own documented example `"HEAD~3..HEAD"` was rejected with `unsafe_range_token`. Endpoints (and the no-range single-ref fallthrough) now validate with `isSafeGitCommitIsh`; `git_diff_summary` also dropped its separate ad hoc range-parsing regex in favor of the shared validator.
- `git_fetch` — corrected a stale comment describing the non-porcelain fallback path as pending work; no behavior change.

## [3.1.0] — 2026-07-04

Token-cost reduction in `batch_commit` output. JSON format version bumped **4 → 5**.

### Changed — breaking

- **`batch_commit` success entries drop echoed `message`/`files`.** Every entry in the JSON `results[]` array repeated the caller's own `message` and full `files[]` from the request, even on success — pure repetition, since the caller already has both. Successful entries now carry only `index`, `ok`, `sha` (or `staged`/`diffStat` in dry-run mode), and `output` when present. Failing entries are unchanged: `message`/`files` stay so the caller can identify the failed commit without cross-referencing the request. `MCP_JSON_FORMAT_VERSION` bumped to `"5"`.

## [3.0.0] — 2026-07-03

Major release: token-cost reduction across the tool surface. Every tool now carries exactly one routing parameter, `git_blame` output is run-length grouped, and integer bounds are explicit. JSON format version bumped **3 → 4**.

### Changed — breaking

- **Routing-param consolidation.** The four overlapping routing params (`workspaceRoot`, `rootIndex`, `allWorkspaceRoots`, `absoluteGitRoots`) are replaced by exactly one param per tool. The five fan-out read tools (`git_status`, `git_inventory`, `git_parity`, `list_presets`, `git_log`) take polymorphic **`root`**: a string (one repo path), a string array (explicit repo list — the old `absoluteGitRoots`), or `"*"` (every MCP root — the old `allWorkspaceRoots`). All other 18 tools take only **`workspaceRoot`** (`git_diff_summary` loses `absoluteGitRoots`). Defaults are unchanged: first MCP root, else `process.cwd()`.
- **`rootIndex` removed fleet-wide.** It was vestigial (no real consumer); the `root_index_out_of_range` error code is gone with it.
- **Root-validation error codes renamed.** `invalid_absolute_git_root` → `invalid_root_path`; `absolute_git_roots_empty` / `_too_many` / `_preset_conflict` / `_nested_or_preset_conflict` → `root_list_empty` / `root_list_too_many` / `root_list_preset_conflict` / `root_list_nested_or_preset_conflict`. `absolute_git_roots_exclusive` and `absolute_git_roots_single_repo_only` are removed — with a single routing param those states are unrepresentable.
- **`git_blame` output v4: run-length grouped.** JSON shape changed from `lines[]` (sha/author/date/summary repeated on every line) to `groups[]` — one entry per contiguous same-commit run carrying `sha`/`author`/`date`/`summary`/`startLine`/`endLine` once, plus `lines: [{ line, content }]`. Markdown output grouped the same way. `MCP_JSON_FORMAT_VERSION` bumped to `"4"`.
- **`git_diff_summary` per-file `truncated` omitted when false** (was always emitted), matching the format-contract rule that optional fields are absent when empty/null/false.

### Added

- **`git_blame` `maxLines`** (default 2000, max 10000) — caps blamed lines; overflow is signalled with top-level `truncated: true` + `omittedLines`.

### Fixed

- **Unbounded `.int()` params serialized `"maximum":9007199254740991` into tool schemas.** Explicit caps added: `batch_commit` `lines.from`/`lines.to` and `git_blame` `startLine`/`endLine` at 1000000, `git_stash_apply` `index` at 10000.

- **`batch_commit` hunk-level staging (`{ path, lines }`) could corrupt the git index.** `extractOverlappingHunks` joined the selected hunk(s) without a trailing newline; whenever the selection wasn't the *last* hunk in the file's real diff, the written patch file's final line had no newline terminator and `git apply --cached` rejected it with `error: corrupt patch at ...`. Fixed by always terminating the extracted patch with `\n`. Confirmed against a real multi-hunk diff before and after the fix; regression test added (`stages a non-final hunk without corrupting the patch`).
- **`batch_commit` `dryRun: true` could leave a partially-staged index after a failure.** When a commit entry listed multiple files and an earlier file staged successfully but a later file in the *same* entry failed to stage, the earlier file's staged state was never added to the dry-run cleanup set (tracking only happened after the whole per-file loop completed without failure) — so a failed "dry run" left real, uncommitted staged changes in the index. Fixed by tracking each file for cleanup immediately after it stages, not gated behind the later failure check. Regression test added (`dryRun: true unstages an earlier file when a later file in the same commit fails to stage`).

## [2.9.1] — 2026-06-11

Patch release: security hardening, schema refresh, and developer-tooling correctness. No JSON-format change.

### Security

- **Insecure temp-file creation eliminated.** `scripts/publish-preflight.ts` and `src/server/git-merge-tool.test.ts` now use `fs.mkdtemp` instead of predictable paths (2 high `js/insecure-temporary-file` alerts resolved).
- **TOCTOU race in `.gitmodules` parsing fixed.** `parseGitSubmodulePaths` in `git.ts` previously called `existsSync` then `lstatSync` separately, creating a file-system race window. The redundant `existsSync` check is removed; `lstatSync` + `readFileSync` is now wrapped in a single `try/catch` (1 high `js/file-system-race` alert resolved).
- **GitHub Actions workflow permissions hardened.** `ci.yml` and `release.yml` gain `permissions: contents: read` blocks at workflow and job level. All third-party action tags are pinned to full commit SHAs (5 medium workflow-permission alerts resolved).

### Changed

- **Schema artifacts regenerated.** `schemas/*.json` (23 files) were stale relative to tool-description changes in the 2.9.0 token-trim and allowlist commits; regenerated so `bun run schema:individual:check` passes in CI.

### Fixed

- **Test files are now type-checked.** `tsconfig.json` includes `**/*.test.ts` with `@types/bun`, and a new `tsconfig.build.json` keeps tests out of the published `dist`. This surfaced and fixed latent type errors in the `tools`, `git-merge`, `list-presets`, and `tool-parameter-schemas` tests that the prior build never caught.
- **`coverage:check` is robust to ANSI color.** `parseAllFilesLineCoverage` strips ANSI escape codes before matching the summary rows, so coverage parsing no longer fails when `bun test --coverage` emits color (e.g. under `FORCE_COLOR`).

## [2.9.0] — 2026-06-05

Feature release: `RETHUNK_GIT_TOOLS` allowlist env var. Additive — no JSON format-version bump.

### Added

- **`RETHUNK_GIT_TOOLS`** — comma-separated allowlist of exact tool names. When set to a non-empty value, only the listed tools are registered; unknown names are warned to stderr and ignored. When unset or empty (default), all 23 tools are registered — zero behavioral change for existing consumers. If every name in the list is unrecognized, zero tools are registered and a loud warning is emitted (the restriction is honored literally rather than falling back to all tools). The presets resource (`rethunk-git://presets`) is always registered regardless of this setting. Cuts MCP token cost for agents that only need a small subset of tools. Example: `RETHUNK_GIT_TOOLS=git_status,git_diff_summary,git_diff,git_log,batch_commit,git_push`.

## [2.8.1] — 2026-06-05

Patch release: token-cost reduction. No behavior or JSON-format change.

### Changed

- Tightened verbose tool parameter descriptions (shared `WorkspacePickSchema` plus several per-tool schemas) to cut the serialized MCP tool payload (~7% of the real `tools/list` size). Descriptions only — no parameter, type, enum, or default changes.

## [2.8.0] — 2026-05-29

Feature release: three new read-only inspection tools (tool count 20 → 23). Additive — no JSON format-version bump.

### Added

- **`git_blame`** — line-by-line authorship for a file: commit SHA, author, ISO date, summary, and content per line. Blames at an optional `ref` and an optional `startLine`/`endLine` range (`-L`); path-confined like the other path tools (`path_escapes_repo`).
- **`git_branch_list`** — list local branches with sha, current marker, and upstream; optional `includeRemotes` adds remote-tracking branches (symbolic `origin/HEAD` skipped). Returns `{ branches, remotes? }`.
- **`git_reflog`** — show the reflog for a ref (default `HEAD`): recent HEAD movements with selector (`HEAD@{N}`), full SHA, and message; `maxEntries` cap (default 30, max 200).

## [2.7.0] — 2026-05-29

Feature release: deepens three read tools per recurring agent pain points (TODO.md) and hardens the git subprocess layer. All changes are additive — no JSON format-version bump.

### Added

- **`git_diff` — multi-path + context control** — new `paths: string[]` scopes the diff to multiple files (unioned with the legacy single `path`), and `unified: number` (0–100) sets the context-line width (`-U<n>`). Path confinement is now enforced on every path input, returning `path_escapes_repo` on escape.
- **`git_show` — stat + multi-path modes** — new `stat: true` returns a `--stat` diffstat (commit message + per-file counts, no full patch), and `paths: string[]` filters the shown patch/stat to specific files, with the same path-confinement guarantees as single `path`.
- **`git_fetch` — structured ref deltas** — emits `updated: [{ ref, oldSha, newSha, flag }]`, `created: [{ ref, newSha, flag }]`, and `pruned: [{ ref }]` parsed from `git fetch --porcelain` (git ≥ 2.41). On older git the option is detected as unsupported and the tool falls back to the legacy line parse; the string `updatedRefs` / `newRefs` fields are retained for back-compat in both modes.
- **`GIT_SUBPROCESS_TIMEOUT_MS`** — `spawnGitAsync` now accepts an optional `{ timeoutMs, signal }` argument and applies a default timeout (120000 ms, configurable via the env var; `0` disables). A hung git operation against a dead remote no longer blocks the server indefinitely — the child is killed (SIGTERM) on expiry or `AbortSignal` abort, and the result resolves `ok: false` with `timedOut` / `aborted` flags. Existing callers are unchanged beyond gaining default timeout protection.

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

### Changed

- Integration tests added for `git_stash_list`, `git_stash_apply`, `git_fetch`, `git_status`, `git_inventory`, and `git_parity` execute paths.
- `isContentEquivalentlyMergedInto` integration tests via real git repos with cherry-picked and diverged histories.
- `batch_commit` dryRun tests covering deleted-file unstaging.
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
- **README / HUMANS / AGENTS / CONTRIBUTING / install docs** refreshed for the current tool surface, shipped schema artifacts, and contributor workflow.
- **`SECURITY.md`** added with repository access, git-operation risk, and disclosure guidance.
- **`docs/mcp-tools.md`** now documents the full tool surface, `batch_commit` atomic staging semantics, and the shipped schema artifacts.
- **`TODO.md`** backlog entries now reflect genuine remaining gaps instead of listing already-implemented tools as missing.
- **`specs/` scaffold** added with standard `active`, `done`, and `parked` layout for repo planning.
- **CHANGELOG references** for `v2.3.2`–`v2.3.4` were restored.
- Coverage expanded across `list_presets`, `git_parity`, `git_cherry_pick`, `git_merge`, `git_show`, schema generation, and roots handling.
- The shared git test harness now reuses repo-init / commit helpers and speeds up fixture setup.

### Fixed

- **MCP roots** — workspace root collection now scans active MCP sessions and dedupes `file://` roots instead of relying on a fixed server `cwd`.
- **`git_push`** and **`batch_commit`** now surface raw git stdout/stderr on failure for easier recovery.
- **Published schema snapshots** are now complete and in sync with the registered tool surface, including `schema:tools:check`.
- **`publish:preflight`** now writes temporary coverage output under the platform temp directory instead of a hard-coded `/tmp` path.

## [2.3.4] — 2026-04-26

Publication-prep patch for the `absoluteGitRoots` line.

### Added

- **`tool-parameters.schema.json`** — generated JSON Schema snapshot for every registered tool parameter surface, plus `bun run schema:tools` / `bun run schema:tools:check`.
- **`git_parity` absolute-root regression coverage** — sibling clone batches are now covered directly.

### Fixed

- **CI coverage gate** now checks `% Lines` from Bun's coverage table instead of accidentally reading `% Funcs`.

### Changed

- **`HUMANS.md`** — added sibling-clone `absoluteGitRoots` examples for `git_status` and `git_parity`.
- **`docs/mcp-tools.md`** — clarified direct `git_push` use for already-committed work and `git_parity` sibling-clone batches.

## [2.3.3] — 2026-04-21

### Added

- **`absoluteGitRoots`** on the workspace pick schema: pass absolute paths to many independent git clones in one MCP call for **`git_status`**, **`git_inventory`**, **`git_log`**, **`git_parity`**, **`git_diff_summary`** (single distinct toplevel only), and **`list_presets`**. Mutating tools omit this parameter from their Zod surface. See **`docs/mcp-tools.md`** (*Workspace root resolution*).

### Changed

- **`requireGitAndRoots`** / **`requireSingleRepo`**: new prelude **`resolveAbsoluteGitRootsList`** with dedupe, fail-fast on invalid paths, and mutual exclusion with `workspaceRoot` / `rootIndex` / `allWorkspaceRoots` / `preset` (and `nestedRoots`+`preset` guarded in **`git_inventory`**).

## [2.3.2] — 2026-04-21

### Changed

- Coverage gate added: `bun run test:coverage` enforces an 80% line-coverage minimum in CI (`check` job).
- **`CONTRIBUTING.md`** — new file; consolidates dev setup, hook table, commit conventions, CI description, PR checklist, path-confinement guidance, and how-to-add-a-tool guidance for mutating tools.
- **`HUMANS.md`** — Development section replaced with a pointer to `CONTRIBUTING.md`; preset file, `git_not_found`, install reference, and publishing steps remain.
- **`AGENTS.md`** — corrected pre-push hook description (missing `test` step) and updated canonical-docs link for dev/CI content.
- **`.cursor/rules/rethunk-git-mcp.mdc`** — removed stale "shell is fine for `git diff` / `git cherry-pick`" examples; both now have MCP tool equivalents (`git_diff_summary`, `git_cherry_pick`).

## [2.3.1] — 2026-04-21

Documentation-only patch following the 2.3.0 release.

### Changed

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
- `requireSingleRepo` helper extracted to `roots.ts`; replaces copy-paste preludes across `batch_commit`, `git_diff_summary`, `git_merge`, `git_cherry_pick`, `git_push`, `git_reset_soft`, and all `git_worktree_*`.
- `conflictPaths` extracted from `git-merge-tool.ts` to `git-refs.ts`; shared by `git_merge` and `git_cherry_pick`.
- `inferRemoteFromUpstream` extracted to `git-refs.ts`; shared by `runPushAfter` (`batch_commit`) and `git_push`.
- `isWorkingTreeClean` used consistently everywhere (was inlined in `git_reset_soft`).
- Coverage: **88.6% lines / 92.8% functions** (up from 69.9% / 71.4%).
- 262 tests across 15 files (up from 134 across 7 files).
- New test files: `presets.test.ts`, `inventory.test.ts`, `git-utils.test.ts`, `json.test.ts`, `git-reset-soft-tool.test.ts`, `git-push-tool.test.ts`, `git-worktree-tool.test.ts`, `roots.test.ts`. `git-refs.test.ts` extended with `isSafeGitAncestorRef` cases.
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
- `docs/mcp-tools.md` — `git_merge` and `git_cherry_pick` sections with parameters, JSON shape, and error codes; `batch_commit` `push: "after"` option documented.

## [2.1.0] — 2026-04-12

- Added `git_log` — path-filtered, time-windowed log across workspace roots.
- Added `git_diff_summary` — structured, token-efficient diff viewer with per-file truncation and default exclusions (lock files, `dist`, vendor).
- Added `batch_commit` — sequential multi-commit tool. Mutating, not idempotent.
- Test harness: fake-server duck-type lets unit tests drive the full FastMCP execute path without a live transport.

## [2.0.1] — 2026-04-11

- Bug fixes and internal cleanup; no public tool-surface change.

## [2.0.0] — 2026-04-11

- **Breaking:** JSON response envelope removed. `MCP_JSON_FORMAT_VERSION` now `"2"`; payloads are minified, and optional fields are omitted when empty / `null` / `false` (consumers test for presence, not equality to `null`).
- Initial preset file schema (`.rethunk/git-mcp-presets.json`) with wrapped and legacy-map layouts.

## [1.0.0] — 2026-04-05

- Initial release: `git_status`, `git_inventory`, `git_parity`, `list_presets`.

[3.2.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v3.2.0
[3.1.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v3.1.0
[3.0.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v3.0.0
[2.9.1]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.9.1
[2.9.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.9.0
[2.8.1]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.8.1
[2.8.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.8.0
[2.7.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.7.0
[2.6.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.6.0
[2.5.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.5.0
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
