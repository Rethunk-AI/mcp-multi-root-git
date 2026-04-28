import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { gateGit, gitTopLevel, spawnGitAsync } from "./git.js";
import { jsonRespond } from "./json.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShowJson {
  ref: string;
  path?: string;
  message: string;
  diff?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run git show for a single ref, optionally limiting to a specific path.
 * Returns commit message and diff (or file content if path is specified).
 */
async function runGitShow(opts: {
  top: string;
  ref: string;
  path?: string;
}): Promise<ShowJson | { error: string }> {
  const { top, ref, path } = opts;

  // Build git show args. Start with --no-patch to get just the commit message.
  const showArgs: string[] = ["show", ref];

  if (path) {
    // When path is specified, show that path at the ref without --no-patch
    // to get the full content at that ref
    showArgs.push("--", path);
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
  // - Diff (if --no-patch not used) or file content
  const output = r.stdout;
  let message = "";
  let diff = "";

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

    // In message: collect until we see "diff --git" which marks the start of the diff section
    if (inMessage) {
      if (line.startsWith("diff --git")) {
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
  diff = contentLines.join("\n").trim();

  const result: ShowJson = {
    ref,
    message,
  };
  if (path) {
    result.path = path;
  }
  if (diff) {
    result.diff = diff;
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
  }
  lines.push("");
  lines.push("## Commit message");
  lines.push("");
  lines.push("```");
  lines.push(result.message);
  lines.push("```");

  if (result.diff) {
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
      "Inspect commit content by ref/SHA. Returns commit message and diff (or file content at a specific path).",
    annotations: {
      readOnlyHint: true,
    },
    parameters: z.object({
      wd: z.string().describe("Working directory (git repository root or subdirectory)."),
      ref: z.string().describe("Commit reference (SHA, branch, tag, or any git rev-spec)."),
      path: z
        .string()
        .optional()
        .describe(
          "Optional file path to inspect at the ref. If provided, shows that path's content at the ref instead of the diff.",
        ),
      format: z.enum(["markdown", "json"]).optional().default("markdown"),
    }),
    execute: async (args) => {
      const gg = gateGit();
      if (!gg.ok) return jsonRespond(gg.body);

      const top = gitTopLevel(args.wd);
      if (!top) {
        return jsonRespond({ error: "not_a_git_repository", path: args.wd });
      }

      const result = await runGitShow({
        top,
        ref: args.ref,
        path: args.path,
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
