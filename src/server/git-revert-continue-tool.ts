import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { conflictPaths } from "./git-refs.js";
import { abortRevert, revertHead } from "./git-revert-tool.js";
import { jsonRespond, spreadDefined } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// git_revert_continue — resume or abort a revert left in progress
//
// Mirrors git_cherry_pick_continue's structure exactly (action continue|abort,
// REVERT_HEAD probe instead of CHERRY_PICK_HEAD, same stateless-per-call design),
// with git_revert's own flat (non-nested) response shape reused for the
// resumable-conflict case instead of git_cherry_pick's nested `conflict` object.
// ---------------------------------------------------------------------------

interface ContinueConflictReport {
  paused: true;
  commit?: string;
  paths: string[];
  detail?: string;
}

function renderRevertContinueMarkdown(
  action: "continue" | "abort",
  ok: boolean,
  applied: number,
  headSha: string | undefined,
  conflict?: ContinueConflictReport,
): string {
  if (action === "abort") {
    return ok
      ? `# Revert abort\nAborted. HEAD restored to \`${headSha ?? "?"}\`.`
      : "# Revert abort\nAbort failed — see error.";
  }
  if (conflict) {
    const lines = [
      `# Revert continue: paused on conflict after ${applied} commit(s)`,
      "",
      `Conflict at commit \`${conflict.commit ?? "?"}\`:`,
    ];
    for (const p of conflict.paths) lines.push(`  conflict: ${p}`);
    if (conflict.detail) lines.push(`  detail: ${conflict.detail}`);
    lines.push(
      "  Paused: revert still in progress. Resolve the conflict, then call `git_revert_continue` again.",
    );
    return lines.join("\n");
  }
  return `# Revert continue: ${applied} commit(s) applied\nHEAD now \`${headSha ?? "?"}\`.`;
}

export function registerGitRevertContinueTool(server: FastMCP): void {
  server.addTool({
    name: "git_revert_continue",
    description:
      "Resume or abort a revert left in progress — typically by `git_revert`'s " +
      '`onConflict: "pause"`, but this tool is stateless and reads `REVERT_HEAD` / the native ' +
      "sequencer live off `.git`, so it works regardless of how the in-progress state was left. " +
      '`action: "continue"` (default) requires every previously conflicted path to be staged (no ' +
      "remaining unmerged entries — `revert_unresolved_paths` otherwise), then runs " +
      "`git -c core.editor=true revert --continue` so git's sequencer both commits the resolved " +
      "revert and resumes through any remaining sources in the same call. If a *later* source then " +
      "conflicts, the response reports it the same way as a paused `git_revert` call (`paused: true`) " +
      'so this tool can be called again to keep walking the sources. `action: "abort"` rolls back the ' +
      "whole in-progress revert via `git revert --abort`.",
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
            '"abort": roll back to the pre-revert HEAD.',
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;
      const action = args.action ?? "continue";

      const inProgressSha = await revertHead(gitTop);
      if (!inProgressSha) {
        return jsonRespond({ error: ERROR_CODES.NO_REVERT_IN_PROGRESS });
      }

      const preHeadProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const preHead = preHeadProbe.ok ? preHeadProbe.stdout.trim() : "";

      // --- abort: reuse the same hardened abort helper/reporting as git_revert ---
      if (action === "abort") {
        const abort = await abortRevert(gitTop);
        if (!abort.ok) {
          return jsonRespond({
            ok: false,
            action: "abort",
            error: ERROR_CODES.REVERT_ABORT_FAILED,
            ...spreadDefined("abortDetail", abort.detail),
          });
        }
        const headProbe = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
        const headSha = headProbe.ok ? headProbe.stdout.trim() : undefined;
        if (args.format === "json") {
          return jsonRespond({ ok: true, action: "abort", ...spreadDefined("headSha", headSha) });
        }
        return renderRevertContinueMarkdown("abort", true, 0, headSha);
      }

      // --- continue: precheck no unmerged paths remain ---
      const unmerged = await conflictPaths(gitTop);
      if (unmerged.length > 0) {
        return jsonRespond({
          error: ERROR_CODES.REVERT_UNRESOLVED_PATHS,
          paths: unmerged,
        });
      }

      // `-c core.editor=true` avoids launching an interactive editor for the reused commit message.
      const r = await spawnGitAsync(gitTop, ["-c", "core.editor=true", "revert", "--continue"]);

      if (!r.ok) {
        const failedSha = await revertHead(gitTop);
        const paths = failedSha ? await conflictPaths(gitTop) : [];
        if (failedSha && paths.length > 0) {
          // A later source in the same revert conflicted — report it the same shape as a
          // paused git_revert call so the caller can loop this tool to resolution.
          const adv = await spawnGitAsync(gitTop, ["rev-list", "--count", `${preHead}..HEAD`]);
          const applied = adv.ok ? parseInt(adv.stdout.trim(), 10) || 0 : 0;
          const conflict: ContinueConflictReport = {
            paused: true,
            ...spreadDefined("commit", failedSha),
            paths,
            ...spreadDefined("detail", (r.stderr || r.stdout).trim() || undefined),
          };
          if (args.format === "json") {
            return jsonRespond({ ok: false, action: "continue", applied, ...conflict });
          }
          return renderRevertContinueMarkdown("continue", false, applied, undefined, conflict);
        }
        // Not a new conflict (e.g. the resolved revert would produce an empty commit) —
        // surface a generic, non-resumable-loop error with whatever detail git gave.
        return jsonRespond({
          error: ERROR_CODES.REVERT_CONTINUE_FAILED,
          ...spreadDefined("commit", failedSha),
          detail: (r.stderr || r.stdout).trim(),
        });
      }

      // --- success: sequencer completed the resolved revert and any remaining ones ---
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
      return renderRevertContinueMarkdown("continue", true, applied, headSha);
    },
  });
}
