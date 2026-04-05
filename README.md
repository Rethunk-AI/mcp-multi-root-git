# @rethunk/mcp-multi-root-git

MCP stdio server providing three read-only git tools for any workspace. No `cwd` in MCP config — workspace root comes from the client's MCP roots (provided at `initialize`).

## Tools

MCP clients expose these as `{serverName}_{toolName}` (e.g. `rethunk-git_git_status`). Register the server with name `rethunk-git` (or any name you choose); the tools' registered short ids are:

| Registered id   | Purpose |
|-----------------|---------|
| `git_status`    | `git status --short -b` for workspace root + optional submodules |
| `git_inventory` | Status + ahead/behind per listed root; ordered for push prep |
| `git_parity`    | Compare `git rev-parse HEAD` for left/right path pairs |

## Workspace preset file

For multi-root repos, commit a file at **`.rethunk/git-mcp-presets.json`** in your workspace root:

```json
{
  "push-prep": {
    "nestedRoots": ["path/to/package-a", "path/to/package-b"],
    "parityPairs": [
      { "left": "core/packages/shared", "right": "edge/packages/shared", "label": "shared" }
    ]
  }
}
```

Then call tools with `"preset": "push-prep"` instead of passing paths inline.

**This file is not part of the npm package.** Each repo that needs named presets commits its own file.

### Schema

```jsonc
// .rethunk/git-mcp-presets.json
{
  "<preset-name>": {
    "nestedRoots": ["<relative-path>", ...],   // for git_inventory
    "parityPairs": [                             // for git_parity
      { "left": "<rel>", "right": "<rel>", "label": "<display>" }
    ]
  }
}
```

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
2. First `file://` root from the MCP `initialize` / `roots/list_changed` (Cursor, Claude Desktop, etc. send these automatically).
3. `process.cwd()` as a last resort (useful in CI and test harnesses that pass explicit `workspaceRoot`).

When a client sends multiple roots, the first valid `file://` root wins. Document tie-breaking in your own skill if you need a different policy.

## Development

Requires **Bun ≥ 1.3.11** (see `packageManager` in `package.json`). The published package still runs under **Node ≥ 22** for `npx` and global npm installs.

```bash
bun install
bun run build      # tsc → dist/
bun run check      # Biome lint + format check
bun run check:fix  # Auto-fix Biome issues
```

## Publishing

```bash
bun run prepublishOnly  # build + check
bun publish             # publishes @rethunk/mcp-multi-root-git
```

`npm publish` still works if you prefer it, as long as `dist/` is built and checks pass.
