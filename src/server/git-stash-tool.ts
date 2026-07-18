import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { conflictPaths } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// git_stash_list
// ---------------------------------------------------------------------------

export function registerGitStashListTool(server: FastMCP): void {
  server.addTool({
    name: "git_stash_list",
    description: "List all git stashes.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema,
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      // List all stashes: git stash list --format='%(refname:short)|%(subject)|%(objectname:short)'
      // git stash list uses git-log format (%s, %h) not for-each-ref format %(subject).
      const r = await spawnGitAsync(gitTop, ["stash", "list", "--format=%gd|%s|%h"]);

      if (!r.ok) {
        // If there are no stashes, git still returns ok=true with empty output
        // Only treat as error if git itself failed
        return jsonRespond({
          error: ERROR_CODES.STASH_LIST_FAILED,
          detail: (r.stderr || r.stdout).trim(),
        });
      }

      const stashes: Array<{ index: number; message: string; sha: string }> = [];
      const lines = (r.stdout || "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      for (const line of lines) {
        const parts = line.split("|");
        // parts[0] = stash@{N}, last part = short SHA, middle = message (may contain "|")
        const sha = parts[parts.length - 1];
        const message = parts.slice(1, -1).join("|");
        // Parse the real stash index from the canonical stash@{N} ref in parts[0].
        const indexMatch = parts[0] ? /stash@\{(\d+)\}/.exec(parts[0]) : null;
        if (!indexMatch || parts.length < 3 || !message || !sha) {
          // Malformed line — skip without affecting index tracking.
          continue;
        }
        stashes.push({
          index: Number(indexMatch[1]),
          message,
          sha,
        });
      }

      if (args.format === "json") {
        return jsonRespond({ stashes });
      }

      if (stashes.length === 0) {
        return "# Stashes\n_(none)_";
      }

      const lines_out: string[] = ["# Stashes", ""];
      for (const s of stashes) {
        lines_out.push(`- **stash@{${s.index}}** — ${s.message}  (\`${s.sha}\`)`);
      }
      return lines_out.join("\n");
    },
  });
}

// ---------------------------------------------------------------------------
// git_stash_apply
// ---------------------------------------------------------------------------

export function registerGitStashApplyTool(server: FastMCP): void {
  server.addTool({
    name: "git_stash_apply",
    description:
      "Apply or pop a git stash. `index` defaults to 0. `pop: true` removes stash after applying.",
    annotations: {
      readOnlyHint: false,
      // pop:true deletes a stash entry — treat the tool as destructive for client filters.
      destructiveHint: true,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      index: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .default(0)
        .describe("Stash index (defaults to 0 for stash@{0})."),
      pop: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Run `git stash pop` instead of `git stash apply` (removes stash after applying).",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      const stashRef = `stash@{${args.index}}`;
      const cmd = args.pop ? "pop" : "apply";
      const r = await spawnGitAsync(gitTop, ["stash", cmd, stashRef]);

      const applied = r.ok;
      const output = (r.stdout || r.stderr).trim();

      // On apply/pop failure, surface unresolved conflict paths when present
      // (mirrors merge/cherry-pick/revert). Leave the tree as git left it —
      // stash conflicts are not auto-aborted.
      const paths = applied ? [] : await conflictPaths(gitTop);

      if (args.format === "json") {
        return jsonRespond({
          ...spreadWhen(!applied, { error: ERROR_CODES.STASH_APPLY_FAILED }),
          applied,
          stashIndex: args.index,
          popped: args.pop,
          ...spreadDefined("output", output || undefined),
          ...spreadWhen(paths.length > 0, { conflictPaths: paths }),
        });
      }

      const verb = args.pop ? "popped" : "applied";
      if (applied) {
        return `# Stash ${verb}\n✓ ${stashRef}  → ${verb}`;
      }
      const conflictBlock =
        paths.length > 0 ? `\n\nConflicts:\n${paths.map((p) => `- ${p}`).join("\n")}` : "";
      return `# Stash ${verb} (failed)\n✗ ${stashRef}\n\n\`\`\`\n${output}\n\`\`\`${conflictBlock}`;
    },
  });
}

// ---------------------------------------------------------------------------
// git_stash_push
// ---------------------------------------------------------------------------

export function registerGitStashPushTool(server: FastMCP): void {
  server.addTool({
    name: "git_stash_push",
    description:
      "Stash working-tree changes (`git stash push`). Optional `message` for the stash subject, " +
      "`includeUntracked` (-u) to also stash untracked files, `keepIndex` (--keep-index) to leave " +
      "staged changes in the index, and `paths` to scope the stash to specific files. " +
      "Returns the new stash ref/SHA, or `stashed: false` if there was nothing to stash.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      message: z
        .string()
        .optional()
        .describe("Stash subject message (`git stash push -m <message>`)."),
      includeUntracked: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include untracked files in the stash (`git stash push -u`)."),
      keepIndex: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Keep staged changes in the index after stashing (`git stash push --keep-index`).",
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          "Scope the stash to specific paths, relative to git root (must resolve within repo root).",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      // Union + dedup + confine paths within the repo (escaping-attempt rejected).
      const rawPaths: string[] = [];
      if (Array.isArray(args.paths)) {
        for (const p of args.paths as string[]) {
          if (typeof p === "string" && p.trim()) {
            rawPaths.push(p.trim());
          }
        }
      }
      const dedupedPaths = [...new Set(rawPaths)];
      for (const p of dedupedPaths) {
        const resolved = resolvePathForRepo(p, gitTop);
        if (!assertRelativePathUnderTop(p, resolved, gitTop)) {
          return jsonRespond({ error: ERROR_CODES.PATH_ESCAPES_REPO, path: p });
        }
      }

      const stashArgs: string[] = ["stash", "push"];
      if (args.includeUntracked) stashArgs.push("-u");
      if (args.keepIndex) stashArgs.push("--keep-index");
      if (args.message) stashArgs.push("-m", args.message);
      if (dedupedPaths.length > 0) stashArgs.push("--", ...dedupedPaths);

      const r = await spawnGitAsync(gitTop, stashArgs);
      const output = (r.stdout || r.stderr).trim();

      if (!r.ok) {
        return jsonRespond({
          error: ERROR_CODES.STASH_PUSH_FAILED,
          detail: output,
        });
      }

      // `git stash push` exits 0 with this message when there is nothing to stash.
      if (/no local changes to save/i.test(output)) {
        if (args.format === "json") {
          return jsonRespond({ stashed: false, reason: "no_local_changes" });
        }
        return "# Stash push\n_(no local changes to save)_";
      }

      const shaResult = await spawnGitAsync(gitTop, ["rev-parse", "stash@{0}"]);
      const sha = shaResult.ok ? shaResult.stdout.trim() : "";
      const subjectResult = await spawnGitAsync(gitTop, ["log", "-1", "--format=%s", "stash@{0}"]);
      const message = subjectResult.ok ? subjectResult.stdout.trim() : "";

      if (args.format === "json") {
        return jsonRespond({
          stashed: true,
          ref: "stash@{0}",
          sha,
          message,
        });
      }

      return `# Stash pushed\n✓ stash@{0} — ${message}${sha ? `  (\`${sha}\`)` : ""}`;
    },
  });
}
