import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { registerBatchCommitTool } from "./batch-commit-tool.js";
import { registerGitCherryPickTool } from "./git-cherry-pick-tool.js";
import { registerGitDiffSummaryTool } from "./git-diff-summary-tool.js";
import { registerGitInventoryTool } from "./git-inventory-tool.js";
import { registerGitLogTool } from "./git-log-tool.js";
import { registerGitMergeTool } from "./git-merge-tool.js";
import { registerGitParityTool } from "./git-parity-tool.js";
import { registerGitPushTool } from "./git-push-tool.js";
import { registerGitResetSoftTool } from "./git-reset-soft-tool.js";
import { registerGitStatusTool } from "./git-status-tool.js";
import {
  registerGitWorktreeAddTool,
  registerGitWorktreeListTool,
  registerGitWorktreeRemoveTool,
} from "./git-worktree-tool.js";
import { registerListPresetsTool } from "./list-presets-tool.js";

export const READ_ONLY_ABSOLUTE_ROOT_TOOLS = [
  "git_status",
  "git_inventory",
  "git_parity",
  "list_presets",
  "git_log",
  "git_diff_summary",
] as const;

export const MUTATING_TOOLS = [
  "batch_commit",
  "git_push",
  "git_merge",
  "git_cherry_pick",
  "git_reset_soft",
  "git_worktree_add",
  "git_worktree_remove",
] as const;

export const ALL_PARAMETER_SCHEMA_TOOLS = [
  ...READ_ONLY_ABSOLUTE_ROOT_TOOLS,
  "git_worktree_list",
  ...MUTATING_TOOLS,
] as const;

type ExecuteFn = (args: Record<string, unknown>, context: Record<string, unknown>) => unknown;

type CapturedTool = {
  name: string;
  parameters: z.ZodType;
};

export type JsonObjectSchema = {
  type?: string;
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolParameterSchemaDocument = {
  $schema: string;
  title: string;
  description: string;
  generatedBy: string;
  tools: Record<string, JsonObjectSchema>;
};

function captureParameterTools(register: (server: FastMCP) => void): CapturedTool[] {
  const tools: CapturedTool[] = [];
  const server = {
    sessions: [],
    addTool(tool: { name: string; parameters: z.ZodType; execute: ExecuteFn }) {
      tools.push({ name: tool.name, parameters: tool.parameters });
    },
  } as unknown as FastMCP;
  register(server);
  return tools;
}

export function captureToolParameterSchemas(): Record<string, JsonObjectSchema> {
  const tools = captureParameterTools((server) => {
    registerGitStatusTool(server);
    registerGitInventoryTool(server);
    registerGitParityTool(server);
    registerListPresetsTool(server);
    registerGitLogTool(server);
    registerGitDiffSummaryTool(server);
    registerGitWorktreeListTool(server);
    registerBatchCommitTool(server);
    registerGitPushTool(server);
    registerGitMergeTool(server);
    registerGitCherryPickTool(server);
    registerGitResetSoftTool(server);
    registerGitWorktreeAddTool(server);
    registerGitWorktreeRemoveTool(server);
  });

  return Object.fromEntries(
    tools.map((tool) => [tool.name, z.toJSONSchema(tool.parameters) as JsonObjectSchema]),
  );
}

export function buildToolParameterSchemaDocument(): ToolParameterSchemaDocument {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "@rethunk/mcp-multi-root-git tool parameter schemas",
    description: "JSON Schema snapshots generated from registered FastMCP tool parameter schemas.",
    generatedBy: "scripts/generate-tool-parameters-schema.ts",
    tools: captureToolParameterSchemas(),
  };
}
