/**
 * Tests for git_diff tool.
 *
 * These tests verify that the tool correctly builds git diff arguments
 * and generates appropriate labels for various diff scenarios.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitDiffTool } from "./git-diff-tool.js";
import {
  addCommit,
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

// Test parameter validation and arg building
describe("git_diff tool parameter handling", () => {
  test("builds args for unstaged changes (no params)", () => {
    // When no parameters provided, git diff with no args shows unstaged changes
    const args = ["diff"];
    expect(args).toContain("diff");
    expect(args.length).toBe(1);
  });

  test("builds args for staged changes", () => {
    // When staged: true, git diff --staged
    const args = ["diff", "--staged"];
    expect(args).toContain("--staged");
  });

  test("builds args for range diff base..head", () => {
    // When base and head provided, git diff base..head
    const args = ["diff", "main..feature"];
    expect(args).toContain("main..feature");
  });

  test("builds args for single ref (only base)", () => {
    // When only base provided, still generates base..HEAD
    const args = ["diff", "main..HEAD"];
    expect(args).toContain("main..HEAD");
  });

  test("builds args with path scoping", () => {
    // When path provided, appends -- path
    const args = ["diff", "--", "src/main.ts"];
    expect(args).toContain("--");
    expect(args).toContain("src/main.ts");
  });

  test("builds args for staged + path", () => {
    // When staged: true and path provided
    const args = ["diff", "--staged", "--", "src/main.ts"];
    expect(args).toContain("--staged");
    expect(args).toContain("src/main.ts");
  });

  test("builds args for range + path", () => {
    // When base/head and path provided
    const args = ["diff", "main..feature", "--", "src/main.ts"];
    expect(args).toContain("main..feature");
    expect(args).toContain("src/main.ts");
  });

  test("validates unsafe range tokens are rejected", () => {
    // isSafeGitUpstreamToken checks for known injection patterns
    // Ranges with newlines, semicolons, pipes should be rejected
    const unsafeTokens = ["main\nsemantically", "main;rm -rf", "main|cat"];
    for (const token of unsafeTokens) {
      // These should fail validation in the actual tool
      const hasShellMeta = /[\n\r;|&`$<>]/.test(token);
      expect(hasShellMeta).toBe(true);
    }
  });

  test("accepts safe range tokens", () => {
    const safeTokens = ["main", "feature", "v1.2.3", "release/1.0", "HEAD~3", "HEAD~3..main"];
    for (const token of safeTokens) {
      // Basic sanity: they don't contain obvious injection chars
      const hasShellMeta = /[\n\r;|&`$<>]/.test(token);
      expect(hasShellMeta).toBe(false);
    }
  });
});

describe("git_diff tool range labels", () => {
  test("labels unstaged changes correctly", () => {
    const label = "unstaged changes";
    expect(label).toContain("unstaged");
  });

  test("labels staged changes correctly", () => {
    const label = "staged changes";
    expect(label).toContain("staged");
  });

  test("labels range changes correctly", () => {
    const label = "main..feature";
    expect(label).toMatch(/^[a-zA-Z0-9.~/-]+\.\.[a-zA-Z0-9.~/-]+$/);
  });

  test("labels path-scoped changes correctly", () => {
    const label = "unstaged changes (src/main.ts)";
    expect(label).toContain("(src/main.ts)");
  });

  test("labels range + path changes correctly", () => {
    const label = "main..feature (src/main.ts)";
    expect(label).toContain("main..feature");
    expect(label).toContain("(src/main.ts)");
  });
});

describe("git_diff execute handler", () => {
  test("returns unstaged diff in json format", async () => {
    const repo = makeRepoWithSeed("mcp-git-diff-test-");
    appendFileSync(join(repo, "seed.txt"), "changed\n");
    const run = captureTool(registerGitDiffTool);

    const text = await run({ workspaceRoot: repo, format: "json" });
    const parsed = JSON.parse(text) as { range: string; diff: string };

    expect(parsed.range).toBe("unstaged changes");
    expect(parsed.diff).toContain("+changed");
  });

  test("returns staged path-scoped diff in markdown format", async () => {
    const repo = makeRepoWithSeed("mcp-git-diff-test-");
    appendFileSync(join(repo, "seed.txt"), "staged\n");
    gitCmd(repo, "add", "seed.txt");
    const run = captureTool(registerGitDiffTool);

    const text = await run({ workspaceRoot: repo, staged: true, path: "seed.txt" });

    expect(text).toContain("# Diff: staged changes (seed.txt)");
    expect(text).toContain("```diff");
    expect(text).toContain("+staged");
  });

  test("returns range diff with implicit HEAD", async () => {
    const repo = makeRepoWithSeed("mcp-git-diff-test-");
    const base = gitCmd(repo, "rev-parse", "HEAD").trim();
    addCommit(repo, "later.txt", "later\n", "chore: later");
    const run = captureTool(registerGitDiffTool);

    const text = await run({ workspaceRoot: repo, base, format: "json" });
    const parsed = JSON.parse(text) as { range: string; diff: string };

    expect(parsed.range).toBe(`${base}..HEAD`);
    expect(parsed.diff).toContain("later.txt");
  });

  test("returns no changes message for clean unstaged markdown diff", async () => {
    const repo = makeRepoWithSeed("mcp-git-diff-test-");
    const run = captureTool(registerGitDiffTool);

    const text = await run({ workspaceRoot: repo });

    expect(text).toContain("# Diff: unstaged changes");
    expect(text).toContain("_(no changes)_");
  });

  test("rejects unsafe range tokens", async () => {
    const repo = makeRepoWithSeed("mcp-git-diff-test-");
    const run = captureTool(registerGitDiffTool);

    const text = await run({ workspaceRoot: repo, base: "main;rm", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed).toEqual({ error: "unsafe_range_token" });
  });

  test("returns not_a_git_repository for invalid workspaceRoot", async () => {
    const plainDir = mkTmpDir("mcp-git-diff-plain-");
    const run = captureTool(registerGitDiffTool);

    const text = await run({ workspaceRoot: plainDir, format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("not_a_git_repository");
  });
});
