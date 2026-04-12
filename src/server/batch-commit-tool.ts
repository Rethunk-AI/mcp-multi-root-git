import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { isStrictlyUnderGitTop, resolvePathForRepo } from "../repo-paths.js";
import { gitTopLevel, spawnGitAsync } from "./git.js";
import { jsonRespond, spreadDefined } from "./json.js";
import { requireGitAndRoots } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

const CommitEntrySchema = z.object({
  message: z.string().min(1).describe("Commit message."),
  files: z.array(z.string().min(1)).min(1).describe("Paths to stage, relative to the git root."),
});

interface CommitResult {
  index: number;
  ok: boolean;
  sha?: string;
  message: string;
  files: string[];
  error?: string;
  detail?: string;
}

export function registerBatchCommitTool(server: FastMCP): void {
  server.addTool({
    name: "batch_commit",
    description:
      "Create multiple sequential git commits in a single call. " +
      "Each entry stages the listed files then commits with the given message. " +
      "Stops on first failure. See docs/mcp-tools.md.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      commits: z
        .array(CommitEntrySchema)
        .min(1)
        .max(50)
        .describe("Commits to create, applied in order."),
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) return jsonRespond(pre.error);

      const rootInput = pre.roots[0];
      if (!rootInput) {
        return jsonRespond({ error: "no_workspace_root" });
      }

      const gitTop = gitTopLevel(rootInput);
      if (!gitTop) {
        return jsonRespond({ error: "not_a_git_repository", path: rootInput });
      }

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
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: entry.files,
            error: "stage_failed",
            detail: (addResult.stderr || addResult.stdout).trim(),
          });
          break;
        }

        // --- Commit ---
        const commitResult = await spawnGitAsync(gitTop, ["commit", "-m", entry.message]);
        if (!commitResult.ok) {
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: entry.files,
            error: "commit_failed",
            detail: (commitResult.stderr || commitResult.stdout).trim(),
          });
          break;
        }

        // --- Extract SHA from commit output ---
        const shaMatch = /\[[\w/.-]+\s+([0-9a-f]+)\]/.exec(commitResult.stdout);
        results.push({
          index: i,
          ok: true,
          sha: shaMatch?.[1],
          message: entry.message,
          files: entry.files,
        });
      }

      const allOk = results.length === args.commits.length && results.every((r) => r.ok);

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
          })),
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
      }

      if (!allOk && results.length < args.commits.length) {
        const skipped = args.commits.length - results.length;
        lines.push("", `${skipped} remaining commit(s) skipped.`);
      }

      return lines.join("\n");
    },
  });
}
