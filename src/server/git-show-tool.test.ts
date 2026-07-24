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
import type { ZodTypeAny } from "zod";

import { registerGitShowTool } from "./git-show-tool.js";
import {
  addCommit,
  captureTool,
  captureToolDefinitions,
  cleanupTmpPaths,
  gitCmd,
  makeRepo,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_show_tool", () => {
  test("git show on a commit returns message + diff", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
    });
    const parsed = JSON.parse(result);

    // Result should contain commit message and diff info
    expect(parsed.message).toContain("feat: add file");
    expect(parsed.ref).toBe("HEAD");
  });

  test("git show with path shows file content at ref", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "first content\n", "feat: add file");
    addCommit(repo, "file.txt", "second content\n", "fix: update file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD~1",
      paths: ["file.txt"],
    });
    const parsed = JSON.parse(result);

    // Result should contain the file path and content from the previous commit
    expect(parsed.paths).toEqual(["file.txt"]);
    expect(parsed.diff).toContain("first content");
  });

  test("git show returns JSON format", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "HEAD",
      paths: ["file.txt"],
      format: "json",
    });

    const parsed = JSON.parse(result);
    expect(parsed.ref).toBe("HEAD");
    expect(parsed.message).toContain("feat: add file");
    expect(typeof parsed.diff).toBe("string");
    expect(parsed.paths).toEqual(["file.txt"]);
  });

  test("git show not_a_git_repository error for invalid path", async () => {
    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: "/nonexistent/path",
      ref: "HEAD",
    });

    expect(result).toContain("not_a_git_repository");
  });

  test("git show invalid ref returns error with detail", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "invalid-ref-xyz",
      format: "json",
    });

    const parsed = JSON.parse(result) as { error: string; detail?: string };
    expect(parsed.error).toBe("git_show_failed");
    expect(typeof parsed.detail).toBe("string");
    expect(parsed.detail?.length).toBeGreaterThan(0);
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

  test("git show rejects double-dot range token (hardening over prior ancestor-ref check)", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");

    const tool = captureTool(registerGitShowTool);
    const result = await tool({
      workspaceRoot: repo,
      ref: "a..b",
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
      paths: ["../../etc/passwd"],
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

  test("paths array schema rejects more than the max cap", () => {
    const def = captureToolDefinitions(registerGitShowTool).find((d) => d.name === "git_show");
    const manyPaths = Array.from({ length: 257 }, (_, i) => `f${i}.txt`);
    const schema = def?.parameters as ZodTypeAny;
    const result = schema.safeParse({ workspaceRoot: "/tmp", ref: "HEAD", paths: manyPaths });
    expect(result.success).toBe(false);
  });

  test("maxBytes truncates oversized diff at a line boundary and sets truncated:true", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "big.txt"),
      `${Array.from({ length: 50 }, (_, i) => `line-${i}-${"y".repeat(30)}`).join("\n")}\n`,
    );
    gitCmd(repo, "add", "big.txt");
    gitCmd(repo, "commit", "-m", "feat: add big file");

    const tool = captureTool(registerGitShowTool);
    const fullText = await tool({ workspaceRoot: repo, ref: "HEAD", format: "json" });
    const fullParsed = JSON.parse(fullText) as { diff: string };
    const fullLines = new Set(fullParsed.diff.split("\n"));

    const text = await tool({ workspaceRoot: repo, ref: "HEAD", format: "json", maxBytes: 1024 });
    const parsed = JSON.parse(text) as { diff: string; truncated?: boolean };

    expect(parsed.truncated).toBe(true);
    expect(Buffer.byteLength(parsed.diff, "utf8")).toBeLessThanOrEqual(1024);
    for (const line of parsed.diff.split("\n")) {
      expect(fullLines.has(line)).toBe(true);
    }
  });

  test("subprocess-level buffer truncation returns partial content + truncated:true, not git_show_failed", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "seed.txt"), `${"z".repeat(4000)}\n`);
    gitCmd(repo, "add", "seed.txt");
    gitCmd(repo, "commit", "-m", "feat: big seed");

    const prevEnv = process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES;
    process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES = "1024";
    try {
      const tool = captureTool(registerGitShowTool);
      const text = await tool({ workspaceRoot: repo, ref: "HEAD", format: "json" });
      const parsed = JSON.parse(text) as { error?: string; truncated?: boolean; message?: string };

      expect(parsed.error).toBeUndefined();
      expect(parsed.truncated).toBe(true);
      expect(typeof parsed.message).toBe("string");
    } finally {
      if (prevEnv === undefined) delete process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES;
      else process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES = prevEnv;
    }
  });

  test("merge commit combined diff (diff --cc) is recognized as diff content, not left in the message", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "shared.txt"), "base\n");
    gitCmd(repo, "add", "shared.txt");
    gitCmd(repo, "commit", "-m", "chore: base");

    gitCmd(repo, "checkout", "-b", "feature");
    writeFileSync(join(repo, "shared.txt"), "base\nfeature-line\n");
    gitCmd(repo, "add", "shared.txt");
    gitCmd(repo, "commit", "-m", "feat: feature line");
    gitCmd(repo, "checkout", "main");

    writeFileSync(join(repo, "shared.txt"), "base\nmain-line\n");
    gitCmd(repo, "add", "shared.txt");
    gitCmd(repo, "commit", "-m", "chore: main line");

    // Resolve the conflict during merge so the merge commit lands cleanly,
    // producing a combined ("diff --cc") patch for the conflicting file.
    try {
      gitCmd(repo, "merge", "feature", "-q", "-m", "merge: combine");
    } catch {
      writeFileSync(join(repo, "shared.txt"), "base\nmain-line\nfeature-line\n");
      gitCmd(repo, "add", "shared.txt");
      gitCmd(repo, "commit", "--no-edit");
    }

    const tool = captureTool(registerGitShowTool);
    const text = await tool({ workspaceRoot: repo, ref: "HEAD", format: "json" });
    const parsed = JSON.parse(text) as { message: string; diff?: string };

    expect(parsed.message).toContain("merge: combine");
    expect(parsed.diff).toBeDefined();
    expect(parsed.diff ?? "").toContain("diff --cc");
    // The combined-diff body must not have leaked into the commit message.
    expect(parsed.message).not.toContain("diff --cc");
  });
});
