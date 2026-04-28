import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { isStrictlyUnderGitTop, resolvePathForRepo } from "../repo-paths.js";
import { spawnGitAsync } from "./git.js";
import { getCurrentBranch, inferRemoteFromUpstream } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

const CommitEntrySchema = z.object({
  message: z.string().min(1).describe("Commit message."),
  files: z.array(z.string().min(1)).min(1).describe("Paths to stage, relative to the git root."),
});

const PushModeSchema = z
  .enum(["never", "after"])
  .optional()
  .default("never")
  .describe(
    "`never` (default): no push. `after`: push the current branch to its upstream once all commits succeed; " +
      "fails with `push_no_upstream` if the branch has no upstream (commits are NOT rolled back). " +
      "Enum reserved for future modes such as `force-with-lease`.",
  );

interface CommitResult {
  index: number;
  ok: boolean;
  sha?: string;
  message: string;
  files: string[];
  error?: string;
  detail?: string;
  output?: string;
}

export interface PushReport {
  ok: boolean;
  branch?: string;
  upstream?: string;
  error?: string;
  detail?: string;
  output?: string;
}

/**
 * After all commits succeed, push the current branch to its upstream.
 * Commits are already applied at this point — do NOT attempt rollback on push failure.
 */
export async function runPushAfter(gitTop: string): Promise<PushReport> {
  const branch = await getCurrentBranch(gitTop);
  if (!branch) {
    return { ok: false, error: "push_detached_head" };
  }

  const t = await inferRemoteFromUpstream(gitTop);
  if (!t.ok) {
    return { ok: false, branch, error: "push_no_upstream", detail: t.detail };
  }

  const pushResult = await spawnGitAsync(gitTop, ["push", t.remote, branch]);
  if (!pushResult.ok) {
    return {
      ok: false,
      branch,
      upstream: t.upstream,
      error: "push_failed",
      detail: (pushResult.stderr || pushResult.stdout).trim(),
    };
  }
  const gitOutput = (pushResult.stdout || pushResult.stderr).trim();
  return {
    ok: true,
    branch,
    upstream: t.upstream,
    ...spreadDefined("output", gitOutput || undefined),
  };
}

export function registerBatchCommitTool(server: FastMCP): void {
  server.addTool({
    name: "batch_commit",
    description:
      "Create multiple sequential git commits in a single call. " +
      "Each entry stages the listed files then commits with the given message. " +
      'Stops on first failure. Optional `push: "after"` pushes the current branch ' +
      "to its upstream once all commits succeed.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.omit({ absoluteGitRoots: true }).extend({
      commits: z
        .array(CommitEntrySchema)
        .min(1)
        .max(50)
        .describe("Commits to create, applied in order."),
      push: PushModeSchema,
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      const results: CommitResult[] = [];

      for (let i = 0; i < args.commits.length; i++) {
        const entry = args.commits[i];
        if (!entry) break;

        // --- Validate all paths are under the git toplevel ---
        const escapedPaths: string[] = [];
        for (const rel of entry.files) {
          const abs = resolvePathForRepo(rel, gitTop);
          if (!isStrictlyUnderGitTop(abs, gitTop)) {
            escapedPaths.push(rel);
          }
        }
        if (escapedPaths.length > 0) {
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: entry.files,
            error: "path_escapes_repository",
            detail: escapedPaths.join(", "),
          });
          break;
        }

        // --- Stage files ---
        const addResult = await spawnGitAsync(gitTop, ["add", "--", ...entry.files]);
        if (!addResult.ok) {
          const gitOutput = (addResult.stderr || addResult.stdout).trim();
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: entry.files,
            error: "stage_failed",
            detail: gitOutput,
            ...spreadDefined("output", gitOutput || undefined),
          });
          break;
        }

        // --- Commit ---
        const commitResult = await spawnGitAsync(gitTop, ["commit", "-m", entry.message]);
        if (!commitResult.ok) {
          const gitOutput = (commitResult.stderr || commitResult.stdout).trim();
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: entry.files,
            error: "commit_failed",
            detail: gitOutput,
            ...spreadDefined("output", gitOutput || undefined),
          });
          break;
        }

        // --- Extract SHA from commit output ---
        const shaMatch = /\[[\w/.-]+\s+([0-9a-f]+)\]/.exec(commitResult.stdout);
        const gitOutput = (commitResult.stdout || commitResult.stderr).trim();
        results.push({
          index: i,
          ok: true,
          sha: shaMatch?.[1],
          message: entry.message,
          files: entry.files,
          ...spreadDefined("output", gitOutput || undefined),
        });
      }

      const allOk = results.length === args.commits.length && results.every((r) => r.ok);

      // --- Optional push after all commits succeed ---
      const push: PushReport | undefined =
        allOk && args.push === "after" ? await runPushAfter(gitTop) : undefined;

      if (args.format === "json") {
        return jsonRespond({
          ok: allOk,
          committed: results.filter((r) => r.ok).length,
          total: args.commits.length,
          results: results.map((r) => ({
            index: r.index,
            ok: r.ok,
            ...spreadDefined("sha", r.sha),
            message: r.message,
            files: r.files,
            ...spreadDefined("error", r.error),
            ...spreadDefined("detail", r.detail),
            ...spreadDefined("output", r.output),
          })),
          ...spreadWhen(push !== undefined, {
            push: {
              ok: push?.ok ?? false,
              ...spreadDefined("branch", push?.branch),
              ...spreadDefined("upstream", push?.upstream),
              ...spreadDefined("error", push?.error),
              ...spreadDefined("detail", push?.detail),
              ...spreadDefined("output", push?.output),
            },
          }),
        });
      }

      // --- Markdown ---
      const lines: string[] = [];
      const header = allOk
        ? `# Batch commit: ${results.length}/${args.commits.length} committed`
        : `# Batch commit: ${results.filter((r) => r.ok).length}/${args.commits.length} committed (stopped on error)`;
      lines.push(header, "");

      for (const r of results) {
        const icon = r.ok ? "✓" : "✗";
        const sha = r.sha ? ` \`${r.sha}\`` : "";
        lines.push(`${icon}${sha} ${r.message}`);
        if (!r.ok && r.detail) {
          lines.push(`  Error: ${r.error} — ${r.detail}`);
        }
        if (r.output) {
          lines.push(`  Output: ${r.output.replace(/\n/g, "\n  ")}`);
        }
      }

      if (!allOk && results.length < args.commits.length) {
        const skipped = args.commits.length - results.length;
        lines.push("", `${skipped} remaining commit(s) skipped.`);
      }

      if (push) {
        lines.push("");
        if (push.ok) {
          lines.push(`Push: ✓ ${push.branch} → ${push.upstream}`);
        } else {
          lines.push(`Push: ✗ ${push.error}${push.detail ? ` — ${push.detail}` : ""}`);
        }
        if (push.output) {
          lines.push(`  Output: ${push.output.replace(/\n/g, "\n  ")}`);
        }
      }

      return lines.join("\n");
    },
  });
}
