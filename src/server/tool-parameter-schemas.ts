import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { registerRethunkGitTools } from "./tools.js";

/**
 * Fan-out read tools: polymorphic `root` routing (string | string[] | "*").
 * Must stay in sync with the tools that use RootPickSchema — asserted against
 * live `registerRethunkGitTools` capture in tests.
 */
export const FAN_OUT_ROOT_TOOLS = [
  "git_status",
  "git_inventory",
  "git_parity",
  "list_presets",
  "git_log",
  "git_grep",
] as const;

/**
 * Read-only single-repo tools: `workspaceRoot` routing only.
 */
export const READ_ONLY_SINGLE_REPO_TOOLS = [
  "git_diff_summary",
  "git_diff",
  "git_show",
  "git_conflicts",
  "git_remote",
  "git_describe",
  "git_worktree_list",
  "git_stash_list",
  "git_blame",
  "git_branch_list",
  "git_reflog",
] as const;

/**
 * Mutating tools: `workspaceRoot` routing only.
 */
export const MUTATING_TOOLS = [
  "git_fetch",
  "batch_commit",
  "git_push",
  "git_merge",
  "git_cherry_pick",
  "git_reset_soft",
  "git_revert",
  "git_tag",
  "git_branch",
  "git_worktree_add",
  "git_worktree_remove",
  "git_stash_apply",
  "git_stash_push",
] as const;

/** Category union used for routing assertions; must equal live registrar names. */
export const ALL_PARAMETER_SCHEMA_TOOLS = [
  ...FAN_OUT_ROOT_TOOLS,
  ...READ_ONLY_SINGLE_REPO_TOOLS,
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

/**
 * Capture parameter Zod schemas by driving the same registrar path as the live
 * server (`registerRethunkGitTools`), so adding a tool only in `tools.ts` is
 * enough for schema capture — no parallel register* list here.
 *
 * Clears `RETHUNK_GIT_TOOLS` for the duration so allowlist filtering cannot
 * silently omit tools from published artifacts.
 */
export function captureToolParameterSchemas(): Record<string, JsonObjectSchema> {
  const tools: CapturedTool[] = [];
  const server = {
    sessions: [],
    addTool(tool: { name: string; parameters: z.ZodType; execute: ExecuteFn }) {
      tools.push({ name: tool.name, parameters: tool.parameters });
    },
    addResource() {
      // Presets resource is always registered; capture only needs tools.
    },
  } as unknown as FastMCP;

  const prev = process.env.RETHUNK_GIT_TOOLS;
  delete process.env.RETHUNK_GIT_TOOLS;
  try {
    registerRethunkGitTools(server);
  } finally {
    if (prev === undefined) {
      delete process.env.RETHUNK_GIT_TOOLS;
    } else {
      process.env.RETHUNK_GIT_TOOLS = prev;
    }
  }

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
