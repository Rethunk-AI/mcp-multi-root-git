import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
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
  paths: string[];
  detail?: string;
  /** `onConflict: "pause"` left the conflict + sequencer state in place instead of aborting. */
  paused?: boolean;
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
  const detail = (r.stderr || r.stdout).trim();
  return detail === "" ? { ok: false } : { ok: false, detail };
}

async function branchExists(gitTop: string, name: string): Promise<boolean> {
  const r = await spawnGitAsync(gitTop, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
  return r.ok;
}

/**
 * Expand a source spec into a list of SHAs to cherry-pick.
 * - `A..B` / `A...B` → `git rev-list --reverse` of the range
 * - branch name (refs/heads/<name> exists) → `onto..<branch>` oldest-first
 * - SHA or ref → single commit
 */
async function resolveSource(
  gitTop: string,
  onto: string,
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
        detail: (r.stderr || r.stdout).trim(),
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
    const commits = await commitListBetween(gitTop, onto, raw);
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
 * Pre-filter already-in-destination commits (they would cherry-pick to empty).
 * Also dedupe across sources while preserving first-seen order per-commit.
 */
async function filterAndDedupe(
  gitTop: string,
  onto: string,
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
      const contained = await spawnGitAsync(gitTop, ["merge-base", "--is-ancestor", sha, onto]);
      if (contained.ok) continue; // already in destination
      picks.push(sha);
      kept.push(sha);
    }
    perSourceKept.set(src.raw, kept);
  }
  return { picks, perSourceKept };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitCherryPickTool(server: FastMCP): void {
  server.addTool({
    name: "git_cherry_pick",
    description:
      "Cherry-pick commits from one or more sources onto a destination. Sources: SHAs, `A..B` ranges, " +
      "or branch names (expanded to `onto..<branch>`, oldest-first). Already-reachable commits skipped. " +
      `Hard-capped at ${MAX_CHERRY_PICK_COMMITS} commits per call (after dedupe). ` +
      "Refuses on dirty tree; stops on first conflict. Optional flags delete source branches/worktrees " +
      "after success using patch-id equivalence (set `strictMergedRefEquality: true` for strict ancestry). " +
      "Protected names always skipped.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      sources: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Sources: SHA, `A..B` range, or branch name (resolves to `onto..<branch>`)."),
      onto: z
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
      const onto = args.onto?.trim() || startBranch;
      if (!onto) return jsonRespond({ error: ERROR_CODES.ONTO_DETACHED_HEAD });
      if (args.onto !== undefined && !isSafeGitRefToken(args.onto)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.onto });
      }

      // --- Refuse dirty tree ---
      if (!(await isWorkingTreeClean(gitTop))) {
        return jsonRespond({ error: ERROR_CODES.WORKING_TREE_DIRTY });
      }

      // --- Ensure destination is checked out ---
      if (onto !== startBranch) {
        const co = await spawnGitAsync(gitTop, ["checkout", onto]);
        if (!co.ok) {
          return jsonRespond({
            error: ERROR_CODES.CHECKOUT_FAILED,
            detail: (co.stderr || co.stdout).trim(),
          });
        }
      }

      if (!(await resolveRef(gitTop, onto))) {
        return jsonRespond({ error: ERROR_CODES.DESTINATION_NOT_FOUND, ref: onto });
      }

      // --- Resolve each source ---
      const resolved: ResolvedSource[] = [];
      for (const raw of args.sources) {
        const r = await resolveSource(gitTop, onto, raw);
        if ("error" in r) {
          return jsonRespond({
            error: r.error,
            source: raw,
            ...spreadDefined("detail", r.detail),
          });
        }
        resolved.push(r);
      }

      // --- Dedupe + skip already-present ---
      const { picks, perSourceKept } = await filterAndDedupe(gitTop, onto, resolved);

      if (picks.length > MAX_CHERRY_PICK_COMMITS) {
        return jsonRespond({
          error: ERROR_CODES.CHERRY_PICK_TOO_MANY_COMMITS,
          picked: picks.length,
          max: MAX_CHERRY_PICK_COMMITS,
        });
      }

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
          const paths = await conflictPaths(gitTop);
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
              paths,
              detail: (r.stderr || r.stdout).trim(),
            };
          } else {
            const abort = await abortCherryPick(gitTop);
            conflict = {
              stage: "cherry-pick",
              ...spreadDefined("commit", failedSha),
              paths,
              detail: (r.stderr || r.stdout).trim(),
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
              const tail = path.split("/").pop() ?? "";
              if (!isProtectedBranch(tail)) {
                const r = await spawnGitAsync(gitTop, ["worktree", "remove", path]);
                if (r.ok) src.worktreeRemoved = path;
              }
            }
          }

          if (args.deleteMergedBranches) {
            if (args.strictMergedRefEquality) {
              const merged = await isFullyMergedInto(gitTop, src.raw, onto);
              if (merged) {
                const r = await spawnGitAsync(gitTop, ["branch", "-d", src.raw]);
                if (r.ok) src.branchDeleted = true;
              }
            } else {
              const merged = await isContentEquivalentlyMergedInto(gitTop, src.raw, onto);
              if (merged) {
                // -D required: git branch -d checks ref ancestry (fails after cherry-pick),
                // but we've already verified content equivalence via patch-id.
                const r = await spawnGitAsync(gitTop, ["branch", "-D", src.raw]);
                if (r.ok) src.branchDeleted = true;
              }
            }
          }
        }
      }

      const headProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const headSha = headProbe.ok ? headProbe.stdout.trim() : undefined;

      if (args.format === "json") {
        return jsonRespond({
          ok: allOk,
          onto,
          ...spreadDefined("headSha", headSha),
          applied: appliedCount,
          picked: picks.length,
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
              paths: conflict?.paths ?? [],
              ...spreadDefined("detail", conflict?.detail),
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
        });
      }

      // --- Markdown ---
      const lines: string[] = [];
      const header = allOk
        ? `# Cherry-pick onto \`${onto}\`: ${appliedCount} commit(s) applied`
        : conflict?.paused
          ? `# Cherry-pick onto \`${onto}\`: paused on conflict after ${appliedCount} commit(s)`
          : `# Cherry-pick onto \`${onto}\`: stopped on conflict after ${appliedCount} commit(s)`;
      lines.push(header, "");

      for (const s of perSourceReport) {
        const kept = perSourceKept.get(s.raw)?.length ?? 0;
        const tail: string[] = [`${s.kind}`, `${kept}/${s.commits.length} picked`];
        if (s.branchDeleted) tail.push("branch deleted");
        if (s.worktreeRemoved) tail.push(`worktree removed: ${s.worktreeRemoved}`);
        lines.push(`- ${s.raw}  —  ${tail.join(", ")}`);
      }

      if (conflict) {
        lines.push("", `Conflict at commit \`${conflict.commit ?? "?"}\` (${conflict.stage}):`);
        for (const p of conflict.paths) lines.push(`  conflict: ${p}`);
        if (conflict.detail) lines.push(`  detail: ${conflict.detail}`);
        if (conflict.paused) {
          lines.push(
            "  Paused: cherry-pick left in progress. Resolve the conflict, then call `git_cherry_pick_continue`.",
          );
        }
        if (conflict.abortFailed) {
          lines.push(
            `  Error: ${ERROR_CODES.CHERRY_PICK_ABORT_FAILED}${conflict.abortDetail ? ` — ${conflict.abortDetail}` : ""}`,
          );
        }
      }

      return lines.join("\n");
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
  paths: string[];
  detail?: string;
}

function renderCherryPickContinueMarkdown(
  action: "continue" | "abort",
  ok: boolean,
  applied: number,
  headSha: string | undefined,
  conflict?: ContinueConflictReport,
): string {
  if (action === "abort") {
    return ok
      ? `# Cherry-pick abort\nAborted. HEAD restored to \`${headSha ?? "?"}\`.`
      : "# Cherry-pick abort\nAbort failed — see error.";
  }
  if (conflict) {
    const lines = [
      `# Cherry-pick continue: paused on conflict after ${applied} commit(s)`,
      "",
      `Conflict at commit \`${conflict.commit ?? "?"}\` (${conflict.stage}):`,
    ];
    for (const p of conflict.paths) lines.push(`  conflict: ${p}`);
    if (conflict.detail) lines.push(`  detail: ${conflict.detail}`);
    lines.push(
      "  Paused: cherry-pick still in progress. Resolve the conflict, then call `git_cherry_pick_continue` again.",
    );
    return lines.join("\n");
  }
  return `# Cherry-pick continue: ${applied} commit(s) applied\nHEAD now \`${headSha ?? "?"}\`.`;
}

export function registerGitCherryPickContinueTool(server: FastMCP): void {
  server.addTool({
    name: "git_cherry_pick_continue",
    description:
      "Resume or abort a cherry-pick left in progress — typically by `git_cherry_pick`'s " +
      '`onConflict: "pause"`, but this tool is stateless and reads `CHERRY_PICK_HEAD` / the native ' +
      "sequencer live off `.git`, so it works regardless of how the in-progress state was left. " +
      '`action: "continue"` (default) requires every previously conflicted path to be staged (no ' +
      "remaining unmerged entries — `cherry_pick_unresolved_paths` otherwise), then runs " +
      "`git -c core.editor=true cherry-pick --continue` so git's sequencer both commits the resolved " +
      "pick and resumes through any remaining picks in the same range. If a *later* pick then " +
      "conflicts, the response reports it the same way as a paused `git_cherry_pick` call (`conflict." +
      'paused: true`) so this tool can be called again to keep walking the range. `action: "abort"` ' +
      "rolls back the whole in-progress cherry-pick via `git cherry-pick --abort`.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
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
        if (args.format === "json") {
          return jsonRespond({ ok: true, action: "abort", ...spreadDefined("headSha", headSha) });
        }
        return renderCherryPickContinueMarkdown("abort", true, 0, headSha);
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
        const paths = failedSha ? await conflictPaths(gitTop) : [];
        if (failedSha && paths.length > 0) {
          // A later commit in the same range conflicted — report it the same shape as a
          // paused git_cherry_pick call so the caller can loop this tool to resolution.
          const adv = await spawnGitAsync(gitTop, ["rev-list", "--count", `${preHead}..HEAD`]);
          const applied = adv.ok ? parseInt(adv.stdout.trim(), 10) || 0 : 0;
          const conflict: ContinueConflictReport = {
            stage: "cherry-pick",
            paused: true,
            ...spreadDefined("commit", failedSha),
            paths,
            ...spreadDefined("detail", (r.stderr || r.stdout).trim() || undefined),
          };
          if (args.format === "json") {
            return jsonRespond({ ok: false, action: "continue", applied, conflict });
          }
          return renderCherryPickContinueMarkdown("continue", false, applied, undefined, conflict);
        }
        // Not a new conflict (e.g. the resolved pick would produce an empty commit) —
        // surface a generic, non-resumable-loop error with whatever detail git gave.
        return jsonRespond({
          error: ERROR_CODES.CHERRY_PICK_CONTINUE_FAILED,
          ...spreadDefined("commit", failedSha),
          detail: (r.stderr || r.stdout).trim(),
        });
      }

      // --- success: sequencer completed the resolved pick and any remaining ones ---
      const adv = await spawnGitAsync(gitTop, ["rev-list", "--count", `${preHead}..HEAD`]);
      const applied = adv.ok ? parseInt(adv.stdout.trim(), 10) || 0 : 0;
      const headProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const headSha = headProbe.ok ? headProbe.stdout.trim() : undefined;

      if (args.format === "json") {
        return jsonRespond({
          ok: true,
          action: "continue",
          applied,
          ...spreadDefined("headSha", headSha),
        });
      }
      return renderCherryPickContinueMarkdown("continue", true, applied, headSha);
    },
  });
}
