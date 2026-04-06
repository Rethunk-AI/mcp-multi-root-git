# @rethunk/mcp-multi-root-git — User guide

Read-only MCP git tools for any workspace. **How the server is installed and wired to clients:** **[docs/install.md](docs/install.md)** only (do not restate that material here).

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

## `git_not_found`

If **`git`** is missing or not runnable, tools and the presets resource respond with **`git_not_found`**. Prerequisites and `PATH`: **[docs/install.md](docs/install.md)**.

## Installation

**Package install and MCP clients:** **[docs/install.md](docs/install.md)**.

## Development

Requires **Bun ≥ 1.3.11** to build this repository (`packageManager` in `package.json`). **Published runtime** (Node/Bun/Git and how to launch the server): **[docs/install.md](docs/install.md)** — *Prerequisites*.

```bash
bun install
bun run build      # rimraf dist + tsc → dist/server.js, dist/server/*.js, dist/repo-paths.js
bun run check      # Biome
bun run check:fix  # Biome --write
bun run setup-hooks   # once per clone: use .githooks (pre-commit: check; pre-push: CI parity)
```

**Git hooks:** after `setup-hooks`, **pre-commit** runs `bun run check`; **pre-push** runs `bun install --frozen-lockfile`, `bun run build`, `bun run check`, and `bun run test` (same order as CI). Set **`SKIP_GIT_HOOKS=1`** or use **`--no-verify`** to bypass.

**CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pull requests and pushes to `main`: **`actions/setup-node` with Node 24** (minimum 22 asserted), then `bun install --frozen-lockfile`, `bun run build`, `bun run check`, and `bun run test`. A follow-up job **`prerelease-pack`** builds the same tree and runs **`npm pack`**, then uploads a **prerelease `.tgz` artifact** (named with the commit SHA) you can download from the workflow run’s **Artifacts** section (retention 90 days). Match the check job locally before opening a PR.

## Publishing

### npm (production) — version tags only

Releases to [npmjs](https://www.npmjs.com/package/@rethunk/mcp-multi-root-git) are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml) when you push a **semver git tag** `vX.Y.Z` that **exactly matches** `version` in `package.json` (e.g. tag `v1.2.3` and `"version": "1.2.3"`).

1. Bump **`package.json` `version`**, commit on `main`.
2. Create and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`

The workflow runs build, check, and tests, publishes with **`npm publish`**, then creates a **GitHub Release** for that tag and attaches the same **`.tgz`** as a downloadable asset.

**Repository secret:** add **`NPM_TOKEN`** (granular npm access token with publish permission for `@rethunk/mcp-multi-root-git` or the scope). Without it, the publish step fails.

### Local publish (maintainers)

```bash
bun run prepublishOnly  # build + check + test
bun publish
```

`npm publish` works if `dist/` is built and checks pass. **`package.json` `files` includes the whole `dist/` directory** so every emitted chunk the entry imports is packed; if you add new `src/server/*.ts` modules, `tsc` will emit matching `dist/server/*.js` files—do not narrow `files` back to a single `server.js` or installs will break.
