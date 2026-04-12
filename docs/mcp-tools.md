# MCP tools and resources (canonical reference)

Single source of truth for **registered tool ids**, **client naming**, **JSON output shape**, **resource URI**, and **workspace root resolution**.  
**Install and MCP clients (only canonical location):** [install.md](install.md). **Preset file, dev, CI, publishing:** [HUMANS.md](../HUMANS.md). **Implementation layout (`src/server/` + entry [`server.ts`](../src/server.ts)), contract bumps:** [AGENTS.md](../AGENTS.md).

## Naming

MCP clients expose tools as `{serverName}_{toolName}`. With the server registered as **`rethunk-git`**, examples use the prefix **`rethunk-git_`**.

## Tools

| Short id | Client id (server `rethunk-git`) | Purpose |
|----------|-----------------------------------|---------|
| `git_status` | `rethunk-git_git_status` | `git status --short -b` per MCP root and optional submodules (`includeSubmodules`); parallel submodule status. Args include `allWorkspaceRoots`, `rootIndex`, `workspaceRoot`, `format`. |
| `git_inventory` | `rethunk-git_git_inventory` | Status + ahead/behind per path; default upstream each repo’s `@{u}`; pass **both** `remote` and `branch` for fixed tracking. `nestedRoots`, `preset`, `presetMerge`, `maxRoots`, `format`, plus workspace pick args. |
| `git_parity` | `rethunk-git_git_parity` | Compare `git rev-parse HEAD` for path pairs. `pairs`, `preset`, `presetMerge`, `format`, plus workspace pick args. |
| `list_presets` | `rethunk-git_list_presets` | List preset names/counts from `.rethunk/git-mcp-presets.json`; invalid JSON/schema surface as errors. Workspace pick + `format` only. |

Pass **`format: "json"`** on any tool for structured JSON instead of markdown (default).

## JSON responses

Tool JSON bodies are minified and contain only the payload — no `rethunkGitMcp` envelope. Current `MCP_JSON_FORMAT_VERSION` is **`"2"`**; server + format version are discoverable via MCP `initialize`. Payload keys (`groups`, `inventories`, `parity`, `roots`) are stable within a given format version. Preset-related responses may include **`presetSchemaVersion`**.

### v2 field omission (consumer contract)

To keep responses compact, **optional fields are omitted when they would be empty, `null`, or `false`** — they are not emitted as `null`. Consumers must test for *presence*, not compare to `null`.

**`git_inventory` → `inventories[*]`**

- Always present: `workspace_root`, `entries`.
- Omitted when not applicable: `presetSchemaVersion`, `nestedRootsTruncated`, `nestedRootsOmittedCount`, and the whole `upstream` object (emitted only when a fixed `remote`/`branch` pair was supplied; in `auto` mode it is absent).

**`git_inventory` → `entries[*]` (`InventoryEntryJson`)**

- Always present: `label`, `path`, `upstreamMode` (`"auto"` or `"fixed"`).
- Optional (omitted when empty/absent): `branchStatus`, `headAbbrev`, `upstreamRef`, `ahead`, `behind`, `upstreamNote`, `detached` (only emitted as `true`), `skipReason` (only on skipped entries).
- **Removed in v2:** `shortStatus`. The porcelain entries now live inside `branchStatus` (the full `git status --short -b` body — branch header line followed by porcelain lines).

**Errors** (any tool)

- Error payloads carry an `error` code string and any structured context (e.g. `preset`, `presetFile`). The old free-text `message` field is **removed** for self-describing codes (`git_not_found`, `remote_branch_mismatch`, `invalid_remote_or_branch`, `no_pairs`, `preset_not_found` *missing* case). It is retained only where it carries parse output (the `invalid_json` preset branch).

**When to bump `MCP_JSON_FORMAT_VERSION` or change payload shape:** [AGENTS.md](../AGENTS.md) — *Changing contracts*.

## Resource

| URI | Purpose |
|-----|---------|
| `rethunk-git://presets` | JSON snapshot of `.rethunk/git-mcp-presets.json` at the resolved git toplevel (or structured errors). |

## Workspace root resolution

Order applied when resolving which directory(ies) tools run against:

1. Explicit **`workspaceRoot`** on the tool call (highest priority).
2. **`rootIndex`** (0-based) — one `file://` MCP root when several exist.
3. **`allWorkspaceRoots`: true** — every `file://` root; markdown output emits one `# {tool}` header with per-root subsections (`git_inventory` uses `### {gitTop}`; `git_status` uses `### MCP root: ...`), or combined JSON.
4. **`preset`** set and multiple roots — first root whose git toplevel defines that preset (respecting **`workspaceRootHint`** on the preset entry when present).
5. Otherwise the first `file://` root from MCP **`initialize`** / **`roots/list_changed`**.
6. **`process.cwd()`** if no file roots (e.g. CI with explicit `workspaceRoot`).

Roots come from the MCP session (**`FastMCP` with `roots: { enabled: true }`** in code); there is no fixed `cwd` in server config.
