/**
 * Integration tests for git_inventory — covers nestedRoots paths, preset
 * conflict errors, remote/branch validation, and maxRoots truncation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitInventoryTool } from "./git-inventory-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  makeRepoWithUpstream,
  mkTmpDir,
} from "./test-harness.js";

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

  test("fixed upstream happy path: remote+branch emits upstream object and ahead/behind", async () => {
    const { work } = makeRepoWithUpstream("mcp-inv-fixed-up-", "mcp-inv-fixed-remote-");
    // Advance local ahead of origin/main
    writeFileSync(join(work, "extra.txt"), "extra\n");
    gitCmd(work, "add", "extra.txt");
    gitCmd(work, "commit", "-m", "feat: local ahead");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: work,
      format: "json",
      remote: "origin",
      branch: "main",
    });
    const parsed = JSON.parse(text) as {
      inventories: Array<{
        upstream?: { mode: string; remote: string; branch: string };
        entries: Array<{ ahead?: string; behind?: string; upstreamRef?: string }>;
      }>;
    };
    expect(parsed.inventories[0]?.upstream).toEqual({
      mode: "fixed",
      remote: "origin",
      branch: "main",
    });
    const entry = parsed.inventories[0]?.entries[0];
    expect(entry?.upstreamRef).toBe("origin/main");
    expect(entry?.ahead).toBe("1");
    expect(entry?.behind).toBe("0");
  });

  test("compareRefs: ahead/behind between two local branches", async () => {
    const dir = makeRepoWithSeed("mcp-inv-compare-");
    gitCmd(dir, "branch", "feature");
    gitCmd(dir, "checkout", "feature");
    writeFileSync(join(dir, "feat.txt"), "feat\n");
    gitCmd(dir, "add", "feat.txt");
    gitCmd(dir, "commit", "-m", "feat: on feature");
    gitCmd(dir, "checkout", "main");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: dir,
      format: "json",
      compareRefs: { left: "main", right: "feature" },
    });
    const parsed = JSON.parse(text) as {
      inventories: Array<{
        entries: Array<{
          compareRefs?: { left: string; right: string; ahead?: string; behind?: string };
        }>;
      }>;
    };
    const cr = parsed.inventories[0]?.entries[0]?.compareRefs;
    expect(cr?.left).toBe("main");
    expect(cr?.right).toBe("feature");
    expect(cr?.ahead).toBe("1");
    expect(cr?.behind).toBe("0");
  });

  test("compareRefs unsafe token rejected", async () => {
    const dir = makeRepoWithSeed("mcp-inv-compare-unsafe-");
    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: dir,
      format: "json",
      compareRefs: { left: "--evil", right: "main" },
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("preset nestedRoots loads from .rethunk/git-mcp-presets.json", async () => {
    const dir = makeRepoWithSeed("mcp-inv-preset-");
    const sub = join(dir, "pkg");
    mkdirSync(sub);
    gitCmd(sub, "init", "-b", "main");
    gitCmd(sub, "config", "user.email", "test@test.com");
    gitCmd(sub, "config", "user.name", "Test User");
    writeFileSync(join(sub, "f.ts"), "const x = 1;\n");
    gitCmd(sub, "add", "f.ts");
    gitCmd(sub, "commit", "-m", "init pkg");

    mkdirSync(join(dir, ".rethunk"), { recursive: true });
    writeFileSync(
      join(dir, ".rethunk", "git-mcp-presets.json"),
      JSON.stringify({ schemaVersion: "1", presets: { inv: { nestedRoots: ["pkg"] } } }),
    );

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: dir, format: "json", preset: "inv" });
    const parsed = JSON.parse(text) as {
      inventories: Array<{ presetSchemaVersion?: string; entries: InventoryEntry[] }>;
    };
    expect(parsed.inventories[0]?.presetSchemaVersion).toBe("1");
    expect(parsed.inventories[0]?.entries).toHaveLength(1);
    expect(parsed.inventories[0]?.entries[0]?.label).toBe("pkg");
  });

  test("preset_not_found when named preset missing", async () => {
    const dir = makeRepoWithSeed("mcp-inv-preset-miss-");
    mkdirSync(join(dir, ".rethunk"), { recursive: true });
    writeFileSync(
      join(dir, ".rethunk", "git-mcp-presets.json"),
      JSON.stringify({
        schemaVersion: "1",
        presets: { other: { nestedRoots: ["pkg"] } },
      }),
    );

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: dir, format: "json", preset: "nope" });
    // Preset resolution failures are per-root entries (contract 1) — never an
    // abort of the whole sweep, even when there's only one root in play.
    const parsed = JSON.parse(text) as {
      inventories: Array<{ entries: unknown[]; error?: { error: string } }>;
    };
    expect(parsed.inventories).toHaveLength(1);
    expect(parsed.inventories[0]?.error?.error).toBe("preset_not_found");
    expect(parsed.inventories[0]?.entries).toHaveLength(0);
  });

  test("string non-git root → skipReason not a git repository (plain text)", async () => {
    const plain = mkTmpDir("mcp-inv-nongit-");
    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: plain, format: "json" });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    expect(parsed.inventories[0]?.entries[0]?.skipReason).toBe("(not a git repository)");
    expect(parsed.inventories[0]?.entries[0]?.skipReason).not.toContain("{");
  });

  test("true 2+-sibling-repo fan-out via root array", async () => {
    const a = makeRepoWithSeed("mcp-inv-sibling-a-");
    const b = makeRepoWithSeed("mcp-inv-sibling-b-");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: [a, b], format: "json" });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    expect(parsed.inventories).toHaveLength(2);
    expect(parsed.inventories.map((g) => g.workspaceRoot)).toEqual([a, b]);
    expect(parsed.inventories[0]?.entries[0]?.label).toBe(".");
    expect(parsed.inventories[1]?.entries[0]?.label).toBe(".");
  });

  test("3-root fan-out via root array stays input-order deterministic", async () => {
    // Root-level work now runs through a bounded pool instead of a strict
    // for-loop; this proves the pool still emits results in `pre.roots`
    // order rather than completion order.
    const a = makeRepoWithSeed("mcp-inv-order-a-");
    const b = makeRepoWithSeed("mcp-inv-order-b-");
    const c = makeRepoWithSeed("mcp-inv-order-c-");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: [a, b, c], format: "json" });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    expect(parsed.inventories.map((g) => g.workspaceRoot)).toEqual([a, b, c]);
  });

  test("nestedRoots fan-out with a mix of valid/escaping/missing entries stays input-order deterministic", async () => {
    // Nested-root work is now folded into one global bounded pool (dir-check
    // + collect) rather than a per-root sequential pass; this proves the
    // final entries order still matches the pre-existing shape (skip entries
    // grouped before computed entries, each group in nestedRoots order).
    const dir = makeRepoWithSeed("mcp-inv-nested-order-");
    mkdirSync(join(dir, "pkg-a"));
    gitCmd(join(dir, "pkg-a"), "init", "-b", "main");
    mkdirSync(join(dir, "pkg-b"));
    gitCmd(join(dir, "pkg-b"), "init", "-b", "main");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: dir,
      format: "json",
      nestedRoots: ["../../outside", "pkg-a", "does-not-exist", "pkg-b"],
    });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    const entries = parsed.inventories[0]?.entries ?? [];
    expect(entries.map((e) => e.label)).toEqual([
      "../../outside",
      "does-not-exist",
      "pkg-a",
      "pkg-b",
    ]);
    expect(entries[0]?.skipReason).toContain("escapes");
    expect(entries[1]?.skipReason).toContain("not a git work tree");
    expect(entries[2]?.skipReason).toBeUndefined();
    expect(entries[3]?.skipReason).toBeUndefined();
  });

  test("compareRefs combined with fixed remote/branch: both upstream and compareRefs populate", async () => {
    const { work } = makeRepoWithUpstream("mcp-inv-combo-up-", "mcp-inv-combo-remote-");
    gitCmd(work, "branch", "feature");
    gitCmd(work, "checkout", "feature");
    writeFileSync(join(work, "feat.txt"), "feat\n");
    gitCmd(work, "add", "feat.txt");
    gitCmd(work, "commit", "-m", "feat: on feature");
    gitCmd(work, "checkout", "main");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({
      root: work,
      format: "json",
      remote: "origin",
      branch: "main",
      compareRefs: { left: "main", right: "feature" },
    });
    const parsed = JSON.parse(text) as {
      inventories: Array<{
        upstream?: { mode: string; remote: string; branch: string };
        entries: Array<{
          upstreamRef?: string;
          ahead?: string;
          behind?: string;
          compareRefs?: { left: string; right: string; ahead?: string; behind?: string };
        }>;
      }>;
    };
    expect(parsed.inventories[0]?.upstream).toEqual({
      mode: "fixed",
      remote: "origin",
      branch: "main",
    });
    const entry = parsed.inventories[0]?.entries[0];
    expect(entry?.upstreamRef).toBe("origin/main");
    expect(entry?.ahead).toBe("0");
    expect(entry?.behind).toBe("0");
    expect(entry?.compareRefs?.ahead).toBe("1");
    expect(entry?.compareRefs?.behind).toBe("0");
  });

  test("nestedRoots dedup happens before maxRoots truncation", async () => {
    const dir = makeRepoWithSeed("mcp-inv-nested-dedup-");
    for (const name of ["a", "b"]) {
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
      nestedRoots: ["a", "a", "b"],
      maxRoots: 2,
    });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    const group = parsed.inventories[0];
    // Without the duplicate "a" eaten into the truncation budget, both unique
    // paths fit under maxRoots=2 and nothing is omitted.
    expect(group?.nestedRootsTruncated).toBeUndefined();
    expect(group?.entries).toHaveLength(2);
    expect(group?.entries.map((e) => e.label)).toEqual(["a", "b"]);
  });

  test("maxBranchStatusLines caps raw branchStatus text and reports omitted count", async () => {
    const dir = makeRepoWithSeed("mcp-inv-branchcap-");
    for (const name of ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"]) {
      writeFileSync(join(dir, name), "x\n");
    }

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: dir, format: "json", maxBranchStatusLines: 3 });
    const parsed = JSON.parse(text) as {
      inventories: Array<{
        entries: Array<{
          branchStatus?: string;
          branchStatusTruncated?: boolean;
          branchStatusOmittedLines?: number;
        }>;
      }>;
    };
    const entry = parsed.inventories[0]?.entries[0];
    expect(entry?.branchStatusTruncated).toBe(true);
    expect(entry?.branchStatusOmittedLines).toBe(3);
    expect(entry?.branchStatus?.split("\n")).toHaveLength(3);
  });

  test("symlink escaping nestedRoots is rejected even though it resolves inside the toplevel lexically", async () => {
    const dir = makeRepoWithSeed("mcp-inv-symlink-");
    const outside = mkTmpDir("mcp-inv-symlink-outside-");
    const linkPath = join(dir, "escape-link");
    symlinkSync(outside, linkPath, "dir");

    const run = captureTool(registerGitInventoryTool);
    const text = await run({ root: dir, format: "json", nestedRoots: ["escape-link"] });
    const parsed = JSON.parse(text) as { inventories: InventoryGroup[] };
    const entries = parsed.inventories[0]?.entries ?? [];
    expect(entries[0]?.skipReason).toContain("path escapes");
  });

  test("preset failure on one root produces a per-root error entry instead of aborting the sweep", async () => {
    const broken = makeRepoWithSeed("mcp-inv-preset-broken-");
    mkdirSync(join(broken, ".rethunk"), { recursive: true });
    writeFileSync(join(broken, ".rethunk", "git-mcp-presets.json"), "{not valid json");

    const ok = makeRepoWithSeed("mcp-inv-preset-ok-");
    const sub = join(ok, "pkg");
    mkdirSync(sub);
    gitCmd(sub, "init", "-b", "main");
    gitCmd(sub, "config", "user.email", "test@test.com");
    gitCmd(sub, "config", "user.name", "Test User");
    writeFileSync(join(sub, "f.ts"), "const x = 1;\n");
    gitCmd(sub, "add", "f.ts");
    gitCmd(sub, "commit", "-m", "init pkg");
    mkdirSync(join(ok, ".rethunk"), { recursive: true });
    writeFileSync(
      join(ok, ".rethunk", "git-mcp-presets.json"),
      JSON.stringify({ schemaVersion: "1", presets: { inv: { nestedRoots: ["pkg"] } } }),
    );

    const run = captureTool(registerGitInventoryTool, undefined, [
      `file://${broken}`,
      `file://${ok}`,
    ]);
    const text = await run({ root: "*", format: "json", preset: "inv" });
    const parsed = JSON.parse(text) as {
      inventories: Array<{
        workspaceRoot: string;
        entries: InventoryEntry[];
        error?: { error: string };
      }>;
    };
    expect(parsed.inventories).toHaveLength(2);
    const brokenGroup = parsed.inventories[0];
    expect(brokenGroup?.workspaceRoot).toBe(broken);
    expect(brokenGroup?.error?.error).toBe("preset_file_invalid");
    expect(brokenGroup?.entries).toHaveLength(0);

    const okGroup = parsed.inventories[1];
    expect(okGroup?.workspaceRoot).toBe(ok);
    expect(okGroup?.entries).toHaveLength(1);
    expect(okGroup?.entries[0]?.label).toBe("pkg");
  });
});
