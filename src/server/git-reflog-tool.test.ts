/**
 * Integration tests for git_reflog_tool.
 *
 * Tests create throwaway git repos via `git init` in OS temp dirs
 * and exercise git reflog for HEAD movement history.
 *
 * We test:
 *  1. Happy path: repo with commits + a reset — assert reflog entries present
 *  2. maxEntries cap — assert only N entries returned
 *  3. Unsafe ref rejection — assert unsafe_ref_token error
 *  4. not_a_git_repository error for non-git path
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerGitReflogTool } from "./git-reflog-tool.js";
import { addCommit, captureTool, cleanupTmpPaths, gitCmd, makeRepo } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_reflog_tool", () => {
  test("happy path: reflog after commits and reset contains HEAD@{0}", async () => {
    const repo = makeRepo();
    addCommit(repo, "a.txt", "alpha\n", "feat: add alpha");
    addCommit(repo, "b.txt", "beta\n", "feat: add beta");
    // Soft-reset so reflog records the reset movement
    gitCmd(repo, "reset", "--soft", "HEAD~1");

    const tool = captureTool(registerGitReflogTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.ref).toBe("HEAD");
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(1);

    const first = parsed.entries[0];
    expect(first.selector).toBe("HEAD@{0}");
    expect(typeof first.sha).toBe("string");
    expect(first.sha.length).toBe(40);
    expect(typeof first.message).toBe("string");
    expect(first.message.length).toBeGreaterThan(0);
  });

  test("maxEntries cap limits returned entries", async () => {
    const repo = makeRepo();
    // Create 5 commits so reflog has at least 5 entries
    for (let i = 1; i <= 5; i++) {
      addCommit(repo, `file${i}.txt`, `content ${i}\n`, `feat: commit ${i}`);
    }

    const tool = captureTool(registerGitReflogTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
      maxEntries: 2,
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.entries.length).toBeLessThanOrEqual(2);
  });

  test("unsafe ref injection returns unsafe_ref_token error", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitReflogTool);

    // Leading dash injection attempt
    const result1 = await tool({
      workspaceRoot: repo,
      ref: "--output=/x",
    });
    expect(result1).toContain("unsafe_ref_token");

    // Double-dot traversal attempt
    const result2 = await tool({
      workspaceRoot: repo,
      ref: "..bad",
    });
    expect(result2).toContain("unsafe_ref_token");
  });

  test("not_a_git_repository error for non-git path", async () => {
    const tool = captureTool(registerGitReflogTool);
    const result = await tool({
      workspaceRoot: "/nonexistent/path",
      ref: "HEAD",
    });

    expect(result).toContain("not_a_git_repository");
  });

  test("markdown format renders selector and sha", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitReflogTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
      format: "markdown",
    });

    expect(result).toContain("# git reflog (HEAD)");
    expect(result).toContain("HEAD@{0}");
  });

  test("returns reflog_failed for an unknown ref", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitReflogTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "no-such-branch-xyz",
      format: "json",
    });

    const parsed = JSON.parse(result) as { error: string; detail?: string };
    expect(parsed.error).toBe("reflog_failed");
    expect(typeof parsed.detail).toBe("string");
    expect(parsed.detail!.length).toBeGreaterThan(0);
  });

  test("returns branch-scoped reflog entries when ref is a branch name", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");
    gitCmd(repo, "checkout", "-b", "feature");
    addCommit(repo, "feature.txt", "feature\n", "feat: on feature");

    const tool = captureTool(registerGitReflogTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "feature",
      format: "json",
    });

    const parsed = JSON.parse(result) as {
      ref: string;
      entries: Array<{ selector: string; message: string }>;
    };

    expect(parsed.ref).toBe("feature");
    expect(parsed.entries.length).toBeGreaterThanOrEqual(1);
    expect(parsed.entries[0]?.selector).toMatch(/^feature@\{\d+\}$/);
    expect(parsed.entries[0]?.message.length).toBeGreaterThan(0);
  });
});
