/**
 * Integration tests for git_status — covers submodule filtering logic.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitStatusTool } from "./git-status-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_status execute handler", () => {
  test("basic JSON output for clean repo", async () => {
    const dir = makeRepoWithSeed("mcp-status-basic-");

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      groups: Array<{ workspaceRoot: string; repos: Array<{ label: string; ok: boolean }> }>;
    };
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.repos[0]?.label).toBe(".");
    expect(parsed.groups[0]?.repos[0]?.ok).toBe(true);
  });

  test("not_a_git_repository: plain directory returns error row", async () => {
    const plain = mkTmpDir("mcp-status-plain-");

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: plain, format: "json" });
    const parsed = JSON.parse(text) as {
      groups: Array<{ repos: Array<{ ok: boolean; statusText: string }> }>;
    };
    expect(parsed.groups[0]?.repos[0]?.ok).toBe(false);
    expect(parsed.groups[0]?.repos[0]?.statusText).toContain("not a git repository");
  });

  test("includeSubmodules: false skips submodule discovery", async () => {
    const dir = makeRepoWithSeed("mcp-status-nosub-");
    writeFileSync(
      join(dir, ".gitmodules"),
      `[submodule "sub"]\n  path = sub\n  url = https://example.com\n`,
    );
    mkdirSync(join(dir, "sub"));

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: dir, format: "json", includeSubmodules: false });
    const parsed = JSON.parse(text) as {
      groups: Array<{ repos: Array<{ label: string }> }>;
    };
    expect(parsed.groups[0]?.repos).toHaveLength(1);
    expect(parsed.groups[0]?.repos[0]?.label).toBe(".");
  });

  test("submodule not checked out shows 'no .git' status", async () => {
    const dir = makeRepoWithSeed("mcp-status-notchecked-");
    writeFileSync(
      join(dir, ".gitmodules"),
      `[submodule "sub"]\n  path = sub\n  url = https://example.com\n`,
    );
    mkdirSync(join(dir, "sub"));

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      groups: Array<{ repos: Array<{ label: string; ok: boolean; statusText: string }> }>;
    };
    const repos = parsed.groups[0]?.repos ?? [];
    const subRow = repos.find((r) => r.label === "sub");
    expect(subRow?.ok).toBe(false);
    expect(subRow?.statusText).toContain("no .git");
  });

  test("submodule path escaping returns rejected status", async () => {
    const dir = makeRepoWithSeed("mcp-status-escape-");
    writeFileSync(
      join(dir, ".gitmodules"),
      `[submodule "escape"]\n  path = ../escape\n  url = https://example.com\n`,
    );

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      groups: Array<{ repos: Array<{ label: string; ok: boolean; statusText: string }> }>;
    };
    const repos = parsed.groups[0]?.repos ?? [];
    const escapeRow = repos.find((r) => r.label === "../escape");
    expect(escapeRow?.ok).toBe(false);
    expect(escapeRow?.statusText).toContain("escapes");
  });

  test("working submodule returns ok: true row", async () => {
    const dir = makeRepoWithSeed("mcp-status-sub-");
    writeFileSync(
      join(dir, ".gitmodules"),
      `[submodule "sub"]\n  path = sub\n  url = https://example.com\n`,
    );

    const subDir = join(dir, "sub");
    mkdirSync(subDir);
    gitCmd(subDir, "init", "-b", "main");
    gitCmd(subDir, "config", "user.email", "test@test.com");
    gitCmd(subDir, "config", "user.name", "Test User");
    writeFileSync(join(subDir, "sub.ts"), "const s = 1;\n");
    gitCmd(subDir, "add", "sub.ts");
    gitCmd(subDir, "commit", "-m", "init sub");

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      groups: Array<{ repos: Array<{ label: string; ok: boolean }> }>;
    };
    const repos = parsed.groups[0]?.repos ?? [];
    const subRow = repos.find((r) => r.label === "sub");
    expect(subRow?.ok).toBe(true);
  });

  test("symlink-based submodule path escape is rejected even though the .gitmodules path is lexically inside", async () => {
    const dir = makeRepoWithSeed("mcp-status-symlink-escape-");
    const outside = mkTmpDir("mcp-status-symlink-outside-");
    writeFileSync(
      join(dir, ".gitmodules"),
      `[submodule "linked"]\n  path = linked\n  url = https://example.com\n`,
    );
    symlinkSync(outside, join(dir, "linked"), "dir");

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      groups: Array<{ repos: Array<{ label: string; ok: boolean; statusText: string }> }>;
    };
    const repos = parsed.groups[0]?.repos ?? [];
    const linkedRow = repos.find((r) => r.label === "linked");
    expect(linkedRow?.ok).toBe(false);
    expect(linkedRow?.statusText).toContain("escapes");
  });

  test("maxChangedFiles caps changed-file lines and reports omitted count", async () => {
    const dir = makeRepoWithSeed("mcp-status-changedcap-");
    for (const name of ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"]) {
      writeFileSync(join(dir, name), "x\n");
    }

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: dir, format: "json", maxChangedFiles: 2 });
    const parsed = JSON.parse(text) as {
      groups: Array<{
        repos: Array<{
          statusText: string;
          changedFilesTruncated?: boolean;
          changedFilesOmittedCount?: number;
        }>;
      }>;
    };
    const row = parsed.groups[0]?.repos[0];
    expect(row?.changedFilesTruncated).toBe(true);
    expect(row?.changedFilesOmittedCount).toBe(3);
    // header line + 2 capped file lines
    expect(row?.statusText.split("\n")).toHaveLength(3);
  });

  test("maxSubmodules caps submodule fan-out and reports omitted count at the group level", async () => {
    const dir = makeRepoWithSeed("mcp-status-submodcap-");
    const gitmodules = ["sub1", "sub2", "sub3"]
      .map((name) => `[submodule "${name}"]\n  path = ${name}\n  url = https://example.com\n`)
      .join("");
    writeFileSync(join(dir, ".gitmodules"), gitmodules);

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: dir, format: "json", maxSubmodules: 2 });
    const parsed = JSON.parse(text) as {
      groups: Array<{
        repos: Array<{ label: string }>;
        submodulesTruncated?: boolean;
        submodulesOmittedCount?: number;
      }>;
    };
    const group = parsed.groups[0];
    expect(group?.submodulesTruncated).toBe(true);
    expect(group?.submodulesOmittedCount).toBe(1);
    // "." row + first 2 submodules only; sub3 never even attempted.
    expect(group?.repos).toHaveLength(3);
    expect(group?.repos.map((r) => r.label)).toEqual([".", "sub1", "sub2"]);
  });

  test("3-root fan-out with unequal per-root work stays input-order deterministic", async () => {
    // Root-level work now runs through a bounded pool instead of a strict
    // for-loop; giving roots different amounts of submodule work makes them
    // finish at different times, so this proves the pool still emits results
    // in `pre.roots` order rather than completion order.
    const dir1 = makeRepoWithSeed("mcp-status-order-1-");
    const dir2 = makeRepoWithSeed("mcp-status-order-2-");
    const dir3 = makeRepoWithSeed("mcp-status-order-3-");
    const gitmodules2 = ["a", "b"]
      .map((name) => `[submodule "${name}"]\n  path = ${name}\n  url = https://example.com\n`)
      .join("");
    writeFileSync(join(dir2, ".gitmodules"), gitmodules2);

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: [dir1, dir2, dir3], format: "json" });
    const parsed = JSON.parse(text) as { groups: Array<{ workspaceRoot: string }> };
    expect(parsed.groups.map((g) => g.workspaceRoot)).toEqual([dir1, dir2, dir3]);
  });
});
