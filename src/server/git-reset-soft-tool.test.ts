/**
 * Integration tests for git_reset_soft.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitResetSoftTool } from "./git-reset-soft-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

function makeRepo(): string {
  return makeRepoWithSeed("mcp-git-reset-soft-test-");
}

function addCommit(dir: string, filename: string, content: string, message: string): void {
  writeFileSync(join(dir, filename), content);
  gitCmd(dir, "add", filename);
  gitCmd(dir, "commit", "-m", message);
}

describe("git_reset_soft", () => {
  test("resets HEAD~1 and stages the rewound commit's file (json)", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.ts", "export const a = 1;\n", "feat: add a");

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD~1", format: "json" });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      beforeSha: string;
      afterSha: string;
      stagedCount: number;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.stagedCount).toBe(1);
    expect(parsed.beforeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.afterSha).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.beforeSha).not.toBe(parsed.afterSha);
  });

  test("resets HEAD~2 and stages two files", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.ts", "export const a = 1;\n", "feat: add a");
    addCommit(dir, "b.ts", "export const b = 2;\n", "feat: add b");

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD~2", format: "json" });
    const parsed = JSON.parse(text) as { ok: boolean; stagedCount: number };

    expect(parsed.ok).toBe(true);
    expect(parsed.stagedCount).toBe(2);
  });

  test("markdown format contains before→after SHAs", async () => {
    const dir = makeRepo();
    addCommit(dir, "x.ts", "export const x = 0;\n", "feat: x");

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD~1" });

    expect(text).toContain("# Reset (soft)");
    expect(text).toMatch(/→/);
    expect(text).toContain("file(s) staged");
  });

  test("refuses when working tree has untracked changes", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "dirty.ts"), "dirty\n");

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD~1", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("working_tree_dirty");
  });

  test("refuses on unsafe ref token (shell metachar)", async () => {
    const dir = makeRepo();

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD;echo evil", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("returns reset_failed for a non-existent ref", async () => {
    const dir = makeRepo();

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "nonexistent-ref-xyz", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("reset_failed");
  });

  test("returns not_a_git_repository for a plain directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD~1", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("not_a_git_repository");
  });
});
