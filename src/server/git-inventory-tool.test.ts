/**
 * Integration tests for git_inventory — covers nestedRoots paths, preset
 * conflict errors, remote/branch validation, and maxRoots truncation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitInventoryTool } from "./git-inventory-tool.js";
import { captureTool, cleanupTmpPaths, gitCmd, makeRepoWithSeed } from "./test-harness.js";

afterEach(cleanupTmpPaths);

type InventoryEntry = {
  label: string;
  path: string;
  skipReason?: string;
};

type InventoryGroup = {
  workspaceRoot: string;
  entries: InventoryEntry[];
  nestedRootsTruncated?: boolean;
  nestedRootsOmittedCount?: number;
};

describe("git_inventory execute handler", () => {
  test("basic single-repo inventory JSON", async () => {
    const dir = makeRepoWithSeed("mcp-inv-basic-");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    expect(parsed.inventories).toHaveLength(1);
    expect(parsed.inventories[0]?.entries).toHaveLength(1);
    expect(parsed.inventories[0]?.entries[0]?.label).toBe(".");
  });

  test("basic single-repo inventory markdown", async () => {
    const dir = makeRepoWithSeed("mcp-inv-md-");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: dir });
    expect(text).toContain("# Git inventory");
    expect(text).toContain(dir);
  });

  test("root_list_nested_or_preset_conflict when root array + nestedRoots", async () => {
    const dir = makeRepoWithSeed("mcp-inv-conflict-");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: [dir],
      nestedRoots: ["sub"],
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("root_list_nested_or_preset_conflict");
  });

  test("remote_branch_mismatch when only remote is provided", async () => {
    const dir = makeRepoWithSeed("mcp-inv-rbmismatch-");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: dir, format: "json", remote: "origin" });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("remote_branch_mismatch");
  });

  test("invalid_remote_or_branch when remote contains unsafe chars", async () => {
    const dir = makeRepoWithSeed("mcp-inv-badremote-");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: dir,
      format: "json",
      remote: "-evil-remote",
      branch: "main",
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("invalid_remote_or_branch");
  });

  test("nestedRoots: valid nested git repo returns inventory entry", async () => {
    const dir = makeRepoWithSeed("mcp-inv-nested-");

    // Create a nested git repo at sub/
    const subDir = join(dir, "sub");
    mkdirSync(subDir);
    gitCmd(subDir, "init", "-b", "main");
    gitCmd(subDir, "config", "user.email", "test@test.com");
    gitCmd(subDir, "config", "user.name", "Test User");
    writeFileSync(join(subDir, "sub.ts"), "const s = 1;\n");
    gitCmd(subDir, "add", "sub.ts");
    gitCmd(subDir, "commit", "-m", "init sub");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: dir, format: "json", nestedRoots: ["sub"] });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    const entries = parsed.inventories[0]?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("sub");
    expect(entries[0]?.skipReason).toBeUndefined();
  });

  test("nestedRoots: path escaping produces skip entry", async () => {
    const dir = makeRepoWithSeed("mcp-inv-escape-");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: dir,
      format: "json",
      nestedRoots: ["../../outside"],
    });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    const entries = parsed.inventories[0]?.entries ?? [];
    expect(entries[0]?.skipReason).toContain("path escapes");
  });

  test("nestedRoots: non-existent path produces skip entry", async () => {
    const dir = makeRepoWithSeed("mcp-inv-notree-");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: dir,
      format: "json",
      nestedRoots: ["does-not-exist"],
    });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    const entries = parsed.inventories[0]?.entries ?? [];
    expect(entries[0]?.skipReason).toContain("not a git work tree");
  });

  test("maxRoots truncation: omits entries beyond limit and reports count", async () => {
    const dir = makeRepoWithSeed("mcp-inv-maxroots-");

    // Create 3 nested git repos
    for (const name of ["a", "b", "c"]) {
      const sub = join(dir, name);
      mkdirSync(sub);
      gitCmd(sub, "init", "-b", "main");
      gitCmd(sub, "config", "user.email", "test@test.com");
      gitCmd(sub, "config", "user.name", "Test User");
      writeFileSync(join(sub, "f.ts"), `const ${name} = 1;\n`);
      gitCmd(sub, "add", "f.ts");
      gitCmd(sub, "commit", "-m", `init ${name}`);
    }

    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: dir,
      format: "json",
      nestedRoots: ["a", "b", "c"],
      maxRoots: 2,
    });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    const group = parsed.inventories[0];
    expect(group?.nestedRootsTruncated).toBe(true);
    expect(group?.nestedRootsOmittedCount).toBe(1);
    expect(group?.entries).toHaveLength(2);
  });
});
