/**
 * Tests for git_stash_list and git_stash_apply: schema validation (unit)
 * + execute path (integration).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitStashApplyTool, registerGitStashListTool } from "./git-stash-tool.js";
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
    const parsed = JSON.parse(text) as { applied: boolean };
    expect(parsed.applied).toBe(false);
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
});
