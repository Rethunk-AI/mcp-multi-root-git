/**
 * Integration tests for git_merge.
 *
 * Uses throwaway on-disk repos so merge/rebase semantics are exercised end-to-end.
 * No network, no real upstream — every branch lives locally.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerGitMergeTool } from "./git-merge-tool.js";
import {
  addCommit,
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
  trackTmpPath,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

// ---------------------------------------------------------------------------
// Repo helpers (shared via test-harness.ts)
// ---------------------------------------------------------------------------

function makeRepo(): string {
  return makeRepoWithSeed("mcp-git-merge-test-");
}

function createBranchAhead(dir: string, branch: string, files: Record<string, string>): void {
  gitCmd(dir, "checkout", "-b", branch);
  for (const [path, body] of Object.entries(files)) {
    writeFileSync(join(dir, path), body);
    gitCmd(dir, "add", path);
  }
  gitCmd(dir, "commit", "-m", `feat: ${branch}`);
  gitCmd(dir, "checkout", "main");
}

// ---------------------------------------------------------------------------
// Fast-forward path (most common: agent worktree ahead of main)
// ---------------------------------------------------------------------------

describe("git_merge fast-forward", () => {
  test("ahead-only source fast-forwards under auto strategy", async () => {
    const dir = makeRepo();
    createBranchAhead(dir, "feature/a", { "a.txt": "A\n" });

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      applied: number;
      results: Array<{ source: string; ok: boolean; outcome: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.applied).toBe(1);
    expect(parsed.results[0]?.outcome).toBe("fast_forward");
    // main now contains a.txt
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
  });

  test("multiple ahead-only sources apply in order", async () => {
    const dir = makeRepo();
    createBranchAhead(dir, "feature/a", { "a.txt": "A\n" });
    // second branch starts from main (before a is merged) and adds b.txt
    createBranchAhead(dir, "feature/b", { "b.txt": "B\n" });

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a", "feature/b"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      applied: number;
      results: Array<{ outcome: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.applied).toBe(2);
    // First is FF, second is either FF (if merge-base still main tip) or rebase_then_ff.
    // After FFing feature/a, main has new commit; feature/b's base is still the original.
    // So feature/b has diverged and under auto will rebase_then_ff.
    expect(["fast_forward", "rebase_then_ff"]).toContain(parsed.results[0]?.outcome);
    expect(["fast_forward", "rebase_then_ff"]).toContain(parsed.results[1]?.outcome);
  });

  test("already up-to-date source is reported but not re-applied", async () => {
    const dir = makeRepo();
    // feature/a points at main, then main advances past it.
    gitCmd(dir, "branch", "feature/a", "HEAD");
    addCommit(dir, "extra.txt", "extra\n", "chore: advance main");

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ outcome: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.outcome).toBe("up_to_date");
  });
});

// ---------------------------------------------------------------------------
// Strategy matrix
// ---------------------------------------------------------------------------

describe("git_merge strategy", () => {
  test("ff-only on diverged branches returns cannot_fast_forward", async () => {
    const dir = makeRepo();
    createBranchAhead(dir, "feature/a", { "a.txt": "A\n" });
    // advance main so feature/a is behind
    addCommit(dir, "m.txt", "M\n", "chore: main advance");

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      strategy: "ff-only",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ error: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("cannot_fast_forward");
  });

  test("auto on diverged branches rebases then fast-forwards when clean", async () => {
    const dir = makeRepo();
    createBranchAhead(dir, "feature/a", { "a.txt": "A\n" });
    addCommit(dir, "m.txt", "M\n", "chore: main advance");

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ outcome: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.outcome).toBe("rebase_then_ff");
  });

  test("merge strategy always creates a merge commit", async () => {
    const dir = makeRepo();
    createBranchAhead(dir, "feature/a", { "a.txt": "A\n" });

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      strategy: "merge",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ outcome: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.outcome).toBe("merge_commit");
    // Confirm there's a merge commit at HEAD (two parents).
    const parents = gitCmd(dir, "rev-list", "--parents", "-1", "HEAD").trim().split(" ");
    expect(parents.length).toBe(3); // commit + 2 parents
  });

  test("auto falls back to merge commit when rebase conflicts", async () => {
    const dir = makeRepo();
    // Both branches touch the same file with incompatible content.
    gitCmd(dir, "checkout", "-b", "feature/a");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    gitCmd(dir, "checkout", "main");
    addCommit(dir, "shared.txt", "beta\n", "chore: beta on main");

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ ok: boolean; outcome?: string; error?: string; conflictStage?: string }>;
    };
    // Rebase conflicts, then merge-commit also conflicts on shared.txt — final outcome is conflict at merge stage.
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.ok).toBe(false);
    expect(parsed.results[0]?.conflictStage).toBe("merge");
  });

  test("rebase strategy surfaces rebase conflict without merge fallback", async () => {
    const dir = makeRepo();
    gitCmd(dir, "checkout", "-b", "feature/a");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    gitCmd(dir, "checkout", "main");
    addCommit(dir, "shared.txt", "beta\n", "chore: beta");

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      strategy: "rebase",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ error: string; conflictStage: string; conflictPaths: string[] }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.conflictStage).toBe("rebase");
    expect(parsed.results[0]?.error).toBe("rebase_conflicts");
    // No rebase artifacts left behind.
    const hasRebaseDir = readdirSync(join(dir, ".git")).some((n) => n.startsWith("rebase-"));
    expect(hasRebaseDir).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cleanup flags
// ---------------------------------------------------------------------------

describe("git_merge cleanup", () => {
  test("deleteMergedBranches deletes non-protected source after FF", async () => {
    const dir = makeRepo();
    createBranchAhead(dir, "feature/a", { "a.txt": "A\n" });

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
      deleteMergedBranches: true,
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ branchDeleted?: boolean }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.branchDeleted).toBe(true);
    // Branch no longer exists.
    const branches = gitCmd(dir, "branch").trim();
    expect(branches).not.toContain("feature/a");
  });

  test("deleteMergedBranches skips protected names", async () => {
    const dir = makeRepo();
    // Create a branch called `dev` (protected) that is ahead of main.
    gitCmd(dir, "checkout", "-b", "dev");
    writeFileSync(join(dir, "d.txt"), "d\n");
    gitCmd(dir, "add", "d.txt");
    gitCmd(dir, "commit", "-m", "feat: dev");
    gitCmd(dir, "checkout", "main");

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["dev"],
      deleteMergedBranches: true,
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ branchDeleted?: boolean }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.branchDeleted).toBeUndefined();
    // dev still exists.
    const branches = gitCmd(dir, "branch").trim();
    expect(branches).toContain("dev");
  });

  test("simple ff-merge (markdown)", async () => {
    const dir = makeRepo();
    createBranchAhead(dir, "feature/a", { "a.txt": "A\n" });
    gitCmd(dir, "checkout", "main");

    const run = captureTool(registerGitMergeTool);
    const text = await run({ workspaceRoot: dir, sources: ["feature/a"] });

    expect(text).toContain("# Merge into `main`");
    expect(text).toContain("feature/a");
    expect(text).toMatch(/✓|✔/);
  });

  test("deleteMergedWorktrees removes a worktree attached to merged source", async () => {
    const dir = makeRepo();
    // Create branch + worktree for it.
    gitCmd(dir, "branch", "feature/w", "HEAD");
    const wtPath = trackTmpPath(join(tmpdir(), `mcp-wt-${Date.now()}`));
    gitCmd(dir, "worktree", "add", wtPath, "feature/w");
    // Add a commit in the worktree so it's ahead.
    writeFileSync(join(wtPath, "w.txt"), "W\n");
    gitCmd(wtPath, "add", "w.txt");
    gitCmd(wtPath, "commit", "-m", "feat: w");

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/w"],
      deleteMergedWorktrees: true,
      deleteMergedBranches: true,
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ branchDeleted?: boolean; worktreeRemoved?: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.worktreeRemoved).toBe(wtPath);
    expect(parsed.results[0]?.branchDeleted).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

describe("git_merge guardrails", () => {
  test("working_tree_dirty refuses when tree has unstaged changes", async () => {
    const dir = makeRepo();
    createBranchAhead(dir, "feature/a", { "a.txt": "A\n" });
    writeFileSync(join(dir, "seed.txt"), "mutated\n");

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("working_tree_dirty");
  });

  test("unknown source returns source_not_found", async () => {
    const dir = makeRepo();

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["does-not-exist"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ error: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("source_not_found");
  });

  test("unsafe ref token rejected", async () => {
    const dir = makeRepo();

    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["; rm -rf /"],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("non-git workspaceRoot returns not_a_git_repository", async () => {
    const plain = mkTmpDir("mcp-plain-");
    const run = captureTool(registerGitMergeTool);
    const text = await run({
      workspaceRoot: plain,
      format: "json",
      sources: ["anything"],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("not_a_git_repository");
  });
});
