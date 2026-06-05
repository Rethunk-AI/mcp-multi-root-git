import type { FastMCP } from "fastmcp";

import { registerBatchCommitTool } from "./batch-commit-tool.js";
import { registerGitBlameTool } from "./git-blame-tool.js";
import { registerGitBranchListTool } from "./git-branch-list-tool.js";
import { registerGitCherryPickTool } from "./git-cherry-pick-tool.js";
import { registerGitDiffSummaryTool } from "./git-diff-summary-tool.js";
import { registerGitDiffTool } from "./git-diff-tool.js";
import { registerGitFetchTool } from "./git-fetch-tool.js";
import { registerGitInventoryTool } from "./git-inventory-tool.js";
import { registerGitLogTool } from "./git-log-tool.js";
import { registerGitMergeTool } from "./git-merge-tool.js";
import { registerGitParityTool } from "./git-parity-tool.js";
import { registerGitPushTool } from "./git-push-tool.js";
import { registerGitReflogTool } from "./git-reflog-tool.js";
import { registerGitResetSoftTool } from "./git-reset-soft-tool.js";
import { registerGitShowTool } from "./git-show-tool.js";
import { registerGitStashApplyTool, registerGitStashListTool } from "./git-stash-tool.js";
import { registerGitStatusTool } from "./git-status-tool.js";
import { registerGitTagTool } from "./git-tag-tool.js";
import {
  registerGitWorktreeAddTool,
  registerGitWorktreeListTool,
  registerGitWorktreeRemoveTool,
} from "./git-worktree-tool.js";
import { registerListPresetsTool } from "./list-presets-tool.js";
import { registerPresetsResource } from "./presets-resource.js";

/**
 * Ordered registry of all 23 MCP tools. Registration order is preserved for
 * both full and filtered (RETHUNK_GIT_TOOLS) subsets.
 */
const TOOL_REGISTRARS: { name: string; register: (server: FastMCP) => void }[] = [
  // Read-only tools
  { name: "git_status", register: registerGitStatusTool },
  { name: "git_inventory", register: registerGitInventoryTool },
  { name: "git_parity", register: registerGitParityTool },
  { name: "list_presets", register: registerListPresetsTool },
  { name: "git_log", register: registerGitLogTool },
  { name: "git_diff_summary", register: registerGitDiffSummaryTool },
  { name: "git_diff", register: registerGitDiffTool },
  { name: "git_show", register: registerGitShowTool },
  { name: "git_worktree_list", register: registerGitWorktreeListTool },
  { name: "git_stash_list", register: registerGitStashListTool },
  { name: "git_fetch", register: registerGitFetchTool },
  { name: "git_blame", register: registerGitBlameTool },
  { name: "git_branch_list", register: registerGitBranchListTool },
  { name: "git_reflog", register: registerGitReflogTool },
  // Mutating tools
  { name: "batch_commit", register: registerBatchCommitTool },
  { name: "git_push", register: registerGitPushTool },
  { name: "git_merge", register: registerGitMergeTool },
  { name: "git_cherry_pick", register: registerGitCherryPickTool },
  { name: "git_reset_soft", register: registerGitResetSoftTool },
  { name: "git_tag", register: registerGitTagTool },
  { name: "git_worktree_add", register: registerGitWorktreeAddTool },
  { name: "git_worktree_remove", register: registerGitWorktreeRemoveTool },
  { name: "git_stash_apply", register: registerGitStashApplyTool },
];

/**
 * Parse the RETHUNK_GIT_TOOLS env var and return the matching subset of
 * registrars plus any unrecognized token names.
 *
 * @param envValue  Raw value of process.env.RETHUNK_GIT_TOOLS (may be undefined).
 * @param registrars  Full ordered registrar list (injectable for tests).
 */
export function selectToolRegistrars(
  envValue: string | undefined,
  registrars: typeof TOOL_REGISTRARS,
): {
  selected: typeof TOOL_REGISTRARS;
  unknown: string[];
} {
  const tokens = (envValue ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Unset, empty, or whitespace-only → register all tools.
  if (tokens.length === 0) {
    return { selected: registrars, unknown: [] };
  }

  const knownNames = new Set(registrars.map((r) => r.name));
  const requested = new Set(tokens);

  const unknown = tokens.filter((t) => !knownNames.has(t));
  // Preserve canonical order; deduplicate duplicate tokens automatically.
  const selected = registrars.filter((r) => requested.has(r.name));

  return { selected, unknown };
}

export function registerRethunkGitTools(server: FastMCP): void {
  const env = process.env.RETHUNK_GIT_TOOLS;
  const { selected, unknown } = selectToolRegistrars(env, TOOL_REGISTRARS);

  if (unknown.length > 0) {
    process.stderr.write(
      `[rethunk-git] RETHUNK_GIT_TOOLS: unknown tool name(s) ignored: ${unknown.map((n) => JSON.stringify(n)).join(", ")}\n`,
    );
  }

  if (selected.length === 0 && (env ?? "").trim().length > 0) {
    process.stderr.write(
      `[rethunk-git] RETHUNK_GIT_TOOLS: every listed name was unrecognized — registering NO tools. ` +
        `Set RETHUNK_GIT_TOOLS to a comma-separated list of valid tool names, or unset it to register all tools.\n`,
    );
  }

  for (const { register } of selected) {
    register(server);
  }

  // The presets RESOURCE is always registered, regardless of the tool allowlist.
  registerPresetsResource(server);
}
