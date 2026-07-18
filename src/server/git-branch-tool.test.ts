/**
 * Tests for git_branch tool.
 *
 * Verifies create/delete/rename actions, protected-branch rejection across
 * all three actions, unsafe ref token rejection, and force-delete of an
 * unmerged branch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitBranchTool } from "./git-branch-tool.js";
import { captureTool, cleanupTmpPaths, gitCmd, makeRepoWithSeed } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_branch execute handler", () => {
  test("creates then deletes a branch (happy path, json format)", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    const headSha = gitCmd(repo, "rev-parse", "HEAD").trim();
    const run = captureTool(registerGitBranchTool);

    const createText = await run({
      workspaceRoot: repo,
      action: "create",
      name: "feature/a",
      format: "json",
    });
    const created = JSON.parse(createText) as { action: string; branch: string; sha: string };
    expect(created).toEqual({ action: "create", branch: "feature/a", sha: headSha });
    expect(gitCmd(repo, "branch", "--list", "feature/a").trim()).not.toBe("");

    const deleteText = await run({
      workspaceRoot: repo,
      action: "delete",
      name: "feature/a",
      format: "json",
    });
    const deleted = JSON.parse(deleteText) as { action: string; branch: string; sha: string };
    expect(deleted).toEqual({ action: "delete", branch: "feature/a", sha: headSha });
    expect(gitCmd(repo, "branch", "--list", "feature/a").trim()).toBe("");
  });

  test("renames a branch and returns the tip SHA in markdown format", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    const headSha = gitCmd(repo, "rev-parse", "HEAD").trim();
    gitCmd(repo, "branch", "old-name");
    const run = captureTool(registerGitBranchTool);

    const text = await run({
      workspaceRoot: repo,
      action: "rename",
      name: "old-name",
      newName: "new-name",
    });

    expect(text).toContain("# Branch renamed: old-name → new-name");
    expect(text).toContain(`**SHA:** \`${headSha}\``);
    expect(gitCmd(repo, "branch", "--list", "old-name").trim()).toBe("");
    expect(gitCmd(repo, "branch", "--list", "new-name").trim()).not.toBe("");
  });

  test("rejects protected branch names for create, delete, and rename", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    const run = captureTool(registerGitBranchTool);

    const createText = await run({
      workspaceRoot: repo,
      action: "create",
      name: "main",
      format: "json",
    });
    expect(JSON.parse(createText)).toEqual({ error: "protected_branch", branch: "main" });

    const deleteText = await run({
      workspaceRoot: repo,
      action: "delete",
      name: "main",
      format: "json",
    });
    expect(JSON.parse(deleteText)).toEqual({ error: "protected_branch", branch: "main" });

    // Renaming FROM a protected name is rejected before newName is even considered.
    const renameFromText = await run({
      workspaceRoot: repo,
      action: "rename",
      name: "main",
      newName: "feature/x",
      format: "json",
    });
    expect(JSON.parse(renameFromText)).toEqual({ error: "protected_branch", branch: "main" });

    // Renaming TO a protected name is rejected too.
    gitCmd(repo, "branch", "feature/y");
    const renameToText = await run({
      workspaceRoot: repo,
      action: "rename",
      name: "feature/y",
      newName: "master",
      format: "json",
    });
    expect(JSON.parse(renameToText)).toEqual({ error: "protected_branch", branch: "master" });
  });

  test("rejects unsafe ref tokens before running git", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    const run = captureTool(registerGitBranchTool);

    const text = await run({
      workspaceRoot: repo,
      action: "create",
      name: "feature;rm -rf",
      format: "json",
    });
    expect(JSON.parse(text)).toEqual({ error: "unsafe_ref_token", ref: "feature;rm -rf" });
  });

  test("force delete removes an unmerged branch (-D)", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    gitCmd(repo, "checkout", "-b", "unmerged");
    writeFileSync(join(repo, "unmerged.txt"), "unmerged\n");
    gitCmd(repo, "add", "unmerged.txt");
    gitCmd(repo, "commit", "-m", "feat: unmerged work");
    const unmergedSha = gitCmd(repo, "rev-parse", "unmerged").trim();
    gitCmd(repo, "checkout", "main");
    const run = captureTool(registerGitBranchTool);

    // Plain -d refuses to delete an unmerged branch.
    const softText = await run({
      workspaceRoot: repo,
      action: "delete",
      name: "unmerged",
      format: "json",
    });
    const softResult = JSON.parse(softText) as { error: string; detail: string };
    expect(softResult.error).toBe("branch_delete_failed");
    expect(gitCmd(repo, "branch", "--list", "unmerged").trim()).not.toBe("");

    const forceText = await run({
      workspaceRoot: repo,
      action: "delete",
      name: "unmerged",
      force: true,
      format: "json",
    });
    const forceResult = JSON.parse(forceText) as { action: string; branch: string; sha: string };
    expect(forceResult).toEqual({ action: "delete", branch: "unmerged", sha: unmergedSha });
    expect(gitCmd(repo, "branch", "--list", "unmerged").trim()).toBe("");
  });

  test("force:true still refuses protected branch delete (name=main)", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    const run = captureTool(registerGitBranchTool);

    const text = await run({
      workspaceRoot: repo,
      action: "delete",
      name: "main",
      force: true,
      format: "json",
    });
    expect(JSON.parse(text)).toEqual({ error: "protected_branch", branch: "main" });
  });

  test("rejects unsafe from token on create", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    const run = captureTool(registerGitBranchTool);

    const text = await run({
      workspaceRoot: repo,
      action: "create",
      name: "feature/from-bad",
      from: "HEAD;rm",
      format: "json",
    });
    expect(JSON.parse(text)).toEqual({ error: "unsafe_ref_token", ref: "HEAD;rm" });
  });

  test("ref_not_found when create from is missing", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    const run = captureTool(registerGitBranchTool);

    const text = await run({
      workspaceRoot: repo,
      action: "create",
      name: "feature/missing-from",
      from: "no-such-ref",
      format: "json",
    });
    expect(JSON.parse(text)).toEqual({ error: "ref_not_found", ref: "no-such-ref" });
  });

  test("missing_new_name on rename without newName", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    gitCmd(repo, "branch", "to-rename");
    const run = captureTool(registerGitBranchTool);

    const text = await run({
      workspaceRoot: repo,
      action: "rename",
      name: "to-rename",
      format: "json",
    });
    expect(JSON.parse(text)).toEqual({ error: "missing_new_name" });
  });

  test("rejects unsafe newName on rename", async () => {
    const repo = makeRepoWithSeed("mcp-git-branch-test-");
    gitCmd(repo, "branch", "to-rename-2");
    const run = captureTool(registerGitBranchTool);

    const text = await run({
      workspaceRoot: repo,
      action: "rename",
      name: "to-rename-2",
      newName: "bad;name",
      format: "json",
    });
    expect(JSON.parse(text)).toEqual({ error: "unsafe_ref_token", ref: "bad;name" });
  });
});
