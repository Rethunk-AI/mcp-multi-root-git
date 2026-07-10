/**
 * Tests for git_conflicts tool.
 *
 * Covers: state detection ("merge"), path + parsed hunk content on a real
 * merge conflict, the no-conflict empty-files case, and maxLinesPerFile
 * truncation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitConflictsTool } from "./git-conflicts-tool.js";
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
  // plus conflict markers in the working tree, as spike-verified:
  //   <<<<<<< HEAD / BETA / ======= / ALPHA / >>>>>>> feature
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
    // Pad the baseline with filler lines before the conflicting line, well past
    // a small maxLinesPerFile cutoff, so the eventual conflict hunk falls outside
    // the scanned window.
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
    // The conflict markers land after line 5, so no hunk is captured within the window.
    expect(parsed.files[0]?.hunks).toBeUndefined();
  });
});
