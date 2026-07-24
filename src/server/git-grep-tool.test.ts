/**
 * Integration tests for git_grep_tool (pickaxe-only since v6).
 *
 * Tests create throwaway git repos via `git init` in OS temp dirs and exercise
 * pickaxe history search (`git log -S` / `-G`).
 *
 * We test:
 *  1. Pickaxe S: commits that introduced/removed a term
 *  2. Pickaxe G: regex-change history
 *  3. No hits — empty commits array, no error
 *  4. maxMatches truncation — cap applied, truncated: true
 *  5. Path-escape rejection (`paths` outside the repo root)
 *  6. ref limits history to that tip
 *  7. Unsafe ref token rejection
 *  8. Multi-root fan-out
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ZodTypeAny } from "zod";

import { registerGitGrepTool } from "./git-grep-tool.js";
import {
  addCommit,
  captureTool,
  captureToolDefinitions,
  cleanupTmpPaths,
  gitCmd,
  makeRepo,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_grep_tool", () => {
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
      results: Array<{ commits?: Array<{ sha: string; subject: string }>; error?: string }>;
    };

    const group = parsed.results[0];
    expect(group?.error).toBeUndefined();
    expect(group?.commits?.length).toBeGreaterThanOrEqual(2);
    const subjects = (group?.commits ?? []).map((c) => c.subject);
    expect(subjects).toContain("feat: add pickaxe term");
    expect(subjects).toContain("feat: remove pickaxe term");
    for (const c of group?.commits ?? []) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("pickaxe G: matches commits whose diff lines match the regex", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "const alpha = 1;\n", "feat: alpha");
    addCommit(repo, "foo.txt", "const alpha = 1;\nconst beta_42 = 2;\n", "feat: beta");

    const tool = captureTool(registerGitGrepTool);
    const parsed = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "G", term: "beta_[0-9]+" },
        format: "json",
      }),
    ) as { results: Array<{ commits?: Array<{ subject: string }> }> };

    const subjects = (parsed.results[0]?.commits ?? []).map((c) => c.subject);
    expect(subjects).toContain("feat: beta");
    expect(subjects).not.toContain("feat: alpha");
  });

  test("no hits: empty commits array, no error", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "one\n", "feat: add foo");

    const tool = captureTool(registerGitGrepTool);
    const parsed = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "S", term: "nonexistent-term-xyz" },
        format: "json",
      }),
    ) as { results: Array<{ commits?: unknown[]; error?: string }> };

    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0]?.error).toBeUndefined();
    expect(parsed.results[0]?.commits).toEqual([]);
  });

  test("maxMatches: truncates commit list and sets truncated: true", async () => {
    const repo = makeRepo();
    // Each commit grows the occurrence count of "churn" so `-S` hits every one.
    for (let i = 0; i < 4; i++) {
      const content = Array.from({ length: i + 1 }, (_, n) => `churn ${n}`).join("\n");
      addCommit(repo, "many.txt", `${content}\n`, `feat: churn ${i}`);
    }

    const tool = captureTool(registerGitGrepTool);
    const parsed = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "S", term: "churn" },
        maxMatches: 2,
        format: "json",
      }),
    ) as { results: Array<{ commits?: unknown[]; truncated?: boolean }> };

    const group = parsed.results[0];
    expect(group?.commits?.length).toBe(2);
    expect(group?.truncated).toBe(true);
  });

  test("path-escape rejection: paths outside repo root", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "needle\n", "feat: add foo");

    const tool = captureTool(registerGitGrepTool);
    const result = await tool({
      root: repo,
      pickaxe: { mode: "S", term: "needle" },
      paths: ["../../etc/passwd"],
      format: "json",
    });

    expect(result).toContain("path_escapes_repo");
  });

  test("paths scopes pickaxe history to the given file", async () => {
    const repo = makeRepo();
    addCommit(repo, "a.txt", "scoped-term\n", "feat: a");
    addCommit(repo, "b.txt", "scoped-term\n", "feat: b");

    const tool = captureTool(registerGitGrepTool);
    const parsed = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "S", term: "scoped-term" },
        paths: ["a.txt"],
        format: "json",
      }),
    ) as { results: Array<{ commits?: Array<{ subject: string }> }> };

    const subjects = (parsed.results[0]?.commits ?? []).map((c) => c.subject);
    expect(subjects).toContain("feat: a");
    expect(subjects).not.toContain("feat: b");
  });

  test("ref limits history to that tip", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "early-term\n", "feat: early");
    const earlySha = gitCmd(repo, "rev-parse", "HEAD").trim();
    addCommit(repo, "foo.txt", "early-term\nlate-term\n", "feat: late");

    const tool = captureTool(registerGitGrepTool);
    const parsed = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "S", term: "late-term" },
        ref: earlySha,
        format: "json",
      }),
    ) as { results: Array<{ commits?: unknown[] }> };

    // The late-term commit is not reachable from the early tip.
    expect(parsed.results[0]?.commits).toEqual([]);
  });

  test("unsafe ref token rejected", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "needle\n", "feat: add foo");

    const tool = captureTool(registerGitGrepTool);
    const result = await tool({
      root: repo,
      pickaxe: { mode: "S", term: "needle" },
      ref: "--evil",
      format: "json",
    });

    expect(result).toContain("unsafe_ref_token");
  });

  test("multi-root fan-out returns one results entry per root", async () => {
    const a = makeRepo();
    const b = makeRepo();
    addCommit(a, "a.txt", "needle-a\n", "feat: a");
    addCommit(b, "b.txt", "needle-b\n", "feat: b");

    const tool = captureTool(registerGitGrepTool);
    const parsed = JSON.parse(
      await tool({ root: [a, b], pickaxe: { mode: "S", term: "needle" }, format: "json" }),
    ) as { results: Array<{ commits?: unknown[] }> };
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results.every((r) => (r.commits?.length ?? 0) >= 1)).toBe(true);
  });

  test("ignoreCase: false (default) is case-sensitive for G mode regex", async () => {
    const repo = makeRepo();
    addCommit(repo, "foo.txt", "const Widget = 1;\n", "feat: add Widget");

    const tool = captureTool(registerGitGrepTool);
    const caseSensitive = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "G", term: "widget" },
        format: "json",
      }),
    ) as { results: Array<{ commits?: unknown[] }> };
    expect(caseSensitive.results[0]?.commits).toEqual([]);

    const caseInsensitive = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "G", term: "widget" },
        ignoreCase: true,
        format: "json",
      }),
    ) as { results: Array<{ commits?: Array<{ subject: string }> }> };
    const subjects = (caseInsensitive.results[0]?.commits ?? []).map((c) => c.subject);
    expect(subjects).toContain("feat: add Widget");
  });

  test("path (singular) is unioned with paths, deduplicated", async () => {
    const repo = makeRepo();
    addCommit(repo, "a.txt", "union-term\n", "feat: a");
    addCommit(repo, "b.txt", "union-term\n", "feat: b");
    addCommit(repo, "c.txt", "union-term\n", "feat: c");

    const tool = captureTool(registerGitGrepTool);
    const parsed = JSON.parse(
      await tool({
        root: repo,
        pickaxe: { mode: "S", term: "union-term" },
        path: "a.txt",
        paths: ["b.txt", "a.txt"],
        format: "json",
      }),
    ) as { results: Array<{ commits?: Array<{ subject: string }> }> };

    const subjects = (parsed.results[0]?.commits ?? []).map((c) => c.subject);
    expect(subjects).toContain("feat: a");
    expect(subjects).toContain("feat: b");
    expect(subjects).not.toContain("feat: c");
  });

  test("paths array schema rejects more than the max cap", () => {
    const def = captureToolDefinitions(registerGitGrepTool).find((d) => d.name === "git_grep");
    const manyPaths = Array.from({ length: 257 }, (_, i) => `f${i}.txt`);
    const schema = def?.parameters as ZodTypeAny;
    const result = schema.safeParse({
      root: "/tmp",
      pickaxe: { mode: "S", term: "x" },
      paths: manyPaths,
    });
    expect(result.success).toBe(false);
  });

  test("subprocess-level buffer truncation returns partial commits + truncated:true, not git_grep_failed", async () => {
    const repo = makeRepo();
    for (let i = 0; i < 20; i++) {
      addCommit(
        repo,
        `f${i}.txt`,
        `bufcap-term\n`,
        `feat: commit number ${i} with quite a lot of extra padding text stuffed in here to grow the pickaxe log output past the buffer cap`,
      );
    }

    const prevEnv = process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES;
    process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES = "1024";
    try {
      const tool = captureTool(registerGitGrepTool);
      const result = await tool({
        root: repo,
        pickaxe: { mode: "S", term: "bufcap-term" },
        format: "json",
      });
      const parsed = JSON.parse(result) as {
        results: Array<{ error?: string; truncated?: boolean; commits?: unknown[] }>;
      };
      expect(parsed.results[0]?.error).toBeUndefined();
      expect(parsed.results[0]?.truncated).toBe(true);
      expect(Array.isArray(parsed.results[0]?.commits)).toBe(true);
    } finally {
      if (prevEnv === undefined) delete process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES;
      else process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES = prevEnv;
    }
  });
});
