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
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitBlameTool } from "./git-blame-tool.js";
import {
  addCommit,
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepo,
  mkTmpDir,
  writeTestGitConfig,
} from "./test-harness.js";

interface BlameGroupJson {
  sha: string;
  author: string;
  authorMail?: string;
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

  test("accepts ancestor notation (HEAD~1) as ref", async () => {
    const repo = makeRepo();
    addCommit(repo, "hello.txt", "line one\n", "feat: add hello");
    addCommit(repo, "hello.txt", "line one\nline two\n", "feat: add line two");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "hello.txt",
      ref: "HEAD~1",
      format: "json",
    });

    const parsed = JSON.parse(result) as { ref?: string; groups: BlameGroupJson[] };
    expect(parsed.ref).toBe("HEAD~1");
    // At HEAD~1 the file only had "line one" — blaming it should not fail.
    expect(parsed.groups.length).toBe(1);
    expect(parsed.groups[0]?.summary).toBe("feat: add hello");
  });

  test("rejects unsafe ref token", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "file.txt",
      ref: "--output=/tmp/x",
      format: "json",
    });

    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("only startLine set returns invalid_line_range", async () => {
    const repo = makeRepo();
    addCommit(repo, "hello.txt", "a\nb\n", "feat: add hello");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "hello.txt",
      startLine: 1,
      format: "json",
    });

    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBe("invalid_line_range");
  });

  test("startLine > endLine returns invalid_line_range", async () => {
    const repo = makeRepo();
    addCommit(repo, "hello.txt", "a\nb\n", "feat: add hello");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({
      workspaceRoot: repo,
      path: "hello.txt",
      startLine: 3,
      endLine: 1,
      format: "json",
    });

    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBe("invalid_line_range");
  });

  test("groups include authorMail from the porcelain author-mail line", async () => {
    const repo = makeRepo();
    addCommit(repo, "hello.txt", "line one\n", "feat: add hello");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({ workspaceRoot: repo, path: "hello.txt", format: "json" });

    const parsed = JSON.parse(result) as { groups: BlameGroupJson[] };
    expect(parsed.groups[0]?.authorMail).toBe("test@example.com");
  });

  test("accepts a 64-hex SHA-256 object name from a sha256-format repo", async () => {
    const dir = mkTmpDir("mcp-blame-sha256-");
    gitCmd(dir, "init", "--object-format=sha256", "-b", "main");
    writeTestGitConfig(dir);
    writeFileSync(join(dir, "hello.txt"), "line one\n");
    gitCmd(dir, "add", "hello.txt");
    gitCmd(dir, "commit", "-m", "feat: add hello (sha256 repo)");

    const tool = captureTool(registerGitBlameTool);
    const result = await tool({ workspaceRoot: dir, path: "hello.txt", format: "json" });

    const parsed = JSON.parse(result) as { groups: BlameGroupJson[] };
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ignoreWhitespace (-w) ignores a whitespace-only change when assigning blame", async () => {
    const repo = makeRepo();
    addCommit(repo, "ws.txt", "const x = 1;\n", "feat: initial");
    // Reindent only (whitespace-only change) in a second commit.
    addCommit(repo, "ws.txt", "  const x = 1;\n", "chore: reindent");

    const tool = captureTool(registerGitBlameTool);
    const withoutFlag = JSON.parse(
      await tool({ workspaceRoot: repo, path: "ws.txt", format: "json" }),
    ) as { groups: BlameGroupJson[] };
    const withFlag = JSON.parse(
      await tool({
        workspaceRoot: repo,
        path: "ws.txt",
        ignoreWhitespace: true,
        format: "json",
      }),
    ) as { groups: BlameGroupJson[] };

    // Without -w, the reindent commit owns the line; with -w, blame attributes
    // it back to the original commit that introduced the (whitespace-insensitive) content.
    expect(withoutFlag.groups[0]?.summary).toBe("chore: reindent");
    expect(withFlag.groups[0]?.summary).toBe("feat: initial");
  });

  test("subprocess-level buffer truncation returns partial groups + truncated:true, not git_blame_failed", async () => {
    const repo = makeRepo();
    const bigLines = Array.from({ length: 200 }, (_, i) => `line-${i}-${"z".repeat(30)}`).join(
      "\n",
    );
    addCommit(repo, "big.txt", `${bigLines}\n`, "feat: add big file");

    const prevEnv = process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES;
    process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES = "1024";
    try {
      const tool = captureTool(registerGitBlameTool);
      const result = await tool({ workspaceRoot: repo, path: "big.txt", format: "json" });
      const parsed = JSON.parse(result) as {
        error?: string;
        truncated?: boolean;
        groups?: BlameGroupJson[];
      };

      expect(parsed.error).toBeUndefined();
      expect(parsed.truncated).toBe(true);
      expect(Array.isArray(parsed.groups)).toBe(true);
    } finally {
      if (prevEnv === undefined) delete process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES;
      else process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES = prevEnv;
    }
  });
});
