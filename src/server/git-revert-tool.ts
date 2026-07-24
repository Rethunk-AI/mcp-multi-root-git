import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { conflictPaths, isSafeGitAncestorRef, isWorkingTreeClean } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA of REVERT_HEAD (the commit currently mid-revert), or undefined once resolved/absent. */
export async function revertHead(gitTop: string): Promise<string | undefined> {
  const r = await spawnGitAsync(gitTop, ["rev-parse", "--verify", "--quiet", "REVERT_HEAD"]);
  if (!r.ok) return undefined;
  const sha = r.stdout.trim();
  return sha === "" ? undefined : sha;
}

/** Result of attempting `git revert --abort` — callers must check `ok` before claiming a clean abort. */
export async function abortRevert(gitTop: string): Promise<{ ok: boolean; detail?: string }> {
  const r = await spawnGitAsync(gitTop, ["revert", "--abort"]);
  if (r.ok) return { ok: true };
  const detail = (r.stderr || r.stdout).trim();
  return detail === "" ? { ok: false } : { ok: false, detail };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitRevertTool(server: FastMCP): void {
  server.addTool({
    name: "git_revert",
    description:
      "`git revert`: creates new commit(s) that undo the changes introduced by one or more source " +
      "commits. Unlike `git_reset_soft`, this never rewrites history — safe on shared/pushed branches. " +
      "Refuses on a dirty tree or when a revert is already in progress. On conflict, " +
      '`onConflict: "abort"` (default) aborts and returns the tree clean; `onConflict: "pause"` ' +
      "leaves the conflict and native sequencer state in place for `git_revert_continue`. `noCommit` " +
      "stages the revert(s) without committing (working tree intentionally left staged in that " +
      "case). `mainline` selects the parent to diff against when reverting a merge commit.",
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
        .describe(
          "Commits to revert, applied in order: SHA, branch/tag name, or ancestor notation (`HEAD~1`).",
        ),
      noCommit: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Pass `--no-commit`: apply the revert(s) to the index/working tree without committing " +
            "(changes are left staged instead).",
        ),
      mainline: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Parent number (`-m N`) to diff against — required when reverting a merge commit.",
        ),
      onConflict: z
        .enum(["abort", "pause"])
        .optional()
        .default("abort")
        .describe(
          "`abort` (default): on conflict, run `revert --abort` and roll back the whole " +
            "in-progress revert sequence (unchanged behavior). `pause`: on conflict, leave the " +
            "conflict and native revert sequencer state in place — commits already made stay " +
            "applied — so it can be resolved and resumed via `git_revert_continue`.",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      // --- Guard: refuse when a revert is already in progress (native REVERT_HEAD state,
      // read live off .git — this server is stateless per call). Checked before the
      // dirty-tree refusal below so callers get a specific, actionable error instead of
      // the generic working_tree_dirty (mirrors git_cherry_pick's CHERRY_PICK_HEAD guard). ---
      const inProgressSha = await revertHead(gitTop);
      if (inProgressSha) {
        return jsonRespond({ error: ERROR_CODES.REVERT_IN_PROGRESS, commit: inProgressSha });
      }

      const onConflict = args.onConflict ?? "abort";

      // --- Validate sources ---
      for (const raw of args.sources) {
        if (!isSafeGitAncestorRef(raw)) {
          return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, source: raw });
        }
      }

      // --- Refuse dirty tree ---
      if (!(await isWorkingTreeClean(gitTop))) {
        return jsonRespond({
          error: ERROR_CODES.WORKING_TREE_DIRTY,
          detail:
            "git_revert requires a clean working tree. Commit or stash pending changes first.",
        });
      }

      const preHeadProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const preHead = preHeadProbe.ok ? preHeadProbe.stdout.trim() : "";

      const revertArgs = ["revert"];
      if (args.noCommit) revertArgs.push("--no-commit");
      if (args.mainline !== undefined) revertArgs.push("-m", String(args.mainline));
      revertArgs.push(...args.sources);

      const r = await spawnGitAsync(gitTop, revertArgs);

      if (!r.ok) {
        const failedSha = await revertHead(gitTop);
        const paths = await conflictPaths(gitTop);

        if (onConflict === "pause") {
          // Leave the conflict + native sequencer state in place. Commits already
          // made before the conflicting source stay applied — compute that count
          // cheaply from the HEAD advance so far (resumable via git_revert_continue).
          const adv = await spawnGitAsync(gitTop, ["rev-list", "--count", `${preHead}..HEAD`]);
          const applied = adv.ok ? parseInt(adv.stdout.trim(), 10) || 0 : 0;
          return jsonRespond({
            ok: false,
            paused: true,
            applied,
            ...spreadDefined("commit", failedSha),
            conflicts: paths,
            ...spreadDefined("detail", (r.stderr || r.stdout).trim() || undefined),
          });
        }

        const abortResult = await abortRevert(gitTop);
        return jsonRespond({
          ok: false,
          aborted: abortResult.ok,
          ...spreadDefined("commit", failedSha),
          conflicts: paths,
          ...spreadDefined("detail", (r.stderr || r.stdout).trim() || undefined),
          ...spreadWhen(!abortResult.ok, {
            error: ERROR_CODES.REVERT_ABORT_FAILED,
            ...spreadDefined("abortDetail", abortResult.detail),
          }),
        });
      }

      // --- No-commit: revert(s) staged, no new commits ---
      if (args.noCommit) {
        const stagedResult = await spawnGitAsync(gitTop, ["diff", "--cached", "--name-only"]);
        const stagedFiles = stagedResult.ok
          ? stagedResult.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0)
          : [];

        if (args.format === "json") {
          return jsonRespond({
            ok: true,
            staged: true,
            sources: args.sources,
            stagedCount: stagedFiles.length,
          });
        }

        return [
          "# Revert (staged, not committed)",
          `${args.sources.length} source(s) → ${stagedFiles.length} file(s) staged`,
          ...args.sources.map((s) => `- ${s}`),
        ].join("\n");
      }

      // --- Committed: one new commit per source, oldest-first ---
      const newCommitsResult = await spawnGitAsync(gitTop, [
        "rev-list",
        "--reverse",
        `${preHead}..HEAD`,
      ]);
      const newCommits = newCommitsResult.ok
        ? newCommitsResult.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
        : [];

      const reverted: Array<{ source: string; sha: string }> = [];
      for (let i = 0; i < args.sources.length; i++) {
        const source = args.sources[i];
        const sha = newCommits[i];
        if (source !== undefined && sha !== undefined) reverted.push({ source, sha });
      }

      if (args.format === "json") {
        return jsonRespond({
          ok: true,
          reverted,
        });
      }

      const lines = [`# Revert: ${reverted.length} commit(s)`, ""];
      for (const item of reverted) {
        lines.push(`- ${item.source} → ${item.sha.slice(0, 7)}`);
      }
      return lines.join("\n");
    },
  });
}
