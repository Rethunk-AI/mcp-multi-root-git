import { resolve } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import {
  isProtectedBranch,
  isSafeGitRefToken,
  listWorktrees,
  type WorktreeEntry,
} from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// git_worktree_list
// ---------------------------------------------------------------------------

export function registerGitWorktreeListTool(server: FastMCP): void {
  server.addTool({
    name: "git_worktree_list",
    description: "List all git worktrees for the repository (`git worktree list --porcelain`).",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.pick({
      workspaceRoot: true,
      format: true,
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      const trees = await listWorktrees(gitTop);

      if (args.format === "json") {
        return jsonRespond({ worktrees: trees as unknown as Record<string, unknown>[] });
      }

      if (trees.length === 0) {
        return "# Worktrees\n_(none)_";
      }
      const lines: string[] = ["# Worktrees", ""];
      for (const t of trees) {
        const branchPart = t.branch ?? "(detached)";
        const headPart = t.head ? ` @ ${t.head.slice(0, 7)}` : "";
        lines.push(`- \`${t.path}\`  ${branchPart}${headPart}`);
      }
      return lines.join("\n");
    },
  });
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
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.omit({
      absoluteGitRoots: true,
      allWorkspaceRoots: true,
    }).extend({
      path: z
        .string()
        .min(1)
        .describe(
          "Filesystem path for the new worktree (relative paths resolved from git toplevel).",
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

      // Validate branch
      if (!isSafeGitRefToken(args.branch)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.branch });
      }
      if (isProtectedBranch(args.branch)) {
        return jsonRespond({ error: ERROR_CODES.PROTECTED_BRANCH, branch: args.branch });
      }
      if (args.baseRef !== undefined && !isSafeGitRefToken(args.baseRef)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.baseRef });
      }

      // Resolve path
      const wtPath = resolve(gitTop, args.path);

      // Check if branch already exists
      const branchCheck = await spawnGitAsync(gitTop, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${args.branch}`,
      ]);
      const branchExists = branchCheck.ok;

      let gitArgs: string[];
      if (branchExists) {
        gitArgs = ["worktree", "add", wtPath, args.branch];
      } else {
        gitArgs = ["worktree", "add", "-b", args.branch, wtPath];
        if (args.baseRef) gitArgs.push(args.baseRef);
      }

      const r = await spawnGitAsync(gitTop, gitArgs);
      if (!r.ok) {
        return jsonRespond({
          ok: false,
          error: ERROR_CODES.WORKTREE_ADD_FAILED,
          detail: (r.stderr || r.stdout).trim(),
        });
      }

      if (args.format === "json") {
        return jsonRespond({
          ok: true,
          path: wtPath,
          branch: args.branch,
          created: !branchExists,
          ...spreadDefined("baseRef", !branchExists ? (args.baseRef ?? "HEAD") : undefined),
        });
      }

      const createdNote = branchExists ? "" : ` (new branch from ${args.baseRef ?? "HEAD"})`;
      return `# Worktree added\n✓ ${wtPath}  →  ${args.branch}${createdNote}`;
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
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.omit({
      absoluteGitRoots: true,
      allWorkspaceRoots: true,
    }).extend({
      path: z
        .string()
        .min(1)
        .describe("Path of the worktree to remove. Must not be the main worktree."),
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

      // Refuse to remove the main worktree
      const wtPath = resolve(gitTop, args.path);
      if (wtPath === gitTop) {
        return jsonRespond({ error: ERROR_CODES.CANNOT_REMOVE_MAIN_WORKTREE, path: wtPath });
      }

      // Verify it exists in the worktree list
      const trees: WorktreeEntry[] = await listWorktrees(gitTop);
      const isRegistered = trees.some((t) => t.path === wtPath || t.path === args.path);
      if (!isRegistered) {
        return jsonRespond({ error: ERROR_CODES.WORKTREE_NOT_FOUND, path: args.path });
      }

      const removeArgs: string[] = ["worktree", "remove", wtPath];
      if (args.force) removeArgs.push("--force");

      const r = await spawnGitAsync(gitTop, removeArgs);
      if (!r.ok) {
        return jsonRespond({
          ok: false,
          error: ERROR_CODES.WORKTREE_REMOVE_FAILED,
          detail: (r.stderr || r.stdout).trim(),
          ...spreadWhen(
            (r.stderr || r.stdout).includes("contains modified") ||
              (r.stderr || r.stdout).includes("is not empty"),
            { hint: "Pass force: true to remove a worktree with uncommitted changes." },
          ),
        });
      }

      if (args.format === "json") {
        return jsonRespond({ ok: true, path: wtPath });
      }
      return `# Worktree removed\n✓ ${wtPath}`;
    },
  });
}
