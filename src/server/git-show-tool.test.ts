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
      workspaceRoot: repo,
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
      workspaceRoot: repo,
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
      workspaceRoot: repo,
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
      workspaceRoot: "/nonexistent/path",
      ref: "HEAD",
    });

    expect(result).toContain("not_a_git_repository");
  });

  test("git show invalid ref returns error", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "invalid-ref-xyz",
    });

    expect(result).toContain("git_show_failed");
  });

  test("git show with path includes path in JSON", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
      path: "file.txt",
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.path).toBe("file.txt");
    expect(parsed.ref).toBe("HEAD");
  });

  test("git show rejects leading-dash ref injection", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "--output=/tmp/x",
    });

    expect(result).toContain("unsafe_ref_token");
  });

  test("git show rejects path that escapes repo", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
      path: "../../etc/passwd",
    });

    expect(result).toContain("path_escapes_repo");
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
      workspaceRoot: repo,
      ref: "HEAD",
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.message).toContain("feat: add file");
    expect(parsed.message).toContain("detailed description");
  });

  test("git show stat:true returns diffstat not full patch", async () => {
    const repo = makeRepo();
    addCommit(repo, "alpha.ts", "const x = 1;\n", "feat: add alpha");
    addCommit(repo, "beta.ts", "const y = 2;\n", "feat: add beta");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
      stat: true,
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.stat).toBe(true);
    expect(parsed.message).toContain("feat: add beta");
    // statOutput should be present (contains the diffstat summary line)
    expect(typeof parsed.statOutput).toBe("string");
    expect(parsed.statOutput).toContain("changed");
    // Full patch content should NOT appear in statOutput
    expect(parsed.statOutput ?? "").not.toContain("diff --git");
    expect(parsed.diff).toBeUndefined();
  });

  test("git show paths[] filters diff to specified files", async () => {
    const repo = makeRepo();
    // Commit two files in one commit
    writeFileSync(join(repo, "a.txt"), "aaa\n");
    writeFileSync(join(repo, "b.txt"), "bbb\n");
    gitCmd(repo, "add", "a.txt", "b.txt");
    gitCmd(repo, "commit", "-m", "feat: add a and b");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
      paths: ["a.txt"],
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.paths).toEqual(["a.txt"]);
    // Diff should mention a.txt but NOT b.txt
    expect(parsed.diff).toContain("a.txt");
    expect(parsed.diff ?? "").not.toContain("b.txt");
  });

  test("git show rejects path in paths[] that escapes repo", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
      paths: ["safe.txt", "../../etc/shadow"],
    });

    expect(result).toContain("path_escapes_repo");
  });
});
