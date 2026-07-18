/**
 * Integration tests for git_grep_tool.
 *
 * Tests create throwaway git repos via `git init` in OS temp dirs and exercise
 * content search across working tree and historical refs.
 *
 * We test:
 *  1. Happy path: a match in the working tree — file, line, text asserted
 *  2. No match — empty matches array, no error
 *  3. filesOnly: true — lists matching file paths, no line/text
 *  4. maxMatches truncation — cap applied, truncated: true
 *  5. Path-escape rejection (`paths` outside the repo root)
 *  6. ref-mode search at an older commit
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerGitGrepTool } from "./git-grep-tool.js";
import { addCommit, captureTool, cleanupTmpPaths, gitCmd, makeRepo } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_grep_tool", () => {
  test("happy path: match in working tree returns file, line, text", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "one\nneedle here\nthree\n", "feat: add foo");

    const tool = captureTool(registerGitGrepTool);
    const result = await tool({ root: repo, pattern: "needle", format: "json" });

    const parsed = JSON.parse(result) as {
      results: Array<{
        root: string;
        matches?: Array<{ file: string; line: number; text: string }>;
        truncated?: boolean;
        error?: string;
      }>;
    };

    expect(parsed.results.length).toBe(1);
    const group = parsed.results[0];
    expect(group?.error).toBeUndefined();
    expect(group?.matches?.length).toBe(1);
    expect(group?.matches?.[0]).toEqual({ file: "foo.txt", line: 2, text: "needle here" });
    expect(group?.truncated).toBeUndefined();
  });

  test("no match: empty matches array, no error", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "one\ntwo\nthree\n", "feat: add foo");

    const tool = captureTool(registerGitGrepTool);
    const result = await tool({ root: repo, pattern: "nonexistent-pattern-xyz", format: "json" });

    const parsed = JSON.parse(result) as {
      results: Array<{ matches?: unknown[]; error?: string }>;
    };

    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0]?.error).toBeUndefined();
    expect(parsed.results[0]?.matches).toEqual([]);
  });

  test("filesOnly: lists matching file paths without line/text", async () => {
    const repo = makeRepo();
    addCommit(repo, "a.txt", "needle\n", "feat: a");
    addCommit(repo, "b.txt", "needle again\n", "feat: b");
    addCommit(repo, "c.txt", "nothing\n", "feat: c");

    const tool = captureTool(registerGitGrepTool);
    const result = await tool({
      root: repo,
      pattern: "needle",
      filesOnly: true,
      format: "json",
    });

    const parsed = JSON.parse(result) as {
      results: Array<{ files?: string[]; matches?: unknown }>;
    };

    const group = parsed.results[0];
    expect(group?.matches).toBeUndefined();
    expect(group?.files?.sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("maxMatches: truncates results and sets truncated: true", async () => {
    const repo = makeRepo();
    const content = Array.from({ length: 5 }, (_, i) => `needle ${i}`).join("\n");
    addCommit(repo, "many.txt", `${content}\n`, "feat: many matches");

    const tool = captureTool(registerGitGrepTool);
    const result = await tool({
      root: repo,
      pattern: "needle",
      maxMatches: 2,
      format: "json",
    });

    const parsed = JSON.parse(result) as {
      results: Array<{ matches?: unknown[]; truncated?: boolean }>;
    };

    const group = parsed.results[0];
    expect(group?.matches?.length).toBe(2);
    expect(group?.truncated).toBe(true);
  });

  test("path-escape rejection: paths outside repo root", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "needle\n", "feat: add foo");

    const tool = captureTool(registerGitGrepTool);
    const result = await tool({
      root: repo,
      pattern: "needle",
      paths: ["../../etc/passwd"],
      format: "json",
    });

    expect(result).toContain("path_escapes_repo");
  });

  test("ref-mode: searches the tree at an older commit, not the working tree", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "old-needle\n", "feat: v1");
    const v1Sha = gitCmd(repo, "rev-parse", "HEAD").trim();
    addCommit(repo, "foo.txt", "new-content\n", "feat: v2");

    const tool = captureTool(registerGitGrepTool);

    // Searching HEAD (working tree) for the old content should find nothing.
    const headResult = await tool({ root: repo, pattern: "old-needle", format: "json" });
    const headParsed = JSON.parse(headResult) as { results: Array<{ matches?: unknown[] }> };
    expect(headParsed.results[0]?.matches).toEqual([]);

    // Searching at the v1 ref should find it, with a plain (unprefixed) file path.
    const refResult = await tool({
      root: repo,
      pattern: "old-needle",
      ref: v1Sha,
      format: "json",
    });
    const refParsed = JSON.parse(refResult) as {
      results: Array<{ matches?: Array<{ file: string; line: number; text: string }> }>;
    };
    expect(refParsed.results[0]?.matches).toEqual([
      { file: "foo.txt", line: 1, text: "old-needle" },
    ]);
  });

  test("unsafe ref token rejected", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "needle\n", "feat: add foo");

    const tool = captureTool(registerGitGrepTool);
    const result = await tool({
      root: repo,
      pattern: "needle",
      ref: "--evil",
      format: "json",
    });

    expect(result).toContain("unsafe_ref_token");
  });

  test("markdown output lists match lines per root", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "needle here\n", "feat: add foo");

    const tool = captureTool(registerGitGrepTool);
    const result = await tool({ root: repo, pattern: "needle" });

    expect(result).toContain("# git grep");
    expect(result).toContain("foo.txt:1");
    expect(result).toContain("needle here");
  });

  test("ignoreCase: true matches mixed-case content", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "NeedleHere\n", "feat: add foo");

    const tool = captureTool(registerGitGrepTool);
    const caseSensitive = JSON.parse(
      await tool({ root: repo, pattern: "needlehere", format: "json" }),
    ) as { results: Array<{ matches?: unknown[] }> };
    expect(caseSensitive.results[0]?.matches).toEqual([]);

    const caseInsensitive = JSON.parse(
      await tool({ root: repo, pattern: "needlehere", ignoreCase: true, format: "json" }),
    ) as { results: Array<{ matches?: Array<{ text: string }> }> };
    expect(caseInsensitive.results[0]?.matches?.length).toBe(1);
    expect(caseInsensitive.results[0]?.matches?.[0]?.text).toBe("NeedleHere");
  });

  test("multi-root fan-out returns one results entry per root", async () => {
    const a = makeRepo();
    const b = makeRepo();
    addCommit(a, "a.txt", "needle-a\n", "feat: a");
    addCommit(b, "b.txt", "needle-b\n", "feat: b");

    const tool = captureTool(registerGitGrepTool);
    const parsed = JSON.parse(await tool({ root: [a, b], pattern: "needle", format: "json" })) as {
      results: Array<{ matches?: unknown[] }>;
    };
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results.every((r) => (r.matches?.length ?? 0) >= 1)).toBe(true);
  });

  test("pickaxe S: returns commits that introduced/removed the term", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "alpha\n", "feat: alpha");
    addCommit(repo, "foo.txt", "alpha\nUNIQUE_PICKAXE_TERM\n", "feat: add pickaxe term");
    addCommit(repo, "foo.txt", "alpha\n", "feat: remove pickaxe term");

    const tool = captureTool(registerGitGrepTool);
    const parsed = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "S", term: "UNIQUE_PICKAXE_TERM" },
        format: "json",
      }),
    ) as {
      results: Array<{ commits?: Array<{ sha: string; subject: string }>; matches?: unknown }>;
    };

    const group = parsed.results[0];
    expect(group?.matches).toBeUndefined();
    expect(group?.commits?.length).toBeGreaterThanOrEqual(2);
    const subjects = (group?.commits ?? []).map((c) => c.subject);
    expect(subjects).toContain("feat: add pickaxe term");
    expect(subjects).toContain("feat: remove pickaxe term");
  });

  test("pickaxe without pattern succeeds; neither pattern nor pickaxe fails", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "x\n", "feat: x");

    const tool = captureTool(registerGitGrepTool);
    const ok = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "S", term: "x" },
        format: "json",
      }),
    ) as { results?: unknown[]; error?: string };
    expect(ok.error).toBeUndefined();
    expect(ok.results).toBeDefined();

    const bad = JSON.parse(await tool({ root: repo, format: "json" })) as { error: string };
    expect(bad.error).toBe("pattern_or_pickaxe_required");
  });
});
