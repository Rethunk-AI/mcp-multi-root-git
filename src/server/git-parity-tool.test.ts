/**
 * Integration tests for git_parity.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitParityTool } from "./git-parity-tool.js";
import { captureTool, cleanupTmpPaths, gitCmd, gitInitMain, mkTmpDir } from "./test-harness.js";

afterEach(cleanupTmpPaths);

function commitFile(dir: string, filename: string, content: string): string {
  writeFileSync(join(dir, filename), content);
  gitCmd(dir, "add", filename);
  gitCmd(dir, "commit", "-m", `add ${filename}`);
  return gitCmd(dir, "rev-parse", "HEAD").trim();
}

function makeParityWorkspace(prefix: string): { root: string; sha: string } {
  const root = mkTmpDir(prefix);
  gitInitMain(root);
  commitFile(root, "root.txt", "root\n");

  const left = join(root, "left");
  const right = join(root, "right");
  mkdirSync(left);
  mkdirSync(right);
  gitInitMain(left);
  gitInitMain(right);
  const sha = commitFile(left, "shared.txt", "same\n");
  commitFile(right, "shared.txt", "same\n");
  return { root, sha };
}

describe("git_parity", () => {
  test("absoluteGitRoots evaluates sibling workspaces independently", async () => {
    const a = makeParityWorkspace("parity-a-");
    const b = makeParityWorkspace("parity-b-");
    const run = captureTool(registerGitParityTool);

    const text = await run({
      format: "json",
      absoluteGitRoots: [a.root, b.root],
      pairs: [{ left: "left", right: "right", label: "nested repos" }],
    });

    const parsed = JSON.parse(text) as {
      parity?: { workspaceRoot: string; status: string; pairs: { match: boolean }[] }[];
    };
    expect(parsed.parity?.map((entry) => entry.workspaceRoot)).toEqual([a.root, b.root]);
    expect(parsed.parity?.map((entry) => entry.status)).toEqual(["OK", "OK"]);
    expect(parsed.parity?.flatMap((entry) => entry.pairs.map((pair) => pair.match))).toEqual([
      true,
      true,
    ]);
  });

  test("markdown format contains parity status and pair labels", async () => {
    const w = makeParityWorkspace("parity-md-");
    const run = captureTool(registerGitParityTool);

    const text = await run({
      absoluteGitRoots: [w.root],
      pairs: [{ left: "left", right: "right", label: "test pair" }],
    });

    expect(text).toContain("# Git HEAD parity");
    expect(text).toContain("test pair");
    expect(text).toContain("OK");
  });

  test("no_pairs error when pairs omitted", async () => {
    const w = makeParityWorkspace("parity-nopairs-");
    const run = captureTool(registerGitParityTool);

    const text = await run({ absoluteGitRoots: [w.root], format: "json" });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("no_pairs");
  });

  test("SHA mismatch JSON: match false with leftSha and rightSha", async () => {
    const root = mkTmpDir("parity-mismatch-");
    gitInitMain(root);
    commitFile(root, "root.txt", "root\n");

    const left = join(root, "left");
    const right = join(root, "right");
    mkdirSync(left);
    mkdirSync(right);
    gitInitMain(left);
    gitInitMain(right);
    const leftSha = commitFile(left, "a.txt", "left content\n");
    const rightSha = commitFile(right, "a.txt", "right content\n");

    const run = captureTool(registerGitParityTool);
    const text = await run({
      format: "json",
      absoluteGitRoots: [root],
      pairs: [{ left: "left", right: "right", label: "mismatch pair" }],
    });
    const parsed = JSON.parse(text) as {
      parity: Array<{
        status: string;
        pairs: Array<{ match: boolean; leftSha?: string; rightSha?: string }>;
      }>;
    };
    expect(parsed.parity[0]?.status).toBe("MISMATCH");
    const pair = parsed.parity[0]?.pairs[0];
    expect(pair?.match).toBe(false);
    expect(pair?.leftSha).toBe(leftSha);
    expect(pair?.rightSha).toBe(rightSha);
  });

  test("SHA mismatch markdown output shows MISMATCH with both SHAs", async () => {
    const root = mkTmpDir("parity-mismatch-md-");
    gitInitMain(root);
    commitFile(root, "root.txt", "root\n");

    const left = join(root, "left");
    const right = join(root, "right");
    mkdirSync(left);
    mkdirSync(right);
    gitInitMain(left);
    gitInitMain(right);
    const leftSha = commitFile(left, "a.txt", "left\n");
    const rightSha = commitFile(right, "a.txt", "right\n");

    const run = captureTool(registerGitParityTool);
    const text = await run({
      absoluteGitRoots: [root],
      pairs: [{ left: "left", right: "right", label: "md mismatch" }],
    });
    expect(text).toContain("MISMATCH");
    expect(text).toContain(leftSha);
    expect(text).toContain(rightSha);
  });

  test("path escaping pair returns error entry", async () => {
    const w = makeParityWorkspace("parity-escape-");
    const run = captureTool(registerGitParityTool);

    const text = await run({
      format: "json",
      absoluteGitRoots: [w.root],
      pairs: [{ left: "../../outside", right: "right", label: "escape attempt" }],
    });
    const parsed = JSON.parse(text) as {
      parity: Array<{
        status: string;
        pairs: Array<{ match: boolean; error?: string }>;
      }>;
    };
    expect(parsed.parity[0]?.status).toBe("MISMATCH");
    const pair = parsed.parity[0]?.pairs[0];
    expect(pair?.match).toBe(false);
    expect(pair?.error).toContain("path escapes");
  });

  test("gitRevParseHead failure when nested repo has no commits", async () => {
    const root = mkTmpDir("parity-nocommit-");
    gitInitMain(root);
    commitFile(root, "root.txt", "root\n");

    const left = join(root, "left");
    const right = join(root, "right");
    mkdirSync(left);
    mkdirSync(right);
    gitInitMain(left);
    commitFile(left, "a.txt", "content\n");
    gitInitMain(right); // no commit — git rev-parse HEAD fails

    const run = captureTool(registerGitParityTool);
    const text = await run({
      format: "json",
      absoluteGitRoots: [root],
      pairs: [{ left: "left", right: "right", label: "no-head pair" }],
    });
    const parsed = JSON.parse(text) as {
      parity: Array<{
        status: string;
        pairs: Array<{ match: boolean; error?: string }>;
      }>;
    };
    expect(parsed.parity[0]?.status).toBe("MISMATCH");
    const pair = parsed.parity[0]?.pairs[0];
    expect(pair?.match).toBe(false);
    expect(pair?.error).toBeTruthy();
  });

  test("invalid_absolute_git_root: plain directory rejected before execute", async () => {
    // requireGitAndRoots validates absoluteGitRoots before execute runs;
    // a non-git directory returns invalid_absolute_git_root, not not_a_git_repository.
    const plain = mkTmpDir("parity-plain-");
    const run = captureTool(registerGitParityTool);

    const text = await run({
      format: "json",
      absoluteGitRoots: [plain],
      pairs: [{ left: "left", right: "right" }],
    });
    const parsed = JSON.parse(text) as { error: string; path: string };
    expect(parsed.error).toBe("invalid_absolute_git_root");
    expect(parsed.path).toBe(plain);
  });
});
