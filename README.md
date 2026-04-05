# @rethunk/mcp-multi-root-git

MCP stdio server providing read-only git tools for any workspace. No `cwd` in MCP config — workspace root comes from the client's MCP roots (provided at `initialize`).

## Tools

MCP clients expose these as `{serverName}_{toolName}` (e.g. `rethunk-git_git_status`). Register the server with name `rethunk-git` (or any name you choose); the tools' registered short ids are:

| Registered id   | Purpose |
|-----------------|---------|
| `git_status`    | `git status --short -b` per MCP root + optional submodules; supports `allWorkspaceRoots` / `rootIndex` |
| `git_inventory` | Status + ahead/behind per listed root; default upstream is each repo's `@{u}`; set both `remote` and `branch` for a fixed pair |
| `git_parity`    | Compare `git rev-parse HEAD` for left/right path pairs |
| `list_presets`  | List preset names and counts from `.rethunk/git-mcp-presets.json` (surfaces invalid JSON / schema errors) |

Optional `format: "json"` on each tool returns structured JSON instead of markdown.

## Resource

| URI | Purpose |
|-----|---------|
| `rethunk-git://presets` | JSON snapshot of `.rethunk/git-mcp-presets.json` at the resolved git toplevel (or structured errors) |

## Workspace preset file

For multi-root repos, commit a file at **`.rethunk/git-mcp-presets.json`** at the **git repository root** (same directory as `.git`):

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

Then call tools with `"preset": "push-prep"` instead of passing paths inline. Use `presetMerge: true` on `git_inventory` or `git_parity` to combine preset paths/pairs with inline `nestedRoots` / `pairs`.

When several MCP file roots exist and you pass a `preset` name, the server picks the first root whose git toplevel loads a preset file containing that name. If that preset entry includes `workspaceRootHint`, only MCP roots whose path basename (or suffix) matches the hint are considered.

**This file is not part of the npm package.** Each repo that needs named presets commits its own file.

Invalid JSON or schema errors in an existing preset file are returned as structured tool errors (`preset_file_invalid`) instead of a silent empty result.

### Schema

```jsonc
// .rethunk/git-mcp-presets.json
{
  "<preset-name>": {
    "nestedRoots": ["<relative-path>", ...],   // git_inventory (optional; merge with presetMerge)
    "parityPairs": [                             // git_parity
      { "left": "<rel>", "right": "<rel>", "label": "<display>" }
    ],
    "workspaceRootHint": "<basename-or-suffix>"  // optional; multi-root MCP disambiguation
  }
}
```

Paths in presets are resolved under the git toplevel; relative paths that escape the repository are rejected.

## Installation

```bash
npm install -g @rethunk/mcp-multi-root-git
# or use via npx (no install required):
npx -y @rethunk/mcp-multi-root-git
# with Bun (no install required):
bunx @rethunk/mcp-multi-root-git
```

## Cursor user-level MCP config

Add to `~/.cursor/mcp.json` (no `cwd` needed — Cursor supplies workspace roots automatically):

```json
{
  "mcpServers": {
    "rethunk-git": {
      "command": "npx",
      "args": ["-y", "@rethunk/mcp-multi-root-git"]
    }
  }
}
```

If you use Bun globally, you can set `"command": "bunx"` and `"args": ["@rethunk/mcp-multi-root-git"]` instead of `npx`.

## Workspace root resolution

1. Explicit `workspaceRoot` arg in the tool call (overrides everything).
2. `rootIndex` (0-based) selects a single `file://` MCP root when multiple exist.
3. `allWorkspaceRoots: true` runs the tool for every `file://` root and aggregates (markdown sections separated by `---`, or JSON arrays).
4. If `preset` is set and multiple MCP roots exist, the server selects a root whose git toplevel defines that preset (respecting `workspaceRootHint` when present).
5. Otherwise the first `file://` root from MCP `initialize` / `roots/list_changed`.
6. `process.cwd()` as a last resort when no file roots exist (useful in CI and test harnesses that pass explicit `workspaceRoot`).

## Development

Requires **Bun ≥ 1.3.11** (see `packageManager` in `package.json`). The published package still runs under **Node ≥ 22** for `npx` and global npm installs.

```bash
bun install
bun run build      # tsc → dist/
bun run check      # Biome lint + format check
bun run check:fix  # Auto-fix Biome issues
```

### Cursor (project MCP)

This repo includes [`.cursor/mcp.json`](.cursor/mcp.json), which starts **rethunk-git** with `bun src/server.ts` (no `dist/` build required for the editor). Open the workspace in Cursor, then **reload MCP** (Command Palette → “MCP: Reload Servers” or equivalent) if the tools do not appear. Agents in this project are guided by [`.cursor/rules/rethunk-git-mcp.mdc`](.cursor/rules/rethunk-git-mcp.mdc) to prefer **`rethunk-git_git_*`** tools for workspace git queries.

## Publishing

```bash
bun run prepublishOnly  # build + check
bun publish             # publishes @rethunk/mcp-multi-root-git
```

`npm publish` still works if you prefer it, as long as `dist/` is built and checks pass.
