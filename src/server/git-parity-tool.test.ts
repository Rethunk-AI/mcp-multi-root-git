/**
 * Integration tests for git_parity.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitParityTool } from "./git-parity-tool.js";
import { captureTool, cleanupTmpPaths, mkTmpDir } from "./test-harness.js";

afterEach(cleanupTmpPaths);

function gitInitMain(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
}

function commitFile(dir: string, filename: string, content: string): string {
  writeFileSync(join(dir, filename), content);
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  execFileSync("git", ["add", filename], { cwd: dir, env, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", `add ${filename}`], { cwd: dir, env, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
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
      parity?: { workspace_root: string; status: string; pairs: { match: boolean }[] }[];
    };
    expect(parsed.parity?.map((entry) => entry.workspace_root)).toEqual([a.root, b.root]);
    expect(parsed.parity?.map((entry) => entry.status)).toEqual(["OK", "OK"]);
    expect(parsed.parity?.flatMap((entry) => entry.pairs.map((pair) => pair.match))).toEqual([
      true,
      true,
    ]);
  });
});
