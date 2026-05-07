# TODO / Feature requests — rethunk-git MCP

Feature asks driven by real pain points from agent sessions. Each item lists the motivating scenario and the expected tool shape.

## High value — deepen current tools

### `git_diff` — multi-path + context controls

**Pain:** `git_diff` now covers a single optional path plus base/head or staged mode, but agents still sometimes need one call that spans multiple paths with explicit context width.

**Ask:**

```ts
git_diff({ paths?: string[], base?: "HEAD~1", head?: "HEAD", unified?: 3 })
```

### `git_show` — stat / multi-path modes

**Pain:** `git_show` now covers a ref plus one optional path, but some sessions only need `--stat` output or a filtered set of paths without full patch text.

**Ask:**

```ts
git_show({ ref: "sha", stat?: true, paths?: string[] })
```

## Medium value — nice to have

### `git_fetch` MCP tool

Current output is string-based (`updatedRefs[]`, `newRefs[]`). Remaining gap is richer structured deltas:

```ts
git_fetch({ updated: [{ ref, oldSha, newSha }], newRefs: [...] })
```
