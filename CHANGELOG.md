# Changelog

All notable changes to `@rethunk/mcp-multi-root-git` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com); the project uses [Semantic Versioning](https://semver.org).

## [2.2.0] — 2026-04-17

Mutating git operations: merge, cherry-pick, and optional push-after for `batch_commit`.

### Added

- **`git_merge`** tool — merge one or more source branches into a destination. Default strategy `auto` cascades fast-forward → rebase → merge-commit per source, preferring linear history. Refuses on dirty tree; stops on first conflict with structured path report. Optional `deleteMergedBranches` / `deleteMergedWorktrees` cascade cleanup, always skipping protected names (`main`, `master`, `dev`, `develop`, `stable`, `trunk`, `prod`, `production`, `release*`, `hotfix*`).
- **`git_cherry_pick`** tool — play commits from one or more sources onto a destination. Sources may be SHAs, `A..B` ranges, or branch names (expanded to `onto..<branch>`, oldest-first). Uses `--empty=drop` so patch-equivalent re-applies add nothing. Refuses on dirty tree; stops on first conflict, aborting cleanly. Same protected-name cleanup flags as `git_merge`.
- **`batch_commit`** `push: "after"` — push the current branch to its upstream once every commit in the batch lands. Omitted by default; no behavior change for existing callers.

### Changed

- **Internal** — shared ref/branch helpers extracted to a common module; merge/cherry-pick/batch-commit implementations now reuse the same dirty-tree guards, protected-name checks, and upstream detection.
- **Tooling** — Biome upgraded to 2.4.11; dev dependency refresh.

### Documentation

- `docs/mcp-tools.md` — `git_merge` and `git_cherry_pick` sections with parameters, JSON shape, and error codes; `batch_commit` `push: "after"` option documented.

## [2.1.0] — prior

- Added `git_log` — path-filtered, time-windowed log across workspace roots.
- Added `git_diff_summary` — structured, token-efficient diff viewer with per-file truncation and default exclusions (lock files, `dist`, vendor).
- Added `batch_commit` — sequential multi-commit tool. Mutating, not idempotent.
- Test harness: fake-server duck-type lets unit tests drive the full FastMCP execute path without a live transport.

## [2.0.1] — prior

- Bug fixes and internal cleanup; no public tool-surface change.

## [2.0.0] — prior

- **Breaking:** JSON response envelope removed. `MCP_JSON_FORMAT_VERSION` now `"2"`; payloads are minified, and optional fields are omitted when empty / `null` / `false` (consumers test for presence, not equality to `null`).
- Initial preset file schema (`.rethunk/git-mcp-presets.json`) with wrapped and legacy-map layouts.

## [1.0.0] — prior

- Initial release: `git_status`, `git_inventory`, `git_parity`, `list_presets`.

[2.2.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.2.0
[2.1.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.1.0
[2.0.1]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.0.1
[2.0.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v2.0.0
[1.0.0]: https://github.com/Rethunk-AI/mcp-multi-root-git/releases/tag/v1.0.0
