import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { resolvePathForRepo, validateRepoPath } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { gitFailureDetail, parseGitSubmodulePaths, spawnGitAsync } from "./git.js";
import { getCurrentBranch, inferRemoteFromUpstream } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { condenseCommitOutput, condensePushOutput } from "./push-output.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

const FileEntrySchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1).describe("File path relative to git root."),
    lineFrom: z
      .number()
      .int()
      .min(1)
      .max(1000000)
      .describe(
        "Start line number (1-indexed). Only hunks overlapping [lineFrom, lineTo] are staged.",
      ),
    lineTo: z
      .number()
      .int()
      .min(1)
      .max(1000000)
      .describe("End line number (1-indexed, inclusive)."),
    // Not a `.refine((v) => v.lineFrom <= v.lineTo)` here: schema-level
    // refinement would reject `lineFrom > lineTo` before `execute` ever runs,
    // making the runtime check below (which returns a structured
    // invalid_line_range result inside `results`, consistent with this
    // tool's other per-entry errors) unreachable dead code.
  }),
]);

const CommitEntrySchema = z.object({
  message: z.string().min(1).describe("Commit message."),
  files: z
    .array(FileEntrySchema)
    .min(1)
    .describe(
      "Paths to stage, relative to git root. String or `{ path, lineFrom, lineTo }` for hunk-level staging. " +
        "Each path is staged individually (`git add` / `git apply --cached` / `git rm --cached`). " +
        "Deleted tracked files are staged via `git rm --cached`. Cannot combine `lineFrom`/`lineTo` with a deleted file. " +
        "Rejects `.`, the repo root, and directory pathspecs.",
    ),
});

type CommitEntryInput = z.infer<typeof CommitEntrySchema>;
type NormalizedFileEntry = { path: string; lineFrom?: number; lineTo?: number };

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

const BatchCommitParamsSchema = WorkspacePickSchema.extend({
  commits: z.array(CommitEntrySchema).min(1).max(50).describe("Ordered list of commits to create."),
  push: PushModeSchema,
  dryRun: DryRunSchema,
});

type BatchCommitArgs = z.infer<typeof BatchCommitParamsSchema>;

/**
 * True when `path` would stage the whole tree or a directory (not a single file).
 * Rejects `.`, `./`, paths resolving to gitTop, trailing-slash directory forms,
 * and on-disk directories. A checked-out submodule is a directory on disk but a
 * single gitlink pathspec to git, so submodule paths (per `.gitmodules`) are
 * exempted from the on-disk directory check.
 */
function isWholeTreeOrDirectoryPathspec(path: string, gitTop: string): boolean {
  const t = path.trim();
  if (t === "" || t === "." || t === "./") return true;
  if (t.endsWith("/") || t.endsWith("/.") || t.endsWith("/..")) return true;

  const abs = resolvePathForRepo(path, gitTop);
  if (resolve(abs) === resolve(gitTop)) return true;

  if (parseGitSubmodulePaths(gitTop).some((p) => resolve(join(gitTop, p)) === resolve(abs))) {
    return false;
  }

  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) return true;
  } catch {
    // ignore stat errors — treat as non-directory
  }
  return false;
}

/**
 * Canonicalizes a caller-supplied path to the same form `git diff --name-only`
 * reports: relative to the git toplevel, no leading `./`, forward slashes.
 * Callers may pass `./x.ts` or other non-canonical relative forms; comparing
 * those literally against git's own output would misclassify this entry's
 * own staged file as an unrelated pre-staged path (see `unmatched` check at
 * the commit call site). Assumes `path` has already been validated as
 * non-absolute and confined under `gitTop`.
 */
function toGitCanonicalPath(path: string, gitTop: string): string {
  const abs = resolvePathForRepo(path, gitTop);
  return relative(gitTop, abs).split(sep).join("/");
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
  lineFrom?: number,
  lineTo?: number,
): Promise<{ ok: boolean; error?: string | undefined }> {
  const hasLineRange = lineFrom !== undefined && lineTo !== undefined;
  const absPath = resolvePathForRepo(filePath, gitTop);
  const fileOnDisk = existsSync(absPath);

  if (!fileOnDisk) {
    if (hasLineRange) {
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
      error: rmResult.ok ? undefined : gitFailureDetail(rmResult),
    };
  }

  if (lineFrom === undefined || lineTo === undefined) {
    // Simple case: stage the whole file
    const addResult = await spawnGitAsync(gitTop, ["add", "--", filePath]);
    return {
      ok: addResult.ok,
      error: addResult.ok ? undefined : gitFailureDetail(addResult),
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
      return { ok: false, error: gitFailureDetail(diffResult) };
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
        error: gitFailureDetail(diffResult) || "No hunks found in line range",
      };
    }
    diffStdout = diffResult.stdout;
  }

  const partialPatch = extractOverlappingHunks(diffStdout, lineFrom, lineTo);
  if (!partialPatch) {
    return { ok: false, error: "No hunks found in line range" };
  }

  // Write partial patch to a temp file outside the git dir (avoids orphan files in .git).
  // Unguessable name + exclusive-create (fails rather than following/overwriting an
  // existing path) closes the symlink/predictable-name race an attacker could otherwise
  // race between path generation and write.
  const { randomUUID } = await import("node:crypto");
  const tempPatchFile = join(tmpdir(), `.mcp-patch-${randomUUID()}.patch`);
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(tempPatchFile, partialPatch, { encoding: "utf8", mode: 0o600, flag: "wx" });

  const applyResult = await spawnGitAsync(gitTop, ["apply", "--cached", tempPatchFile]);

  // Clean up temp file
  try {
    unlinkSync(tempPatchFile);
  } catch {
    // Ignore cleanup errors
  }

  return {
    ok: applyResult.ok,
    error: applyResult.ok ? undefined : gitFailureDetail(applyResult),
  };
}

interface CommitResult {
  index: number;
  ok: boolean;
  sha?: string | undefined;
  message: string;
  files: string[]; // File paths only (for display)
  error?: string;
  detail?: string;
  output?: string | undefined;
  staged?: string[]; // For dry-run: files that were staged
  diffStat?: string; // For dry-run: diff stat output
}

interface PushReport {
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
async function runPushAfter(gitTop: string): Promise<PushReport> {
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
      detail: gitFailureDetail(pushResult),
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

// ---------------------------------------------------------------------------
// Per-repo serialization
// ---------------------------------------------------------------------------

/** Chained execution promises, keyed by resolved (realpath) git toplevel. */
const repoCommitLocks = new Map<string, Promise<unknown>>();

/** Resolves symlinks so distinct caller-supplied paths for the same on-disk repo share one lock. */
function repoLockKey(gitTop: string): string {
  try {
    return realpathSync(gitTop);
  } catch {
    return gitTop;
  }
}

/**
 * Serializes `batch_commit` executions per repo, in-process only. The
 * stage → commit → restore sequence mutates shared index state; two
 * overlapping calls targeting the same git toplevel could otherwise
 * interleave their git invocations and corrupt each other's staging.
 * Chains `run` onto whatever is already queued for `gitTop` — regardless
 * of whether the prior call succeeded or failed — so calls for the same
 * repo execute one at a time, in call order.
 *
 * This is a single-process mutex (the server runs single-process stdio);
 * it does not protect against a second server process or a human running
 * `git` concurrently against the same repo.
 */
function withRepoLock<T>(gitTop: string, run: () => Promise<T>): Promise<T> {
  const key = repoLockKey(gitTop);
  const prior = repoCommitLocks.get(key) ?? Promise.resolve();
  const settledPrior = prior.then(
    () => undefined,
    () => undefined,
  );
  const result = settledPrior.then(run);
  const settledResult = result.then(
    () => undefined,
    () => undefined,
  );
  repoCommitLocks.set(key, settledResult);
  // Best-effort cleanup: drop the map entry once this call settles, unless a
  // later call has already replaced it (avoids unbounded growth across a
  // long-lived process without racing a newer chain link).
  settledResult.then(() => {
    if (repoCommitLocks.get(key) === settledResult) {
      repoCommitLocks.delete(key);
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Per-entry helpers (execute() decomposition)
// ---------------------------------------------------------------------------

/** Builds a failed `CommitResult` — the shape shared by every rejection path. */
function failureResult(
  index: number,
  message: string,
  filePaths: string[],
  error: string,
  detail: string,
  output?: string,
): CommitResult {
  return {
    index,
    ok: false,
    message,
    files: filePaths,
    error,
    detail,
    ...spreadDefined("output", output),
  };
}

/** Snapshots the current index as a tree object, for later restoration via `read-tree`. */
async function snapshotIndex(
  gitTop: string,
): Promise<{ ok: true; tree: string } | { ok: false; detail: string }> {
  const wt = await spawnGitAsync(gitTop, ["write-tree"]);
  if (!wt.ok) {
    return { ok: false, detail: gitFailureDetail(wt) };
  }
  return { ok: true, tree: wt.stdout.trim() };
}

/** Restores the index to a previously captured `write-tree` snapshot. */
async function rollbackEntry(gitTop: string, snapshot: string): Promise<void> {
  await spawnGitAsync(gitTop, ["read-tree", snapshot]);
}

/** Normalizes a commit entry's `files` into `{ path, lineFrom?, lineTo? }` form, flagging `lineFrom > lineTo`. */
function normalizeEntryFiles(entry: CommitEntryInput): {
  fileEntries: NormalizedFileEntry[];
  filePaths: string[];
  invalidLineRange: boolean;
} {
  const fileEntries: NormalizedFileEntry[] = [];
  const filePaths: string[] = [];
  let invalidLineRange = false;
  for (const fileEntry of entry.files) {
    if (typeof fileEntry === "string") {
      fileEntries.push({ path: fileEntry });
      filePaths.push(fileEntry);
    } else {
      if (fileEntry.lineFrom > fileEntry.lineTo) {
        invalidLineRange = true;
        filePaths.push(fileEntry.path);
        break;
      }
      fileEntries.push(fileEntry);
      filePaths.push(fileEntry.path);
    }
  }
  return { fileEntries, filePaths, invalidLineRange };
}

/**
 * Validates an entry's file paths ahead of staging: rejects absolute paths,
 * paths that escape the git toplevel, and `.`/repo-root/directory pathspecs.
 * Returns `undefined` when every path is valid.
 */
function validateEntryPaths(
  filePaths: string[],
  gitTop: string,
): { error: string; detail: string } | undefined {
  // --- Reject absolute paths ---
  // CONTRIBUTING.md forbids mutating tools from accepting absolute paths.
  // `resolvePathForRepo`'s isAbsolute branch is retained for read tools
  // that legitimately pass workspace-absolute paths (git-show, git-diff,
  // etc.) — batch_commit gates it here instead of changing that shared
  // behavior. This also closes the root enabler of the canonicalization
  // mismatch below: an absolute path never round-trips through
  // `relative(gitTop, abs)` the way a caller might expect for the
  // git-relative name comparisons in `commitEntry`.
  const absolutePaths = filePaths.filter((p) => isAbsolute(p.trim()));
  if (absolutePaths.length > 0) {
    return {
      error: ERROR_CODES.INVALID_PATHS,
      detail: `absolute paths are not accepted: ${absolutePaths.join(", ")}`,
    };
  }

  // --- Validate all paths are under the git toplevel ---
  const escapedPaths: string[] = [];
  for (const path of filePaths) {
    if (!validateRepoPath(path, gitTop).underTop) {
      escapedPaths.push(path);
    }
  }
  if (escapedPaths.length > 0) {
    return { error: ERROR_CODES.PATH_ESCAPES_REPO, detail: escapedPaths.join(", ") };
  }

  // --- Reject `.` / repo-root / directory pathspecs ---
  const invalidPaths = filePaths.filter((p) => isWholeTreeOrDirectoryPathspec(p, gitTop));
  if (invalidPaths.length > 0) {
    return {
      error: ERROR_CODES.INVALID_PATHS,
      detail: `directory or whole-tree pathspec rejected: ${invalidPaths.join(", ")}`,
    };
  }

  return undefined;
}

/** Stages every file in an entry, stopping at the first failure. */
async function stageEntryFiles(
  gitTop: string,
  fileEntries: NormalizedFileEntry[],
): Promise<{ ok: true } | { ok: false; detail: string }> {
  for (const fileEntry of fileEntries) {
    const stageResult = await stageFile(
      gitTop,
      fileEntry.path,
      fileEntry.lineFrom,
      fileEntry.lineTo,
    );
    if (!stageResult.ok) {
      return { ok: false, detail: stageResult.error || "Unknown error" };
    }
  }
  return { ok: true };
}

type CommitOutcome =
  | { ok: true; sha?: string | undefined; output?: string | undefined }
  | { ok: false; error: string; detail: string; output?: string | undefined };

/**
 * Commits a staged entry, isolating it from any unrelated pre-staged index
 * paths: `git commit -- <paths>` uses `--only` (worktree) mode and would
 * squash hunk-level staging, so instead this temporarily unstages unrelated
 * paths, commits from the index, then restores them.
 *
 * On any failure — an unmatched canonical path or the commit itself — the
 * index is restored to `entrySnapshot` (the pre-staging state captured by
 * the caller), the same rollback `stage_failed` uses, so a rejected commit
 * (e.g. a pre-commit hook) never leaves this entry's files staged.
 */
async function commitEntry(
  gitTop: string,
  message: string,
  filePaths: string[],
  entrySnapshot: string,
): Promise<CommitOutcome> {
  const stagedNamesResult = await spawnGitAsync(gitTop, ["diff", "--cached", "--name-only"]);
  const stagedNames = stagedNamesResult.ok
    ? stagedNamesResult.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  // Canonicalize this entry's paths before comparing against git's own
  // --name-only output — otherwise a non-canonical caller path (e.g.
  // "./x.ts") would fail to match its own staged name, get classified as
  // "unrelated pre-staged", and get silently excluded from the commit
  // while the tool still returns ok:true.
  const canonicalPaths = filePaths.map((p) => toGitCanonicalPath(p, gitTop));
  const stagedNameSet = new Set(stagedNames);
  const unmatchedCanonicalPaths = canonicalPaths.filter((p) => !stagedNameSet.has(p));
  if (unmatchedCanonicalPaths.length > 0) {
    // A path we intended to stage for this entry didn't show up under
    // its canonical name — never silently drop it; restore and error.
    await rollbackEntry(gitTop, entrySnapshot);
    return {
      ok: false,
      error: ERROR_CODES.INVALID_PATHS,
      detail: `staged path could not be matched to git's canonical name: ${unmatchedCanonicalPaths.join(", ")}`,
    };
  }

  const entryPathSet = new Set(canonicalPaths);
  const unrelatedStaged = stagedNames.filter((p) => !entryPathSet.has(p));

  let indexSnap: string | undefined;
  if (unrelatedStaged.length > 0) {
    const wt = await spawnGitAsync(gitTop, ["write-tree"]);
    if (!wt.ok) {
      return {
        ok: false,
        error: ERROR_CODES.COMMIT_FAILED,
        detail: gitFailureDetail(wt) || "failed to snapshot index for pre-staged path isolation",
      };
    }
    indexSnap = wt.stdout.trim();
    await spawnGitAsync(gitTop, ["restore", "--staged", "--", ...unrelatedStaged]);
  }

  const commitResult = await spawnGitAsync(gitTop, ["commit", "-m", message]);
  if (!commitResult.ok) {
    // Restore the exact pre-entry index snapshot — same rollback as
    // stage_failed — rather than only restoring the unrelated paths, so
    // this entry's own staged files don't linger in the index either.
    await rollbackEntry(gitTop, entrySnapshot);
    const gitOutput = gitFailureDetail(commitResult);
    return {
      ok: false,
      error: ERROR_CODES.COMMIT_FAILED,
      detail: gitOutput,
      output: gitOutput || undefined,
    };
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

  const shaMatch = /\[[\w/.-]+\s+([0-9a-f]+)\]/.exec(commitResult.stdout);
  const gitOutput = condenseCommitOutput(commitResult.stdout, commitResult.stderr);
  return { ok: true, sha: shaMatch?.[1], output: gitOutput || undefined };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Build the `batch_commit` JSON payload from the already-assembled per-entry results. */
function buildBatchCommitJson(
  args: BatchCommitArgs,
  results: CommitResult[],
  allOk: boolean,
  push: PushReport | undefined,
): Record<string, unknown> {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Top-level orchestration (runs inside the per-repo lock)
// ---------------------------------------------------------------------------

async function runBatchCommit(gitTop: string, args: BatchCommitArgs): Promise<string> {
  const results: CommitResult[] = [];

  // Snapshot the full index before dry-run so cleanup restores pre-staged
  // paths even when dryRun stages additional hunks onto the same paths.
  let indexTreeBefore: string | undefined;
  if (args.dryRun) {
    const snap = await snapshotIndex(gitTop);
    if (!snap.ok) {
      return jsonRespond({
        error: ERROR_CODES.COMMIT_FAILED,
        detail: snap.detail || "failed to snapshot index before dryRun",
      });
    }
    indexTreeBefore = snap.tree;
  }

  for (let i = 0; i < args.commits.length; i++) {
    const entry = args.commits[i];
    if (!entry) break;

    const { fileEntries, filePaths, invalidLineRange } = normalizeEntryFiles(entry);
    if (invalidLineRange) {
      results.push(
        failureResult(
          i,
          entry.message,
          filePaths,
          ERROR_CODES.INVALID_LINE_RANGE,
          "lineFrom must be <= lineTo",
        ),
      );
      break;
    }

    const pathError = validateEntryPaths(filePaths, gitTop);
    if (pathError) {
      results.push(failureResult(i, entry.message, filePaths, pathError.error, pathError.detail));
      break;
    }

    // --- Snapshot the index before staging so a mid-entry stage failure (or
    // a rejected commit) restores the exact pre-entry index state. A bare
    // `git restore --staged` resets to HEAD and would destroy content
    // already staged on the same path before this call started; read-tree
    // from this snapshot restores it byte-identically instead.
    const entrySnap = await snapshotIndex(gitTop);
    if (!entrySnap.ok) {
      results.push(
        failureResult(
          i,
          entry.message,
          filePaths,
          ERROR_CODES.COMMIT_FAILED,
          entrySnap.detail || "failed to snapshot index before staging",
        ),
      );
      break;
    }
    const entrySnapshot = entrySnap.tree;

    const stageOutcome = await stageEntryFiles(gitTop, fileEntries);
    if (!stageOutcome.ok) {
      await rollbackEntry(gitTop, entrySnapshot);
      results.push(
        failureResult(
          i,
          entry.message,
          filePaths,
          ERROR_CODES.STAGE_FAILED,
          stageOutcome.detail,
          stageOutcome.detail || undefined,
        ),
      );
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

      // Restore this entry's pre-staging snapshot before the next so the next
      // entry starts clean (final read-tree still restores the full pre-call index).
      await rollbackEntry(gitTop, entrySnapshot);
      continue;
    }

    const commitOutcome = await commitEntry(gitTop, entry.message, filePaths, entrySnapshot);
    if (!commitOutcome.ok) {
      results.push(
        failureResult(
          i,
          entry.message,
          filePaths,
          commitOutcome.error,
          commitOutcome.detail,
          commitOutcome.output,
        ),
      );
      break;
    }

    results.push({
      index: i,
      ok: true,
      sha: commitOutcome.sha,
      message: entry.message,
      files: filePaths,
      ...spreadDefined("output", commitOutcome.output),
    });
  }

  // --- In dry-run mode, restore the full pre-call index ---
  if (args.dryRun && indexTreeBefore) {
    await rollbackEntry(gitTop, indexTreeBefore);
  }

  const allOk = results.length === args.commits.length && results.every((r) => r.ok);

  // --- Optional push after all commits succeed (not in dry-run mode) ---
  const push: PushReport | undefined =
    !args.dryRun && allOk && args.push === "after" ? await runPushAfter(gitTop) : undefined;

  return jsonRespond(buildBatchCommitJson(args, results, allOk, push));
}

export function registerBatchCommitTool(server: FastMCP): void {
  server.addTool({
    name: "batch_commit",
    description:
      "Create multiple sequential git commits in one call. " +
      "Each entry stages its files then commits. Unrelated pre-staged index paths " +
      "are temporarily unstaged around the commit so they are not included " +
      "(hunk-level staging is preserved — pathspec commit mode is not used). " +
      "Stops on first failure; stage_failed and commit_failed both restore the pre-entry index snapshot. " +
      "Concurrent calls on the same repo serialize in-process only (not cross-process). " +
      'Optional `push: "after"` pushes after all commits succeed. `dryRun: true` previews without writing.',
    annotations: {
      title: "Batch Commit",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: BatchCommitParamsSchema,
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;
      return withRepoLock(gitTop, () => runBatchCommit(gitTop, args));
    },
  });
}
