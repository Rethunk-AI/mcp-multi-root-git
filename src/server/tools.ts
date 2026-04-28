import type { FastMCP } from "fastmcp";

import { registerBatchCommitTool } from "./batch-commit-tool.js";
import { registerGitCherryPickTool } from "./git-cherry-pick-tool.js";
import { registerGitDiffSummaryTool } from "./git-diff-summary-tool.js";
import { registerGitDiffTool } from "./git-diff-tool.js";
import { registerGitInventoryTool } from "./git-inventory-tool.js";
import { registerGitLogTool } from "./git-log-tool.js";
import { registerGitMergeTool } from "./git-merge-tool.js";
import { registerGitParityTool } from "./git-parity-tool.js";
import { registerGitPushTool } from "./git-push-tool.js";
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

export function registerRethunkGitTools(server: FastMCP): void {
  // Read-only tools
  registerGitStatusTool(server);
  registerGitInventoryTool(server);
  registerGitParityTool(server);
  registerListPresetsTool(server);
  registerGitLogTool(server);
  registerGitDiffSummaryTool(server);
  registerGitDiffTool(server);
  registerGitShowTool(server);
  registerGitWorktreeListTool(server);
  registerGitStashListTool(server);
  // Mutating tools
  registerBatchCommitTool(server);
  registerGitPushTool(server);
  registerGitMergeTool(server);
  registerGitCherryPickTool(server);
  registerGitResetSoftTool(server);
  registerGitTagTool(server);
  registerGitWorktreeAddTool(server);
  registerGitWorktreeRemoveTool(server);
  registerGitStashApplyTool(server);
  // Resources
  registerPresetsResource(server);
}
