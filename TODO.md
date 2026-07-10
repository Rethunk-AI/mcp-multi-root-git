# TODO / Feature requests — rethunk-git MCP

Feature asks driven by real pain points from agent sessions. Each item lists the motivating scenario and the expected tool shape.

## Medium value — deepen current tools

### `git_grep` — pickaxe history search

**Pain:** `git_grep` covers content search (working tree or at a ref), but "when did this string appear/disappear?" still needs shell `git log -S`.

**Ask:**

```ts
git_grep({ pickaxe: { mode: "S" | "G", term: "needle" } })
// → commits touching the term, oneline-style, instead of file/line matches
```

Different output shape from content mode — design the payload before implementing.

### `git_log` — follow renames for a single path

**Pain:** file-history questions ("who touched this file before it was renamed?") fall back to shell `git log --follow`.

**Ask:**

```ts
git_log({ paths: ["src/one-file.ts"], follow: true })
// git constraint: --follow requires exactly one path — validate that
```

### `git_inventory` — ahead/behind between arbitrary ref pairs

**Pain:** `git_inventory` reports upstream ahead/behind only; comparing arbitrary local refs (e.g. `main` vs a long-lived feature branch) needs shell `rev-list --count`.

Small extension to `git_inventory` or `git_log`, not a new tool.
