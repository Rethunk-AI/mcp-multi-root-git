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

### JSON responses and stability

Every JSON string returned by a tool (including error-only responses) ends with a **`rethunkGitMcp`** object:

- **`jsonFormatVersion`**: `"1"` for this response shape; bump only when field names or nesting change in a breaking way.
- **`packageVersion`**: value from this server’s `package.json` at runtime.

Tool-specific payloads (for example `groups`, `inventories`, `parity`, `roots`) are stable within a given `jsonFormatVersion`. When using presets, successful loads may also include **`presetSchemaVersion`** on the preset file (`"1"` when set explicitly in JSON).

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

Each consuming repo commits its own **`.rethunk/git-mcp-presets.json`**. The **JSON Schema** for that file ships with this package as **`git-mcp-presets.schema.json`** (also at the repo root here) so editors can validate it.

Point VS Code / Cursor at the schema, for example:

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

**Layouts supported:**

1. **Wrapped (recommended):** `{ "schemaVersion": "1", "presets": { "<name>": { ... } } }` — use `schemaVersion` `"1"` with the published schema.
2. **Legacy map:** `{ "<preset-name>": { ... }, ... }` with optional top-level `"schemaVersion"` and `"$schema"` (meta keys are ignored for preset names).

Invalid JSON or schema errors in an existing preset file are returned as structured tool errors (`preset_file_invalid`) instead of a silent empty result.

### Schema (quick reference)

```jsonc
// .rethunk/git-mcp-presets.json — preset entry shape
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

The server requires a working **`git`** on `PATH` (`git --version`); otherwise tools respond with `git_not_found` in JSON (or the same payload when clients read resources as JSON).

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
bun run build      # rimraf dist + tsc → dist/server.js only (no .map / .d.ts)
bun run check      # Biome lint + format check
bun run check:fix  # Auto-fix Biome issues
```

Pull requests run **`bun install --frozen-lockfile`**, **`bun run build`**, and **`bun run check`** via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

### Cursor (project MCP)

This repo includes [`.cursor/mcp.json`](.cursor/mcp.json), which starts **rethunk-git** with `bun src/server.ts` (no `dist/` build required for the editor). Open the workspace in Cursor, then **reload MCP** (Command Palette → “MCP: Reload Servers” or equivalent) if the tools do not appear. Agents in this project are guided by [`.cursor/rules/rethunk-git-mcp.mdc`](.cursor/rules/rethunk-git-mcp.mdc) to prefer **`rethunk-git_git_*`** tools for workspace git queries.

## Publishing

```bash
bun run prepublishOnly  # build + check
bun publish             # publishes @rethunk/mcp-multi-root-git
```

`npm publish` still works if you prefer it, as long as `dist/` is built and checks pass.
