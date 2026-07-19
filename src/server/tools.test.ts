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

/** All 31 canonical tool names, in registration order, verified from source. */
const ALL_TOOL_NAMES = [
  // Read-only
  "git_status",
  "git_inventory",
  "git_parity",
  "list_presets",
  "git_log",
  "git_grep",
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
  // Mutating
  "git_fetch",
  "batch_commit",
  "git_push",
  "git_merge",
  "git_cherry_pick",
  "git_cherry_pick_continue",
  "git_reset_soft",
  "git_revert",
  "git_tag",
  "git_branch",
  "git_worktree_add",
  "git_worktree_remove",
  "git_stash_apply",
  "git_stash_push",
] as const;

/** Minimal registrar stub used for pure unit tests of selectToolRegistrars. */
const STUB_REGISTRARS = ALL_TOOL_NAMES.map((name) => ({
  name,
  register: (_server: FastMCP) => undefined,
}));

type CapturedResource = { uri?: string; name?: string };

/**
 * Capture both addTool and addResource registrations (test-harness only
 * exposes tools; presets always-on assertions need resource visibility).
 */
function captureToolsAndResources(register: (server: FastMCP) => void): {
  tools: { name: string }[];
  resources: CapturedResource[];
} {
  const tools: { name: string }[] = [];
  const resources: CapturedResource[] = [];
  const server = {
    sessions: [],
    addTool(tool: { name: string }) {
      tools.push({ name: tool.name });
    },
    addResource(resource: CapturedResource) {
      resources.push(resource);
    },
  } as unknown as FastMCP;
  register(server);
  return { tools, resources };
}

function withStderrCapture(fn: () => void): string[] {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    writes.push(text);
    if (typeof encodingOrCb === "function") encodingOrCb();
    else if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return writes;
}

function withEnv(value: string | undefined, fn: () => void): void {
  const saved = process.env.RETHUNK_GIT_TOOLS;
  try {
    if (value === undefined) delete process.env.RETHUNK_GIT_TOOLS;
    else process.env.RETHUNK_GIT_TOOLS = value;
    fn();
  } finally {
    if (saved !== undefined) process.env.RETHUNK_GIT_TOOLS = saved;
    else delete process.env.RETHUNK_GIT_TOOLS;
  }
}

// ---------------------------------------------------------------------------
// selectToolRegistrars — pure unit tests
// ---------------------------------------------------------------------------

describe("selectToolRegistrars", () => {
  test("no-tokens env (undefined, empty, or whitespace-only) → all tools returned", () => {
    for (const env of [undefined, "", "   ,  ,  "]) {
      const { selected, unknown } = selectToolRegistrars(env, STUB_REGISTRARS);
      expect(selected.map((r) => r.name)).toEqual([...ALL_TOOL_NAMES]);
      expect(unknown).toEqual([]);
    }
  });

  test('bare "*" → all tools (all-tools sentinel, not empty selection)', () => {
    for (const env of ["*", " * ", "*,", ",*"]) {
      const { selected, unknown } = selectToolRegistrars(env, STUB_REGISTRARS);
      expect(selected.map((r) => r.name)).toEqual([...ALL_TOOL_NAMES]);
      expect(unknown).toEqual([]);
    }
  });

  test("empty-token path returns a shallow copy, not the same array reference", () => {
    const { selected } = selectToolRegistrars(undefined, STUB_REGISTRARS);
    expect(selected).not.toBe(STUB_REGISTRARS);
    expect(selected.map((r) => r.name)).toEqual([...ALL_TOOL_NAMES]);
  });

  test("subset env → exactly those tools in canonical order, duplicates deduplicated", () => {
    const { selected, unknown } = selectToolRegistrars(
      "git_push,git_status,batch_commit,git_push",
      STUB_REGISTRARS,
    );
    // canonical order: git_status (0) < batch_commit (18) < git_push (19)
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

  test("duplicate unknown tokens → reported once (first-seen order)", () => {
    const { selected, unknown } = selectToolRegistrars("typo,typo,also_bad,typo", STUB_REGISTRARS);
    expect(selected).toEqual([]);
    expect(unknown).toEqual(["typo", "also_bad"]);
  });

  test("case-sensitive match → wrong casing is unknown and not registered", () => {
    const { selected, unknown } = selectToolRegistrars(
      "Git_Status,git_log,GIT_DIFF",
      STUB_REGISTRARS,
    );
    expect(selected.map((r) => r.name)).toEqual(["git_log"]);
    expect(unknown).toEqual(["Git_Status", "GIT_DIFF"]);
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
  test("unset RETHUNK_GIT_TOOLS → all 31 tools registered in canonical order", () => {
    withEnv(undefined, () => {
      const tools = captureToolDefinitions(registerRethunkGitTools);
      expect(tools.map((t) => t.name)).toEqual([...ALL_TOOL_NAMES]);
    });
  });

  test('RETHUNK_GIT_TOOLS="*" → all 31 tools registered', () => {
    withEnv("*", () => {
      const tools = captureToolDefinitions(registerRethunkGitTools);
      expect(tools.map((t) => t.name)).toEqual([...ALL_TOOL_NAMES]);
    });
  });

  test("subset RETHUNK_GIT_TOOLS → only listed tools registered", () => {
    withEnv("git_status,git_diff_summary,batch_commit", () => {
      const tools = captureToolDefinitions(registerRethunkGitTools);
      expect(tools.map((t) => t.name)).toEqual(["git_status", "git_diff_summary", "batch_commit"]);
    });
  });

  test("all-unknown RETHUNK_GIT_TOOLS → zero tools registered", () => {
    withEnv("not_a_tool", () => {
      const tools = captureToolDefinitions(registerRethunkGitTools);
      expect(tools).toEqual([]);
    });
  });

  test("presets resource always registered under subset allowlist", () => {
    withEnv("git_status", () => {
      const { tools, resources } = captureToolsAndResources(registerRethunkGitTools);
      expect(tools.map((t) => t.name)).toEqual(["git_status"]);
      expect(resources.some((r) => r.uri === "rethunk-git://presets")).toBe(true);
    });
  });

  test("presets resource always registered when allowlist yields zero tools", () => {
    withEnv("not_a_tool", () => {
      const { tools, resources } = captureToolsAndResources(registerRethunkGitTools);
      expect(tools).toEqual([]);
      expect(resources.some((r) => r.uri === "rethunk-git://presets")).toBe(true);
    });
  });

  test("mixed-unknown env writes stderr warning listing unknowns", () => {
    withEnv("git_status,typo_tool,git_log", () => {
      const writes = withStderrCapture(() => {
        captureToolDefinitions(registerRethunkGitTools);
      });
      const joined = writes.join("");
      expect(joined).toContain("unknown tool name(s) ignored");
      expect(joined).toContain('"typo_tool"');
      expect(joined).not.toContain("registering NO tools");
    });
  });

  test("all-unknown env writes stderr warning about empty tool surface", () => {
    withEnv("not_a_tool", () => {
      const writes = withStderrCapture(() => {
        captureToolDefinitions(registerRethunkGitTools);
      });
      const joined = writes.join("");
      expect(joined).toContain("unknown tool name(s) ignored");
      expect(joined).toContain('"not_a_tool"');
      expect(joined).toContain("registering NO tools");
    });
  });

  test("declared tool names match actual addTool names — drift guard", () => {
    withEnv(undefined, () => {
      const tools = captureToolDefinitions(registerRethunkGitTools);
      const captured = new Set(tools.map((t) => t.name));
      const declared = new Set<string>(ALL_TOOL_NAMES);
      // Every declared name must appear as a real addTool call.
      for (const name of declared) {
        expect(captured.has(name)).toBe(true);
      }
      // Every captured name must appear in our declared list.
      for (const name of captured) {
        expect(declared.has(name)).toBe(true);
      }
    });
  });
});
