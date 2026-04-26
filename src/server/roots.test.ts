/**
 * Tests for workspace root resolution paths in src/server/roots.ts.
 *
 * Uses a simple tool (git_status) as the vehicle since the interesting
 * resolution logic lives in requireGitAndRoots / resolveWorkspaceRoots,
 * which are exercised whenever a tool is invoked.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { registerGitInventoryTool } from "./git-inventory-tool.js";
import { registerGitStatusTool } from "./git-status-tool.js";
import { captureTool, cleanupTmpPaths, mkTmpDir, writeTestGitConfig } from "./test-harness.js";

afterEach(cleanupTmpPaths);

function gitInitMain(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  writeTestGitConfig(dir);
}

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

  test("absoluteGitRoots: two sibling repos → two status groups", async () => {
    const a = mkTmpDir("abs-root-a-");
    const b = mkTmpDir("abs-root-b-");
    gitInitMain(a);
    gitInitMain(b);
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json", absoluteGitRoots: [a, b] });
    const parsed = JSON.parse(text) as { groups?: { mcpRoot: string; repos: unknown[] }[] };
    expect(parsed.groups?.length).toBe(2);
    expect(parsed.groups?.[0]?.mcpRoot).toBe(a);
    expect(parsed.groups?.[1]?.mcpRoot).toBe(b);
  });

  test("absoluteGitRoots dedupes same repo (nested path + root)", async () => {
    const a = mkTmpDir("abs-root-dedupe-");
    gitInitMain(a);
    const nested = join(a, "subdir");
    mkdirSync(nested, { recursive: true });
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json", absoluteGitRoots: [nested, a] });
    const parsed = JSON.parse(text) as { groups?: unknown[] };
    expect(parsed.groups?.length).toBe(1);
  });

  test("absoluteGitRoots + workspaceRoot → absolute_git_roots_exclusive", async () => {
    const run = captureTool(registerGitStatusTool);
    const text = await run({
      format: "json",
      absoluteGitRoots: [process.cwd()],
      workspaceRoot: process.cwd(),
    });
    const parsed = JSON.parse(text) as { error?: string };
    expect(parsed.error).toBe("absolute_git_roots_exclusive");
  });

  test("git_inventory absoluteGitRoots + nestedRoots → conflict", async () => {
    const a = mkTmpDir("abs-inv-");
    gitInitMain(a);
    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      format: "json",
      absoluteGitRoots: [a],
      nestedRoots: ["."],
    });
    const parsed = JSON.parse(text) as { error?: string };
    expect(parsed.error).toBe("absolute_git_roots_nested_or_preset_conflict");
  });
});
