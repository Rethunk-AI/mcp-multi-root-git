# @rethunk/mcp-multi-root-git — User guide

MCP git tools for any workspace. **How the server is installed and wired to clients:** **[docs/install.md](docs/install.md)** only (do not restate that material here).

## Badges

[![Release](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/release.yml/badge.svg)](https://github.com/Rethunk-AI/mcp-multi-root-git/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/Rethunk-AI/mcp-multi-root-git?logo=github&label=release)](https://github.com/Rethunk-AI/mcp-multi-root-git/releases/latest)
[![npm downloads](https://img.shields.io/npm/dm/%40rethunk%2Fmcp-multi-root-git.svg?label=npm%20downloads)](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git)
[![GitHub Packages](https://img.shields.io/badge/github%20packages-%40rethunk--ai%2Fmcp--multi--root--git-24292f?logo=github)](https://github.com/Rethunk-AI/mcp-multi-root-git/packages)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://github.com/Rethunk-AI/mcp-multi-root-git/blob/main/package.json)

**Implementation map (modules under `src/server/`, entry `src/server.ts`), symbols, and contract bumps** live in **`AGENTS.md`** at the repository root. This guide does not repeat those sections.

**Registered tool ids, client naming (`rethunk-git_*`), `format` / JSON envelopes, resource URI, workspace root resolution:** **[docs/mcp-tools.md](docs/mcp-tools.md)** — canonical; not duplicated here.

## Workspace preset file

Commit **`.rethunk/git-mcp-presets.json`** at the **git repository root** (next to `.git`).

Example (legacy-style map):

```json
{
  "push-prep": {
    "nestedRoots": ["path/to/package-a", "path/to/package-b"],
    "parityPairs": [
      { "left": "core/packages/shared", "right": "edge/packages/shared", "label": "shared" }
    ],
    "workspaceRootHint": "my-repo"
  }
}
```

Call tools with `"preset": "push-prep"` instead of passing paths inline. Use **`presetMerge`: true** on `git_inventory` or `git_parity` to merge preset paths/pairs with inline `nestedRoots` / `pairs`.

With **multiple MCP file roots**, the server picks a root whose git toplevel defines that preset. If the preset entry has **`workspaceRootHint`**, only MCP roots whose basename or path suffix match are considered.

**JSON Schema** ships with the package as **`git-mcp-presets.schema.json`** for editor validation. Example wrapped layout:

```json
{
  "$schema": "./node_modules/@rethunk/mcp-multi-root-git/git-mcp-presets.schema.json",
  "schemaVersion": "1",
  "presets": {
    "push-prep": {
      "nestedRoots": ["packages/a"],
      "parityPairs": []
    }
  }
}
```

If you installed from **GitHub Packages**, use **`./node_modules/@rethunk-ai/mcp-multi-root-git/git-mcp-presets.schema.json`** in **`$schema`** instead (see [docs/install.md](docs/install.md#github-packages)).

## Tool parameter schema artifact

The package ships **`tool-parameters.schema.json`**, a generated JSON Schema snapshot of every registered tool's parameter schema. Maintainers regenerate it with:

```bash
bun run schema:tools
```

CI and `prepublishOnly` use:

```bash
bun run schema:tools:check
```

This artifact is for inspection, drift checks, and clients that want an offline schema snapshot. Runtime MCP schema discovery remains the source of truth for connected clients.

**Layouts:**

1. **Wrapped (recommended):** `{ "schemaVersion": "1", "presets": { "<name>": { ... } } }`.
2. **Legacy map:** `{ "<preset-name>": { ... } }` with optional top-level `"schemaVersion"` and `"$schema"`.

Invalid JSON or schema errors return **`preset_file_invalid`** (not a silent empty result).

### Preset entry (quick reference)

```jsonc
{
  "<preset-name>": {
    "nestedRoots": ["<relative-path>", ...],
    "parityPairs": [{ "left": "<rel>", "right": "<rel>", "label": "<display>" }],
    "workspaceRootHint": "<basename-or-suffix>"
  }
}
```

Relative preset paths must stay inside the git toplevel; escapes are rejected.

## Sibling clone batches

Use **`absoluteGitRoots`** when you want one read-only call to inspect independent sibling clones that are not all exposed as MCP workspace roots. This is most useful from agent workflows rooted at a parent directory or when an MCP client exposes only one repo root.

Example `git_status` batch:

```json
{
  "format": "json",
  "absoluteGitRoots": [
    "/usr/local/src/com.github/Rethunk-AI/mcp-multi-root-git",
    "/usr/local/src/com.github/Rethunk-AI/rethunk-github-mcp"
  ]
}
```

Example `git_parity` batch using the same pair in each sibling clone:

```json
{
  "format": "json",
  "absoluteGitRoots": [
    "/usr/local/src/com.github/Rethunk-AI/mcp-multi-root-git",
    "/usr/local/src/com.github/Rethunk-AI/rethunk-github-mcp"
  ],
  "pairs": [{ "left": "packages/shared", "right": "apps/web/shared", "label": "shared" }]
}
```

`absoluteGitRoots` is read-only by design. Mutating tools such as **`batch_commit`**, **`git_push`**, **`git_merge`**, and **`git_cherry_pick`** omit it from their schema; use `workspaceRoot` or MCP roots for writes. Full parameter rules and error codes live in **[docs/mcp-tools.md](docs/mcp-tools.md#absoluteGitRoots-sibling-clones)**.

## Prerequisites

- **Git** on `PATH` (`git --version`). Missing git → all tools return `git_not_found`.
- **Node.js ≥ 22** (for `npx`) or **Bun** (for `bunx`). See `engines` in `package.json`.
- No other runtime dependencies; the server is a self-contained MCP stdio process.

## Running the server

The server is a **stdio** MCP process — your MCP client starts it. You do not run it directly. Quick start:

```bash
# npmjs (public, may lag tags)
npx -y @rethunk/mcp-multi-root-git

# GitHub Packages (CI-aligned, every tag)
npx -y @rethunk-ai/mcp-multi-root-git   # requires ~/.npmrc with @rethunk-ai registry token
```

Add the server to your MCP client config under a stable name (e.g. `rethunk-git`). Full per-client config (Cursor, VS Code, Claude Desktop, Zed): **[docs/install.md](docs/install.md)**.

## Common operations

Call tools by their registered id (prefix depends on client config name):

| Operation | Tool |
|-----------|------|
| Check status across workspace roots | `git_status` |
| Status + ahead/behind for submodules | `git_inventory` |
| Compare HEAD between path pairs | `git_parity` |
| List preset names | `list_presets` |
| View commit log | `git_log` |
| View diff | `git_diff_summary` |
| Create commits | `batch_commit` |
| Push a branch | `git_push` |
| Merge branches | `git_merge` |
| Cherry-pick commits | `git_cherry_pick` |
| Soft-reset HEAD | `git_reset_soft` |
| Manage worktrees | `git_worktree_list` / `git_worktree_add` / `git_worktree_remove` |

Full parameter tables and JSON shapes: **[docs/mcp-tools.md](docs/mcp-tools.md)**.

## `git_not_found`

If **`git`** is missing or not runnable, tools and the presets resource respond with **`git_not_found`**. Ensure `git` is on `PATH` in the environment that launches the MCP server.

## Installation

**Full install instructions and MCP client wiring:** **[docs/install.md](docs/install.md)**.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, build commands, git hooks, commit conventions, CI, and how to add a tool.

## Publishing

### GitHub (automated) — version tags only

Tag pushes run [`.github/workflows/release.yml`](.github/workflows/release.yml): build, check, tests, then:

1. **`npm pack`** using the committed **`package.json`** name [`@rethunk/mcp-multi-root-git`](https://github.com/Rethunk-AI/mcp-multi-root-git) — tarball attached to a **GitHub Release** for that tag.
2. **GitHub Packages** (npm registry): the workflow temporarily rewrites the package **name** to **`@rethunk-ai/mcp-multi-root-git`** (required scope for org `Rethunk-AI` on GitHub) and runs **`npm publish`** to **`https://npm.pkg.github.com`** with **`GITHUB_TOKEN`** (`packages: write`). No npmjs token is used in CI.

Prerequisite: push a **semver git tag** `vX.Y.Z` that **exactly matches** `version` in `package.json` (e.g. `v1.2.3` and `"version": "1.2.3"`).

Before tagging, run the clean-tree preflight from the release commit:

```bash
bun run publish:preflight
```

It verifies the `package.json` version has a matching `CHANGELOG.md` section, generated tool schemas are current, build/check/coverage pass, and `npm pack --dry-run` includes the expected package files.

### npmjs (manual) — maintainers only

npmjs no longer fits an unattended CI publish flow for this org; **do not** rely on automation to [npmjs](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git). To publish the **same** package name consumers already use (**`@rethunk/mcp-multi-root-git`**):

1. On a clean checkout at the release commit (usually **`main`** after bumping version), run **`bun run prepublishOnly`** (or `bun run build && bun run check && bun run test`).
2. Log in to the public registry once per machine: **`npm login`** (or `npm adduser`) so **`npm whoami`** shows the account that owns **`@rethunk`** on npmjs.
3. Ensure **`package.json`** still has **`"name": "@rethunk/mcp-multi-root-git"`** and **`publishConfig.access`** is **`"public"`** (no **`publishConfig.registry`** pointing at GitHub — leave default registry for npmjs).
4. Publish: **`npm publish --access public`** (runs **`prepublishOnly`** again unless you pass **`--ignore-scripts`** after you already verified locally).

**`package.json` `files`** must keep the whole **`dist/`** directory so every emitted chunk the entry imports is packed; if you add new `src/server/*.ts` modules, `tsc` emits matching **`dist/server/*.js`** files — do not narrow **`files`** back to a single **`server.js`** or installs break.

**Preset `$schema`:** after **`npm install`**, the schema path is under **`node_modules/@rethunk/mcp-multi-root-git/`** for npmjs, or **`node_modules/@rethunk-ai/mcp-multi-root-git/`** when installing from GitHub Packages — adjust **`$schema`** accordingly (see [docs/install.md](docs/install.md)).
