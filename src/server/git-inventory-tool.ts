import type { FastMCP } from "fastmcp";
import { z } from "zod";

import {
  asyncPool,
  GIT_SUBPROCESS_PARALLELISM,
  gitRevParseGitDir,
  gitTopLevel,
  isSafeGitUpstreamToken,
} from "./git.js";
import {
  buildInventorySectionMarkdown,
  collectInventoryEntry,
  type InventoryEntryJson,
  makeSkipEntry,
  validateRepoPath,
} from "./inventory.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { applyPresetNestedRoots } from "./presets.js";
import { requireGitAndRoots } from "./roots.js";
import { MAX_INVENTORY_ROOTS_DEFAULT, WorkspacePickSchema } from "./schemas.js";

export function registerGitInventoryTool(server: FastMCP): void {
  server.addTool({
    name: "git_inventory",
    description: "Read-only status + ahead/behind per root. See docs/mcp-tools.md.",
    parameters: WorkspacePickSchema.extend({
      nestedRoots: z.array(z.string()).optional().describe("Paths relative to git toplevel."),
      preset: z.string().optional().describe("Named preset from .rethunk/git-mcp-presets.json."),
      presetMerge: z
        .boolean()
        .optional()
        .default(false)
        .describe("Merge nestedRoots with preset instead of replacing."),
      remote: z.string().optional().describe("Fixed upstream remote (pair with `branch`)."),
      branch: z.string().optional().describe("Fixed upstream branch (pair with `remote`)."),
      maxRoots: z
        .number()
        .int()
        .min(1)
        .max(256)
        .optional()
        .default(MAX_INVENTORY_ROOTS_DEFAULT),
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
        if (!isSafeGitUpstreamToken(fixedRemote!.trim()) || !isSafeGitUpstreamToken(fixedBranch!.trim())) {
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
              entries: [makeSkipEntry(workspaceRoot, workspaceRoot, useFixed ? "fixed" : "auto", JSON.stringify(err))],
            });
          } else {
            mdChunks.push(`### ${workspaceRoot}\n${jsonRespond(err)}`);
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
          ? `upstream (fixed): ${fixedRemote}/${fixedBranch}`
          : "upstream: @{u}";

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
          const sections: string[] = [`### ${top}`, headerNote];
          if (nestedRootsTruncated) {
            sections.push(
              `nested_roots_truncated: ${nestedRootsOmittedCount} path(s) not listed (maxRoots=${maxRoots})`,
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
      return ["# Git inventory", ...mdChunks].join("\n\n");
    },
  });
}
