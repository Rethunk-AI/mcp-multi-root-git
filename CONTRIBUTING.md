# Contributing

Rethunk AI internal project. External PRs are not expected, but the process is documented for clarity.

## Prerequisites

- **Node.js ≥ 22** — see [docs/install.md](docs/install.md) *Prerequisites* for version notes.
- **Bun ≥ 1.3.14** (`packageManager` in `package.json`) — only needed to build and test from source.
- **Git ≥ 2.28**.

## Development setup

```bash
git clone https://github.com/Rethunk-AI/mcp-multi-root-git.git
cd mcp-multi-root-git
bun install
bun run build       # rimraf dist && tsc → dist/server.js, dist/server/*.js, dist/repo-paths.js
bun run lint       # Biome lint + format check
bun run format   # auto-fix with Biome
bun run schema:tools       # regenerate tool-parameters.schema.json
bun run schema:individual  # regenerate schemas/index.json + per-tool JSON Schemas
bun run schema:tools:check # verify the generated tool schema is current
bun run publish:preflight  # clean-tree release gate before tagging
bun run test        # bun test src/
bun run test:coverage  # bun test src/ --coverage
bun run coverage:check /tmp/coverage.txt 80  # validate Bun coverage output captured with tee
bun run setup-hooks    # one-time per clone: wire .githooks/
```

## Git hooks

`bun run setup-hooks` sets `core.hooksPath = .githooks`.

| Hook | Runs |
|------|------|
| pre-commit | `bun run lint` |
| pre-push | `bun install --frozen-lockfile` + `bun run ci` (schema checks, lint, typecheck, coverage gate, build — same core gates as CI) |

Set `SKIP_GIT_HOOKS=1` to bypass.

## Commit conventions

```
type(scope): imperative summary ≤72 chars
type(scope)!: breaking change summary ≤72 chars

Body explains WHY this change exists — motivation, context, constraints.
Not a file list. Not a summary of what the diff already shows.
```

Append `!` after the type/scope (before the colon) for breaking changes — e.g. `fix(batch-commit)!: …`.

| Type | When |
|------|------|
| `feat` | New capability |
| `fix` | Bug corrected |
| `docs` | Documentation only |
| `refactor` | No behaviour change |
| `test` | Test additions or fixes |
| `chore` | Maintenance, deps, tooling |
| `ci` | CI/CD config |
| `build` | Build system changes |
| `style` | Formatting, whitespace, lint-only style (no logic change) |
| `perf` | Performance improvement |

One logical unit per commit. Max ~7 files. Split by theme, not by file count.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on PRs and pushes to `main`:

1. `bun install --frozen-lockfile`
2. `bun run schema:tools:check`
3. `bun run schema:individual:check`
4. `bun run lint` (Biome)
5. `bun run typecheck`
6. `bun run test:coverage` + `bun run coverage:check /tmp/coverage.txt 80`
7. `bun run build`
8. Prerelease `npm pack` artifact uploaded (90-day retention)

Match the CI steps locally before opening a PR.

## Pull request checklist

- [ ] `bun run ci` passes (or run each gate below).
- [ ] `bun run schema:tools:check` passes.
- [ ] `bun run schema:individual:check` passes (regenerate with `bun run schema:individual` when the parameter surface changed).
- [ ] `bun run lint` passes (no Biome errors).
- [ ] `bun run typecheck` passes.
- [ ] `bun run test:coverage` + `bun run coverage:check .coverage-ci.txt 80` pass (or `tee` output to another path).
- [ ] `bun run build` passes.
- [ ] Any new tool has a corresponding `*.test.ts` file.
- [ ] `docs/mcp-tools.md` updated if the public tool surface changed.
- [ ] `README.md` updated if the public tool surface is mentioned there.
- [ ] `CHANGELOG.md` entry added under `[Unreleased]`.

## Adding a git tool

1. Create `src/server/<tool-name>-tool.ts` exporting a `register<ToolName>Tool(server: FastMCP)` function.
2. Register it in `src/server/tools.ts` inside `registerRethunkGitTools`.
3. Add a test file `src/server/<tool-name>-tool.test.ts`.
4. Run `bun run schema:tools && bun run schema:individual` so the shipped schema snapshots stay in sync.
5. Add any new wire error codes to [`src/server/error-codes.ts`](src/server/error-codes.ts) and document them in [docs/mcp-tools.md](docs/mcp-tools.md) (tool ID, parameters, JSON shape, error codes).
6. Update [docs/mcp-tools.md](docs/mcp-tools.md) and [README.md](README.md) when the public tool surface changes (README only when the tool is mentioned there).
7. Follow contract-change rules in [AGENTS.md](AGENTS.md) — bump JSON format version if the output shape changes incompatibly.
8. **Path confinement:** if the tool accepts file paths, use `resolvePathForRepo` / `assertRelativePathUnderTop` from [`src/repo-paths.ts`](src/repo-paths.ts) and add tests for escaping attempts.

## Code style

Enforced by **Biome** (`biome.json`): recommended rules, 100-char lines, double quotes, semicolons, trailing commas.

TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`. Avoid `any`; if genuinely necessary, add an inline comment explaining why.

**Mutating tools** (those that run `git commit`, `push`, `merge`, `cherry-pick`, etc.) must gate on `gateGit()` and operate only within roots confirmed by `requireGitAndRoots` / `requireSingleRepo`. Do not accept absolute paths from the caller for mutating operations.
