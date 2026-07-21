# MCP tools and resources (canonical reference)

Single source of truth for **registered tool ids**, **client naming**, **JSON output shape**, **resource URI**, and **root resolution**.  
**Install and MCP clients (only canonical location):** [install.md](install.md). **Preset file, dev, CI, publishing:** [HUMANS.md](../HUMANS.md). **Implementation layout (`src/server/` + entry [`server.ts`](../src/server.ts)), contract bumps:** [AGENTS.md](../AGENTS.md).

## Naming

MCP clients expose tools as `{serverName}_{toolName}`. With the server registered as **`rethunk-git`**, examples use the prefix **`rethunk-git_`**.

## Tools

| Short id | Client id (server `rethunk-git`) | Purpose |
| ---------- | ----------------------------------- | --------- |
| `git_status` | `rethunk-git_git_status` | `git status --short -b` per MCP root and optional submodules (`includeSubmodules`); parallel submodule status. Args: `includeSubmodules`, `root`, `format`. **Read-only.** |
| `git_inventory` | `rethunk-git_git_inventory` | Status + ahead/behind per path; default upstream each repo’s `@{u}`; pass **both** `remote` and `branch` for fixed tracking; optional `compareRefs: { left, right }` for ahead/behind between arbitrary local refs (independent of upstream). `nestedRoots`, `preset`, `presetMerge`, `maxRoots`, `format`, plus `root` (array form cannot combine with `preset`/`nestedRoots`). **Read-only.** |
| `git_parity` | `rethunk-git_git_parity` | Compare `git rev-parse HEAD` for path pairs. `pairs`, `preset`, `presetMerge`, `format`, plus `root`. **Read-only.** |
| `list_presets` | `rethunk-git_list_presets` | List preset names/counts from `.rethunk/git-mcp-presets.json`; invalid JSON/schema surface as errors. `root` + `format` only. **Read-only.** |
| `git_log` | `rethunk-git_git_log` | Path-filtered, time-windowed `git log` across one or more roots. Returns commit history with author, date, subject, and shortstat. Optional `follow: true` follows renames (`git log --follow`; requires exactly one `paths` entry). Args: `since`, `paths`, `follow?`, `grep`, `author`, `maxCommits`, `branch`, plus `root` + `format` (`markdown`/`json`/`oneline`). **Read-only.** |
| `git_grep` | `rethunk-git_git_grep` | Read-only pickaxe history search across one or more roots (`pickaxe: { mode: "S"\|"G", term }` → `git log -S`/`-G`, `commits[]` per root). `pickaxe` is required — content-mode working-tree search was removed in v6 (use the client's native grep/rg tooling). Args: `pickaxe`, `ref?`, `paths?`, `ignoreCase?`, `maxMatches?`, plus `root` + `format`. **Read-only.** |
| `git_diff_summary` | `rethunk-git_git_diff_summary` | Structured, token-efficient diff viewer. Returns per-file diffs with additions/deletions counts, truncated to configurable line limits, with lock files/dist/vendor excluded by default. Args: `range`, `fileFilter`, `maxLinesPerFile`, `maxFiles`, `excludePatterns`, plus `workspaceRoot` + `format`. **Read-only.** |
| `git_diff` | `rethunk-git_git_diff` | Raw diff text for a single repo. Supports unstaged, staged, or `base..head` ranges, scoped to one or more paths with configurable context width. Optional `maxBytes` caps returned UTF-8 bytes (`truncated: true` when cut). Args: `workspaceRoot`, `format`, `base?`, `head?`, `path?`, `paths?`, `unified?`, `staged?`, `maxBytes?`. **Read-only.** |
| `git_show` | `rethunk-git_git_show` | Inspect one commit or ref. Returns commit message plus patch (or `--stat` diffstat). Optional `path`/`paths` filter the patch to those paths (`git show <ref> -- <path>`), not a raw blob checkout. Args: `ref`, `path?`, `paths?`, `stat?`, plus `workspaceRoot` + `format`. **Read-only.** |
| `git_conflicts` | `rethunk-git_git_conflicts` | Inspect an in-progress conflicted merge/cherry-pick/revert/rebase in the working tree (markers under the git dir). Per conflicted file, parses `<<<<<<</\|\|\|\|\|\|\|/=======/>>>>>>>` into ours/theirs (and base, for diff3-style) hunks. **Note:** `git_merge` and `git_cherry_pick` always attempt `--abort` before returning a conflict report, so a successful abort leaves a clean tree — call this tool for conflicts still in progress (manual ops, failed abort, or other tools), not as a follow-up to those tools' conflict payloads. Args: `withHunks?` (default `true`), `maxLinesPerFile?` (default `200`, max `2000`), plus `workspaceRoot` + `format`. **Read-only.** |
| `git_blame` | `rethunk-git_git_blame` | File authorship grouped into contiguous same-commit line runs (SHA, author, date, summary once per run). Args: `path` (required), `ref?`, `startLine?`, `endLine?`, `maxLines?`, plus `workspaceRoot` + `format`. **Read-only.** |
| `batch_commit` | `rethunk-git_batch_commit` | Create multiple sequential git commits in a single call. Each entry stages the listed files or line-ranged file hunks, then commits with the given message. Stops on first failure. Optional `push: "after"` pushes once every commit lands; optional `dryRun: true` previews staged content without writing commits. Args: `commits` (array of `{message, files}`), `push?`, `dryRun?`, plus `workspaceRoot` + `format`. **Mutating — not idempotent.** |
| `git_push` | `rethunk-git_git_push` | Push the current branch to its upstream. Optional `remote`, `branch`, `setUpstream` (passes `-u`). Refuses on detached HEAD; never force-pushes. `workspaceRoot` + `format`. **Mutating.** |
| `git_merge` | `rethunk-git_git_merge` | Merge one or more source branches into a destination. Default strategy `auto` cascades fast-forward → rebase → merge-commit per source, preferring linear history. **`auto`/`rebase` rewrite the source branch tip in place** when rebasing (new SHAs on the source ref), then fast-forward the destination — not destination-only. Refuses on dirty tree; stops on first conflict and attempts `--abort` (abort failure surfaces `rebase_abort_failed` / `merge_abort_failed`). Optional `deleteMergedBranches` / `deleteMergedWorktrees` cascade cleanup, always skipping protected names (main/master/dev/develop/stable/trunk/prod/production/head, plus `release/*`/`release-*`/`hotfix/*`/`hotfix-*` with separator + suffix). Args: `sources`, `into?`, `strategy?`, `message?`, cleanup flags + `workspaceRoot` + `format`. **Mutating.** |
| `git_cherry_pick` | `rethunk-git_git_cherry_pick` | Play commits from one or more sources onto a destination. Sources may be SHAs, `A..B` ranges, or branch names (expanded to `onto..<branch>`, oldest-first). Hard-caps expanded/deduped picks at **100** commits per call (`cherry_pick_too_many_commits`). Uses `--empty=drop` so patch-equivalent re-applies add nothing. Refuses on dirty tree; refuses when a cherry-pick is already in progress (`cherry_pick_in_progress`). Stops on first conflict: `onConflict: "abort"` (default) attempts `--abort` (abort failure → `cherry_pick_abort_failed`); `onConflict: "pause"` leaves the conflict and native sequencer state in place (`conflict.paused: true`) for `git_cherry_pick_continue`. Same cleanup flags as `git_merge` (branch-kind sources only, protected names skipped, and only run on full success); branch deletion uses patch-id equivalence by default so cherry-pick workflows (where SHA differs but diff is identical) clean up correctly. Pass `strictMergedRefEquality: true` for strict `git branch -d` ancestry semantics. Args: `sources`, `onto?`, cleanup flags, `strictMergedRefEquality?`, `onConflict?` + `workspaceRoot` + `format`. **Mutating.** |
| `git_cherry_pick_continue` | `rethunk-git_git_cherry_pick_continue` | Resume or abort a cherry-pick left in progress (by `git_cherry_pick`'s `onConflict: "pause"` or any other means — reads `CHERRY_PICK_HEAD` live off `.git`, stateless). `action: "continue"` (default) requires no remaining unmerged paths (`cherry_pick_unresolved_paths` otherwise), then runs `git -c core.editor=true cherry-pick --continue`; if a later pick then conflicts, reports it the same shape as a paused `git_cherry_pick` call (`conflict.paused: true`) so this tool can be called again. `action: "abort"` rolls back via `git cherry-pick --abort` (same abort helper/reporting as `git_cherry_pick`). Errors `no_cherry_pick_in_progress` when nothing is in progress. Args: `action?` + `workspaceRoot` + `format`. **Mutating.** |
| `git_reset_soft` | `rethunk-git_git_reset_soft` | Soft-reset the current branch to a ref (`HEAD~N`, SHA, branch). Rewound changes land in the staging index; requires a clean working tree. Args: `ref`, plus `workspaceRoot` + `format`. **Mutating — not idempotent.** |
| `git_revert` | `rethunk-git_git_revert` | Create new commit(s) that undo the changes introduced by one or more source commits (`git revert`), applied in listed order. Never rewrites history — safe on shared/pushed branches, unlike `git_reset_soft`. Refuses on dirty tree; on conflict aborts and leaves the tree clean. Args: `sources`, `noCommit?`, `mainline?`, plus `workspaceRoot` + `format`. **Mutating — not idempotent.** |
| `git_tag` | `rethunk-git_git_tag` | Create/delete annotated or lightweight tags for one repo. Args: `tag`, `message?`, `ref?`, `delete?`, plus `workspaceRoot` + `format`. **Mutating.** |
| `git_branch` | `rethunk-git_git_branch` | Create, delete, or rename a local branch. `action: "create"` bases a new branch on `from` (default `HEAD`); `action: "delete"` removes `name` (`force: true` for `-D` on an unmerged branch); `action: "rename"` renames `name` to `newName`. Refuses protected branch names (main/master/dev/develop/stable/trunk/prod/production/head, plus `release/*`/`release-*`/`hotfix/*`/`hotfix-*` with separator + suffix) in any role — as source, target, or rename endpoint. Args: `action`, `name`, `from?`, `newName?`, `force?`, plus `workspaceRoot` + `format`. **Mutating.** |
| `git_worktree_add` | `rethunk-git_git_worktree_add` | Create a new linked worktree, creating the branch from `baseRef` if it does not yet exist. Sibling paths outside the git toplevel are allowed; leading `-` / option-like basenames and NUL bytes are rejected (`invalid_paths`). Path is passed to git after `--`. Refuses on protected branch names. Args: `path`, `branch`, `baseRef?`, plus `workspaceRoot` + `format`. **Mutating.** |
| `git_worktree_remove` | `rethunk-git_git_worktree_remove` | Remove a registered worktree; refuses to remove the main worktree. Same path argv rules as add (leading `-` / NUL → `invalid_paths`; path after `--`). Optional `force: true` for dirty trees. Args: `path`, `force?`, plus `workspaceRoot` + `format`. **Mutating.** |
| `git_stash_apply` | `rethunk-git_git_stash_apply` | Apply or pop a stash entry for one repo (`destructiveHint: true` — pop can delete a stash entry). On failure emits `error: stash_apply_failed` and optional `conflictPaths`. Args: `index?`, `pop?`, plus `workspaceRoot` + `format`. **Mutating.** |
| `git_stash_push` | `rethunk-git_git_stash_push` | Stash working-tree changes (`git stash push`). Optional `message`, `includeUntracked` (-u), `keepIndex` (--keep-index), `paths` to scope. Args: `message?`, `includeUntracked?`, `paths?`, `keepIndex?`, plus `workspaceRoot` + `format`. **Mutating.** |

**`format: "json"`** (minified) is the default on every tool. Pass **`format: "markdown"`** for human-readable output instead.

---

### `git_status` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
| `includeSubmodules` | boolean | `true` | When `true`, reads `.gitmodules` at each git toplevel and runs `git status --short -b` for each checked-out submodule in parallel. Set `false` to skip submodule discovery entirely. |
| `root` | string \| string[] \| `"*"` | — | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | `"json"` | Output format. |

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
| ------------------- | --------- | --------- |
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
| ----------- | ------ | --------- | ------- |
| `nestedRoots` | string[] | — | Relative paths (from the workspace git toplevel) to treat as independent git repos to inventory. Each must be a valid git work tree; invalid paths produce skip entries rather than errors. Cannot combine with an array `root`. May be combined with `preset` when `presetMerge: true` (merged) or when `presetMerge` is false (inline list replaces the preset's `nestedRoots`). |
| `preset` | string | — | Preset name from `.rethunk/git-mcp-presets.json`. Loads `nestedRoots` from the preset's entry. Cannot combine with an array `root`. |
| `presetMerge` | boolean | `false` | When `true`, merge inline `nestedRoots` with preset roots instead of replacing. |
| `remote` | string | — | Fixed remote for ahead/behind tracking. Must be paired with `branch`. |
| `branch` | string | — | Fixed branch for ahead/behind tracking. Must be paired with `remote`. When both are absent the tool uses each repo's `@{u}` upstream. |
| `compareRefs` | `{ left: string, right: string }` | — | Optional ahead/behind between arbitrary local refs (independent of upstream). Ahead = commits reachable as `left..right`; behind = `right..left`. Each side validated with `isSafeGitAncestorRef` → `unsafe_ref_token` on rejection. |
| `maxRoots` | int | `64` | Max nested roots to process (1–256). Roots beyond the limit are omitted; `nestedRootsTruncated: true` and `nestedRootsOmittedCount` are set on the group. |
| `root` | string \| string[] \| `"*"` | — | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. Array form cannot combine with `nestedRoots` or `preset`. |
| `format` | `"markdown"` \| `"json"` | `"json"` | Output format. |

### `git_inventory` — JSON shape (`format: "json"`)

```json
{
  "inventories": [{
    "workspaceRoot": "/abs/path",
    "entries": [{
      "label": ".",
      "path": "/abs/path",
      "upstreamMode": "auto",
      "branchStatus": "## main...origin/main",
      "headAbbrev": "a1b2c3d",
      "upstreamRef": "origin/main",
      "ahead": "2",
      "behind": "0",
      "compareRefs": {
        "left": "main",
        "right": "feature",
        "ahead": "1",
        "behind": "0"
      }
    }],
    "nestedRootsTruncated": true,
    "nestedRootsOmittedCount": 3,
    "upstream": { "mode": "fixed", "remote": "origin", "branch": "main" }
  }]
}
```

`nestedRootsTruncated` / `nestedRootsOmittedCount` present only when `maxRoots` cut the list. `upstream` object present only when `remote`+`branch` were supplied (fixed mode). `compareRefs` on an entry is present only when the call requested `compareRefs` and counts could be computed; optional `note` appears when a ref is unreadable or counts fail. `presetSchemaVersion` present only when a preset was loaded. Non-git paths produce skip entries with plain `skipReason` text such as `(not a git repository)` (not nested JSON). See [Field omission](#field-omission-consumer-contract-v2) for `entries[*]` optional fields.

### `git_inventory` — error codes

| Code | Meaning |
| ------ | --------- |
| `git_not_found` | `git` binary not on `PATH`. |
| `remote_branch_mismatch` | Only one of `remote` / `branch` was provided; supply both or neither. |
| `invalid_remote_or_branch` | `remote` or `branch` contains characters outside the safe token set. |
| `unsafe_ref_token` | A `compareRefs.left` / `compareRefs.right` token failed `isSafeGitAncestorRef` validation. |
| `root_list_nested_or_preset_conflict` | `root` array combined with `nestedRoots` or `preset`. |
| `invalid_root_path` | A `root` array entry is empty or not a git-recognized directory. |
| `root_list_too_many` | More than 256 entries in the `root` array. |
| `root_list_empty` | The `root` array resolved to zero git toplevels. |
| `preset_not_found` | Named preset does not exist in the preset file. |
| `preset_file_invalid` | Preset file failed to load. Discriminator `kind`: `"invalid_json"` (parse failure; may include `message`) or `"schema"` (Zod validation failure; may include `issues`). Always includes `presetFile`. |

Skip entries (individual repos that could not be inventoried) appear inline in `entries[*]` with `skipReason` rather than as top-level errors.

---

### `git_parity` — parameters

| Parameter | Type | Notes |
| ----------- | ------ | ------- |
| `pairs` | `{left: string, right: string, label?: string}[]` | Path pairs to compare. `left` and `right` are relative to the workspace git toplevel. `label` is optional display name; defaults to `"left / right"`. At least one pair required (via inline `pairs` or `preset`). |
| `preset` | string | Preset name from `.rethunk/git-mcp-presets.json`. Loads `parityPairs` from the preset's entry. |
| `presetMerge` | boolean | Default `false`. When `true`, merge inline `pairs` with preset pairs instead of replacing. |
| `root` | string \| string[] \| `"*"` | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | Output format. Default: `"json"`. |

### `git_parity` — JSON shape (`format: "json"`)

```json
{
  "parity": [{
    "workspaceRoot": "/abs/path",
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

`status` is `"OK"` when every pair matches, `"MISMATCH"` when any pair differs or errors. On a match, `sha` carries the common HEAD SHA. On a mismatch, `leftSha` / `rightSha` carry the differing SHAs. On error (path escape, non-git path, or `git rev-parse HEAD` failure), `error` carries a plain description string (e.g. `not a git repository: <path>`) and both SHA fields are absent — never a nested minified JSON blob. `presetSchemaVersion` is present when a preset was loaded.

### `git_parity` — error codes

| Code | Meaning |
| ------ | --------- |
| `git_not_found` | `git` binary not on `PATH`. |
| `no_pairs` | Neither inline `pairs` nor a preset with `parityPairs` was supplied. |
| `root_list_preset_conflict` | `root` array combined with a `preset` argument. |
| `invalid_root_path` | A `root` array entry is empty or not a git-recognized directory. |
| `root_list_too_many` | More than 256 entries in the `root` array. |
| `root_list_empty` | The `root` array resolved to zero git toplevels. |
| `preset_not_found` | Named preset does not exist in the preset file. |
| `preset_file_invalid` | Preset file failed to load. Discriminator `kind`: `"invalid_json"` or `"schema"` (see `git_inventory`). |

Path-escape and `rev-parse` failures are reported inline in `pairs[*].error`, not as top-level error codes.

---

### `list_presets` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `root` | string \| string[] \| `"*"` | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | Output format. Default: `"json"`. |

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
| ------ | --------- |
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repository` | Root is not inside a git repository (reported inline in the `roots[*].error` field, not top-level). |
| `preset_file_invalid` | Preset file failed to load (inline in `roots[*].error`). Discriminator `kind`: `"invalid_json"` or `"schema"`. |
| `invalid_root_path` | A `root` array entry is empty or not a git-recognized directory. |
| `root_list_too_many` | More than 256 entries in the `root` array. |
| `root_list_empty` | The `root` array resolved to zero git toplevels. |

---

## JSON responses

Tool JSON bodies are minified and contain only the payload — no `rethunkGitMcp` envelope. Current `MCP_JSON_FORMAT_VERSION` is **`"6"`** (exported constant in `src/server.ts`); the version string is surfaced in the FastMCP `instructions` field and is therefore discoverable via the MCP `initialize` response. Payload keys (`groups`, `inventories`, `parity`, `roots`) are stable within a given format version. Preset-related responses may include **`presetSchemaVersion`**.

v6 changes from v5: the tool surface shrank to **24 tools** — `git_fetch`, `git_remote`, `git_describe`, `git_stash_list`, `git_reflog`, `git_branch_list`, and `git_worktree_list` were removed (thin wrappers over tiny-output git commands; see [CONTRIBUTING.md — Tool inclusion criteria](../CONTRIBUTING.md#tool-inclusion-criteria)); `git_grep` dropped content mode — `pickaxe` is now required, `pattern`/`filesOnly` are gone, and `results[*]` always carries `commits[]` (never `matches`/`files`); the `pattern_or_pickaxe_required` error code was removed.

v5 changes from v4: `batch_commit` successful `results[*]` entries drop the echoed `message`/`files` (the caller already supplied both in the request); failing entries still carry `message`/`files` alongside `error`/`detail` for diagnosis.

v4 changes from v3: `git_blame` output is run-length grouped (`lines[]` with per-line commit metadata → `groups[]` with metadata once per contiguous same-commit run); `git_diff_summary` per-file `truncated` is omitted when `false`.

The package also ships **`tool-parameters.schema.json`**, generated from the registered Zod parameter schemas via `bun run schema:tools`, plus the published **`schemas/`** directory (`schemas/index.json` + one JSON Schema per tool) via `bun run schema:individual`. Connected MCP clients should still prefer live schema discovery from `initialize` / tool listing; the shipped artifacts are for offline inspection, drift checks, and code generation.

### Field omission (consumer contract, v2+)

To keep responses compact, **optional fields are usually omitted when they would be empty, `null`, or `false`**. Consumers must test for *presence*, not compare to `null`, except where a tool documents an intentional `null` (documented exception: `list_presets` emits `gitTop: null` when the workspace is not inside a git repo).

**`git_inventory` → `inventories[*]`**

- Always present: `workspaceRoot`, `entries`.
- Omitted when not applicable: `presetSchemaVersion`, `nestedRootsTruncated`, `nestedRootsOmittedCount`, and the whole `upstream` object (emitted only when a fixed `remote`/`branch` pair was supplied; in `auto` mode it is absent).

**`git_inventory` → `entries[*]` (`InventoryEntryJson`)**

- Always present: `label`, `path`, `upstreamMode` (`"auto"` or `"fixed"`).
- Optional (omitted when empty/absent): `branchStatus`, `headAbbrev`, `upstreamRef`, `ahead`, `behind`, `upstreamNote`, `compareRefs` (when requested), `detached` (only emitted as `true`), `skipReason` (only on skipped entries).
- **Removed in v2:** `shortStatus`. The porcelain entries now live inside `branchStatus` (the full `git status --short -b` body — branch header line followed by porcelain lines).

**Errors** (any tool)

- Error payloads carry an `error` code string and any structured context (e.g. `preset`, `presetFile`, `kind`). The old free-text `message` field is **removed** for self-describing codes (`git_not_found`, `remote_branch_mismatch`, `invalid_remote_or_branch`, `no_pairs`, `preset_not_found` *missing* case). For preset load failures the wire code is always `preset_file_invalid` with discriminator `kind` (`"invalid_json"` or `"schema"`); `message` is retained on the `invalid_json` kind (parse output) and `issues` on the `schema` kind.

**When to bump `MCP_JSON_FORMAT_VERSION` or change payload shape:** [AGENTS.md](../AGENTS.md) — *Changing contracts*. The constant lives in `src/server.ts` and is surfaced via the server `instructions` field (discoverable from the MCP `initialize` response).

### `git_log` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
| `since` | string | `"7.days"` | Passed to `git log --since=`. Accepts ISO timestamps (`2026-04-01T00:00:00Z`) or git relative forms (`48.hours`, `2.weeks.ago`). |
| `paths` | string[] | (all) | Restrict to commits touching these paths (appended after `--`). Each entry is confined with `resolvePathForRepo` / `assertRelativePathUnderTop` → `path_escapes_repo` on escape. |
| `follow` | boolean | `false` | Pass `--follow` for rename-aware history. Requires **exactly one** `paths` entry; otherwise top-level `invalid_paths` with `detail: "follow requires exactly one path"`. |
| `grep` | string | — | Filter by commit message regex (git `--grep`, always case-insensitive). |
| `author` | string | — | Filter by author name or email (`--author=`). |
| `maxCommits` | int | `50` | Max commits per root. Hard cap: `500`. |
| `branch` | string | `HEAD` | Ref/branch to log from. |
| `root` | string \| string[] \| `"*"` | — | Repo path (string), explicit list of repo paths (array, max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` \| `"oneline"` | `"json"` | Output format. `oneline` returns the first 7 characters of each commit SHA plus the subject (`<abbrev> <subject>`) per line with no headers (single root) or `### repo (branch)` separators per group (multi-root). Display shorthand only — the JSON field remains full `sha` (v3 removed the old `sha7` field). Lowest-token option for post-commit verification. |

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
| ------ | --------- |
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |
| `invalid_since` | The `since` string contains shell metacharacters and was rejected. |
| `invalid_paths` | A `paths` entry failed validation, or `follow: true` was set without exactly one `paths` entry (`detail: "follow requires exactly one path"`). |
| `path_escapes_repo` | A `paths` entry resolves outside that root's git toplevel. |
| `unsafe_ref_token` | `branch` contains characters outside the argv-safe subset. |
| `git_log_failed` | `git log` exited non-zero (e.g. unknown branch ref). |
| `invalid_root_path` | A `root` array entry is empty, not inside a git worktree, or not a directory git recognizes. |
| `root_list_too_many` | More than 256 entries in the `root` array. |
| `root_list_empty` | The `root` array produced zero git toplevels after resolution. |

### `git_grep` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
| `pickaxe` | `{ mode: "S" \| "G", term: string }` | — | **Required.** Pickaxe history search (`git log -S` / `-G`): `S` finds commits that changed the occurrence count of `term`; `G` finds commits whose diff lines match the `term` regex. JSON results are `commits[]` of `{ sha, subject }` per root. |
| `ref` | string | — | Commit/branch/tag to use as the history tip. Validated as a safe ref token (`isSafeGitAncestorRef`); rejects `--`-prefixed or otherwise unsafe tokens. |
| `paths` | string[] | — | Limit history to these paths. Each must resolve within the repo root (`resolvePathForRepo` / `assertRelativePathUnderTop`); escaping paths are rejected per-root. |
| `ignoreCase` | boolean | `false` | Case-insensitive match (`-i`; affects `G` mode regexes). |
| `maxMatches` | integer | `200` | Cap on commits per root. Hard cap `1000`. |
| `root` | string \| string[] \| `"*"` | — | Repo path, array of paths (max 256), or `"*"` for every MCP root. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | `"json"` | Output format. |

Content-mode working-tree search (`pattern`, `filesOnly`, ref-tree search) was **removed in v6** — it duplicated the native grep/rg tooling every MCP client already ships. Pickaxe history is the part with no native equivalent.

### `git_grep` — JSON shape (`format: "json"`)

```json
{
  "results": [
    {
      "root": "/abs/workspace",
      "repo": "workspace",
      "commits": [
        { "sha": "a1b2c3d4e5f6…", "subject": "feat: introduce needle" }
      ],
      "truncated": true
    }
  ]
}
```

One `results` entry per resolved root, each carrying `commits[]` of `{ sha, subject }` hits. `truncated: true` is present only when the per-root commit count exceeded `maxMatches`. A root that fails to resolve or whose git invocation errors carries `error` (and optional `detail`) instead of `commits`. Zero pickaxe hits is **not** an error — `commits` is simply empty.

### `git_grep` — error codes

| Code | Meaning |
| ------ | --------- |
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repository` | A resolved root is not inside a git repository. |
| `unsafe_ref_token` | `ref` failed `isSafeGitAncestorRef` validation. |
| `path_escapes_repo` | A `paths` entry resolves outside that root's git toplevel. |
| `git_grep_failed` | Pickaxe `git log` exited non-zero (bad regex, unknown ref, etc.). |
| `invalid_root_path` / `root_list_too_many` / `root_list_empty` | `root` array validation (shared fan-out behavior). |

---

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
| ----------- | ------ | --------- | ------- |
| `range` | string | unstaged | Diff range. `"staged"` / `"cached"` for index; `"HEAD"` for last commit; `"A..B"` or `"A...B"` for revision ranges; single ref. Ancestor notation (`HEAD~3`, `main^2`) is accepted on any endpoint. Default: unstaged working-tree changes. |
| `fileFilter` | string | — | Glob pattern to restrict output to matching files (e.g. `"*.ts"`, `"src/**"`). |
| `maxLinesPerFile` | int | `50` | Max diff lines to include per file (1–2000). |
| `maxFiles` | int | `30` | Max files to include in output (1–500). |
| `excludePatterns` | string[] | lock files, dist, vendor | Glob patterns to exclude. Defaults to `*.lock`, `*.lockb`, `bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `*.min.js`, `*.min.css`, `vendor/**`, `node_modules/**`, `dist/**`. Pass an empty array to disable. |
| `workspaceRoot` | string | — | Repo path. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | `"json"` | Output format. |

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

`status` is one of `"modified"`, `"added"`, `"deleted"`, `"renamed"`. `oldPath` is present only for renamed files. Per-file `truncated` is present (`true`) only when the diff body was cut at `maxLinesPerFile` (v4). `totalFiles` / `totalAdditions` / `totalDeletions` count the post-`excludePatterns`+`fileFilter` set (before `maxFiles` display truncation). `excludedFiles` includes both exclude-pattern hits and `fileFilter` drops. `truncatedFiles` is the count omitted by `maxFiles`. `truncatedFiles` and `excludedFiles` are omitted when zero/empty (field-omission contract).

### `git_diff_summary` — error codes

| Code | Meaning |
| ------ | --------- |
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |
| `unsafe_range_token` | The `range` string contains characters outside the safe token set. |
| `git_diff_failed` | `git diff` exited non-zero. |

---

### `git_diff` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
| `base` | string | — | Base ref for a revision diff. When omitted with no `staged`, the tool shows unstaged changes. Ancestor notation (`HEAD~3`, `main^2`) is accepted. |
| `head` | string | `HEAD` | Head ref for a revision diff. Used only when `base` is provided. Ancestor notation (`HEAD~3`, `main^2`) is accepted. |
| `path` | string | — | Optional single file path to scope the diff. Confined to the repo (`path_escapes_repo` on escape). |
| `paths` | string[] | — | Multiple file paths to scope the diff; unioned with `path` (deduped). Each confined to the repo. |
| `unified` | integer | — | Context lines around each change (passed as `-U<n>`, 0–100). Omit for git's default (3). |
| `staged` | boolean | `false` | When `true`, runs `git diff --staged`. Ignored when `base` is provided. |
| `maxBytes` | integer | `512000` | Cap on UTF-8 bytes of returned diff text (1024–10000000). Oversized output is truncated; JSON emits `truncated: true` (omitted when false). |
| `workspaceRoot` | string | — | Repo path. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | `"json"` | Output format. |

`git_diff` is a single-repo tool; use `workspaceRoot` to select the target repo. When `base` is set, `staged` is ignored and `head` is used; `head` alone (without `base`) still yields the unstaged working-tree diff.

### `git_diff` — JSON shape (`format: "json"`)

```json
{
  "range": "HEAD~1..HEAD (src/server.ts)",
  "diff": "diff --git a/src/server.ts b/src/server.ts\n...",
  "truncated": true
}
```

`truncated: true` is present only when the `maxBytes` cap fired.

### `git_diff` — error codes

| Code | Meaning |
| ------ | --------- |
| `unsafe_range_token` | `base` or `head` contains characters outside the argv-safe subset. |
| `path_escapes_repo` | A `path` / `paths` entry resolves outside the git toplevel. |
| `git_diff_failed` | `git diff` exited non-zero. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_show` — parameters

| Parameter | Type | Notes |
| ----------- | ------ | ------- |
| `ref` | string | Commit, branch, tag, or other git rev-spec to inspect. Ancestor notation (`HEAD~3`, `main^2`) is accepted. |
| `path` | string | Optional single path. When provided, filters the shown patch/stat to that path (`git show <ref> -- <path>`), not a raw blob (`ref:path`) checkout. |
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
| ------ | --------- |
| `unsafe_ref_token` | `ref` contains characters outside the argv-safe subset. |
| `path_escapes_repo` | `path` resolves outside the git toplevel. |
| `git_show_failed` | `git show` exited non-zero (e.g. unknown ref). Includes `detail` (stderr/stdout trim), matching peer tools. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_conflicts` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
| `withHunks` | boolean | `true` | Parse conflict-marker hunks per file. Set `false` to return just the conflicted path list (skips reading file contents). |
| `maxLinesPerFile` | int | `200` | Cap on lines scanned per file (1–2000) before marking `truncated: true` on that file and dropping any hunk still open at the cutoff. |
| `workspaceRoot`, `format` | — | — | Standard single-repo pick + output format. |

### `git_conflicts` — JSON shape (`format: "json"`)

```json
{
  "state": "merge",
  "files": [
    {
      "path": "shared.txt",
      "hunks": [
        {
          "startLine": 2,
          "ours": "BETA",
          "theirs": "ALPHA",
          "oursLabel": "HEAD",
          "theirsLabel": "feature"
        }
      ]
    }
  ]
}
```

`state` is omitted when no merge/cherry-pick/revert/rebase is in progress (e.g. conflicts were left by some other means). A clean repo returns `{ "files": [] }`. Each file entry's `hunks` is omitted when empty (unreadable, binary, or no markers found — file still listed by `path` alone); `base` appears only for diff3-style markers (`|||||||`); `oursLabel`/`theirsLabel` are omitted when git did not attach a label to that marker. Per-file optional `error: "path_escapes_repo"` when a conflict path fails confinement (rare; paths normally come from git). Incomplete conflict markers within the scan window set `truncated: true` (same as line-cap truncation).

### `git_conflicts` — error codes

Only the shared single-repo prelude errors apply — the tool itself never fails on conflict state:

| Code | Meaning |
|------|---------|
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_blame` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
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
| ------ | --------- |
| `path_escapes_repo` | `path` resolves outside the git toplevel. |
| `unsafe_ref_token` | `ref` contains characters outside the argv-safe subset. |
| `invalid_line_range` | Only one of `startLine`/`endLine` was given, or `startLine > endLine`. |
| `git_blame_failed` | `git blame` exited non-zero (unknown path/ref). `detail` carries stderr. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `batch_commit` — atomic staging semantics

**Critical for AI agents:** Each call to `batch_commit` is **self-contained and atomic per-commit entry**.

- **All files in a single entry are staged together.** When you list `files: ["src/foo.ts", "src/bar.ts"]` in one commit entry, both are staged as a unit before the commit is created.
- **Index isolation per commit.** Unrelated paths that were already staged before the call are temporarily unstaged around an **index-based** `git commit` so they are not included. Pathspec/`--only` mode is intentionally avoided — it commits from the worktree and would squash hunk-level (`{ path, lines }`) staging.
- **Each commit entry is processed sequentially within the call.** The tool stages files, commits, then moves to the next entry. All entries within a single `batch_commit` call happen in one atomic MCP transaction.
- **A single `batch_commit` call cannot be split across multiple MCP calls.** Do NOT attempt incremental staging like "call 1 with file A, then call 2 with file B hoping they stage together." Each call is independent — call 1's commit lands immediately; call 2's changes are a separate transaction.
- **Failed entry stops the batch.** If staging or commit fails on entry N, the tool aborts and skips remaining entries. On mid-entry `stage_failed`, paths already staged for that entry are unstaged (`git restore --staged`). **Entries that succeeded before the failure remain committed** — they are not rolled back.
- **Include all files for a logical change in a single `batch_commit` call.** Group related files in each commit entry, list them all in the `files` array, and include all necessary entries in the `commits` array.
- **dryRun** uses path-scoped `diff --stat`, unstages between entries, and restores the full pre-call index via `write-tree`/`read-tree` (including overlapping pre-staged paths).

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
| ----------- | ------ | ------- |
| `commits` | `{message: string, files: (string \| {path: string, lines: {from: number, to: number}})[]}[]` | Commits to create in order. 1–50 entries. Each `files` entry is either: (a) a path relative to the git root, staged with `git add`; (b) a `{path, lines: {from, to}}` object for hunk-level staging — only unified-diff hunks overlapping the given 1-indexed line range are staged (`from`/`to` each max `1000000`; `from > to` → `invalid_line_range`); or (c) a path to a **deleted tracked file** (missing on disk but tracked in HEAD), which is staged as a removal via `git rm --cached` — combining `{path, lines}` with a deleted file is an error. All paths must stay within the git toplevel. Rejects `.`, repo-root, and directory pathspecs (`invalid_paths`). |
| `push` | `"never"` \| `"after"` | Default `"never"`. `"after"` pushes the current branch to its upstream **once all commits succeed**. Never auto-sets upstream — branches without an upstream fail with `push_no_upstream`. Commits are **not** rolled back on push failure. |
| `dryRun` | boolean | Default `false`. When `true`, stages each entry, reports what would be committed (`staged`, `diffStat`), then unstages everything without writing commits. |
| `workspaceRoot` | string | Repo path. Default: first MCP root / cwd. |
| `format` | `"markdown"` \| `"json"` | Output format. Default: `"json"`. |

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

Successful `results[*]` entries carry only what's needed to confirm the commit landed (`index`, `ok`, `sha`, plus `output` when git printed something worth keeping) — they omit `message`/`files` since the caller already supplied both in the request. `output` is condensed the same way as push output: `git commit`'s own `[branch sha] subject` confirmation line and pre-commit-hook noise are dropped (the subject/sha are already the `message`/`sha` fields), keeping only diffstat/mode/rename lines plus an omitted-line count. Failing entries echo `message` and `files` back (alongside `error`/`detail`, with full untouched output) so the caller can identify the failed commit without cross-referencing the request.

On first failure `ok` is `false`, `committed` reflects only the entries that succeeded before the error, and the failing entry includes `message`, `files`, `error`, and `detail` fields. Remaining entries are skipped and not included in `results`.

When `dryRun: true`, the top-level response includes `dryRun: true`; successful `results[*]` entries omit `sha` and instead include `staged` and `diffStat`.

The `push` object is present only when `push: "after"` was requested **and** every commit landed. On push failure the top-level `ok` stays `true` (the commits themselves succeeded) while `push.ok` is `false` and `push.error` carries the code.

### `batch_commit` — error codes (per-result `error` field)

| Code | Meaning |
| ------ | --------- |
| `path_escapes_repository` | One of the listed file paths resolves outside the git toplevel. |
| `invalid_paths` | A pathspec is `.`, the repo root, or a directory (file paths only). |
| `invalid_line_range` | A `{path, lines}` entry has `from > to`. |
| `stage_failed` | Staging failed. `git add` error for modified/new files; `git rm --cached` error for deleted files (e.g. path never tracked in HEAD); `{path, lines}` on a deleted file. |
| `commit_failed` | `git commit` failed (e.g. nothing staged, hooks rejected). |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

### `batch_commit` — push error codes (`push.error` field)

| Code | Meaning |
| ------ | --------- |
| `push_detached_head` | HEAD is detached; no branch to push. |
| `push_no_upstream` | Current branch has no configured upstream. `batch_commit` will not auto-set one — do `git push -u origin <branch>` yourself (or re-run without `push`). |
| `push_failed` | `git push` exited non-zero (network error, non-fast-forward, hook rejection). `detail` carries the stderr/stdout from git. |

---

### `git_merge` — parameters

| Parameter | Type | Notes |
| ----------- | ------ | ------- |
| `sources` | `string[]` | Source branches to merge, in order. 1–20 entries. Each must be a valid git ref token. |
| `into` | string | Destination branch. Defaults to the currently checked-out branch. Rejected when HEAD is detached. |
| `strategy` | `"auto"` \| `"ff-only"` \| `"rebase"` \| `"merge"` | Default `"auto"`: cascade **fast-forward → rebase → merge-commit** per source. `"ff-only"` fails on divergence. `"rebase"` rebases source onto destination and fast-forwards; no merge-commit fallback. `"merge"` always creates a merge commit (`--no-ff`). **`auto`/`rebase` rewrite the source branch tip when rebasing** (history rewrite of the source ref), then fast-forward the destination — agents must not treat `auto` as destination-only. |
| `message` | string | Merge commit message, used only when a merge commit is created. Defaults to `Merge branch '<source>' into <into>`. |
| `deleteMergedBranches` | boolean | Default `false`. After **all** sources land cleanly, delete each source branch locally (`git branch -d`). **Protected names always skipped** (main, master, dev, develop, stable, trunk, prod, production, head, plus `release/*`/`release-*`/`hotfix/*`/`hotfix-*` — pattern requires a separator and non-empty suffix; bare `release`/`hotfix` are not protected). Never touches remote refs. |
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

On conflict: top-level `ok` is `false`, the conflicting entry has `ok: false` with `conflictStage` (`"rebase"` or `"merge"`), `conflictPaths` (array of paths with unresolved markers), and an `error` code. The tool attempts `git rebase --abort` / `git merge --abort`. When abort succeeds, the tree is clean. When abort itself fails, the per-source `error` is `rebase_abort_failed` / `merge_abort_failed` (tree may still be mid-rebase/merge; `detail` carries abort stderr). Remaining sources are not attempted.

### `git_merge` — error codes

| Code | Meaning |
| ------ | --------- |
| `unsafe_ref_token` | A source or `into` contains characters outside the argv-safe subset (spaces, shell meta, `..`, `@{`, leading `-`, trailing `.lock`). |
| `into_detached_head` | HEAD is detached and no `into` was given — the tool needs a concrete destination branch. |
| `working_tree_dirty` | Uncommitted changes present. Commit, stash, or discard before merging. |
| `checkout_failed` | Could not switch to `into`. `detail` carries git's stderr. |
| `destination_not_found` | `into` does not resolve to a commit. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |
| `source_not_found` (per source) | A source branch name does not resolve. |
| `cannot_fast_forward` (per source) | `strategy: "ff-only"` refused because branches have diverged. |
| `rebase_conflicts` (per source) | Rebase encountered conflicts. The tool attempts `git rebase --abort`; on abort success the tree is clean. On abort failure see `rebase_abort_failed`. |
| `merge_conflicts` (per source) | Merge commit encountered conflicts. The tool attempts `git merge --abort`; on abort success the tree is clean. On abort failure see `merge_abort_failed`. |
| `rebase_abort_failed` (per source) | `git rebase --abort` failed after a conflict; tree may still be mid-rebase. `detail` carries abort stderr. |
| `merge_abort_failed` (per source) | `git merge --abort` failed after a conflict; tree may still be mid-merge. `detail` carries abort stderr. |
| `merge_failed` (per source) | `git merge --ff-only` failed unexpectedly. `detail` carries stderr. |
| `merge_base_failed` (per source) | `git merge-base` failed (usually unrelated histories). |

---

### `git_cherry_pick` — parameters

| Parameter | Type | Notes |
| ----------- | ------ | ------- |
| `sources` | `string[]` | Source specs. 1–50 entries. Each entry is one of: a full/short SHA, an `A..B` / `A...B` range, or a branch name. Branch names expand to `onto..<branch>` (oldest-first). After SHA-reachability filtering, at most **100** commits are fed to `git cherry-pick` per call; oversize returns `cherry_pick_too_many_commits` with `picked` + `max`. |
| `onto` | string | Destination branch. Defaults to the currently checked-out branch. Rejected when HEAD is detached. |
| `deleteMergedBranches` | boolean | Default `false`. After all commits apply, delete each **branch-kind** source locally. Deletion uses **patch-id equivalence** by default — correct for cherry-pick workflows where SHA differs but diff is identical. Protected names always skipped; never touches remote refs. |
| `deleteMergedWorktrees` | boolean | Default `false`. After success, remove any local worktree attached to a branch-kind source (`git worktree remove`). Protected tails always skipped. |
| `strictMergedRefEquality` | boolean | Default `false`. When `true`, branch deletion uses strict SHA-reachability (`git branch -d` ancestry semantics) instead of patch-id equivalence. Use when you need git's exact ancestry guarantee rather than content equivalence. |
| `onConflict` | `"abort"` \| `"pause"` | Default `"abort"`: on conflict, run `cherry-pick --abort` and roll back the whole range (unchanged behavior). `"pause"`: on conflict, leave the conflict and native cherry-pick sequencer state in place — commits already applied stay applied — so it can be resolved and resumed via `git_cherry_pick_continue` (below). |
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

With the default `onConflict: "abort"`, the tool attempts `git cherry-pick --abort`. On abort success the tree is clean. On abort failure: top-level `error: cherry_pick_abort_failed`, and `conflict.abortFailed: true` (+ optional `abortDetail`); `CHERRY_PICK_HEAD` may remain.

With `onConflict: "pause"`, the tool does **not** abort — `conflict.paused: true` is added and `CHERRY_PICK_HEAD`/the sequencer are left in place. `applied` reflects commits from the same range that landed before the conflicting one (cheaply derived via `rev-list --count`, not rolled back). Resolve the conflict and call `git_cherry_pick_continue` to resume, or abort it explicitly with the same tool (`action: "abort"`):

```json
{
  "ok": false,
  "onto": "main",
  "picked": 3,
  "applied": 1,
  "results": [ ... ],
  "conflict": {
    "stage": "cherry-pick",
    "paused": true,
    "commit": "abcdef1",
    "paths": ["src/foo.ts"],
    "detail": "…git stderr…"
  }
}
```

### `git_cherry_pick` — error codes

| Code | Meaning |
| ------ | --------- |
| `unsafe_ref_token` | A source or `onto` contains characters outside the argv-safe subset. |
| `onto_detached_head` | HEAD is detached and no `onto` was given. |
| `working_tree_dirty` | Uncommitted changes present. Commit, stash, or discard before cherry-picking. |
| `cherry_pick_in_progress` | A cherry-pick is already in progress (`CHERRY_PICK_HEAD` set, e.g. left paused by a prior call). Response includes `commit`. Resolve via `git_cherry_pick_continue` first. |
| `checkout_failed` | Could not switch to `onto`. |
| `destination_not_found` | `onto` does not resolve to a commit. |
| `source_not_found` | A source spec resolves to neither a branch, a range, nor a commit. |
| `range_resolution_failed` | `git rev-list` failed to expand a range spec. |
| `cherry_pick_too_many_commits` | Expanded/deduped pick list exceeds the hard cap of 100. Response includes `picked` + `max`. |
| `cherry_pick_abort_failed` | `git cherry-pick --abort` failed after a conflict (`onConflict: "abort"`, the default); tree may still be mid-cherry-pick. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_cherry_pick_continue` — parameters

| Parameter | Type | Notes |
|-----------|------|-------|
| `action` | `"continue"` \| `"abort"` | Default `"continue"`. `"continue"`: precheck no unmerged paths remain, then resume the native sequencer (`git -c core.editor=true cherry-pick --continue`). `"abort"`: roll back to the pre-cherry-pick HEAD (`git cherry-pick --abort`, same helper `git_cherry_pick` uses). |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

This tool is **stateless** — it probes `CHERRY_PICK_HEAD` live off `.git` on every call rather than depending on the pausing `git_cherry_pick` call, so it works for a cherry-pick left in progress by any means.

### `git_cherry_pick_continue` — JSON shape (`format: "json"`)

Success:

```json
{ "ok": true, "action": "continue", "applied": 2, "headSha": "a1b2c3d…" }
```

`applied` counts commits added to HEAD since the call started (the resolved pick plus any further picks the sequencer completed on its own).

If resuming lands on another conflict later in the same range, the response mirrors a paused `git_cherry_pick` call so the loop is resumable — call this tool again after resolving:

```json
{
  "ok": false,
  "action": "continue",
  "applied": 1,
  "conflict": {
    "stage": "cherry-pick",
    "paused": true,
    "commit": "def4567",
    "paths": ["src/bar.ts"],
    "detail": "…git stderr…"
  }
}
```

`action: "abort"` success:

```json
{ "ok": true, "action": "abort", "headSha": "a1b2c3d…" }
```

### `git_cherry_pick_continue` — error codes

| Code | Meaning |
| ------ | --------- |
| `no_cherry_pick_in_progress` | `CHERRY_PICK_HEAD` is not set — nothing to continue or abort. |
| `cherry_pick_unresolved_paths` | `action: "continue"` called while conflicted paths are still unmerged. Response includes `paths`. Stage resolutions first. |
| `cherry_pick_continue_failed` | `git cherry-pick --continue` failed for a reason other than a new conflict (e.g. the resolved pick would produce an empty commit). Response includes `detail`. |
| `cherry_pick_abort_failed` | `git cherry-pick --abort` failed (`action: "abort"`); tree may still be mid-cherry-pick. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_push` — parameters

For already-committed work, call **`git_push`** directly instead of creating an empty commit or falling back to shell. Continue to prefer **`batch_commit`** with **`push: "after"`** when commits and push happen in the same MCP call.

| Parameter | Type | Notes |
| ----------- | ------ | ------- |
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
| ------ | --------- |
| `push_detached_head` | HEAD is detached; no branch name to push. |
| `push_no_upstream` | Branch has no configured upstream and `setUpstream` was not requested. |
| `push_failed` | `git push` exited non-zero. `detail` carries stderr. |
| `unsafe_ref_token` | `branch` value contains characters outside the safe token set. |
| `unsafe_remote_token` | `remote` value contains disallowed characters. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_tag` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
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
| ------ | --------- |
| `empty_tag_name` | `tag` trimmed to an empty string. |
| `unsafe_tag_token` | `tag` contains disallowed characters. |
| `unsafe_ref_token` | `ref` contains disallowed characters. |
| `ref_not_found` | `ref` did not resolve to a commit. |
| `tag_create_failed` | `git tag` failed while creating the tag. |
| `tag_delete_failed` | `git tag -d` failed. |
| `tag_verification_failed` | The tag could not be read back after creation. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_branch` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
| `action` | `"create"` \| `"delete"` \| `"rename"` | — | Required. Which branch operation to perform. |
| `name` | string | — | Required. Branch to create/delete, or the existing branch name for rename. |
| `from` | string | `HEAD` | Commit-ish to base a new branch on. `create` only; ignored otherwise. |
| `newName` | string | — | New branch name. Required when `action: "rename"`. |
| `force` | boolean | `false` | Force-delete an unmerged branch (`git branch -D`). `delete` only; never overrides protected-branch rejection. |
| `workspaceRoot`, `format` | — | — | Standard single-repo pick + output format. |

### `git_branch` — JSON shape (`format: "json"`)

```json
{ "action": "create", "branch": "feature/x", "sha": "a1b2c3d4e5f6..." }
```

`action` echoes the requested operation; `branch` is the resulting branch name (the created/deleted name, or the new name after a rename); `sha` is the branch tip — for `delete`, the tip SHA the branch pointed to immediately before removal.

### `git_branch` — error codes

| Code | Meaning |
| ------ | --------- |
| `unsafe_ref_token` | `name`, `from`, or `newName` contains disallowed characters. |
| `protected_branch` | `name` (source) or `newName` (rename target) is on the protected names list. Checked for every action, regardless of `force`. |
| `missing_new_name` | `action: "rename"` without a non-empty `newName`. |
| `ref_not_found` | `from` (create) or `name` (delete) did not resolve to a commit. |
| `branch_create_failed` | `git branch <name> <from>` exited non-zero (e.g. name already exists). `detail` carries stderr. |
| `branch_delete_failed` | `git branch -d`/`-D` exited non-zero (e.g. unmerged without `force`, or deleting the checked-out branch). `detail` carries stderr. |
| `branch_rename_failed` | `git branch -m` exited non-zero (e.g. target name already exists), or the SHA could not be resolved after a successful rename. `detail` carries stderr/diagnostic text. |
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
| ------ | --------- |
| `unsafe_ref_token` | `ref` contains characters outside the ancestor-safe token set. |
| `working_tree_dirty` | Working tree has uncommitted/unstaged changes; clean up before resetting. |
| `reset_failed` | `git reset --soft` failed (e.g. ref does not exist). |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

### `git_revert` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
| `sources` | string[] | — | Required, 1–20 entries. Commits to revert, applied in order: SHA, branch/tag name, or ancestor notation (`HEAD~1`). Each validated as an ancestor-safe ref token. |
| `noCommit` | boolean | `false` | Pass `--no-commit`: stage the revert(s) in the index/working tree without committing. Working tree is intentionally left staged in this case (documented exception to the tree-clean guarantee). |
| `mainline` | int ≥ 1 | — | Parent number (`-m N`) to diff against — required when reverting a merge commit. |
| `workspaceRoot`, `format` | — | — | Standard single-repo pick + output format. |

### `git_revert` — JSON shape (`format: "json"`)

Success (committed):

```json
{ "ok": true, "reverted": [{ "source": "a1b2c3d", "sha": "f9e8d7c…" }] }
```

Success (`noCommit: true` — no commits made):

```json
{ "ok": true, "staged": true, "sources": ["a1b2c3d"], "stagedCount": 1 }
```

Conflict (aborted, tree left clean):

```json
{ "ok": false, "aborted": true, "commit": "a1b2c3d…", "conflicts": ["shared.txt"], "detail": "..." }
```

`commit`/`detail` are omitted when unavailable. `reverted[].sha` is the new commit created by reverting `source`, in the same order as `sources` (one new commit per source when `noCommit` is `false`).

### `git_revert` — error codes

| Code | Meaning |
| ------ | --------- |
| `unsafe_ref_token` | A `sources` entry contains characters outside the ancestor-safe token set. |
| `working_tree_dirty` | Working tree has uncommitted/unstaged changes; clean up before reverting. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

Conflict / other `git revert` failures do **not** use the `error` field — see the `aborted: true` shape above (mirrors `git_cherry_pick`'s conflict reporting).

---

### `git_stash_apply` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
| `index` | int | `0` | Stash index to apply/pop (`stash@{index}`). Max `10000`. |
| `pop` | boolean | `false` | When `true`, runs `git stash pop` instead of `git stash apply`. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_stash_apply` — JSON shape (`format: "json"`)

Success (`applied: true`, no `error`):

```json
{
  "applied": true,
  "stashIndex": 0,
  "popped": false,
  "output": "On branch main\nChanges not staged for commit:\n..."
}
```

On failure (`applied: false`):

```json
{
  "error": "stash_apply_failed",
  "applied": false,
  "stashIndex": 0,
  "popped": false,
  "output": "…",
  "conflictPaths": ["conflict.txt"]
}
```

`error: "stash_apply_failed"` on every failed apply/pop. `conflictPaths` is omitted when empty (omit-empty rule); populated via `git diff --name-only --diff-filter=U`. The tree is left as git left it (no auto-abort). With `pop: true`, a conflicted pop retains the stash entry (git does not drop it until the apply succeeds). Markdown failure output lists conflict paths under a `Conflicts:` block when present. `output` is omitted when git produced no stdout/stderr text. `popped` mirrors the requested `pop` flag (whether pop was attempted), not whether the stash entry was removed.

### `git_stash_apply` — error codes

| Code | Meaning |
|------|---------|
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |
| `stash_apply_failed` | Apply/pop failed (also on the failure payload above with `applied: false`). |

---

### `git_stash_push` — parameters

| Parameter | Type | Default | Notes |
| ----------- | ------ | --------- | ------- |
| `message` | string | — | Stash subject (`git stash push -m <message>`). |
| `includeUntracked` | boolean | `false` | Also stash untracked files (`git stash push -u`). |
| `keepIndex` | boolean | `false` | Keep staged changes in the index after stashing (`git stash push --keep-index`). |
| `paths` | string[] | — | Scope the stash to specific paths, relative to git root. Each path must resolve within the repo root or the call fails with `path_escapes_repo`. |
| `workspaceRoot`, `format` | — | — | Standard single-repo pick + output format. |

### `git_stash_push` — JSON shape (`format: "json"`)

Success:

```json
{
  "stashed": true,
  "ref": "stash@{0}",
  "sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "message": "On main: wip: pushed"
}
```

Nothing to stash (git exits 0 printing "No local changes to save"):

```json
{ "stashed": false, "reason": "no_local_changes" }
```

### `git_stash_push` — error codes

| Code | Meaning |
| ------ | --------- |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |
| `path_escapes_repo` | A `paths` entry resolves outside the repository root. |
| `stash_push_failed` | `git stash push` exited non-zero for a reason other than "nothing to stash" (see `detail`). |

---

### `git_worktree_add` — parameters

| Parameter | Type | Notes |
| ----------- | ------ | ------- |
| `path` | string | Filesystem path for the new worktree. Relative paths are resolved from the git toplevel. Sibling worktrees **outside** the git toplevel remain allowed (absolute or relative). Leading `-` / option-like basenames and NUL bytes are rejected with `invalid_paths`. The path is passed to git after `--` so it cannot be parsed as an option. |
| `branch` | string | Branch to check out. Created from `baseRef` if it does not already exist. Trimmed before validation and spawn. |
| `baseRef` | string | Commit-ish for branch creation. Default: `HEAD`. Ignored when `branch` already exists. Trimmed before validation and spawn. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_worktree_add` — JSON shape (`format: "json"`)

```json
{ "ok": true, "path": "/abs/worktree", "branch": "feature/x", "created": true, "baseRef": "main" }
```

### `git_worktree_add` — error codes

| Code | Meaning |
| ------ | --------- |
| `unsafe_ref_token` | `branch` or `baseRef` contains disallowed characters. |
| `protected_branch` | `branch` is on the protected names list. |
| `invalid_paths` | `path` has a leading `-` / option-like basename, contains a NUL byte, or otherwise fails argv-safe path checks. |
| `worktree_add_failed` | `git worktree add` exited non-zero. `detail` carries stderr. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

### `git_worktree_remove` — parameters

| Parameter | Type | Notes |
| ----------- | ------ | ------- |
| `path` | string | Path of the worktree to remove. Same argv rules as add (leading `-` / NUL → `invalid_paths`; path passed after `--`). Sibling paths outside the toplevel are allowed when registered. |
| `force` | boolean | Default `false`. Pass `--force` to allow removal with uncommitted changes. |
| `workspaceRoot`, `format` | — | Standard single-repo pick + output format. |

### `git_worktree_remove` — JSON shape (`format: "json"`)

```json
{ "ok": true, "path": "/abs/worktree" }
```

### `git_worktree_remove` — error codes

| Code | Meaning |
| ------ | --------- |
| `cannot_remove_main_worktree` | `path` resolves to the main (non-linked) worktree. |
| `worktree_not_found` | `path` is not registered as a worktree in this repo. |
| `invalid_paths` | `path` has a leading `-` / option-like basename, contains a NUL byte, or otherwise fails argv-safe path checks. |
| `worktree_remove_failed` | `git worktree remove` failed. Pass `force: true` if there are uncommitted changes. |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

## Environment

| Variable | Default | Notes |
| ---------- | --------- | ------- |
| `GIT_SUBPROCESS_PARALLELISM` | CPU-based | Max concurrent git subprocesses for multi-root fan-out (`git_inventory`, `git_parity`, multi-root `git_log`, multi-root `git_grep`). |
| `GIT_SUBPROCESS_TIMEOUT_MS` | `120000` | Per-subprocess timeout in ms; on expiry the child is killed (SIGTERM) and the call resolves as failed. Set `0` (or negative) to disable (unbounded). |
| `RETHUNK_GIT_TOOLS` | *(unset — all)* | Comma-separated allowlist of exact tool names. Unset or empty → all 24 tools registered. Non-empty → only the listed tools; unknown names warned to stderr. If every listed name is unknown, zero tools are registered (restriction honored literally). The presets resource is always available. Example: `RETHUNK_GIT_TOOLS=git_status,git_diff_summary,git_diff,git_log,batch_commit,git_push`. |

## Resource

| URI | Purpose |
|-----|---------|
| `rethunk-git://presets` | JSON snapshot of `.rethunk/git-mcp-presets.json` at the resolved git toplevel (or structured errors). |

Error payloads from this resource may include:

| Code | Meaning |
| ------ | --------- |
| `no_workspace_root` | No MCP workspace root could be resolved for the session. |
| `not_a_git_repository` | The resolved path is not inside a git repository. |
| `preset_file_invalid` | Preset file failed to load (`kind`: `"invalid_json"` or `"schema"`). |

When the file is missing, the resource returns `fileExists: false` with an empty `presets` object (not an error).

## Root resolution

Every tool carries exactly **one** routing parameter:

| Tools | Parameter | Accepts |
|-------|-----------|---------|
| Fan-out: `git_status`, `git_inventory`, `git_parity`, `list_presets`, `git_log`, `git_grep` | `root` | string (one repo path) \| string[] (explicit repo list) \| `"*"` (every MCP root) |
| All other 18 tools | `workspaceRoot` | string (one repo path) |

### `root` forms (fan-out tools)

- **string** — resolve that one path (same semantics as `workspaceRoot`).
- **string[]** — explicit repo list (sibling clones). Each entry is passed through `path.resolve`, then resolved to a **git toplevel**; duplicate toplevels are dropped (stable order, first wins). Max **256** paths (`root_list_too_many`); an entry that is not inside a git repo returns `invalid_root_path`; zero resolved toplevels returns `root_list_empty`. Cannot be combined with a `preset` argument (`root_list_preset_conflict`; `git_inventory` also rejects arrays combined with `nestedRoots` — `root_list_nested_or_preset_conflict`).
- **`"*"`** — every `file://` root reported by the MCP client (capped at **256** resolved toplevels — same `root_list_too_many` as an explicit array); markdown output emits one `# {tool}` header with per-root subsections (`git_inventory` uses `### {gitTop}`; `git_status` uses `### MCP root: ...`), or combined JSON.

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
