/**
 * Tests for git_remote tool.
 *
 * Verifies remote listing (fetch/push URL merge behavior) and the no-remotes
 * case.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerGitRemoteTool } from "./git-remote-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_remote execute handler", () => {
  test("lists a remote with identical fetch/push URL (pushUrl omitted) in json format", async () => {
    const repo = makeRepoWithSeed("mcp-git-remote-test-");
    const remoteDir = mkTmpDir("mcp-git-remote-target-");
    gitCmd(remoteDir, "init", "--bare", "-b", "main");
    gitCmd(repo, "remote", "add", "origin", remoteDir);

    const run = captureTool(registerGitRemoteTool);
    const text = await run({ workspaceRoot: repo, format: "json" });
    const parsed = JSON.parse(text) as {
      remotes: Array<{ name: string; fetchUrl: string; pushUrl?: string }>;
    };

    expect(parsed).toEqual({
      remotes: [{ name: "origin", fetchUrl: remoteDir }],
    });
  });

  test("includes pushUrl only when it differs from fetchUrl", async () => {
    const repo = makeRepoWithSeed("mcp-git-remote-test-");
    const fetchTarget = mkTmpDir("mcp-git-remote-fetch-");
    const pushTarget = mkTmpDir("mcp-git-remote-push-");
    gitCmd(fetchTarget, "init", "--bare", "-b", "main");
    gitCmd(pushTarget, "init", "--bare", "-b", "main");
    gitCmd(repo, "remote", "add", "origin", fetchTarget);
    gitCmd(repo, "remote", "set-url", "--push", "origin", pushTarget);

    const run = captureTool(registerGitRemoteTool);
    const text = await run({ workspaceRoot: repo, format: "json" });
    const parsed = JSON.parse(text) as {
      remotes: Array<{ name: string; fetchUrl: string; pushUrl?: string }>;
    };

    expect(parsed).toEqual({
      remotes: [{ name: "origin", fetchUrl: fetchTarget, pushUrl: pushTarget }],
    });
  });

  test("returns an empty remotes array when no remote is configured", async () => {
    const repo = makeRepoWithSeed("mcp-git-remote-test-");
    const run = captureTool(registerGitRemoteTool);

    const text = await run({ workspaceRoot: repo, format: "json" });
    const parsed = JSON.parse(text) as { remotes: unknown[] };

    expect(parsed).toEqual({ remotes: [] });
  });

  test("renders markdown listing by default", async () => {
    const repo = makeRepoWithSeed("mcp-git-remote-test-");
    const remoteDir = mkTmpDir("mcp-git-remote-md-");
    gitCmd(remoteDir, "init", "--bare", "-b", "main");
    gitCmd(repo, "remote", "add", "origin", remoteDir);

    const run = captureTool(registerGitRemoteTool);
    const text = await run({ workspaceRoot: repo });

    expect(text).toContain("# git remote");
    expect(text).toContain(`origin`);
    expect(text).toContain(remoteDir);
  });
});
