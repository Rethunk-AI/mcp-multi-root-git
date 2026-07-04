import { existsSync } from "node:fs";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { isStrictlyUnderGitTop, resolvePathForRepo } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { getCurrentBranch, inferRemoteFromUpstream } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

const FileEntrySchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1).describe("File path relative to git root."),
    lines: z
      .object({
        from: z.number().int().min(1).max(1000000).describe("Start line number (1-indexed)."),
        to: z
          .number()
          .int()
          .min(1)
          .max(1000000)
          .describe("End line number (1-indexed, inclusive)."),
      })
      .describe("Line range to stage. Only hunks overlapping [from, to] are staged."),
  }),
]);

const CommitEntrySchema = z.object({
  message: z.string().min(1).describe("Commit message."),
  files: z
    .array(FileEntrySchema)
    .min(1)
    .describe(
      "Paths to stage, relative to git root. String or `{ path, lines }` for hunk-level staging. " +
        "Deleted tracked files are staged via `git rm --cached`. Cannot combine `lines` with a deleted file.",
    ),
});

const PushModeSchema = z
  .enum(["never", "after"])
  .optional()
  .default("never")
  .describe(
    "`never` (default): no push. `after`: push current branch to upstream after all commits succeed; " +
      "fails with `push_no_upstream` if no upstream (commits are NOT rolled back).",
  );

const DryRunSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    "Stage files and return a preview without writing commits; unstages afterwards. Response is marked DRY RUN.",
  );

/**
 * Parses a unified diff to extract hunks that overlap with a given line range.
 * Returns a partial patch containing only the overlapping hunks, including header lines.
 * Uses new file line numbers (after @@) to determine overlap.
 */
function extractOverlappingHunks(
  diffContent: string,
  fromLine: number,
  toLine: number,
): string | null {
  const lines = diffContent.split("\n");

  // Find file header lines (index, ---, +++)
  const fileHeaderLines: string[] = [];
  let firstHunkIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith("@@")) {
      firstHunkIdx = i;
      break;
    }
    fileHeaderLines.push(line);
  }

  if (firstHunkIdx === -1) {
    // No hunks found
    return null;
  }

  const result: string[] = [...fileHeaderLines];
  let i = firstHunkIdx;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      i++;
      continue;
    }

    // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);

    if (hunkMatch) {
      const newStart = Number.parseInt(hunkMatch[1] || "0", 10);
      const newCount = Number.parseInt(hunkMatch[2] || "1", 10);
      // newCount=0 means pure deletion; hunkEnd must equal newStart so ranges
      // that include newStart correctly capture the deletion.
      const hunkEnd = newCount === 0 ? newStart : newStart + newCount - 1;

      // Check if hunk overlaps with requested line range
      const hasOverlap = !(hunkEnd < fromLine || newStart > toLine);

      if (hasOverlap) {
        // Add hunk header
        result.push(line);
        i++;

        // Add hunk content until next hunk or EOF
        while (i < lines.length) {
          const contentLine = lines[i];
          if (contentLine === undefined) {
            i++;
            continue;
          }
          // Stop at next hunk header
          if (contentLine.startsWith("@@")) {
            break;
          }
          result.push(contentLine);
          i++;
        }
      } else {
        // Skip hunk
        i++;
        while (i < lines.length) {
          const contentLine = lines[i];
          if (contentLine === undefined) {
            i++;
            continue;
          }
          if (contentLine.startsWith("@@")) {
            break;
          }
          i++;
        }
      }
    } else {
      i++;
    }
  }

  // Trailing newline is required: when the selected hunk(s) aren't the last hunk in the
  // real diff, the last copied line is a content line that had a newline after it in the
  // original diff output. Dropping it produces a patch `git apply` rejects as corrupt.
  return result.length > fileHeaderLines.length ? `${result.join("\n")}\n` : null;
}

/**
 * Stages a file with optional line range. If lines are provided, only hunks
 * overlapping the range are staged via a partial patch. Otherwise, stages the whole file.
 */
async function stageFile(
  gitTop: string,
  filePath: string,
  lines?: { from: number; to: number },
): Promise<{ ok: boolean; error?: string }> {
  const absPath = resolvePathForRepo(filePath, gitTop);
  const fileOnDisk = existsSync(absPath);

  if (!fileOnDisk) {
    if (lines) {
      return { ok: false, error: "cannot stage line range for deleted file" };
    }
    // File missing on disk — stage as removal if tracked in HEAD
    const lsResult = await spawnGitAsync(gitTop, ["ls-files", "--error-unmatch", "--", filePath]);
    if (!lsResult.ok) {
      return { ok: false, error: `pathspec '${filePath}' did not match any files` };
    }
    const rmResult = await spawnGitAsync(gitTop, ["rm", "--cached", "--", filePath]);
    return {
      ok: rmResult.ok,
      error: rmResult.ok ? undefined : (rmResult.stderr || rmResult.stdout).trim(),
    };
  }

  if (!lines) {
    // Simple case: stage the whole file
    const addResult = await spawnGitAsync(gitTop, ["add", "--", filePath]);
    return {
      ok: addResult.ok,
      error: addResult.ok ? undefined : (addResult.stderr || addResult.stdout).trim(),
    };
  }

  // Line range case: extract overlapping hunks and apply patch
  const diffResult = await spawnGitAsync(gitTop, ["diff", filePath]);
  if (!diffResult.ok) {
    return { ok: false, error: (diffResult.stderr || diffResult.stdout).trim() };
  }

  const partialPatch = extractOverlappingHunks(diffResult.stdout, lines.from, lines.to);
  if (!partialPatch) {
    return { ok: false, error: "No hunks found in line range" };
  }

  // Resolve the real git dir (works for linked worktrees where .git is a file, not a dir)
  const gitDirResult = await spawnGitAsync(gitTop, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDirResult.ok) {
    return { ok: false, error: (gitDirResult.stderr || gitDirResult.stdout).trim() };
  }
  const gitDir = gitDirResult.stdout.trim();

  // Write partial patch to temp file in the git dir and apply it to the index
  const tempPatchFile = `${gitDir}/.mcp-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`;
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(tempPatchFile, partialPatch, "utf8");

  const applyResult = await spawnGitAsync(gitTop, ["apply", "--cached", tempPatchFile]);

  // Clean up temp file
  try {
    unlinkSync(tempPatchFile);
  } catch {
    // Ignore cleanup errors
  }

  return {
    ok: applyResult.ok,
    error: applyResult.ok ? undefined : (applyResult.stderr || applyResult.stdout).trim(),
  };
}

interface CommitResult {
  index: number;
  ok: boolean;
  sha?: string;
  message: string;
  files: string[]; // File paths only (for display)
  error?: string;
  detail?: string;
  output?: string;
  staged?: string[]; // For dry-run: files that were staged
  diffStat?: string; // For dry-run: diff stat output
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
    return { ok: false, error: ERROR_CODES.PUSH_DETACHED_HEAD };
  }

  const t = await inferRemoteFromUpstream(gitTop);
  if (!t.ok) {
    return { ok: false, branch, error: ERROR_CODES.PUSH_NO_UPSTREAM, detail: t.detail };
  }

  const pushResult = await spawnGitAsync(gitTop, ["push", t.remote, branch]);
  if (!pushResult.ok) {
    return {
      ok: false,
      branch,
      upstream: t.upstream,
      error: ERROR_CODES.PUSH_FAILED,
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
      "Create multiple sequential git commits in one call. " +
      "Each entry stages its files then commits. Stops on first failure. " +
      'Optional `push: "after"` pushes after all commits succeed. `dryRun: true` previews without writing.',
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
        .describe("Ordered list of commits to create."),
      push: PushModeSchema,
      dryRun: DryRunSchema,
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      const results: CommitResult[] = [];
      const stagedFilesForCleanup: Set<string> = new Set();

      // Snapshot already-staged paths BEFORE the preview loop so dry-run cleanup
      // doesn't unstage files the caller had staged before invoking.
      let preStagedPaths: Set<string> = new Set();
      if (args.dryRun) {
        const snapResult = await spawnGitAsync(gitTop, ["diff", "--cached", "--name-only"]);
        if (snapResult.ok) {
          preStagedPaths = new Set(
            snapResult.stdout
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
      }

      for (let i = 0; i < args.commits.length; i++) {
        const entry = args.commits[i];
        if (!entry) break;

        // Normalize file entries to { path, lines? } format
        const fileEntries: Array<{ path: string; lines?: { from: number; to: number } }> = [];
        const filePaths: string[] = [];
        for (const fileEntry of entry.files) {
          if (typeof fileEntry === "string") {
            fileEntries.push({ path: fileEntry });
            filePaths.push(fileEntry);
          } else {
            fileEntries.push(fileEntry);
            filePaths.push(fileEntry.path);
          }
        }

        // --- Validate all paths are under the git toplevel ---
        const escapedPaths: string[] = [];
        for (const path of filePaths) {
          const abs = resolvePathForRepo(path, gitTop);
          if (!isStrictlyUnderGitTop(abs, gitTop)) {
            escapedPaths.push(path);
          }
        }
        if (escapedPaths.length > 0) {
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: filePaths,
            error: ERROR_CODES.PATH_ESCAPES_REPOSITORY,
            detail: escapedPaths.join(", "),
          });
          break;
        }

        // --- Stage files (with optional line ranges) ---
        let stagingFailed = false;
        let stagingError = "";
        for (const fileEntry of fileEntries) {
          const stageResult = await stageFile(gitTop, fileEntry.path, fileEntry.lines);
          if (!stageResult.ok) {
            stagingFailed = true;
            stagingError = stageResult.error || "Unknown error";
            break;
          }
          // Track for dry-run cleanup as soon as a file stages successfully — a later
          // file in this same commit entry may still fail, and anything already staged
          // must still be unstaged so a failed dry run never leaves index state behind.
          // Excludes paths that were already staged before this call (so pre-existing
          // staged state survives).
          if (args.dryRun && !preStagedPaths.has(fileEntry.path)) {
            stagedFilesForCleanup.add(fileEntry.path);
          }
        }

        if (stagingFailed) {
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: filePaths,
            error: ERROR_CODES.STAGE_FAILED,
            detail: stagingError,
            ...spreadDefined("output", stagingError || undefined),
          });
          break;
        }

        // --- Dry-run mode: collect preview and unstage ---
        if (args.dryRun) {
          // Get diff stat for this staged entry
          const diffStatResult = await spawnGitAsync(gitTop, ["diff", "--staged", "--stat"]);
          const diffStat = diffStatResult.ok ? (diffStatResult.stdout || "").trim() : undefined;

          results.push({
            index: i,
            ok: true,
            message: entry.message,
            files: filePaths,
            staged: filePaths,
            ...spreadDefined("diffStat", diffStat || undefined),
          });
          continue; // Skip actual commit in dry-run mode
        }

        // --- Commit ---
        const commitResult = await spawnGitAsync(gitTop, ["commit", "-m", entry.message]);
        if (!commitResult.ok) {
          const gitOutput = (commitResult.stderr || commitResult.stdout).trim();
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: filePaths,
            error: ERROR_CODES.COMMIT_FAILED,
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
          files: filePaths,
          ...spreadDefined("output", gitOutput || undefined),
        });
      }

      // --- In dry-run mode, unstage all files ---
      if (args.dryRun && stagedFilesForCleanup.size > 0) {
        const filesToReset = Array.from(stagedFilesForCleanup);
        await spawnGitAsync(gitTop, ["reset", "HEAD", "--", ...filesToReset]);
      }

      const allOk = results.length === args.commits.length && results.every((r) => r.ok);

      // --- Optional push after all commits succeed (not in dry-run mode) ---
      const push: PushReport | undefined =
        !args.dryRun && allOk && args.push === "after" ? await runPushAfter(gitTop) : undefined;

      if (args.format === "json") {
        return jsonRespond({
          ...spreadWhen(args.dryRun, { dryRun: true }),
          ok: allOk,
          committed: results.filter((r) => r.ok).length,
          total: args.commits.length,
          results: results.map((r) => ({
            index: r.index,
            ok: r.ok,
            ...spreadDefined("sha", r.sha),
            // message/files are the caller's own request echoed back — only worth
            // repeating on failure, where the caller needs them to diagnose without
            // cross-referencing the request.
            ...spreadWhen(!r.ok, { message: r.message, files: r.files }),
            ...spreadDefined("staged", r.staged),
            ...spreadDefined("diffStat", r.diffStat),
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
      const dryRunPrefix = args.dryRun ? "DRY RUN — " : "";
      const header = allOk
        ? `# Batch commit: ${dryRunPrefix}${results.length}/${args.commits.length} committed`
        : `# Batch commit: ${dryRunPrefix}${results.filter((r) => r.ok).length}/${args.commits.length} committed (stopped on error)`;
      lines.push(header, "");

      for (const r of results) {
        const icon = r.ok ? "✓" : "✗";
        const sha = r.sha ? ` \`${r.sha}\`` : "";
        lines.push(`${icon}${sha} ${r.message}`);
        if (!r.ok && r.detail) {
          lines.push(`  Error: ${r.error} — ${r.detail}`);
        }
        if (args.dryRun && r.staged) {
          lines.push(`  Staged: ${r.staged.join(", ")}`);
        }
        if (args.dryRun && r.diffStat) {
          lines.push(`  Diff stat:`);
          lines.push(`  ${r.diffStat.replace(/\n/g, "\n  ")}`);
        }
        if (r.output) {
          lines.push(`  Output: ${r.output.replace(/\n/g, "\n  ")}`);
        }
      }

      if (!allOk && results.length < args.commits.length) {
        const skipped = args.commits.length - results.length;
        lines.push("", `${skipped} remaining commit(s) skipped.`);
      }

      if (args.dryRun) {
        lines.push("", "**DRY RUN — no commits written. All staged files have been unstaged.**");
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
