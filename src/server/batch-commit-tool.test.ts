/**
 * Tests for batch_commit_tool logic.
 *
 * The execute handler is not exported, so we test:
 *  1. SHA extraction regex (unit) — mirrors the pattern inside the handler
 *  2. Path escape detection (unit) — uses exported isStrictlyUnderGitTop + resolvePathForRepo
 *  3. Integration: full stage-and-commit flow via spawnGitAsync against throwaway repos
 *
 * We test:
 *  1. SHA extraction regex parses standard git commit output
 *  2. SHA regex returns undefined for unrecognised output
 *  3. path_escapes_repository: dotdot path rejected before staging
 *  4. Single commit succeeds and SHA captured
 *  5. Multiple sequential commits all succeed
 *  6. Stops after first failure (nothing staged → commit_failed)
 *  7. Valid path that is exactly the git root is accepted
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { isStrictlyUnderGitTop, resolvePathForRepo } from "../repo-paths.js";
import { registerBatchCommitTool } from "./batch-commit-tool.js";
import { spawnGitAsync } from "./git.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepo,
  makeRepoWithUpstream,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

// ---------------------------------------------------------------------------
// Mirrors the SHA extraction regex from batch-commit-tool.ts
// ---------------------------------------------------------------------------

function extractSha(commitOutput: string): string | undefined {
  return /\[[\w/.-]+\s+([0-9a-f]+)\]/.exec(commitOutput)?.[1];
}

// ---------------------------------------------------------------------------
// Repo helpers (shared via test-harness.ts)
// ---------------------------------------------------------------------------

// gitCmd, makeRepo, makeRepoWithUpstream imported from test-harness

// ---------------------------------------------------------------------------
// Unit: SHA extraction regex
// ---------------------------------------------------------------------------

describe("extractSha", () => {
  test("parses standard git commit output", () => {
    const output = "[main abc1234] feat: add feature\n 1 file changed, 5 insertions(+)";
    expect(extractSha(output)).toBe("abc1234");
  });

  test("parses branch with slash in name", () => {
    const output = "[feature/my-branch d3adb33] fix: patch\n 1 file changed";
    expect(extractSha(output)).toBe("d3adb33");
  });

  test("parses short SHA of varying length", () => {
    const output = "[main 0a1b2c3d] chore: update\n";
    expect(extractSha(output)).toBe("0a1b2c3d");
  });

  test("returns undefined for unrecognised output", () => {
    expect(extractSha("nothing useful here")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(extractSha("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit: path escape detection (mirrors execute handler validation)
// ---------------------------------------------------------------------------

describe("path escape detection", () => {
  test("dotdot path that escapes root is rejected", () => {
    const gitTop = mkTmpDir("mcp-top-");
    const rel = "../../etc/passwd";
    const abs = resolvePathForRepo(rel, gitTop);
    expect(isStrictlyUnderGitTop(abs, gitTop)).toBe(false);
  });

  test("normal nested path is accepted", () => {
    const gitTop = mkTmpDir("mcp-top-");
    const rel = "src/foo.ts";
    const abs = resolvePathForRepo(rel, gitTop);
    expect(isStrictlyUnderGitTop(abs, gitTop)).toBe(true);
  });

  test("absolute path outside root is rejected", () => {
    const gitTop = mkTmpDir("mcp-top-");
    const outside = mkTmpDir("mcp-other-");
    expect(isStrictlyUnderGitTop(outside, gitTop)).toBe(false);
  });

  test("path equal to git root is accepted", () => {
    const gitTop = mkTmpDir("mcp-top-");
    expect(isStrictlyUnderGitTop(gitTop, gitTop)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: stage-and-commit flow
// ---------------------------------------------------------------------------

describe("batch_commit integration", () => {
  test("single file commit succeeds and SHA is captured", async () => {
    const dir = makeRepo();

    // Create an initial commit so HEAD exists
    writeFileSync(join(dir, "init.ts"), "const x = 0;\n");
    gitCmd(dir, "add", "init.ts");
    gitCmd(dir, "commit", "-m", "chore: init");

    // Stage a new file
    writeFileSync(join(dir, "feat.ts"), "export const y = 1;\n");
    const addResult = await spawnGitAsync(dir, ["add", "--", "feat.ts"]);
    expect(addResult.ok).toBe(true);

    // Commit
    const commitResult = await spawnGitAsync(dir, ["commit", "-m", "feat: add y"]);
    expect(commitResult.ok).toBe(true);

    const sha = extractSha(commitResult.stdout);
    expect(sha).toBeDefined();
    expect(sha).toMatch(/^[0-9a-f]+$/);
  });

  test("multiple sequential commits all succeed", async () => {
    const dir = makeRepo();

    // Establish HEAD so subsequent commits are non-root (root-commit output differs)
    writeFileSync(join(dir, "base.ts"), "const base = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    const shas: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const file = `file${i}.ts`;
      writeFileSync(join(dir, file), `const v${i} = ${i};\n`);
      const addR = await spawnGitAsync(dir, ["add", "--", file]);
      expect(addR.ok).toBe(true);
      const commitR = await spawnGitAsync(dir, ["commit", "-m", `chore: add file ${i}`]);
      expect(commitR.ok).toBe(true);
      const sha = extractSha(commitR.stdout);
      expect(sha).toBeDefined();
      if (sha) shas.push(sha);
    }

    // All 3 SHAs are distinct
    expect(new Set(shas).size).toBe(3);
  });

  test("commit fails when nothing is staged", async () => {
    const dir = makeRepo();

    // Create initial commit so HEAD exists
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Attempt commit with empty index
    const commitResult = await spawnGitAsync(dir, ["commit", "-m", "should fail"]);
    expect(commitResult.ok).toBe(false);
  });

  test("stage fails for non-existent file", async () => {
    const dir = makeRepo();

    const addResult = await spawnGitAsync(dir, ["add", "--", "nonexistent.ts"]);
    expect(addResult.ok).toBe(false);
  });

  test("git log reflects commits in order after sequential commits", async () => {
    const dir = makeRepo();

    const messages = ["feat: first", "feat: second", "feat: third"];
    for (const msg of messages) {
      const file = `f${++_seq}.ts`;
      writeFileSync(join(dir, file), `// ${msg}\n`);
      gitCmd(dir, "add", file);
      gitCmd(dir, "commit", "-m", msg);
    }

    const logResult = await spawnGitAsync(dir, ["log", "--oneline", "-5"]);
    expect(logResult.ok).toBe(true);
    // Most recent first
    expect(logResult.stdout).toContain("feat: third");
    expect(logResult.stdout.indexOf("feat: third")).toBeLessThan(
      logResult.stdout.indexOf("feat: second"),
    );
  });
});

// ---------------------------------------------------------------------------
// Execute handler: end-to-end via fake server harness
// ---------------------------------------------------------------------------

describe("batch_commit execute handler", () => {
  test("happy path: single commit returns markdown with sha and success header", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      commits: [{ message: "feat: add new", files: ["new.ts"] }],
    });
    expect(text).toContain("1/1 committed");
    expect(text).toContain("feat: add new");
  });

  test("json format returns structured result with ok:true", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "feat: json", files: ["a.ts"] }],
    });
    const parsed = JSON.parse(text) as { ok: boolean; committed: number; total: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);
    expect(parsed.total).toBe(1);
  });

  test("path_escapes_repository: dotdot path → error in json response", async () => {
    const dir = makeRepo();

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "bad", files: ["../../etc/passwd"] }],
    });
    const parsed = JSON.parse(text) as { ok: boolean; results: Array<{ error: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("path_escapes_repository");
  });

  test("non-git workspaceRoot → not_a_git_repository error", async () => {
    const plain = mkTmpDir("mcp-plain-");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: plain,
      format: "json",
      commits: [{ message: "noop", files: ["x.ts"] }],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("not_a_git_repository");
  });

  test("multiple commits: stops on first failure, reports partial progress", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "ok.ts"), "const ok = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [
        { message: "feat: ok", files: ["ok.ts"] },
        { message: "feat: bad", files: ["nonexistent.ts"] },
      ],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      committed: number;
      results: Array<{ ok: boolean; error?: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.committed).toBe(1);
    expect(parsed.results[0]?.ok).toBe(true);
    expect(parsed.results[1]?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// push: "after" behaviour
// ---------------------------------------------------------------------------

describe("batch_commit push: after", () => {
  test("default (push omitted) does not touch the remote", async () => {
    const { work, remote } = makeRepoWithUpstream();
    writeFileSync(join(work, "a.ts"), "const a = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      commits: [{ message: "feat: a", files: ["a.ts"] }],
    });
    const parsed = JSON.parse(text) as { ok: boolean; push?: unknown };
    expect(parsed.ok).toBe(true);
    expect(parsed.push).toBeUndefined();

    // Remote is still at the seed commit only.
    const remoteLog = gitCmd(remote, "log", "--oneline");
    expect(remoteLog.split("\n").filter((l) => l.trim()).length).toBe(1);
  });

  test('push: "after" with a tracking branch pushes successfully', async () => {
    const { work, remote } = makeRepoWithUpstream();
    writeFileSync(join(work, "a.ts"), "const a = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      push: "after",
      commits: [{ message: "feat: a", files: ["a.ts"] }],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      push?: { ok: boolean; branch?: string; upstream?: string; error?: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.push?.ok).toBe(true);
    expect(parsed.push?.branch).toBe("main");
    expect(parsed.push?.upstream).toBe("origin/main");

    // Remote now has two commits (seed + new).
    const remoteLog = gitCmd(remote, "log", "--oneline");
    expect(remoteLog.split("\n").filter((l) => l.trim()).length).toBe(2);
  });

  test('push: "after" on a branch with no upstream returns push_no_upstream', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      push: "after",
      commits: [{ message: "feat: a", files: ["a.ts"] }],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      committed: number;
      push?: { ok: boolean; error?: string };
    };
    // Commits succeed; only push fails — do NOT roll back.
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);
    expect(parsed.push?.ok).toBe(false);
    expect(parsed.push?.error).toBe("push_no_upstream");
  });

  test('push: "after" is skipped when a commit fails', async () => {
    const { work } = makeRepoWithUpstream();

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      push: "after",
      commits: [{ message: "feat: bad", files: ["nonexistent.ts"] }],
    });
    const parsed = JSON.parse(text) as { ok: boolean; push?: unknown };
    expect(parsed.ok).toBe(false);
    expect(parsed.push).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dryRun mode tests
// ---------------------------------------------------------------------------

describe("batch_commit dryRun mode", () => {
  test("dryRun: true stages files and returns preview without committing", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      dryRun: true,
      commits: [{ message: "feat: add new", files: ["new.ts"] }],
    });
    const parsed = JSON.parse(text) as {
      dryRun: boolean;
      ok: boolean;
      results: Array<{ ok: boolean; staged?: string[] }>;
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.staged).toEqual(["new.ts"]);

    // Verify no commit was written (log unchanged)
    const logResult = await spawnGitAsync(dir, ["log", "--oneline"]);
    expect(logResult.stdout).toContain("chore: base");
    expect(logResult.stdout).not.toContain("feat: add new");
  });

  test("dryRun: true unstages files after preview", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    await run({
      workspaceRoot: dir,
      dryRun: true,
      commits: [{ message: "feat: add new", files: ["new.ts"] }],
    });

    // Check that nothing is staged
    const statusResult = await spawnGitAsync(dir, ["status", "--short"]);
    expect(statusResult.stdout).toContain("?? new.ts"); // Untracked, not staged
  });

  test("dryRun: true includes diffStat in json response", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "file1.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "file2.ts"), "export const b = 2;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      dryRun: true,
      commits: [{ message: "feat: multi", files: ["file1.ts", "file2.ts"] }],
    });
    const parsed = JSON.parse(text) as {
      results: Array<{ diffStat?: string }>;
    };
    expect(parsed.results[0]?.diffStat).toBeDefined();
    expect(parsed.results[0]?.diffStat).toContain("file1.ts");
    expect(parsed.results[0]?.diffStat).toContain("file2.ts");
  });

  test("dryRun: true markdown header indicates DRY RUN mode", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      dryRun: true,
      commits: [{ message: "feat: add new", files: ["new.ts"] }],
    });
    expect(text).toContain("DRY RUN");
    expect(text).toContain("no commits written");
  });

  test("dryRun: true with multiple commits shows all previews", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "file1.ts"), "const a = 1;\n");
    writeFileSync(join(dir, "file2.ts"), "const b = 2;\n");
    writeFileSync(join(dir, "file3.ts"), "const c = 3;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      dryRun: true,
      commits: [
        { message: "feat: first", files: ["file1.ts"] },
        { message: "feat: second", files: ["file2.ts"] },
        { message: "feat: third", files: ["file3.ts"] },
      ],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      committed: number;
      total: number;
      results: Array<{ ok: boolean; staged?: string[] }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(3);
    expect(parsed.total).toBe(3);
    expect(parsed.results[0]?.staged).toEqual(["file1.ts"]);
    expect(parsed.results[1]?.staged).toEqual(["file2.ts"]);
    expect(parsed.results[2]?.staged).toEqual(["file3.ts"]);

    // Verify no commits were written
    const logResult = await spawnGitAsync(dir, ["log", "--oneline"]);
    expect(logResult.stdout).toContain("chore: base");
    expect(logResult.stdout).not.toContain("feat: first");
    expect(logResult.stdout).not.toContain("feat: second");
    expect(logResult.stdout).not.toContain("feat: third");
  });

  test("dryRun: true does not perform push even with push: after", async () => {
    const { work, remote } = makeRepoWithUpstream();
    writeFileSync(join(work, "a.ts"), "const a = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: work,
      format: "json",
      dryRun: true,
      push: "after",
      commits: [{ message: "feat: a", files: ["a.ts"] }],
    });
    const parsed = JSON.parse(text) as { dryRun: boolean; push?: unknown };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.push).toBeUndefined();

    // Remote should still be at seed commit only
    const remoteLog = gitCmd(remote, "log", "--oneline");
    expect(remoteLog.split("\n").filter((l) => l.trim()).length).toBe(1);
  });

  test("dryRun: false (default) commits as normal", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      dryRun: false,
      commits: [{ message: "feat: add new", files: ["new.ts"] }],
    });
    const parsed = JSON.parse(text) as { dryRun?: boolean; ok: boolean };
    expect(parsed.dryRun).toBeUndefined();
    expect(parsed.ok).toBe(true);

    // Verify commit was written
    const logResult = await spawnGitAsync(dir, ["log", "--oneline"]);
    expect(logResult.stdout).toContain("feat: add new");
  });
});

// ---------------------------------------------------------------------------
// Line-range staging (lines parameter)
// ---------------------------------------------------------------------------

describe("batch_commit line-range staging", () => {
  test("stages only lines in range when lines parameter is provided", async () => {
    const dir = makeRepo();

    // Create base commit
    writeFileSync(join(dir, "code.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "code.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Modify file with multiple sections
    writeFileSync(
      join(dir, "code.ts"),
      "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n",
    );

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [
        {
          message: "feat: stage lines 2-3",
          files: [{ path: "code.ts", lines: { from: 2, to: 3 } }],
        },
      ],
    });
    const parsed = JSON.parse(text) as { ok: boolean; committed: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);

    // Verify commit was created
    const logResult = await spawnGitAsync(dir, ["log", "--oneline"]);
    expect(logResult.ok).toBe(true);
    expect(logResult.stdout).toContain("feat: stage lines 2-3");
  });

  test("stages whole file when lines parameter is absent", async () => {
    const dir = makeRepo();

    // Create base commit
    writeFileSync(join(dir, "code.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "code.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Modify file with multiple lines
    writeFileSync(join(dir, "code.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [
        {
          message: "feat: stage all",
          files: ["code.ts"],
        },
      ],
    });
    const parsed = JSON.parse(text) as { ok: boolean; committed: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);

    // Verify whole file was committed
    const logResult = await spawnGitAsync(dir, ["log", "-1", "--name-status"]);
    expect(logResult.ok).toBe(true);
    expect(logResult.stdout).toContain("code.ts");
  });

  test("supports mixed file entries (with and without lines)", async () => {
    const dir = makeRepo();

    // Create base commit
    writeFileSync(join(dir, "file1.ts"), "const b = 0;\n");
    writeFileSync(join(dir, "file2.ts"), "const x = 0;\n");
    gitCmd(dir, "add", "file1.ts", "file2.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Modify both files
    writeFileSync(join(dir, "file1.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    writeFileSync(join(dir, "file2.ts"), "const x = 1;\nconst y = 2;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [
        {
          message: "feat: mixed staging",
          files: [
            { path: "file1.ts", lines: { from: 2, to: 2 } }, // Only line 2
            "file2.ts", // Whole file
          ],
        },
      ],
    });
    const parsed = JSON.parse(text) as { ok: boolean; committed: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);

    // Verify both files are in the commit
    const logResult = await spawnGitAsync(dir, ["log", "-1", "--name-status"]);
    expect(logResult.stdout).toContain("file1.ts");
    expect(logResult.stdout).toContain("file2.ts");
  });

  test("returns error when line range has no matching hunks", async () => {
    const dir = makeRepo();

    // Create base commit
    writeFileSync(join(dir, "code.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "code.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Modify only first line
    writeFileSync(join(dir, "code.ts"), "const a = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [
        {
          message: "feat: invalid range",
          files: [{ path: "code.ts", lines: { from: 100, to: 200 } }],
        },
      ],
    });
    const parsed = JSON.parse(text) as { ok: boolean; results: Array<{ error?: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("stage_failed");
  });
});

let _seq = 0;
