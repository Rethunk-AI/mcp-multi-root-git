import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
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
  paths?: string[];
  unified?: number;
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

  // Apply unified context width if specified
  if (typeof opts.unified === "number") {
    args.push(`-U${opts.unified}`);
  }

  // Scope to paths if provided
  if (opts.paths && opts.paths.length > 0) {
    args.push("--", ...opts.paths);
  }

  return { ok: true, args };
}

/** Human-readable label for the range. */
function rangeLabel(opts: {
  base?: string;
  head?: string;
  paths?: string[];
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

  if (opts.paths && opts.paths.length > 0) {
    label += ` (${opts.paths.join(", ")})`;
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
      "Get diff text for scoped file(s) or range. Returns the raw diff output. " +
      "Use `staged: true` for staged changes, `base`/`head` for revision ranges, " +
      "`path` to scope to a single file, `paths` to scope to multiple files, " +
      "and `unified` to control the number of context lines.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.omit({
      absoluteGitRoots: true,
      allWorkspaceRoots: true,
    }).extend({
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
        .describe(
          'Scope diff to a single file path (e.g. "src/main.ts"). ' +
            "For multiple files, prefer `paths`. If both `path` and `paths` are given, they are unioned.",
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Scope diff to multiple file paths (e.g. ["src/a.ts", "src/b.ts"]). ' +
            "Each path is validated and must lie within the repository root. " +
            "If both `path` and `paths` are given, they are unioned.",
        ),
      staged: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, show staged changes (git diff --staged). " + "Ignored if `base` is provided.",
        ),
      unified: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe(
          "Number of context lines to show around each change (passed as -U<n> to git diff). " +
            "Defaults to git's built-in default (3). Use 0 for no context.",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      // Union path + paths, trim, dedup
      const rawPaths: string[] = [];
      if (args.path && typeof args.path === "string" && args.path.trim()) {
        rawPaths.push(args.path.trim());
      }
      if (Array.isArray(args.paths)) {
        for (const p of args.paths as string[]) {
          if (typeof p === "string" && p.trim()) {
            rawPaths.push(p.trim());
          }
        }
      }
      // Dedup preserving order
      const dedupedPaths = [...new Set(rawPaths)];

      // Confine each path within the repo
      for (const p of dedupedPaths) {
        const resolved = resolvePathForRepo(p, gitTop);
        if (!assertRelativePathUnderTop(p, resolved, gitTop)) {
          return jsonRespond({ error: "path_escapes_repo", path: p });
        }
      }

      // Build git diff args
      const diffArgsResult = buildDiffArgs({
        base: args.base,
        head: args.head,
        paths: dedupedPaths.length > 0 ? dedupedPaths : undefined,
        unified: typeof args.unified === "number" ? args.unified : undefined,
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
        paths: dedupedPaths.length > 0 ? dedupedPaths : undefined,
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
