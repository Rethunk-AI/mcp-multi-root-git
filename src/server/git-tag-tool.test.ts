/**
 * Tests for git_tag tool.
 *
 * These tests verify that the tool correctly handles tag creation
 * (annotated and lightweight), deletion, and validation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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

  test("rejects .lock tag names that upstream-token previously allowed", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "main.lock",
      format: "json",
    });
    expect(JSON.parse(text)).toEqual({ error: "unsafe_tag_token", tag: "main.lock" });
  });

  test("rejects unsafe ref tokens", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "v-unsafe-ref",
      ref: "bad;ref",
      format: "json",
    });
    expect(JSON.parse(text)).toEqual({ error: "unsafe_ref_token", ref: "bad;ref" });
  });

  test("tag_create_failed on duplicate tag (no -f overwrite)", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    gitCmd(repo, "tag", "v-dup");
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "v-dup",
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string; detail: string };
    expect(parsed.error).toBe("tag_create_failed");
    expect(parsed.detail.length).toBeGreaterThan(0);
  });

  test("tag_delete_failed for a missing tag", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "v-missing-delete",
      delete: true,
      format: "json",
    });
    const parsed = JSON.parse(text) as { error: string; detail: string };
    expect(parsed.error).toBe("tag_delete_failed");
    expect(parsed.detail.length).toBeGreaterThan(0);
  });

  test("creates a tag at HEAD~1 via commit-ish ref", async () => {
    const repo = makeRepoWithSeed("mcp-git-tag-test-");
    writeFileSync(join(repo, "second.txt"), "second\n");
    gitCmd(repo, "add", "second.txt");
    gitCmd(repo, "commit", "-m", "chore: second");
    const parentSha = gitCmd(repo, "rev-parse", "HEAD~1").trim();
    const run = captureTool(registerGitTagTool);

    const text = await run({
      workspaceRoot: repo,
      tag: "v-parent",
      ref: "HEAD~1",
      format: "json",
    });
    const parsed = JSON.parse(text) as { tag: string; type: string; sha: string };
    expect(parsed).toEqual({ tag: "v-parent", type: "lightweight", sha: parentSha });
  });
});
