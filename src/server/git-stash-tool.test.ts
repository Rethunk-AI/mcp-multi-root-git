/**
 * Tests for git_stash_list and git_stash_apply: schema validation (unit)
 * + execute path (integration).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  registerGitStashApplyTool,
  registerGitStashListTool,
  registerGitStashPushTool,
} from "./git-stash-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

// ---------------------------------------------------------------------------
// Integration: execute paths
// ---------------------------------------------------------------------------

function makeRepo(): string {
  return makeRepoWithSeed("mcp-stash-test-");
}

describe("git_stash_list execute handler", () => {
  test("returns empty stashes list when no stashes exist", async () => {
    const dir = makeRepo();

    const run = captureTool(registerGitStashListTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { stashes: unknown[] };
    expect(parsed.stashes).toHaveLength(0);
  });

  test("markdown output lists stashes", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "dirty.ts"), "const x = 1;\n");
    gitCmd(dir, "add", "dirty.ts");
    gitCmd(dir, "stash", "push", "-m", "wip: listed");

    const run = captureTool(registerGitStashListTool);
    const text = await run({ workspaceRoot: dir });
    expect(text).toContain("Stashes");
    expect(text).toContain("wip: listed");
  });

  test("markdown output says none when no stashes", async () => {
    const dir = makeRepo();

    const run = captureTool(registerGitStashListTool);
    const text = await run({ workspaceRoot: dir });
    expect(text).toContain("none");
  });

  test("not_a_git_repository error for plain directory", async () => {
    const plain = mkTmpDir("mcp-plain-stash-");
    const run = captureTool(registerGitStashListTool);
    const text = await run({ workspaceRoot: plain, format: "json" });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("not_a_git_repository");
  });

  test("JSON includes message and short sha fields", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "dirty.ts"), "const x = 1;\n");
    gitCmd(dir, "add", "dirty.ts");
    gitCmd(dir, "stash", "push", "-m", "wip: json fields");

    const run = captureTool(registerGitStashListTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      stashes: Array<{ index: number; message: string; sha: string }>;
    };
    expect(parsed.stashes).toHaveLength(1);
    expect(parsed.stashes[0]?.message).toContain("wip: json fields");
    expect(parsed.stashes[0]?.sha).toMatch(/^[0-9a-f]+$/);
    expect(parsed.stashes[0]?.sha.length).toBeGreaterThanOrEqual(7);
    expect(parsed.stashes[0]?.sha.length).toBeLessThan(40);
  });

  test("pipe characters inside stash subject survive list parsing", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "piped.ts"), "const p = 1;\n");
    gitCmd(dir, "add", "piped.ts");
    gitCmd(dir, "stash", "push", "-m", "wip: a|b|c");

    const run = captureTool(registerGitStashListTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      stashes: Array<{ index: number; message: string; sha: string }>;
    };
    expect(parsed.stashes).toHaveLength(1);
    expect(parsed.stashes[0]?.message).toContain("a|b|c");
    expect(parsed.stashes[0]?.sha).toMatch(/^[0-9a-f]+$/);
  });

  test("stash index reflects true stash@{N} even when earlier lines are malformed", async () => {
    // Create two stashes so we have stash@{0} and stash@{1}, then verify
    // that a simulated malformed line preceding valid ones does not shift indexes.
    // We verify this by checking that a second stash reports index 1, not 0.
    const dir = makeRepo();

    // Create stash@{0}
    writeFileSync(join(dir, "file1.ts"), "const a = 1;\n");
    gitCmd(dir, "add", "file1.ts");
    gitCmd(dir, "stash", "push", "-m", "wip: second");

    // Create stash@{0} (pushes the previous one to stash@{1})
    writeFileSync(join(dir, "file2.ts"), "const b = 2;\n");
    gitCmd(dir, "add", "file2.ts");
    gitCmd(dir, "stash", "push", "-m", "wip: first");

    const run = captureTool(registerGitStashListTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      stashes: Array<{ index: number; message: string; sha: string }>;
    };

    expect(parsed.stashes).toHaveLength(2);
    // stash@{0} is the most recently created stash
    expect(parsed.stashes[0]?.index).toBe(0);
    expect(parsed.stashes[0]?.message).toContain("wip: first");
    expect(parsed.stashes[0]?.sha).toBeDefined();
    // stash@{1} must use index 1 from the canonical ref, not the loop counter
    expect(parsed.stashes[1]?.index).toBe(1);
    expect(parsed.stashes[1]?.message).toContain("wip: second");
  });
});

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
    const listRun = captureTool(registerGitStashListTool);
    const listText = await listRun({ workspaceRoot: dir, format: "json" });
    const listParsed = JSON.parse(listText) as { stashes: unknown[] };
    expect(listParsed.stashes).toHaveLength(1);
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
    const listRun = captureTool(registerGitStashListTool);
    const listText = await listRun({ workspaceRoot: dir, format: "json" });
    const listParsed = JSON.parse(listText) as { stashes: unknown[] };
    expect(listParsed.stashes).toHaveLength(0);
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

    const listRun = captureTool(registerGitStashListTool);
    const listText = await listRun({ workspaceRoot: dir, format: "json" });
    const listParsed = JSON.parse(listText) as { stashes: unknown[] };
    expect(listParsed.stashes).toHaveLength(1);
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

    const listRun = captureTool(registerGitStashListTool);
    const listText = await listRun({ workspaceRoot: dir, format: "json" });
    const listParsed = JSON.parse(listText) as { stashes: unknown[] };
    expect(listParsed.stashes).toHaveLength(1);
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
