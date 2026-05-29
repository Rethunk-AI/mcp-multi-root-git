import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { spawnGitAsync } from "./git.js";
import { isSafeGitAncestorRef } from "./git-refs.js";
import { jsonRespond } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShowJson {
  ref: string;
  path?: string;
  paths?: string[];
  stat?: boolean;
  message: string;
  statOutput?: string;
  diff?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run git show for a single ref, optionally limiting to specific paths and/or
 * showing only the --stat diffstat rather than the full patch.
 * Returns commit message and diff/stat output.
 */
async function runGitShow(opts: {
  top: string;
  ref: string;
  path?: string;
  paths?: string[];
  stat?: boolean;
}): Promise<ShowJson | { error: string }> {
  const { top, ref, path, paths, stat } = opts;

  // Merge single path + paths array into a unified list (deduped, order preserved).
  const effectivePaths: string[] = [];
  if (path) effectivePaths.push(path);
  if (paths) {
    for (const p of paths) {
      if (!effectivePaths.includes(p)) effectivePaths.push(p);
    }
  }

  // Build git show args. Shows commit message + full diff (or --stat diffstat).
  const showArgs: string[] = ["show"];
  if (stat) {
    showArgs.push("--stat");
  }
  showArgs.push(ref);

  if (effectivePaths.length > 0) {
    showArgs.push("--", ...effectivePaths);
  }

  const r = await spawnGitAsync(top, showArgs);
  if (!r.ok) {
    return {
      error: "git_show_failed",
    };
  }

  // Parse the output. For a commit, git show outputs:
  // - Header (commit, Author, Date, etc.)
  // - Blank line
  // - Commit message (may contain multiple lines and blank lines)
  // - Blank line (separator before diff)
  // - Diff or --stat diffstat section
  const output = r.stdout;
  let message = "";

  const lines = output.split("\n");
  let inHeader = true;
  let inMessage = false;
  const messageLines: string[] = [];
  const contentLines: string[] = [];

  for (const line of lines) {
    if (line === undefined) continue;

    // End header when we see a blank line
    if (inHeader && line.trim() === "") {
      inHeader = false;
      inMessage = true;
      continue;
    }

    if (inMessage) {
      // In stat mode: content starts at the first line that looks like a stat entry
      // (indented file path) or the summary line "N files changed".
      // In diff mode: content starts at "diff --git".
      const isStatLine =
        stat &&
        (line.match(/^\s+\S.*\|/) !== null || line.match(/^\s*\d+ files? changed/) !== null);
      const isDiffLine = !stat && line.startsWith("diff --git");

      if (isStatLine || isDiffLine) {
        inMessage = false;
        contentLines.push(line);
      } else {
        messageLines.push(line);
      }
    } else if (!inHeader) {
      // In diff/content section
      contentLines.push(line);
    }
  }

  message = messageLines.join("\n").trim();
  const contentStr = contentLines.join("\n").trim();

  const result: ShowJson = {
    ref,
    message,
  };
  // Reflect single legacy path (for backward-compat) and new paths[] in result.
  if (path && !paths) {
    result.path = path;
  } else if (effectivePaths.length > 0) {
    result.paths = effectivePaths;
  }
  if (stat) {
    result.stat = true;
    if (contentStr) {
      result.statOutput = contentStr;
    }
  } else if (contentStr) {
    result.diff = contentStr;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderShowMarkdown(result: ShowJson): string {
  const lines: string[] = [];
  lines.push(`# git show ${result.ref}`);
  if (result.path) {
    lines.push(`_path: ${result.path}_`);
  } else if (result.paths && result.paths.length > 0) {
    lines.push(`_paths: ${result.paths.join(", ")}_`);
  }
  if (result.stat) {
    lines.push("_mode: stat_");
  }
  lines.push("");
  lines.push("## Commit message");
  lines.push("");
  lines.push("```");
  lines.push(result.message);
  lines.push("```");

  if (result.stat && result.statOutput) {
    lines.push("");
    lines.push("## Stat");
    lines.push("");
    lines.push("```");
    lines.push(result.statOutput);
    lines.push("```");
  } else if (result.diff) {
    lines.push("");
    lines.push("## Diff");
    lines.push("");
    lines.push("```diff");
    lines.push(result.diff);
    lines.push("```");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitShowTool(server: FastMCP): void {
  server.addTool({
    name: "git_show",
    description:
      "Inspect commit content by ref/SHA. Returns commit message and diff (or --stat diffstat when stat:true). Optionally filter to specific paths via path or paths[].",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.omit({ absoluteGitRoots: true, allWorkspaceRoots: true })
      .pick({
        workspaceRoot: true,
        rootIndex: true,
        format: true,
      })
      .extend({
        ref: z
          .string()
          .min(1)
          .describe("Commit reference (SHA, branch, tag, or any git rev-spec)."),
        path: z
          .string()
          .optional()
          .describe(
            "Optional single file path to inspect at the ref. Merged with `paths` when both are provided.",
          ),
        paths: z
          .array(z.string())
          .optional()
          .describe(
            "Optional list of file paths to filter the shown diff/stat. Merged with `path` when both are provided.",
          ),
        stat: z
          .boolean()
          .optional()
          .describe(
            "When true, show --stat diffstat (files changed summary) instead of the full patch.",
          ),
      }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const top = pre.gitTop;

      if (!isSafeGitAncestorRef(args.ref as string)) {
        return jsonRespond({ error: "unsafe_ref_token", ref: args.ref });
      }

      if (args.path !== undefined) {
        const resolved = resolvePathForRepo(args.path as string, top);
        if (!assertRelativePathUnderTop(args.path as string, resolved, top)) {
          return jsonRespond({ error: "path_escapes_repo", path: args.path });
        }
      }

      if (Array.isArray(args.paths)) {
        for (const p of args.paths as string[]) {
          const resolved = resolvePathForRepo(p, top);
          if (!assertRelativePathUnderTop(p, resolved, top)) {
            return jsonRespond({ error: "path_escapes_repo", path: p });
          }
        }
      }

      const result = await runGitShow({
        top,
        ref: args.ref as string,
        path: args.path as string | undefined,
        paths: args.paths as string[] | undefined,
        stat: args.stat as boolean | undefined,
      });

      if ("error" in result) {
        return jsonRespond(result);
      }

      if (args.format === "json") {
        return jsonRespond(result as unknown as Record<string, unknown>);
      }

      // Markdown
      return renderShowMarkdown(result);
    },
  });
}
