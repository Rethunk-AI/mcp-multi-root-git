import type { FastMCP } from "fastmcp";

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
  registerPresetsResource(server);
}
