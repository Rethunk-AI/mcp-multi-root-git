# MCP tools and resources (canonical reference)

Single source of truth for **registered tool ids**, **client naming**, **JSON output shape**, **resource URI**, and **workspace root resolution**.  
**Install and MCP clients (only canonical location):** [install.md](install.md). **Preset file, dev, CI, publishing:** [HUMANS.md](../HUMANS.md). **Implementation layout (`src/server/` + entry [`server.ts`](../src/server.ts)), contract bumps:** [AGENTS.md](../AGENTS.md).

## Naming

MCP clients expose tools as `{serverName}_{toolName}`. With the server registered as **`rethunk-git`**, examples use the prefix **`rethunk-git_`**.

## Tools

| Short id | Client id (server `rethunk-git`) | Purpose |
|----------|-----------------------------------|---------|
| `git_status` | `rethunk-git_git_status` | `git status --short -b` per MCP root and optional submodules (`includeSubmodules`); parallel submodule status. Args include `absoluteGitRoots`, `allWorkspaceRoots`, `rootIndex`, `workspaceRoot`, `format`. **Read-only.** |
| `git_inventory` | `rethunk-git_git_inventory` | Status + ahead/behind per path; default upstream each repo’s `@{u}`; pass **both** `remote` and `branch` for fixed tracking. `nestedRoots`, `preset`, `presetMerge`, `maxRoots`, `format`, plus workspace pick args (`absoluteGitRoots` cannot combine with `preset`/`nestedRoots`). **Read-only.** |
| `git_parity` | `rethunk-git_git_parity` | Compare `git rev-parse HEAD` for path pairs. `pairs`, `preset`, `presetMerge`, `format`, plus workspace pick args. **Read-only.** |
| `list_presets` | `rethunk-git_list_presets` | List preset names/counts from `.rethunk/git-mcp-presets.json`; invalid JSON/schema surface as errors. Workspace pick + `format` only (includes `absoluteGitRoots`). **Read-only.** |
| `git_log` | `rethunk-git_git_log` | Path-filtered, time-windowed `git log` across one or more workspace roots. Returns commit history with author, date, subject, and shortstat. Args: `since`, `paths`, `grep`, `author`, `maxCommits`, `branch`, plus workspace pick args (`absoluteGitRoots` for sibling clones) + `format`. **Read-only.** |
| `git_diff_summary` | `rethunk-git_git_diff_summary` | Structured, token-efficient diff viewer. Returns per-file diffs with additions/deletions counts, truncated to configurable line limits, with lock files/dist/vendor excluded by default. Args: `range`, `fileFilter`, `maxLinesPerFile`, `maxFiles`, `excludePatterns`, plus workspace pick args (optional single-entry `absoluteGitRoots`) + `format`. **Read-only.** |
| `git_worktree_list` | `rethunk-git_git_worktree_list` | List all worktrees (`git worktree list --porcelain`). Workspace pick + `format`. **Read-only.** |
| `git_push` | `rethunk-git_git_push` | Push the current branch to its upstream. Optional `remote`, `branch`, `setUpstream` (passes `-u`). Refuses on detached HEAD; never force-pushes. Workspace pick + `format`. **Mutating.** |
| `git_worktree_add` | `rethunk-git_git_worktree_add` | Create a new linked worktree, creating the branch from `baseRef` if it does not yet exist. Refuses on protected branch names. Args: `path`, `branch`, `baseRef?`, plus workspace pick + `format`. **Mutating.** |
| `git_worktree_remove` | `rethunk-git_git_worktree_remove` | Remove a registered worktree; refuses to remove the main worktree. Optional `force: true` for dirty trees. Args: `path`, `force?`, plus workspace pick + `format`. **Mutating.** |
| `git_reset_soft` | `rethunk-git_git_reset_soft` | Soft-reset the current branch to a ref (`HEAD~N`, SHA, branch). Rewound changes land in the staging index; requires a clean working tree. Args: `ref`, plus workspace pick + `format`. **Mutating — not idempotent.** |
| `batch_commit` | `rethunk-git_batch_commit` | Create multiple sequential git commits in a single call. Each entry stages the listed files then commits with the given message. Stops on first failure. Optional `push: "after"` pushes the current branch to its upstream once every commit lands. Args: `commits` (array of `{message, files}`), `push?`, plus workspace pick args + `format`. **Mutating — not idempotent.** |
| `git_merge` | `rethunk-git_git_merge` | Merge one or more source branches into a destination. Default strategy `auto` cascades fast-forward → rebase → merge-commit per source, preferring linear history. Refuses on dirty tree; stops on first conflict with structured path report. Optional `deleteMergedBranches` / `deleteMergedWorktrees` cascade cleanup, always skipping protected names (main/master/dev/develop/stable/trunk/prod/production/release\*/hotfix\*). Args: `sources`, `into?`, `strategy?`, `message?`, cleanup flags + workspace pick + `format`. **Mutating.** |
| `git_cherry_pick` | `rethunk-git_git_cherry_pick` | Play commits from one or more sources onto a destination. Sources may be SHAs, `A..B` ranges, or branch names (expanded to `onto..<branch>`, oldest-first). Uses `--empty=drop` so patch-equivalent re-applies add nothing. Refuses on dirty tree; stops on first conflict, aborting cleanly. Same cleanup flags as `git_merge` (branch-kind sources only, protected names skipped). Args: `sources`, `onto?`, cleanup flags + workspace pick + `format`. **Mutating.** |

Pass **`format: "json"`** on any tool for structured JSON instead of markdown (default).

## JSON responses

Tool JSON bodies are minified and contain only the payload — no `rethunkGitMcp` envelope. Current `MCP_JSON_FORMAT_VERSION` is **`"3"`**; server + format version are discoverable via MCP `initialize`. Payload keys (`groups`, `inventories`, `parity`, `roots`) are stable within a given format version. Preset-related responses may include **`presetSchemaVersion`**.

### v2/v3 field omission (consumer contract)

To keep responses compact, **optional fields are omitted when they would be empty, `null`, or `false`** — they are not emitted as `null`. Consumers must test for *presence*, not compare to `null`.

**`git_inventory` → `inventories[*]`**

- Always present: `workspace_root`, `entries`.
- Omitted when not applicable: `presetSchemaVersion`, `nestedRootsTruncated`, `nestedRootsOmittedCount`, and the whole `upstream` object (emitted only when a fixed `remote`/`branch` pair was supplied; in `auto` mode it is absent).

**`git_inventory` → `entries[*]` (`InventoryEntryJson`)**

- Always present: `label`, `path`, `upstreamMode` (`"auto"` or `"fixed"`).
- Optional (omitted when empty/absent): `branchStatus`, `headAbbrev`, `upstreamRef`, `ahead`, `behind`, `upstreamNote`, `detached` (only emitted as `true`), `skipReason` (only on skipped entries).
- **Removed in v2:** `shortStatus`. The porcelain entries now live inside `branchStatus` (the full `git status --short -b` body — branch header line followed by porcelain lines).

**Errors** (any tool)

- Error payloads carry an `error` code string and any structured context (e.g. `preset`, `presetFile`). The old free-text `message` field is **removed** for self-describing codes (`git_not_found`, `remote_branch_mismatch`, `invalid_remote_or_branch`, `no_pairs`, `preset_not_found` *missing* case). It is retained only where it carries parse output (the `invalid_json` preset branch).

**When to bump `MCP_JSON_FORMAT_VERSION` or change payload shape:** [AGENTS.md](../AGENTS.md) — *Changing contracts*.

### `git_log` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `since` | string | `"7.days"` | Passed to `git log --since=`. Accepts ISO timestamps (`2026-04-01T00:00:00Z`) or git relative forms (`48.hours`, `2.weeks.ago`). |
| `paths` | string[] | (all) | Restrict to commits touching these paths (appended after `--`). |
| `grep` | string | — | Filter by commit message regex (git `--grep`, always case-insensitive). |
| `author` | string | — | Filter by author name or email (`--author=`). |
| `maxCommits` | int | `50` | Max commits per root. Hard cap: `500`. |
| `branch` | string | `HEAD` | Ref/branch to log from. |
| `workspaceRoot` | string | — | Explicit root; highest priority. |
| `rootIndex` | int | — | Pick one of several MCP roots (0-based). |
| `allWorkspaceRoots` | boolean | `false` | Fan out across all MCP roots. |
| `format` | `"markdown"` \| `"json"` | `"markdown"` | Output format. |

### `git_log` — JSON shape (`format: "json"`)

```json
{
  "groups": [{
    "workspaceRoot": "/abs/path",
    "repo": "my-repo",
    "branch": "main",
    "commits": [{
      "sha": "a1bf184c3d…",
      "subject": "feat(satcom): upgrade to PROTOCOL_VERSION 4",
      "author": "Damon Blais",
      "email": "damon@example.com",
      "date": "2026-04-12T18:32:01-07:00",
      "filesChanged": 4,
      "insertions": 16,
      "deletions": 5
    }],
    "truncated": true,
    "omittedCount": 12
  }]
}
```

v3 changes from v2: `sha7` removed (use `sha.slice(0,7)` for display); `ageRelative` removed (use `date` — ISO 8601); `email` omitted when empty; `workspace_root` renamed to `workspaceRoot` (camelCase consistency).

v2 field-omission rules still apply: `filesChanged`, `insertions`, `deletions` omitted when zero/absent. `truncated` and `omittedCount` omitted when `false`/`0`. A group emits `error` instead of `commits` when git fails for that root.

### `git_log` — error codes

| Code | Meaning |
|------|---------|
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |
| `invalid_since` | The `since` string contains shell metacharacters and was rejected. |
| `invalid_paths` | One of the `paths` entries contains shell metacharacters and was rejected. |
| `git_log_failed` | `git log` exited non-zero (e.g. unknown branch ref). |
| `root_index_out_of_range` | `rootIndex` exceeds the number of MCP file roots. |
| `absolute_git_roots_exclusive` | `absoluteGitRoots` was combined with `workspaceRoot`, `rootIndex`, or `allWorkspaceRoots: true`. |
| `absolute_git_roots_preset_conflict` | `absoluteGitRoots` was combined with a `preset` argument (root resolution). |
| `invalid_absolute_git_root` | An `absoluteGitRoots` entry is empty, not inside a git worktree, or not a directory git recognizes. |
| `absolute_git_roots_too_many` | More than 256 entries in `absoluteGitRoots`. |
| `absolute_git_roots_empty` | `absoluteGitRoots` produced zero git toplevels after resolution. |
| `absolute_git_roots_single_repo_only` | A single-repo tool received `absoluteGitRoots` resolving to more than one distinct git toplevel. |

### `git_diff_summary` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `range` | string | unstaged | Diff range. `"staged"` / `"cached"` for index; `"HEAD"` for last commit; `"A..B"` or `"A...B"` for revision ranges; single ref. Default: unstaged working-tree changes. |
| `fileFilter` | string | — | Glob pattern to restrict output to matching files (e.g. `"*.ts"`, `"src/**"`). |
| `maxLinesPerFile` | int | `50` | Max diff lines to include per file (1–2000). |
| `maxFiles` | int | `30` | Max files to include in output (1–500). |
| `excludePatterns` | string[] | lock files, dist, vendor | Glob patterns to exclude. Defaults to `*.lock`, `*.lockb`, `bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `*.min.js`, `*.min.css`, `vendor/**`, `node_modules/**`, `dist/**`. Pass an empty array to disable. |
| `workspaceRoot` | string | — | Explicit root; highest priority. |
| `rootIndex` | int | — | Pick one of several MCP roots (0-based). |
| `format` | `"markdown"` \| `"json"` | `"markdown"` | Output format. |

### `git_diff_summary` — JSON shape (`format: "json"`)

```json
{
  "range": "unstaged changes",
  "totalFiles": 2,
  "totalAdditions": 10,
  "totalDeletions": 5,
  "files": [{
    "path": "src/foo.ts",
    "status": "modified",
    "additions": 8,
    "deletions": 3,
    "truncated": false,
    "diff": "@@ -1,3 +1,8 @@\n-const x = 1;\n+const x = 2;"
  }],
  "truncatedFiles": 1,
  "excludedFiles": ["yarn.lock"]
}
```

`status` is one of `"modified"`, `"added"`, `"deleted"`, `"renamed"`. `oldPath` is present only for renamed files. `truncatedFiles` and `excludedFiles` are omitted when zero/empty (v2 field-omission contract).

### `git_diff_summary` — error codes

| Code | Meaning |
|------|---------|
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |
| `unsafe_range_token` | The `range` string contains characters outside the safe token set. |
| `git_diff_failed` | `git diff` exited non-zero. |

---

### `batch_commit` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `commits` | `{message: string, files: string[]}[]` | Commits to create in order. 1–50 entries. Each `files` entry is a path relative to the git root; all must stay within the git toplevel. |
| `push` | `"never"` \| `"after"` | Default `"never"`. `"after"` pushes the current branch to its upstream **once all commits succeed**. Never auto-sets upstream — branches without an upstream fail with `push_no_upstream`. Commits are **not** rolled back on push failure. Enum reserved for future modes such as `"force-with-lease"`. |
| `workspaceRoot` | string | Explicit root; highest priority. |
| `rootIndex` | int | Pick one of several MCP roots (0-based). |
| `format` | `"markdown"` \| `"json"` | Output format. Default: `"markdown"`. |

### `batch_commit` — JSON shape (`format: "json"`)

```json
{
  "ok": true,
  "committed": 2,
  "total": 2,
  "results": [{
    "index": 0,
    "ok": true,
    "sha": "a1b2c3d",
    "message": "feat: add foo",
    "files": ["src/foo.ts"]
  }, {
    "index": 1,
    "ok": true,
    "sha": "b2c3d4e",
    "message": "chore: update config",
    "files": ["config.json"]
  }],
  "push": {
    "ok": true,
    "branch": "main",
    "upstream": "origin/main"
  }
}
```

On first failure `ok` is `false`, `committed` reflects only the entries that succeeded before the error, and the failing entry includes `error` and `detail` fields. Remaining entries are skipped and not included in `results`.

The `push` object is present only when `push: "after"` was requested **and** every commit landed. On push failure the top-level `ok` stays `true` (the commits themselves succeeded) while `push.ok` is `false` and `push.error` carries the code.

### `batch_commit` — error codes (per-result `error` field)

| Code | Meaning |
|------|---------|
| `path_escapes_repository` | One of the listed file paths resolves outside the git toplevel. |
| `stage_failed` | `git add` failed (e.g. untracked path or permission error). |
| `commit_failed` | `git commit` failed (e.g. nothing staged, hooks rejected). |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

### `batch_commit` — push error codes (`push.error` field)

| Code | Meaning |
|------|---------|
| `push_detached_head` | HEAD is detached; no branch to push. |
| `push_no_upstream` | Current branch has no configured upstream. `batch_commit` will not auto-set one — do `git push -u origin <branch>` yourself (or re-run without `push`). |
| `push_failed` | `git push` exited non-zero (network error, non-fast-forward, hook rejection). `detail` carries the stderr/stdout from git. |

---

### `git_merge` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `sources` | `string[]` | Source branches to merge, in order. 1–20 entries. Each must be a valid git ref token. |
| `into` | string | Destination branch. Defaults to the currently checked-out branch. Rejected when HEAD is detached. |
| `strategy` | `"auto"` \| `"ff-only"` \| `"rebase"` \| `"merge"` | Default `"auto"`: cascade **fast-forward → rebase → merge-commit** per source. `"ff-only"` fails on divergence. `"rebase"` rebases source onto destination and fast-forwards; no merge-commit fallback. `"merge"` always creates a merge commit (`--no-ff`). |
| `message` | string | Merge commit message, used only when a merge commit is created. Defaults to `Merge branch '<source>' into <into>`. |
| `deleteMergedBranches` | boolean | Default `false`. After **all** sources land cleanly, delete each source branch locally (`git branch -d`). **Protected names always skipped** (main, master, dev, develop, stable, trunk, prod, production, `release/*`, `release-*`, `hotfix/*`, `hotfix-*`). Never touches remote refs. |
| `deleteMergedWorktrees` | boolean | Default `false`. After success, remove any local worktree currently checked out on a source branch (`git worktree remove`). Protected tails always skipped. |
| `workspaceRoot`, `rootIndex`, `format` | — | Standard workspace pick + output format. |

### `git_merge` — JSON shape (`format: "json"`)

```json
{
  "ok": true,
  "into": "main",
  "strategy": "auto",
  "headSha": "a1b2c3d4e5f6…",
  "applied": 2,
  "total": 2,
  "results": [
    {
      "source": "feature/a",
      "ok": true,
      "outcome": "fast_forward",
      "mergedSha": "a1b2c3d4e5f6…",
      "branchDeleted": true,
      "worktreeRemoved": "/tmp/agent-a"
    },
    {
      "source": "feature/b",
      "ok": true,
      "outcome": "rebase_then_ff",
      "mergedSha": "b2c3d4e5f6a1…"
    }
  ]
}
```

**`outcome`** (per source): `fast_forward`, `rebase_then_ff`, `merge_commit`, `up_to_date`, or `conflicts`. Cleanup fields (`branchDeleted`, `worktreeRemoved`) are only emitted when the corresponding flag was set and the operation actually ran — both are omitted for up-to-date sources and are never populated on partial-failure runs.

On conflict: top-level `ok` is `false`, the conflicting entry has `ok: false` with `conflictStage` (`"rebase"` or `"merge"`), `conflictPaths` (array of paths with unresolved markers), and an `error` code. Remaining sources are not attempted.

### `git_merge` — error codes

| Code | Meaning |
|------|---------|
| `unsafe_ref_token` | A source or `into` contains characters outside the argv-safe subset (spaces, shell meta, `..`, `@{`, leading `-`, trailing `.lock`). |
| `into_detached_head` | HEAD is detached and no `into` was given — the tool needs a concrete destination branch. |
| `working_tree_dirty` | Uncommitted changes present. Commit, stash, or discard before merging. |
| `checkout_failed` | Could not switch to `into`. `detail` carries git's stderr. |
| `destination_not_found` | `into` does not resolve to a commit. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |
| `source_not_found` (per source) | A source branch name does not resolve. |
| `cannot_fast_forward` (per source) | `strategy: "ff-only"` refused because branches have diverged. |
| `rebase_conflicts` (per source) | Rebase encountered conflicts. Repo state is cleaned before returning. |
| `merge_conflicts` (per source) | Merge commit encountered conflicts. Repo state is cleaned before returning. |
| `merge_failed` (per source) | `git merge --ff-only` failed unexpectedly. `detail` carries stderr. |
| `merge_base_failed` (per source) | `git merge-base` failed (usually unrelated histories). |

---

### `git_cherry_pick` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `sources` | `string[]` | Source specs. 1–50 entries. Each entry is one of: a full/short SHA, an `A..B` / `A...B` range, or a branch name. Branch names expand to `onto..<branch>` (oldest-first). |
| `onto` | string | Destination branch. Defaults to the currently checked-out branch. Rejected when HEAD is detached. |
| `deleteMergedBranches` | boolean | Default `false`. After all commits apply, delete each **branch-kind** source locally (`git branch -d`) when it is fully merged into the destination by SHA-reachability (not patch-equivalence). Protected names always skipped; never touches remote refs. |
| `deleteMergedWorktrees` | boolean | Default `false`. After success, remove any local worktree attached to a branch-kind source (`git worktree remove`). Protected tails always skipped. |
| `workspaceRoot`, `rootIndex`, `format` | — | Standard workspace pick + output format. |

### `git_cherry_pick` — JSON shape (`format: "json"`)

```json
{
  "ok": true,
  "onto": "main",
  "headSha": "a1b2c3d…",
  "picked": 3,
  "applied": 2,
  "results": [
    { "source": "feature/a", "kind": "branch", "resolvedCommits": 2, "keptCommits": 2 },
    { "source": "abcdef1",    "kind": "sha",    "resolvedCommits": 1, "keptCommits": 1 }
  ]
}
```

**`picked`** is the number of unique SHAs fed to `git cherry-pick` after SHA-reachability filtering. **`applied`** is the number of new commits actually added to HEAD — may be less than `picked` because the tool passes `--empty=drop` to git, so patch-equivalent commits are skipped at apply time without error.

**`kind`** is `"sha"`, `"range"`, or `"branch"`. **`resolvedCommits`** is how many commits the source expanded to; **`keptCommits`** is how many survived SHA-reachability dedupe. Cleanup fields (`branchDeleted`, `worktreeRemoved`) are only emitted for branch-kind sources when the corresponding flag was set and the operation succeeded.

On conflict, the response has `ok: false` and a top-level `conflict` object:

```json
{
  "ok": false,
  "onto": "main",
  "picked": 2,
  "applied": 0,
  "results": [ ... ],
  "conflict": {
    "stage": "cherry-pick",
    "commit": "abcdef1",
    "paths": ["src/foo.ts"],
    "detail": "…git stderr…"
  }
}
```

Repo state is cleaned (`git cherry-pick --abort`) before returning — no partially-applied index.

### `git_cherry_pick` — error codes

| Code | Meaning |
|------|---------|
| `unsafe_ref_token` | A source or `onto` contains characters outside the argv-safe subset. |
| `onto_detached_head` | HEAD is detached and no `onto` was given. |
| `working_tree_dirty` | Uncommitted changes present. Commit, stash, or discard before cherry-picking. |
| `checkout_failed` | Could not switch to `onto`. |
| `destination_not_found` | `onto` does not resolve to a commit. |
| `source_not_found` | A source spec resolves to neither a branch, a range, nor a commit. |
| `range_resolution_failed` | `git rev-list` failed to expand a range spec. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_push` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `remote` | string | Remote to push to. Defaults to the remote inferred from the upstream tracking ref, or `origin` when `setUpstream` is true. |
| `branch` | string | Branch to push. Defaults to the currently checked-out branch. Rejected on detached HEAD. |
| `setUpstream` | boolean | Default `false`. Pass `-u` to set the upstream tracking ref; remote defaults to `origin`. |
| `workspaceRoot`, `rootIndex`, `format` | — | Standard workspace pick + output format. |

### `git_push` — JSON shape (`format: "json"`)

```json
{ "ok": true, "branch": "feature/x", "remote": "origin", "upstream": "origin/feature/x" }
```

### `git_push` — error codes

| Code | Meaning |
|------|---------|
| `push_detached_head` | HEAD is detached; no branch name to push. |
| `push_no_upstream` | Branch has no configured upstream and `setUpstream` was not requested. |
| `push_failed` | `git push` exited non-zero. `detail` carries stderr. |
| `unsafe_ref_token` | `branch` value contains characters outside the safe token set. |
| `unsafe_remote_token` | `remote` value contains disallowed characters. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_reset_soft` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `ref` | string | Target commit: `HEAD~N`, branch name, or full/short SHA. |
| `workspaceRoot`, `rootIndex`, `format` | — | Standard workspace pick + output format. |

### `git_reset_soft` — JSON shape (`format: "json"`)

```json
{ "ok": true, "ref": "HEAD~2", "beforeSha": "a1b2c3d…", "afterSha": "f9e8d7c…", "stagedCount": 5 }
```

### `git_reset_soft` — error codes

| Code | Meaning |
|------|---------|
| `unsafe_ref_token` | `ref` contains characters outside the ancestor-safe token set. |
| `working_tree_dirty` | Working tree has uncommitted/unstaged changes; clean up before resetting. |
| `status_failed` | `git status` failed unexpectedly. |
| `reset_failed` | `git reset --soft` failed (e.g. ref does not exist). |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_worktree_list` — JSON shape (`format: "json"`)

```json
{ "worktrees": [{ "path": "/abs/path", "branch": "feature/x", "head": "a1b2c3d…" }] }
```

`branch` is `null` for detached-HEAD worktrees.

### `git_worktree_add` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `path` | string | Filesystem path for the new worktree. Relative paths are resolved from the git toplevel. |
| `branch` | string | Branch to check out. Created from `baseRef` if it does not already exist. |
| `baseRef` | string | Commit-ish for branch creation. Default: `HEAD`. Ignored when `branch` already exists. |
| `workspaceRoot`, `rootIndex`, `format` | — | Standard workspace pick + output format. |

### `git_worktree_add` — JSON shape (`format: "json"`)

```json
{ "ok": true, "path": "/abs/worktree", "branch": "feature/x", "created": true, "baseRef": "main" }
```

### `git_worktree_add` — error codes

| Code | Meaning |
|------|---------|
| `unsafe_ref_token` | `branch` or `baseRef` contains disallowed characters. |
| `protected_branch` | `branch` is on the protected names list. |
| `worktree_add_failed` | `git worktree add` exited non-zero. `detail` carries stderr. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

### `git_worktree_remove` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `path` | string | Path of the worktree to remove. |
| `force` | boolean | Default `false`. Pass `--force` to allow removal with uncommitted changes. |
| `workspaceRoot`, `rootIndex`, `format` | — | Standard workspace pick + output format. |

### `git_worktree_remove` — error codes

| Code | Meaning |
|------|---------|
| `cannot_remove_main_worktree` | `path` resolves to the main (non-linked) worktree. |
| `worktree_not_found` | `path` is not registered as a worktree in this repo. |
| `worktree_remove_failed` | `git worktree remove` failed. Pass `force: true` if there are uncommitted changes. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

## Resource

| URI | Purpose |
|-----|---------|
| `rethunk-git://presets` | JSON snapshot of `.rethunk/git-mcp-presets.json` at the resolved git toplevel (or structured errors). |

## Workspace root resolution

### `absoluteGitRoots` (sibling clones)

When **`absoluteGitRoots`** is a **non-empty** string array, it **replaces** the normal workspace pick for that tool call:

- Each entry is passed through `path.resolve`, then resolved to a **git toplevel** via the same logic as `workspaceRoot`. Duplicate toplevels are dropped (stable order, first wins).
- **Maximum** **256** paths (same cap as `git_inventory` `maxRoots` upper bound).
- **Mutually exclusive** with **`workspaceRoot`**, **`rootIndex`**, and **`allWorkspaceRoots: true`**. Combining them returns `{ "error": "absolute_git_roots_exclusive" }`.
- **Mutually exclusive** with a **`preset`** argument on root resolution (`absolute_git_roots_preset_conflict`).
- **`git_inventory` only:** also mutually exclusive with **`nestedRoots`** or **`preset`** on the same call (`absolute_git_roots_nested_or_preset_conflict`).
- **Mutating** tools (`batch_commit`, `git_push`, `git_merge`, …) **omit** this parameter from their schema; callers must use `workspaceRoot` / MCP roots for writes.
- **Read tools** that use **`requireSingleRepo`** (`git_diff_summary`, …) accept at most **one** distinct toplevel from `absoluteGitRoots`; more than one returns `absolute_git_roots_single_repo_only`.

Example — two sibling repos in one `git_status` call:

```json
{
  "format": "json",
  "absoluteGitRoots": [
    "/usr/local/src/com.github/Rethunk-AI/mcp-multi-root-git",
    "/usr/local/src/com.github/Rethunk-AI/rethunk-github-mcp"
  ]
}
```

### Default order (when `absoluteGitRoots` is absent or empty)

Order applied when resolving which directory(ies) tools run against:

1. Explicit **`workspaceRoot`** on the tool call (highest priority).
2. **`rootIndex`** (0-based) — one `file://` MCP root when several exist.
3. **`allWorkspaceRoots`: true** — every `file://` root; markdown output emits one `# {tool}` header with per-root subsections (`git_inventory` uses `### {gitTop}`; `git_status` uses `### MCP root: ...`), or combined JSON.
4. **`preset`** set and multiple roots — first root whose git toplevel defines that preset (respecting **`workspaceRootHint`** on the preset entry when present).
5. Otherwise the first `file://` root from MCP **`initialize`** / **`roots/list_changed`**.
6. **`process.cwd()`** if no file roots (e.g. CI with explicit `workspaceRoot`).

Roots come from the MCP session (**`FastMCP` with `roots: { enabled: true }`** in code); there is no fixed `cwd` in server config.
