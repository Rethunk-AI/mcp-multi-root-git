import { join, resolve } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { isStrictlyUnderGitTop } from "../repo-paths.js";
import {
  asyncPool,
  GIT_SUBPROCESS_PARALLELISM,
  gitRevParseGitDir,
  gitRevParseHead,
  gitStatusShortBranchAsync,
  gitTopLevel,
  hasGitMetadata,
  isSafeGitUpstreamToken,
  parseGitSubmodulePaths,
} from "./git.js";
import {
  buildInventorySectionMarkdown,
  collectInventoryEntry,
  type InventoryEntryJson,
  makeSkipEntry,
  validateRepoPath,
} from "./inventory.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import type { ParityPair } from "./presets.js";
import {
  applyPresetNestedRoots,
  applyPresetParityPairs,
  loadPresetsFromGitTop,
  PRESET_FILE_PATH,
  presetLoadErrorPayload,
} from "./presets.js";
import { requireGitAndRoots } from "./roots.js";
import { MAX_INVENTORY_ROOTS_DEFAULT, WorkspacePickSchema } from "./schemas.js";

export function registerRethunkGitTools(server: FastMCP): void {
  server.addTool({
    name: "git_status",
    description:
      "Run `git status --short -b` in the workspace root and (optionally) each path from `.gitmodules`. " +
      "Read-only. Supports multi-root MCP workspaces via `allWorkspaceRoots` or `rootIndex`.",
    parameters: WorkspacePickSchema.extend({
      includeSubmodules: z
        .boolean()
        .optional()
        .default(true)
        .describe("When true (default), include submodule paths listed in .gitmodules."),
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      type RepoRow = { label: string; path: string; statusText: string; ok: boolean };
      type Group = { mcpRoot: string; repos: RepoRow[] };
      const groups: Group[] = [];

      for (const rootInput of pre.roots) {
        const repos: RepoRow[] = [];
        const top = gitTopLevel(rootInput);
        if (!top) {
          repos.push({
            label: rootInput,
            path: rootInput,
            statusText: "not a git repository",
            ok: false,
          });
          groups.push({ mcpRoot: rootInput, repos });
          continue;
        }

        const includeSubmodules = args.includeSubmodules !== false;
        const meta = await gitStatusShortBranchAsync(top);
        repos.push({ label: ".", path: top, statusText: meta.text, ok: meta.ok });

        if (includeSubmodules) {
          const rels = parseGitSubmodulePaths(top);
          const subRows = await asyncPool(rels, GIT_SUBPROCESS_PARALLELISM, async (rel) => {
            const subPath = resolve(join(top, rel));
            if (!isStrictlyUnderGitTop(subPath, top)) {
              return {
                label: rel,
                path: subPath,
                statusText: "(submodule path escapes repository — rejected)",
                ok: false,
              };
            }
            if (!hasGitMetadata(subPath)) {
              return {
                label: rel,
                path: subPath,
                statusText: "(no .git — submodule not checked out?)",
                ok: false,
              };
            }
            const st = await gitStatusShortBranchAsync(subPath);
            return { label: rel, path: subPath, statusText: st.text, ok: st.ok };
          });
          repos.push(...subRows);
        }
        groups.push({ mcpRoot: rootInput, repos });
      }

      if (args.format === "json") {
        return jsonRespond({ groups });
      }

      const sections: string[] = ["# Multi-root git status", ""];
      for (const g of groups) {
        if (groups.length > 1) {
          sections.push(`### MCP root: ${g.mcpRoot}`, "");
        }
        for (const row of g.repos) {
          sections.push(
            `## ${row.label}`,
            `path: ${row.path}`,
            "```text",
            row.statusText || "(empty)",
            "```",
            ``,
          );
        }
      }
      return sections.join("\n");
    },
  });

  server.addTool({
    name: "git_inventory",
    description:
      "Read-only push-prep inventory: status + ahead/behind per root. " +
      "Uses each repo's configured upstream (`@{u}`) unless both `remote` and `branch` are set. " +
      "Presets from `.rethunk/git-mcp-presets.json`; use `presetMerge` to combine with inline paths.",
    parameters: WorkspacePickSchema.extend({
      nestedRoots: z
        .array(z.string())
        .optional()
        .describe(
          "Paths relative to git toplevel. If empty/omitted, only the repo root is listed. With `presetMerge`, merged with preset paths.",
        ),
      preset: z
        .string()
        .optional()
        .describe("Named preset from .rethunk/git-mcp-presets.json (at git toplevel)."),
      presetMerge: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, merge `nestedRoots` with preset nestedRoots instead of replacing."),
      remote: z
        .string()
        .optional()
        .describe(
          "Fixed upstream remote; must be set together with `branch` to override auto upstream.",
        ),
      branch: z
        .string()
        .optional()
        .describe("Fixed upstream branch name; must be set together with `remote`."),
      maxRoots: z
        .number()
        .int()
        .min(1)
        .max(256)
        .optional()
        .default(MAX_INVENTORY_ROOTS_DEFAULT)
        .describe("Max nested roots to process (cap)."),
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, args.preset);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const fixedRemote = args.remote;
      const fixedBranch = args.branch;
      const hasRemote = fixedRemote !== undefined && fixedRemote.trim() !== "";
      const hasBranch = fixedBranch !== undefined && fixedBranch.trim() !== "";
      if (hasRemote !== hasBranch) {
        return jsonRespond({
          error: "remote_branch_mismatch",
          message:
            "Set both `remote` and `branch` for fixed upstream, or omit both for auto `@{u}`.",
        });
      }
      const useFixed = hasRemote && hasBranch;
      if (useFixed) {
        const r = String(fixedRemote).trim();
        const b = String(fixedBranch).trim();
        if (!isSafeGitUpstreamToken(r) || !isSafeGitUpstreamToken(b)) {
          return jsonRespond({
            error: "invalid_remote_or_branch",
            message:
              "remote and branch must be plain tokens: no whitespace, control characters, `@`, `..`, leading `-`, or git rev metacharacters like `^ : ? * [ ] { } ~ \\`.",
          });
        }
      }

      const allJson: {
        workspace_root: string;
        presetSchemaVersion?: string;
        upstream: { mode: "auto" | "fixed"; remote?: string; branch?: string };
        entries: InventoryEntryJson[];
      }[] = [];

      const mdChunks: string[] = [];

      for (const workspaceRoot of pre.roots) {
        const top = gitTopLevel(workspaceRoot);
        if (!top) {
          const err = { error: "not_a_git_repository", path: workspaceRoot };
          if (args.format === "json") {
            allJson.push({
              workspace_root: workspaceRoot,
              upstream: {
                mode: useFixed ? "fixed" : "auto",
                remote: fixedRemote,
                branch: fixedBranch,
              },
              entries: [
                {
                  label: workspaceRoot,
                  path: workspaceRoot,
                  branchStatus: "",
                  shortStatus: "",
                  detached: false,
                  headAbbrev: "",
                  upstreamMode: useFixed ? "fixed" : "auto",
                  upstreamRef: null,
                  ahead: null,
                  behind: null,
                  upstreamNote: "",
                  skipReason: JSON.stringify(err),
                },
              ],
            });
          } else {
            mdChunks.push(`# Git inventory`, "", jsonRespond(err), "");
          }
          continue;
        }

        let nestedRoots: string[] | undefined = args.nestedRoots;
        let presetSchemaVersion: string | undefined;

        if (args.preset) {
          const applied = applyPresetNestedRoots(top, args.preset, args.presetMerge, nestedRoots);
          if (!applied.ok) {
            return jsonRespond(applied.error);
          }
          nestedRoots = applied.nestedRoots;
          presetSchemaVersion = applied.presetSchemaVersion;
        }

        const maxRoots = args.maxRoots ?? MAX_INVENTORY_ROOTS_DEFAULT;
        let nestedRootsTruncated = false;
        let nestedRootsOmittedCount = 0;
        if (nestedRoots && nestedRoots.length > maxRoots) {
          nestedRootsOmittedCount = nestedRoots.length - maxRoots;
          nestedRoots = nestedRoots.slice(0, maxRoots);
          nestedRootsTruncated = true;
        }

        const headerNote = useFixed
          ? `remote/branch (fixed): ${fixedRemote}/${fixedBranch}`
          : "upstream: per-repo @{u} (configured upstream)";

        const entries: InventoryEntryJson[] = [];

        if (nestedRoots?.length) {
          const jobs: { label: string; abs: string }[] = [];
          for (const rel of nestedRoots) {
            const { abs, underTop } = validateRepoPath(rel, top);
            if (!underTop) {
              entries.push(
                makeSkipEntry(
                  rel,
                  abs,
                  useFixed ? "fixed" : "auto",
                  "(path escapes git toplevel — rejected)",
                ),
              );
              continue;
            }
            if (!gitRevParseGitDir(abs)) {
              entries.push(
                makeSkipEntry(
                  rel,
                  abs,
                  useFixed ? "fixed" : "auto",
                  "(not a git work tree — skip)",
                ),
              );
              continue;
            }
            jobs.push({ label: rel, abs });
          }
          const computed = await asyncPool(jobs, GIT_SUBPROCESS_PARALLELISM, (j) =>
            collectInventoryEntry(
              j.label,
              j.abs,
              useFixed ? fixedRemote : undefined,
              useFixed ? fixedBranch : undefined,
            ),
          );
          entries.push(...computed);
        } else if (!gitRevParseGitDir(top)) {
          entries.push(
            makeSkipEntry(
              ".",
              top,
              useFixed ? "fixed" : "auto",
              "(not a git work tree — unexpected)",
            ),
          );
        } else {
          const one = await collectInventoryEntry(
            ".",
            top,
            useFixed ? fixedRemote : undefined,
            useFixed ? fixedBranch : undefined,
          );
          entries.push(one);
        }

        if (args.format === "json") {
          allJson.push({
            workspace_root: top,
            ...spreadDefined("presetSchemaVersion", presetSchemaVersion),
            ...spreadWhen(nestedRootsTruncated, {
              nestedRootsTruncated: true,
              nestedRootsOmittedCount,
            }),
            upstream: useFixed
              ? { mode: "fixed", remote: fixedRemote, branch: fixedBranch }
              : { mode: "auto" },
            entries,
          });
        } else {
          const sections: string[] = [
            "# Git inventory",
            "",
            `workspace_root: ${top}`,
            headerNote,
            "",
          ];
          if (nestedRootsTruncated) {
            sections.push(
              `nested_roots_truncated: ${nestedRootsOmittedCount} path(s) not listed (maxRoots=${maxRoots})`,
              "",
            );
          }
          for (const e of entries) {
            sections.push(...buildInventorySectionMarkdown(e));
          }
          mdChunks.push(sections.join("\n"));
        }
      }

      if (args.format === "json") {
        return jsonRespond({ inventories: allJson });
      }
      return mdChunks.join("\n\n---\n\n");
    },
  });

  server.addTool({
    name: "git_parity",
    description:
      "Read-only: compare `git rev-parse HEAD` for path pairs. Presets or inline `pairs`; `presetMerge` merges with inline pairs.",
    parameters: WorkspacePickSchema.extend({
      pairs: z
        .array(
          z.object({
            left: z.string(),
            right: z.string(),
            label: z.string().optional(),
          }),
        )
        .optional(),
      preset: z.string().optional(),
      presetMerge: z.boolean().optional().default(false),
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, args.preset);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const results: {
        workspace_root: string;
        presetSchemaVersion?: string;
        status: "OK" | "MISMATCH";
        pairs: {
          label: string;
          leftPath: string;
          rightPath: string;
          match: boolean;
          sha?: string;
          leftSha?: string;
          rightSha?: string;
          error?: string;
        }[];
      }[] = [];

      const mdParts: string[] = [];

      for (const workspaceRoot of pre.roots) {
        const top = gitTopLevel(workspaceRoot);
        if (!top) {
          const errPayload = { error: "not_a_git_repository", path: workspaceRoot };
          const err = jsonRespond(errPayload);
          if (args.format === "json") {
            results.push({
              workspace_root: workspaceRoot,
              status: "MISMATCH",
              pairs: [{ label: "—", leftPath: "", rightPath: "", match: false, error: err }],
            });
          } else {
            mdParts.push(err);
          }
          continue;
        }

        let pairs: ParityPair[] | undefined = args.pairs;
        let parityPresetSchemaVersion: string | undefined;
        if (args.preset) {
          const applied = applyPresetParityPairs(top, args.preset, args.presetMerge, pairs);
          if (!applied.ok) {
            return jsonRespond(applied.error);
          }
          pairs = applied.pairs;
          parityPresetSchemaVersion = applied.presetSchemaVersion;
        }

        if (!pairs?.length) {
          return jsonRespond({
            error: "no_pairs",
            message: "Pass `pairs` directly or a `preset` with parityPairs (or presetMerge).",
          });
        }

        let allOk = true;
        const pairResults: (typeof results)[0]["pairs"] = [];

        for (const pair of pairs) {
          const pa = validateRepoPath(pair.left, top);
          const pb = validateRepoPath(pair.right, top);
          const label = pair.label ?? `${pair.left} / ${pair.right}`;

          if (!pa.underTop || !pb.underTop) {
            allOk = false;
            pairResults.push({
              label,
              leftPath: pa.abs,
              rightPath: pb.abs,
              match: false,
              error: "path escapes git toplevel — rejected",
            });
            continue;
          }

          const ha = gitRevParseHead(pa.abs);
          const hb = gitRevParseHead(pb.abs);

          if (!ha.ok || !hb.ok) {
            allOk = false;
            pairResults.push({
              label,
              leftPath: pa.abs,
              rightPath: pb.abs,
              match: false,
              error: [!ha.ok ? `left: ${ha.text}` : "", !hb.ok ? `right: ${hb.text}` : ""]
                .filter(Boolean)
                .join("\n"),
            });
            continue;
          }
          if (ha.sha !== hb.sha) {
            allOk = false;
            pairResults.push({
              label,
              leftPath: pa.abs,
              rightPath: pb.abs,
              match: false,
              leftSha: ha.sha,
              rightSha: hb.sha,
            });
          } else {
            pairResults.push({
              label,
              leftPath: pa.abs,
              rightPath: pb.abs,
              match: true,
              sha: ha.sha,
            });
          }
        }

        results.push({
          workspace_root: top,
          ...spreadDefined("presetSchemaVersion", parityPresetSchemaVersion),
          status: allOk ? "OK" : "MISMATCH",
          pairs: pairResults,
        });

        if (args.format !== "json") {
          const lines: string[] = [
            "# Git HEAD parity",
            "",
            `status: ${allOk ? "OK" : "MISMATCH"}`,
            "",
          ];
          for (const pr of pairResults) {
            if (pr.error) {
              lines.push(`## ${pr.label} — error`, "```text", pr.error, "```", "");
            } else if (pr.match) {
              lines.push(`## ${pr.label} — OK`, "```text", `SHA: ${pr.sha}`, "```", "");
            } else {
              lines.push(
                `## ${pr.label} — MISMATCH`,
                "```text",
                `left:  ${pr.leftSha}`,
                `right: ${pr.rightSha}`,
                "```",
                "",
              );
            }
          }
          mdParts.push(lines.join("\n"));
        }
      }

      if (args.format === "json") {
        return jsonRespond({ parity: results });
      }
      return mdParts.join("\n\n---\n\n");
    },
  });

  server.addTool({
    name: "list_presets",
    description:
      "List named entries from `.rethunk/git-mcp-presets.json` at the git toplevel for the resolved workspace root.",
    parameters: WorkspacePickSchema.pick({
      workspaceRoot: true,
      rootIndex: true,
      allWorkspaceRoots: true,
      format: true,
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const out: {
        workspaceRoot: string;
        gitTop: string | null;
        presetFile: string;
        fileExists: boolean;
        presetSchemaVersion?: string;
        presets: {
          name: string;
          nestedRootsCount: number;
          parityPairsCount: number;
          workspaceRootHint?: string;
        }[];
        error?: Record<string, unknown>;
      }[] = [];

      for (const ws of pre.roots) {
        const top = gitTopLevel(ws);
        const presetFile = top ? join(top, PRESET_FILE_PATH) : join(ws, PRESET_FILE_PATH);
        if (!top) {
          out.push({
            workspaceRoot: ws,
            gitTop: null,
            presetFile,
            fileExists: false,
            presets: [],
            error: { error: "not_a_git_repository", path: ws },
          });
          continue;
        }
        const loaded = loadPresetsFromGitTop(top);
        if (!loaded.ok) {
          if (loaded.reason === "missing") {
            out.push({
              workspaceRoot: ws,
              gitTop: top,
              presetFile,
              fileExists: false,
              presets: [],
            });
          } else {
            out.push({
              workspaceRoot: ws,
              gitTop: top,
              presetFile,
              fileExists: true,
              presets: [],
              error: presetLoadErrorPayload(top, loaded),
            });
          }
          continue;
        }
        const presets = Object.entries(loaded.data).map(([name, e]) => ({
          name,
          nestedRootsCount: e.nestedRoots?.length ?? 0,
          parityPairsCount: e.parityPairs?.length ?? 0,
          ...spreadDefined(
            "workspaceRootHint",
            e.workspaceRootHint ? e.workspaceRootHint : undefined,
          ),
        }));
        out.push({
          workspaceRoot: ws,
          gitTop: top,
          presetFile,
          fileExists: true,
          ...spreadDefined("presetSchemaVersion", loaded.schemaVersion),
          presets,
        });
      }

      if (args.format === "json") {
        return jsonRespond({ roots: out });
      }
      const lines: string[] = ["# Git MCP presets", ""];
      for (const row of out) {
        lines.push(
          `## ${row.workspaceRoot}`,
          `git_top: ${row.gitTop ?? "(none)"}`,
          `preset_file: ${row.presetFile}`,
          "",
        );
        if (row.error) {
          lines.push("```json", JSON.stringify(row.error, null, 2), "```", "");
          continue;
        }
        if (!row.fileExists) {
          lines.push("(no preset file)", "");
          continue;
        }
        if (row.presets.length === 0) {
          lines.push("(empty preset file)", "");
          continue;
        }
        if (row.presetSchemaVersion !== undefined) {
          lines.push(`preset_schema_version: ${row.presetSchemaVersion}`, "");
        }
        for (const p of row.presets) {
          lines.push(
            `- **${p.name}**: nestedRoots=${p.nestedRootsCount}, parityPairs=${p.parityPairsCount}` +
              (p.workspaceRootHint ? `, hint=${p.workspaceRootHint}` : ""),
          );
        }
        lines.push("");
      }
      return lines.join("\n");
    },
  });

  server.addResource({
    uri: "rethunk-git://presets",
    name: "git-mcp-presets",
    mimeType: "application/json",
    async load() {
      const pre = requireGitAndRoots(server, {}, undefined);
      if (!pre.ok) {
        return { text: jsonRespond(pre.error) };
      }
      const ws = pre.roots[0];
      if (!ws) {
        return { text: jsonRespond({ error: "no_workspace_root" }) };
      }
      const top = gitTopLevel(ws);
      if (!top) {
        return { text: jsonRespond({ error: "not_a_git_repository", path: ws }) };
      }
      const loaded = loadPresetsFromGitTop(top);
      if (!loaded.ok) {
        if (loaded.reason === "missing") {
          return {
            text: jsonRespond({
              presetFile: join(top, PRESET_FILE_PATH),
              fileExists: false,
              presets: {},
            }),
          };
        }
        return { text: jsonRespond(presetLoadErrorPayload(top, loaded)) };
      }
      return {
        text: jsonRespond({
          presetFile: join(top, PRESET_FILE_PATH),
          fileExists: true,
          ...spreadDefined("presetSchemaVersion", loaded.schemaVersion),
          presets: loaded.data,
        }),
      };
    },
  });
}
