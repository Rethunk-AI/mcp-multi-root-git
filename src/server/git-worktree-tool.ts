import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { platform } from "node:process";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { gitFailureDetail, spawnGitAsync } from "./git.js";
import {
  isProtectedBranch,
  isSafeGitRefToken,
  listWorktrees,
  type WorktreeEntry,
} from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

/**
 * Resolve a worktree path for add/remove.
 *
 * Sibling worktrees outside `gitTop` are intentional (absolute or relative).
 * Still refuse empty/whitespace, NUL bytes, and leading-dash / option-like
 * path tokens so git does not treat the operand as a flag. Callers must pass
 * the resolved path after `--` in argv.
 */
function resolveWorktreePath(
  gitTop: string,
  rawPath: string,
): { ok: true; path: string } | { ok: false; error: string; path: string } {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    return { ok: false, error: ERROR_CODES.INVALID_PATHS, path: rawPath };
  }
  // Reject option-like tokens before resolve (relative "-foo") and after
  // (absolute paths whose basename still starts with `-`, e.g. "/tmp/-evil").
  if (trimmed.startsWith("-") || basename(trimmed).startsWith("-")) {
    return { ok: false, error: ERROR_CODES.INVALID_PATHS, path: rawPath };
  }
  const wtPath = resolve(gitTop, trimmed);
  if (basename(wtPath).startsWith("-")) {
    return { ok: false, error: ERROR_CODES.INVALID_PATHS, path: rawPath };
  }
  return { ok: true, path: wtPath };
}

/**
 * Canonicalize a path for the registration-check comparison: resolve symlinks
 * (`git worktree list` reports the canonical path, but a caller may pass a
 * symlinked alias) and, on case-insensitive filesystems (macOS/Windows),
 * lowercase it. Falls back to the input unchanged when it does not exist
 * (e.g. already removed) — comparison then degrades to a plain string match.
 */
function normalizeWorktreePathForCompare(p: string): string {
  let resolved = p;
  try {
    resolved = realpathSync(p);
  } catch {
    // Path may not exist (stale registration, already-removed worktree) —
    // fall back to comparing the raw resolved path.
  }
  return platform === "darwin" || platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Build the `git_worktree_add` success JSON payload. */
function buildGitWorktreeAddJson(opts: {
  path: string;
  branch: string;
  created: boolean;
  baseRef: string | undefined;
}): Record<string, unknown> {
  return {
    ok: true,
    path: opts.path,
    branch: opts.branch,
    created: opts.created,
    ...spreadDefined("baseRef", opts.baseRef),
  };
}

/** Build the `git_worktree_remove` success JSON payload. */
function buildGitWorktreeRemoveJson(path: string): Record<string, unknown> {
  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// git_worktree_add
// ---------------------------------------------------------------------------

export function registerGitWorktreeAddTool(server: FastMCP): void {
  server.addTool({
    name: "git_worktree_add",
    description:
      "Add a new git worktree. Creates `branch` from `baseRef` (default: HEAD) if it doesn't exist. Refuses protected branch names.",
    annotations: {
      title: "Git Worktree Add",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      path: z
        .string()
        .min(1)
        .describe(
          "Filesystem path for the new worktree (relative paths resolved from git toplevel). " +
            "Sibling directories outside the repo toplevel are allowed; leading `-` and NUL are rejected.",
        ),
      branch: z
        .string()
        .min(1)
        .describe("Branch to check out; created from `baseRef` if it doesn't exist."),
      baseRef: z
        .string()
        .optional()
        .describe("Commit-ish to base the new branch on. Default: HEAD."),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      const branch = args.branch.trim();
      const baseRef = args.baseRef !== undefined ? args.baseRef.trim() : undefined;

      // Validate branch
      if (!isSafeGitRefToken(branch)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.branch });
      }
      if (isProtectedBranch(branch)) {
        return jsonRespond({ error: ERROR_CODES.PROTECTED_BRANCH, branch });
      }
      if (baseRef !== undefined && !isSafeGitRefToken(baseRef)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.baseRef });
      }

      const resolved = resolveWorktreePath(gitTop, args.path);
      if (!resolved.ok) {
        return jsonRespond({ error: resolved.error, path: resolved.path });
      }
      const wtPath = resolved.path;

      // Check if branch already exists
      const branchCheck = await spawnGitAsync(gitTop, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      const branchExists = branchCheck.ok;

      // Path must follow `--` so a leading-dash path cannot be parsed as an option.
      let gitArgs: string[];
      if (branchExists) {
        gitArgs = ["worktree", "add", "--", wtPath, branch];
      } else {
        gitArgs = ["worktree", "add", "-b", branch, "--", wtPath];
        if (baseRef) gitArgs.push(baseRef);
      }

      const r = await spawnGitAsync(gitTop, gitArgs);
      if (!r.ok) {
        return jsonRespond({
          ok: false,
          error: ERROR_CODES.WORKTREE_ADD_FAILED,
          detail: gitFailureDetail(r),
        });
      }

      return jsonRespond(
        buildGitWorktreeAddJson({
          path: wtPath,
          branch,
          created: !branchExists,
          baseRef: !branchExists ? (baseRef ?? "HEAD") : undefined,
        }),
      );
    },
  });
}

// ---------------------------------------------------------------------------
// git_worktree_remove
// ---------------------------------------------------------------------------

export function registerGitWorktreeRemoveTool(server: FastMCP): void {
  server.addTool({
    name: "git_worktree_remove",
    description:
      "Remove a git worktree. Pass `force: true` to remove with uncommitted changes. Refuses to remove the main worktree.",
    annotations: {
      title: "Git Worktree Remove",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      path: z
        .string()
        .min(1)
        .describe(
          "Path of the worktree to remove. Must not be the main worktree. " +
            "Sibling paths outside the repo toplevel are allowed; leading `-` and NUL are rejected.",
        ),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe("Allow removal of worktrees with uncommitted changes (`--force`)."),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      const resolved = resolveWorktreePath(gitTop, args.path);
      if (!resolved.ok) {
        return jsonRespond({ error: resolved.error, path: resolved.path });
      }
      const wtPath = resolved.path;

      // Refuse to remove the main worktree
      if (wtPath === gitTop) {
        return jsonRespond({ error: ERROR_CODES.CANNOT_REMOVE_MAIN_WORKTREE, path: wtPath });
      }

      // Verify it exists in the worktree list
      const listed = await listWorktrees(gitTop);
      if (!listed.ok) {
        return jsonRespond({
          ok: false,
          error: ERROR_CODES.WORKTREE_REMOVE_FAILED,
          detail: listed.detail,
        });
      }
      const trees: WorktreeEntry[] = listed.worktrees;
      const normalizedCandidates = new Set(
        [wtPath, args.path].map(normalizeWorktreePathForCompare),
      );
      const isRegistered = trees.some((t) =>
        normalizedCandidates.has(normalizeWorktreePathForCompare(t.path)),
      );
      if (!isRegistered) {
        return jsonRespond({ error: ERROR_CODES.WORKTREE_NOT_FOUND, path: args.path });
      }

      const removeArgs: string[] = ["worktree", "remove"];
      if (args.force) removeArgs.push("--force");
      removeArgs.push("--", wtPath);

      const r = await spawnGitAsync(gitTop, removeArgs);
      if (!r.ok) {
        return jsonRespond({
          ok: false,
          error: ERROR_CODES.WORKTREE_REMOVE_FAILED,
          detail: gitFailureDetail(r),
          ...spreadWhen(
            (r.stderr || r.stdout).includes("contains modified") ||
              (r.stderr || r.stdout).includes("is not empty"),
            { hint: "Pass force: true to remove a worktree with uncommitted changes." },
          ),
        });
      }

      return jsonRespond(buildGitWorktreeRemoveJson(wtPath));
    },
  });
}
