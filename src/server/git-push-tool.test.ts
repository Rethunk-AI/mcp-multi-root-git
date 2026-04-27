/**
 * Integration tests for git_push.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitPushTool } from "./git-push-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithUpstream,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

function makeRepoWithRemote(): { dir: string; remote: string } {
  // Use shared builder then add extra seed file (diverges from standard)
  const { work: dir, remote } = makeRepoWithUpstream("mcp-git-push-test-", "mcp-git-push-remote-");
  writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
  gitCmd(dir, "add", "base.ts");
  gitCmd(dir, "commit", "-m", "chore: base");
  gitCmd(dir, "push", "origin", "main");
  return { dir, remote };
}

describe("git_push", () => {
  test("pushes to configured upstream (json)", async () => {
    const { dir } = makeRepoWithRemote();
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
    gitCmd(dir, "add", "new.ts");
    gitCmd(dir, "commit", "-m", "feat: new");

    const run = captureTool(registerGitPushTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { ok: boolean; branch: string; upstream: string };

    expect(parsed.ok).toBe(true);
    expect(parsed.branch).toBe("main");
    expect(parsed.upstream).toContain("origin");
  });

  test("pushes to configured upstream (markdown)", async () => {
    const { dir } = makeRepoWithRemote();
    writeFileSync(join(dir, "new2.ts"), "export const n2 = 2;\n");
    gitCmd(dir, "add", "new2.ts");
    gitCmd(dir, "commit", "-m", "feat: new2");

    const run = captureTool(registerGitPushTool);
    const text = await run({ workspaceRoot: dir });

    expect(text).toContain("# Push");
    expect(text).toContain("main");
    expect(text).toContain("→");
  });

  test("setUpstream=true sets tracking on a branch with no upstream (json)", async () => {
    const dir = mkTmpDir("mcp-git-push-set-upstream-");
    const remote = mkTmpDir("mcp-git-push-set-upstream-remote-");
    gitCmd(dir, "init", "-b", "feature/new");
    writeTestGitConfig(dir);
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    gitCmd(remote, "init", "--bare", "-b", "feature/new");
    gitCmd(dir, "remote", "add", "origin", remote);

    const run = captureTool(registerGitPushTool);
    const text = await run({ workspaceRoot: dir, setUpstream: true, format: "json" });
    const parsed = JSON.parse(text) as { ok: boolean; setUpstream?: boolean };

    expect(parsed.ok).toBe(true);
    expect(parsed.setUpstream).toBe(true);
  });

  test("explicit remote overrides inferred remote", async () => {
    const { dir, remote } = makeRepoWithRemote();
    // Add a second remote pointing to the same bare repo
    gitCmd(dir, "remote", "add", "mirror", remote);
    writeFileSync(join(dir, "c.ts"), "export const c = 3;\n");
    gitCmd(dir, "add", "c.ts");
    gitCmd(dir, "commit", "-m", "feat: c");

    const run = captureTool(registerGitPushTool);
    const text = await run({ workspaceRoot: dir, remote: "mirror", format: "json" });
    const parsed = JSON.parse(text) as { ok: boolean; remote: string };

    expect(parsed.ok).toBe(true);
    expect(parsed.remote).toBe("mirror");
  });

  test("push_no_upstream when no tracking configured", async () => {
    const dir = mkTmpDir("mcp-git-push-no-upstream-");
    gitCmd(dir, "init", "-b", "main");
    writeTestGitConfig(dir);
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    const run = captureTool(registerGitPushTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("push_no_upstream");
  });

  test("push_detached_head when HEAD is detached", async () => {
    const dir = mkTmpDir("mcp-git-push-detached-");
    gitCmd(dir, "init", "-b", "main");
    writeTestGitConfig(dir);
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    const sha = gitCmd(dir, "rev-parse", "HEAD").trim();
    gitCmd(dir, "checkout", sha);

    const run = captureTool(registerGitPushTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("push_detached_head");
  });

  test("unsafe_ref_token for a bad branch argument", async () => {
    const { dir } = makeRepoWithRemote();

    const run = captureTool(registerGitPushTool);
    const text = await run({ workspaceRoot: dir, branch: "bad;branch", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("unsafe_remote_token for a bad remote argument", async () => {
    const { dir } = makeRepoWithRemote();

    const run = captureTool(registerGitPushTool);
    const text = await run({ workspaceRoot: dir, remote: "bad;remote", format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("unsafe_remote_token");
  });

  test("not_a_git_repository for a plain directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");

    const run = captureTool(registerGitPushTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { error: string };

    expect(parsed.error).toBe("not_a_git_repository");
  });
});
