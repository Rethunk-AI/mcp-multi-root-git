import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { jsonRespond, spreadDefined } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// git_stash_list
// ---------------------------------------------------------------------------

export function registerGitStashListTool(server: FastMCP): void {
  server.addTool({
    name: "git_stash_list",
    description:
      "List all git stashes. Returns array of `{ index: number, message: string, sha: string }`.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.omit({ absoluteGitRoots: true, allWorkspaceRoots: true }).pick({
      workspaceRoot: true,
      rootIndex: true,
      format: true,
    }),
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
      "Apply or pop a git stash. `index` defaults to 0 (stash@{0}). " +
      "Set `pop: true` to run `git stash pop` instead of `git stash apply` (removes stash after applying). " +
      "Returns `{ applied: boolean, stashIndex: number, popped: boolean, output: string }`.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    parameters: WorkspacePickSchema.omit({ absoluteGitRoots: true, allWorkspaceRoots: true })
      .pick({
        workspaceRoot: true,
        rootIndex: true,
        format: true,
      })
      .extend({
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Stash index (defaults to 0 for stash@{0})."),
        pop: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, runs `git stash pop` instead of `git stash apply` (removes stash after applying).",
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

      if (args.format === "json") {
        return jsonRespond({
          applied,
          stashIndex: args.index,
          popped: args.pop,
          ...spreadDefined("output", output),
        });
      }

      const verb = args.pop ? "popped" : "applied";
      if (applied) {
        return `# Stash ${verb}\n✓ ${stashRef}  → ${verb}`;
      }
      return `# Stash ${verb} (failed)\n✗ ${stashRef}\n\n\`\`\`\n${output}\n\`\`\``;
    },
  });
}
