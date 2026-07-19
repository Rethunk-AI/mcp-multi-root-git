# Security Policy

## Reporting Security Vulnerabilities

**DO NOT** open a public GitHub issue for security vulnerabilities. Instead, please report them responsibly to:

**Email:** security@rethunk.tech  
**Response SLA:** We aim to respond to security reports within 24 hours.

When reporting a vulnerability, please include:
- Description of the vulnerability
- Affected component(s) and version(s)
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (optional)

## Scope & Risk Profile

`mcp-multi-root-git` is an MCP **stdio** server that exposes **30** git tools to LLMs. It runs with the OS user's permissions and can read and modify local repositories the operator (or client) can reach.

### Tool surface (30)

**Fan-out read** (`root`: one path, path list, or `"*"`):

| Tool | Risk note |
|------|-----------|
| `git_status` | Working-tree / branch metadata |
| `git_inventory` | Status + ahead/behind across roots |
| `git_parity` | HEAD equality across path pairs |
| `list_presets` | Preset file discovery |
| `git_log` | Commit history / subjects / shortstat |
| `git_grep` | Content search in trees or working copy |

**Single-repo read** (`workspaceRoot`):

| Tool | Risk note |
|------|-----------|
| `git_diff_summary` | Structured diffs (truncated) |
| `git_diff` | Raw scoped diff text |
| `git_show` | Commit message + diff, or **file content at a ref** |
| `git_conflicts` | Conflict hunk text (ours/theirs/base) |
| `git_remote` | Remote URLs |
| `git_describe` | Nearest-tag description |
| `git_worktree_list` | Worktree paths and refs |
| `git_stash_list` | Stash entry metadata |
| `git_blame` | Authorship + line content runs |
| `git_branch_list` | Local / remote-tracking branch names |
| `git_reflog` | Reflog selectors and messages |

**Mutating** (`workspaceRoot` only — no multi-repo fan-out on writes):

| Tool | Effect |
|------|--------|
| `git_fetch` | Updates remote-tracking refs (no working-tree checkout) |
| `batch_commit` | Stages listed paths / hunks and creates commits; optional push-after |
| `git_push` | Pushes current branch; **never** force-pushes |
| `git_merge` | Merges sources into a destination; optional cleanup skips protected names |
| `git_cherry_pick` | Applies commits onto a destination; same protected-name cleanup rules; `onConflict: "pause"` leaves conflict + sequencer state in place instead of aborting; refuses a second call while one is already in progress |
| `git_cherry_pick_continue` | Resumes (`--continue`) or rolls back (`--abort`) a cherry-pick left in progress; stateless, reads `CHERRY_PICK_HEAD` live |
| `git_reset_soft` | Moves branch tip (`--soft`); history rewrite of the tip (objects kept in index) |
| `git_revert` | New inverse commit(s); **does not** rewrite history |
| `git_tag` | Create / delete tags |
| `git_branch` | Create / delete / rename local branches (protected names refused) |
| `git_worktree_add` | Adds a linked worktree (protected branch names refused) |
| `git_worktree_remove` | Removes a linked worktree (not the main worktree) |
| `git_stash_apply` | Apply or pop a stash entry |
| `git_stash_push` | Creates a new stash (may clear working-tree changes) |

There is **no** `git_pull` tool. Remote updates are via `git_fetch` (refs) and `git_push` (publish). Optional `batch_commit` `push: "after"` uses the same non-force push path.

### Trust model: `workspaceRoot` and MCP roots

**`workspaceRoot` (and fan-out `root` path strings) are trusted operator input.** The server resolves a path to a git toplevel and operates there. It does **not** whitelist those paths against the MCP session's advertised roots.

Consequence: any LLM tool call that supplies an absolute (or resolvable) path to a git repository the OS user can read/write can target that repository. Host clients must treat tool arguments as privileged and constrain who may invoke mutating tools.

MCP roots still matter for discovery and for `root: "*"` fan-out (session-advertised roots). They are **not** a sandbox boundary for explicit path arguments.

### Path confinement (file args under a chosen repo)

Once a git toplevel is selected, file-path arguments (commit paths, blame path, diff paths, stash pathspecs, worktree paths, etc.) are confined with `realpath`-based checks in `src/repo-paths.ts` (`resolvePathForRepo` / `assertRelativePathUnderTop` / `isStrictlyUnderGitTop`). Paths must resolve strictly under that toplevel; symlink escape outside the chosen repo is rejected.

This is **per-repo path confinement**, not an MCP-root allowlist. Choosing the wrong toplevel (see trust model above) is outside that control.

### Write operations risk

Mutating tools can lose uncommitted work, move refs, create or delete branches/tags/worktrees/stashes, or publish commits. Shipped controls (not aspirational TODOs):

| Control | Behavior |
|---------|----------|
| No force-push | `git_push` has **no** `--force` / `--force-with-lease` mode for any branch |
| Soft reset only | `git_reset_soft` is soft; hard/mixed reset are not exposed |
| Non-rewriting revert | `git_revert` adds inverse commits; does not rewrite tip history |
| Protected branches | See below — enforced on `git_branch`, `git_worktree_add`, and merge/cherry-pick cleanup |
| Pathspecs on commit | `batch_commit` stages only the listed entry files / hunks |
| Dirty-tree gates | Merge, cherry-pick, revert, and soft-reset refuse unsafe dirty trees as documented per tool |

**History rewrite vs non-rewrite:**

- **Rewrites tip (local):** `git_reset_soft` moves `HEAD`/branch tip; previously committed tip commits remain reachable via reflog until GC, but the branch no longer points at them. Force-push is unavailable, so remote history is not overwritten through this server.
- **Non-rewriting:** `git_revert`, `batch_commit`, `git_merge`, `git_cherry_pick`, `git_tag`, branch/worktree/stash tools (aside from deleting refs they own).

### Protected branches

Exact names (case-insensitive, optional `refs/heads/` prefix stripped): `main`, `master`, `dev`, `develop`, `stable`, `trunk`, `prod`, `production`, `head`.

Patterns: `release-*` / `release/*` and `hotfix-*` / `hotfix/*` (see `PROTECTED_PATTERN` in `src/server/git-refs.ts`).

Enforcement:

- `git_branch` refuses protected names in any role (create / delete / rename source or target)
- `git_worktree_add` refuses protected branch names
- `git_merge` / `git_cherry_pick` optional branch/worktree cleanup **skips** protected names

Protected-branch checks do **not** mean force-push is gated — force-push simply does not exist.

### Subprocess and injection controls

Git is invoked via argv arrays (`spawnGitAsync` in `src/server/git.ts`) — **no shell**, so shell metacharacter injection through a joined command string does not apply.

Untrusted tokens (refs, ranges, remotes, upstream names, etc.) must still pass validators such as `isSafeGitRefToken`, `isSafeGitRangeToken`, `isSafeGitCommitIsh`, `isSafeGitAncestorRef`, and `isSafeGitUpstreamToken` before being placed on the argv. Callers and future tools must keep routing user-controlled strings through those gates.

### Content exfiltration (read tools)

Read-only tools can surface secrets already present in tracked history or the working tree: `git_show` (file-at-ref), `git_blame`, `git_grep`, `git_log`, `git_diff` / `git_diff_summary`, and `git_conflicts` hunk text. Truncation reduces volume; it does **not** redact secrets. Treat any repo that may contain credentials as sensitive when exposing these tools to an LLM.

### Repository credentials

- Push and fetch use the host's git credential helpers / SSH agent; the server does not embed credentials
- Credentials must never be logged; this server does not implement a durable write-operation audit log (tool responses are the MCP client's responsibility to retain if needed)
- Prefer SSH agent or OS credential storage; do not put PATs in tool arguments or env visible to the model

### Deployment hardening: `RETHUNK_GIT_TOOLS`

Set `RETHUNK_GIT_TOOLS` to a comma-separated allowlist of tool names to shrink the registered surface (for example omit all mutators in a read-only deployment). When unset, all 31 tools register. Details: [docs/install.md](docs/install.md).

## Security Practices (operator)

- Constrain which principals may call mutating tools; remember `workspaceRoot` is trusted
- Use `RETHUNK_GIT_TOOLS` to drop write tools where not needed
- Keep git CLI, Node/Bun runtime, and dependencies (`fastmcp`, `zod`, etc.) patched; run `bun audit` regularly
- Prefer dedicated non-production clones when evaluating mutators
- Do not store secrets in tracked files that read tools can return

## Supported Versions

Latest release only.

| Version | Supported |
|---------|-----------|
| Latest  | ✅ Yes    |

## Known Vulnerabilities

None currently known. Reports are welcome via security@rethunk.tech.

## Testing & Validation

- Exercise path confinement with symlink escape attempts under a chosen git toplevel
- Confirm `git_push` rejects any attempt to introduce force flags (none are accepted in the schema)
- Confirm protected-name refusals on `git_branch` / `git_worktree_add` and cleanup skips on merge/cherry-pick
- Confirm invalid ref tokens fail validators before spawn
- Run mutators only on disposable test repositories

## Incident Response

If a security vulnerability is discovered:

1. **Report immediately** to security@rethunk.tech (do not disclose publicly)
2. **Include reproduction steps** and affected version(s)
3. **Allow 24-48 hours** for initial response and triage
4. **Coordinate disclosure** timeline if a patch is required
5. **Credit will be given** to the reporter (if desired)

## Contact

- **Security Issues:** security@rethunk.tech
- **General Support:** support@rethunk.tech
- **Website:** https://rethunk.tech

---

**Last updated:** 2026-07-18
