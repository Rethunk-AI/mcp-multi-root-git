import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { validateRepoPath } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { gitFailureDetail, resolveGitSubprocessMaxBufferBytes, spawnGitAsync } from "./git.js";
import { isSafeGitCommitIsh } from "./git-refs.js";
import { jsonRespond, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default byte cap on raw diff stdout to keep agent context bounded. */
export const GIT_DIFF_DEFAULT_MAX_BYTES = 512_000;

/** Max entries accepted in `paths` per call. */
const MAX_PATHS = 256;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build just the range-selecting args (`base..head` or `--staged`), with no
 * `diff` subcommand prefix and no `unified`/`paths` handling — the shared
 * canonical range shape reused by both `git_diff` and `git_diff_summary`.
 * Docs: `staged` is ignored when `base` is provided; `head` is used only
 * when `base` is set. Prefer base..head over --staged whenever base is set.
 */
export function buildDiffRangeArgs(opts: {
  base?: string | undefined;
  head?: string | undefined;
  staged?: boolean | undefined;
}): { ok: true; args: string[] } | { ok: false; error: string } {
  if (opts.base) {
    const baseStr = opts.base.trim();
    const headStr = opts.head?.trim() || "HEAD";

    if (!isSafeGitCommitIsh(baseStr) || !isSafeGitCommitIsh(headStr)) {
      return { ok: false, error: ERROR_CODES.UNSAFE_RANGE_TOKEN };
    }

    return { ok: true, args: [`${baseStr}..${headStr}`] };
  }
  if (opts.staged === true) {
    return { ok: true, args: ["--staged"] };
  }
  // head without base is ignored (matches docs: head used only when base is set)
  return { ok: true, args: [] };
}

/** Build the full `git diff` args array from parameters. */
export function buildDiffArgs(opts: {
  base?: string | undefined;
  head?: string | undefined;
  paths?: string[] | undefined;
  unified?: number | undefined;
  staged?: boolean | undefined;
  findCopies?: boolean | undefined;
}): { ok: true; args: string[] } | { ok: false; error: string } {
  const rangeResult = buildDiffRangeArgs(opts);
  if (!rangeResult.ok) return rangeResult;

  const args: string[] = ["diff", ...rangeResult.args];

  // Apply unified context width if specified
  if (typeof opts.unified === "number") {
    args.push(`-U${opts.unified}`);
  }

  // Copy detection (git -C), alongside git's default rename detection.
  if (opts.findCopies === true) {
    args.push("-C");
  }

  // Scope to paths if provided
  if (opts.paths && opts.paths.length > 0) {
    args.push("--", ...opts.paths);
  }

  return { ok: true, args };
}

/** Human-readable label for the range. */
export function rangeLabel(opts: {
  base?: string | undefined;
  head?: string | undefined;
  paths?: string[] | undefined;
  staged?: boolean | undefined;
}): string {
  let label = "";

  if (opts.base) {
    const baseStr = opts.base.trim();
    const headStr = opts.head?.trim() || "HEAD";
    label = `${baseStr}..${headStr}`;
  } else if (opts.staged === true) {
    label = "staged changes";
  } else {
    label = "unstaged changes";
  }

  if (opts.paths && opts.paths.length > 0) {
    label += ` (${opts.paths.join(", ")})`;
  }

  return label;
}

/**
 * Cap diff text at maxBytes, cutting at a line boundary (never mid-line) so
 * the returned text is always well-formed diff lines rather than an
 * arbitrary byte offset. Always keeps at least one line, even if that line
 * alone exceeds maxBytes.
 */
export function truncateDiffOutput(
  diff: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const totalBytes = Buffer.byteLength(diff, "utf8");
  if (totalBytes <= maxBytes) {
    return { text: diff, truncated: false };
  }

  const lines = diff.split("\n");
  let usedBytes = 0;
  let cutIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf8") + (i > 0 ? 1 : 0); // +1 for joiner "\n"
    if (usedBytes + lineBytes > maxBytes) break;
    usedBytes += lineBytes;
    cutIndex = i + 1;
  }
  if (cutIndex === 0 && lines.length > 0) cutIndex = 1;
  return { text: lines.slice(0, cutIndex).join("\n"), truncated: true };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitDiffTool(server: FastMCP): void {
  server.addTool({
    name: "git_diff",
    description:
      "Raw diff text for scoped file(s) or range. `staged: true` for staged changes, " +
      "`base`/`head` for revision ranges, `paths` to scope, `unified` for context lines, " +
      "`findCopies` for copy detection (`-C`). " +
      "Output is capped by `maxBytes` (default 512000) to bound agent context.",
    annotations: {
      title: "Git Diff",
      readOnlyHint: true,
      openWorldHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      base: z
        .string()
        .optional()
        .describe(
          'Base ref (e.g. "main"). Ancestor notation is accepted (e.g. "HEAD~3", "main^2"). Omit for unstaged changes.',
        ),
      head: z
        .string()
        .optional()
        .describe(
          'Head ref (e.g. "feature-branch"). Ancestor notation is accepted (e.g. "HEAD~3", "main^2"). Defaults to HEAD. Used only when `base` is set.',
        ),
      paths: z
        .array(z.string())
        .max(MAX_PATHS)
        .optional()
        .describe(`Scope to one or more files (must be within repo root, max ${MAX_PATHS}).`),
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
      findCopies: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Detect copies from other files (`git diff -C`), alongside default rename detection.",
        ),
      maxBytes: z
        .number()
        .int()
        .min(1024)
        .max(10_000_000)
        .optional()
        .default(GIT_DIFF_DEFAULT_MAX_BYTES)
        .describe(
          `Max UTF-8 bytes of diff text to return (default ${GIT_DIFF_DEFAULT_MAX_BYTES}), cut at a line boundary. Oversized output is truncated with truncated:true.`,
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      // Trim + dedup paths, preserving order
      const rawPaths: string[] = [];
      if (Array.isArray(args.paths)) {
        for (const p of args.paths) {
          if (typeof p === "string" && p.trim()) {
            rawPaths.push(p.trim());
          }
        }
      }
      const dedupedPaths = [...new Set(rawPaths)];

      // Confine each path within the repo
      for (const p of dedupedPaths) {
        if (!validateRepoPath(p, gitTop).underTop) {
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
        findCopies: args.findCopies,
      });
      if (!diffArgsResult.ok) {
        return jsonRespond({ error: diffArgsResult.error });
      }

      // Run git diff. maxBufferBytes is recomputed per call (not the cached
      // module constant) so tests can shrink GIT_SUBPROCESS_MAX_BUFFER_BYTES
      // at request time without needing multi-MiB fixtures.
      const result = await spawnGitAsync(gitTop, diffArgsResult.args, {
        maxBufferBytes: resolveGitSubprocessMaxBufferBytes(),
      });
      // A subprocess-level buffer cap (result.truncated) still yields usable
      // partial stdout — build the normal payload from it instead of failing.
      if (!result.ok && !result.truncated) {
        return jsonRespond({
          error: ERROR_CODES.GIT_DIFF_FAILED,
          detail: gitFailureDetail(result),
        });
      }

      const maxBytes =
        typeof args.maxBytes === "number" ? args.maxBytes : GIT_DIFF_DEFAULT_MAX_BYTES;
      const { text: diffText, truncated: byteTruncated } = truncateDiffOutput(
        result.stdout,
        maxBytes,
      );
      const truncated = byteTruncated || result.truncated === true;

      const label = rangeLabel({
        base: args.base,
        head: args.head,
        paths: dedupedPaths.length > 0 ? dedupedPaths : undefined,
        staged: args.staged,
      });

      return jsonRespond({
        range: label,
        diff: diffText,
        ...spreadWhen(truncated, { truncated: true }),
      });
    },
  });
}
