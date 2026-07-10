/**
 * Pure-helper tests for src/server/git-refs.ts.
 *
 * Async helpers (getCurrentBranch, isWorkingTreeClean, etc.) are exercised
 * through the integration tests for git_merge and git_cherry_pick.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  isContentEquivalentlyMergedInto,
  isProtectedBranch,
  isSafeGitAncestorRef,
  isSafeGitCommitIsh,
  isSafeGitRangeToken,
  isSafeGitRefToken,
} from "./git-refs.js";
import { cleanupTmpPaths, gitCmd, makeRepoWithSeed } from "./test-harness.js";

afterEach(cleanupTmpPaths);

// ---------------------------------------------------------------------------
// Integration: isContentEquivalentlyMergedInto
// ---------------------------------------------------------------------------

function makeRepo(): string {
  return makeRepoWithSeed("mcp-git-refs-test-");
}

function addFile(dir: string, name: string, content: string, msg: string): void {
  writeFileSync(join(dir, name), content);
  gitCmd(dir, "add", name);
  gitCmd(dir, "commit", "-m", msg);
}

describe("isContentEquivalentlyMergedInto", () => {
  test("returns true when branch is a direct ancestor of target (fast-forward merged)", async () => {
    const dir = makeRepo();
    addFile(dir, "a.ts", "const a = 1;\n", "feat: a");

    // Create feature branch at same commit, then add another commit on main.
    gitCmd(dir, "checkout", "-b", "feature");
    addFile(dir, "b.ts", "const b = 2;\n", "feat: b");
    gitCmd(dir, "checkout", "main");
    gitCmd(dir, "merge", "--ff-only", "feature");

    expect(await isContentEquivalentlyMergedInto(dir, "feature", "main")).toBe(true);
  });

  test("returns false when branch has commits not on target", async () => {
    const dir = makeRepo();
    addFile(dir, "a.ts", "const a = 1;\n", "feat: a");
    gitCmd(dir, "checkout", "-b", "feature");
    addFile(dir, "b.ts", "const b = 2;\n", "feat: b");
    gitCmd(dir, "checkout", "main");
    // Do NOT merge — feature is ahead of main.

    expect(await isContentEquivalentlyMergedInto(dir, "feature", "main")).toBe(false);
  });

  test("returns true when cherry-picked commits are content-equivalent (different SHA)", async () => {
    const dir = makeRepo();
    addFile(dir, "a.ts", "const a = 1;\n", "feat: base");

    // Feature branch adds a commit.
    gitCmd(dir, "checkout", "-b", "feature");
    addFile(dir, "b.ts", "const b = 2;\n", "feat: b");
    const featureSha = gitCmd(dir, "rev-parse", "HEAD").trim();

    // Main advances so cherry-pick produces a different SHA.
    gitCmd(dir, "checkout", "main");
    addFile(dir, "c.ts", "const c = 3;\n", "feat: unrelated");
    gitCmd(dir, "cherry-pick", featureSha);

    expect(await isContentEquivalentlyMergedInto(dir, "feature", "main")).toBe(true);
  });

  test("returns false for unsafe ref tokens", async () => {
    const dir = makeRepo();
    addFile(dir, "a.ts", "const a = 1;\n", "feat: a");
    expect(await isContentEquivalentlyMergedInto(dir, "-bad-branch", "main")).toBe(false);
    expect(await isContentEquivalentlyMergedInto(dir, "main", "-bad-target")).toBe(false);
  });
});

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

  test("refs/heads/ prefix is stripped before checking", () => {
    expect(isProtectedBranch("refs/heads/main")).toBe(true);
    expect(isProtectedBranch("refs/heads/master")).toBe(true);
    expect(isProtectedBranch("refs/heads/develop")).toBe(true);
    expect(isProtectedBranch("refs/heads/feature/auth")).toBe(false);
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

  test("accepts ancestor notation on either endpoint", () => {
    expect(isSafeGitRangeToken("HEAD~3..HEAD")).toBe(true);
    expect(isSafeGitRangeToken("main...feature^2")).toBe(true);
  });

  test("rejects ranges with more than two endpoints", () => {
    expect(isSafeGitRangeToken("a..b..c")).toBe(false);
  });

  test("rejects ranges with invalid endpoint", () => {
    expect(isSafeGitRangeToken("main..-evil")).toBe(false);
    expect(isSafeGitRangeToken("-a..b")).toBe(false);
    expect(isSafeGitRangeToken("-x..HEAD")).toBe(false);
    expect(isSafeGitRangeToken("a.lock..b")).toBe(false);
    expect(isSafeGitRangeToken("a..b$(c)")).toBe(false);
    expect(isSafeGitRangeToken("..b")).toBe(false);
    expect(isSafeGitRangeToken("a..")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSafeGitAncestorRef
// ---------------------------------------------------------------------------

describe("isSafeGitAncestorRef", () => {
  test("accepts HEAD~N ancestor notation", () => {
    expect(isSafeGitAncestorRef("HEAD~1")).toBe(true);
    expect(isSafeGitAncestorRef("HEAD~10")).toBe(true);
    expect(isSafeGitAncestorRef("HEAD^1")).toBe(true);
  });

  test("accepts plain branch names and full SHAs", () => {
    expect(isSafeGitAncestorRef("main")).toBe(true);
    expect(isSafeGitAncestorRef("feature/auth")).toBe(true);
    expect(isSafeGitAncestorRef("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")).toBe(true);
  });

  test("rejects leading dash", () => {
    expect(isSafeGitAncestorRef("-ref")).toBe(false);
  });

  test("rejects shell metacharacters", () => {
    expect(isSafeGitAncestorRef("HEAD;evil")).toBe(false);
    expect(isSafeGitAncestorRef("HEAD$(cmd)")).toBe(false);
    expect(isSafeGitAncestorRef("HEAD ref")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isSafeGitAncestorRef("")).toBe(false);
  });

  test("rejects string longer than 256 chars", () => {
    expect(isSafeGitAncestorRef("a".repeat(257))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSafeGitCommitIsh
// ---------------------------------------------------------------------------

describe("isSafeGitCommitIsh", () => {
  test("accepts HEAD~N and mixed/chained ancestor notation", () => {
    expect(isSafeGitCommitIsh("HEAD~3")).toBe(true);
    expect(isSafeGitCommitIsh("main^2")).toBe(true);
    expect(isSafeGitCommitIsh("v1.0.0~2^1")).toBe(true);
  });

  test("accepts plain refs", () => {
    expect(isSafeGitCommitIsh("main")).toBe(true);
    expect(isSafeGitCommitIsh("feature/auth")).toBe(true);
    expect(isSafeGitCommitIsh("HEAD")).toBe(true);
    expect(isSafeGitCommitIsh("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")).toBe(true);
  });

  test("rejects range tokens (a..b)", () => {
    expect(isSafeGitCommitIsh("a..b")).toBe(false);
  });

  test("rejects leading dash", () => {
    expect(isSafeGitCommitIsh("-x")).toBe(false);
  });

  test("rejects .lock suffix", () => {
    expect(isSafeGitCommitIsh("x.lock")).toBe(false);
  });

  test("rejects double-slash", () => {
    expect(isSafeGitCommitIsh("a//b")).toBe(false);
  });

  test("rejects reflog @{ notation", () => {
    expect(isSafeGitCommitIsh("a@{1}")).toBe(false);
  });

  test("rejects whitespace", () => {
    expect(isSafeGitCommitIsh("a b")).toBe(false);
  });

  test("rejects colon (pathspec separator)", () => {
    expect(isSafeGitCommitIsh("a:b")).toBe(false);
  });

  test("rejects ancestor operators embedded mid-name", () => {
    expect(isSafeGitCommitIsh("a~b")).toBe(false);
  });

  test("rejects bare ancestor operators with no base name", () => {
    expect(isSafeGitCommitIsh("~3")).toBe(false);
    expect(isSafeGitCommitIsh("^1")).toBe(false);
  });

  test("rejects empty string and over-length tokens", () => {
    expect(isSafeGitCommitIsh("")).toBe(false);
    expect(isSafeGitCommitIsh("a".repeat(257))).toBe(false);
  });
});
