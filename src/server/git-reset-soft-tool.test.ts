/**
 * Integration tests for git_reset_soft.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitResetSoftTool } from "./git-reset-soft-tool.js";
import {
  addCommit,
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_reset_soft", () => {
  test("resets HEAD~1 and stages the rewound commit's file (json)", async () => {
    const dir = makeRepoWithSeed();
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

  test("markdown format contains before→after SHAs", async () => {
    const dir = makeRepoWithSeed();
    addCommit(dir, "x.ts", "export const x = 0;\n", "feat: x");

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD~1" });

    expect(text).toContain("# Reset (soft)");
    expect(text).toMatch(/→/);
    expect(text).toContain("file(s) staged");
  });

  test("refuses when working tree has untracked changes", async () => {
    const dir = makeRepoWithSeed();
    writeFileSync(join(dir, "dirty.ts"), "dirty\n");

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD~1", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("working_tree_dirty");
  });

  test("refuses on unsafe ref token (shell metachar)", async () => {
    const dir = makeRepoWithSeed();

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD;echo evil", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("returns reset_failed for a non-existent ref", async () => {
    const dir = makeRepoWithSeed();

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "nonexistent-ref-xyz", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("reset_failed");
  });

  test("refuses to reset onto a non-ancestor ref unless force:true", async () => {
    const dir = makeRepoWithSeed();
    // Diverge: a sibling branch that shares the seed commit but is not an
    // ancestor of main's tip after main gains its own commit.
    gitCmd(dir, "branch", "sibling");
    gitCmd(dir, "checkout", "sibling");
    addCommit(dir, "sibling.ts", "export const s = 1;\n", "feat: sibling work");
    const siblingSha = gitCmd(dir, "rev-parse", "sibling").trim();
    gitCmd(dir, "checkout", "main");
    addCommit(dir, "main.ts", "export const m = 1;\n", "feat: main work");

    const run = captureTool(registerGitResetSoftTool);
    const failText = await run({ workspaceRoot: dir, ref: siblingSha, format: "json" });
    const failParsed = JSON.parse(failText) as { error: string; ref: string };
    expect(failParsed.error).toBe("reset_not_ancestor");
    expect(failParsed.ref).toBe(siblingSha);

    // HEAD is unchanged after the refusal.
    const headAfterFail = gitCmd(dir, "rev-parse", "HEAD").trim();
    expect(headAfterFail).not.toBe(siblingSha);

    const forceText = await run({
      workspaceRoot: dir,
      ref: siblingSha,
      force: true,
      format: "json",
    });
    const forceParsed = JSON.parse(forceText) as { ok: boolean; afterSha: string };
    expect(forceParsed.ok).toBe(true);
    expect(forceParsed.afterSha).toBe(siblingSha);
  });

  test("allows resetting to an ancestor ref without force", async () => {
    const dir = makeRepoWithSeed();
    addCommit(dir, "a.ts", "export const a = 1;\n", "feat: add a");
    const parentSha = gitCmd(dir, "rev-parse", "HEAD~1").trim();

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: parentSha, format: "json" });
    const parsed = JSON.parse(text) as { ok: boolean; afterSha: string };

    expect(parsed.ok).toBe(true);
    expect(parsed.afterSha).toBe(parentSha);
  });

  test("returns not_a_git_repository for a plain directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");

    const run = captureTool(registerGitResetSoftTool);
    const text = await run({ workspaceRoot: dir, ref: "HEAD~1", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("not_a_git_repository");
  });
});
