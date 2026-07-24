/**
 * Integration tests for git_revert_continue.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitRevertContinueTool } from "./git-revert-continue-tool.js";
import { registerGitRevertTool } from "./git-revert-tool.js";
import { captureTool, cleanupTmpPaths, gitCmd, makeRepoWithSeed } from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_revert_continue", () => {
  test("with nothing in progress returns no_revert_in_progress", async () => {
    const dir = makeRepoWithSeed();
    const run = captureTool(registerGitRevertContinueTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("no_revert_in_progress");
  });

  test("with unresolved paths returns an informative error", async () => {
    const dir = makeRepoWithSeed();
    writeFileSync(join(dir, "seed.txt"), "alpha\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: alpha");
    const alphaSha = gitCmd(dir, "rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "seed.txt"), "beta\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const runRevert = captureTool(registerGitRevertTool);
    await runRevert({
      workspaceRoot: dir,
      format: "json",
      sources: [alphaSha],
      onConflict: "pause",
    });

    const runContinue = captureTool(registerGitRevertContinueTool);
    const text = await runContinue({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { error: string; paths: string[] };
    expect(parsed.error).toBe("revert_unresolved_paths");
    expect(parsed.paths).toContain("seed.txt");

    gitCmd(dir, "revert", "--abort");
  });

  test("continue after resolving the conflict completes the remaining source", async () => {
    const dir = makeRepoWithSeed();
    writeFileSync(join(dir, "seed.txt"), "alpha\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: alpha");
    const alphaSha = gitCmd(dir, "rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "other.txt"), "other\n");
    gitCmd(dir, "add", "other.txt");
    gitCmd(dir, "commit", "-m", "feat: other");
    const otherSha = gitCmd(dir, "rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "seed.txt"), "beta\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const runRevert = captureTool(registerGitRevertTool);
    const pauseText = await runRevert({
      workspaceRoot: dir,
      format: "json",
      sources: [alphaSha, otherSha],
      onConflict: "pause",
    });
    const paused = JSON.parse(pauseText) as { ok: boolean; paused?: boolean; applied?: number };
    expect(paused.ok).toBe(false);
    expect(paused.paused).toBe(true);
    expect(paused.applied).toBe(0);

    // Resolve the conflict and stage it.
    writeFileSync(join(dir, "seed.txt"), "resolved\n");
    gitCmd(dir, "add", "seed.txt");

    const runContinue = captureTool(registerGitRevertContinueTool);
    const continueText = await runContinue({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(continueText) as { ok: boolean; action: string; applied: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("continue");
    // Resolved revert of alpha + the clean revert of otherSha both land via the resumed sequencer.
    expect(parsed.applied).toBe(2);

    expect(existsSync(join(dir, ".git", "REVERT_HEAD"))).toBe(false);
    expect(gitCmd(dir, "status", "--porcelain").trim()).toBe("");
    // other.txt was reverted away (the commit that added it is undone).
    expect(existsSync(join(dir, "other.txt"))).toBe(false);
  });

  test("action: abort restores HEAD to the pre-revert commit", async () => {
    const dir = makeRepoWithSeed();
    writeFileSync(join(dir, "seed.txt"), "alpha\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: alpha");
    const alphaSha = gitCmd(dir, "rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "seed.txt"), "beta\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");
    const preHead = gitCmd(dir, "rev-parse", "HEAD").trim();

    const runRevert = captureTool(registerGitRevertTool);
    await runRevert({
      workspaceRoot: dir,
      format: "json",
      sources: [alphaSha],
      onConflict: "pause",
    });

    const runContinue = captureTool(registerGitRevertContinueTool);
    const text = await runContinue({ workspaceRoot: dir, format: "json", action: "abort" });
    const parsed = JSON.parse(text) as { ok: boolean; action: string; headSha?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("abort");
    expect(parsed.headSha).toBe(preHead);

    expect(gitCmd(dir, "rev-parse", "HEAD").trim()).toBe(preHead);
    expect(existsSync(join(dir, ".git", "REVERT_HEAD"))).toBe(false);
    expect(gitCmd(dir, "status", "--porcelain").trim()).toBe("");
  });

  test("markdown format reports the completed continue", async () => {
    const dir = makeRepoWithSeed();
    writeFileSync(join(dir, "seed.txt"), "alpha\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: alpha");
    const alphaSha = gitCmd(dir, "rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "seed.txt"), "beta\n");
    gitCmd(dir, "add", "seed.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    const runRevert = captureTool(registerGitRevertTool);
    await runRevert({
      workspaceRoot: dir,
      format: "json",
      sources: [alphaSha],
      onConflict: "pause",
    });

    writeFileSync(join(dir, "seed.txt"), "resolved\n");
    gitCmd(dir, "add", "seed.txt");

    const runContinue = captureTool(registerGitRevertContinueTool);
    const text = await runContinue({ workspaceRoot: dir, format: "markdown" });

    expect(text).toContain("# Revert continue");
    expect(text).toContain("1 commit(s) applied");
  });
});
