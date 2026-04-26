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
    description: "Read-only status + ahead/behind per root.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.extend({
      nestedRoots: z.array(z.string()).optional(),
      preset: z.string().optional(),
      presetMerge: z
        .boolean()
        .optional()
        .default(false)
        .describe("Merge with preset instead of replacing."),
      remote: z.string().optional().describe("Pair with `branch`."),
      branch: z.string().optional().describe("Pair with `remote`."),
      maxRoots: z.number().int().min(1).max(256).optional().default(MAX_INVENTORY_ROOTS_DEFAULT),
    }),
    execute: async (args) => {
      if (args.absoluteGitRoots != null && args.absoluteGitRoots.length > 0) {
        if (args.preset || (args.nestedRoots?.length ?? 0) > 0) {
          return jsonRespond({ error: "absolute_git_roots_nested_or_preset_conflict" });
        }
      }
      const pre = requireGitAndRoots(server, args, args.preset);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const rawRemote = args.remote?.trim();
      const rawBranch = args.branch?.trim();
      const hasRemote = rawRemote !== undefined && rawRemote !== "";
      const hasBranch = rawBranch !== undefined && rawBranch !== "";
      if (hasRemote !== hasBranch) {
        return jsonRespond({ error: "remote_branch_mismatch" });
      }

      type Upstream =
        | { mode: "fixed"; remote: string; branch: string }
        | { mode: "auto"; remote?: undefined; branch?: undefined };

      let upstream: Upstream = { mode: "auto" };
      if (hasRemote && hasBranch && rawRemote && rawBranch) {
        if (!isSafeGitUpstreamToken(rawRemote) || !isSafeGitUpstreamToken(rawBranch)) {
          return jsonRespond({ error: "invalid_remote_or_branch" });
        }
        upstream = { mode: "fixed", remote: rawRemote, branch: rawBranch };
      }

      const useFixed = upstream.mode === "fixed";

      const allJson: {
        workspace_root: string;
        presetSchemaVersion?: string;
        upstream?: { mode: "fixed"; remote: string; branch: string };
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
              ...(upstream.mode === "fixed" ? { upstream } : {}),
              entries: [
                makeSkipEntry(workspaceRoot, workspaceRoot, upstream.mode, JSON.stringify(err)),
              ],
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
          ? `upstream (fixed): ${upstream.remote}/${upstream.branch}`
          : "upstream: @{u}";

        const entries: InventoryEntryJson[] = [];

        if (nestedRoots?.length) {
          const jobs: { label: string; abs: string }[] = [];
          for (const rel of nestedRoots) {
            const { abs, underTop } = validateRepoPath(rel, top);
            if (!underTop) {
              entries.push(
                makeSkipEntry(rel, abs, upstream.mode, "(path escapes git toplevel — rejected)"),
              );
              continue;
            }
            if (!gitRevParseGitDir(abs)) {
              entries.push(makeSkipEntry(rel, abs, upstream.mode, "(not a git work tree — skip)"));
              continue;
            }
            jobs.push({ label: rel, abs });
          }
          const computed = await asyncPool(jobs, GIT_SUBPROCESS_PARALLELISM, (j) =>
            collectInventoryEntry(j.label, j.abs, upstream.remote, upstream.branch),
          );
          entries.push(...computed);
        } else if (!gitRevParseGitDir(top)) {
          entries.push(
            makeSkipEntry(".", top, upstream.mode, "(not a git work tree — unexpected)"),
          );
        } else {
          const one = await collectInventoryEntry(".", top, upstream.remote, upstream.branch);
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
            ...(upstream.mode === "fixed" ? { upstream } : {}),
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
