/**
 * Tests for git_stash_apply and git_stash_push: schema validation (unit)
 * + execute path (integration).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitStashApplyTool, registerGitStashPushTool } from "./git-stash-tool.js";
import { captureTool, cleanupTmpPaths, gitCmd, makeRepoWithSeed } from "./test-harness.js";

afterEach(cleanupTmpPaths);

// ---------------------------------------------------------------------------
// Integration: execute paths
// ---------------------------------------------------------------------------

function makeRepo(): string {
  return makeRepoWithSeed("mcp-stash-test-");
}

function stashCount(dir: string): number {
  return gitCmd(dir, "stash", "list")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

describe("git_stash_apply execute handler", () => {
  test("applies stash and restores staged file", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "stashed.ts"), "const s = 1;\n");
    gitCmd(dir, "add", "stashed.ts");
    gitCmd(dir, "stash", "push", "-m", "wip: apply me");

    const run = captureTool(registerGitStashApplyTool);
    const text = await run({ workspaceRoot: dir, format: "json", index: 0, pop: false });
    const parsed = JSON.parse(text) as {
      applied: boolean;
      stashIndex: number;
      popped: boolean;
    };
    expect(parsed.applied).toBe(true);
    expect(parsed.stashIndex).toBe(0);
    expect(parsed.popped).toBe(false);

    // Stash still exists (apply, not pop)
    expect(stashCount(dir)).toBe(1);
  });

  test("pop removes stash after applying", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "popped.ts"), "const p = 2;\n");
    gitCmd(dir, "add", "popped.ts");
    gitCmd(dir, "stash", "push", "-m", "wip: pop me");

    const run = captureTool(registerGitStashApplyTool);
    const text = await run({ workspaceRoot: dir, format: "json", index: 0, pop: true });
    const parsed = JSON.parse(text) as { applied: boolean; popped: boolean };
    expect(parsed.applied).toBe(true);
    expect(parsed.popped).toBe(true);

    // Stash is gone
    expect(stashCount(dir)).toBe(0);
  });

  test("apply fails when no stash exists", async () => {
    const dir = makeRepo();

    const run = captureTool(registerGitStashApplyTool);
    const text = await run({ workspaceRoot: dir, format: "json", index: 0 });
    const parsed = JSON.parse(text) as {
      applied: boolean;
      error?: string;
      conflictPaths?: string[];
    };
    expect(parsed.applied).toBe(false);
    expect(parsed.error).toBe("stash_apply_failed");
    expect(parsed.conflictPaths).toBeUndefined();
  });

  test("apply markdown success output contains stash ref", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "md.ts"), "const m = 3;\n");
    gitCmd(dir, "add", "md.ts");
    gitCmd(dir, "stash", "push", "-m", "wip: md");

    const run = captureTool(registerGitStashApplyTool);
    const text = await run({ workspaceRoot: dir, index: 0 });
    expect(text).toContain("stash@{0}");
    expect(text).toContain("applied");
  });

  test("conflicted apply returns applied=false with conflictPaths; pop retains stash", async () => {
    const dir = makeRepo();
    // Commit base → stash divergent edit → commit a different edit → apply conflicts (UU).
    writeFileSync(join(dir, "conflict.txt"), "base\n");
    gitCmd(dir, "add", "conflict.txt");
    gitCmd(dir, "commit", "-m", "base conflict file");

    writeFileSync(join(dir, "conflict.txt"), "stashed version\n");
    gitCmd(dir, "stash", "push", "-m", "wip: conflict stash");

    writeFileSync(join(dir, "conflict.txt"), "committed version\n");
    gitCmd(dir, "add", "conflict.txt");
    gitCmd(dir, "commit", "-m", "divergent commit");

    const applyRun = captureTool(registerGitStashApplyTool);
    const applyText = await applyRun({
      workspaceRoot: dir,
      format: "json",
      index: 0,
      pop: false,
    });
    const applyParsed = JSON.parse(applyText) as {
      applied: boolean;
      error?: string;
      conflictPaths?: string[];
      output?: string;
    };
    expect(applyParsed.applied).toBe(false);
    expect(applyParsed.error).toBe("stash_apply_failed");
    expect(applyParsed.conflictPaths).toBeDefined();
    expect(applyParsed.conflictPaths).toContain("conflict.txt");

    // Abort conflicted tree, then pop — conflicted pop must retain the stash entry.
    gitCmd(dir, "reset", "--hard", "HEAD");

    const popRun = captureTool(registerGitStashApplyTool);
    const popText = await popRun({
      workspaceRoot: dir,
      format: "json",
      index: 0,
      pop: true,
    });
    const popParsed = JSON.parse(popText) as {
      applied: boolean;
      popped: boolean;
      conflictPaths?: string[];
    };
    expect(popParsed.applied).toBe(false);
    expect(popParsed.popped).toBe(true);
    expect(popParsed.conflictPaths).toContain("conflict.txt");

    expect(stashCount(dir)).toBe(1);
  });
});

describe("git_stash_push execute handler", () => {
  test("stashes dirty tracked changes and cleans the working tree", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "seed.txt"), "seed\nmodified\n");

    const run = captureTool(registerGitStashPushTool);
    const text = await run({ workspaceRoot: dir, format: "json", message: "wip: pushed" });
    const parsed = JSON.parse(text) as {
      stashed: boolean;
      ref: string;
      sha: string;
      message: string;
    };

    expect(parsed.stashed).toBe(true);
    expect(parsed.ref).toBe("stash@{0}");
    expect(parsed.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.message).toContain("wip: pushed");

    // Working tree must be clean after a successful stash push.
    expect(gitCmd(dir, "status", "--porcelain").trim()).toBe("");

    expect(stashCount(dir)).toBe(1);
  });

  test("reports no_local_changes when the working tree is clean", async () => {
    const dir = makeRepo();

    const run = captureTool(registerGitStashPushTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { stashed: boolean; reason: string };

    expect(parsed.stashed).toBe(false);
    expect(parsed.reason).toBe("no_local_changes");
  });

  test("path escape via paths array returns path_escapes_repo", async () => {
    const dir = makeRepo();

    const run = captureTool(registerGitStashPushTool);
    const text = await run({
      workspaceRoot: dir,
      paths: ["../../etc/passwd"],
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string; path: string };

    expect(parsed.error).toBe("path_escapes_repo");
    expect(parsed.path).toBe("../../etc/passwd");
  });

  test("includeUntracked controls whether untracked files are stashed", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "untracked.txt"), "new file\n");

    // Without the flag, untracked-only changes are not stashed at all.
    const withoutFlag = captureTool(registerGitStashPushTool);
    const textWithout = await withoutFlag({ workspaceRoot: dir, format: "json" });
    const parsedWithout = JSON.parse(textWithout) as { stashed: boolean; reason?: string };
    expect(parsedWithout.stashed).toBe(false);
    expect(parsedWithout.reason).toBe("no_local_changes");
    expect(existsSync(join(dir, "untracked.txt"))).toBe(true);

    // With includeUntracked, the file is picked up and removed from the tree.
    const withFlag = captureTool(registerGitStashPushTool);
    const textWith = await withFlag({
      workspaceRoot: dir,
      format: "json",
      includeUntracked: true,
    });
    const parsedWith = JSON.parse(textWith) as { stashed: boolean };
    expect(parsedWith.stashed).toBe(true);
    expect(existsSync(join(dir, "untracked.txt"))).toBe(false);
  });

  test("keepIndex leaves staged content in the index after stash", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "seed.txt"), "seed\nstaged\n");
    gitCmd(dir, "add", "seed.txt");

    const run = captureTool(registerGitStashPushTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      message: "wip: keep-index",
      keepIndex: true,
    });
    const parsed = JSON.parse(text) as { stashed: boolean };
    expect(parsed.stashed).toBe(true);

    // Staged content remains; working tree matches index for the stashed path.
    const staged = gitCmd(dir, "diff", "--cached", "--name-only").trim();
    expect(staged).toContain("seed.txt");
  });

  test("paths scopes stash push to a relative in-repo file", async () => {
    const dir = makeRepo();
    // Both paths must be tracked (pathspec stash ignores untracked without -u).
    writeFileSync(join(dir, "keep.txt"), "keep\n");
    writeFileSync(join(dir, "stash-me.txt"), "stash\n");
    gitCmd(dir, "add", "keep.txt", "stash-me.txt");
    gitCmd(dir, "commit", "-m", "add scoped files");
    writeFileSync(join(dir, "keep.txt"), "keep me dirty\n");
    writeFileSync(join(dir, "stash-me.txt"), "stash this\n");

    const run = captureTool(registerGitStashPushTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      message: "wip: scoped",
      paths: ["stash-me.txt"],
    });
    const parsed = JSON.parse(text) as { stashed: boolean; message: string };
    expect(parsed.stashed).toBe(true);
    expect(parsed.message).toContain("wip: scoped");

    // Only the scoped file is cleaned; keep.txt stays dirty.
    const porcelain = gitCmd(dir, "status", "--porcelain").trim();
    expect(porcelain).toContain("keep.txt");
    expect(porcelain).not.toContain("stash-me.txt");
  });
});
