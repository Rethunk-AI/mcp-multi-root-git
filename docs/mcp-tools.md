# MCP tools and resources (canonical reference)

Single source of truth for **registered tool ids**, **client naming**, **JSON output shape**, **resource URI**, and **root resolution**.  
**Install and MCP clients (only canonical location):** [install.md](install.md). **Preset file, dev, CI, publishing:** [HUMANS.md](../HUMANS.md). **Implementation layout (`src/server/` + entry [`server.ts`](../src/server.ts)), contract bumps:** [AGENTS.md](../AGENTS.md).

## Naming

MCP clients expose tools as `{serverName}_{toolName}`. With the server registered as **`rethunk-git`**, examples use the prefix **`rethunk-git_`**.

## Tools

| Short id | Client id (server `rethunk-git`) | Purpose |
|----------|-----------------------------------|---------|
| `git_status` | `rethunk-git_git_status` | `git status --short -b` per MCP root and optional submodules (`includeSubmodules`); parallel submodule status. Args: `includeSubmodules`, `root`, `format`. **Read-only.** |
| `git_inventory` | `rethunk-git_git_inventory` | Status + ahead/behind per path; default upstream each repo’s `@{u}`; pass **both** `remote` and `branch` for fixed tracking. `nestedRoots`, `preset`, `presetMerge`, `maxRoots`, `format`, plus `root` (array form cannot combine with `preset`/`nestedRoots`). **Read-only.** |
| `git_parity` | `rethunk-git_git_parity` | Compare `git rev-parse HEAD` for path pairs. `pairs`, `preset`, `presetMerge`, `format`, plus `root`. **Read-only.** |
| `list_presets` | `rethunk-git_list_presets` | List preset names/counts from `.rethunk/git-mcp-presets.json`; invalid JSON/schema surface as errors. `root` + `format` only. **Read-only.** |
| `git_log` | `rethunk-git_git_log` | Path-filtered, time-windowed `git log` across one or more roots. Returns commit history with author, date, subject, and shortstat. Args: `since`, `paths`, `grep`, `author`, `maxCommits`, `branch`, plus `root` + `format` (`markdown`/`json`/`oneline`). **Read-only.** |
| `git_diff_summary` | `rethunk-git_git_diff_summary` | Structured, token-efficient diff viewer. Returns per-file diffs with additions/deletions counts, truncated to configurable line limits, with lock files/dist/vendor excluded by default. Args: `range`, `fileFilter`, `maxLinesPerFile`, `maxFiles`, `excludePatterns`, plus `workspaceRoot` + `format`. **Read-only.** |
| `git_diff` | `rethunk-git_git_diff` | Raw diff text for a single repo. Supports unstaged, staged, or `base..head` ranges, scoped to one or more paths with configurable context width. Args: `workspaceRoot`, `format`, `base?`, `head?`, `path?`, `paths?`, `unified?`, `staged?`. **Read-only.** |
| `git_show` | `rethunk-git_git_show` | Inspect one commit or ref. Returns commit message plus diff (or `--stat` diffstat), or file content at `path` for that ref. Args: `ref`, `path?`, `paths?`, `stat?`, plus `workspaceRoot` + `format`. **Read-only.** |
| `git_worktree_list` | `rethunk-git_git_worktree_list` | List all worktrees (`git worktree list --porcelain`). `workspaceRoot` + `format`. **Read-only.** |
| `git_stash_list` | `rethunk-git_git_stash_list` | List `git stash` entries for one repo. Args: `workspaceRoot` + `format`. **Read-only.** |
| `git_blame` | `rethunk-git_git_blame` | File authorship grouped into contiguous same-commit line runs (SHA, author, date, summary once per run). Args: `path` (required), `ref?`, `startLine?`, `endLine?`, `maxLines?`, plus `workspaceRoot` + `format`. **Read-only.** |
| `git_branch_list` | `rethunk-git_git_branch_list` | List local branches (sha, current marker, upstream); optional `includeRemotes` adds remote-tracking branches. Args: `includeRemotes?`, plus `workspaceRoot` + `format`. **Read-only.** |
| `git_reflog` | `rethunk-git_git_reflog` | Show the reflog for a ref (default `HEAD`) — recent HEAD movements with selector, SHA, and message. Args: `ref?`, `maxEntries?`, plus `workspaceRoot` + `format`. **Read-only.** |
| `git_fetch` | `rethunk-git_git_fetch` | Fetch from a remote without modifying the working tree. Updates refs only and reports updated/new refs, plus structured `updated`/`created`/`pruned` deltas on git ≥ 2.41. Args: `remote?`, `branch?`, `prune?`, `tags?`, plus `workspaceRoot` + `format`. **Mutating — refs only.** |
| `git_push` | `rethunk-git_git_push` | Push the current branch to its upstream. Optional `remote`, `branch`, `setUpstream` (passes `-u`). Refuses on detached HEAD; never force-pushes. `workspaceRoot` + `format`. **Mutating.** |
| `git_tag` | `rethunk-git_git_tag` | Create/delete annotated or lightweight tags for one repo. Args: `tag`, `message?`, `ref?`, `delete?`, plus `workspaceRoot` + `format`. **Mutating.** |
| `git_worktree_add` | `rethunk-git_git_worktree_add` | Create a new linked worktree, creating the branch from `baseRef` if it does not yet exist. Refuses on protected branch names. Args: `path`, `branch`, `baseRef?`, plus `workspaceRoot` + `format`. **Mutating.** |
| `git_worktree_remove` | `rethunk-git_git_worktree_remove` | Remove a registered worktree; refuses to remove the main worktree. Optional `force: true` for dirty trees. Args: `path`, `force?`, plus `workspaceRoot` + `format`. **Mutating.** |
| `git_reset_soft` | `rethunk-git_git_reset_soft` | Soft-reset the current branch to a ref (`HEAD~N`, SHA, branch). Rewound changes land in the staging index; requires a clean working tree. Args: `ref`, plus `workspaceRoot` + `format`. **Mutating — not idempotent.** |
| `batch_commit` | `rethunk-git_batch_commit` | Create multiple sequential git commits in a single call. Each entry stages the listed files or line-ranged file hunks, then commits with the given message. Stops on first failure. Optional `push: "after"` pushes once every commit lands; optional `dryRun: true` previews staged content without writing commits. Args: `commits` (array of `{message, files}`), `push?`, `dryRun?`, plus `workspaceRoot` + `format`. **Mutating — not idempotent.** |
| `git_merge` | `rethunk-git_git_merge` | Merge one or more source branches into a destination. Default strategy `auto` cascades fast-forward → rebase → merge-commit per source, preferring linear history. Refuses on dirty tree; stops on first conflict with structured path report. Optional `deleteMergedBranches` / `deleteMergedWorktrees` cascade cleanup, always skipping protected names (main/master/dev/develop/stable/trunk/prod/production/release\*/hotfix\*). Args: `sources`, `into?`, `strategy?`, `message?`, cleanup flags + `workspaceRoot` + `format`. **Mutating.** |
| `git_cherry_pick` | `rethunk-git_git_cherry_pick` | Play commits from one or more sources onto a destination. Sources may be SHAs, `A..B` ranges, or branch names (expanded to `onto..<branch>`, oldest-first). Uses `--empty=drop` so patch-equivalent re-applies add nothing. Refuses on dirty tree; stops on first conflict, aborting cleanly. Same cleanup flags as `git_merge` (branch-kind sources only, protected names skipped); branch deletion uses patch-id equivalence by default so cherry-pick workflows (where SHA differs but diff is identical) clean up correctly. Pass `strictMergedRefEquality: true` for strict `git branch -d` ancestry semantics. Args: `sources`, `onto?`, cleanup flags, `strictMergedRefEquality?` + `workspaceRoot` + `format`. **Mutating.** |
| `git_stash_apply` | `rethunk-git_git_stash_apply` | Apply or pop a stash entry for one repo. Args: `index?`, `pop?`, plus `workspaceRoot` + `format`. **Mutating.** |

Pass **`format: "json"`** on any tool for structured JSON instead of markdown (default).

---

### `git_status` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `includeSubmodules` | boolean | `true` | When `true`, reads `.gitmodules` at each git toplevel and runs `git status --short -b` for each checked-out submodule in parallel. Set `false` to skip submodule discovery entirely. |
| `root` | string \| string[] \| `"*"` | — | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | `"markdown"` | Output format. |

### `git_status` — JSON shape (`format: "json"`)

```json
{
  "groups": [{
    "mcpRoot": "/abs/workspace",
    "repos": [
      { "label": ".", "path": "/abs/workspace", "statusText": "## main...origin/main\nM src/foo.ts", "ok": true },
      { "label": "sub", "path": "/abs/workspace/sub", "statusText": "## main...origin/main", "ok": true }
    ]
  }]
}
```

One `groups` entry per resolved root. Each `repos` entry has `label` (relative path, `"."` for the root), `path` (absolute), `statusText` (full `git status --short -b` output), and `ok` (`false` when git failed or the submodule is not checked out).

### `git_status` — error codes

Error payloads appear as top-level JSON or inline in individual repo rows (`ok: false`):

| Code / statusText | Context | Meaning |
|-------------------|---------|---------|
| `git_not_found` | top-level | `git` binary not on `PATH`. |
| `not_a_git_repository` | repo row `statusText` | Root is not inside a git repository. |
| `(submodule path escapes repository — rejected)` | repo row `statusText` | `.gitmodules` path resolves outside the git toplevel (security guard). |
| `(no .git — submodule not checked out?)` | repo row `statusText` | Submodule directory exists but has no `.git` — not initialized. |
| `invalid_root_path` | top-level | A `root` array entry is empty or not a git-recognized directory. |
| `root_list_too_many` | top-level | More than 256 entries in the `root` array. |
| `root_list_empty` | top-level | The `root` array resolved to zero git toplevels. |

---

### `git_inventory` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `nestedRoots` | string[] | — | Relative paths (from the workspace git toplevel) to treat as independent git repos to inventory. Each must be a valid git work tree; invalid paths produce skip entries rather than errors. Cannot combine with an array `root` or `preset`. |
| `preset` | string | — | Preset name from `.rethunk/git-mcp-presets.json`. Loads `nestedRoots` from the preset's entry. Cannot combine with an array `root`. |
| `presetMerge` | boolean | `false` | When `true`, merge inline `nestedRoots` with preset roots instead of replacing. |
| `remote` | string | — | Fixed remote for ahead/behind tracking. Must be paired with `branch`. |
| `branch` | string | — | Fixed branch for ahead/behind tracking. Must be paired with `remote`. When both are absent the tool uses each repo's `@{u}` upstream. |
| `maxRoots` | int | `64` | Max nested roots to process (1–256). Roots beyond the limit are omitted; `nestedRootsTruncated: true` and `nestedRootsOmittedCount` are set on the group. |
| `root` | string \| string[] \| `"*"` | — | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. | Array form cannot combine with `nestedRoots` or `preset`.
| `format` | `"markdown"` \| `"json"` | `"markdown"` | Output format. |

### `git_inventory` — JSON shape (`format: "json"`)

```json
{
  "inventories": [{
    "workspace_root": "/abs/path",
    "entries": [{
      "label": ".",
      "path": "/abs/path",
      "upstreamMode": "auto",
      "branchStatus": "## main...origin/main",
      "headAbbrev": "a1b2c3d",
      "upstreamRef": "origin/main",
      "ahead": "2",
      "behind": "0"
    }],
    "nestedRootsTruncated": true,
    "nestedRootsOmittedCount": 3,
    "upstream": { "mode": "fixed", "remote": "origin", "branch": "main" }
  }]
}
```

`nestedRootsTruncated` / `nestedRootsOmittedCount` present only when `maxRoots` cut the list. `upstream` object present only when `remote`+`branch` were supplied (fixed mode). `presetSchemaVersion` present only when a preset was loaded. See *Field omission* for `entries[*]` optional fields.

### `git_inventory` — error codes

| Code | Meaning |
|------|---------|
| `git_not_found` | `git` binary not on `PATH`. |
| `remote_branch_mismatch` | Only one of `remote` / `branch` was provided; supply both or neither. |
| `invalid_remote_or_branch` | `remote` or `branch` contains characters outside the safe token set. |
| `root_list_nested_or_preset_conflict` | `root` array combined with `nestedRoots` or `preset`. |
| `root_list_preset_conflict` | `root` array combined with a `preset` argument. |
| `invalid_root_path` | A `root` array entry is empty or not a git-recognized directory. |
| `root_list_too_many` | More than 256 entries in the `root` array. |
| `root_list_empty` | The `root` array resolved to zero git toplevels. |
| `preset_not_found` | Named preset does not exist in the preset file. |
| `invalid_json` | Preset file contains invalid JSON. |
| `invalid_schema` | Preset file fails schema validation. |

Skip entries (individual repos that could not be inventoried) appear inline in `entries[*]` with `skipReason` rather than as top-level errors.

---

### `git_parity` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `pairs` | `{left: string, right: string, label?: string}[]` | Path pairs to compare. `left` and `right` are relative to the workspace git toplevel. `label` is optional display name; defaults to `"left / right"`. At least one pair required (via inline `pairs` or `preset`). |
| `preset` | string | Preset name from `.rethunk/git-mcp-presets.json`. Loads `parityPairs` from the preset's entry. |
| `presetMerge` | boolean | Default `false`. When `true`, merge inline `pairs` with preset pairs instead of replacing. |
| `root` | string \| string[] \| `"*"` | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | Output format. Default: `"markdown"`. |

### `git_parity` — JSON shape (`format: "json"`)

```json
{
  "parity": [{
    "workspace_root": "/abs/path",
    "status": "MISMATCH",
    "pairs": [
      {
        "label": "shared",
        "leftPath": "/abs/path/left",
        "rightPath": "/abs/path/right",
        "match": true,
        "sha": "a1b2c3d4e5f6…"
      },
      {
        "label": "config",
        "leftPath": "/abs/path/cfg-a",
        "rightPath": "/abs/path/cfg-b",
        "match": false,
        "leftSha": "a1b2c3d…",
        "rightSha": "f9e8d7c…"
      }
    ]
  }]
}
```

`status` is `"OK"` when every pair matches, `"MISMATCH"` when any pair differs or errors. On a match, `sha` carries the common HEAD SHA. On a mismatch, `leftSha` / `rightSha` carry the differing SHAs. On error (path escape or `git rev-parse HEAD` failure), `error` carries a description string and both SHA fields are absent. `presetSchemaVersion` is present when a preset was loaded.

### `git_parity` — error codes

| Code | Meaning |
|------|---------|
| `git_not_found` | `git` binary not on `PATH`. |
| `no_pairs` | Neither inline `pairs` nor a preset with `parityPairs` was supplied. |
| `root_list_preset_conflict` | `root` array combined with a `preset` argument. |
| `invalid_root_path` | A `root` array entry is empty or not a git-recognized directory. |
| `root_list_too_many` | More than 256 entries in the `root` array. |
| `root_list_empty` | The `root` array resolved to zero git toplevels. |
| `preset_not_found` | Named preset does not exist in the preset file. |
| `invalid_json` | Preset file contains invalid JSON. |
| `invalid_schema` | Preset file fails schema validation. |

Path-escape and `rev-parse` failures are reported inline in `pairs[*].error`, not as top-level error codes.

---

### `list_presets` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `root` | string \| string[] \| `"*"` | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | Output format. Default: `"markdown"`. |

### `list_presets` — JSON shape (`format: "json"`)

```json
{
  "roots": [{
    "workspaceRoot": "/abs/workspace",
    "gitTop": "/abs/workspace",
    "presetFile": "/abs/workspace/.rethunk/git-mcp-presets.json",
    "fileExists": true,
    "presetSchemaVersion": "1",
    "presets": [
      {
        "name": "monorepo",
        "nestedRootsCount": 5,
        "parityPairsCount": 2,
        "workspaceRootHint": "/abs/workspace"
      }
    ]
  }]
}
```

`gitTop` is `null` when the workspace root is not inside a git repository. `presetSchemaVersion` is omitted when absent. `workspaceRootHint` is omitted when not set. When `fileExists: false` the `presets` array is empty and no `error` is present. When the file exists but fails to load, `error` contains a structured error object and `presets` is empty.

### `list_presets` — error codes

| Code | Meaning |
|------|---------|
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repository` | Root is not inside a git repository (reported inline in the `roots[*].error` field, not top-level). |
| `invalid_json` | Preset file is not valid JSON (inline in `roots[*].error`). |
| `invalid_schema` | Preset file fails schema validation (inline in `roots[*].error`). |
| `invalid_root_path` | A `root` array entry is empty or not a git-recognized directory. |
| `root_list_too_many` | More than 256 entries in the `root` array. |
| `root_list_empty` | The `root` array resolved to zero git toplevels. |

---

## JSON responses

Tool JSON bodies are minified and contain only the payload — no `rethunkGitMcp` envelope. Current `MCP_JSON_FORMAT_VERSION` is **`"5"`** (exported constant in `src/server.ts`); the version string is surfaced in the FastMCP `instructions` field and is therefore discoverable via the MCP `initialize` response. Payload keys (`groups`, `inventories`, `parity`, `roots`) are stable within a given format version. Preset-related responses may include **`presetSchemaVersion`**.

v5 changes from v4: `batch_commit` successful `results[*]` entries drop the echoed `message`/`files` (the caller already supplied both in the request); failing entries still carry `message`/`files` alongside `error`/`detail` for diagnosis.

v4 changes from v3: `git_blame` output is run-length grouped (`lines[]` with per-line commit metadata → `groups[]` with metadata once per contiguous same-commit run); `git_diff_summary` per-file `truncated` is omitted when `false`.

The package also ships **`tool-parameters.schema.json`**, generated from the registered Zod parameter schemas via `bun run schema:tools`, plus the published **`schemas/`** directory (`schemas/index.json` + one JSON Schema per tool) via `bun run schema:individual`. Connected MCP clients should still prefer live schema discovery from `initialize` / tool listing; the shipped artifacts are for offline inspection, drift checks, and code generation.

### Field omission (consumer contract, v2+)

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

**When to bump `MCP_JSON_FORMAT_VERSION` or change payload shape:** [AGENTS.md](../AGENTS.md) — *Changing contracts*. The constant lives in `src/server.ts` and is surfaced via the server `instructions` field (discoverable from the MCP `initialize` response).

### `git_log` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `since` | string | `"7.days"` | Passed to `git log --since=`. Accepts ISO timestamps (`2026-04-01T00:00:00Z`) or git relative forms (`48.hours`, `2.weeks.ago`). |
| `paths` | string[] | (all) | Restrict to commits touching these paths (appended after `--`). |
| `grep` | string | — | Filter by commit message regex (git `--grep`, always case-insensitive). |
| `author` | string | — | Filter by author name or email (`--author=`). |
| `maxCommits` | int | `50` | Max commits per root. Hard cap: `500`. |
| `branch` | string | `HEAD` | Ref/branch to log from. |
| `root` | string \| string[] \| `"*"` | — | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` \| `"oneline"` | `"markdown"` | Output format. `oneline` returns `<sha7> <subject>` per line with no headers (single root) or `### repo (branch)` separators per group (multi-root). Lowest-token option for post-commit verification. |

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
| `unsafe_ref_token` | `branch` contains characters outside the argv-safe subset. |
| `git_log_failed` | `git log` exited non-zero (e.g. unknown branch ref). |
| `root_list_preset_conflict` | `root` array was combined with a `preset` argument (root resolution). |
| `invalid_root_path` | A `root` array entry is empty, not inside a git worktree, or not a directory git recognizes. |
| `root_list_too_many` | More than 256 entries in the `root` array. |
| `root_list_empty` | The `root` array produced zero git toplevels after resolution. |

### `git_parity` — `root` array example

Pass a `root` array when the same parity pair should be checked across sibling clones that are not all MCP workspace roots:

```json
{
  "format": "json",
  "root": [
    "/usr/local/src/com.github/Rethunk-AI/mcp-multi-root-git",
    "/usr/local/src/com.github/Rethunk-AI/rethunk-github-mcp"
  ],
  "pairs": [{ "left": "packages/shared", "right": "apps/web/shared", "label": "shared" }]
}
```

The response contains one **`parity[]`** entry per resolved git toplevel. An array `root` cannot be combined with `preset`; pass inline `pairs` for sibling-clone batches.

**Diff-family filtering divergence (intentional):** `git_diff_summary` filters client-side via a `fileFilter` glob applied to the summarized file list; `git_diff` and `git_show` instead take server-confined `paths[]` (each entry validated with `resolvePathForRepo`/`assertRelativePathUnderTop` and rejected with `path_escapes_repo` on escape). Don't expect glob syntax on `git_diff`/`git_show` `paths[]`, and don't expect path confinement guarantees on `git_diff_summary`'s `fileFilter`.

### `git_diff_summary` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `range` | string | unstaged | Diff range. `"staged"` / `"cached"` for index; `"HEAD"` for last commit; `"A..B"` or `"A...B"` for revision ranges; single ref. Default: unstaged working-tree changes. |
| `fileFilter` | string | — | Glob pattern to restrict output to matching files (e.g. `"*.ts"`, `"src/**"`). |
| `maxLinesPerFile` | int | `50` | Max diff lines to include per file (1–2000). |
| `maxFiles` | int | `30` | Max files to include in output (1–500). |
| `excludePatterns` | string[] | lock files, dist, vendor | Glob patterns to exclude. Defaults to `*.lock`, `*.lockb`, `bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `*.min.js`, `*.min.css`, `vendor/**`, `node_modules/**`, `dist/**`. Pass an empty array to disable. |
| `workspaceRoot` | string | — | Repo path. Default: first MCP root / cwd. |
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
    "diff": "@@ -1,3 +1,8 @@\n-const x = 1;\n+const x = 2;"
  }],
  "truncatedFiles": 1,
  "excludedFiles": ["yarn.lock"]
}
```

`status` is one of `"modified"`, `"added"`, `"deleted"`, `"renamed"`. `oldPath` is present only for renamed files. Per-file `truncated` is present (`true`) only when the diff body was cut at `maxLinesPerFile` (v4). `truncatedFiles` and `excludedFiles` are omitted when zero/empty (field-omission contract).

### `git_diff_summary` — error codes

| Code | Meaning |
|------|---------|
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |
| `unsafe_range_token` | The `range` string contains characters outside the safe token set. |
| `git_diff_failed` | `git diff` exited non-zero. |

---

### `git_diff` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `base` | string | — | Base ref for a revision diff. When omitted with no `staged`, the tool shows unstaged changes. Ancestor notation (`HEAD~3`, `main^2`) is accepted. |
| `head` | string | `HEAD` | Head ref for a revision diff. Used only when `base` is provided. Ancestor notation (`HEAD~3`, `main^2`) is accepted. |
| `path` | string | — | Optional single file path to scope the diff. Confined to the repo (`path_escapes_repo` on escape). |
| `paths` | string[] | — | Multiple file paths to scope the diff; unioned with `path` (deduped). Each confined to the repo. |
| `unified` | integer | — | Context lines around each change (passed as `-U<n>`, 0–100). Omit for git's default (3). |
| `staged` | boolean | `false` | When `true`, runs `git diff --staged`. Ignored when `base` is provided. |
| `workspaceRoot` | string | — | Repo path. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | `"markdown"` | Output format. |

`git_diff` is a single-repo tool; use `workspaceRoot` to select the target repo.

### `git_diff` — JSON shape (`format: "json"`)

```json
{
  "range": "HEAD~1..HEAD (src/server.ts)",
  "diff": "diff --git a/src/server.ts b/src/server.ts\n..."
}
```

### `git_diff` — error codes

| Code | Meaning |
|------|---------|
| `unsafe_range_token` | `base` or `head` contains characters outside the argv-safe subset. |
| `path_escapes_repo` | A `path` / `paths` entry resolves outside the git toplevel. |
| `git_diff_failed` | `git diff` exited non-zero. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_show` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `ref` | string | Commit, branch, tag, or other git rev-spec to inspect. Ancestor notation (`HEAD~3`, `main^2`) is accepted. |
| `path` | string | Optional single path. When provided, the response shows that path's content at `ref` instead of the full commit diff. |
| `stat` | boolean | When `true`, runs `git show --stat` — commit message plus per-file diffstat, no full patch (`statOutput` in JSON). |
| `paths` | string[] | Filter the shown patch/stat to these repo-relative paths; unioned with `path`. Each confined to the repo. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_show` — JSON shape (`format: "json"`)

```json
{
  "ref": "HEAD",
  "message": "feat: add tool",
  "path": "src/server.ts",
  "diff": "diff --git a/src/server.ts b/src/server.ts\n..."
}
```

`path` is omitted when not requested; `paths` is present when multiple paths were given. `diff` is omitted when `git show` returns only a commit message. With `stat: true`, `stat` is `true` and `statOutput` carries the diffstat instead of a full `diff`.

### `git_show` — error codes

| Code | Meaning |
|------|---------|
| `unsafe_ref_token` | `ref` contains characters outside the argv-safe subset. |
| `path_escapes_repo` | `path` resolves outside the git toplevel. |
| `git_show_failed` | `git show` exited non-zero (e.g. unknown ref). |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_stash_list` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_stash_list` — JSON shape (`format: "json"`)

```json
{
  "stashes": [
    { "index": 0, "message": "WIP on main: abc1234 feat: add tool", "sha": "abc1234" }
  ]
}
```

### `git_stash_list` — error codes

| Code | Meaning |
|------|---------|
| `stash_list_failed` | `git stash list` failed unexpectedly. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_fetch` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `remote` | string | `"origin"` | Remote to fetch from. |
| `branch` | string | — | Optional branch/ref to fetch from that remote. |
| `prune` | boolean | `false` | Pass `--prune` to remove deleted remote-tracking refs. |
| `tags` | boolean | `false` | Pass `--tags` to also fetch all tags. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_fetch` — JSON shape (`format: "json"`)

```json
{
  "ok": true,
  "remote": "origin",
  "updatedRefs": ["abc1234..def5678  main       -> origin/main"],
  "newRefs": ["[new tag]        v2.0.0     -> v2.0.0"],
  "updated": [{ "ref": "refs/remotes/origin/main", "oldSha": "abc1234…", "newSha": "def5678…", "flag": " " }],
  "created": [{ "ref": "refs/tags/v2.0.0", "newSha": "0a1b2c3…", "flag": "*" }],
  "pruned": [{ "ref": "refs/remotes/origin/old" }],
  "output": "From origin\n..."
}
```

`updated` / `created` / `pruned` are structured ref deltas parsed from `git fetch --porcelain` (git ≥ 2.41), each omitted when empty. On older git the `--porcelain` option is detected as unsupported and the tool falls back to a plain fetch, omitting the structured arrays; the `updatedRefs` / `newRefs` string fields are always present for back-compat. Fetch failures are reported as `ok: false` with the captured git output in `output`.

### `git_fetch` — error codes

| Code | Meaning |
|------|---------|
| `unsafe_remote_token` | `remote` contains characters outside the argv-safe subset. |
| `unsafe_ref_token` | `branch` contains characters outside the argv-safe subset. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_blame` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `path` | string | — | **Required.** Repo-relative file to annotate. Confined to the repo (`path_escapes_repo` on escape). |
| `ref` | string | working tree | Commit-ish to blame at. Validated as a safe ref token. Ancestor notation (`HEAD~3`, `main^2`) is accepted. |
| `startLine` | int | — | Start of a line range (`-L`). Requires `endLine`. Max `1000000`. |
| `endLine` | int | — | End of the line range, inclusive. Requires `startLine`. Max `1000000`. |
| `maxLines` | int | `2000` | Max blamed lines to return (1–10000). Excess lines are dropped and signalled via `truncated`/`omittedLines`. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_blame` — JSON shape (`format: "json"`)

```json
{
  "ref": "HEAD",
  "path": "src/server.ts",
  "groups": [
    {
      "sha": "a1b2c3d4…",
      "author": "Damon Blais",
      "date": "2026-04-12T18:32:01-07:00",
      "summary": "feat: add tool",
      "startLine": 1,
      "endLine": 2,
      "lines": [
        { "line": 1, "content": "import { FastMCP } from \"fastmcp\";" },
        { "line": 2, "content": "" }
      ]
    }
  ],
  "truncated": true,
  "omittedLines": 120
}
```

One `groups` entry per **contiguous run of lines last touched by the same commit** (v4 run-length grouping — commit metadata is emitted once per run, not once per line). `ref` is omitted when blaming the working tree. `truncated`/`omittedLines` are omitted unless `maxLines` cut the output.

### `git_blame` — error codes

| Code | Meaning |
|------|---------|
| `path_escapes_repo` | `path` resolves outside the git toplevel. |
| `unsafe_ref_token` | `ref` contains characters outside the argv-safe subset. |
| `invalid_line_range` | Only one of `startLine`/`endLine` was given, or `startLine > endLine`. |
| `git_blame_failed` | `git blame` exited non-zero (unknown path/ref). `detail` carries stderr. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_branch_list` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `includeRemotes` | boolean | `false` | Also list remote-tracking branches (`refs/remotes`); symbolic `origin/HEAD` is skipped. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_branch_list` — JSON shape (`format: "json"`)

```json
{
  "branches": [
    { "name": "main", "sha": "a1b2c3d4…", "current": true, "upstream": "origin/main" },
    { "name": "feature/x", "sha": "b2c3d4e5…", "current": false }
  ],
  "remotes": [{ "name": "origin/main", "sha": "a1b2c3d4…" }]
}
```

`upstream` is omitted when a branch has no upstream. `remotes` is present only when `includeRemotes: true`.

### `git_branch_list` — error codes

| Code | Meaning |
|------|---------|
| `branch_list_failed` | `git for-each-ref` exited non-zero. `detail` carries stderr. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_reflog` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `ref` | string | `HEAD` | Ref whose reflog to show. Validated as a safe ref token. |
| `maxEntries` | int | `30` | Max entries to return (1–200). |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_reflog` — JSON shape (`format: "json"`)

```json
{
  "ref": "HEAD",
  "entries": [
    { "sha": "a1b2c3d4…", "selector": "HEAD@{0}", "message": "commit: feat: add tool" }
  ]
}
```

### `git_reflog` — error codes

| Code | Meaning |
|------|---------|
| `unsafe_ref_token` | `ref` contains characters outside the argv-safe subset. |
| `reflog_failed` | `git reflog show` exited non-zero. `detail` carries stderr. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `batch_commit` — atomic staging semantics

**Critical for AI agents:** Each call to `batch_commit` is **self-contained and atomic per-commit entry**.

- **All files in a single entry are staged together.** When you list `files: ["src/foo.ts", "src/bar.ts"]` in one commit entry, both are staged atomically as a unit with a single `git add` before the commit is created.
- **Each commit entry is processed sequentially within the call.** The tool stages files, commits, then moves to the next entry. All entries within a single `batch_commit` call happen in one atomic MCP transaction.
- **A single `batch_commit` call cannot be split across multiple MCP calls.** Do NOT attempt incremental staging like "call 1 with file A, then call 2 with file B hoping they stage together." Each call is independent — call 1's commit lands immediately; call 2's changes are a separate transaction.
- **Failed entry stops the batch.** If staging or commit fails on entry N, the tool aborts and skips remaining entries. However, **entries that succeeded before the failure remain committed** — they are not rolled back.
- **Include all files for a logical change in a single `batch_commit` call.** Group related files in each commit entry, list them all in the `files` array, and include all necessary entries in the `commits` array.

Example: to commit two related changes atomically, pass both entries in one call:
```json
{
  "commits": [
    { "message": "feat: add foo module", "files": ["src/foo.ts", "tests/foo.test.ts"] },
    { "message": "feat: integrate foo into bar", "files": ["src/bar.ts", "docs/foo.md"] }
  ]
}
```

Do NOT do this: make two separate calls hoping to stage files incrementally. That breaks the contract.

### `batch_commit` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `commits` | `{message: string, files: (string \| {path: string, lines: {from: number, to: number}})[]}[]` | Commits to create in order. 1–50 entries. Each `files` entry is either: (a) a path relative to the git root, staged with `git add`; (b) a `{path, lines: {from, to}}` object for hunk-level staging — only unified-diff hunks overlapping the given 1-indexed line range are staged (`from`/`to` each max `1000000`); or (c) a path to a **deleted tracked file** (missing on disk but tracked in HEAD), which is staged as a removal via `git rm --cached` — combining `{path, lines}` with a deleted file is an error. All paths must stay within the git toplevel. |
| `push` | `"never"` \| `"after"` | Default `"never"`. `"after"` pushes the current branch to its upstream **once all commits succeed**. Never auto-sets upstream — branches without an upstream fail with `push_no_upstream`. Commits are **not** rolled back on push failure. |
| `dryRun` | boolean | Default `false`. When `true`, stages each entry, reports what would be committed (`staged`, `diffStat`), then unstages everything without writing commits. |
| `workspaceRoot` | string | Repo path. Default: first MCP root / cwd. |
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
    "sha": "a1b2c3d"
  }, {
    "index": 1,
    "ok": true,
    "sha": "b2c3d4e"
  }],
  "push": {
    "ok": true,
    "branch": "main",
    "upstream": "origin/main"
  }
}
```

Successful `results[*]` entries carry only what's needed to confirm the commit landed (`index`, `ok`, `sha`, plus `output` when git printed something) — they omit `message`/`files` since the caller already supplied both in the request. Failing entries echo `message` and `files` back (alongside `error`/`detail`) so the caller can identify the failed commit without cross-referencing the request.

On first failure `ok` is `false`, `committed` reflects only the entries that succeeded before the error, and the failing entry includes `message`, `files`, `error`, and `detail` fields. Remaining entries are skipped and not included in `results`.

When `dryRun: true`, the top-level response includes `dryRun: true`; successful `results[*]` entries omit `sha` and instead include `staged` and `diffStat`.

The `push` object is present only when `push: "after"` was requested **and** every commit landed. On push failure the top-level `ok` stays `true` (the commits themselves succeeded) while `push.ok` is `false` and `push.error` carries the code.

### `batch_commit` — error codes (per-result `error` field)

| Code | Meaning |
|------|---------|
| `path_escapes_repository` | One of the listed file paths resolves outside the git toplevel. |
| `stage_failed` | Staging failed. `git add` error for modified/new files; `git rm --cached` error for deleted files (e.g. path never tracked in HEAD); `{path, lines}` on a deleted file. |
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
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

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
| `deleteMergedBranches` | boolean | Default `false`. After all commits apply, delete each **branch-kind** source locally. Deletion uses **patch-id equivalence** by default — correct for cherry-pick workflows where SHA differs but diff is identical. Protected names always skipped; never touches remote refs. |
| `deleteMergedWorktrees` | boolean | Default `false`. After success, remove any local worktree attached to a branch-kind source (`git worktree remove`). Protected tails always skipped. |
| `strictMergedRefEquality` | boolean | Default `false`. When `true`, branch deletion uses strict SHA-reachability (`git branch -d` ancestry semantics) instead of patch-id equivalence. Use when you need git's exact ancestry guarantee rather than content equivalence. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

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

For already-committed work, call **`git_push`** directly instead of creating an empty commit or falling back to shell. Continue to prefer **`batch_commit`** with **`push: "after"`** when commits and push happen in the same MCP call.

| Parameter | Type | Notes |
|-----------|------|-------|
| `remote` | string | Remote to push to. Defaults to the remote inferred from the upstream tracking ref, or `origin` when `setUpstream` is true. |
| `branch` | string | Branch to push. Defaults to the currently checked-out branch. Rejected on detached HEAD. |
| `setUpstream` | boolean | Default `false`. Pass `-u` to set the upstream tracking ref; remote defaults to `origin`. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

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

### `git_tag` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `tag` | string | — | Tag name to create or delete. |
| `message` | string | — | When provided, creates an annotated tag; otherwise creates a lightweight tag. |
| `ref` | string | `HEAD` | Commit/ref to tag. Ignored when `delete: true`. |
| `delete` | boolean | `false` | Delete the named tag instead of creating it. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_tag` — JSON shape (`format: "json"`)

```json
{ "tag": "v2.3.5", "type": "annotated", "sha": "a1b2c3d4e5f6..." }
```

For deletions, `type` is `"deleted"` and `sha` is an empty string.

### `git_tag` — error codes

| Code | Meaning |
|------|---------|
| `empty_tag_name` | `tag` trimmed to an empty string. |
| `unsafe_tag_token` | `tag` contains disallowed characters. |
| `unsafe_ref_token` | `ref` contains disallowed characters. |
| `ref_not_found` | `ref` did not resolve to a commit. |
| `tag_create_failed` | `git tag` failed while creating the tag. |
| `tag_delete_failed` | `git tag -d` failed. |
| `tag_verification_failed` | The tag could not be read back after creation. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_reset_soft` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `ref` | string | Target commit: `HEAD~N`, branch name, or full/short SHA. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

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

### `git_stash_apply` — parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `index` | int | `0` | Stash index to apply/pop (`stash@{index}`). Max `10000`. |
| `pop` | boolean | `false` | When `true`, runs `git stash pop` instead of `git stash apply`. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_stash_apply` — JSON shape (`format: "json"`)

```json
{
  "applied": true,
  "stashIndex": 0,
  "popped": false,
  "output": "On branch main\nChanges not staged for commit:\n..."
}
```

`output` is omitted when git produced no stdout/stderr text.

### `git_stash_apply` — error codes

| Code | Meaning |
|------|---------|
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
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

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
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_worktree_remove` — error codes

| Code | Meaning |
|------|---------|
| `cannot_remove_main_worktree` | `path` resolves to the main (non-linked) worktree. |
| `worktree_not_found` | `path` is not registered as a worktree in this repo. |
| `worktree_remove_failed` | `git worktree remove` failed. Pass `force: true` if there are uncommitted changes. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

## Environment

| Variable | Default | Notes |
|----------|---------|-------|
| `GIT_SUBPROCESS_PARALLELISM` | CPU-based | Max concurrent git subprocesses for multi-root fan-out (`git_inventory`, `git_parity`, multi-root `git_log`). |
| `GIT_SUBPROCESS_TIMEOUT_MS` | `120000` | Per-subprocess timeout in ms; on expiry the child is killed (SIGTERM) and the call resolves as failed. Set `0` (or negative) to disable (unbounded). |
| `RETHUNK_GIT_TOOLS` | _(unset — all)_ | Comma-separated allowlist of exact tool names. Unset or empty → all 23 tools registered. Non-empty → only the listed tools; unknown names warned to stderr. If every listed name is unknown, zero tools are registered (restriction honored literally). The presets resource is always available. Example: `RETHUNK_GIT_TOOLS=git_status,git_diff_summary,git_diff,git_log,batch_commit,git_push`. |

## Resource

| URI | Purpose |
|-----|---------|
| `rethunk-git://presets` | JSON snapshot of `.rethunk/git-mcp-presets.json` at the resolved git toplevel (or structured errors). |

## Root resolution

Every tool carries exactly **one** routing parameter:

| Tools | Parameter | Accepts |
|-------|-----------|---------|
| Fan-out: `git_status`, `git_inventory`, `git_parity`, `list_presets`, `git_log` | `root` | string (one repo path) \| string[] (explicit repo list) \| `"*"` (every MCP root) |
| All other 18 tools | `workspaceRoot` | string (one repo path) |

### `root` forms (fan-out tools)

- **string** — resolve that one path (same semantics as `workspaceRoot`).
- **string[]** — explicit repo list (sibling clones). Each entry is passed through `path.resolve`, then resolved to a **git toplevel**; duplicate toplevels are dropped (stable order, first wins). Max **256** paths (`root_list_too_many`); an entry that is not inside a git repo returns `invalid_root_path`; zero resolved toplevels returns `root_list_empty`. Cannot be combined with a `preset` argument (`root_list_preset_conflict`; `git_inventory` also rejects arrays combined with `nestedRoots` — `root_list_nested_or_preset_conflict`).
- **`"*"`** — every `file://` root reported by the MCP client; markdown output emits one `# {tool}` header with per-root subsections (`git_inventory` uses `### {gitTop}`; `git_status` uses `### MCP root: ...`), or combined JSON.

Example — two sibling repos in one `git_status` call:

```json
{
  "format": "json",
  "root": [
    "/usr/local/src/com.github/Rethunk-AI/mcp-multi-root-git",
    "/usr/local/src/com.github/Rethunk-AI/rethunk-github-mcp"
  ]
}
```

### Default order (when `root` / `workspaceRoot` is omitted)

1. **`preset`** set and multiple MCP roots (fan-out tools) — first root whose git toplevel defines that preset (respecting **`workspaceRootHint`** on the preset entry when present).
2. Otherwise the first `file://` root reported by the MCP client through **`roots/list`**.
3. **`process.cwd()`** if no file roots (e.g. CI with explicit `workspaceRoot`).

Roots come from active MCP sessions (**`FastMCP` with `roots: { enabled: true }`** in code); there is no fixed `cwd` in server config. This is what allows one globally installed server to follow the workspace opened in VS Code, Claude Code, Cursor, or any other roots-capable MCP client.
