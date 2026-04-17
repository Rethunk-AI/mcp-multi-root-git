/**
 * Pure-helper tests for src/server/git-refs.ts.
 *
 * Async helpers (getCurrentBranch, isWorkingTreeClean, etc.) are exercised
 * through the integration tests for git_merge and git_cherry_pick.
 */

import { describe, expect, test } from "bun:test";

import { isProtectedBranch, isSafeGitRangeToken, isSafeGitRefToken } from "./git-refs.js";

describe("isProtectedBranch", () => {
  test("exact protected names are protected", () => {
    for (const name of [
      "main",
      "master",
      "dev",
      "develop",
      "stable",
      "trunk",
      "prod",
      "production",
      "HEAD",
    ]) {
      expect(isProtectedBranch(name)).toBe(true);
    }
  });

  test("release/* and hotfix/* are protected (case-insensitive)", () => {
    expect(isProtectedBranch("release/1.2.3")).toBe(true);
    expect(isProtectedBranch("release-2024-04")).toBe(true);
    expect(isProtectedBranch("hotfix/security-patch")).toBe(true);
    expect(isProtectedBranch("Release/foo")).toBe(true);
  });

  test("feature/agent branches are not protected", () => {
    expect(isProtectedBranch("feature/auth")).toBe(false);
    expect(isProtectedBranch("worktree-agent-abc")).toBe(false);
    expect(isProtectedBranch("fix/login")).toBe(false);
  });

  test("empty / whitespace treated as protected (refuse)", () => {
    expect(isProtectedBranch("")).toBe(true);
    expect(isProtectedBranch("   ")).toBe(true);
  });

  test("release on its own (no suffix) is not matched by pattern", () => {
    // Pattern requires at least one char after release[-/]
    expect(isProtectedBranch("release")).toBe(false);
  });
});

describe("isSafeGitRefToken", () => {
  test("accepts simple branch names", () => {
    expect(isSafeGitRefToken("main")).toBe(true);
    expect(isSafeGitRefToken("feature/auth")).toBe(true);
    expect(isSafeGitRefToken("v1.2.3")).toBe(true);
    expect(isSafeGitRefToken("release-2024-04")).toBe(true);
  });

  test("rejects leading dash, double dots, @{, trailing slash / .lock", () => {
    expect(isSafeGitRefToken("-evil")).toBe(false);
    expect(isSafeGitRefToken("a..b")).toBe(false);
    expect(isSafeGitRefToken("HEAD@{1}")).toBe(false);
    expect(isSafeGitRefToken("refs/heads/main/")).toBe(false);
    expect(isSafeGitRefToken("main.lock")).toBe(false);
  });

  test("rejects shell metacharacters and spaces", () => {
    expect(isSafeGitRefToken("a;b")).toBe(false);
    expect(isSafeGitRefToken("a b")).toBe(false);
    expect(isSafeGitRefToken("a$(b)")).toBe(false);
    expect(isSafeGitRefToken("a|b")).toBe(false);
  });

  test("rejects empty and too-long", () => {
    expect(isSafeGitRefToken("")).toBe(false);
    expect(isSafeGitRefToken("a".repeat(257))).toBe(false);
  });
});

describe("isSafeGitRangeToken", () => {
  test("accepts plain refs", () => {
    expect(isSafeGitRangeToken("main")).toBe(true);
    expect(isSafeGitRangeToken("HEAD")).toBe(true);
  });

  test("accepts A..B and A...B with valid sides", () => {
    expect(isSafeGitRangeToken("main..feature")).toBe(true);
    expect(isSafeGitRangeToken("main...feature")).toBe(true);
    expect(isSafeGitRangeToken("v1.0.0..v1.1.0")).toBe(true);
  });

  test("rejects ranges with more than two endpoints", () => {
    expect(isSafeGitRangeToken("a..b..c")).toBe(false);
  });

  test("rejects ranges with invalid endpoint", () => {
    expect(isSafeGitRangeToken("main..-evil")).toBe(false);
    expect(isSafeGitRangeToken("-a..b")).toBe(false);
    expect(isSafeGitRangeToken("a..b$(c)")).toBe(false);
  });

  test("rejects empty endpoints", () => {
    expect(isSafeGitRangeToken("..b")).toBe(false);
    expect(isSafeGitRangeToken("a..")).toBe(false);
  });
});
