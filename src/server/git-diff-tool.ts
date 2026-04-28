import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { isSafeGitUpstreamToken, spawnGitAsync } from "./git.js";
import { jsonRespond } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the diff args array from parameters. */
function buildDiffArgs(opts: {
  base?: string;
  head?: string;
  path?: string;
  staged?: boolean;
}): { ok: true; args: string[] } | { ok: false; error: string } {
  const args: string[] = ["diff"];

  // Handle staged flag first
  if (opts.staged === true) {
    args.push("--staged");
  } else if (opts.base || opts.head) {
    // Range-based diff: base..head or base...head
    // If only base is given, use base~0..HEAD (implicit HEAD)
    const baseStr = opts.base?.trim() ?? "HEAD";
    const headStr = opts.head?.trim() ?? "HEAD";

    if (!isSafeGitUpstreamToken(baseStr) || !isSafeGitUpstreamToken(headStr)) {
      return { ok: false, error: "unsafe_range_token" };
    }

    // Use two-dot range: base..head
    args.push(`${baseStr}..${headStr}`);
  }

  // Scope to path if provided
  if (opts.path?.trim()) {
    args.push("--", opts.path.trim());
  }

  return { ok: true, args };
}

/** Human-readable label for the range. */
function rangeLabel(opts: {
  base?: string;
  head?: string;
  path?: string;
  staged?: boolean;
}): string {
  let label = "";

  if (opts.staged === true) {
    label = "staged changes";
  } else if (opts.base || opts.head) {
    const baseStr = opts.base?.trim() ?? "HEAD";
    const headStr = opts.head?.trim() ?? "HEAD";
    label = `${baseStr}..${headStr}`;
  } else {
    label = "unstaged changes";
  }

  if (opts.path?.trim()) {
    label += ` (${opts.path.trim()})`;
  }

  return label;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitDiffTool(server: FastMCP): void {
  server.addTool({
    name: "git_diff",
    description:
      "Get diff text for scoped file or range. Returns the raw diff output. " +
      "Use `staged: true` for staged changes, `base`/`head` for revision ranges, " +
      "and `path` to scope to a specific file.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.extend({
      base: z
        .string()
        .optional()
        .describe(
          'Base ref (e.g. "main", "HEAD~3"). Required for range diffs. ' +
            "If omitted and `staged: false`, shows unstaged changes.",
        ),
      head: z
        .string()
        .optional()
        .describe(
          'Head ref (e.g. "feature-branch"). If omitted, defaults to HEAD. ' +
            "Only used if `base` is provided.",
        ),
      path: z
        .string()
        .optional()
        .describe('Scope diff to a single file path (e.g. "src/main.ts").'),
      staged: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, show staged changes (git diff --staged). " + "Ignored if `base` is provided.",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      // Build git diff args
      const diffArgsResult = buildDiffArgs({
        base: args.base,
        head: args.head,
        path: args.path,
        staged: args.staged,
      });
      if (!diffArgsResult.ok) {
        return jsonRespond({ error: diffArgsResult.error });
      }

      // Run git diff
      const result = await spawnGitAsync(gitTop, diffArgsResult.args);
      if (!result.ok) {
        return jsonRespond({
          error: "git_diff_failed",
          detail: (result.stderr || result.stdout).trim(),
        });
      }

      const label = rangeLabel({
        base: args.base,
        head: args.head,
        path: args.path,
        staged: args.staged,
      });

      if (args.format === "json") {
        return jsonRespond({
          range: label,
          diff: result.stdout,
        } as unknown as Record<string, unknown>);
      }

      // Markdown output
      const lines: string[] = [];
      lines.push(`# Diff: ${label}`, "");

      if (result.stdout.trim()) {
        lines.push("```diff", result.stdout.trimEnd(), "```");
      } else {
        lines.push("_(no changes)_");
      }

      return lines.join("\n");
    },
  });
}
