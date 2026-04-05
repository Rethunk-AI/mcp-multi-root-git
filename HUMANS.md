# @rethunk/mcp-multi-root-git — User guide

Read-only **MCP stdio** git tools for any workspace. No `cwd` in MCP config: the client supplies workspace roots at `initialize`.

For **LLM/developer onboarding**, implementation maps, and contract-change rules, see **[AGENTS.md](AGENTS.md)**.

## Tools

MCP clients expose tools as `{serverName}_{toolName}` (e.g. `rethunk-git_git_status` when the server is registered as `rethunk-git`). Registered short ids:

| Registered id   | Purpose |
|-----------------|---------|
| `git_status`    | `git status --short -b` per MCP root + optional submodules; `allWorkspaceRoots` / `rootIndex` |
| `git_inventory` | Status + ahead/behind per root; default upstream is each repo's `@{u}`; set both `remote` and `branch` for a fixed pair |
| `git_parity`    | Compare `git rev-parse HEAD` for left/right path pairs |
| `list_presets`  | List preset names and counts from `.rethunk/git-mcp-presets.json` (invalid JSON/schema surface as errors) |

Pass **`format: "json"`** on a tool for structured JSON instead of markdown.

### JSON responses (summary)

Every JSON string from a tool (including errors) includes a trailing **`rethunkGitMcp`** object with **`jsonFormatVersion`** (`"1"`) and **`packageVersion`**. Payloads such as `groups`, `inventories`, `parity`, and `roots` are stable for that version. Preset-driven responses may include **`presetSchemaVersion`**. When to bump versions or rename fields is documented in **[AGENTS.md](AGENTS.md)**.

## Resource

| URI | Purpose |
|-----|---------|
| `rethunk-git://presets` | JSON snapshot of `.rethunk/git-mcp-presets.json` at the resolved git toplevel (or structured errors) |

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

## Git on PATH

The server runs **`git`** subprocesses. If `git` is missing or `git --version` fails, tools respond with **`git_not_found`** (JSON), including when reading the presets resource as JSON.

## Installation

```bash
npm install -g @rethunk/mcp-multi-root-git
npx -y @rethunk/mcp-multi-root-git
bunx @rethunk/mcp-multi-root-git
```

## Cursor user-level MCP

Add to `~/.cursor/mcp.json` (no `cwd`; Cursor passes workspace roots):

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

With Bun globally: `"command": "bunx"`, `"args": ["@rethunk/mcp-multi-root-git"]`.

## Workspace root resolution

1. Explicit **`workspaceRoot`** on the tool call (highest priority).
2. **`rootIndex`** (0-based) — one `file://` MCP root when several exist.
3. **`allWorkspaceRoots`: true** — every `file://` root; markdown sections separated by `---`, or combined JSON.
4. **`preset`** set and multiple roots — root whose git toplevel defines that preset (respecting **`workspaceRootHint`**).
5. Otherwise the first `file://` root from MCP **`initialize`** / **`roots/list_changed`**.
6. **`process.cwd()`** if no file roots (e.g. CI with explicit `workspaceRoot`).

## Development

Requires **Bun ≥ 1.3.11** (`packageManager` in `package.json`). Published usage still targets **Node ≥ 22** for `npx` / global installs.

```bash
bun install
bun run build      # rimraf dist + tsc → dist/server.js only
bun run check      # Biome
bun run check:fix  # Biome --write
```

**CI:** pull requests run `bun install --frozen-lockfile`, `bun run build`, and `bun run check` (see `.github/workflows/ci.yml`). Match that locally before opening a PR.

### Cursor (this repository)

[`.cursor/mcp.json`](.cursor/mcp.json) runs **rethunk-git** with `bun src/server.ts` (no prior `dist/` build). Reload MCP if tools are missing. Agent behavior in this workspace: [`.cursor/rules/rethunk-git-mcp.mdc`](.cursor/rules/rethunk-git-mcp.mdc) (short nudge; details in **AGENTS.md**).

## Publishing

```bash
bun run prepublishOnly  # build + check
bun publish
```

`npm publish` works if `dist/` is built and checks pass.
