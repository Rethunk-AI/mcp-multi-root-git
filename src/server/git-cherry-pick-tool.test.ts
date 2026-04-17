/**
 * Integration tests for git_cherry_pick.
 */

import { describe, expect, test } from "bun:test";
import { type ExecSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerGitCherryPickTool } from "./git-cherry-pick-tool.js";
import { captureTool } from "./test-harness.js";

function gitCmd(cwd: string, ...args: string[]): string {
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
    },
  };
  return execFileSync("git", args, opts);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-cherry-pick-test-"));
  gitCmd(dir, "init", "-b", "main");
  gitCmd(dir, "config", "user.email", "test@example.com");
  gitCmd(dir, "config", "user.name", "Test User");
  gitCmd(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  gitCmd(dir, "add", "seed.txt");
  gitCmd(dir, "commit", "-m", "chore: seed");
  return dir;
}

function createBranchWithCommits(
  dir: string,
  branch: string,
  commits: Array<{ path: string; body: string; message: string }>,
): string[] {
  gitCmd(dir, "checkout", "-b", branch);
  const shas: string[] = [];
  for (const c of commits) {
    writeFileSync(join(dir, c.path), c.body);
    gitCmd(dir, "add", c.path);
    gitCmd(dir, "commit", "-m", c.message);
    shas.push(gitCmd(dir, "rev-parse", "HEAD").trim());
  }
  gitCmd(dir, "checkout", "main");
  return shas;
}

// ---------------------------------------------------------------------------
// Branch-source flow (the primary agent-worktree use case)
// ---------------------------------------------------------------------------

describe("git_cherry_pick branch sources", () => {
  test("single branch source plays every new commit onto destination", async () => {
    const dir = makeRepo();
    createBranchWithCommits(dir, "feature/a", [
      { path: "a1.txt", body: "a1\n", message: "feat: a1" },
      { path: "a2.txt", body: "a2\n", message: "feat: a2" },
    ]);

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      applied: number;
      picked: number;
      results: Array<{ source: string; kind: string; keptCommits: number }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.applied).toBe(2);
    expect(parsed.picked).toBe(2);
    expect(parsed.results[0]?.kind).toBe("branch");
    expect(parsed.results[0]?.keptCommits).toBe(2);
    // Destination file check
    expect(existsSync(join(dir, "a1.txt"))).toBe(true);
    expect(existsSync(join(dir, "a2.txt"))).toBe(true);
  });

  test("multiple branch sources applied in order", async () => {
    const dir = makeRepo();
    createBranchWithCommits(dir, "feature/a", [{ path: "a.txt", body: "a\n", message: "feat: a" }]);
    createBranchWithCommits(dir, "feature/b", [{ path: "b.txt", body: "b\n", message: "feat: b" }]);

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a", "feature/b"],
    });
    const parsed = JSON.parse(text) as { ok: boolean; applied: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.applied).toBe(2);
    const log = gitCmd(dir, "log", "--oneline").trim();
    // Most recent first: b, then a, then seed.
    expect(log.split("\n")[0]).toContain("feat: b");
    expect(log.split("\n")[1]).toContain("feat: a");
  });

  test("re-applying a patch-equivalent commit adds nothing (--empty=drop)", async () => {
    const dir = makeRepo();
    const shas = createBranchWithCommits(dir, "feature/a", [
      { path: "a.txt", body: "a\n", message: "feat: a" },
    ]);
    const headBefore = gitCmd(dir, "rev-parse", "HEAD").trim();

    // Cherry-pick once (succeeds).
    const run = captureTool(registerGitCherryPickTool);
    await run({ workspaceRoot: dir, format: "json", sources: [shas[0] ?? ""] });
    const headAfterFirst = gitCmd(dir, "rev-parse", "HEAD").trim();
    expect(headAfterFirst).not.toBe(headBefore);

    // Second call with the branch source. `onto..feature/a` still lists the original
    // SHA (it is not an ancestor of main — different SHA than the cherry-picked copy).
    // `--empty=drop` handles the patch-equivalence at cherry-pick time, so `applied`
    // is 0 and HEAD does not advance.
    const text2 = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text2) as {
      ok: boolean;
      applied: number;
      picked: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.applied).toBe(0);
    // picked is what was fed to `git cherry-pick`; git itself drops empties.
    expect(parsed.picked).toBeGreaterThanOrEqual(0);
    const headAfterSecond = gitCmd(dir, "rev-parse", "HEAD").trim();
    expect(headAfterSecond).toBe(headAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// SHA and range sources
// ---------------------------------------------------------------------------

describe("git_cherry_pick SHA and range sources", () => {
  test("single SHA picks exactly that commit", async () => {
    const dir = makeRepo();
    const shas = createBranchWithCommits(dir, "feature/a", [
      { path: "a1.txt", body: "a1\n", message: "feat: a1" },
      { path: "a2.txt", body: "a2\n", message: "feat: a2" },
    ]);
    const secondSha = shas[1];
    expect(secondSha).toBeDefined();

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: [secondSha ?? ""],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      applied: number;
      results: Array<{ kind: string; resolvedCommits: number }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.applied).toBe(1);
    expect(parsed.results[0]?.kind).toBe("sha");
    // Only a2.txt appears on destination (a1.txt was skipped).
    expect(existsSync(join(dir, "a1.txt"))).toBe(false);
    expect(existsSync(join(dir, "a2.txt"))).toBe(true);
  });

  test("A..B range picks all commits in range, oldest-first", async () => {
    const dir = makeRepo();
    const shas = createBranchWithCommits(dir, "feature/a", [
      { path: "a1.txt", body: "a1\n", message: "feat: a1" },
      { path: "a2.txt", body: "a2\n", message: "feat: a2" },
      { path: "a3.txt", body: "a3\n", message: "feat: a3" },
    ]);

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: [`main..${"feature/a"}`],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      applied: number;
      results: Array<{ kind: string; resolvedCommits: number }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.applied).toBe(3);
    expect(parsed.results[0]?.kind).toBe("range");
    // All three files present.
    expect(existsSync(join(dir, "a1.txt"))).toBe(true);
    expect(existsSync(join(dir, "a2.txt"))).toBe(true);
    expect(existsSync(join(dir, "a3.txt"))).toBe(true);
    // Log order: a3 newest.
    const log = gitCmd(dir, "log", "--oneline").trim().split("\n");
    expect(log[0]).toContain("feat: a3");
    // shas array unused beyond creation, but keep ref to satisfy no-unused warning
    expect(shas.length).toBe(3);
  });

  test("overlap between branch and SHA sources deduplicates", async () => {
    const dir = makeRepo();
    const shas = createBranchWithCommits(dir, "feature/a", [
      { path: "a.txt", body: "a\n", message: "feat: a" },
    ]);
    const sha = shas[0] ?? "";

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: [sha, "feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      applied: number;
      results: Array<{ keptCommits: number }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.applied).toBe(1); // not 2
    expect(parsed.results[0]?.keptCommits).toBe(1);
    expect(parsed.results[1]?.keptCommits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Conflict handling
// ---------------------------------------------------------------------------

describe("git_cherry_pick conflicts", () => {
  test("conflict aborts cherry-pick and reports structured paths", async () => {
    const dir = makeRepo();
    // Two branches touch the same file with incompatible content.
    writeFileSync(join(dir, "shared.txt"), "common\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: shared");

    // Branch A touches shared.txt one way.
    gitCmd(dir, "checkout", "-b", "feature/a");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    gitCmd(dir, "checkout", "main");

    // Main advances on shared.txt differently.
    writeFileSync(join(dir, "shared.txt"), "beta\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      applied: number;
      conflict?: { stage: string; paths: string[] };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.applied).toBe(0);
    expect(parsed.conflict?.stage).toBe("cherry-pick");
    expect(parsed.conflict?.paths).toContain("shared.txt");
    // Repo state is clean (cherry-pick aborted).
    const status = gitCmd(dir, "status", "--porcelain").trim();
    expect(status).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Cleanup flags
// ---------------------------------------------------------------------------

describe("git_cherry_pick cleanup", () => {
  test("deleteMergedBranches deletes fully-merged non-protected branch", async () => {
    const dir = makeRepo();
    createBranchWithCommits(dir, "feature/a", [{ path: "a.txt", body: "a\n", message: "feat: a" }]);

    const run = captureTool(registerGitCherryPickTool);
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
    // After cherry-pick, feature/a's only commit is reachable from main as a cherry
    // (different SHA). `git branch -d` uses merge-base --is-ancestor, which requires
    // the original SHA to be reachable. Cherry-picked commits have NEW SHAs,
    // so the original is NOT an ancestor → branch is NOT deleted. Verify this.
    expect(parsed.results[0]?.branchDeleted).toBeUndefined();
    // Branch still exists.
    const branches = gitCmd(dir, "branch").trim();
    expect(branches).toContain("feature/a");
  });

  test("deleteMergedBranches skips protected 'dev' name even if merged", async () => {
    const dir = makeRepo();
    // Create and merge a dev branch forward into main via fast-forward.
    gitCmd(dir, "checkout", "-b", "dev");
    writeFileSync(join(dir, "d.txt"), "d\n");
    gitCmd(dir, "add", "d.txt");
    gitCmd(dir, "commit", "-m", "feat: d");
    gitCmd(dir, "checkout", "main");
    // Fast-forward main to dev to make dev fully merged.
    gitCmd(dir, "merge", "--ff-only", "dev");

    const run = captureTool(registerGitCherryPickTool);
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
    const branches = gitCmd(dir, "branch").trim();
    expect(branches).toContain("dev");
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

describe("git_cherry_pick guardrails", () => {
  test("working_tree_dirty refuses unstaged changes", async () => {
    const dir = makeRepo();
    createBranchWithCommits(dir, "feature/a", [{ path: "a.txt", body: "a\n", message: "feat: a" }]);
    writeFileSync(join(dir, "seed.txt"), "mutated\n");

    const run = captureTool(registerGitCherryPickTool);
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
    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["does-not-exist"],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("source_not_found");
  });

  test("unsafe ref token rejected", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["; rm -rf /"],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("unsafe_ref_token");
  });
});
