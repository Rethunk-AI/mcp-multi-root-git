/**
 * Tests for git_conflicts tool.
 *
 * Covers: state detection (merge/cherry-pick/revert/rebase), path + parsed hunk
 * content (including diff3 base), incomplete-marker truncation, path escape,
 * and maxLinesPerFile truncation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  detectConflictState,
  parseConflictHunks,
  readConflictFile,
  registerGitConflictsTool,
} from "./git-conflicts-tool.js";
import { captureTool, cleanupTmpPaths, gitCmd, makeRepoWithSeed } from "./test-harness.js";

afterEach(cleanupTmpPaths);

/**
 * Create a real, unresolved merge conflict in a fresh repo: two branches
 * edit the same line of the same file, then `git merge` (run directly, not
 * through the git_merge tool, so the conflict is left in place rather than
 * auto-aborted).
 */
function makeMergeConflictRepo(): string {
  const dir = makeRepoWithSeed("mcp-conflicts-test-");
  writeFileSync(join(dir, "shared.txt"), "line1\nline2\nline3\n");
  gitCmd(dir, "add", "shared.txt");
  gitCmd(dir, "commit", "-m", "chore: shared baseline");

  gitCmd(dir, "checkout", "-b", "feature");
  writeFileSync(join(dir, "shared.txt"), "line1\nALPHA\nline3\n");
  gitCmd(dir, "add", "shared.txt");
  gitCmd(dir, "commit", "-m", "feat: alpha");
  gitCmd(dir, "checkout", "main");

  writeFileSync(join(dir, "shared.txt"), "line1\nBETA\nline3\n");
  gitCmd(dir, "add", "shared.txt");
  gitCmd(dir, "commit", "-m", "chore: beta");

  // Plain `git merge` (not the git_merge tool) — fails and leaves MERGE_HEAD
  // plus conflict markers in the working tree.
  try {
    gitCmd(dir, "merge", "feature", "-q");
  } catch {
    // Expected: merge conflict — non-zero exit.
  }
  return dir;
}

describe("git_conflicts merge state and hunks", () => {
  test("reports state merge, conflict path, and ours/theirs hunk text", async () => {
    const dir = makeMergeConflictRepo();
    const run = captureTool(registerGitConflictsTool);

    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      state?: string;
      files: Array<{
        path: string;
        hunks?: Array<{
          startLine: number;
          ours: string;
          theirs: string;
          oursLabel?: string;
          theirsLabel?: string;
        }>;
      }>;
    };

    expect(parsed.state).toBe("merge");
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0];
    expect(file?.path).toBe("shared.txt");
    expect(file?.hunks).toHaveLength(1);
    const hunk = file?.hunks?.[0];
    expect(hunk?.startLine).toBe(2);
    expect(hunk?.ours).toBe("BETA");
    expect(hunk?.theirs).toBe("ALPHA");
    expect(hunk?.oursLabel).toBe("HEAD");
    expect(hunk?.theirsLabel).toBe("feature");
  });

  test("markdown format includes state and conflict path", async () => {
    const dir = makeMergeConflictRepo();
    const run = captureTool(registerGitConflictsTool);

    const text = await run({ workspaceRoot: dir });
    expect(text).toContain("state: merge");
    expect(text).toContain("shared.txt");
    expect(text).toContain("BETA");
    expect(text).toContain("ALPHA");
  });

  test("withHunks: false returns paths without parsed hunk content", async () => {
    const dir = makeMergeConflictRepo();
    const run = captureTool(registerGitConflictsTool);

    const text = await run({ workspaceRoot: dir, format: "json", withHunks: false });
    const parsed = JSON.parse(text) as { files: Array<{ path: string; hunks?: unknown }> };

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe("shared.txt");
    expect(parsed.files[0]?.hunks).toBeUndefined();
  });
});

describe("git_conflicts no-conflict repo", () => {
  test("clean repo returns empty files and omits state", async () => {
    const dir = makeRepoWithSeed("mcp-conflicts-clean-");
    const run = captureTool(registerGitConflictsTool);

    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { state?: string; files: unknown[] };

    expect(parsed.state).toBeUndefined();
    expect(parsed.files).toEqual([]);
  });
});

describe("git_conflicts maxLinesPerFile truncation", () => {
  test("file longer than maxLinesPerFile is marked truncated and hunk beyond cutoff is dropped", async () => {
    const dir = makeRepoWithSeed("mcp-conflicts-truncate-");
    const filler = Array.from({ length: 20 }, (_, i) => `filler${i}`).join("\n");
    writeFileSync(join(dir, "shared.txt"), `${filler}\nmid\n`);
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: shared baseline");

    gitCmd(dir, "checkout", "-b", "feature");
    writeFileSync(join(dir, "shared.txt"), `${filler}\nALPHA\n`);
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "feat: alpha");
    gitCmd(dir, "checkout", "main");

    writeFileSync(join(dir, "shared.txt"), `${filler}\nBETA\n`);
    gitCmd(dir, "add", "shared.txt");
    gitCmd(dir, "commit", "-m", "chore: beta");

    try {
      gitCmd(dir, "merge", "feature", "-q");
    } catch {
      // Expected: merge conflict.
    }

    const run = captureTool(registerGitConflictsTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      maxLinesPerFile: 5,
    });
    const parsed = JSON.parse(text) as {
      files: Array<{ path: string; hunks?: unknown[]; truncated?: boolean }>;
    };

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.truncated).toBe(true);
    expect(parsed.files[0]?.hunks).toBeUndefined();
  });
});

describe("detectConflictState marker files", () => {
  test("CHERRY_PICK_HEAD → cherry-pick", async () => {
    const dir = makeRepoWithSeed("mcp-conflicts-cp-");
    writeFileSync(join(dir, ".git", "CHERRY_PICK_HEAD"), "abc\n");
    expect(await detectConflictState(dir)).toBe("cherry-pick");
  });

  test("REVERT_HEAD → revert", async () => {
    const dir = makeRepoWithSeed("mcp-conflicts-rv-");
    writeFileSync(join(dir, ".git", "REVERT_HEAD"), "abc\n");
    expect(await detectConflictState(dir)).toBe("revert");
  });

  test("rebase-merge dir → rebase", async () => {
    const dir = makeRepoWithSeed("mcp-conflicts-rb-");
    mkdirSync(join(dir, ".git", "rebase-merge"), { recursive: true });
    expect(await detectConflictState(dir)).toBe("rebase");
  });

  test("rebase-apply dir → rebase", async () => {
    const dir = makeRepoWithSeed("mcp-conflicts-ra-");
    mkdirSync(join(dir, ".git", "rebase-apply"), { recursive: true });
    expect(await detectConflictState(dir)).toBe("rebase");
  });
});

describe("parseConflictHunks", () => {
  test("diff3 markers populate base", () => {
    const text = [
      "<<<<<<< HEAD",
      "ours-line",
      "||||||| merged common ancestors",
      "base-line",
      "=======",
      "theirs-line",
      ">>>>>>> feature",
      "",
    ].join("\n");
    const { hunks, truncated } = parseConflictHunks(text, 200);
    expect(truncated).toBe(false);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.ours).toBe("ours-line");
    expect(hunks[0]?.base).toBe("base-line");
    expect(hunks[0]?.theirs).toBe("theirs-line");
  });

  test("incomplete open hunk at EOF sets truncated without emitting half-formed hunk", () => {
    const text = ["<<<<<<< HEAD", "ours-only", "=======", "theirs-no-close"].join("\n");
    const { hunks, truncated } = parseConflictHunks(text, 200);
    expect(truncated).toBe(true);
    expect(hunks).toHaveLength(0);
  });
});

describe("readConflictFile path confinement", () => {
  test("path escaping the repo returns path_escapes_repo on the file entry", () => {
    const dir = makeRepoWithSeed("mcp-conflicts-escape-");
    const result = readConflictFile(dir, "../../etc/passwd", 200);
    expect(result).toEqual({ path: "../../etc/passwd", error: "path_escapes_repo" });
  });
});
