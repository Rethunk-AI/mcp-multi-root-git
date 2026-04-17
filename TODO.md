# TODO / Feature requests — rethunk-git MCP

Feature asks driven by real pain points from agent sessions. Each item lists the motivating scenario and the expected tool shape.

## High value — reduce Bash fallback

### `batch_commit` — `stage` argument for path/hunk scoping

**Pain:** `batch_commit` stages whole files atomically. Subagents asked to produce N commits from a single file edit cannot split post-hoc (sandbox blocks `git reset --soft`; `git rebase -i` is interactive).

**Ask:** Allow scoped staging:

```ts
batch_commit({
  stage: { paths: ["Makefile"], hunks: [{ file: "Makefile", lines: "120-180" }] },
  message: "feat(make): add sbom target"
})
```

Path-level `files: string[]` already exists per-entry on `batch_commit`. Remaining gap is hunk-level staging via `git add -p` patch interface.

### `git_worktree_add` / `git_worktree_remove` / `git_worktree_list`

**Pain:** Parallel subagent batches use worktrees heavily. Today: Bash `git worktree add/remove/list`. Should be MCP-native.

**Ask:**

```ts
git_worktree_add({ path: ".claude/worktrees/agent-abc", branch: "worktree-agent-abc", baseRef: "main" })
git_worktree_remove({ path: "...", force?: false })
git_worktree_list() // → [{ path, branch, commit, locked }]
```

### `git_reset_soft` MCP tool

**Pain:** Sandbox blocks Bash `git reset --soft HEAD~N`, but this is the only way to split atomic commits. Subagents hit this repeatedly.

**Ask:** Narrow, safe MCP tool:

```ts
git_reset_soft({ ref: "HEAD~3" })
// Reset branch pointer by N commits while keeping staged index.
// Refuses if working tree is dirty (reserve for workflows where all changes are already committed).
```

## Medium value — ergonomics

### `git_diff` — scoped

**Pain:** `git_diff_summary` is aggregate; sometimes need the actual diff text for a specific file/range. Currently Bash fallback.

**Ask:**

```ts
git_diff({ paths?: string[], base?: "HEAD~1", target?: "HEAD", unified?: 3 })
```

### `git_show` MCP tool

**Pain:** Inspecting a subagent branch's commits uses Bash `git show <sha>`. Should be covered.

**Ask:**

```ts
git_show({ ref: "sha", stat?: boolean, paths?: string[] })
```

### `batch_commit` — `dry_run: true`

**Pain:** Agent wants to verify staging is what it thinks before committing. Today: commit, inspect, reset (blocked), retry.

**Ask:** `dry_run: true` reports what would be committed (files, message, diff summary) without writing.

## Low value — nice to have

### `git_stash_apply` / `git_stash_list` MCP tools

Currently Bash. Stash flows come up occasionally in agent sessions when a conflict needs to be set aside.

### `git_tag` MCP tool

For release workflows: `git_tag({ name: "v0.6.0", message: "Release 0.6.0", signed?: false })`.

### `git_fetch` MCP tool

With structured output: `{ updated: [{ ref, oldSha, newSha }], newRefs: [...] }`.

## Non-tool asks

### Document `batch_commit` atomic-stage semantics

In `docs/` README: state clearly that `batch_commit` stages listed files atomically before creating the commit, so N back-to-back calls to `batch_commit` on the same file cannot produce N commits with distinct content. Agents routinely expect per-call incremental semantics.

### Publish JSON schemas for all MCP tool args

Helps agents validate calls locally before invoking. Also eases codegen for skill builders.
