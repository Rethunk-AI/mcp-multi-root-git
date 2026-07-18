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
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

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
