/**
 * Integration tests for git_parity.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitParityTool } from "./git-parity-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  mkTmpDir,
  writeTestGitConfig,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

function gitInitMain(dir: string): void {
  gitCmd(dir, "init", "-b", "main");
  writeTestGitConfig(dir);
}

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
      parity?: { workspace_root: string; status: string; pairs: { match: boolean }[] }[];
    };
    expect(parsed.parity?.map((entry) => entry.workspace_root)).toEqual([a.root, b.root]);
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
});
