import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { getCurrentBranch, inferRemoteFromUpstream } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { condensePushOutput } from "./push-output.js";
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
      .refine((l) => l.from <= l.to, {
        message: "lines.from must be <= lines.to",
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
        "Each path is staged individually (`git add` / `git apply --cached` / `git rm --cached`); " +
        "on mid-entry stage failure, already-staged paths for that entry are unstaged. " +
        "Deleted tracked files are staged via `git rm --cached`. Cannot combine `lines` with a deleted file. " +
        "Rejects `.`, the repo root, and directory pathspecs.",
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
    "Stage files and return a preview without writing commits; restores the index afterwards. Response is marked DRY RUN.",
  );

/**
 * True when `path` would stage the whole tree or a directory (not a single file).
 * Rejects `.`, `./`, paths resolving to gitTop, trailing-slash directory forms,
 * and on-disk directories.
 */
function isWholeTreeOrDirectoryPathspec(path: string, gitTop: string): boolean {
  const t = path.trim();
  if (t === "" || t === "." || t === "./") return true;
  if (t.endsWith("/") || t.endsWith("/.") || t.endsWith("/..")) return true;

  const abs = resolvePathForRepo(path, gitTop);
  if (resolve(abs) === resolve(gitTop)) return true;

  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) return true;
  } catch {
    // ignore stat errors — treat as non-directory
  }
  return false;
}

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

  // Line range case: extract overlapping hunks and apply patch.
  // Tracked files: unstaged worktree vs index (`git diff -- path`).
  // Untracked files: synthesize a new-file diff via `--no-index` (exit 1 with
  // differences is expected — treat non-empty stdout as success).
  const tracked = await spawnGitAsync(gitTop, ["ls-files", "--error-unmatch", "--", filePath]);
  let diffStdout: string;
  if (tracked.ok) {
    const diffResult = await spawnGitAsync(gitTop, ["diff", "--", filePath]);
    if (!diffResult.ok && !diffResult.stdout.trim()) {
      return { ok: false, error: (diffResult.stderr || diffResult.stdout).trim() };
    }
    diffStdout = diffResult.stdout;
  } else {
    const diffResult = await spawnGitAsync(gitTop, [
      "diff",
      "--no-index",
      "--",
      "/dev/null",
      filePath,
    ]);
    // --no-index exits 1 when files differ; accept stdout as the patch body.
    if (!diffResult.stdout.trim()) {
      return {
        ok: false,
        error: (diffResult.stderr || diffResult.stdout || "No hunks found in line range").trim(),
      };
    }
    diffStdout = diffResult.stdout;
  }

  const partialPatch = extractOverlappingHunks(diffStdout, lines.from, lines.to);
  if (!partialPatch) {
    return { ok: false, error: "No hunks found in line range" };
  }

  // Write partial patch to a temp file outside the git dir (avoids orphan files in .git)
  const tempPatchFile = join(
    tmpdir(),
    `.mcp-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`,
  );
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
  const gitOutput = condensePushOutput(pushResult.stdout, pushResult.stderr);
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
      "Each entry stages its files then commits. Unrelated pre-staged index paths " +
      "are temporarily unstaged around the commit so they are not included " +
      "(hunk-level staging is preserved — pathspec commit mode is not used). " +
      "Stops on first failure; mid-entry stage failures unstage that entry's " +
      "already-staged paths. " +
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

      // Snapshot the full index before dry-run so cleanup restores pre-staged
      // paths even when dryRun stages additional hunks onto the same paths.
      let indexTreeBefore: string | undefined;
      if (args.dryRun) {
        const wt = await spawnGitAsync(gitTop, ["write-tree"]);
        if (!wt.ok) {
          return jsonRespond({
            error: ERROR_CODES.COMMIT_FAILED,
            detail: (wt.stderr || wt.stdout).trim() || "failed to snapshot index before dryRun",
          });
        }
        indexTreeBefore = wt.stdout.trim();
      }

      for (let i = 0; i < args.commits.length; i++) {
        const entry = args.commits[i];
        if (!entry) break;

        // Normalize file entries to { path, lines? } format
        const fileEntries: Array<{ path: string; lines?: { from: number; to: number } }> = [];
        const filePaths: string[] = [];
        let invalidLineRange = false;
        for (const fileEntry of entry.files) {
          if (typeof fileEntry === "string") {
            fileEntries.push({ path: fileEntry });
            filePaths.push(fileEntry);
          } else {
            if (fileEntry.lines.from > fileEntry.lines.to) {
              invalidLineRange = true;
              filePaths.push(fileEntry.path);
              break;
            }
            fileEntries.push(fileEntry);
            filePaths.push(fileEntry.path);
          }
        }
        if (invalidLineRange) {
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: filePaths,
            error: ERROR_CODES.INVALID_LINE_RANGE,
            detail: "lines.from must be <= lines.to",
          });
          break;
        }

        // --- Validate all paths are under the git toplevel ---
        const escapedPaths: string[] = [];
        for (const path of filePaths) {
          const abs = resolvePathForRepo(path, gitTop);
          if (!assertRelativePathUnderTop(path, abs, gitTop)) {
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

        // --- Reject `.` / repo-root / directory pathspecs ---
        const invalidPaths = filePaths.filter((p) => isWholeTreeOrDirectoryPathspec(p, gitTop));
        if (invalidPaths.length > 0) {
          results.push({
            index: i,
            ok: false,
            message: entry.message,
            files: filePaths,
            error: ERROR_CODES.INVALID_PATHS,
            detail: `directory or whole-tree pathspec rejected: ${invalidPaths.join(", ")}`,
          });
          break;
        }

        // --- Stage files (with optional line ranges) ---
        let stagingFailed = false;
        let stagingError = "";
        const stagedSoFar: string[] = [];
        for (const fileEntry of fileEntries) {
          const stageResult = await stageFile(gitTop, fileEntry.path, fileEntry.lines);
          if (!stageResult.ok) {
            stagingFailed = true;
            stagingError = stageResult.error || "Unknown error";
            break;
          }
          stagedSoFar.push(fileEntry.path);
        }

        if (stagingFailed) {
          // Unstage anything this entry already staged (live + dryRun).
          // dryRun final cleanup also restores via read-tree when available.
          if (stagedSoFar.length > 0) {
            await spawnGitAsync(gitTop, ["restore", "--staged", "--", ...stagedSoFar]);
          }
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

        // --- Dry-run mode: collect preview scoped to this entry's paths ---
        if (args.dryRun) {
          // Path-scoped stat so multi-entry previews do not accumulate prior entries.
          const diffStatResult = await spawnGitAsync(gitTop, [
            "diff",
            "--staged",
            "--stat",
            "--",
            ...filePaths,
          ]);
          const diffStat = diffStatResult.ok ? (diffStatResult.stdout || "").trim() : undefined;

          results.push({
            index: i,
            ok: true,
            message: entry.message,
            files: filePaths,
            staged: filePaths,
            ...spreadDefined("diffStat", diffStat || undefined),
          });

          // Unstage this entry before the next so the next entry's staging starts clean
          // relative to the snapshot (final read-tree still restores pre-call index).
          await spawnGitAsync(gitTop, ["restore", "--staged", "--", ...filePaths]);
          continue;
        }

        // --- Commit: isolate entry files from unrelated pre-staged index paths ---
        // `git commit -- <paths>` uses --only (worktree) mode and would squash
        // hunk-level staging. Instead: snapshot index, temporarily unstage
        // unrelated staged paths, commit from the index, then restore them.
        const stagedNamesResult = await spawnGitAsync(gitTop, ["diff", "--cached", "--name-only"]);
        const stagedNames = stagedNamesResult.ok
          ? stagedNamesResult.stdout
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const entryPathSet = new Set(filePaths);
        const unrelatedStaged = stagedNames.filter((p) => !entryPathSet.has(p));

        let indexSnap: string | undefined;
        if (unrelatedStaged.length > 0) {
          const wt = await spawnGitAsync(gitTop, ["write-tree"]);
          if (!wt.ok) {
            results.push({
              index: i,
              ok: false,
              message: entry.message,
              files: filePaths,
              error: ERROR_CODES.COMMIT_FAILED,
              detail:
                (wt.stderr || wt.stdout).trim() ||
                "failed to snapshot index for pre-staged path isolation",
            });
            break;
          }
          indexSnap = wt.stdout.trim();
          await spawnGitAsync(gitTop, ["restore", "--staged", "--", ...unrelatedStaged]);
        }

        const commitResult = await spawnGitAsync(gitTop, ["commit", "-m", entry.message]);
        if (!commitResult.ok) {
          // Restore unrelated staged paths even on failure so we don't leave the
          // index worse than when we entered this entry.
          if (indexSnap && unrelatedStaged.length > 0) {
            await spawnGitAsync(gitTop, [
              "restore",
              `--source=${indexSnap}`,
              "--staged",
              "--",
              ...unrelatedStaged,
            ]);
          }
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

        if (indexSnap && unrelatedStaged.length > 0) {
          await spawnGitAsync(gitTop, [
            "restore",
            `--source=${indexSnap}`,
            "--staged",
            "--",
            ...unrelatedStaged,
          ]);
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

      // --- In dry-run mode, restore the full pre-call index ---
      if (args.dryRun && indexTreeBefore) {
        await spawnGitAsync(gitTop, ["read-tree", indexTreeBefore]);
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
