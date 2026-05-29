/**
 * Integration tests for git_blame_tool.
 *
 * Tests create throwaway git repos via `git init` in OS temp dirs
 * and exercise git blame on committed files.
 *
 * We test:
 *  1. Happy path blame of a committed file (author, sha, content)
 *  2. -L range narrows output to the requested lines only
 *  3. Path-escape rejection (../../etc/passwd)
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerGitBlameTool } from "./git-blame-tool.js";
import { addCommit, captureTool, cleanupTmpPaths, makeRepo } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_blame_tool", () => {
  test("blame of a committed file returns author, sha, and content", async () => {
    const repo = makeRepo();
    addCommit(repo, "hello.txt", "line one\nline two\n", "feat: add hello");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "hello.txt",
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.path).toBe("hello.txt");
    expect(Array.isArray(parsed.lines)).toBe(true);
    expect(parsed.lines.length).toBe(2);

    const first = parsed.lines[0];
    expect(typeof first.sha).toBe("string");
    expect(first.sha).toHaveLength(40);
    expect(first.author).toBe("Test User");
    expect(first.content).toBe("line one");
    expect(first.line).toBe(1);
    expect(typeof first.date).toBe("string");
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.summary).toBe("feat: add hello");
  });

  test("-L range narrows blame output to the specified lines", async () => {
    const repo = makeRepo();
    addCommit(repo, "multi.txt", "alpha\nbeta\ngamma\ndelta\n", "feat: add multi");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "multi.txt",
      startLine: 2,
      endLine: 3,
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.lines.length).toBe(2);
    expect(parsed.lines[0].line).toBe(2);
    expect(parsed.lines[0].content).toBe("beta");
    expect(parsed.lines[1].line).toBe(3);
    expect(parsed.lines[1].content).toBe("gamma");
  });

  test("path-escape attempt returns path_escapes_repo error", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "../../etc/passwd",
    });

    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("path_escapes_repo");
  });
});
