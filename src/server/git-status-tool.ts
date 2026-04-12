import { join, resolve } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { isStrictlyUnderGitTop } from "../repo-paths.js";
import {
  asyncPool,
  GIT_SUBPROCESS_PARALLELISM,
  gitStatusShortBranchAsync,
  gitTopLevel,
  hasGitMetadata,
  parseGitSubmodulePaths,
} from "./git.js";
import { jsonRespond } from "./json.js";
import { requireGitAndRoots } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

export function registerGitStatusTool(server: FastMCP): void {
  server.addTool({
    name: "git_status",
    description: "Read-only `git status --short -b` per root + submodules. See docs/mcp-tools.md.",
    parameters: WorkspacePickSchema.extend({
      includeSubmodules: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include .gitmodules paths (default true)."),
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

      const sections: string[] = [groups.length > 1 ? "# Multi-root git status" : "# Git status"];
      for (const g of groups) {
        if (groups.length > 1) {
          sections.push("", `### MCP root: ${g.mcpRoot}`);
        }
        for (const row of g.repos) {
          const body = row.statusText || "(clean)";
          if (body.includes("\n")) {
            sections.push("", `## ${row.label} — ${row.path}`, "```text", body, "```");
          } else {
            sections.push("", `## ${row.label} — ${row.path}`, body);
          }
        }
      }
      return sections.join("\n");
    },
  });
}
