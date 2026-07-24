import { basename } from "node:path";
import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { gitFailureDetail, spawnGitAsync } from "./git.js";
import {
  commitListBetween,
  conflictPaths,
  getCurrentBranch,
  isContentEquivalentlyMergedInto,
  isFullyMergedInto,
  isProtectedBranch,
  isSafeGitRangeToken,
  isSafeGitRefToken,
  isWorkingTreeClean,
  resolveRef,
  worktreeForBranch,
} from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

/** Hard cap on SHAs fed to a single `git cherry-pick` (ARG_MAX / runtime guard). */
export const MAX_CHERRY_PICK_COMMITS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceKind = "sha" | "range" | "branch";

interface ResolvedSource {
  raw: string;
  kind: SourceKind;
  commits: string[];
}

interface SourceReport extends ResolvedSource {
  branchDeleted?: boolean;
  worktreeRemoved?: string;
}

interface ConflictReport {
  stage: "cherry-pick";
  commit?: string;
  conflicts: string[];
  detail?: string;
  /** `onConflict: "pause"` left the conflict + sequencer state in place instead of aborting. */
  paused?: boolean;
  /** `cherry_pick_conflicts` (mirrors git_merge's `merge_conflicts`), or `cherry_pick_abort_failed`. */
  error?: string;
  abortFailed?: boolean;
  abortDetail?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function cherryPickHead(gitTop: string): Promise<string | undefined> {
  const r = await spawnGitAsync(gitTop, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]);
  if (!r.ok) return undefined;
  const sha = r.stdout.trim();
  return sha === "" ? undefined : sha;
}

/** Result of `git cherry-pick --abort` — callers must check `ok` before claiming a clean abort. */
export async function abortCherryPick(gitTop: string): Promise<{ ok: boolean; detail?: string }> {
  const r = await spawnGitAsync(gitTop, ["cherry-pick", "--abort"]);
  if (r.ok) return { ok: true };
  const detail = gitFailureDetail(r);
  return detail === "" ? { ok: false } : { ok: false, detail };
}

async function branchExists(gitTop: string, name: string): Promise<boolean> {
  const r = await spawnGitAsync(gitTop, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
  return r.ok;
}

/**
 * Expand a source spec into a list of SHAs to cherry-pick.
 * - `A..B` / `A...B` → `git rev-list --reverse` of the range
 * - branch name (refs/heads/<name> exists) → `into..<branch>` oldest-first
 * - SHA or ref → single commit
 */
async function resolveSource(
  gitTop: string,
  into: string,
  raw: string,
): Promise<ResolvedSource | { error: string; detail?: string; raw: string }> {
  if (raw.includes("..")) {
    if (!isSafeGitRangeToken(raw)) {
      return { error: ERROR_CODES.UNSAFE_REF_TOKEN, raw };
    }
    const r = await spawnGitAsync(gitTop, ["rev-list", "--reverse", raw]);
    if (!r.ok) {
      return {
        error: ERROR_CODES.RANGE_RESOLUTION_FAILED,
        detail: gitFailureDetail(r),
        raw,
      };
    }
    const commits = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { raw, kind: "range", commits };
  }

  if (!isSafeGitRefToken(raw)) {
    return { error: ERROR_CODES.UNSAFE_REF_TOKEN, raw };
  }

  if (await branchExists(gitTop, raw)) {
    const commits = await commitListBetween(gitTop, into, raw);
    if (commits === null) {
      return { error: ERROR_CODES.RANGE_RESOLUTION_FAILED, raw };
    }
    return { raw, kind: "branch", commits };
  }

  const sha = await resolveRef(gitTop, raw);
  if (!sha) {
    return { error: ERROR_CODES.SOURCE_NOT_FOUND, raw };
  }
  return { raw, kind: "sha", commits: [sha] };
}

/**
 * Count of distinct SHAs across all resolved sources — cheap set membership only,
 * no subprocess spawning. Used to enforce `MAX_CHERRY_PICK_COMMITS` *before*
 * `filterAndDedupe` below, which spawns one `merge-base --is-ancestor` subprocess
 * per unique commit; checking the cap first bounds that spawning regardless of
 * how large an unexpanded range/branch source is.
 */
function countUniqueCommits(resolved: ResolvedSource[]): number {
  const seen = new Set<string>();
  for (const src of resolved) {
    for (const sha of src.commits) seen.add(sha);
  }
  return seen.size;
}

/**
 * Pre-filter already-in-destination commits (they would cherry-pick to empty).
 * Also dedupe across sources while preserving first-seen order per-commit.
 */
async function filterAndDedupe(
  gitTop: string,
  into: string,
  resolved: ResolvedSource[],
): Promise<{ picks: string[]; perSourceKept: Map<string, string[]> }> {
  const seen = new Set<string>();
  const picks: string[] = [];
  const perSourceKept = new Map<string, string[]>();
  for (const src of resolved) {
    const kept: string[] = [];
    for (const sha of src.commits) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      // Skip commits already reachable from destination (would produce empty commits).
      const contained = await spawnGitAsync(gitTop, ["merge-base", "--is-ancestor", sha, into]);
      if (contained.ok) continue; // already in destination
      picks.push(sha);
      kept.push(sha);
    }
    perSourceKept.set(src.raw, kept);
  }
  return { picks, perSourceKept };
}

// ---------------------------------------------------------------------------
// Branch-deletion equivalence (cleanup after a successful cherry-pick)
// ---------------------------------------------------------------------------

/**
 * True when `branch`'s history unique to it (since its merge-base with `target`)
 * contains any merge commits. Fails closed (`true`, i.e. "cannot confirm") on any
 * git error so the caller falls back to the strict ref-ancestry path rather than
 * trusting an unverifiable patch-id comparison enough to force-delete.
 */
export async function branchHasUnmergedMergeCommits(
  gitTop: string,
  branch: string,
  target: string,
): Promise<boolean> {
  const mb = await spawnGitAsync(gitTop, ["merge-base", branch, target]);
  if (!mb.ok) return true;
  const base = mb.stdout.trim();
  const r = await spawnGitAsync(gitTop, ["rev-list", "--merges", "--count", `${base}..${branch}`]);
  if (!r.ok) return true;
  return (parseInt(r.stdout.trim(), 10) || 0) > 0;
}

/**
 * Delete a cherry-picked branch-kind source after success.
 *
 * `strict: true` — strict ref-ancestry (`git branch -d`), same semantics as `git_merge`'s cleanup.
 *
 * `strict: false` (default) — patch-id content equivalence (`isContentEquivalentlyMergedInto`),
 * then force-delete with `-D` since cherry-picked history never satisfies `-d`'s ref-ancestry
 * check. That patch-id comparison silently ignores merge commits (plain `git diff-tree` shows no
 * diff for a merge without `-m`/`-c`), so it cannot vouch for any unique content a merge commit
 * introduced (e.g. via conflict resolution). When `branch`'s own history since its merge-base
 * with `into` contains merge commits, fall back to the strict `-d` path instead of trusting that
 * incomplete check enough to force-delete.
 */
export async function maybeDeleteCherryPickedBranch(
  gitTop: string,
  branch: string,
  into: string,
  strict: boolean,
): Promise<boolean> {
  const useStrict = strict || (await branchHasUnmergedMergeCommits(gitTop, branch, into));
  if (useStrict) {
    const merged = await isFullyMergedInto(gitTop, branch, into);
    if (!merged) return false;
    const r = await spawnGitAsync(gitTop, ["branch", "-d", branch]);
    return r.ok;
  }
  const merged = await isContentEquivalentlyMergedInto(gitTop, branch, into);
  if (!merged) return false;
  // -D required: git branch -d checks ref ancestry (fails after cherry-pick),
  // but we've already verified content equivalence via patch-id.
  const r = await spawnGitAsync(gitTop, ["branch", "-D", branch]);
  return r.ok;
}

/** Build the `git_cherry_pick` JSON payload from the already-assembled per-source reports. */
function buildGitCherryPickJson(opts: {
  allOk: boolean;
  into: string;
  headSha: string | undefined;
  appliedCount: number;
  pickedCount: number;
  perSourceReport: SourceReport[];
  perSourceKept: Map<string, string[]>;
  conflict: ConflictReport | undefined;
}): Record<string, unknown> {
  const {
    allOk,
    into,
    headSha,
    appliedCount,
    pickedCount,
    perSourceReport,
    perSourceKept,
    conflict,
  } = opts;
  return {
    ok: allOk,
    into,
    ...spreadDefined("headSha", headSha),
    applied: appliedCount,
    picked: pickedCount,
    results: perSourceReport.map((s) => ({
      source: s.raw,
      kind: s.kind,
      resolvedCommits: s.commits.length,
      keptCommits: perSourceKept.get(s.raw)?.length ?? 0,
      ...spreadWhen(s.branchDeleted === true, { branchDeleted: true }),
      ...spreadDefined("worktreeRemoved", s.worktreeRemoved),
    })),
    ...spreadWhen(conflict !== undefined, {
      conflict: {
        stage: conflict?.stage ?? "cherry-pick",
        ...spreadWhen(conflict?.paused === true, { paused: true }),
        ...spreadDefined("commit", conflict?.commit),
        conflicts: conflict?.conflicts ?? [],
        ...spreadDefined("detail", conflict?.detail),
        ...spreadDefined("error", conflict?.error),
        ...spreadWhen(conflict?.abortFailed === true, {
          abortFailed: true,
          ...spreadDefined("abortDetail", conflict?.abortDetail),
        }),
      },
    }),
    ...spreadWhen(conflict?.abortFailed === true, {
      error: ERROR_CODES.CHERRY_PICK_ABORT_FAILED,
      ...spreadDefined("abortDetail", conflict?.abortDetail),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitCherryPickTool(server: FastMCP): void {
  server.addTool({
    name: "git_cherry_pick",
    description:
      "Cherry-pick commits from one or more sources into a destination. Sources: SHAs, `A..B` ranges, " +
      "or branch names (expanded to `into..<branch>`, oldest-first). Already-reachable commits skipped. " +
      `Hard-capped at ${MAX_CHERRY_PICK_COMMITS} commits per call (after dedupe). ` +
      "Refuses on dirty tree or an in-progress cherry-pick; stops on first conflict. Optional flags " +
      "delete source branches/worktrees after success using patch-id equivalence (set " +
      "`strictMergedRefEquality: true` for strict ancestry) — automatically falls back to strict " +
      "ancestry when a source branch's own history includes merge commits patch-id can't verify. " +
      "Protected names always skipped.",
    annotations: {
      title: "Git Cherry-Pick",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      sources: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Sources: SHA, `A..B` range, or branch name (resolves to `into..<branch>`)."),
      into: z
        .string()
        .optional()
        .describe("Destination branch. Defaults to the currently checked-out branch."),
      deleteMergedBranches: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Delete branch-kind sources locally after success. Protected names and remote refs unaffected.",
        ),
      deleteMergedWorktrees: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Remove local worktrees on branch-kind sources after success. Protected names and path tails skipped.",
        ),
      strictMergedRefEquality: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "false (default): delete branch when every commit is content-equivalent on destination (patch-id, normal cherry-pick outcome). " +
            "true: require strict ref ancestry (`git branch -d` semantics — will refuse after cherry-pick due to SHA mismatch).",
        ),
      onConflict: z
        .enum(["abort", "pause"])
        .optional()
        .default("abort")
        .describe(
          "`abort` (default): on conflict, run `cherry-pick --abort` and roll back the whole range " +
            "(unchanged behavior). `pause`: on conflict, leave the conflict and native cherry-pick " +
            "sequencer state in place — commits already applied stay applied — so it can be resolved " +
            "and resumed via `git_cherry_pick_continue`.",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      // --- Guard: refuse when a cherry-pick is already in progress (native sequencer state,
      // read live off CHERRY_PICK_HEAD — this server is stateless per call). Checked before the
      // dirty-tree refusal below so callers get a specific, actionable error instead of the
      // generic working_tree_dirty. ---
      const alreadyInProgress = await cherryPickHead(gitTop);
      if (alreadyInProgress) {
        return jsonRespond({
          error: ERROR_CODES.CHERRY_PICK_IN_PROGRESS,
          commit: alreadyInProgress,
        });
      }

      const onConflict = args.onConflict ?? "abort";

      // --- Resolve destination ---
      const startBranch = await getCurrentBranch(gitTop);
      const into = args.into?.trim() || startBranch;
      if (!into) return jsonRespond({ error: ERROR_CODES.INTO_DETACHED_HEAD });
      if (args.into !== undefined && !isSafeGitRefToken(args.into)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.into });
      }

      // --- Refuse dirty tree ---
      if (!(await isWorkingTreeClean(gitTop))) {
        return jsonRespond({ error: ERROR_CODES.WORKING_TREE_DIRTY });
      }

      // --- Ensure destination is checked out ---
      if (into !== startBranch) {
        const co = await spawnGitAsync(gitTop, ["checkout", into]);
        if (!co.ok) {
          return jsonRespond({
            error: ERROR_CODES.CHECKOUT_FAILED,
            detail: gitFailureDetail(co),
          });
        }
      }

      if (!(await resolveRef(gitTop, into))) {
        return jsonRespond({ error: ERROR_CODES.DESTINATION_NOT_FOUND, ref: into });
      }

      // --- Resolve each source ---
      const resolved: ResolvedSource[] = [];
      for (const raw of args.sources) {
        const r = await resolveSource(gitTop, into, raw);
        if ("error" in r) {
          return jsonRespond({
            error: r.error,
            source: raw,
            ...spreadDefined("detail", r.detail),
          });
        }
        resolved.push(r);
      }

      // --- Cap check BEFORE dedupe: filterAndDedupe spawns one `merge-base
      // --is-ancestor` subprocess per unique resolved commit, so the cap must be
      // enforced on the raw (pre-dedupe) count here — otherwise a huge range/branch
      // source can force an unbounded number of sequential subprocess spawns before
      // the cap is ever checked. ---
      const rawUniqueCount = countUniqueCommits(resolved);
      if (rawUniqueCount > MAX_CHERRY_PICK_COMMITS) {
        return jsonRespond({
          error: ERROR_CODES.CHERRY_PICK_TOO_MANY_COMMITS,
          picked: rawUniqueCount,
          max: MAX_CHERRY_PICK_COMMITS,
        });
      }

      // --- Dedupe + skip already-present ---
      const { picks, perSourceKept } = await filterAndDedupe(gitTop, into, resolved);

      // --- Apply cherry-pick (single atomic call) ---
      // `--empty=drop` silently drops commits that would produce no change against the
      // current tip — makes the tool idempotent when the same patch is re-applied.
      let conflict: ConflictReport | undefined;
      let appliedCount = 0;
      const preHeadProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const preHead = preHeadProbe.ok ? preHeadProbe.stdout.trim() : "";
      if (picks.length > 0) {
        const r = await spawnGitAsync(gitTop, ["cherry-pick", "--empty=drop", ...picks]);
        if (!r.ok) {
          const failedSha = await cherryPickHead(gitTop);
          const conflicts = await conflictPaths(gitTop);
          if (onConflict === "pause") {
            // Leave the conflict + native sequencer state in place. Commits already
            // applied before the conflicting one stay applied — compute that count
            // cheaply from the HEAD advance so far (resumable via git_cherry_pick_continue).
            const adv = await spawnGitAsync(gitTop, ["rev-list", "--count", `${preHead}..HEAD`]);
            appliedCount = adv.ok ? parseInt(adv.stdout.trim(), 10) || 0 : 0;
            conflict = {
              stage: "cherry-pick",
              paused: true,
              ...spreadDefined("commit", failedSha),
              conflicts,
              detail: gitFailureDetail(r),
              error: ERROR_CODES.CHERRY_PICK_CONFLICTS,
            };
          } else {
            const abort = await abortCherryPick(gitTop);
            conflict = {
              stage: "cherry-pick",
              ...spreadDefined("commit", failedSha),
              conflicts,
              detail: gitFailureDetail(r),
              error: abort.ok
                ? ERROR_CODES.CHERRY_PICK_CONFLICTS
                : ERROR_CODES.CHERRY_PICK_ABORT_FAILED,
              ...spreadWhen(!abort.ok, {
                abortFailed: true,
                ...spreadDefined("abortDetail", abort.detail),
              }),
            };
          }
        } else {
          // Actual commits written = HEAD advance count (empty-drop may skip some).
          const adv = await spawnGitAsync(gitTop, ["rev-list", "--count", `${preHead}..HEAD`]);
          appliedCount = adv.ok ? parseInt(adv.stdout.trim(), 10) || 0 : 0;
        }
      }

      const allOk = !conflict;

      // --- Cleanup (only on full success, only branch-kind sources) ---
      const perSourceReport: SourceReport[] = resolved.map((s) => ({ ...s }));
      if (allOk) {
        for (let i = 0; i < perSourceReport.length; i++) {
          const src = perSourceReport[i];
          if (src?.kind !== "branch") continue;
          if (isProtectedBranch(src.raw)) continue;

          if (args.deleteMergedWorktrees) {
            const path = await worktreeForBranch(gitTop, src.raw);
            if (path) {
              const tail = basename(path);
              if (!isProtectedBranch(tail)) {
                const r = await spawnGitAsync(gitTop, ["worktree", "remove", path]);
                if (r.ok) src.worktreeRemoved = path;
              }
            }
          }

          if (args.deleteMergedBranches) {
            const deleted = await maybeDeleteCherryPickedBranch(
              gitTop,
              src.raw,
              into,
              args.strictMergedRefEquality ?? false,
            );
            if (deleted) src.branchDeleted = true;
          }
        }
      }

      const headProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const headSha = headProbe.ok ? headProbe.stdout.trim() : undefined;

      return jsonRespond(
        buildGitCherryPickJson({
          allOk,
          into,
          headSha,
          appliedCount,
          pickedCount: picks.length,
          perSourceReport,
          perSourceKept,
          conflict,
        }),
      );
    },
  });
}

// ---------------------------------------------------------------------------
// git_cherry_pick_continue — resume or abort a cherry-pick left in progress
// ---------------------------------------------------------------------------

interface ContinueConflictReport {
  stage: "cherry-pick";
  paused: true;
  commit?: string;
  conflicts: string[];
  detail?: string;
}

/** Build the `git_cherry_pick_continue` JSON payload for the resumable-conflict case. */
function buildGitCherryPickContinueConflictJson(
  applied: number,
  conflict: ContinueConflictReport,
): Record<string, unknown> {
  return { ok: false, action: "continue", applied, conflict };
}

/** Build the `git_cherry_pick_continue` success JSON payload (`action: "continue"`). */
function buildGitCherryPickContinueJson(
  applied: number,
  headSha: string | undefined,
): Record<string, unknown> {
  return { ok: true, action: "continue", applied, ...spreadDefined("headSha", headSha) };
}

export function registerGitCherryPickContinueTool(server: FastMCP): void {
  server.addTool({
    name: "git_cherry_pick_continue",
    description:
      "Resume or abort a cherry-pick left in progress (typically by `git_cherry_pick`'s " +
      '`onConflict: "pause"`). Stateless — reads `CHERRY_PICK_HEAD` directly, so it works ' +
      "regardless of how the pause happened. " +
      '`action: "continue"` (default) requires all conflicted paths staged (else ' +
      "`cherry_pick_unresolved_paths`), then runs `cherry-pick --continue`, committing the " +
      "resolved pick and resuming any remaining picks in the range. A later conflict reports " +
      "`conflict.paused: true` the same as `git_cherry_pick`, so call again to keep walking. " +
      '`action: "abort"` rolls back the whole in-progress cherry-pick via `cherry-pick --abort`.',
    annotations: {
      title: "Git Cherry-Pick Continue",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      action: z
        .enum(["continue", "abort"])
        .optional()
        .default("continue")
        .describe(
          '"continue" (default): resolve conflicts, stage them, then resume the sequencer. ' +
            '"abort": roll back to the pre-cherry-pick HEAD.',
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;
      const action = args.action ?? "continue";

      const inProgressSha = await cherryPickHead(gitTop);
      if (!inProgressSha) {
        return jsonRespond({ error: ERROR_CODES.NO_CHERRY_PICK_IN_PROGRESS });
      }

      const preHeadProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const preHead = preHeadProbe.ok ? preHeadProbe.stdout.trim() : "";

      // --- abort: reuse the same hardened abort helper/reporting as git_cherry_pick ---
      if (action === "abort") {
        const abort = await abortCherryPick(gitTop);
        if (!abort.ok) {
          return jsonRespond({
            ok: false,
            action: "abort",
            error: ERROR_CODES.CHERRY_PICK_ABORT_FAILED,
            ...spreadDefined("abortDetail", abort.detail),
          });
        }
        const headProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
        const headSha = headProbe.ok ? headProbe.stdout.trim() : undefined;
        return jsonRespond({ ok: true, action: "abort", ...spreadDefined("headSha", headSha) });
      }

      // --- continue: precheck no unmerged paths remain ---
      const unmerged = await conflictPaths(gitTop);
      if (unmerged.length > 0) {
        return jsonRespond({
          error: ERROR_CODES.CHERRY_PICK_UNRESOLVED_PATHS,
          paths: unmerged,
        });
      }

      // `-c core.editor=true` avoids launching an interactive editor for the reused commit message.
      const r = await spawnGitAsync(gitTop, [
        "-c",
        "core.editor=true",
        "cherry-pick",
        "--continue",
      ]);

      if (!r.ok) {
        const failedSha = await cherryPickHead(gitTop);
        const conflicts = failedSha ? await conflictPaths(gitTop) : [];
        if (failedSha && conflicts.length > 0) {
          // A later commit in the same range conflicted — report it the same shape as a
          // paused git_cherry_pick call so the caller can loop this tool to resolution.
          const adv = await spawnGitAsync(gitTop, ["rev-list", "--count", `${preHead}..HEAD`]);
          const applied = adv.ok ? parseInt(adv.stdout.trim(), 10) || 0 : 0;
          const conflict: ContinueConflictReport = {
            stage: "cherry-pick",
            paused: true,
            ...spreadDefined("commit", failedSha),
            conflicts,
            ...spreadDefined("detail", gitFailureDetail(r) || undefined),
          };
          return jsonRespond(buildGitCherryPickContinueConflictJson(applied, conflict));
        }
        // Not a new conflict (e.g. the resolved pick would produce an empty commit) —
        // surface a generic, non-resumable-loop error with whatever detail git gave.
        return jsonRespond({
          error: ERROR_CODES.CHERRY_PICK_CONTINUE_FAILED,
          ...spreadDefined("commit", failedSha),
          detail: gitFailureDetail(r),
        });
      }

      // --- success: sequencer completed the resolved pick and any remaining ones ---
      const adv = await spawnGitAsync(gitTop, ["rev-list", "--count", `${preHead}..HEAD`]);
      const applied = adv.ok ? parseInt(adv.stdout.trim(), 10) || 0 : 0;
      const headProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const headSha = headProbe.ok ? headProbe.stdout.trim() : undefined;

      return jsonRespond(buildGitCherryPickContinueJson(applied, headSha));
    },
  });
}
