/**
 * Tests for src/server/inventory.ts.
 *
 * Pure helpers (makeSkipEntry) are tested as unit tests; collectInventoryEntry
 * is tested with real on-disk repos.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { collectInventoryEntry, MAX_INVENTORY_ROOTS_DEFAULT, makeSkipEntry } from "./inventory.js";
import { cleanupTmpPaths, gitCmd, makeRepoWithSeed, mkTmpDir } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("MAX_INVENTORY_ROOTS_DEFAULT", () => {
  test("is a positive number", () => {
    expect(MAX_INVENTORY_ROOTS_DEFAULT).toBeGreaterThan(0);
  });
});

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

    const fixed = makeSkipEntry("label", "/p", "fixed", "reason");
    expect(fixed.upstreamMode).toBe("fixed");
  });
});

// ---------------------------------------------------------------------------
// collectInventoryEntry
// ---------------------------------------------------------------------------

describe("collectInventoryEntry", () => {
  test("auto mode without upstream reports no upstream note", async () => {
    const dir = makeRepoWithSeed();
    const entry = await collectInventoryEntry("test-repo", dir, undefined, undefined);
    expect(entry.label).toBe("test-repo");
    expect(entry.path).toBe(dir);
    expect(entry.upstreamMode).toBe("auto");
    expect(entry.upstreamNote).toBeDefined();
    expect(entry.upstreamNote).toContain("no upstream");
  });

  test("auto mode with configured upstream returns ahead/behind", async () => {
    const dir = makeRepoWithSeed();
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
    const dir = makeRepoWithSeed();
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
    const dir = makeRepoWithSeed();
    const entry = await collectInventoryEntry("test-repo", dir, "ghost-remote", "main");
    expect(entry.upstreamMode).toBe("fixed");
    expect(entry.upstreamRef).toBe("ghost-remote/main");
    expect(entry.upstreamNote).toContain("no local ref");
  });

  test("detached HEAD is detected", async () => {
    const dir = makeRepoWithSeed();
    const sha = gitCmd(dir, "rev-parse", "HEAD").trim();
    gitCmd(dir, "checkout", sha);

    const entry = await collectInventoryEntry("test-repo", dir, undefined, undefined);
    expect(entry.detached).toBe(true);
  });
});
