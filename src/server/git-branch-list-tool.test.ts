/**
 * Integration tests for git_branch_list_tool.
 *
 * Tests create throwaway git repos via `git init` in OS temp dirs
 * and exercise branch listing for local and remote-tracking branches.
 *
 * We test:
 *  1. Happy path: multi-branch repo — names, exactly one current:true, sha present
 *  2. includeRemotes: false — remotes key omitted from response
 *  3. includeRemotes: true — remote-tracking branches present after push
 *  4. not_a_git_repository error for non-git path
 *  5. JSON format output
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerGitBranchListTool } from "./git-branch-list-tool.js";
import {
  addCommit,
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepo,
  makeRepoWithUpstream,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_branch_list_tool", () => {
  test("happy path: multi-branch repo returns names, exactly one current, sha present", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");
    // Create a second branch (still on main)
    gitCmd(repo, "branch", "feature/my-feature");

    const tool = captureTool(registerGitBranchListTool);
    const result = await tool({ workspaceRoot: repo, format: "json" });

    const parsed = JSON.parse(result) as {
      branches: Array<{ name: string; sha: string; current: boolean; upstream?: string }>;
      remotes?: unknown;
    };

    expect(Array.isArray(parsed.branches)).toBe(true);
    expect(parsed.branches.length).toBe(2);

    const names = parsed.branches.map((b) => b.name);
    expect(names).toContain("main");
    expect(names).toContain("feature/my-feature");

    // Exactly one branch should be current
    const currentBranches = parsed.branches.filter((b) => b.current);
    expect(currentBranches.length).toBe(1);
    expect(currentBranches[0]?.name).toBe("main");

    // All branches have a non-empty sha
    for (const b of parsed.branches) {
      expect(typeof b.sha).toBe("string");
      expect(b.sha.length).toBeGreaterThan(0);
    }

    // includeRemotes defaults to false → remotes key omitted from response
    expect(parsed.remotes).toBeUndefined();
  });

  test("reports upstream tracking for a branch with origin/main", async () => {
    const { work } = makeRepoWithUpstream();

    const tool = captureTool(registerGitBranchListTool);
    const result = await tool({ workspaceRoot: work, format: "json" });
    const parsed = JSON.parse(result) as {
      branches: Array<{ name: string; upstream?: string; current: boolean }>;
    };

    const main = parsed.branches.find((b) => b.name === "main");
    expect(main?.upstream).toBe("origin/main");
    expect(main?.current).toBe(true);
  });

  test("detached HEAD yields no current:true branch", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");
    const headSha = gitCmd(repo, "rev-parse", "HEAD").trim();
    gitCmd(repo, "checkout", "--detach", headSha);

    const tool = captureTool(registerGitBranchListTool);
    const result = await tool({ workspaceRoot: repo, format: "json" });
    const parsed = JSON.parse(result) as {
      branches: Array<{ current: boolean }>;
    };

    expect(parsed.branches.some((b) => b.current)).toBe(false);
  });

  test("includeRemotes true: remote-tracking branches populated after push", async () => {
    const { work } = makeRepoWithUpstream();

    const tool = captureTool(registerGitBranchListTool);
    const result = await tool({ workspaceRoot: work, includeRemotes: true, format: "json" });

    const parsed = JSON.parse(result) as {
      branches: Array<{ name: string; sha: string; current: boolean }>;
      remotes?: Array<{ name: string; sha: string }>;
    };

    // Local branches still present
    expect(Array.isArray(parsed.branches)).toBe(true);
    expect(parsed.branches.length).toBeGreaterThan(0);

    // Remotes populated and contain origin/main
    expect(Array.isArray(parsed.remotes)).toBe(true);
    const remoteNames = (parsed.remotes ?? []).map((r) => r.name);
    expect(remoteNames).toContain("origin/main");

    // Symbolic origin/HEAD not included
    expect(remoteNames).not.toContain("origin/HEAD");

    // Each remote entry has a non-empty sha
    for (const r of parsed.remotes ?? []) {
      expect(typeof r.sha).toBe("string");
      expect(r.sha.length).toBeGreaterThan(0);
    }
  });

  test("not_a_git_repository error for non-git path", async () => {
    const tool = captureTool(registerGitBranchListTool);
    const result = await tool({ workspaceRoot: "/nonexistent/path" });

    expect(result).toContain("not_a_git_repository");
  });

  test("markdown output marks current branch with *", async () => {
    const repo = makeRepo();
    addCommit(repo, "file.txt", "content\n", "feat: add file");
    gitCmd(repo, "branch", "other-branch");

    const tool = captureTool(registerGitBranchListTool);
    const result = await tool({ workspaceRoot: repo, format: "markdown" });

    expect(result).toContain("# git branch list");
    expect(result).toContain("## Branches");
    expect(result).toContain("* **main**");
    // Non-current branch should not have the * prefix
    expect(result).not.toContain("* **other-branch**");
  });
});
