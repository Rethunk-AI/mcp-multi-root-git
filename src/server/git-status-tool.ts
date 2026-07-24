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
import { jsonRespond, spreadWhen } from "./json.js";
import { requireGitAndRoots } from "./roots.js";
import { RootPickSchema } from "./schemas.js";

/** Default / hard cap on changed-file lines retained per repo's statusText. */
const MAX_CHANGED_FILES_DEFAULT = 500;
const MAX_CHANGED_FILES_HARD_CAP = 20000;

/** Default / hard cap on submodules fanned out to per root. */
const MAX_SUBMODULES_DEFAULT = 64;
const MAX_SUBMODULES_HARD_CAP = 256;

/**
 * Cap the changed-file lines in a `git status --short -b` text blob, keeping
 * the leading `##` branch header (if present) uncapped.
 */
function capChangedFileLines(
  text: string,
  maxChangedFiles: number,
): { text: string; truncated: boolean; omittedCount: number } {
  if (!text) return { text, truncated: false, omittedCount: 0 };
  const lines = text.split("\n");
  const headerLines = lines[0]?.startsWith("##") ? 1 : 0;
  const fileLines = lines.slice(headerLines);
  if (fileLines.length <= maxChangedFiles) {
    return { text, truncated: false, omittedCount: 0 };
  }
  const omittedCount = fileLines.length - maxChangedFiles;
  const capped = [...lines.slice(0, headerLines), ...fileLines.slice(0, maxChangedFiles)];
  return { text: capped.join("\n"), truncated: true, omittedCount };
}

export function registerGitStatusTool(server: FastMCP): void {
  server.addTool({
    name: "git_status",
    description: "Read-only `git status --short -b` per root + submodules.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: RootPickSchema.extend({
      includeSubmodules: z.boolean().optional().default(true),
      maxChangedFiles: z
        .number()
        .int()
        .min(1)
        .max(MAX_CHANGED_FILES_HARD_CAP)
        .optional()
        .default(MAX_CHANGED_FILES_DEFAULT)
        .describe(`Cap changed-file lines per repo (hard cap ${MAX_CHANGED_FILES_HARD_CAP}).`),
      maxSubmodules: z
        .number()
        .int()
        .min(1)
        .max(MAX_SUBMODULES_HARD_CAP)
        .optional()
        .default(MAX_SUBMODULES_DEFAULT)
        .describe(`Cap submodules fanned out to per root (hard cap ${MAX_SUBMODULES_HARD_CAP}).`),
    }),
    execute: async (args, context) => {
      const pre = requireGitAndRoots(server, args, undefined, context.sessionId);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const maxChangedFiles = args.maxChangedFiles ?? MAX_CHANGED_FILES_DEFAULT;
      const maxSubmodules = args.maxSubmodules ?? MAX_SUBMODULES_DEFAULT;

      type RepoRow = {
        label: string;
        path: string;
        statusText: string;
        ok: boolean;
        changedFilesTruncated?: boolean;
        changedFilesOmittedCount?: number;
      };
      type Group = {
        mcpRoot: string;
        repos: RepoRow[];
        submodulesTruncated?: boolean;
        submodulesOmittedCount?: number;
      };
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
        const metaCap = meta.ok ? capChangedFileLines(meta.text, maxChangedFiles) : undefined;
        repos.push({
          label: ".",
          path: top,
          statusText: metaCap ? metaCap.text : meta.text,
          ok: meta.ok,
          ...spreadWhen(metaCap?.truncated ?? false, {
            changedFilesTruncated: true,
            changedFilesOmittedCount: metaCap?.omittedCount ?? 0,
          }),
        });

        let submodulesTruncated = false;
        let submodulesOmittedCount = 0;
        if (includeSubmodules) {
          let rels = parseGitSubmodulePaths(top);
          if (rels.length > maxSubmodules) {
            submodulesOmittedCount = rels.length - maxSubmodules;
            rels = rels.slice(0, maxSubmodules);
            submodulesTruncated = true;
          }
          const subRows = await asyncPool(rels, GIT_SUBPROCESS_PARALLELISM, async (rel) => {
            // One throwing job must not fail the whole batch — contain it as a
            // per-submodule error row instead of letting asyncPool's Promise.all reject.
            try {
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
              const stCap = st.ok ? capChangedFileLines(st.text, maxChangedFiles) : undefined;
              return {
                label: rel,
                path: subPath,
                statusText: stCap ? stCap.text : st.text,
                ok: st.ok,
                ...spreadWhen(stCap?.truncated ?? false, {
                  changedFilesTruncated: true,
                  changedFilesOmittedCount: stCap?.omittedCount ?? 0,
                }),
              };
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              return {
                label: rel,
                path: resolve(join(top, rel)),
                statusText: `(submodule status collection failed: ${msg})`,
                ok: false,
              };
            }
          });
          repos.push(...subRows);
        }
        groups.push({
          mcpRoot: rootInput,
          repos,
          ...spreadWhen(submodulesTruncated, { submodulesTruncated: true, submodulesOmittedCount }),
        });
      }

      if (args.format === "json") {
        return jsonRespond({ groups });
      }

      const sections: string[] = [groups.length > 1 ? "# Multi-root git status" : "# Git status"];
      for (const g of groups) {
        if (groups.length > 1) {
          sections.push("", `### MCP root: ${g.mcpRoot}`);
        }
        if (g.submodulesTruncated) {
          sections.push(
            "",
            `submodules_truncated: ${g.submodulesOmittedCount} submodule(s) not shown (maxSubmodules=${maxSubmodules})`,
          );
        }
        for (const row of g.repos) {
          const body = row.statusText || "(clean)";
          if (body.includes("\n")) {
            sections.push("", `## ${row.label} — ${row.path}`, "```text", body, "```");
          } else {
            sections.push("", `## ${row.label} — ${row.path}`, body);
          }
          if (row.changedFilesTruncated) {
            sections.push(
              `changed_files_truncated: ${row.changedFilesOmittedCount} file(s) not shown (maxChangedFiles=${maxChangedFiles})`,
            );
          }
        }
      }
      return sections.join("\n");
    },
  });
}
