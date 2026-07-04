/**
 * Integration tests for git_status — covers submodule filtering logic.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
      groups: Array<{ mcpRoot: string; repos: Array<{ label: string; ok: boolean }> }>;
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

  test("markdown format output contains # Git status header", async () => {
    const dir = makeRepoWithSeed("mcp-status-md-");

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: dir });
    expect(text).toContain("# Git status");
  });

  test("multi-root markdown output contains # Multi-root git status", async () => {
    const dir1 = makeRepoWithSeed("mcp-status-mr1-");
    const dir2 = makeRepoWithSeed("mcp-status-mr2-");

    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: [dir1, dir2] });
    expect(text).toContain("# Multi-root git status");
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
});
