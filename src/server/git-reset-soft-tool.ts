import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { spawnGitAsync } from "./git.js";
import { isSafeGitAncestorRef, isWorkingTreeClean } from "./git-refs.js";
import { jsonRespond, spreadDefined } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

export function registerGitResetSoftTool(server: FastMCP): void {
  server.addTool({
    name: "git_reset_soft",
    description:
      "Soft-reset the current branch to a reference (`git reset --soft <ref>`). " +
      "Moves the branch pointer back while keeping all changes from the rewound commits " +
      "in the staging index — use this to re-split an already-committed chunk. " +
      "Refuses when the working tree has any uncommitted or unstaged changes (run on a clean tree).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      ref: z
        .string()
        .min(1)
        .describe(
          "Commit to reset to. Accepts ancestor notation (`HEAD~1`, `HEAD~3`), " +
            "branch names, or full SHAs.",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      // Validate ref — allow ancestor notation (~N, ^N).
      if (!isSafeGitAncestorRef(args.ref)) {
        return jsonRespond({ error: "unsafe_ref_token", ref: args.ref });
      }

      // Refuse when the working tree is dirty (unstaged or untracked changes).
      if (!(await isWorkingTreeClean(gitTop))) {
        return jsonRespond({
          error: "working_tree_dirty",
          detail:
            "git_reset_soft requires a clean working tree. " +
            "Commit or stash pending changes first.",
        });
      }

      // Probe HEAD before reset for the response.
      const preSha = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const beforeSha = preSha.ok ? preSha.stdout.trim() : undefined;

      // Run the reset.
      const r = await spawnGitAsync(gitTop, ["reset", "--soft", args.ref]);
      if (!r.ok) {
        return jsonRespond({
          error: "reset_failed",
          detail: (r.stderr || r.stdout).trim(),
        });
      }

      // Probe HEAD after reset.
      const postSha = await spawnGitAsync(gitTop, ["rev-parse", "HEAD"]);
      const afterSha = postSha.ok ? postSha.stdout.trim() : undefined;

      // Count staged changes after reset.
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
          ref: args.ref,
          ...spreadDefined("beforeSha", beforeSha),
          ...spreadDefined("afterSha", afterSha),
          stagedCount: stagedFiles.length,
        });
      }

      const beforeShort = beforeSha?.slice(0, 7) ?? "?";
      const afterShort = afterSha?.slice(0, 7) ?? "?";
      return [
        "# Reset (soft)",
        `✓ ${beforeShort} → ${afterShort}  (${stagedFiles.length} file(s) staged)`,
      ].join("\n");
    },
  });
}
