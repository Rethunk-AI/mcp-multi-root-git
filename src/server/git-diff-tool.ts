import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
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
      return { ok: false, error: ERROR_CODES.UNSAFE_RANGE_TOKEN };
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
      "Raw diff text for scoped file(s) or range. `staged: true` for staged changes, " +
      "`base`/`head` for revision ranges, `path`/`paths` to scope, `unified` for context lines.",
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
        .describe('Base ref (e.g. "main", "HEAD~3"). Omit for unstaged changes.'),
      head: z
        .string()
        .optional()
        .describe(
          'Head ref (e.g. "feature-branch"). Defaults to HEAD. Used only when `base` is set.',
        ),
      path: z
        .string()
        .optional()
        .describe("Scope to a single file. Unioned with `paths` if both given."),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          "Scope to multiple files (must be within repo root). Unioned with `path` if both given.",
        ),
      staged: z
        .boolean()
        .optional()
        .default(false)
        .describe("Show staged changes (`git diff --staged`). Ignored if `base` is set."),
      unified: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("Context lines around each change (`-U<n>`). Default: 3. Use 0 for no context."),
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
          return jsonRespond({ error: ERROR_CODES.PATH_ESCAPES_REPO, path: p });
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
          error: ERROR_CODES.GIT_DIFF_FAILED,
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
