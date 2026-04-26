/**
 * Tests for src/server/inventory.ts.
 *
 * Pure helpers (makeSkipEntry, buildInventorySectionMarkdown, validateRepoPath)
 * are tested as unit tests; collectInventoryEntry is tested with real on-disk repos.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ExecSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildInventorySectionMarkdown,
  collectInventoryEntry,
  makeSkipEntry,
  validateRepoPath,
} from "./inventory.js";
import { cleanupTmpPaths, mkTmpDir, writeTestGitConfig } from "./test-harness.js";

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
  const dir = mkTmpDir("mcp-inventory-test-");
  gitCmd(dir, "init", "-b", "main");
  writeTestGitConfig(dir);
  writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
  gitCmd(dir, "add", "base.ts");
  gitCmd(dir, "commit", "-m", "chore: base");
  return dir;
}

// ---------------------------------------------------------------------------
// makeSkipEntry
// ---------------------------------------------------------------------------

describe("makeSkipEntry", () => {
  test("produces an entry with all given fields", () => {
    const e = makeSkipEntry("my-label", "/abs/path", "auto", "not_a_git_repo");
    expect(e.label).toBe("my-label");
    expect(e.path).toBe("/abs/path");
    expect(e.upstreamMode).toBe("auto");
    expect(e.skipReason).toBe("not_a_git_repo");
  });

  test("fixed upstreamMode is preserved", () => {
    const e = makeSkipEntry("label", "/p", "fixed", "reason");
    expect(e.upstreamMode).toBe("fixed");
  });
});

// ---------------------------------------------------------------------------
// buildInventorySectionMarkdown
// ---------------------------------------------------------------------------

describe("buildInventorySectionMarkdown", () => {
  test("skip entry returns [empty, header, skipReason]", () => {
    const lines = buildInventorySectionMarkdown({
      label: "pkg/a",
      path: "/abs/path",
      upstreamMode: "auto",
      skipReason: "not_a_git_repo",
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("");
    expect(lines[1]).toContain("pkg/a");
    expect(lines[2]).toBe("not_a_git_repo");
  });

  test("single-line clean entry returns [empty, header, statusLine]", () => {
    const lines = buildInventorySectionMarkdown({
      label: "pkg/b",
      path: "/abs/path",
      upstreamMode: "auto",
      branchStatus: "## main",
    });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("## main");
  });

  test("entry with detached HEAD includes detached note (code block)", () => {
    const lines = buildInventorySectionMarkdown({
      label: "pkg/c",
      path: "/abs/path",
      upstreamMode: "auto",
      branchStatus: "HEAD (no branch)",
      detached: true,
    });
    const body = lines.join("\n");
    expect(body).toContain("detached HEAD");
    expect(lines).toContain("```text");
  });

  test("entry with ahead/behind/upstreamRef renders tracking info in code block", () => {
    const lines = buildInventorySectionMarkdown({
      label: "pkg/d",
      path: "/abs/path",
      upstreamMode: "auto",
      branchStatus: "## main...origin/main",
      ahead: "2",
      behind: "0",
      upstreamRef: "origin/main",
    });
    const body = lines.join("\n");
    expect(body).toContain("ahead 2");
    expect(body).toContain("origin/main");
    expect(lines).toContain("```text");
  });

  test("entry with upstreamNote (no ref counts) renders note", () => {
    const lines = buildInventorySectionMarkdown({
      label: "pkg/e",
      path: "/abs/path",
      upstreamMode: "auto",
      branchStatus: "## main",
      upstreamNote: "no upstream configured",
    });
    const body = lines.join("\n");
    expect(body).toContain("no upstream configured");
  });

  test("multi-line branchStatus triggers code block", () => {
    const lines = buildInventorySectionMarkdown({
      label: "pkg/f",
      path: "/abs",
      upstreamMode: "auto",
      branchStatus: "## main\n M file.ts",
    });
    expect(lines).toContain("```text");
  });

  test("missing branchStatus defaults to (clean)", () => {
    const lines = buildInventorySectionMarkdown({
      label: "pkg/g",
      path: "/abs",
      upstreamMode: "auto",
    });
    expect(lines.join("\n")).toContain("(clean)");
  });
});

// ---------------------------------------------------------------------------
// validateRepoPath
// ---------------------------------------------------------------------------

describe("validateRepoPath", () => {
  test("valid nested path reports underTop=true", () => {
    const dir = makeRepo();
    const result = validateRepoPath("packages/sub", dir);
    expect(result.underTop).toBe(true);
    expect(result.abs).toContain("packages/sub");
  });

  test("dotdot path that escapes the root reports underTop=false", () => {
    const dir = makeRepo();
    const result = validateRepoPath("../escape", dir);
    expect(result.underTop).toBe(false);
  });

  test("absolute path outside root reports underTop=false", () => {
    const dir = makeRepo();
    const result = validateRepoPath("/tmp/outside", dir);
    expect(result.underTop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectInventoryEntry
// ---------------------------------------------------------------------------

describe("collectInventoryEntry", () => {
  test("auto mode without upstream reports no upstream note", async () => {
    const dir = makeRepo();
    const entry = await collectInventoryEntry("test-repo", dir, undefined, undefined);
    expect(entry.label).toBe("test-repo");
    expect(entry.path).toBe(dir);
    expect(entry.upstreamMode).toBe("auto");
    expect(entry.upstreamNote).toBeDefined();
    expect(entry.upstreamNote).toContain("no upstream");
  });

  test("auto mode with configured upstream returns ahead/behind", async () => {
    const dir = makeRepo();
    const bare = mkTmpDir("mcp-inventory-remote-");
    gitCmd(bare, "init", "--bare", "-b", "main");
    gitCmd(dir, "remote", "add", "origin", bare);
    gitCmd(dir, "push", "-u", "origin", "main");

    const entry = await collectInventoryEntry("test-repo", dir, undefined, undefined);
    expect(entry.upstreamMode).toBe("auto");
    expect(entry.upstreamRef).toBeDefined();
    expect(entry.ahead).toBeDefined();
    expect(entry.behind).toBeDefined();
  });

  test("fixed mode with valid remote ref returns ahead/behind", async () => {
    const dir = makeRepo();
    const bare = mkTmpDir("mcp-inventory-remote-fixed-");
    gitCmd(bare, "init", "--bare", "-b", "main");
    gitCmd(dir, "remote", "add", "origin", bare);
    gitCmd(dir, "push", "origin", "main");

    const entry = await collectInventoryEntry("test-repo", dir, "origin", "main");
    expect(entry.upstreamMode).toBe("fixed");
    expect(entry.upstreamRef).toBe("origin/main");
    expect(entry.ahead).toBeDefined();
    expect(entry.behind).toBeDefined();
  });

  test("fixed mode with non-existent remote ref returns a note", async () => {
    const dir = makeRepo();
    const entry = await collectInventoryEntry("test-repo", dir, "ghost-remote", "main");
    expect(entry.upstreamMode).toBe("fixed");
    expect(entry.upstreamRef).toBe("ghost-remote/main");
    expect(entry.upstreamNote).toContain("no local ref");
  });

  test("detached HEAD is detected", async () => {
    const dir = makeRepo();
    const sha = gitCmd(dir, "rev-parse", "HEAD").trim();
    gitCmd(dir, "checkout", sha);

    const entry = await collectInventoryEntry("test-repo", dir, undefined, undefined);
    expect(entry.detached).toBe(true);
  });
});
