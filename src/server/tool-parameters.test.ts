/**
 * Tool parameter surface checks.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { captureToolDefinitions } from "./test-harness.js";
import { registerRethunkGitTools } from "./tools.js";

const READ_ONLY_ABSOLUTE_ROOT_TOOLS = [
  "git_status",
  "git_inventory",
  "git_parity",
  "list_presets",
  "git_log",
  "git_diff_summary",
];

const MUTATING_TOOLS = [
  "batch_commit",
  "git_push",
  "git_merge",
  "git_cherry_pick",
  "git_reset_soft",
  "git_worktree_add",
  "git_worktree_remove",
];

const ALL_TOOLS = [...READ_ONLY_ABSOLUTE_ROOT_TOOLS, "git_worktree_list", ...MUTATING_TOOLS];

type JsonObjectSchema = { properties?: Record<string, unknown>; required?: string[] };

function toolSchemas(): Map<string, JsonObjectSchema> {
  return new Map(
    captureToolDefinitions(registerRethunkGitTools).map((tool) => [
      tool.name,
      z.toJSONSchema(tool.parameters as z.ZodType) as JsonObjectSchema,
    ]),
  );
}

describe("tool parameter schemas", () => {
  test("generates JSON Schema for every registered tool", () => {
    const schemas = toolSchemas();
    expect([...schemas.keys()].sort()).toEqual([...ALL_TOOLS].sort());
    for (const [name, schema] of schemas) {
      expect(name.length).toBeGreaterThan(0);
      expect(schema.properties).toBeDefined();
    }
  });

  test("read-only batch tools expose absoluteGitRoots", () => {
    const schemas = toolSchemas();
    for (const name of READ_ONLY_ABSOLUTE_ROOT_TOOLS) {
      expect(schemas.get(name)?.properties).toHaveProperty("absoluteGitRoots");
    }
  });

  test("mutating tools do not expose absoluteGitRoots", () => {
    const schemas = toolSchemas();
    for (const name of MUTATING_TOOLS) {
      expect(schemas.get(name)?.properties).not.toHaveProperty("absoluteGitRoots");
    }
  });

  test("standalone git_push exposes push-only parameters", () => {
    const schema = toolSchemas().get("git_push");
    expect(schema?.properties).toHaveProperty("remote");
    expect(schema?.properties).toHaveProperty("branch");
    expect(schema?.properties).toHaveProperty("setUpstream");
    expect(schema?.properties).not.toHaveProperty("commits");
  });
});
