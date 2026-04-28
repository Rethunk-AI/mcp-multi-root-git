/**
 * Integration tests for git_show_tool.
 *
 * Tests create throwaway git repos via `git init` in OS temp dirs
 * and exercise git show for commits and file inspection.
 *
 * We test:
 *  1. git show on a commit ref returns message + diff
 *  2. git show with a path returns file content at that ref
 *  3. commit message is correctly extracted from git show output
 *  4. not_a_git_repository error for non-git path
 *  5. invalid ref error handling
 *  6. JSON format output
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitShowTool } from "./git-show-tool.js";
import { addCommit, captureTool, cleanupTmpPaths, gitCmd, makeRepo } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_show_tool", () => {
  test("git show on a commit returns message + diff", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      wd: repo,
      ref: "HEAD",
      format: "markdown",
    });

    // Result should contain commit message and diff info
    expect(result).toContain("feat: add file");
    expect(result).toContain("git show HEAD");
  });

  test("git show with path shows file content at ref", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "first content\n", "feat: add file");
    addCommit(repo, "file.txt", "second content\n", "fix: update file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      wd: repo,
      ref: "HEAD~1",
      path: "file.txt",
      format: "markdown",
    });

    // Result should contain the file path and content from the previous commit
    expect(result).toContain("file.txt");
    expect(result).toContain("first content");
  });

  test("git show returns JSON format", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      wd: repo,
      ref: "HEAD",
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.ref).toBe("HEAD");
    expect(parsed.message).toContain("feat: add file");
    expect(typeof parsed.diff).toBe("string");
  });

  test("git show not_a_git_repository error for invalid path", async () => {
    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      wd: "/nonexistent/path",
      ref: "HEAD",
    });

    expect(result).toContain("not_a_git_repository");
  });

  test("git show invalid ref returns error", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      wd: repo,
      ref: "invalid-ref-xyz",
    });

    expect(result).toContain("git_show_failed");
  });

  test("git show with path includes path in JSON", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      wd: repo,
      ref: "HEAD",
      path: "file.txt",
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.path).toBe("file.txt");
    expect(parsed.ref).toBe("HEAD");
  });

  test("git show commit message with multiline content", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "content\n");
    gitCmd(repo, "add", "file.txt");
    gitCmd(
      repo,
      "commit",
      "-m",
      "feat: add file\n\nThis is a detailed description\nof the feature.",
    );

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      wd: repo,
      ref: "HEAD",
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.message).toContain("feat: add file");
    expect(parsed.message).toContain("detailed description");
  });
});
