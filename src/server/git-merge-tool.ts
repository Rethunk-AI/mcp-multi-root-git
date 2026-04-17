import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { gitTopLevel, spawnGitAsync } from "./git.js";
import {
  getCurrentBranch,
  isFullyMergedInto,
  isProtectedBranch,
  isSafeGitRefToken,
  isWorkingTreeClean,
  resolveRef,
  worktreeForBranch,
} from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireGitAndRoots } from "./roots.js";
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
      "`merge`: always create a merge commit (no fast-forward).",
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
  skipReason?: string;
  error?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Conflict helpers
// ---------------------------------------------------------------------------

async function conflictPaths(gitTop: string): Promise<string[]> {
  const r = await spawnGitAsync(gitTop, ["diff", "--name-only", "--diff-filter=U"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function abortMerge(gitTop: string): Promise<void> {
  await spawnGitAsync(gitTop, ["merge", "--abort"]);
}

async function abortRebase(gitTop: string): Promise<void> {
  await spawnGitAsync(gitTop, ["rebase", "--abort"]);
}

// ---------------------------------------------------------------------------
// Per-source merge logic
// ---------------------------------------------------------------------------

/**
 * Attempt to land `source` on `into`. Caller must ensure `into` is checked out.
 * On conflict the repo state is cleaned (merge/rebase aborted, HEAD restored to `into`).
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
    return { source, ok: false, error: "source_not_found" };
  }
  if (!intoSha) {
    return { source, ok: false, error: "destination_not_found" };
  }

  const mb = await spawnGitAsync(gitTop, ["merge-base", into, source]);
  if (!mb.ok) {
    return {
      source,
      ok: false,
      error: "merge_base_failed",
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
        error: "cannot_fast_forward",
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
    await abortMerge(gitTop);
    return {
      source,
      ok: false,
      outcome: "conflicts",
      conflictStage: "merge",
      conflictPaths: [],
      error: "merge_failed",
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
    await abortMerge(gitTop);
    return {
      source,
      ok: false,
      outcome: "conflicts",
      conflictStage: "merge",
      conflictPaths: paths,
      error: "merge_conflicts",
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
    await abortRebase(gitTop);
    // Ensure we're back on `into` regardless of rebase state.
    await spawnGitAsync(gitTop, ["checkout", into]);
    return {
      source,
      ok: false,
      outcome: "conflicts",
      conflictStage: "rebase",
      conflictPaths: paths,
      error: "rebase_conflicts",
      detail: (r.stderr || r.stdout).trim(),
    };
  }
  // Rebase succeeded; switch back to destination so the caller can FF.
  const co = await spawnGitAsync(gitTop, ["checkout", into]);
  if (!co.ok) {
    return {
      source,
      ok: false,
      error: "checkout_failed",
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
      "Merge one or more source branches into a destination. Default strategy `auto` " +
      "cascades fast-forward → rebase → merge-commit per source, preferring linear history. " +
      "Refuses if the working tree is dirty. Stops on the first conflict and reports " +
      "the affected paths. Optional flags auto-delete merged branches and worktrees, " +
      "skipping protected names (main, master, dev, develop, stable, trunk, prod, " +
      "production, release/*, hotfix/*). See docs/mcp-tools.md.",
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
          "After all sources merge cleanly, delete each source branch locally (`git branch -d`). " +
            "Protected names (main, master, dev, develop, stable, trunk, prod, production, " +
            "release/*, hotfix/*) are always skipped. Never affects remote branches.",
        ),
      deleteMergedWorktrees: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "After all sources merge cleanly, remove any local worktree currently checked out " +
            "on a source branch (`git worktree remove`). Protected tails always skipped.",
        ),
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) return jsonRespond(pre.error);

      const rootInput = pre.roots[0];
      if (!rootInput) return jsonRespond({ error: "no_workspace_root" });

      const gitTop = gitTopLevel(rootInput);
      if (!gitTop) return jsonRespond({ error: "not_a_git_repository", path: rootInput });

      // --- Validate ref tokens early ---
      for (const s of args.sources) {
        if (!isSafeGitRefToken(s)) {
          return jsonRespond({ error: "unsafe_ref_token", ref: s });
        }
      }
      if (args.into !== undefined && !isSafeGitRefToken(args.into)) {
        return jsonRespond({ error: "unsafe_ref_token", ref: args.into });
      }

      // --- Resolve destination ---
      const startBranch = await getCurrentBranch(gitTop);
      const into = args.into?.trim() || startBranch;
      if (!into) {
        return jsonRespond({ error: "into_detached_head" });
      }

      // --- Refuse dirty tree ---
      if (!(await isWorkingTreeClean(gitTop))) {
        return jsonRespond({ error: "working_tree_dirty" });
      }

      // --- Ensure destination is checked out ---
      if (into !== startBranch) {
        const co = await spawnGitAsync(gitTop, ["checkout", into]);
        if (!co.ok) {
          return jsonRespond({
            error: "checkout_failed",
            detail: (co.stderr || co.stdout).trim(),
          });
        }
      }

      // Verify destination exists after checkout.
      const intoShaProbe = await resolveRef(gitTop, into);
      if (!intoShaProbe) {
        return jsonRespond({ error: "destination_not_found", ref: into });
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
            ...spreadDefined("skipReason", r.skipReason),
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
