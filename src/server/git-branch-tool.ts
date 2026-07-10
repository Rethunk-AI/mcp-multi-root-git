import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { isProtectedBranch, isSafeGitAncestorRef, isSafeGitRefToken } from "./git-refs.js";
import { jsonRespond } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BranchResult {
  action: "create" | "delete" | "rename";
  branch: string;
  sha: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a ref (branch/commit-ish) to its full SHA; `null` if unresolvable. */
async function getRefSha(gitTop: string, ref: string): Promise<string | null> {
  const result = await spawnGitAsync(gitTop, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return sha === "" ? null : sha;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitBranchTool(server: FastMCP): void {
  server.addTool({
    name: "git_branch",
    description:
      "Create, delete, or rename a local git branch. `action: 'create'` makes `name` from `from` " +
      "(default HEAD); `action: 'delete'` removes `name` (`force: true` for an unmerged branch, `-D`); " +
      "`action: 'rename'` renames `name` to `newName`. Refuses protected branch names " +
      "(main/master/dev/develop/stable/trunk/prod/production/release*/hotfix*) in any role.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      action: z.enum(["create", "delete", "rename"]).describe("Which branch operation to perform."),
      name: z
        .string()
        .min(1)
        .describe("Branch name to create/delete, or the existing branch name for rename."),
      from: z
        .string()
        .optional()
        .describe("Commit-ish to base a new branch on (create only). Default: HEAD."),
      newName: z.string().optional().describe("New branch name (required for rename)."),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Force-delete an unmerged branch (`git branch -D`). Delete only; never overrides protected-branch rejection.",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      const name = args.name.trim();
      if (!isSafeGitRefToken(name)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: name });
      }
      if (isProtectedBranch(name)) {
        return jsonRespond({ error: ERROR_CODES.PROTECTED_BRANCH, branch: name });
      }

      if (args.action === "create") {
        const fromRef = (args.from ?? "HEAD").trim();
        if (!isSafeGitAncestorRef(fromRef)) {
          return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: fromRef });
        }

        const sha = await getRefSha(gitTop, fromRef);
        if (!sha) {
          return jsonRespond({ error: ERROR_CODES.REF_NOT_FOUND, ref: fromRef });
        }

        const createResult = await spawnGitAsync(gitTop, ["branch", name, fromRef]);
        if (!createResult.ok) {
          return jsonRespond({
            error: ERROR_CODES.BRANCH_CREATE_FAILED,
            detail: (createResult.stderr || createResult.stdout).trim(),
          });
        }

        return respond(args.format, { action: "create", branch: name, sha }, fromRef);
      }

      if (args.action === "delete") {
        const sha = await getRefSha(gitTop, name);
        if (!sha) {
          return jsonRespond({ error: ERROR_CODES.REF_NOT_FOUND, ref: name });
        }

        const deleteArgs = ["branch", args.force ? "-D" : "-d", name];
        const deleteResult = await spawnGitAsync(gitTop, deleteArgs);
        if (!deleteResult.ok) {
          return jsonRespond({
            error: ERROR_CODES.BRANCH_DELETE_FAILED,
            detail: (deleteResult.stderr || deleteResult.stdout).trim(),
          });
        }

        return respond(args.format, { action: "delete", branch: name, sha });
      }

      // action === "rename"
      const newName = args.newName?.trim();
      if (!newName) {
        return jsonRespond({ error: ERROR_CODES.MISSING_NEW_NAME });
      }
      if (!isSafeGitRefToken(newName)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: newName });
      }
      if (isProtectedBranch(newName)) {
        return jsonRespond({ error: ERROR_CODES.PROTECTED_BRANCH, branch: newName });
      }

      const renameResult = await spawnGitAsync(gitTop, ["branch", "-m", name, newName]);
      if (!renameResult.ok) {
        return jsonRespond({
          error: ERROR_CODES.BRANCH_RENAME_FAILED,
          detail: (renameResult.stderr || renameResult.stdout).trim(),
        });
      }

      const sha = await getRefSha(gitTop, newName);
      if (!sha) {
        return jsonRespond({
          error: ERROR_CODES.BRANCH_RENAME_FAILED,
          detail: `renamed '${name}' to '${newName}' but could not resolve its SHA`,
        });
      }

      return respond(args.format, { action: "rename", branch: newName, sha }, undefined, name);
    },
  });
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function respond(
  format: "markdown" | "json" | undefined,
  result: BranchResult,
  from?: string,
  renamedFrom?: string,
): string {
  if (format === "json") {
    return jsonRespond(result as unknown as Record<string, unknown>);
  }

  const lines: string[] = [];
  if (result.action === "create") {
    lines.push(`# Branch created: ${result.branch}`);
    lines.push("");
    lines.push(`**From:** ${from ?? "HEAD"}`);
  } else if (result.action === "delete") {
    lines.push(`# Branch deleted: ${result.branch}`);
  } else {
    lines.push(`# Branch renamed: ${renamedFrom ?? "?"} → ${result.branch}`);
  }
  lines.push(`**SHA:** \`${result.sha}\``);
  return lines.join("\n");
}
