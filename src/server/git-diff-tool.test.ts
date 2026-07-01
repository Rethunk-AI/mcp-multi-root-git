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

  test("multi-path diff scopes output to both specified files", async () => {
    const repo = makeRepoWithSeed("mcp-git-diff-test-");
    // Create two additional files and commit them
    addCommit(repo, "alpha.txt", "alpha\n", "chore: alpha");
    addCommit(repo, "beta.txt", "beta\n", "chore: beta");
    // Record the SHA before making unstaged changes
    appendFileSync(join(repo, "alpha.txt"), "alpha-changed\n");
    appendFileSync(join(repo, "beta.txt"), "beta-changed\n");
    appendFileSync(join(repo, "seed.txt"), "seed-changed\n");
    const run = captureTool(registerGitDiffTool);

    const text = await run({
      workspaceRoot: repo,
      paths: ["alpha.txt", "beta.txt"],
      format: "json",
    });
    const parsed = JSON.parse(text) as { range: string; diff: string };

    // Range label should list both paths
    expect(parsed.range).toBe("unstaged changes (alpha.txt, beta.txt)");
    // Diff includes changes to alpha and beta but NOT seed
    expect(parsed.diff).toContain("alpha-changed");
    expect(parsed.diff).toContain("beta-changed");
    expect(parsed.diff).not.toContain("seed-changed");
  });

  test("unified: 0 suppresses context lines around change", async () => {
    const repo = makeRepoWithSeed("mcp-git-diff-test-");
    // Create a multi-line file where neighbors are clearly identifiable
    const lines = ["line1", "line2", "line3", "CHANGE_ME", "line5", "line6", "line7"].join("\n");
    addCommit(repo, "multi.txt", `${lines}\n`, "chore: multi");
    // Replace only the middle line
    const changed = ["line1", "line2", "line3", "CHANGED", "line5", "line6", "line7"].join("\n");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(repo, "multi.txt"), `${changed}\n`);
    const run = captureTool(registerGitDiffTool);

    const text = await run({ workspaceRoot: repo, unified: 0, format: "json" });
    const parsed = JSON.parse(text) as { range: string; diff: string };

    // The change must appear
    expect(parsed.diff).toContain("CHANGED");
    // With unified=0, neighboring lines must not appear as context lines
    // (git context lines start with a literal space character followed by the line content)
    const contextLines = parsed.diff
      .split("\n")
      .filter((l: string) => l.startsWith(" ") && !l.startsWith(" @"));
    expect(contextLines.some((l: string) => l.includes("line3"))).toBe(false);
    expect(contextLines.some((l: string) => l.includes("line5"))).toBe(false);
  });

  test("path escape via paths array returns path_escapes_repo", async () => {
    const repo = makeRepoWithSeed("mcp-git-diff-test-");
    const run = captureTool(registerGitDiffTool);

    const text = await run({
      workspaceRoot: repo,
      paths: ["../../etc/passwd"],
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string; path: string };

    expect(parsed.error).toBe("path_escapes_repo");
    expect(parsed.path).toBe("../../etc/passwd");
  });
});
