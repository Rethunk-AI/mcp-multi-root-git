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
  "git_blame",
] as const;

/**
 * Mutating tools: `workspaceRoot` routing only.
 */
export const MUTATING_TOOLS = [
  "batch_commit",
  "git_push",
  "git_merge",
  "git_cherry_pick",
  "git_cherry_pick_continue",
  "git_reset_soft",
  "git_revert",
  "git_revert_continue",
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

type CapturedFastMcpTool = {
  name: string;
  parameters: z.ZodType;
  execute?: ExecuteFn;
};

/**
 * Duck-typed fake FastMCP server: satisfies just enough of the interface
 * (`sessions`, `addTool`, `addResource`) to drive a real registrar
 * (`registerRethunkGitTools` or a single `register*Tool`) without a live
 * transport. Shared by schema capture (this module) and the test harness
 * (`test-harness.ts`) — the only difference between callers is whether
 * `roots` is populated and whether `execute` is later invoked.
 */
export function makeFakeFastMcpServer(roots: string[] = []): {
  server: FastMCP;
  tools: CapturedFastMcpTool[];
} {
  const tools: CapturedFastMcpTool[] = [];
  const server = {
    sessions: [{ roots: roots.map((uri) => ({ uri })) }],
    addTool(tool: CapturedFastMcpTool) {
      tools.push(tool);
    },
    addResource() {
      // Presets resource is always registered; capture only needs tools.
    },
  } as unknown as FastMCP;
  return { server, tools };
}

type JsonObjectSchema = {
  type?: string;
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

type ToolParameterSchemaDocument = {
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
  const { server, tools } = makeFakeFastMcpServer();

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
