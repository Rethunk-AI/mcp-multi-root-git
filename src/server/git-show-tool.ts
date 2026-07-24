import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { validateRepoPath } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { gitFailureDetail, resolveGitSubprocessMaxBufferBytes, spawnGitAsync } from "./git.js";
import { GIT_DIFF_DEFAULT_MAX_BYTES, truncateDiffOutput } from "./git-diff-tool.js";
import { isSafeGitCommitIsh } from "./git-refs.js";
import { jsonRespond } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max entries accepted in `paths` per call. */
const MAX_PATHS = 256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ShowJson = {
  ref: string;
  paths?: string[];
  stat?: boolean;
  message: string;
  statOutput?: string;
  diff?: string;
  /** Present (true) only when content was cut — subprocess buffer cap or maxBytes. */
  truncated?: boolean;
};

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
  paths?: string[] | undefined;
  stat?: boolean | undefined;
  maxBytes: number;
}): Promise<ShowJson | { error: string; detail?: string }> {
  const { top, ref, paths, stat, maxBytes } = opts;

  // Dedup paths, preserving order.
  const effectivePaths: string[] = [];
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

  const r = await spawnGitAsync(top, showArgs, {
    maxBufferBytes: resolveGitSubprocessMaxBufferBytes(),
  });
  // A subprocess-level buffer cap (r.truncated) still yields a usable partial
  // commit message + diff — build the normal payload from it instead of failing.
  if (!r.ok && !r.truncated) {
    return {
      error: ERROR_CODES.GIT_SHOW_FAILED,
      detail: gitFailureDetail(r),
    };
  }
  const subprocessTruncated = r.truncated === true;

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
      // "diff --cc" (and the 3+-parent "diff --combined") introduce the
      // combined-diff body git show emits for merge commits, in place of the
      // usual "diff --git" per-file header.
      const isDiffLine =
        !stat &&
        (line.startsWith("diff --git") ||
          line.startsWith("diff --cc") ||
          line.startsWith("diff --combined"));

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
  const rawContentStr = contentLines.join("\n").trim();
  const { text: contentStr, truncated: byteTruncated } = truncateDiffOutput(
    rawContentStr,
    maxBytes,
  );

  const result: ShowJson = {
    ref,
    message,
  };
  if (effectivePaths.length > 0) {
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
  if (subprocessTruncated || byteTruncated) {
    result.truncated = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitShowTool(server: FastMCP): void {
  server.addTool({
    name: "git_show",
    description:
      "Inspect commit content by ref/SHA. Returns commit message and diff (or --stat diffstat when stat:true). Optionally filter to specific paths via `paths[]`.",
    annotations: {
      title: "Git Show",
      readOnlyHint: true,
      openWorldHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      ref: z
        .string()
        .min(1)
        .describe(
          'Commit reference (SHA, branch, tag, or ancestor notation like "HEAD~3", "main^2").',
        ),
      paths: z
        .array(z.string())
        .max(MAX_PATHS)
        .optional()
        .describe(`Optional list of file paths (max ${MAX_PATHS}) to filter the shown diff/stat.`),
      stat: z
        .boolean()
        .optional()
        .describe(
          "When true, show --stat diffstat (files changed summary) instead of the full patch.",
        ),
      maxBytes: z
        .number()
        .int()
        .min(1024)
        .max(10_000_000)
        .optional()
        .default(GIT_DIFF_DEFAULT_MAX_BYTES)
        .describe(
          `Max UTF-8 bytes of diff/stat content to return (default ${GIT_DIFF_DEFAULT_MAX_BYTES}), cut at a line boundary. Oversized output is truncated with truncated:true.`,
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const top = pre.gitTop;

      if (!isSafeGitCommitIsh(args.ref)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.ref });
      }

      if (Array.isArray(args.paths)) {
        for (const p of args.paths) {
          if (!validateRepoPath(p, top).underTop) {
            return jsonRespond({ error: ERROR_CODES.PATH_ESCAPES_REPO, path: p });
          }
        }
      }

      const result = await runGitShow({
        top,
        ref: args.ref,
        paths: args.paths,
        stat: args.stat,
        maxBytes: typeof args.maxBytes === "number" ? args.maxBytes : GIT_DIFF_DEFAULT_MAX_BYTES,
      });

      return jsonRespond(result);
    },
  });
}
