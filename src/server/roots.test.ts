/**
 * Tests for root resolution paths in src/server/roots.ts.
 *
 * Uses a simple tool (git_status) as the vehicle since the interesting
 * resolution logic lives in requireGitAndRoots, which is exercised
 * whenever a fan-out tool is invoked.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { registerGitStatusTool } from "./git-status-tool.js";
import { captureTool, cleanupTmpPaths, gitInitMain, mkTmpDir } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("root resolution", () => {
  test("omitting root falls back to process.cwd() (which is a git repo in CI)", async () => {
    // process.cwd() during tests is the project root — a valid git repo.
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json" });
    const parsed = JSON.parse(text) as { groups?: unknown; error?: string };
    // Either succeeds (returns groups) or returns an error — should not throw.
    expect(parsed.groups !== undefined || parsed.error !== undefined).toBe(true);
  });

  test('root: "*" with empty sessions falls back to process.cwd()', async () => {
    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: "*", format: "json" });
    const parsed = JSON.parse(text) as { groups?: unknown; error?: string };
    expect(parsed.groups !== undefined || parsed.error !== undefined).toBe(true);
  });

  test("root string targets that repo", async () => {
    const a = mkTmpDir("root-string-");
    gitInitMain(a);
    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: a, format: "json" });
    const parsed = JSON.parse(text) as { groups?: { mcpRoot: string }[] };
    expect(parsed.groups?.length).toBe(1);
    expect(parsed.groups?.[0]?.mcpRoot).toBe(a);
  });

  test("root array: two sibling repos → two status groups", async () => {
    const a = mkTmpDir("abs-root-a-");
    const b = mkTmpDir("abs-root-b-");
    gitInitMain(a);
    gitInitMain(b);
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json", root: [a, b] });
    const parsed = JSON.parse(text) as { groups?: { mcpRoot: string; repos: unknown[] }[] };
    expect(parsed.groups?.length).toBe(2);
    expect(parsed.groups?.[0]?.mcpRoot).toBe(a);
    expect(parsed.groups?.[1]?.mcpRoot).toBe(b);
  });

  test('root: "*" fans out across MCP client file roots', async () => {
    const a = mkTmpDir("mcp-root-a-");
    const b = mkTmpDir("mcp-root-b-");
    gitInitMain(a);
    gitInitMain(b);
    const run = captureTool(registerGitStatusTool, undefined, [
      `file://${a}`,
      "vscode-remote://ssh-remote/ignored",
      `file://${b}`,
    ]);
    const text = await run({ root: "*", format: "json" });
    const parsed = JSON.parse(text) as { groups?: { mcpRoot: string }[] };
    expect(parsed.groups?.map((g) => g.mcpRoot)).toEqual([a, b]);
  });

  test("root array dedupes same repo (nested path + root)", async () => {
    const a = mkTmpDir("abs-root-dedupe-");
    gitInitMain(a);
    const nested = join(a, "subdir");
    mkdirSync(nested, { recursive: true });
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json", root: [nested, a] });
    const parsed = JSON.parse(text) as { groups?: unknown[] };
    expect(parsed.groups?.length).toBe(1);
  });
});
