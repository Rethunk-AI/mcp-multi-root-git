/**
 * Tests for git_describe tool.
 *
 * Verifies tag/distance/sha parsing against an annotated tag, the no-tag
 * error payload, and unsafe ref/match rejection.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  isSafeMatchPattern,
  parseDescribeOutput,
  registerGitDescribeTool,
} from "./git-describe-tool.js";
import {
  addCommit,
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("isSafeMatchPattern", () => {
  test("accepts common glob tokens", () => {
    expect(isSafeMatchPattern("v1.*")).toBe(true);
    expect(isSafeMatchPattern("release/[0-9]*")).toBe(true);
  });

  test("rejects empty, overlong, leading dash, and unsafe characters", () => {
    expect(isSafeMatchPattern("")).toBe(false);
    expect(isSafeMatchPattern("-oops")).toBe(false);
    expect(isSafeMatchPattern("a".repeat(257))).toBe(false);
    expect(isSafeMatchPattern("v1$(whoami)")).toBe(false);
  });
});

describe("parseDescribeOutput", () => {
  test("parses hyphenated tags and distance 0", () => {
    expect(parseDescribeOutput("release-1.0.0-0-gabc1234")).toEqual({
      describe: "release-1.0.0-0-gabc1234",
      tag: "release-1.0.0",
      distance: 0,
      sha: "abc1234",
    });
  });

  test("greedily splits on the final -<distance>-g<sha> suffix", () => {
    expect(parseDescribeOutput("weird-1-gabc-2-gdef5678")).toEqual({
      describe: "weird-1-gabc-2-gdef5678",
      tag: "weird-1-gabc",
      distance: 2,
      sha: "def5678",
    });
  });

  test("returns null for malformed describe strings", () => {
    expect(parseDescribeOutput("v1.0.0")).toBeNull();
    expect(parseDescribeOutput("v1.0.0-1-gh")).toBeNull();
  });
});

describe("git_describe execute handler", () => {
  test("returns tag/distance/sha for a commit past an annotated tag", async () => {
    const repo = makeRepoWithSeed("mcp-git-describe-test-");
    gitCmd(repo, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
    addCommit(repo, "file2.txt", "second\n", "chore: second");
    const headShort = gitCmd(repo, "rev-parse", "--short", "HEAD").trim();

    const run = captureTool(registerGitDescribeTool);
    const text = await run({ workspaceRoot: repo, format: "json" });
    const parsed = JSON.parse(text) as {
      describe: string;
      tag: string;
      distance: number;
      sha: string;
    };

    expect(parsed.tag).toBe("v1.0.0");
    expect(parsed.distance).toBe(1);
    expect(parsed.sha).toBe(headShort);
    expect(parsed.describe).toBe(`v1.0.0-1-g${headShort}`);
  });

  test("returns no_tag_found when no tag is reachable", async () => {
    const repo = makeRepoWithSeed("mcp-git-describe-test-");
    const run = captureTool(registerGitDescribeTool);

    const text = await run({ workspaceRoot: repo, format: "json" });
    const parsed = JSON.parse(text) as { error: string; ref: string };

    expect(parsed).toEqual({ error: "no_tag_found", ref: "HEAD" });
  });

  test("rejects an unsafe ref token before running git", async () => {
    const repo = makeRepoWithSeed("mcp-git-describe-test-");
    const run = captureTool(registerGitDescribeTool);

    const text = await run({ workspaceRoot: repo, ref: "HEAD; rm -rf /", format: "json" });
    const parsed = JSON.parse(text) as { error: string; ref: string };

    expect(parsed).toEqual({ error: "unsafe_ref_token", ref: "HEAD; rm -rf /" });
  });

  test("rejects an unsafe match pattern before running git", async () => {
    const repo = makeRepoWithSeed("mcp-git-describe-test-");
    gitCmd(repo, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
    const run = captureTool(registerGitDescribeTool);

    const text = await run({ workspaceRoot: repo, match: "-oops", format: "json" });
    const parsed = JSON.parse(text) as { error: string; match: string };

    expect(parsed).toEqual({ error: "unsafe_match_pattern", match: "-oops" });
  });

  test("respects tags:false so lightweight tags are ignored", async () => {
    const repo = makeRepoWithSeed("mcp-git-describe-lightweight-");
    gitCmd(repo, "tag", "v1.0.0");
    addCommit(repo, "file2.txt", "second\n", "chore: second");

    const run = captureTool(registerGitDescribeTool);
    const withTags = await run({ workspaceRoot: repo, format: "json" });
    const withTagsParsed = JSON.parse(withTags) as { tag: string };

    const withoutTags = await run({ workspaceRoot: repo, tags: false, format: "json" });
    const withoutTagsParsed = JSON.parse(withoutTags) as { error: string; ref: string };

    expect(withTagsParsed.tag).toBe("v1.0.0");
    expect(withoutTagsParsed).toEqual({ error: "no_tag_found", ref: "HEAD" });
  });

  test("filters candidate tags with match and honors abbrev", async () => {
    const repo = makeRepoWithSeed("mcp-git-describe-match-");
    gitCmd(repo, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
    gitCmd(repo, "tag", "-a", "v2.0.0", "-m", "v2.0.0");
    addCommit(repo, "file2.txt", "second\n", "chore: second");
    const headShort = gitCmd(repo, "rev-parse", "--short=12", "HEAD").trim();

    const run = captureTool(registerGitDescribeTool);
    const text = await run({
      workspaceRoot: repo,
      match: "v1.*",
      abbrev: 12,
      format: "json",
    });
    const parsed = JSON.parse(text) as {
      tag: string;
      distance: number;
      sha: string;
      describe: string;
    };

    expect(parsed.tag).toBe("v1.0.0");
    expect(parsed.distance).toBe(1);
    expect(parsed.sha).toHaveLength(12);
    expect(parsed.describe).toBe(`v1.0.0-1-g${headShort}`);
  });

  test("describes an ancestor ref such as HEAD~1", async () => {
    const repo = makeRepoWithSeed("mcp-git-describe-ancestor-");
    gitCmd(repo, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
    addCommit(repo, "file2.txt", "second\n", "chore: second");
    const taggedShort = gitCmd(repo, "rev-parse", "--short", "HEAD~1").trim();

    const run = captureTool(registerGitDescribeTool);
    const text = await run({ workspaceRoot: repo, ref: "HEAD~1", format: "json" });
    const parsed = JSON.parse(text) as {
      tag: string;
      distance: number;
      sha: string;
    };

    expect(parsed.tag).toBe("v1.0.0");
    expect(parsed.distance).toBe(0);
    expect(parsed.sha).toBe(taggedShort);
  });
});
