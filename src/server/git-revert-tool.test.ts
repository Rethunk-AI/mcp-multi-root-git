/**
 * Integration tests for git_revert.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { abortRevert, registerGitRevertTool } from "./git-revert-tool.js";
import { captureTool, cleanupTmpPaths, gitCmd, makeRepoWithSeed } from "./test-harness.js";

afterEach(cleanupTmpPaths);

function makeRepo(): string {
  return makeRepoWithSeed("mcp-revert-test-");
}

describe("git_revert happy path", () => {
  test("reverts a seeded commit: restores content and creates a new commit", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "seed.txt"), "changed\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: change seed");
    const targetSha = gitCmd(dir, "rev-parse", "HEAD").trim();
    const headBefore = targetSha;

    const run = captureTool(registerGitRevertTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: [targetSha],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      reverted: Array<{ source: string; sha: string }>;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.reverted).toHaveLength(1);
    expect(parsed.reverted[0]?.source).toBe(targetSha);
    const revertSha = parsed.reverted[0]?.sha;
    expect(revertSha).toBeTruthy();
    expect(revertSha).not.toBe(headBefore);

    // Content restored to pre-change state.
    expect(readFileSync(join(dir, "seed.txt"), "utf8")).toBe("seed\n");

    // A new commit was made (HEAD advanced), history not rewritten.
    const headAfter = gitCmd(dir, "rev-parse", "HEAD").trim();
    expect(headAfter).toBe(revertSha as string);
    expect(headAfter).not.toBe(headBefore);
    const log = gitCmd(dir, "log", "--oneline").trim().split("\n");
    expect(log[0]).toContain("Revert");
    // Original commit still present in history — nothing rewritten.
    expect(gitCmd(dir, "cat-file", "-e", targetSha)).toBe("");
  });

  test("noCommit stages the revert without creating a commit", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "seed.txt"), "changed\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: change seed");
    const targetSha = gitCmd(dir, "rev-parse", "HEAD").trim();
    const headBefore = targetSha;

    const run = captureTool(registerGitRevertTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: [targetSha],
      noCommit: true,
    });
    const parsed = JSON.parse(text) as { ok: boolean; staged: boolean; sources: string[] };

    expect(parsed.ok).toBe(true);
    expect(parsed.staged).toBe(true);
    expect(parsed.sources).toEqual([targetSha]);

    // No new commit — HEAD unchanged.
    const headAfter = gitCmd(dir, "rev-parse", "HEAD").trim();
    expect(headAfter).toBe(headBefore);

    // Change is staged, not committed.
    const status = gitCmd(dir, "status", "--porcelain").trim();
    expect(status).toContain("M  seed.txt");
  });
});

describe("git_revert conflicts", () => {
  test("conflict aborts revert and reports paths, leaving the tree clean", async () => {
    const dir = makeRepo();
    // seed.txt: seed -> alpha -> beta. Reverting the "alpha" change while "beta"
    // is HEAD produces a conflict (both touched the same lines afterwards).
    writeFileSync(join(dir, "seed.txt"), "alpha\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: alpha");
    const alphaSha = gitCmd(dir, "rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "seed.txt"), "beta\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const run = captureTool(registerGitRevertTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: [alphaSha],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      aborted: boolean;
      conflicts: string[];
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.aborted).toBe(true);
    expect(parsed.conflicts).toContain("seed.txt");

    // Repo state is clean (revert aborted).
    const status = gitCmd(dir, "status", "--porcelain").trim();
    expect(status).toBe("");
    // HEAD unchanged.
    const headAfter = gitCmd(dir, "rev-parse", "HEAD").trim();
    const log = gitCmd(dir, "log", "-1", "--oneline").trim();
    expect(log).toContain("beta");
    expect(headAfter).toBeTruthy();
  });

  test("abortRevert reports failure instead of claiming a clean abort", async () => {
    // Exercises the abortRevert helper directly (rather than through the full
    // tool) because forcing `git revert --abort` itself to fail requires
    // making `.git` unwritable *after* the conflict already exists — a state
    // the full execute() path can't be paused in mid-flight from a test
    // without mocking beyond this file's style.
    const dir = makeRepo();
    writeFileSync(join(dir, "seed.txt"), "alpha\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: alpha");
    const alphaSha = gitCmd(dir, "rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "seed.txt"), "beta\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    // Produce a real conflicted, mid-revert state (same as the "conflicts" test above).
    expect(() => gitCmd(dir, "revert", "--no-edit", alphaSha)).toThrow();
    expect(gitCmd(dir, "rev-parse", "--verify", "--quiet", "REVERT_HEAD").trim()).toBeTruthy();

    // Now make .git read-only so `git revert --abort` cannot create index.lock
    // and fails with a non-zero exit — simulating an abort that itself fails.
    const gitDir = join(dir, ".git");
    execFileSync("chmod", ["a-w", gitDir]);
    try {
      const result = await abortRevert(dir);
      expect(result.ok).toBe(false);
      expect(result.detail).toBeTruthy();
    } finally {
      // Restore permissions so cleanupTmpPaths (rmSync) can remove the directory tree.
      execFileSync("chmod", ["u+w", gitDir]);
    }

    // The failed abort must not have silently "succeeded" — tree is still mid-revert.
    expect(gitCmd(dir, "rev-parse", "--verify", "--quiet", "REVERT_HEAD").trim()).toBeTruthy();
    expect(gitCmd(dir, "status", "--porcelain").trim()).not.toBe("");

    // Clean up now that .git is writable again so the rest of the suite (and
    // cleanupTmpPaths) don't trip over a leftover mid-revert state.
    gitCmd(dir, "revert", "--abort");
  });
});

describe("git_revert guardrails", () => {
  test("working_tree_dirty refuses unstaged changes", async () => {
    const dir = makeRepo();
    const targetSha = gitCmd(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "seed.txt"), "mutated\n");

    const run = captureTool(registerGitRevertTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: [targetSha],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("working_tree_dirty");
  });

  test("unsafe source token rejected", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitRevertTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["; rm -rf /"],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("unsafe_ref_token");
  });
});
