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
  test("root array evaluates sibling workspaces independently", async () => {
    const a = makeParityWorkspace("parity-a-");
    const b = makeParityWorkspace("parity-b-");
    const run = captureTool(registerGitParityTool);

    const text = await run({
      format: "json",
      root: [a.root, b.root],
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

  test("3-root fan-out with unequal pair counts stays input-order deterministic", async () => {
    // Root-level AND pair-level work now run through one shared bounded pool
    // instead of nested sequential loops; giving roots different pair counts
    // makes them finish at different times, so this proves the pool still
    // emits results in `pre.roots` order rather than completion order.
    const a = makeParityWorkspace("parity-order-a-");
    const b = mkTmpDir("parity-order-b-");
    gitInitMain(b);
    commitFile(b, "root.txt", "root\n");
    const pairNames = ["p1", "p2", "p3", "p4"];
    for (const n of pairNames) {
      const d = join(b, n);
      mkdirSync(d);
      gitInitMain(d);
      commitFile(d, "f.txt", "same\n");
    }
    const c = makeParityWorkspace("parity-order-c-");

    const run = captureTool(registerGitParityTool);
    const text = await run({
      format: "json",
      root: [a.root, b, c.root],
      pairs: [
        { left: "left", right: "right", label: "single" },
        { left: "p1", right: "p2", label: "p12" },
        { left: "p3", right: "p4", label: "p34" },
      ],
    });
    const parsed = JSON.parse(text) as { parity: { workspaceRoot: string }[] };
    expect(parsed.parity.map((p) => p.workspaceRoot)).toEqual([a.root, b, c.root]);
  });

  test("markdown format contains parity status and pair labels", async () => {
    const w = makeParityWorkspace("parity-md-");
    const run = captureTool(registerGitParityTool);

    const text = await run({
      root: [w.root],
      pairs: [{ left: "left", right: "right", label: "test pair" }],
    });

    expect(text).toContain("# Git HEAD parity");
    expect(text).toContain("test pair");
    expect(text).toContain("OK");
  });

  test("no_pairs error when pairs omitted", async () => {
    const w = makeParityWorkspace("parity-nopairs-");
    const run = captureTool(registerGitParityTool);

    const text = await run({ root: [w.root], format: "json" });
    // no_pairs is a per-root entry (contract 1) — never an abort of the whole
    // sweep, even when there's only one root in play.
    const parsed = JSON.parse(text) as {
      parity: Array<{ status: string; pairs: unknown[]; error?: { error: string } }>;
    };
    expect(parsed.parity).toHaveLength(1);
    expect(parsed.parity[0]?.error?.error).toBe("no_pairs");
    expect(parsed.parity[0]?.status).toBe("MISMATCH");
    expect(parsed.parity[0]?.pairs).toHaveLength(0);
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
      root: [root],
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
      root: [root],
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
      root: [w.root],
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
      root: [root],
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

  test("invalid_root_path: plain directory rejected before execute", async () => {
    // requireGitAndRoots validates the root array before execute runs;
    // a non-git directory returns invalid_root_path, not not_a_git_repository.
    const plain = mkTmpDir("parity-plain-");
    const run = captureTool(registerGitParityTool);

    const text = await run({
      format: "json",
      root: [plain],
      pairs: [{ left: "left", right: "right" }],
    });
    const parsed = JSON.parse(text) as { error: string; path: string };
    expect(parsed.error).toBe("invalid_root_path");
    expect(parsed.path).toBe(plain);
  });

  test("string non-git root: pairs.error is plain description, not nested JSON", async () => {
    const plain = mkTmpDir("parity-nongit-str-");
    const run = captureTool(registerGitParityTool);

    const text = await run({
      format: "json",
      root: plain,
      pairs: [{ left: "left", right: "right" }],
    });
    const parsed = JSON.parse(text) as {
      parity: Array<{ pairs: Array<{ error?: string }> }>;
    };
    const err = parsed.parity[0]?.pairs[0]?.error;
    expect(err).toBeTruthy();
    expect(err).toContain("not a git repository");
    expect(err).not.toMatch(/^\{/);
    expect(() => JSON.parse(err as string)).toThrow();
  });

  test("preset parityPairs loads from .rethunk/git-mcp-presets.json", async () => {
    const w = makeParityWorkspace("parity-preset-");
    mkdirSync(join(w.root, ".rethunk"), { recursive: true });
    writeFileSync(
      join(w.root, ".rethunk", "git-mcp-presets.json"),
      JSON.stringify({
        schemaVersion: "1",
        presets: {
          p: { parityPairs: [{ left: "left", right: "right", label: "from preset" }] },
        },
      }),
    );

    const run = captureTool(registerGitParityTool);
    const text = await run({ root: w.root, format: "json", preset: "p" });
    const parsed = JSON.parse(text) as {
      parity: Array<{
        status: string;
        presetSchemaVersion?: string;
        pairs: Array<{ label: string; match: boolean }>;
      }>;
    };
    expect(parsed.parity[0]?.presetSchemaVersion).toBe("1");
    expect(parsed.parity[0]?.status).toBe("OK");
    expect(parsed.parity[0]?.pairs[0]?.label).toBe("from preset");
    expect(parsed.parity[0]?.pairs[0]?.match).toBe(true);
  });

  test("maxPairs dedupes duplicate pairs before truncation and reports omitted count", async () => {
    const root = mkTmpDir("parity-cap-");
    gitInitMain(root);
    commitFile(root, "root.txt", "root\n");
    for (const n of ["left", "right", "left2", "right2", "left3", "right3"]) {
      const d = join(root, n);
      mkdirSync(d);
      gitInitMain(d);
      commitFile(d, "f.txt", "same\n");
    }

    const run = captureTool(registerGitParityTool);
    const text = await run({
      format: "json",
      root: [root],
      pairs: [
        { left: "left", right: "right", label: "p1" },
        { left: "left", right: "right", label: "p1-dup" },
        { left: "left2", right: "right2", label: "p2" },
        { left: "left3", right: "right3", label: "p3" },
      ],
      maxPairs: 2,
    });
    const parsed = JSON.parse(text) as {
      parity: Array<{
        pairsTruncated?: boolean;
        pairsOmittedCount?: number;
        pairs: Array<{ label: string }>;
      }>;
    };
    const group = parsed.parity[0];
    // 4 input pairs -> 3 unique on (left,right) -> capped to 2 -> 1 omitted.
    expect(group?.pairsTruncated).toBe(true);
    expect(group?.pairsOmittedCount).toBe(1);
    expect(group?.pairs.map((p) => p.label)).toEqual(["p1", "p2"]);
  });

  test("preset failure on one root produces a per-root error entry instead of aborting the sweep", async () => {
    const broken = mkTmpDir("parity-preset-broken-");
    gitInitMain(broken);
    mkdirSync(join(broken, ".rethunk"), { recursive: true });
    writeFileSync(join(broken, ".rethunk", "git-mcp-presets.json"), "{not valid json");

    const ok = makeParityWorkspace("parity-preset-ok-");
    mkdirSync(join(ok.root, ".rethunk"), { recursive: true });
    writeFileSync(
      join(ok.root, ".rethunk", "git-mcp-presets.json"),
      JSON.stringify({
        schemaVersion: "1",
        presets: { p: { parityPairs: [{ left: "left", right: "right" }] } },
      }),
    );

    const run = captureTool(registerGitParityTool, undefined, [
      `file://${broken}`,
      `file://${ok.root}`,
    ]);
    const text = await run({ root: "*", format: "json", preset: "p" });
    const parsed = JSON.parse(text) as {
      parity: Array<{
        workspaceRoot: string;
        status: string;
        pairs: unknown[];
        error?: { error: string };
      }>;
    };
    expect(parsed.parity).toHaveLength(2);
    expect(parsed.parity[0]?.workspaceRoot).toBe(broken);
    expect(parsed.parity[0]?.error?.error).toBe("preset_file_invalid");
    expect(parsed.parity[0]?.pairs).toHaveLength(0);
    expect(parsed.parity[1]?.workspaceRoot).toBe(ok.root);
    expect(parsed.parity[1]?.status).toBe("OK");
  });

  test("no_pairs on one root (preset with no pairs) produces a per-root error entry instead of aborting the sweep", async () => {
    const a = mkTmpDir("parity-nopairs-sweep-a-");
    gitInitMain(a);
    mkdirSync(join(a, ".rethunk"), { recursive: true });
    writeFileSync(
      join(a, ".rethunk", "git-mcp-presets.json"),
      JSON.stringify({ schemaVersion: "1", presets: { p: {} } }),
    );

    const b = makeParityWorkspace("parity-nopairs-sweep-b-");
    mkdirSync(join(b.root, ".rethunk"), { recursive: true });
    writeFileSync(
      join(b.root, ".rethunk", "git-mcp-presets.json"),
      JSON.stringify({
        schemaVersion: "1",
        presets: { p: { parityPairs: [{ left: "left", right: "right" }] } },
      }),
    );

    const run = captureTool(registerGitParityTool, undefined, [`file://${a}`, `file://${b.root}`]);
    const text = await run({ root: "*", format: "json", preset: "p" });
    const parsed = JSON.parse(text) as {
      parity: Array<{
        workspaceRoot: string;
        status: string;
        pairs: unknown[];
        error?: { error: string };
      }>;
    };
    expect(parsed.parity).toHaveLength(2);
    expect(parsed.parity[0]?.workspaceRoot).toBe(a);
    expect(parsed.parity[0]?.error?.error).toBe("no_pairs");
    expect(parsed.parity[1]?.workspaceRoot).toBe(b.root);
    expect(parsed.parity[1]?.status).toBe("OK");
  });
});
