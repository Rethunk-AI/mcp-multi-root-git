/**
 * Integration tests for git_cherry_pick.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  abortCherryPick,
  MAX_CHERRY_PICK_COMMITS,
  registerGitCherryPickContinueTool,
  registerGitCherryPickTool,
} from "./git-cherry-pick-tool.js";
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

function makeRepo(): string {
  return makeRepoWithSeed("mcp-cherry-pick-test-");
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
    // Default onConflict ("abort") never emits the pause marker (v5 contract: omit-when-false).
    expect(text).not.toContain('"paused"');
  });
});

// ---------------------------------------------------------------------------
// Cleanup flags
// ---------------------------------------------------------------------------

describe("git_cherry_pick cleanup", () => {
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

  test("deleteMergedWorktrees removes a worktree attached to branch-kind source", async () => {
    const dir = makeRepo();
    createBranchWithCommits(dir, "feature/w", [{ path: "w.txt", body: "W\n", message: "feat: w" }]);
    const wtContainer = mkTmpDir("mcp-cp-wt-");
    const wtPath = trackTmpPath(join(wtContainer, "wt"));
    gitCmd(dir, "worktree", "add", wtPath, "feature/w");

    // Unrelated commit on main so cherry-pick creates a new SHA (patch-id still matches).
    addCommit(dir, "unrelated.txt", "extra\n", "chore: diverge main");

    const run = captureTool(registerGitCherryPickTool);
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

  test("single branch source cherry-pick (markdown)", async () => {
    const dir = makeRepo();
    createBranchWithCommits(dir, "feature/cp", [
      { path: "cp.txt", body: "cp\n", message: "feat: cp" },
    ]);

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({ workspaceRoot: dir, sources: ["feature/cp"] });

    expect(text).toContain("# Cherry-pick onto `main`");
    expect(text).toContain("feature/cp");
    expect(text).toContain("branch");
    expect(text).toContain("picked");
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Patch-id cleanup (deleteMergedBranches after cherry-pick)
// ---------------------------------------------------------------------------

describe("git_cherry_pick patch-id branch deletion", () => {
  test("deleteMergedBranches deletes branch after cherry-pick despite SHA mismatch", async () => {
    const dir = makeRepo();
    // Create feature branch from seed
    createBranchWithCommits(dir, "feature/cp", [
      { path: "cp.txt", body: "content\n", message: "feat: cherry-pick me" },
    ]);
    // Add an unrelated commit to main so cherry-pick will have a different parent → different SHA.
    // After cherry-pick the SHA differs (different committer date/parent), so a plain
    // `git branch -d` would refuse — patch-id comparison detects content equivalence
    // and the branch is deleted anyway.
    writeFileSync(join(dir, "unrelated.txt"), "extra\n");
    gitCmd(dir, "add", "unrelated.txt");
    gitCmd(dir, "commit", "-m", "chore: unrelated on main");

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/cp"],
      deleteMergedBranches: true,
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ source: string; branchDeleted?: boolean }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.branchDeleted).toBe(true);

    // Branch should be gone
    const branches = gitCmd(dir, "branch");
    expect(branches).not.toContain("feature/cp");
  });

  test("strictMergedRefEquality: true skips deletion after cherry-pick (SHA mismatch)", async () => {
    const dir = makeRepo();
    createBranchWithCommits(dir, "feature/strict", [
      { path: "strict.txt", body: "strict\n", message: "feat: strict" },
    ]);
    // Add unrelated commit so parent differs → different SHA after cherry-pick
    writeFileSync(join(dir, "unrelated2.txt"), "extra\n");
    gitCmd(dir, "add", "unrelated2.txt");
    gitCmd(dir, "commit", "-m", "chore: diverge main");

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/strict"],
      deleteMergedBranches: true,
      strictMergedRefEquality: true,
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ source: string; branchDeleted?: boolean }>;
    };
    expect(parsed.ok).toBe(true);
    // Branch NOT deleted because SHA differs
    expect(parsed.results[0]?.branchDeleted).toBeUndefined();

    const branches = gitCmd(dir, "branch");
    expect(branches).toContain("feature/strict");
  });
});

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

  test("unsafe range token rejected", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["main..;rm"],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("onto checks out a non-current destination branch", async () => {
    const dir = makeRepo();
    gitCmd(dir, "checkout", "-b", "dest");
    addCommit(dir, "dest.txt", "d\n", "chore: dest base");
    gitCmd(dir, "checkout", "main");
    createBranchWithCommits(dir, "feature/a", [{ path: "a.txt", body: "a\n", message: "feat: a" }]);

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      onto: "dest",
      sources: ["feature/a"],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      onto: string;
      applied: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.onto).toBe("dest");
    expect(parsed.applied).toBe(1);
    expect(gitCmd(dir, "branch", "--show-current").trim()).toBe("dest");
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
  });

  test("too many expanded commits returns cherry_pick_too_many_commits", async () => {
    const dir = makeRepo();
    gitCmd(dir, "checkout", "-b", "feature/many");
    for (let i = 0; i < MAX_CHERRY_PICK_COMMITS + 1; i++) {
      writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
      gitCmd(dir, "add", `f${i}.txt`);
      gitCmd(dir, "commit", "-m", `feat: ${i}`);
    }
    gitCmd(dir, "checkout", "main");

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/many"],
    });
    const parsed = JSON.parse(text) as {
      error: string;
      picked: number;
      max: number;
    };
    expect(parsed.error).toBe("cherry_pick_too_many_commits");
    expect(parsed.picked).toBe(MAX_CHERRY_PICK_COMMITS + 1);
    expect(parsed.max).toBe(MAX_CHERRY_PICK_COMMITS);
  });

  test("abortCherryPick reports failure instead of claiming a clean abort", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "shared.txt"), "common\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: shared");

    gitCmd(dir, "checkout", "-b", "feature/a");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    const sha = gitCmd(dir, "rev-parse", "HEAD").trim();
    gitCmd(dir, "checkout", "main");

    writeFileSync(join(dir, "shared.txt"), "beta\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    expect(() => gitCmd(dir, "cherry-pick", sha)).toThrow();
    expect(gitCmd(dir, "rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD").trim()).toBeTruthy();

    const gitDir = join(dir, ".git");
    execFileSync("chmod", ["a-w", gitDir]);
    try {
      const result = await abortCherryPick(dir);
      expect(result.ok).toBe(false);
      expect(result.detail).toBeTruthy();
    } finally {
      execFileSync("chmod", ["u+w", gitDir]);
    }

    expect(gitCmd(dir, "rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD").trim()).toBeTruthy();
    expect(gitCmd(dir, "status", "--porcelain").trim()).not.toBe("");
    gitCmd(dir, "cherry-pick", "--abort");
  });
});

// ---------------------------------------------------------------------------
// onConflict: "pause" + git_cherry_pick_continue
// ---------------------------------------------------------------------------

describe("git_cherry_pick onConflict: pause", () => {
  test("leaves the conflict and sequencer state in place instead of aborting", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "shared.txt"), "common\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: shared");

    gitCmd(dir, "checkout", "-b", "feature/a");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    const conflictSha = gitCmd(dir, "rev-parse", "HEAD").trim();
    gitCmd(dir, "checkout", "main");

    writeFileSync(join(dir, "shared.txt"), "beta\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/a"],
      onConflict: "pause",
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      applied: number;
      conflict?: { stage: string; paused?: boolean; commit?: string; paths: string[] };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.applied).toBe(0);
    expect(parsed.conflict?.paused).toBe(true);
    expect(parsed.conflict?.commit).toBe(conflictSha);
    expect(parsed.conflict?.paths).toContain("shared.txt");

    // Sequencer state left in place (not aborted): CHERRY_PICK_HEAD still set, tree still dirty.
    expect(gitCmd(dir, "rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD").trim()).toBeTruthy();
    expect(gitCmd(dir, "status", "--porcelain").trim()).not.toBe("");

    gitCmd(dir, "cherry-pick", "--abort");
  });

  test("markdown format reports the paused state and points at git_cherry_pick_continue", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "shared.txt"), "common\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: shared");

    gitCmd(dir, "checkout", "-b", "feature/g");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    gitCmd(dir, "checkout", "main");

    writeFileSync(join(dir, "shared.txt"), "beta\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const run = captureTool(registerGitCherryPickTool);
    const text = await run({ workspaceRoot: dir, sources: ["feature/g"], onConflict: "pause" });

    expect(text).toContain("paused on conflict");
    expect(text).toContain("git_cherry_pick_continue");

    gitCmd(dir, "cherry-pick", "--abort");
  });

  test("a second git_cherry_pick call while paused returns cherry_pick_in_progress", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "shared.txt"), "common\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: shared");

    gitCmd(dir, "checkout", "-b", "feature/f");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    gitCmd(dir, "checkout", "main");

    writeFileSync(join(dir, "shared.txt"), "beta\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const run = captureTool(registerGitCherryPickTool);
    const pauseText = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/f"],
      onConflict: "pause",
    });
    const paused = JSON.parse(pauseText) as { conflict?: { commit?: string } };

    const secondText = await run({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/f"],
    });
    const second = JSON.parse(secondText) as { error: string; commit?: string };
    expect(second.error).toBe("cherry_pick_in_progress");
    expect(second.commit).toBe(paused.conflict?.commit);

    gitCmd(dir, "cherry-pick", "--abort");
  });
});

describe("git_cherry_pick_continue", () => {
  test("with nothing in progress returns no_cherry_pick_in_progress", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitCherryPickContinueTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("no_cherry_pick_in_progress");
  });

  test("with unresolved paths returns an informative error", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "shared.txt"), "common\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: shared");

    gitCmd(dir, "checkout", "-b", "feature/c");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    gitCmd(dir, "checkout", "main");

    writeFileSync(join(dir, "shared.txt"), "beta\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const runPick = captureTool(registerGitCherryPickTool);
    await runPick({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/c"],
      onConflict: "pause",
    });

    const runContinue = captureTool(registerGitCherryPickContinueTool);
    const text = await runContinue({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { error: string; paths: string[] };
    expect(parsed.error).toBe("cherry_pick_unresolved_paths");
    expect(parsed.paths).toContain("shared.txt");

    gitCmd(dir, "cherry-pick", "--abort");
  });

  test("continue after resolving the conflict completes remaining picks", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "shared.txt"), "common\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: shared");

    gitCmd(dir, "checkout", "-b", "feature/b");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    writeFileSync(join(dir, "other.txt"), "new\n");
    gitCmd(dir, "add", "other.txt");
    gitCmd(dir, "commit", "-m", "feat: other");
    gitCmd(dir, "checkout", "main");

    writeFileSync(join(dir, "shared.txt"), "beta\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const runPick = captureTool(registerGitCherryPickTool);
    const pauseText = await runPick({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/b"],
      onConflict: "pause",
    });
    const paused = JSON.parse(pauseText) as { ok: boolean; conflict?: { paused?: boolean } };
    expect(paused.ok).toBe(false);
    expect(paused.conflict?.paused).toBe(true);

    // Resolve the conflict and stage it.
    writeFileSync(join(dir, "shared.txt"), "resolved\n");
    gitCmd(dir, "add", "shared.txt");

    const runContinue = captureTool(registerGitCherryPickContinueTool);
    const continueText = await runContinue({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(continueText) as { ok: boolean; action: string; applied: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("continue");
    // Resolved commit + the clean second pick both land via the resumed sequencer.
    expect(parsed.applied).toBe(2);

    // `git rev-parse --verify --quiet` exits non-zero (execFileSync throw) once the sequencer
    // state is gone, so check for absence via the marker file instead.
    expect(existsSync(join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
    expect(gitCmd(dir, "status", "--porcelain").trim()).toBe("");
    expect(readFileSync(join(dir, "shared.txt"), "utf8")).toBe("resolved\n");
    expect(existsSync(join(dir, "other.txt"))).toBe(true);
  });

  test("a later commit conflicting mid-continue is reported resumably", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "shared.txt"), "common\n");
    gitCmd(dir, "add", "shared.txt");
    writeFileSync(join(dir, "other.txt"), "common2\n");
    gitCmd(dir, "add", "other.txt");
    gitCmd(dir, "commit", "-m", "chore: base2");

    gitCmd(dir, "checkout", "-b", "feature/d");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    const shaAlpha = gitCmd(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "other.txt"), "alpha2\n");
    gitCmd(dir, "add", "other.txt");
    gitCmd(dir, "commit", "-m", "feat: other-alpha");
    const shaOtherAlpha = gitCmd(dir, "rev-parse", "HEAD").trim();
    gitCmd(dir, "checkout", "main");

    writeFileSync(join(dir, "shared.txt"), "beta\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");
    writeFileSync(join(dir, "other.txt"), "beta2\n");
    gitCmd(dir, "add", "other.txt");
    gitCmd(dir, "commit", "-m", "chore: beta2");

    const runPick = captureTool(registerGitCherryPickTool);
    const pauseText = await runPick({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/d"],
      onConflict: "pause",
    });
    const paused = JSON.parse(pauseText) as { conflict?: { commit?: string } };
    expect(paused.conflict?.commit).toBe(shaAlpha);

    // Resolve the first conflict.
    writeFileSync(join(dir, "shared.txt"), "resolved1\n");
    gitCmd(dir, "add", "shared.txt");

    const runContinue = captureTool(registerGitCherryPickContinueTool);
    const secondText = await runContinue({ workspaceRoot: dir, format: "json" });
    const second = JSON.parse(secondText) as {
      ok: boolean;
      applied: number;
      conflict?: { paused?: boolean; commit?: string; paths: string[] };
    };
    // The sequencer committed feat: alpha, then hit a second conflict on feat: other-alpha.
    expect(second.ok).toBe(false);
    expect(second.applied).toBe(1);
    expect(second.conflict?.paused).toBe(true);
    expect(second.conflict?.commit).toBe(shaOtherAlpha);
    expect(second.conflict?.paths).toContain("other.txt");
    expect(gitCmd(dir, "rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD").trim()).toBeTruthy();

    // Resolve the second conflict and finish the loop.
    writeFileSync(join(dir, "other.txt"), "resolved2\n");
    gitCmd(dir, "add", "other.txt");

    const finalText = await runContinue({ workspaceRoot: dir, format: "json" });
    const final = JSON.parse(finalText) as { ok: boolean; applied: number };
    expect(final.ok).toBe(true);
    expect(final.applied).toBe(1);
    expect(existsSync(join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
    expect(gitCmd(dir, "status", "--porcelain").trim()).toBe("");
  });

  test("action: abort restores HEAD to the pre-cherry-pick commit", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "shared.txt"), "common\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: shared");

    gitCmd(dir, "checkout", "-b", "feature/e");
    writeFileSync(join(dir, "shared.txt"), "alpha\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    gitCmd(dir, "checkout", "main");

    writeFileSync(join(dir, "shared.txt"), "beta\n");
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");
    const preHead = gitCmd(dir, "rev-parse", "HEAD").trim();

    const runPick = captureTool(registerGitCherryPickTool);
    await runPick({
      workspaceRoot: dir,
      format: "json",
      sources: ["feature/e"],
      onConflict: "pause",
    });

    const runContinue = captureTool(registerGitCherryPickContinueTool);
    const text = await runContinue({ workspaceRoot: dir, format: "json", action: "abort" });
    const parsed = JSON.parse(text) as { ok: boolean; action: string; headSha?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("abort");
    expect(parsed.headSha).toBe(preHead);

    expect(gitCmd(dir, "rev-parse", "HEAD").trim()).toBe(preHead);
    expect(existsSync(join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
    expect(gitCmd(dir, "status", "--porcelain").trim()).toBe("");
  });
});
