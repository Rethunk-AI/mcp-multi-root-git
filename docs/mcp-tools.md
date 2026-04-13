# MCP tools and resources (canonical reference)

Single source of truth for **registered tool ids**, **client naming**, **JSON output shape**, **resource URI**, and **workspace root resolution**.  
**Install and MCP clients (only canonical location):** [install.md](install.md). **Preset file, dev, CI, publishing:** [HUMANS.md](../HUMANS.md). **Implementation layout (`src/server/` + entry [`server.ts`](../src/server.ts)), contract bumps:** [AGENTS.md](../AGENTS.md).

## Naming

MCP clients expose tools as `{serverName}_{toolName}`. With the server registered as **`rethunk-git`**, examples use the prefix **`rethunk-git_`**.

## Tools

| Short id | Client id (server `rethunk-git`) | Purpose |
|----------|-----------------------------------|---------|
| `git_status` | `rethunk-git_git_status` | `git status --short -b` per MCP root and optional submodules (`includeSubmodules`); parallel submodule status. Args include `allWorkspaceRoots`, `rootIndex`, `workspaceRoot`, `format`. |
| `git_inventory` | `rethunk-git_git_inventory` | Status + ahead/behind per path; default upstream each repo’s `@{u}`; pass **both** `remote` and `branch` for fixed tracking. `nestedRoots`, `preset`, `presetMerge`, `maxRoots`, `format`, plus workspace pick args. |
| `git_parity` | `rethunk-git_git_parity` | Compare `git rev-parse HEAD` for path pairs. `pairs`, `preset`, `presetMerge`, `format`, plus workspace pick args. |
| `list_presets` | `rethunk-git_list_presets` | List preset names/counts from `.rethunk/git-mcp-presets.json`; invalid JSON/schema surface as errors. Workspace pick + `format` only. |
| `git_log` | `rethunk-git_git_log` | Path-filtered, time-windowed `git log` across one or more workspace roots. Returns commit history with author, date, subject, and shortstat. Args: `since`, `paths`, `grep`, `author`, `maxCommits`, `branch`, plus workspace pick args + `format`. |
| `git_diff_summary` | `rethunk-git_git_diff_summary` | Structured, token-efficient diff viewer. Returns per-file diffs with additions/deletions counts, truncated to configurable line limits, with lock files/dist/vendor excluded by default. Args: `range`, `fileFilter`, `maxLinesPerFile`, `maxFiles`, `excludePatterns`, plus workspace pick args + `format`. **Read-only.** |
| `batch_commit` | `rethunk-git_batch_commit` | Create multiple sequential git commits in a single call. Each entry stages the listed files then commits with the given message. Stops on first failure. Args: `commits` (array of `{message, files}`), plus workspace pick args + `format`. **Mutating — not idempotent.** |

Pass **`format: "json"`** on any tool for structured JSON instead of markdown (default).

## JSON responses

Tool JSON bodies are minified and contain only the payload — no `rethunkGitMcp` envelope. Current `MCP_JSON_FORMAT_VERSION` is **`"2"`**; server + format version are discoverable via MCP `initialize`. Payload keys (`groups`, `inventories`, `parity`, `roots`) are stable within a given format version. Preset-related responses may include **`presetSchemaVersion`**.

### v2 field omission (consumer contract)

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
    "workspace_root": "/abs/path",
    "repo": "my-repo",
    "branch": "main",
    "commits": [{
      "sha7": "a1bf184",
      "shaFull": "a1bf184c3d...",
      "subject": "feat(satcom): upgrade to PROTOCOL_VERSION 4",
      "author": "Damon Blais",
      "email": "damon@example.com",
      "date": "2026-04-12T18:32:01-07:00",
      "ageRelative": "42m ago",
      "filesChanged": 4,
      "insertions": 16,
      "deletions": 5
    }],
    "truncated": true,
    "omittedCount": 12
  }]
}
```

v2 field-omission rules: `filesChanged`, `insertions`, `deletions` are omitted when zero/absent (new file with no shortstat). `truncated` and `omittedCount` are omitted when `false`/`0`. A group emits `error` instead of `commits` when git fails for that root.

### `git_log` — error codes

| Code | Meaning |
|------|---------|
| `git_not_found` | `git` binary not on `PATH`. |
| `not_a_git_repo` | The resolved workspace root is not inside a git repository. |
| `invalid_since` | The `since` string contains shell metacharacters and was rejected. |
| `invalid_paths` | One of the `paths` entries contains shell metacharacters and was rejected. |
| `git_log_failed` | `git log` exited non-zero (e.g. unknown branch ref). |
| `root_index_out_of_range` | `rootIndex` exceeds the number of MCP file roots. |

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
  }]
}
```

On first failure `ok` is `false`, `committed` reflects only the entries that succeeded before the error, and the failing entry includes `error` and `detail` fields. Remaining entries are skipped and not included in `results`.

### `batch_commit` — error codes (per-result `error` field)

| Code | Meaning |
|------|---------|
| `path_escapes_repository` | One of the listed file paths resolves outside the git toplevel. |
| `stage_failed` | `git add` failed (e.g. untracked path or permission error). |
| `commit_failed` | `git commit` failed (e.g. nothing staged, hooks rejected). |
| `not_a_git_repository` | The resolved workspace root is not inside a git repository. |

---

## Resource

| URI | Purpose |
|-----|---------|
| `rethunk-git://presets` | JSON snapshot of `.rethunk/git-mcp-presets.json` at the resolved git toplevel (or structured errors). |

## Workspace root resolution

Order applied when resolving which directory(ies) tools run against:

1. Explicit **`workspaceRoot`** on the tool call (highest priority).
2. **`rootIndex`** (0-based) — one `file://` MCP root when several exist.
3. **`allWorkspaceRoots`: true** — every `file://` root; markdown output emits one `# {tool}` header with per-root subsections (`git_inventory` uses `### {gitTop}`; `git_status` uses `### MCP root: ...`), or combined JSON.
4. **`preset`** set and multiple roots — first root whose git toplevel defines that preset (respecting **`workspaceRootHint`** on the preset entry when present).
5. Otherwise the first `file://` root from MCP **`initialize`** / **`roots/list_changed`**.
6. **`process.cwd()`** if no file roots (e.g. CI with explicit `workspaceRoot`).

Roots come from the MCP session (**`FastMCP` with `roots: { enabled: true }`** in code); there is no fixed `cwd` in server config.
