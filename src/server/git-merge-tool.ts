import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import {
  conflictPaths,
  getCurrentBranch,
  isFullyMergedInto,
  isProtectedBranch,
  isSafeGitRefToken,
  isWorkingTreeClean,
  resolveRef,
  worktreeForBranch,
} from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const StrategySchema = z
  .enum(["auto", "ff-only", "rebase", "merge"])
  .optional()
  .default("auto")
  .describe(
    "`auto` (default): cascade fast-forward → rebase → merge-commit per source. " +
      "`ff-only`: only fast-forward, fail if diverged. " +
      "`rebase`: rebase source onto destination, then fast-forward (no merge-commit fallback). " +
      "`merge`: always create a merge commit (no fast-forward). " +
      "Note: `auto`/`rebase` rewrite the source branch tip in place when rebasing (new SHAs).",
  );

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceOutcome =
  | "up_to_date"
  | "fast_forward"
  | "rebase_then_ff"
  | "merge_commit"
  | "conflicts";

interface SourceResult {
  source: string;
  ok: boolean;
  outcome?: SourceOutcome;
  mergedSha?: string;
  conflictStage?: "rebase" | "merge";
  conflictPaths?: string[];
  branchDeleted?: boolean;
  worktreeRemoved?: string;
  error?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Abort helpers
// ---------------------------------------------------------------------------

/** Result of `git merge --abort` — callers must check `ok` before claiming a clean abort. */
export async function abortMerge(gitTop: string): Promise<{ ok: boolean; detail?: string }> {
  const r = await spawnGitAsync(gitTop, ["merge", "--abort"]);
  if (r.ok) return { ok: true };
  const detail = (r.stderr || r.stdout).trim();
  return detail === "" ? { ok: false } : { ok: false, detail };
}

/** Result of `git rebase --abort` — callers must check `ok` before claiming a clean abort. */
export async function abortRebase(gitTop: string): Promise<{ ok: boolean; detail?: string }> {
  const r = await spawnGitAsync(gitTop, ["rebase", "--abort"]);
  if (r.ok) return { ok: true };
  const detail = (r.stderr || r.stdout).trim();
  return detail === "" ? { ok: false } : { ok: false, detail };
}

async function mergeInProgress(gitTop: string): Promise<boolean> {
  const r = await spawnGitAsync(gitTop, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  return r.ok;
}

// ---------------------------------------------------------------------------
// Per-source merge logic
// ---------------------------------------------------------------------------

/**
 * Attempt to land `source` on `into`. Caller must ensure `into` is checked out.
 * On conflict the repo is aborted when possible; if `--abort` itself fails the
 * result carries `merge_abort_failed` / `rebase_abort_failed` and the tree may
 * still be mid-merge/rebase.
 */
async function mergeOneSource(
  gitTop: string,
  into: string,
  source: string,
  strategy: "auto" | "ff-only" | "rebase" | "merge",
  mergeMessage: string | undefined,
): Promise<SourceResult> {
  // --- Classify state via merge-base ---
  const intoSha = await resolveRef(gitTop, into);
  const sourceSha = await resolveRef(gitTop, source);
  if (!sourceSha) {
    return { source, ok: false, error: ERROR_CODES.SOURCE_NOT_FOUND };
  }
  if (!intoSha) {
    return { source, ok: false, error: ERROR_CODES.DESTINATION_NOT_FOUND };
  }

  const mb = await spawnGitAsync(gitTop, ["merge-base", into, source]);
  if (!mb.ok) {
    return {
      source,
      ok: false,
      error: ERROR_CODES.MERGE_BASE_FAILED,
      detail: (mb.stderr || mb.stdout).trim(),
    };
  }
  const mergeBase = mb.stdout.trim();

  // source fully contained in into → noop
  if (mergeBase === sourceSha) {
    return { source, ok: true, outcome: "up_to_date", mergedSha: intoSha };
  }

  // into fully contained in source → fast-forward is the right move
  const canFastForward = mergeBase === intoSha;

  // --- ff-only strategy ---
  if (strategy === "ff-only") {
    if (!canFastForward) {
      return {
        source,
        ok: false,
        error: ERROR_CODES.CANNOT_FAST_FORWARD,
        detail: "destination and source have diverged; retry with strategy: rebase, merge, or auto",
      };
    }
    return fastForward(gitTop, source);
  }

  // --- Fast-forward path for auto/rebase when applicable ---
  if (canFastForward && (strategy === "auto" || strategy === "rebase")) {
    return fastForward(gitTop, source);
  }

  // --- merge strategy: always merge commit ---
  if (strategy === "merge") {
    return mergeCommit(gitTop, source, mergeMessage, into);
  }

  // --- rebase or auto (diverged case) ---
  // Warning: rebaseSourceOntoInto rewrites the source branch tip in place.
  const rebased = await rebaseSourceOntoInto(gitTop, into, source);
  if (rebased.ok) {
    // Rebase succeeded; FF destination up to the now-rebased source tip.
    const ff = await fastForward(gitTop, source);
    if (!ff.ok) return ff;
    return { ...ff, outcome: "rebase_then_ff" };
  }

  if (strategy === "rebase") {
    return rebased; // caller opted out of merge-commit fallback
  }

  // auto: fall through to merge commit
  return mergeCommit(gitTop, source, mergeMessage, into);
}

async function fastForward(gitTop: string, source: string): Promise<SourceResult> {
  const r = await spawnGitAsync(gitTop, ["merge", "--ff-only", source]);
  if (!r.ok) {
    // ff-only refusal normally leaves no MERGE_HEAD — only abort when mid-merge.
    if (await mergeInProgress(gitTop)) {
      const abort = await abortMerge(gitTop);
      if (!abort.ok) {
        return {
          source,
          ok: false,
          outcome: "conflicts",
          conflictStage: "merge",
          conflictPaths: [],
          error: ERROR_CODES.MERGE_ABORT_FAILED,
          detail: abort.detail ?? (r.stderr || r.stdout).trim(),
        };
      }
    }
    return {
      source,
      ok: false,
      outcome: "conflicts",
      conflictStage: "merge",
      conflictPaths: [],
      error: ERROR_CODES.MERGE_FAILED,
      detail: (r.stderr || r.stdout).trim(),
    };
  }
  const head = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
  return {
    source,
    ok: true,
    outcome: "fast_forward",
    mergedSha: head.ok ? head.stdout.trim() : undefined,
  };
}

async function mergeCommit(
  gitTop: string,
  source: string,
  message: string | undefined,
  into: string,
): Promise<SourceResult> {
  const msg = message?.trim() || `Merge branch '${source}' into ${into}`;
  const r = await spawnGitAsync(gitTop, ["merge", "--no-ff", "--no-edit", "-m", msg, source]);
  if (!r.ok) {
    const paths = await conflictPaths(gitTop);
    const abort = await abortMerge(gitTop);
    if (!abort.ok) {
      return {
        source,
        ok: false,
        outcome: "conflicts",
        conflictStage: "merge",
        conflictPaths: paths,
        error: ERROR_CODES.MERGE_ABORT_FAILED,
        detail: abort.detail ?? (r.stderr || r.stdout).trim(),
      };
    }
    return {
      source,
      ok: false,
      outcome: "conflicts",
      conflictStage: "merge",
      conflictPaths: paths,
      error: ERROR_CODES.MERGE_CONFLICTS,
      detail: (r.stderr || r.stdout).trim(),
    };
  }
  const head = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
  return {
    source,
    ok: true,
    outcome: "merge_commit",
    mergedSha: head.ok ? head.stdout.trim() : undefined,
  };
}

/**
 * Rebase `source` onto `into`, then return to `into`.
 * On failure: abort rebase, check out `into` again, return structured conflict.
 * Successful rebase rewrites the source branch tip (new SHAs).
 */
async function rebaseSourceOntoInto(
  gitTop: string,
  into: string,
  source: string,
): Promise<SourceResult> {
  // `git rebase <upstream> <branch>` first switches to <branch>.
  const r = await spawnGitAsync(gitTop, ["rebase", into, source]);
  if (!r.ok) {
    const paths = await conflictPaths(gitTop);
    const abort = await abortRebase(gitTop);
    // Ensure we're back on `into` regardless of rebase state (best-effort).
    await spawnGitAsync(gitTop, ["checkout", into]);
    if (!abort.ok) {
      return {
        source,
        ok: false,
        outcome: "conflicts",
        conflictStage: "rebase",
        conflictPaths: paths,
        error: ERROR_CODES.REBASE_ABORT_FAILED,
        detail: abort.detail ?? (r.stderr || r.stdout).trim(),
      };
    }
    return {
      source,
      ok: false,
      outcome: "conflicts",
      conflictStage: "rebase",
      conflictPaths: paths,
      error: ERROR_CODES.REBASE_CONFLICTS,
      detail: (r.stderr || r.stdout).trim(),
    };
  }
  // Rebase succeeded; switch back to destination so the caller can FF.
  const co = await spawnGitAsync(gitTop, ["checkout", into]);
  if (!co.ok) {
    return {
      source,
      ok: false,
      error: ERROR_CODES.CHECKOUT_FAILED,
      detail: (co.stderr || co.stdout).trim(),
    };
  }
  return { source, ok: true }; // caller FFs
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function maybeRemoveWorktree(
  gitTop: string,
  source: string,
  enabled: boolean,
): Promise<string | undefined> {
  if (!enabled) return undefined;
  // Gate on the source branch name first (path basename may be an agent temp dir).
  if (isProtectedBranch(source)) return undefined;
  const path = await worktreeForBranch(gitTop, source);
  if (!path) return undefined;
  // Re-check protected names against the worktree path's trailing segment too.
  const tail = path.split("/").pop() ?? "";
  if (isProtectedBranch(tail)) return undefined;
  const r = await spawnGitAsync(gitTop, ["worktree", "remove", path]);
  return r.ok ? path : undefined;
}

async function maybeDeleteBranch(
  gitTop: string,
  source: string,
  enabled: boolean,
  into: string,
): Promise<boolean> {
  if (!enabled) return false;
  if (isProtectedBranch(source)) return false;
  // Safety double-check: source must be fully merged into destination.
  const merged = await isFullyMergedInto(gitTop, source, into);
  if (!merged) return false;
  const r = await spawnGitAsync(gitTop, ["branch", "-d", source]);
  return r.ok;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitMergeTool(server: FastMCP): void {
  server.addTool({
    name: "git_merge",
    description:
      "Merge one or more source branches into a destination. `auto` cascades " +
      "fast-forward → rebase → merge-commit, preferring linear history. " +
      "`auto`/`rebase` rewrite the source branch tip in place when rebasing (new SHAs), not only the destination. " +
      "Refuses on dirty tree; stops on first conflict. Optional flags delete merged branches/worktrees " +
      "(protected names skipped: main, master, dev, develop, stable, trunk, prod, production, release/*, hotfix/*).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      sources: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe("Branches to merge into the destination, in order."),
      into: z
        .string()
        .optional()
        .describe("Destination branch. Defaults to the currently checked-out branch."),
      strategy: StrategySchema,
      message: z
        .string()
        .optional()
        .describe("Merge commit message (used only when a merge commit is created)."),
      deleteMergedBranches: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Delete each source branch locally after clean merge (`git branch -d`). Protected names and remote refs unaffected.",
        ),
      deleteMergedWorktrees: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Remove local worktrees on source branches after clean merge (`git worktree remove`). Protected source names and path tails skipped.",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      // --- Validate ref tokens early ---
      for (const s of args.sources) {
        if (!isSafeGitRefToken(s)) {
          return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: s });
        }
      }
      if (args.into !== undefined && !isSafeGitRefToken(args.into)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.into });
      }

      // --- Resolve destination ---
      const startBranch = await getCurrentBranch(gitTop);
      const into = args.into?.trim() || startBranch;
      if (!into) {
        return jsonRespond({ error: ERROR_CODES.INTO_DETACHED_HEAD });
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
            detail: (co.stderr || co.stdout).trim(),
          });
        }
      }

      // Verify destination exists after checkout.
      const intoShaProbe = await resolveRef(gitTop, into);
      if (!intoShaProbe) {
        return jsonRespond({ error: ERROR_CODES.DESTINATION_NOT_FOUND, ref: into });
      }

      // --- Merge each source sequentially ---
      const strategy = args.strategy ?? "auto";
      const results: SourceResult[] = [];
      let firstConflict = false;
      for (const source of args.sources) {
        const r = await mergeOneSource(gitTop, into, source, strategy, args.message);
        results.push(r);
        if (!r.ok) {
          firstConflict = true;
          break;
        }
      }

      const allOk = !firstConflict && results.every((r) => r.ok);

      // --- Cleanup (only on full success) ---
      if (allOk) {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (!r || r.outcome === "up_to_date") continue;
          const worktreeRemoved = await maybeRemoveWorktree(
            gitTop,
            r.source,
            args.deleteMergedWorktrees ?? false,
          );
          const branchDeleted = await maybeDeleteBranch(
            gitTop,
            r.source,
            args.deleteMergedBranches ?? false,
            into,
          );
          results[i] = {
            ...r,
            ...spreadDefined("worktreeRemoved", worktreeRemoved),
            ...spreadWhen(branchDeleted, { branchDeleted: true }),
          };
        }
      }

      const headProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const headSha = headProbe.ok ? headProbe.stdout.trim() : undefined;

      if (args.format === "json") {
        return jsonRespond({
          ok: allOk,
          into,
          strategy,
          ...spreadDefined("headSha", headSha),
          applied: results.filter((r) => r.ok).length,
          total: args.sources.length,
          results: results.map((r) => ({
            source: r.source,
            ok: r.ok,
            ...spreadDefined("outcome", r.outcome),
            ...spreadDefined("mergedSha", r.mergedSha),
            ...spreadDefined("conflictStage", r.conflictStage),
            ...spreadWhen((r.conflictPaths?.length ?? 0) > 0, {
              conflictPaths: r.conflictPaths,
            }),
            ...spreadWhen(r.branchDeleted === true, { branchDeleted: true }),
            ...spreadDefined("worktreeRemoved", r.worktreeRemoved),
            ...spreadDefined("error", r.error),
            ...spreadDefined("detail", r.detail),
          })),
        });
      }

      // --- Markdown ---
      const lines: string[] = [];
      const applied = results.filter((r) => r.ok).length;
      const header = allOk
        ? `# Merge into \`${into}\`: ${applied}/${args.sources.length} sources applied`
        : `# Merge into \`${into}\`: ${applied}/${args.sources.length} sources applied (stopped on conflict)`;
      lines.push(header, "");

      for (const r of results) {
        const icon = r.ok ? "✓" : "✗";
        const tail: string[] = [];
        if (r.outcome) tail.push(r.outcome);
        if (r.mergedSha) tail.push(`\`${r.mergedSha.slice(0, 7)}\``);
        if (r.branchDeleted) tail.push("branch deleted");
        if (r.worktreeRemoved) tail.push(`worktree removed: ${r.worktreeRemoved}`);
        lines.push(`${icon} ${r.source}${tail.length ? `  —  ${tail.join(", ")}` : ""}`);
        if (!r.ok) {
          if (r.conflictPaths?.length) {
            for (const p of r.conflictPaths) lines.push(`  conflict: ${p}`);
          }
          if (r.error) lines.push(`  Error: ${r.error}${r.detail ? ` — ${r.detail}` : ""}`);
        }
      }

      if (!allOk) {
        const skipped = args.sources.length - results.length;
        if (skipped > 0) lines.push("", `${skipped} remaining source(s) skipped.`);
      }

      return lines.join("\n");
    },
  });
}
