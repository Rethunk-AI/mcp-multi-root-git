import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { gitTopLevel, spawnGitAsync } from "./git.js";
import {
  commitListBetween,
  getCurrentBranch,
  isFullyMergedInto,
  isProtectedBranch,
  isSafeGitRangeToken,
  isSafeGitRefToken,
  isWorkingTreeClean,
  resolveRef,
  worktreeForBranch,
} from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireGitAndRoots } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function conflictPaths(gitTop: string): Promise<string[]> {
  const r = await spawnGitAsync(gitTop, ["diff", "--name-only", "--diff-filter=U"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function cherryPickHead(gitTop: string): Promise<string | undefined> {
  const r = await spawnGitAsync(gitTop, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]);
  if (!r.ok) return undefined;
  const sha = r.stdout.trim();
  return sha === "" ? undefined : sha;
}

async function abortCherryPick(gitTop: string): Promise<void> {
  await spawnGitAsync(gitTop, ["cherry-pick", "--abort"]);
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
      return { error: "unsafe_ref_token", raw };
    }
    const r = await spawnGitAsync(gitTop, ["rev-list", "--reverse", raw]);
    if (!r.ok) {
      return {
        error: "range_resolution_failed",
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
    return { error: "unsafe_ref_token", raw };
  }

  if (await branchExists(gitTop, raw)) {
    const commits = await commitListBetween(gitTop, onto, raw);
    if (commits === null) {
      return { error: "range_resolution_failed", raw };
    }
    return { raw, kind: "branch", commits };
  }

  const sha = await resolveRef(gitTop, raw);
  if (!sha) {
    return { error: "source_not_found", raw };
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
      "Play commits from one or more sources onto a destination. Sources may be SHAs, " +
      "`A..B` ranges, or branch names (expanded to `onto..<branch>`, oldest-first). " +
      "Commits already reachable from the destination are skipped. Refuses on dirty tree; " +
      "stops on the first conflict and reports paths. Optional flags auto-delete fully " +
      "merged source branches and their worktrees, skipping protected names. See docs/mcp-tools.md.",
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
        .describe(
          "Sources to cherry-pick: SHA, `A..B` range, or branch name. Branch sources " +
            "resolve to `onto..<branch>` (only commits missing from destination).",
        ),
      onto: z
        .string()
        .optional()
        .describe("Destination branch. Defaults to the currently checked-out branch."),
      deleteMergedBranches: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "After all commits apply, delete each branch-kind source locally " +
            "(`git branch -d`) when it is fully merged into the destination. " +
            "Protected names always skipped; never touches remote refs.",
        ),
      deleteMergedWorktrees: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "After success, remove any local worktree attached to a branch-kind source " +
            "(`git worktree remove`). Protected tails always skipped.",
        ),
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) return jsonRespond(pre.error);

      const rootInput = pre.roots[0];
      if (!rootInput) return jsonRespond({ error: "no_workspace_root" });

      const gitTop = gitTopLevel(rootInput);
      if (!gitTop) return jsonRespond({ error: "not_a_git_repository", path: rootInput });

      // --- Resolve destination ---
      const startBranch = await getCurrentBranch(gitTop);
      const onto = args.onto?.trim() || startBranch;
      if (!onto) return jsonRespond({ error: "onto_detached_head" });
      if (args.onto !== undefined && !isSafeGitRefToken(args.onto)) {
        return jsonRespond({ error: "unsafe_ref_token", ref: args.onto });
      }

      // --- Refuse dirty tree ---
      if (!(await isWorkingTreeClean(gitTop))) {
        return jsonRespond({ error: "working_tree_dirty" });
      }

      // --- Ensure destination is checked out ---
      if (onto !== startBranch) {
        const co = await spawnGitAsync(gitTop, ["checkout", onto]);
        if (!co.ok) {
          return jsonRespond({
            error: "checkout_failed",
            detail: (co.stderr || co.stdout).trim(),
          });
        }
      }

      if (!(await resolveRef(gitTop, onto))) {
        return jsonRespond({ error: "destination_not_found", ref: onto });
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
          await abortCherryPick(gitTop);
          conflict = {
            stage: "cherry-pick",
            ...spreadDefined("commit", failedSha),
            paths,
            detail: (r.stderr || r.stdout).trim(),
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
          if (!src || src.kind !== "branch") continue;
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
            const merged = await isFullyMergedInto(gitTop, src.raw, onto);
            if (merged) {
              const r = await spawnGitAsync(gitTop, ["branch", "-d", src.raw]);
              if (r.ok) src.branchDeleted = true;
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
            },
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
      }

      return lines.join("\n");
    },
  });
}
