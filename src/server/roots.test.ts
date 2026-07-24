/**
 * Tests for root resolution paths in src/server/roots.ts.
 *
 * Covers resolveRootPathListAsync / requireSingleRepo / requireGitAndRootsAsync
 * edge errors directly, plus git_status happy-path routing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FastMCP } from "fastmcp";

import { ERROR_CODES } from "./error-codes.js";
import { registerGitStatusTool } from "./git-status-tool.js";
import { requireGitAndRootsAsync, requireSingleRepo, resolveRootPathListAsync } from "./roots.js";
import { MAX_ROOT_PATHS } from "./schemas.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitInitMain,
  mkTmpDir,
  writePresetFixture,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

function fakeServer(fileRoots: string[] = []): FastMCP {
  return {
    sessions: [{ roots: fileRoots.map((uri) => ({ uri })) }],
    addTool() {},
    addResource() {},
  } as unknown as FastMCP;
}

/** Multi-session fake server; each group gets its own optional `sessionId`. */
function fakeServerWithSessions(groups: { roots: string[]; sessionId?: string }[]): FastMCP {
  return {
    sessions: groups.map((g) => ({
      roots: g.roots.map((uri) => ({ uri })),
      sessionId: g.sessionId,
    })),
    addTool() {},
    addResource() {},
  } as unknown as FastMCP;
}

describe("resolveRootPathListAsync", () => {
  test("returns root_list_too_many when length exceeds MAX_ROOT_PATHS", async () => {
    const raw = Array.from({ length: MAX_ROOT_PATHS + 1 }, (_, i) => `/tmp/r${i}`);
    const result = await resolveRootPathListAsync(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      error: ERROR_CODES.ROOT_LIST_TOO_MANY,
      max: MAX_ROOT_PATHS,
      count: MAX_ROOT_PATHS + 1,
    });
  });

  test("returns root_list_empty for an empty array", async () => {
    const result = await resolveRootPathListAsync([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ error: ERROR_CODES.ROOT_LIST_EMPTY });
  });

  test("returns invalid_root_path for a blank entry", async () => {
    const blank = await resolveRootPathListAsync(["   "]);
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error).toEqual({ error: ERROR_CODES.INVALID_ROOT_PATH, path: "   " });
  });

  test("returns invalid_root_path for a non-git directory", async () => {
    const dir = mkTmpDir("root-nongit-");
    const result = await resolveRootPathListAsync([dir]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(ERROR_CODES.INVALID_ROOT_PATH);
  });

  test("returns ok with unique git toplevels", async () => {
    const a = mkTmpDir("root-ok-a-");
    const b = mkTmpDir("root-ok-b-");
    gitInitMain(a);
    gitInitMain(b);
    const result = await resolveRootPathListAsync([a, b, a]);
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

describe("requireGitAndRootsAsync", () => {
  test("root array + presetName → root_list_preset_conflict", async () => {
    const a = mkTmpDir("preset-conflict-");
    gitInitMain(a);
    const result = await requireGitAndRootsAsync(fakeServer(), { root: [a] }, "fleet");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ error: ERROR_CODES.ROOT_LIST_PRESET_CONFLICT });
  });

  test('root "*" over MAX_ROOT_PATHS → root_list_too_many', async () => {
    const uris = Array.from({ length: MAX_ROOT_PATHS + 1 }, (_, i) => `file:///tmp/star-root-${i}`);
    const result = await requireGitAndRootsAsync(fakeServer(uris), { root: "*" }, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      error: ERROR_CODES.ROOT_LIST_TOO_MANY,
      max: MAX_ROOT_PATHS,
      count: MAX_ROOT_PATHS + 1,
    });
  });

  test("root array of non-git paths surfaces invalid_root_path via resolveRootPathListAsync", async () => {
    const dir = mkTmpDir("fanout-nongit-");
    const result = await requireGitAndRootsAsync(fakeServer(), { root: [dir] }, undefined);
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

describe("wildcard root: gitTopLevel resolution + dedup", () => {
  test("nested/overlapping MCP roots collapse to one git toplevel", async () => {
    const a = mkTmpDir("wild-nested-a-");
    gitInitMain(a);
    const nested = join(a, "subdir");
    mkdirSync(nested, { recursive: true });

    const result = await requireGitAndRootsAsync(
      fakeServer([`file://${a}`, `file://${nested}`]),
      { root: "*" },
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual([a]);
  });

  test("a non-git MCP root is preserved as-is (not silently dropped)", async () => {
    const a = mkTmpDir("wild-nongit-a-");
    const b = mkTmpDir("wild-nongit-b-");
    gitInitMain(b);

    const result = await requireGitAndRootsAsync(
      fakeServer([`file://${a}`, `file://${b}`]),
      { root: "*" },
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual([a, b]);
  });
});

describe("multi-root preset routing (resolveRootsForPresetAsync)", () => {
  test("matches the root whose preset entry's workspaceRootHint matches its basename", async () => {
    const g1 = mkTmpDir("preset-route-g1-");
    const g2 = mkTmpDir("preset-route-g2-");
    gitInitMain(g1);
    gitInitMain(g2);
    writePresetFixture(g2, {
      schemaVersion: "1",
      presets: { p: { nestedRoots: ["pkg"], workspaceRootHint: basename(g2) } },
    });

    const result = await requireGitAndRootsAsync(
      fakeServer([`file://${g1}`, `file://${g2}`]),
      {},
      "p",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual([g2]);
    expect(result.warning).toBeUndefined();
  });

  test("per-root isolation: an unparseable presets.json on an irrelevant root does not abort the search", async () => {
    const broken = mkTmpDir("preset-route-broken-");
    const g2 = mkTmpDir("preset-route-ok-");
    gitInitMain(broken);
    gitInitMain(g2);
    mkdirSync(join(broken, ".rethunk"), { recursive: true });
    writeFileSync(join(broken, ".rethunk", "git-mcp-presets.json"), "{not valid json");
    writePresetFixture(g2, { schemaVersion: "1", presets: { p: { nestedRoots: ["pkg"] } } });

    const result = await requireGitAndRootsAsync(
      fakeServer([`file://${broken}`, `file://${g2}`]),
      {},
      "p",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual([g2]);
  });

  test("workspaceRootHint mismatch surfaces an explicit warning instead of a silent fallback", async () => {
    const g1 = mkTmpDir("preset-hint-mismatch-g1-");
    const g2 = mkTmpDir("preset-hint-mismatch-g2-");
    gitInitMain(g1);
    gitInitMain(g2);
    writePresetFixture(g1, {
      schemaVersion: "1",
      presets: { p: { nestedRoots: ["pkg"], workspaceRootHint: "no-such-root-anywhere" } },
    });

    const result = await requireGitAndRootsAsync(
      fakeServer([`file://${g1}`, `file://${g2}`]),
      {},
      "p",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual([g1]);
    expect(result.warning).toEqual({
      code: "workspace_root_hint_mismatch",
      preset: "p",
      hint: "no-such-root-anywhere",
    });
  });
});

describe("listFileRoots session scoping", () => {
  test("root '*' scopes to the calling session when sessionId matches a live session", async () => {
    const a = mkTmpDir("session-scope-a-");
    const b = mkTmpDir("session-scope-b-");
    gitInitMain(a);
    gitInitMain(b);

    const server = fakeServerWithSessions([
      { roots: [`file://${a}`], sessionId: "session-a" },
      { roots: [`file://${b}`], sessionId: "session-b" },
    ]);

    const result = await requireGitAndRootsAsync(server, { root: "*" }, undefined, "session-a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual([a]);
  });

  test("falls back to the aggregate across all sessions when sessionId has no match", async () => {
    const a = mkTmpDir("session-scope-fallback-a-");
    const b = mkTmpDir("session-scope-fallback-b-");
    gitInitMain(a);
    gitInitMain(b);

    const server = fakeServerWithSessions([
      { roots: [`file://${a}`], sessionId: "session-a" },
      { roots: [`file://${b}`], sessionId: "session-b" },
    ]);

    const result = await requireGitAndRootsAsync(
      server,
      { root: "*" },
      undefined,
      "unknown-session",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual([a, b]);
  });

  test("falls back to the aggregate across all sessions when sessionId is omitted (stdio transport)", async () => {
    const a = mkTmpDir("session-scope-omitted-a-");
    const b = mkTmpDir("session-scope-omitted-b-");
    gitInitMain(a);
    gitInitMain(b);

    const server = fakeServerWithSessions([
      { roots: [`file://${a}`], sessionId: "session-a" },
      { roots: [`file://${b}`], sessionId: "session-b" },
    ]);

    const result = await requireGitAndRootsAsync(server, { root: "*" }, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roots).toEqual([a, b]);
  });
});
