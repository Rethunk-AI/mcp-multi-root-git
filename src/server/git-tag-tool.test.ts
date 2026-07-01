/**
 * Tests for git_tag tool.
 *
 * These tests verify that the tool correctly handles tag creation
 * (annotated and lightweight), deletion, and validation.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerGitTagTool } from "./git-tag-tool.js";
import { captureTool, cleanupTmpPaths, gitCmd, makeRepoWithSeed } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_tag execute handler", () => {
  test("creates a lightweight tag in json format", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    const headSha = gitCmd(repo, "rev-parse", "HEAD").trim();
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "v1.0.0",
      format: "json",
    });
    const parsed = JSON.parse(text) as { tag: string; type: string; sha: string };

    expect(parsed).toEqual({
      tag: "v1.0.0",
      type: "lightweight",
      sha: headSha,
    });
  });

  test("creates an annotated tag in markdown format", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    const headSha = gitCmd(repo, "rev-parse", "HEAD").trim();
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "v1.1.0",
      message: "Release 1.1.0",
    });

    expect(text).toContain("# Tag: v1.1.0");
    expect(text).toContain("**Type:** annotated");
    expect(text).toContain(`**SHA:** \`${headSha}\``);
    expect(text).toContain("Release 1.1.0");
  });

  test("deletes an existing tag in json format", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    gitCmd(repo, "tag", "v1.2.0");
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "v1.2.0",
      delete: true,
      format: "json",
    });
    const parsed = JSON.parse(text) as { tag: string; type: string; sha: string };

    expect(parsed).toEqual({
      tag: "v1.2.0",
      type: "deleted",
      sha: "",
    });
    expect(gitCmd(repo, "tag", "--list", "v1.2.0").trim()).toBe("");
  });

  test("returns ref_not_found for missing ref", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "v-missing-ref",
      ref: "missing-ref",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string; ref: string };

    expect(parsed).toEqual({ error: "ref_not_found", ref: "missing-ref" });
  });

  test("rejects unsafe tag names before running git", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "v1.0.0;rm",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string; tag: string };

    expect(parsed).toEqual({ error: "unsafe_tag_token", tag: "v1.0.0;rm" });
  });
});
