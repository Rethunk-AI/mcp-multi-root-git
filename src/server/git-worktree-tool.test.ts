/**
 * Integration tests for git_worktree_list, git_worktree_add, git_worktree_remove.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  registerGitWorktreeAddTool,
  registerGitWorktreeListTool,
  registerGitWorktreeRemoveTool,
} from "./git-worktree-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
  trackTmpPath,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

function makeRepo(): string {
  return makeRepoWithSeed("mcp-git-worktree-test-");
}

// ---------------------------------------------------------------------------
// git_worktree_list
// ---------------------------------------------------------------------------

describe("git_worktree_list", () => {
  test("lists the main worktree for a fresh repo (json)", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitWorktreeListTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      worktrees: { path: string; branch: string | null }[];
    };

    expect(parsed.worktrees).toHaveLength(1);
    expect(parsed.worktrees[0]?.branch).toContain("main");
  });

  test("markdown format includes the branch name", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitWorktreeListTool);
    const text = await run({ workspaceRoot: dir });

    expect(text).toContain("# Worktrees");
    expect(text).toContain("main");
  });

  test("includes an added worktree in the list", async () => {
    const dir = makeRepo();
    const wtPath = trackTmpPath(join(dir, "../wt-for-list"));
    gitCmd(dir, "worktree", "add", "-b", "feature/listed", wtPath);

    const run = captureTool(registerGitWorktreeListTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      worktrees: { path: string; branch: string | null }[];
    };

    expect(parsed.worktrees).toHaveLength(2);
    const branches = parsed.worktrees.map((w) => w.branch);
    expect(branches.some((b) => b?.includes("feature/listed"))).toBe(true);
  });

  test("returns not_a_git_repository for a plain directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");
    const run = captureTool(registerGitWorktreeListTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("not_a_git_repository");
  });
});

// ---------------------------------------------------------------------------
// git_worktree_add
// ---------------------------------------------------------------------------

describe("git_worktree_add", () => {
  test("adds a new worktree with a new branch (json)", async () => {
    const dir = makeRepo();
    const wtPath = trackTmpPath(join(dir, "../wt-feature-a"));

    const run = captureTool(registerGitWorktreeAddTool);
    const text = await run({
      workspaceRoot: dir,
      path: wtPath,
      branch: "feature/agent-a",
      format: "json",
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      path: string;
      branch: string;
      created: boolean;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.branch).toBe("feature/agent-a");
    expect(parsed.created).toBe(true);
    expect(existsSync(wtPath)).toBe(true);
  });

  test("adds a worktree for an existing branch", async () => {
    const dir = makeRepo();
    gitCmd(dir, "checkout", "-b", "feature/existing");
    gitCmd(dir, "checkout", "main");

    const wtPath = trackTmpPath(join(dir, "../wt-existing"));
    const run = captureTool(registerGitWorktreeAddTool);
    const text = await run({
      workspaceRoot: dir,
      path: wtPath,
      branch: "feature/existing",
      format: "json",
    });
    const parsed = JSON.parse(text) as { ok: boolean; created: boolean };

    expect(parsed.ok).toBe(true);
    expect(parsed.created).toBe(false);
  });

  test("markdown format shows the new worktree path and branch", async () => {
    const dir = makeRepo();
    const wtPath = trackTmpPath(join(dir, "../wt-feature-md"));

    const run = captureTool(registerGitWorktreeAddTool);
    const text = await run({
      workspaceRoot: dir,
      path: wtPath,
      branch: "feature/md-test",
    });

    expect(text).toContain("# Worktree added");
    expect(text).toContain("feature/md-test");
  });

  test("adds worktree with explicit baseRef", async () => {
    const dir = makeRepo();
    const sha = gitCmd(dir, "rev-parse", "HEAD").trim();
    const wtPath = trackTmpPath(join(dir, "../wt-baseref"));

    const run = captureTool(registerGitWorktreeAddTool);
    const text = await run({
      workspaceRoot: dir,
      path: wtPath,
      branch: "feature/from-sha",
      baseRef: sha,
      format: "json",
    });
    const parsed = JSON.parse(text) as { ok: boolean; baseRef: string };

    expect(parsed.ok).toBe(true);
    expect(parsed.baseRef).toBe(sha);
  });

  test("refuses to add worktree on a protected branch", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitWorktreeAddTool);
    const text = await run({
      workspaceRoot: dir,
      path: "/tmp/wt-main-protected",
      branch: "main",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("protected_branch");
  });

  test("refuses on unsafe branch name", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitWorktreeAddTool);
    const text = await run({
      workspaceRoot: dir,
      path: "/tmp/wt-bad-branch",
      branch: "bad;branch",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("refuses on unsafe baseRef", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitWorktreeAddTool);
    const text = await run({
      workspaceRoot: dir,
      path: "/tmp/wt-bad-ref",
      branch: "feature/ok",
      baseRef: "-bad",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("returns not_a_git_repository for a plain directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");
    const run = captureTool(registerGitWorktreeAddTool);
    const text = await run({
      workspaceRoot: dir,
      path: "/tmp/wt-nongit",
      branch: "feature/x",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("not_a_git_repository");
  });
});

// ---------------------------------------------------------------------------
// git_worktree_remove
// ---------------------------------------------------------------------------

describe("git_worktree_remove", () => {
  test("removes an existing worktree (json)", async () => {
    const dir = makeRepo();
    const wtPath = trackTmpPath(join(dir, "../wt-to-remove"));
    gitCmd(dir, "worktree", "add", "-b", "feature/to-remove", wtPath);

    const run = captureTool(registerGitWorktreeRemoveTool);
    const text = await run({ workspaceRoot: dir, path: wtPath, format: "json" });
    const parsed = JSON.parse(text) as { ok: boolean };

    expect(parsed.ok).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
  });

  test("markdown format shows removed path", async () => {
    const dir = makeRepo();
    const wtPath = trackTmpPath(join(dir, "../wt-to-remove-md"));
    gitCmd(dir, "worktree", "add", "-b", "feature/remove-md", wtPath);

    const run = captureTool(registerGitWorktreeRemoveTool);
    const text = await run({ workspaceRoot: dir, path: wtPath });

    expect(text).toContain("# Worktree removed");
    expect(text).toContain(wtPath);
  });

  test("cannot_remove_main_worktree refuses to remove the main worktree", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitWorktreeRemoveTool);
    const text = await run({ workspaceRoot: dir, path: dir, format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("cannot_remove_main_worktree");
  });

  test("worktree_not_found for a path not registered as a worktree", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitWorktreeRemoveTool);
    const text = await run({
      workspaceRoot: dir,
      path: "/tmp/nonexistent-worktree-xyz-abc",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("worktree_not_found");
  });

  test("returns not_a_git_repository for a plain directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");
    const run = captureTool(registerGitWorktreeRemoveTool);
    const text = await run({ workspaceRoot: dir, path: "/tmp/some-wt", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("not_a_git_repository");
  });
});
