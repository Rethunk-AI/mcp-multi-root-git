import { afterEach, describe, expect, it, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tests for git_fetch tool: output parsing (unit) + execute path (integration).
 */

import {
  isPorcelainUnsupported,
  parseGitFetchOutput,
  registerGitFetchTool,
} from "./git-fetch-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithUpstream,
  mkTmpDir,
  writeTestGitConfig,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

describe("git_fetch isPorcelainUnsupported", () => {
  test("detects unknown-option / unknown-switch / invalid-option stderr", () => {
    expect(isPorcelainUnsupported("error: unknown option `porcelain'")).toBe(true);
    expect(isPorcelainUnsupported("error: unknown switch `porcelain'")).toBe(true);
    expect(isPorcelainUnsupported("error: invalid option: --porcelain")).toBe(true);
    expect(isPorcelainUnsupported("fatal: 'origin' does not appear to be a git repository")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Unit: parseGitFetchOutput — exercises the real git <2.41 fallback parser
// (unexported prior to this change; now covered directly).
// ---------------------------------------------------------------------------

describe("git_fetch parseGitFetchOutput", () => {
  it("parses empty output", () => {
    const result = parseGitFetchOutput("");
    expect(result.updatedRefs).toEqual([]);
    expect(result.newRefs).toEqual([]);
  });

  it("parses updated refs with -> notation", () => {
    const output = `From origin
  abc1234..def5678  main       -> origin/main`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs).toContain("abc1234..def5678  main       -> origin/main");
    expect(result.newRefs).toEqual([]);
  });

  it("parses new refs with [new tag] notation", () => {
    const output = `From origin
 * [new tag]         v1.0.0     -> v1.0.0`;

    const result = parseGitFetchOutput(output);
    expect(result.newRefs.length).toBe(1);
    expect(result.newRefs[0]).toContain("[new tag]");
    expect(result.newRefs[0]).toContain("v1.0.0");
  });

  it("parses mixed updated and new refs", () => {
    const output = `From origin
  abc1234..def5678  main       -> origin/main
 * [new branch]     feature/x  -> origin/feature/x
 * [new tag]        v2.0.0     -> v2.0.0`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs.length).toBe(1);
    expect(result.updatedRefs).toContain("abc1234..def5678  main       -> origin/main");
    expect(result.newRefs.length).toBe(2);
    expect(result.newRefs).toEqual([
      expect.stringContaining("[new branch]"),
      expect.stringContaining("[new tag]"),
    ]);
  });

  it("ignores lines without -> or [new prefix", () => {
    const output = `From origin
Fetching submodule foo
Some other message`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs).toEqual([]);
    expect(result.newRefs).toEqual([]);
  });

  it("handles whitespace correctly", () => {
    const output = `
    abc1234..def5678  main       -> origin/main
    [new tag]        v1.0.0     -> v1.0.0
    `;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs.length).toBe(1);
    expect(result.newRefs.length).toBe(1);
    expect(result.newRefs[0]).toContain("[new tag]");
  });

  it("parses pruned refs with -> notation", () => {
    const output = `From origin
 - [deleted]       origin/old-branch`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs).toEqual([]);
    expect(result.newRefs).toEqual([]);
  });

  it("captures branch tracking updates", () => {
    const output = `From origin
  d1e2f3..a4b5c6  main       -> origin/main
  1234567..abcdef  main       -> main`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs.length).toBe(2);
  });

  it("handles refs with special characters", () => {
    const output = `From origin
  abc1234..def5678  refs/pull/123/head -> origin/pull/123/head
 * [new ref]       refs/heads/feature/my-feature -> origin/feature/my-feature`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs.length).toBe(1);
    expect(result.updatedRefs[0]).toContain("refs/pull/123/head");
    expect(result.newRefs.length).toBe(1);
    expect(result.newRefs[0]).toContain("[new ref]");
  });
});

// ---------------------------------------------------------------------------
// Integration: execute path via captureTool
// ---------------------------------------------------------------------------

describe("git_fetch execute handler", () => {
  test("not_a_git_repository returns error in json format", async () => {
    const plain = mkTmpDir("mcp-plain-fetch-");
    const run = captureTool(registerGitFetchTool);
    const text = await run({ workspaceRoot: plain, format: "json" });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("not_a_git_repository");
  });

  test("fetch from local bare remote succeeds (already up to date)", async () => {
    const { work } = makeRepoWithUpstream("mcp-fetch-work-", "mcp-fetch-remote-");

    const run = captureTool(registerGitFetchTool);
    const text = await run({ workspaceRoot: work, format: "json" });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      remote: string;
      updatedRefs: string[];
      newRefs: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.remote).toBe("origin");
    expect(Array.isArray(parsed.updatedRefs)).toBe(true);
    expect(Array.isArray(parsed.newRefs)).toBe(true);
  });

  test("fetch picks up new branch pushed to remote — newRefs and created populated", async () => {
    const { work, remote } = makeRepoWithUpstream("mcp-fetch-work2-", "mcp-fetch-remote2-");

    // Push a new branch to the bare remote directly.
    const cloneDir = mkTmpDir("mcp-fetch-clone-");
    gitCmd(cloneDir, "clone", remote, ".");
    writeFileSync(join(cloneDir, "extra.ts"), "export const x = 1;\n");
    gitCmd(cloneDir, "checkout", "-b", "feature-new");
    gitCmd(cloneDir, "add", "extra.ts");
    gitCmd(cloneDir, "commit", "-m", "feat: extra");
    gitCmd(cloneDir, "push", "origin", "feature-new");

    const run = captureTool(registerGitFetchTool);
    const text = await run({ workspaceRoot: work, format: "json" });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      newRefs: string[];
      created?: Array<{ ref: string; newSha: string; flag: string }>;
    };
    expect(parsed.ok).toBe(true);
    // Legacy field still present
    expect(parsed.newRefs.some((r) => r.includes("feature-new"))).toBe(true);
    // Structured created field populated when --porcelain is supported
    if (parsed.created !== undefined) {
      expect(parsed.created.length).toBeGreaterThan(0);
      const entry = parsed.created.find((c) => c.ref.includes("feature-new"));
      expect(entry).toBeDefined();
      expect(typeof entry?.newSha).toBe("string");
      expect(entry?.newSha.length).toBeGreaterThan(0);
      expect(entry?.flag).toBe("*");
    }
  });

  test("fetch picks up updated ref — updated field populated with oldSha/newSha", async () => {
    const { work, remote } = makeRepoWithUpstream("mcp-fetch-upd-", "mcp-fetch-upd-remote-");

    // Push an additional commit to main on the remote via a second clone
    const cloneDir = mkTmpDir("mcp-fetch-upd-clone-");
    gitCmd(cloneDir, "clone", remote, ".");
    writeFileSync(join(cloneDir, "update.ts"), "export const y = 2;\n");
    gitCmd(cloneDir, "add", "update.ts");
    gitCmd(cloneDir, "commit", "-m", "feat: update");
    gitCmd(cloneDir, "push", "origin", "main");

    const run = captureTool(registerGitFetchTool);
    const text = await run({ workspaceRoot: work, format: "json" });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      updatedRefs: string[];
      updated?: Array<{ ref: string; oldSha: string; newSha: string; flag: string }>;
    };
    expect(parsed.ok).toBe(true);
    // Legacy field shows update
    expect(parsed.updatedRefs.length).toBeGreaterThan(0);
    // Structured updated field populated when --porcelain is supported
    if (parsed.updated !== undefined) {
      expect(parsed.updated.length).toBeGreaterThan(0);
      const entry = parsed.updated[0];
      expect(typeof entry?.oldSha).toBe("string");
      expect(typeof entry?.newSha).toBe("string");
      expect(entry?.oldSha).not.toBe(entry?.newSha);
      expect(entry?.oldSha.length).toBeGreaterThan(0);
      expect(entry?.newSha.length).toBeGreaterThan(0);
    }
  });

  test("fetch markdown output contains success status", async () => {
    const { work } = makeRepoWithUpstream("mcp-fetch-md-", "mcp-fetch-md-remote-");

    const run = captureTool(registerGitFetchTool);
    const text = await run({ workspaceRoot: work });
    expect(text).toContain("Git fetch from");
    expect(text).toContain("Success");
  });

  test("leading-dash remote is rejected with unsafe_remote_token", async () => {
    const { work } = makeRepoWithUpstream("mcp-fetch-inject-", "mcp-fetch-inject-remote-");

    const run = captureTool(registerGitFetchTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      remote: "--upload-pack=/tmp/x",
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("unsafe_remote_token");
  });

  test("rejects leading-plus force refspec branch (+main)", async () => {
    const { work } = makeRepoWithUpstream("mcp-fetch-plus-", "mcp-fetch-plus-remote-");

    const run = captureTool(registerGitFetchTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      branch: "+main",
    });
    const parsed = JSON.parse(text) as { error: string; branch: string };
    expect(parsed.error).toBe("unsafe_ref_token");
    expect(parsed.branch).toBe("+main");
  });

  test("rejects unsafe branch tokens (shell metacharacters)", async () => {
    const { work } = makeRepoWithUpstream("mcp-fetch-bad-branch-", "mcp-fetch-bad-branch-remote-");

    const run = captureTool(registerGitFetchTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      branch: "main;rm",
    });
    const parsed = JSON.parse(text) as { error: string; branch: string };
    expect(parsed.error).toBe("unsafe_ref_token");
    expect(parsed.branch).toBe("main;rm");
  });

  test("branch filter fetches only the named branch", async () => {
    const { work, remote } = makeRepoWithUpstream("mcp-fetch-branch-", "mcp-fetch-branch-remote-");

    const cloneDir = mkTmpDir("mcp-fetch-branch-clone-");
    gitCmd(cloneDir, "clone", remote, ".");
    writeFileSync(join(cloneDir, "other.ts"), "export const o = 1;\n");
    gitCmd(cloneDir, "checkout", "-b", "other");
    gitCmd(cloneDir, "add", "other.ts");
    gitCmd(cloneDir, "commit", "-m", "feat: other");
    gitCmd(cloneDir, "push", "origin", "other");

    const run = captureTool(registerGitFetchTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      branch: "main",
    });
    const parsed = JSON.parse(text) as { ok: boolean; newRefs: string[] };
    expect(parsed.ok).toBe(true);
    // Branch-scoped fetch should not advertise the unrelated remote branch.
    expect(parsed.newRefs.some((r) => r.includes("other"))).toBe(false);
  });

  test("tags:true fetches a tag created on the remote", async () => {
    const { work, remote } = makeRepoWithUpstream("mcp-fetch-tags-", "mcp-fetch-tags-remote-");

    const cloneDir = mkTmpDir("mcp-fetch-tags-clone-");
    gitCmd(cloneDir, "clone", remote, ".");
    writeTestGitConfig(cloneDir);
    gitCmd(cloneDir, "tag", "v-fetch-tag");
    gitCmd(cloneDir, "push", "origin", "v-fetch-tag");

    const run = captureTool(registerGitFetchTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      tags: true,
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      newRefs: string[];
      created?: Array<{ ref: string }>;
    };
    expect(parsed.ok).toBe(true);
    const sawTag =
      parsed.newRefs.some((r) => r.includes("v-fetch-tag")) ||
      (parsed.created?.some((c) => c.ref.includes("v-fetch-tag")) ?? false);
    expect(sawTag).toBe(true);
  });

  test("prune:true reports pruned remote-tracking refs", async () => {
    const { work, remote } = makeRepoWithUpstream("mcp-fetch-prune-", "mcp-fetch-prune-remote-");

    const cloneDir = mkTmpDir("mcp-fetch-prune-clone-");
    gitCmd(cloneDir, "clone", remote, ".");
    writeFileSync(join(cloneDir, "gone.ts"), "export const g = 1;\n");
    gitCmd(cloneDir, "checkout", "-b", "to-prune");
    gitCmd(cloneDir, "add", "gone.ts");
    gitCmd(cloneDir, "commit", "-m", "feat: to-prune");
    gitCmd(cloneDir, "push", "origin", "to-prune");

    // Fetch once so work has origin/to-prune, then delete it on the remote.
    gitCmd(work, "fetch", "origin");
    gitCmd(cloneDir, "push", "origin", "--delete", "to-prune");

    const run = captureTool(registerGitFetchTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      prune: true,
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      pruned?: Array<{ ref: string }>;
    };
    expect(parsed.ok).toBe(true);
    // Porcelain path surfaces pruned[]; older git may only delete silently.
    if (parsed.pruned !== undefined) {
      expect(parsed.pruned.some((p) => p.ref.includes("to-prune"))).toBe(true);
    } else {
      expect(gitCmd(work, "branch", "-r", "--list", "origin/to-prune").trim()).toBe("");
    }
  });

  test("fetch with invalid remote returns ok:false in json", async () => {
    const { work } = makeRepoWithUpstream("mcp-fetch-bad-", "mcp-fetch-bad-remote-");

    const run = captureTool(registerGitFetchTool);
    const text = await run({ workspaceRoot: work, format: "json", remote: "no-such-remote" });
    const parsed = JSON.parse(text) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });
});
