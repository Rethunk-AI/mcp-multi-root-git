import type { FastMCP } from "fastmcp";

import { registerBatchCommitTool } from "./batch-commit-tool.js";
import { registerGitDiffSummaryTool } from "./git-diff-summary-tool.js";
import { registerGitInventoryTool } from "./git-inventory-tool.js";
import { registerGitParityTool } from "./git-parity-tool.js";
import { registerGitStatusTool } from "./git-status-tool.js";
import { registerListPresetsTool } from "./list-presets-tool.js";
import { registerPresetsResource } from "./presets-resource.js";

export function registerRethunkGitTools(server: FastMCP): void {
  registerGitStatusTool(server);
  registerGitInventoryTool(server);
  registerGitParityTool(server);
  registerListPresetsTool(server);
  registerBatchCommitTool(server);
  registerGitDiffSummaryTool(server);
  registerPresetsResource(server);
}
