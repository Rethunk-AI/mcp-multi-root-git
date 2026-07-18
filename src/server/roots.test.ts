/**
 * Tests for root resolution paths in src/server/roots.ts.
 *
 * Covers resolveRootPathList / requireSingleRepo / requireGitAndRoots edge
 * errors directly, plus git_status happy-path routing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastMCP } from "fastmcp";

import { ERROR_CODES } from "./error-codes.js";
import { registerGitStatusTool } from "./git-status-tool.js";
import { requireGitAndRoots, requireSingleRepo, resolveRootPathList } from "./roots.js";
import { MAX_ROOT_PATHS } from "./schemas.js";
import { captureTool, cleanupTmpPaths, gitInitMain, mkTmpDir } from "./test-harness.js";

afterEach(cleanupTmpPaths);

function fakeServer(fileRoots: string[] = []): FastMCP {
  return {
    sessions: [{ roots: fileRoots.map((uri) => ({ uri })) }],
    addTool() {},
    addResource() {},
  } as unknown as FastMCP;
}

describe("resolveRootPathList", () => {
  test("returns root_list_too_many when length exceeds MAX_ROOT_PATHS", () => {
    const raw = Array.from({ length: MAX_ROOT_PATHS + 1 }, (_, i) => `/tmp/r${i}`);
    const result = resolveRootPathList(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      error: ERROR_CODES.ROOT_LIST_TOO_MANY,
      max: MAX_ROOT_PATHS,
      count: MAX_ROOT_PATHS + 1,
    });
  });

  test("returns root_list_empty for an empty array", () => {
    const result = resolveRootPathList([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ error: ERROR_CODES.ROOT_LIST_EMPTY });
  });

  test("returns invalid_root_path for a blank entry", () => {
    const blank = resolveRootPathList(["   "]);
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error).toEqual({ error: ERROR_CODES.INVALID_ROOT_PATH, path: "   " });
  });

  test("returns invalid_root_path for a non-git directory", () => {
    const dir = mkTmpDir("root-nongit-");
    const result = resolveRootPathList([dir]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(ERROR_CODES.INVALID_ROOT_PATH);
  });

  test("returns ok with unique git toplevels", () => {
    const a = mkTmpDir("root-ok-a-");
    const b = mkTmpDir("root-ok-b-");
    gitInitMain(a);
    gitInitMain(b);
    const result = resolveRootPathList([a, b, a]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual([a, b]);
  });
});

describe("requireSingleRepo", () => {
  test("returns not_a_git_repository for a plain directory", () => {
    const dir = mkTmpDir("single-nongit-");
    const result = requireSingleRepo(fakeServer(), { workspaceRoot: dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      error: ERROR_CODES.NOT_A_GIT_REPOSITORY,
      path: dir,
    });
  });

  test("returns gitTop for a valid repo", () => {
    const dir = mkTmpDir("single-git-");
    gitInitMain(dir);
    const result = requireSingleRepo(fakeServer(), { workspaceRoot: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gitTop).toBe(dir);
  });
});

describe("requireGitAndRoots", () => {
  test("root array + presetName → root_list_preset_conflict", () => {
    const a = mkTmpDir("preset-conflict-");
    gitInitMain(a);
    const result = requireGitAndRoots(fakeServer(), { root: [a] }, "fleet");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ error: ERROR_CODES.ROOT_LIST_PRESET_CONFLICT });
  });

  test('root "*" over MAX_ROOT_PATHS → root_list_too_many', () => {
    const uris = Array.from({ length: MAX_ROOT_PATHS + 1 }, (_, i) => `file:///tmp/star-root-${i}`);
    const result = requireGitAndRoots(fakeServer(uris), { root: "*" }, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      error: ERROR_CODES.ROOT_LIST_TOO_MANY,
      max: MAX_ROOT_PATHS,
      count: MAX_ROOT_PATHS + 1,
    });
  });

  test("root array of non-git paths surfaces invalid_root_path via resolveRootPathList", () => {
    const dir = mkTmpDir("fanout-nongit-");
    const result = requireGitAndRoots(fakeServer(), { root: [dir] }, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(ERROR_CODES.INVALID_ROOT_PATH);
  });
});

describe("root resolution via git_status", () => {
  test("omitting root falls back to process.cwd() (which is a git repo in CI)", async () => {
    // process.cwd() during tests is the project root — a valid git repo.
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json" });
    const parsed = JSON.parse(text) as { groups?: unknown; error?: string };
    // Either succeeds (returns groups) or returns an error — should not throw.
    expect(parsed.groups !== undefined || parsed.error !== undefined).toBe(true);
  });

  test('root: "*" with empty sessions falls back to process.cwd()', async () => {
    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: "*", format: "json" });
    const parsed = JSON.parse(text) as { groups?: unknown; error?: string };
    expect(parsed.groups !== undefined || parsed.error !== undefined).toBe(true);
  });

  test("root string targets that repo", async () => {
    const a = mkTmpDir("root-string-");
    gitInitMain(a);
    const run = captureTool(registerGitStatusTool);
    const text = await run({ root: a, format: "json" });
    const parsed = JSON.parse(text) as { groups?: { mcpRoot: string }[] };
    expect(parsed.groups?.length).toBe(1);
    expect(parsed.groups?.[0]?.mcpRoot).toBe(a);
  });

  test("root array: two sibling repos → two status groups", async () => {
    const a = mkTmpDir("abs-root-a-");
    const b = mkTmpDir("abs-root-b-");
    gitInitMain(a);
    gitInitMain(b);
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json", root: [a, b] });
    const parsed = JSON.parse(text) as { groups?: { mcpRoot: string; repos: unknown[] }[] };
    expect(parsed.groups?.length).toBe(2);
    expect(parsed.groups?.[0]?.mcpRoot).toBe(a);
    expect(parsed.groups?.[1]?.mcpRoot).toBe(b);
  });

  test('root: "*" fans out across MCP client file roots', async () => {
    const a = mkTmpDir("mcp-root-a-");
    const b = mkTmpDir("mcp-root-b-");
    gitInitMain(a);
    gitInitMain(b);
    const run = captureTool(registerGitStatusTool, undefined, [
      `file://${a}`,
      "vscode-remote://ssh-remote/ignored",
      `file://${b}`,
    ]);
    const text = await run({ root: "*", format: "json" });
    const parsed = JSON.parse(text) as { groups?: { mcpRoot: string }[] };
    expect(parsed.groups?.map((g) => g.mcpRoot)).toEqual([a, b]);
  });

  test("root array dedupes same repo (nested path + root)", async () => {
    const a = mkTmpDir("abs-root-dedupe-");
    gitInitMain(a);
    const nested = join(a, "subdir");
    mkdirSync(nested, { recursive: true });
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json", root: [nested, a] });
    const parsed = JSON.parse(text) as { groups?: unknown[] };
    expect(parsed.groups?.length).toBe(1);
  });

  test("root array over MAX_ROOT_PATHS returns root_list_too_many JSON", async () => {
    const paths = Array.from({ length: MAX_ROOT_PATHS + 1 }, (_, i) => `/tmp/too-many-${i}`);
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json", root: paths });
    const parsed = JSON.parse(text) as { error?: string; max?: number; count?: number };
    expect(parsed.error).toBe(ERROR_CODES.ROOT_LIST_TOO_MANY);
    expect(parsed.max).toBe(MAX_ROOT_PATHS);
    expect(parsed.count).toBe(MAX_ROOT_PATHS + 1);
  });
});
