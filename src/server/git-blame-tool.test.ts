/**
 * Integration tests for git_blame_tool.
 *
 * Tests create throwaway git repos via `git init` in OS temp dirs
 * and exercise git blame on committed files.
 *
 * We test:
 *  1. Happy path blame of a committed file (grouped run-length output)
 *  2. Multi-commit file splits into one group per contiguous run
 *  3. -L range narrows output to the requested lines only
 *  4. maxLines truncation signals truncated/omittedLines
 *  5. Path-escape rejection (../../etc/passwd)
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerGitBlameTool } from "./git-blame-tool.js";
import { addCommit, captureTool, cleanupTmpPaths, makeRepo } from "./test-harness.js";

interface BlameGroupJson {
  sha: string;
  author: string;
  date: string;
  summary: string;
  startLine: number;
  endLine: number;
  lines: { line: number; content: string }[];
}

describe("git_blame_tool", () => {
  afterEach(cleanupTmpPaths);

  test("blame of a committed file returns one group with author, sha, and lines", async () => {
    const repo = makeRepo();
    addCommit(repo, "hello.txt", "line one\nline two\n", "feat: add hello");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "hello.txt",
      format: "json",
    });

    const parsed = JSON.parse(result) as {
      path: string;
      groups: BlameGroupJson[];
      truncated?: boolean;
    };
    expect(parsed.path).toBe("hello.txt");
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.groups.length).toBe(1);

    const g = parsed.groups[0] as BlameGroupJson;
    expect(g.sha).toHaveLength(40);
    expect(g.author).toBe("Test User");
    expect(g.summary).toBe("feat: add hello");
    expect(g.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(g.startLine).toBe(1);
    expect(g.endLine).toBe(2);
    expect(g.lines).toEqual([
      { line: 1, content: "line one" },
      { line: 2, content: "line two" },
    ]);
  });

  test("two commits produce one group per contiguous run", async () => {
    const repo = makeRepo();
    addCommit(repo, "multi.txt", "alpha\nbeta\n", "feat: first");
    addCommit(repo, "multi.txt", "alpha\nbeta\ngamma\ndelta\n", "feat: second");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({ workspaceRoot: repo, path: "multi.txt", format: "json" });

    const parsed = JSON.parse(result) as { groups: BlameGroupJson[] };
    expect(parsed.groups.length).toBe(2);
    expect(parsed.groups[0]?.summary).toBe("feat: first");
    expect(parsed.groups[0]?.startLine).toBe(1);
    expect(parsed.groups[0]?.endLine).toBe(2);
    expect(parsed.groups[1]?.summary).toBe("feat: second");
    expect(parsed.groups[1]?.startLine).toBe(3);
    expect(parsed.groups[1]?.endLine).toBe(4);
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

    const parsed = JSON.parse(result) as { groups: BlameGroupJson[] };
    expect(parsed.groups.length).toBe(1);
    expect(parsed.groups[0]?.lines).toEqual([
      { line: 2, content: "beta" },
      { line: 3, content: "gamma" },
    ]);
  });

  test("maxLines truncates and reports omittedLines", async () => {
    const repo = makeRepo();
    addCommit(repo, "big.txt", "a\nb\nc\nd\ne\n", "feat: add big");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "big.txt",
      maxLines: 2,
      format: "json",
    });

    const parsed = JSON.parse(result) as {
      groups: BlameGroupJson[];
      truncated?: boolean;
      omittedLines?: number;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.omittedLines).toBe(3);
    expect(parsed.groups.length).toBe(1);
    expect(parsed.groups[0]?.endLine).toBe(2);
  });

  test("path-escape attempt returns path_escapes_repo error", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "../../etc/passwd",
    });

    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBe("path_escapes_repo");
  });
});
