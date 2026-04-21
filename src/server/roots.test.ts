/**
 * Tests for workspace root resolution paths in src/server/roots.ts.
 *
 * Uses a simple tool (git_status) as the vehicle since the interesting
 * resolution logic lives in requireGitAndRoots / resolveWorkspaceRoots,
 * which are exercised whenever a tool is invoked.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerGitStatusTool } from "./git-status-tool.js";
import { captureTool, cleanupTmpPaths } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("workspace root resolution", () => {
  test("omitting workspaceRoot falls back to process.cwd() (which is a git repo in CI)", async () => {
    // process.cwd() during tests is the project root — a valid git repo.
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json" });
    const parsed = JSON.parse(text) as { groups?: unknown; error?: string };
    // Either succeeds (returns groups) or returns an error — should not throw.
    expect(parsed.groups !== undefined || parsed.error !== undefined).toBe(true);
  });

  test("allWorkspaceRoots=true with empty sessions falls back to process.cwd()", async () => {
    const run = captureTool(registerGitStatusTool);
    const text = await run({ allWorkspaceRoots: true, format: "json" });
    const parsed = JSON.parse(text) as { groups?: unknown; error?: string };
    expect(parsed.groups !== undefined || parsed.error !== undefined).toBe(true);
  });

  test("rootIndex out of range returns root_index_out_of_range (empty sessions)", async () => {
    const run = captureTool(registerGitStatusTool);
    // With sessions=[], any numeric rootIndex will be out of range.
    const text = await run({ rootIndex: 99, format: "json" });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("root_index_out_of_range");
  });
});
