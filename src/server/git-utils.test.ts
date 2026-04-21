/**
 * Tests for utility functions in src/server/git.ts.
 *
 * These cover the sync helpers and async pool that are not exercised
 * by the tool-level integration tests.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ExecSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  asyncPool,
  fetchAheadBehind,
  gitRevParseGitDir,
  gitRevParseHead,
  gitStatusShortBranchAsync,
  gitStatusSnapshotAsync,
  hasGitMetadata,
  isSafeGitUpstreamToken,
  parseGitSubmodulePaths,
} from "./git.js";
import { cleanupTmpPaths, mkTmpDir } from "./test-harness.js";

afterEach(cleanupTmpPaths);

function gitCmd(cwd: string, ...args: string[]): string {
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
    },
  };
  return execFileSync("git", args, opts);
}

function makeRepo(): string {
  const dir = mkTmpDir("mcp-git-utils-test-");
  gitCmd(dir, "init", "-b", "main");
  gitCmd(dir, "config", "user.email", "test@example.com");
  gitCmd(dir, "config", "user.name", "Test User");
  gitCmd(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
  gitCmd(dir, "add", "base.ts");
  gitCmd(dir, "commit", "-m", "chore: base");
  return dir;
}

// ---------------------------------------------------------------------------
// isSafeGitUpstreamToken
// ---------------------------------------------------------------------------

describe("isSafeGitUpstreamToken", () => {
  test("accepts simple remote names", () => {
    expect(isSafeGitUpstreamToken("origin")).toBe(true);
    expect(isSafeGitUpstreamToken("upstream")).toBe(true);
    expect(isSafeGitUpstreamToken("my-remote")).toBe(true);
  });

  test("accepts remote/branch combos", () => {
    expect(isSafeGitUpstreamToken("origin/main")).toBe(true);
    expect(isSafeGitUpstreamToken("origin/feature/auth")).toBe(true);
  });

  test("rejects double-dots", () => {
    expect(isSafeGitUpstreamToken("a..b")).toBe(false);
  });

  test("rejects leading dash", () => {
    expect(isSafeGitUpstreamToken("-origin")).toBe(false);
  });

  test("rejects shell metacharacters", () => {
    expect(isSafeGitUpstreamToken("origin;evil")).toBe(false);
    expect(isSafeGitUpstreamToken("$(cmd)")).toBe(false);
    expect(isSafeGitUpstreamToken("a b")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isSafeGitUpstreamToken("")).toBe(false);
  });

  test("rejects string longer than 256 chars", () => {
    expect(isSafeGitUpstreamToken("a".repeat(257))).toBe(false);
  });

  test("accepts exactly 256 chars", () => {
    expect(isSafeGitUpstreamToken("a".repeat(256))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gitRevParseGitDir
// ---------------------------------------------------------------------------

describe("gitRevParseGitDir", () => {
  test("returns true for a valid git repository", () => {
    const dir = makeRepo();
    expect(gitRevParseGitDir(dir)).toBe(true);
  });

  test("returns false for a plain directory", () => {
    const dir = mkTmpDir("mcp-nongit-");
    expect(gitRevParseGitDir(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gitRevParseHead
// ---------------------------------------------------------------------------

describe("gitRevParseHead", () => {
  test("returns ok=true with a SHA for a repo that has commits", () => {
    const dir = makeRepo();
    const result = gitRevParseHead(dir);
    expect(result.ok).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns ok=false for a plain directory", () => {
    const dir = mkTmpDir("mcp-nongit-");
    const result = gitRevParseHead(dir);
    expect(result.ok).toBe(false);
    expect(result.sha).toBeUndefined();
    expect(typeof result.text).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// parseGitSubmodulePaths
// ---------------------------------------------------------------------------

describe("parseGitSubmodulePaths", () => {
  test("returns [] when .gitmodules does not exist", () => {
    const dir = makeRepo();
    expect(parseGitSubmodulePaths(dir)).toEqual([]);
  });

  test("returns parsed submodule paths when .gitmodules exists", () => {
    const dir = makeRepo();
    writeFileSync(
      join(dir, ".gitmodules"),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/lib.git\n',
      "utf8",
    );
    const paths = parseGitSubmodulePaths(dir);
    expect(paths).toEqual(["vendor/lib"]);
  });

  test("returns multiple paths from a multi-submodule .gitmodules", () => {
    const dir = makeRepo();
    writeFileSync(
      join(dir, ".gitmodules"),
      '[submodule "a"]\n\tpath = vendor/a\n\turl = https://a.example.com\n' +
        '[submodule "b"]\n\tpath = vendor/b\n\turl = https://b.example.com\n',
      "utf8",
    );
    const paths = parseGitSubmodulePaths(dir);
    expect(paths).toEqual(["vendor/a", "vendor/b"]);
  });
});

// ---------------------------------------------------------------------------
// hasGitMetadata
// ---------------------------------------------------------------------------

describe("hasGitMetadata", () => {
  test("returns true for a directory that contains a .git folder", () => {
    const dir = makeRepo();
    expect(hasGitMetadata(dir)).toBe(true);
  });

  test("returns false for a plain directory without .git", () => {
    const dir = mkTmpDir("mcp-nongit-");
    expect(hasGitMetadata(dir)).toBe(false);
  });

  test("returns false for a nested directory inside a repo", () => {
    const dir = makeRepo();
    const sub = join(dir, "subdir");
    mkdirSync(sub, { recursive: true });
    expect(hasGitMetadata(sub)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// asyncPool
// ---------------------------------------------------------------------------

describe("asyncPool", () => {
  test("processes all items and returns results in index order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await asyncPool(items, 2, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  test("handles a single item", async () => {
    const results = await asyncPool([42], 4, async (x) => x + 1);
    expect(results).toEqual([43]);
  });

  test("handles an empty array", async () => {
    const results = await asyncPool([], 4, async (x: number) => x);
    expect(results).toEqual([]);
  });

  test("concurrency higher than item count doesn't error", async () => {
    const results = await asyncPool([1, 2], 100, async (x) => x * 3);
    expect(results).toEqual([3, 6]);
  });
});

// ---------------------------------------------------------------------------
// gitStatusSnapshotAsync / gitStatusShortBranchAsync
// ---------------------------------------------------------------------------

describe("gitStatusSnapshotAsync", () => {
  test("succeeds for a clean repo on main", async () => {
    const dir = makeRepo();
    const snap = await gitStatusSnapshotAsync(dir);
    expect(snap.branchOk).toBe(true);
    expect(snap.branchLine).toContain("main");
  });

  test("fails gracefully for a non-git directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");
    const snap = await gitStatusSnapshotAsync(dir);
    expect(snap.branchOk).toBe(false);
    expect(typeof snap.branchLine).toBe("string");
  });
});

describe("gitStatusShortBranchAsync", () => {
  test("returns ok=true and branch text for a valid repo", async () => {
    const dir = makeRepo();
    const result = await gitStatusShortBranchAsync(dir);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("main");
  });
});

// ---------------------------------------------------------------------------
// fetchAheadBehind
// ---------------------------------------------------------------------------

describe("fetchAheadBehind", () => {
  test("returns ahead/behind counts relative to upstream", async () => {
    const dir = makeRepo();
    const bare = mkTmpDir("mcp-git-utils-remote-");
    gitCmd(bare, "init", "--bare", "-b", "main");
    gitCmd(dir, "remote", "add", "origin", bare);
    gitCmd(dir, "push", "-u", "origin", "main");

    // Add a local commit ahead of origin
    writeFileSync(join(dir, "extra.ts"), "export const e = 1;\n");
    gitCmd(dir, "add", "extra.ts");
    gitCmd(dir, "commit", "-m", "feat: extra");

    const { ahead, behind } = await fetchAheadBehind(dir, "@{u}");
    expect(ahead).toBe("1");
    expect(behind).toBe("0");
  });

  test("returns null ahead/behind for an invalid upstream spec", async () => {
    const dir = makeRepo();
    const { ahead, behind } = await fetchAheadBehind(dir, "nonexistent-spec");
    expect(ahead).toBeNull();
    expect(behind).toBeNull();
  });
});
