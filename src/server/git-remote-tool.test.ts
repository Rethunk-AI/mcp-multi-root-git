/**
 * Tests for git_remote tool.
 *
 * Verifies remote listing (fetch/push URL merge behavior) and the no-remotes
 * case.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import * as gitModule from "./git.js";
import { parseGitRemoteOutput, registerGitRemoteTool } from "./git-remote-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("parseGitRemoteOutput", () => {
  test("preserves first-seen remote order across multiple remotes", () => {
    const output = [
      "origin\thttps://example.com/origin.git (fetch)",
      "upstream\thttps://example.com/upstream.git (fetch)",
      "origin\thttps://example.com/origin.git (push)",
      "upstream\thttps://example.com/upstream.git (push)",
    ].join("\n");

    expect(parseGitRemoteOutput(output).map((r) => r.name)).toEqual(["origin", "upstream"]);
  });

  test("skips malformed lines and records push-only remotes", () => {
    const output = [
      "not-a-remote-line",
      "deploy\thttps://push.example/deploy.git (push)",
      "origin\thttps://fetch.example/origin.git (fetch)",
      "origin\thttps://fetch.example/origin.git (push)",
    ].join("\n");

    expect(parseGitRemoteOutput(output)).toEqual([
      { name: "deploy", fetchUrl: "", pushUrl: "https://push.example/deploy.git" },
      { name: "origin", fetchUrl: "https://fetch.example/origin.git" },
    ]);
  });

  test("includes pushUrl only when it differs from fetchUrl", () => {
    const output = [
      "origin\thttps://fetch.example/origin.git (fetch)",
      "origin\thttps://push.example/origin.git (push)",
    ].join("\n");

    expect(parseGitRemoteOutput(output)).toEqual([
      {
        name: "origin",
        fetchUrl: "https://fetch.example/origin.git",
        pushUrl: "https://push.example/origin.git",
      },
    ]);
  });
});

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

  test("returns remote_list_failed when git remote -v exits non-zero", async () => {
    const repo = makeRepoWithSeed("mcp-git-remote-fail-");
    const spawnGitAsyncMock = mock(async () => ({
      ok: false as const,
      stderr: "fatal: simulated remote list failure",
      stdout: "",
    }));

    mock.module("./git.js", () => ({
      ...gitModule,
      spawnGitAsync: spawnGitAsyncMock,
    }));

    try {
      const run = captureTool(registerGitRemoteTool);
      const text = await run({ workspaceRoot: repo, format: "json" });
      const parsed = JSON.parse(text) as { error: string; detail?: string };

      expect(parsed.error).toBe("remote_list_failed");
      expect(parsed.detail).toBe("fatal: simulated remote list failure");
      expect(spawnGitAsyncMock.mock.calls.length).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });
});
