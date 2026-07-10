/**
 * Tests for git_describe tool.
 *
 * Verifies tag/distance/sha parsing against an annotated tag, the no-tag
 * error payload, and unsafe ref/match rejection.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerGitDescribeTool } from "./git-describe-tool.js";
import {
  addCommit,
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

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
});
