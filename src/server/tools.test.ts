/**
 * Tests for RETHUNK_GIT_TOOLS tool allowlist filtering in registerRethunkGitTools / selectToolRegistrars.
 */

import { describe, expect, test } from "bun:test";
import type { FastMCP } from "fastmcp";

import { captureToolDefinitions } from "./test-harness.js";
import { registerRethunkGitTools, selectToolRegistrars } from "./tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All 23 canonical tool names, in registration order, verified from source. */
const ALL_TOOL_NAMES: string[] = [
  // Read-only
  "git_status",
  "git_inventory",
  "git_parity",
  "list_presets",
  "git_log",
  "git_diff_summary",
  "git_diff",
  "git_show",
  "git_worktree_list",
  "git_stash_list",
  "git_fetch",
  "git_blame",
  "git_branch_list",
  "git_reflog",
  // Mutating
  "batch_commit",
  "git_push",
  "git_merge",
  "git_cherry_pick",
  "git_reset_soft",
  "git_tag",
  "git_worktree_add",
  "git_worktree_remove",
  "git_stash_apply",
] as const;

/** Minimal registrar stub used for pure unit tests of selectToolRegistrars. */
const STUB_REGISTRARS = ALL_TOOL_NAMES.map((name) => ({
  name,
  register: (_server: FastMCP) => undefined,
}));

// ---------------------------------------------------------------------------
// selectToolRegistrars — pure unit tests
// ---------------------------------------------------------------------------

describe("selectToolRegistrars", () => {
  test("no-tokens env (undefined, empty, or whitespace-only) → all tools returned", () => {
    for (const env of [undefined, "", "   ,  ,  "]) {
      const { selected, unknown } = selectToolRegistrars(env, STUB_REGISTRARS);
      expect(selected.map((r) => r.name)).toEqual(ALL_TOOL_NAMES);
      expect(unknown).toEqual([]);
    }
  });

  test("subset env → exactly those tools in canonical order, duplicates deduplicated", () => {
    const { selected, unknown } = selectToolRegistrars(
      "git_push,git_status,batch_commit,git_push",
      STUB_REGISTRARS,
    );
    // canonical order: git_status (0) < batch_commit (14) < git_push (15)
    expect(selected.map((r) => r.name)).toEqual(["git_status", "batch_commit", "git_push"]);
    expect(unknown).toEqual([]);
  });

  test("subset env with extra whitespace → trimmed and matched", () => {
    const { selected, unknown } = selectToolRegistrars("  git_log , git_diff  ", STUB_REGISTRARS);
    expect(selected.map((r) => r.name)).toEqual(["git_log", "git_diff"]);
    expect(unknown).toEqual([]);
  });

  test("unknown name → reported in unknown, valid ones still registered", () => {
    const { selected, unknown } = selectToolRegistrars(
      "git_status,typo_tool,git_log",
      STUB_REGISTRARS,
    );
    expect(selected.map((r) => r.name)).toEqual(["git_status", "git_log"]);
    expect(unknown).toEqual(["typo_tool"]);
  });

  test("all unknown names → empty selected, all reported as unknown", () => {
    const { selected, unknown } = selectToolRegistrars("not_a_tool,also_bad", STUB_REGISTRARS);
    expect(selected).toEqual([]);
    expect(unknown).toEqual(["not_a_tool", "also_bad"]);
  });
});

// ---------------------------------------------------------------------------
// registerRethunkGitTools — integration: actual addTool stubs
// ---------------------------------------------------------------------------

describe("registerRethunkGitTools", () => {
  test("unset RETHUNK_GIT_TOOLS → all 23 tools registered", () => {
    const savedEnv = process.env.RETHUNK_GIT_TOOLS;
    delete process.env.RETHUNK_GIT_TOOLS;
    try {
      const tools = captureToolDefinitions(registerRethunkGitTools);
      expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
    } finally {
      if (savedEnv !== undefined) process.env.RETHUNK_GIT_TOOLS = savedEnv;
    }
  });

  test("subset RETHUNK_GIT_TOOLS → only listed tools registered", () => {
    const savedEnv = process.env.RETHUNK_GIT_TOOLS;
    process.env.RETHUNK_GIT_TOOLS = "git_status,git_diff_summary,batch_commit";
    try {
      const tools = captureToolDefinitions(registerRethunkGitTools);
      expect(tools.map((t) => t.name)).toEqual(["git_status", "git_diff_summary", "batch_commit"]);
    } finally {
      if (savedEnv !== undefined) process.env.RETHUNK_GIT_TOOLS = savedEnv;
      else delete process.env.RETHUNK_GIT_TOOLS;
    }
  });

  test("all-unknown RETHUNK_GIT_TOOLS → zero tools registered", () => {
    const savedEnv = process.env.RETHUNK_GIT_TOOLS;
    process.env.RETHUNK_GIT_TOOLS = "not_a_tool";
    try {
      const tools = captureToolDefinitions(registerRethunkGitTools);
      expect(tools).toEqual([]);
    } finally {
      if (savedEnv !== undefined) process.env.RETHUNK_GIT_TOOLS = savedEnv;
      else delete process.env.RETHUNK_GIT_TOOLS;
    }
  });

  test("declared tool names match actual addTool names — drift guard", () => {
    // Register all tools unconditionally, capture real addTool names.
    const savedEnv = process.env.RETHUNK_GIT_TOOLS;
    delete process.env.RETHUNK_GIT_TOOLS;
    try {
      const tools = captureToolDefinitions(registerRethunkGitTools);
      const captured = new Set(tools.map((t) => t.name));
      const declared = new Set(ALL_TOOL_NAMES);
      // Every declared name must appear as a real addTool call.
      for (const name of declared) {
        expect(captured.has(name)).toBe(true);
      }
      // Every captured name must appear in our declared list.
      for (const name of captured) {
        expect(declared.has(name)).toBe(true);
      }
    } finally {
      if (savedEnv !== undefined) process.env.RETHUNK_GIT_TOOLS = savedEnv;
    }
  });
});
