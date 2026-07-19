import type { FastMCP } from "fastmcp";

import { registerBatchCommitTool } from "./batch-commit-tool.js";
import { registerGitBlameTool } from "./git-blame-tool.js";
import { registerGitBranchTool } from "./git-branch-tool.js";
import {
  registerGitCherryPickContinueTool,
  registerGitCherryPickTool,
} from "./git-cherry-pick-tool.js";
import { registerGitConflictsTool } from "./git-conflicts-tool.js";
import { registerGitDiffSummaryTool } from "./git-diff-summary-tool.js";
import { registerGitDiffTool } from "./git-diff-tool.js";
import { registerGitGrepTool } from "./git-grep-tool.js";
import { registerGitInventoryTool } from "./git-inventory-tool.js";
import { registerGitLogTool } from "./git-log-tool.js";
import { registerGitMergeTool } from "./git-merge-tool.js";
import { registerGitParityTool } from "./git-parity-tool.js";
import { registerGitPushTool } from "./git-push-tool.js";
import { registerGitResetSoftTool } from "./git-reset-soft-tool.js";
import { registerGitRevertTool } from "./git-revert-tool.js";
import { registerGitShowTool } from "./git-show-tool.js";
import { registerGitStashApplyTool, registerGitStashPushTool } from "./git-stash-tool.js";
import { registerGitStatusTool } from "./git-status-tool.js";
import { registerGitTagTool } from "./git-tag-tool.js";
import { registerGitWorktreeAddTool, registerGitWorktreeRemoveTool } from "./git-worktree-tool.js";
import { registerListPresetsTool } from "./list-presets-tool.js";
import { registerPresetsResource } from "./presets-resource.js";

/**
 * Ordered registry of all 24 MCP tools. Registration order is preserved for
 * both full and filtered (RETHUNK_GIT_TOOLS) subsets.
 */
const TOOL_REGISTRARS: { name: string; register: (server: FastMCP) => void }[] = [
  // Read-only tools
  { name: "git_status", register: registerGitStatusTool },
  { name: "git_inventory", register: registerGitInventoryTool },
  { name: "git_parity", register: registerGitParityTool },
  { name: "list_presets", register: registerListPresetsTool },
  { name: "git_log", register: registerGitLogTool },
  { name: "git_grep", register: registerGitGrepTool },
  { name: "git_diff_summary", register: registerGitDiffSummaryTool },
  { name: "git_diff", register: registerGitDiffTool },
  { name: "git_show", register: registerGitShowTool },
  { name: "git_conflicts", register: registerGitConflictsTool },
  { name: "git_blame", register: registerGitBlameTool },
  // Mutating tools
  { name: "batch_commit", register: registerBatchCommitTool },
  { name: "git_push", register: registerGitPushTool },
  { name: "git_merge", register: registerGitMergeTool },
  { name: "git_cherry_pick", register: registerGitCherryPickTool },
  { name: "git_cherry_pick_continue", register: registerGitCherryPickContinueTool },
  { name: "git_reset_soft", register: registerGitResetSoftTool },
  { name: "git_revert", register: registerGitRevertTool },
  { name: "git_tag", register: registerGitTagTool },
  { name: "git_branch", register: registerGitBranchTool },
  { name: "git_worktree_add", register: registerGitWorktreeAddTool },
  { name: "git_worktree_remove", register: registerGitWorktreeRemoveTool },
  { name: "git_stash_apply", register: registerGitStashApplyTool },
  { name: "git_stash_push", register: registerGitStashPushTool },
];

/**
 * Parse the RETHUNK_GIT_TOOLS env var and return the matching subset of
 * registrars plus any unrecognized token names.
 *
 * Semantics:
 * - unset / empty / whitespace-only → all tools
 * - bare `*` (sole non-empty token) → all tools (all-tools sentinel; not an empty selection)
 * - otherwise → exact name match (case-sensitive), canonical order, duplicates ignored
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

  // Unset, empty, whitespace-only, or bare "*" → register all tools.
  // Bare "*" is an intentional all-tools sentinel (operators used to root="*"
  // fan-out may set RETHUNK_GIT_TOOLS=* expecting the full surface — treating
  // it as an unrecognized name that empties the allowlist is a footgun).
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "*")) {
    // Shallow copy so callers cannot mutate the shared TOOL_REGISTRARS array.
    return { selected: [...registrars], unknown: [] };
  }

  const knownNames = new Set(registrars.map((r) => r.name));
  const requested = new Set(tokens);

  // Deduplicate unknown tokens while preserving first-seen order.
  const unknownSeen = new Set<string>();
  const unknown: string[] = [];
  for (const t of tokens) {
    if (!knownNames.has(t) && !unknownSeen.has(t)) {
      unknownSeen.add(t);
      unknown.push(t);
    }
  }
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
        `Set RETHUNK_GIT_TOOLS to a comma-separated list of valid tool names, bare "*" for all tools, or unset it to register all tools.\n`,
    );
  }

  for (const { register } of selected) {
    register(server);
  }

  // The presets RESOURCE is always registered, regardless of the tool allowlist.
  registerPresetsResource(server);
}
