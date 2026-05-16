/**
 * Tests for git_stash_list and git_stash_apply: schema validation (unit)
 * + execute path (integration).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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
// Unit: schema validation
// ---------------------------------------------------------------------------

describe("git_stash_tool schemas", () => {
  const GitStashListParamsSchema = z.object({
    workspaceRoot: z.string().optional(),
    rootIndex: z.number().int().min(0).optional(),
    format: z.enum(["markdown", "json"]).optional().default("markdown"),
  });

  test("git_stash_list: accepts valid workspaceRoot", () => {
    const params = { workspaceRoot: "/repo", format: "json" };
    expect(() => GitStashListParamsSchema.parse(params)).not.toThrow();
  });

  test("git_stash_list: accepts valid rootIndex", () => {
    const params = { rootIndex: 0 };
    expect(() => GitStashListParamsSchema.parse(params)).not.toThrow();
  });

  test("git_stash_list: defaults format to markdown", () => {
    const params = {};
    const parsed = GitStashListParamsSchema.parse(params);
    expect(parsed.format).toBe("markdown");
  });

  test("git_stash_list: rejects negative rootIndex", () => {
    const params = { rootIndex: -1 };
    expect(() => GitStashListParamsSchema.parse(params)).toThrow();
  });

  const GitStashApplyParamsSchema = z.object({
    workspaceRoot: z.string().optional(),
    rootIndex: z.number().int().min(0).optional(),
    format: z.enum(["markdown", "json"]).optional().default("markdown"),
    index: z.number().int().min(0).optional().default(0),
    pop: z.boolean().optional().default(false),
  });

  test("git_stash_apply: defaults index to 0", () => {
    const params = {};
    const parsed = GitStashApplyParamsSchema.parse(params);
    expect(parsed.index).toBe(0);
  });

  test("git_stash_apply: defaults pop to false", () => {
    const params = {};
    const parsed = GitStashApplyParamsSchema.parse(params);
    expect(parsed.pop).toBe(false);
  });

  test("git_stash_apply: accepts custom index", () => {
    const params = { index: 5 };
    const parsed = GitStashApplyParamsSchema.parse(params);
    expect(parsed.index).toBe(5);
  });

  test("git_stash_apply: accepts pop true", () => {
    const params = { pop: true };
    const parsed = GitStashApplyParamsSchema.parse(params);
    expect(parsed.pop).toBe(true);
  });

  test("git_stash_apply: rejects negative index", () => {
    const params = { index: -1 };
    expect(() => GitStashApplyParamsSchema.parse(params)).toThrow();
  });
});

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

  test("returns stash entry after git stash", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "dirty.ts"), "const x = 1;\n");
    gitCmd(dir, "add", "dirty.ts");
    gitCmd(dir, "stash", "push", "-m", "wip: my stash");

    const run = captureTool(registerGitStashListTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      stashes: Array<{ index: number; message: string; sha: string }>;
    };
    expect(parsed.stashes).toHaveLength(1);
    expect(parsed.stashes[0]?.index).toBe(0);
    expect(parsed.stashes[0]?.message).toContain("wip: my stash");
    expect(parsed.stashes[0]?.sha).toBeDefined();
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
