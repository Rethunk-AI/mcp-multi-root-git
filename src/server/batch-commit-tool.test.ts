/**
 * Tests for batch_commit_tool logic.
 *
 * The execute handler is not exported, so we test:
 *  1. SHA extraction regex (unit) — mirrors the pattern inside the handler
 *  2. Path escape detection (unit) — uses exported isStrictlyUnderGitTop + resolvePathForRepo
 *  3. Integration: full stage-and-commit flow via spawnGitAsync against throwaway repos
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  test("path equal to git root is inside top (helper); batch_commit still rejects it", () => {
    const gitTop = mkTmpDir("mcp-top-");
    // Confinement helper treats top === abs as inside; tool rejects whole-tree pathspecs separately.
    expect(isStrictlyUnderGitTop(gitTop, gitTop)).toBe(true);
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
      results: Array<{
        ok: boolean;
        error?: string;
        sha?: string;
        message?: string;
        files?: string[];
      }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.committed).toBe(1);
    expect(parsed.results[0]?.ok).toBe(true);
    expect(parsed.results[1]?.ok).toBe(false);

    // Success entries drop the echoed request (message/files) — the caller
    // already has them — but keep the SHA needed to confirm the commit.
    expect(parsed.results[0]?.sha).toBeDefined();
    expect(parsed.results[0]?.message).toBeUndefined();
    expect(parsed.results[0]?.files).toBeUndefined();

    // Failure entries keep message/files so the caller can diagnose which
    // commit/files failed without cross-referencing the original request.
    expect(parsed.results[1]?.message).toBe("feat: bad");
    expect(parsed.results[1]?.files).toEqual(["nonexistent.ts"]);
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

  test("dryRun: true with deleted file unstages cleanly after preview", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "keep.ts"), "const k = 0;\n");
    writeFileSync(join(dir, "gone.ts"), "const g = 1;\n");
    gitCmd(dir, "add", "keep.ts", "gone.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    rmSync(join(dir, "gone.ts"));

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      dryRun: true,
      commits: [{ message: "fix: remove gone", files: ["gone.ts"] }],
    });
    const parsed = JSON.parse(text) as {
      dryRun: boolean;
      ok: boolean;
      results: Array<{ ok: boolean; staged?: string[] }>;
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.staged).toEqual(["gone.ts"]);

    // Cleanup must leave deletion unstaged (not staged, not committed)
    const status = await spawnGitAsync(dir, ["status", "--short"]);
    expect(status.stdout).not.toContain("D  gone.ts"); // not staged
    expect(status.stdout).toContain(" D gone.ts"); // unstaged deletion
    const log = await spawnGitAsync(dir, ["log", "--oneline"]);
    expect(log.stdout).not.toContain("fix: remove gone");
  });

  test("dryRun: true with mixed edits and deletions unstages all cleanly", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "edit.ts"), "const e = 0;\n");
    writeFileSync(join(dir, "del.ts"), "const d = 1;\n");
    gitCmd(dir, "add", "edit.ts", "del.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "edit.ts"), "const e = 99;\n");
    rmSync(join(dir, "del.ts"));

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      dryRun: true,
      commits: [
        { message: "fix: edit", files: ["edit.ts"] },
        { message: "fix: delete", files: ["del.ts"] },
      ],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ ok: boolean }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toHaveLength(2);

    // Both files must be unstaged after cleanup
    const status = await spawnGitAsync(dir, ["status", "--short"]);
    expect(status.stdout).not.toContain("M  edit.ts");
    expect(status.stdout).not.toContain("D  del.ts");
    expect(status.stdout).toContain(" M edit.ts");
    expect(status.stdout).toContain(" D del.ts");
  });

  test("dryRun: true leaves pre-staged file still staged after cleanup", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    writeFileSync(join(dir, "pre.ts"), "const p = 0;\n");
    gitCmd(dir, "add", "base.ts", "pre.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Modify both files — stage only pre.ts before invoking dry run
    writeFileSync(join(dir, "pre.ts"), "const p = 99;\n");
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
    gitCmd(dir, "add", "pre.ts"); // pre-existing staged change

    const run = captureTool(registerBatchCommitTool);
    await run({
      workspaceRoot: dir,
      dryRun: true,
      commits: [{ message: "feat: add new", files: ["new.ts"] }],
    });

    // new.ts must be unstaged (dry-run file); pre.ts must remain staged
    const statusResult = await spawnGitAsync(dir, ["diff", "--cached", "--name-only"]);
    expect(statusResult.stdout).toContain("pre.ts"); // still staged — pre-existing
    expect(statusResult.stdout).not.toContain("new.ts"); // cleaned up by dry-run
  });
});

// ---------------------------------------------------------------------------
// Line-range staging (lines parameter)
// ---------------------------------------------------------------------------

describe("batch_commit line-range staging", () => {
  test("stages only lines in range when lines parameter is provided", async () => {
    const dir = makeRepo();

    // Two well-separated regions so the diff produces distinct hunks.
    const filler = Array.from({ length: 20 }, (_, i) => `// filler ${i}`).join("\n");
    const base = `const a = 1;\n\n${filler}\n\nconst z = 0;\n`;
    writeFileSync(join(dir, "code.ts"), base);
    gitCmd(dir, "add", "code.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Modify both regions; stage only the first hunk via lines.
    const modified = base.replace("const a = 1", "const a = 100").replace("const z = 0", "const z = 99");
    writeFileSync(join(dir, "code.ts"), modified);

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [
        {
          message: "feat: stage lines 1-3",
          files: [{ path: "code.ts", lines: { from: 1, to: 3 } }],
        },
      ],
    });
    const parsed = JSON.parse(text) as { ok: boolean; committed: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);

    const logResult = await spawnGitAsync(dir, ["log", "--oneline"]);
    expect(logResult.ok).toBe(true);
    expect(logResult.stdout).toContain("feat: stage lines 1-3");

    // Out-of-range edit must remain unstaged/uncommitted.
    const diffResult = await spawnGitAsync(dir, ["diff", "--", "code.ts"]);
    expect(diffResult.stdout).toContain("const z = 99");
    const showResult = await spawnGitAsync(dir, ["log", "-1", "-p"]);
    expect(showResult.stdout).toContain("const a = 100");
    expect(showResult.stdout).not.toContain("const z = 99");
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

  test("stages a non-final hunk without corrupting the patch", async () => {
    const dir = makeRepo();

    // Two well-separated functions so the diff produces two distinct hunks.
    const filler = Array.from({ length: 20 }, (_, i) => `# filler ${i}`).join("\n");
    const base = `def a():\n    return 1\n\n${filler}\n\ndef b():\n    return 2\n`;
    writeFileSync(join(dir, "code.py"), base);
    gitCmd(dir, "add", "code.py");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Modify both functions so the raw diff has hunk(a) followed by hunk(b).
    const modified = base.replace("return 1", "return 100").replace("return 2", "return 200");
    writeFileSync(join(dir, "code.py"), modified);

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [
        {
          // Range covers only hunk(a) — hunk(b) exists later in the real diff.
          // Regression test: extractOverlappingHunks previously joined the
          // selected hunk(s) without a trailing newline, which `git apply`
          // rejects as a corrupt patch whenever the selection isn't the last
          // hunk in the file's diff.
          message: "feat: stage first hunk only",
          files: [{ path: "code.py", lines: { from: 1, to: 5 } }],
        },
      ],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      committed: number;
      results: Array<{ error?: string; detail?: string }>;
    };
    expect(parsed.results[0]?.detail).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);

    // hunk(b) must remain unstaged and uncommitted.
    const diffResult = await spawnGitAsync(dir, ["diff", "code.py"]);
    expect(diffResult.stdout).toContain("return 200");
    const logResult = await spawnGitAsync(dir, ["log", "-1", "-p"]);
    expect(logResult.stdout).toContain("return 100");
    expect(logResult.stdout).not.toContain("return 200");
  });

  test("dryRun: true unstages an earlier file when a later file in the same commit fails to stage", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "good.ts"), "const g = 0;\n");
    writeFileSync(join(dir, "bad.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "good.ts", "bad.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // good.ts has a real change to stage; bad.ts's requested range matches nothing.
    writeFileSync(join(dir, "good.ts"), "const g = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      dryRun: true,
      commits: [
        {
          // Regression test: stagedFilesForCleanup was previously only populated
          // after every file in the entry staged successfully, so good.ts (staged
          // first) was never tracked for rollback once bad.ts failed, leaving a
          // "dry run" with real, uncleaned index state.
          message: "feat: mixed success then failure",
          files: ["good.ts", { path: "bad.ts", lines: { from: 100, to: 200 } }],
        },
      ],
    });
    const parsed = JSON.parse(text) as { ok: boolean; results: Array<{ error?: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("stage_failed");

    // good.ts must be fully unstaged — a failed dry run must leave no index trace.
    const staged = await spawnGitAsync(dir, ["diff", "--cached", "--name-only"]);
    expect(staged.stdout).not.toContain("good.ts");
  });
});

// ---------------------------------------------------------------------------
// Deletion staging (deleted tracked files)
// ---------------------------------------------------------------------------

describe("batch_commit deletion staging", () => {
  test("stages deleted tracked file via git rm --cached", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    writeFileSync(join(dir, "delete-me.ts"), "const gone = 1;\n");
    gitCmd(dir, "add", "base.ts", "delete-me.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Delete the file from disk
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(dir, "delete-me.ts"));

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "fix: remove delete-me", files: ["delete-me.ts"] }],
    });
    const parsed = JSON.parse(text) as { ok: boolean; committed: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);

    // Verify file is no longer tracked
    const lsResult = await spawnGitAsync(dir, ["ls-files", "delete-me.ts"]);
    expect(lsResult.stdout.trim()).toBe("");
  });

  test("commit mixing edits and deletions succeeds atomically", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "keep.ts"), "const k = 0;\n");
    writeFileSync(join(dir, "gone.ts"), "const g = 1;\n");
    gitCmd(dir, "add", "keep.ts", "gone.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Modify keep.ts, delete gone.ts
    writeFileSync(join(dir, "keep.ts"), "const k = 99;\n");
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(dir, "gone.ts"));

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "fix: edit + delete", files: ["keep.ts", "gone.ts"] }],
    });
    const parsed = JSON.parse(text) as { ok: boolean; committed: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);

    // gone.ts untracked, keep.ts updated
    const lsGone = await spawnGitAsync(dir, ["ls-files", "gone.ts"]);
    expect(lsGone.stdout.trim()).toBe("");
  });

  test("lines + deleted file returns stage_failed with descriptive error", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    writeFileSync(join(dir, "gone.ts"), "const g = 1;\n");
    gitCmd(dir, "add", "base.ts", "gone.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(dir, "gone.ts"));

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "bad", files: [{ path: "gone.ts", lines: { from: 1, to: 5 } }] }],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ error?: string; detail?: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("stage_failed");
    expect(parsed.results[0]?.detail).toContain("deleted");
  });

  test("untracked missing file still fails with pathspec error", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "bad", files: ["never-existed.ts"] }],
    });
    const parsed = JSON.parse(text) as { ok: boolean; results: Array<{ error?: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("stage_failed");
  });
});

// ---------------------------------------------------------------------------
// Pathspec isolation, mid-entry rollback, directory rejection
// ---------------------------------------------------------------------------

describe("batch_commit pathspec isolation and stage rollback", () => {
  test("commit excludes pre-staged unrelated index paths", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    writeFileSync(join(dir, "pre.ts"), "const p = 0;\n");
    gitCmd(dir, "add", "base.ts", "pre.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    writeFileSync(join(dir, "pre.ts"), "const p = 99;\n");
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
    gitCmd(dir, "add", "pre.ts"); // pre-staged — must NOT ride into the commit

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "feat: add new only", files: ["new.ts"] }],
    });
    const parsed = JSON.parse(text) as { ok: boolean; committed: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);

    const show = await spawnGitAsync(dir, ["log", "-1", "--name-only", "--pretty=format:"]);
    expect(show.stdout).toContain("new.ts");
    expect(show.stdout).not.toContain("pre.ts");

    // pre.ts remains staged after pathspec commit
    const staged = await spawnGitAsync(dir, ["diff", "--cached", "--name-only"]);
    expect(staged.stdout).toContain("pre.ts");
  });

  test("mid-entry stage_failed unstages already-staged entry files", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "good.ts"), "const g = 0;\n");
    writeFileSync(join(dir, "bad.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "good.ts", "bad.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    writeFileSync(join(dir, "good.ts"), "const g = 1;\n");
    // bad.ts unchanged — lines range will fail with no hunks

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [
        {
          message: "feat: partial stage fail",
          files: ["good.ts", { path: "bad.ts", lines: { from: 100, to: 200 } }],
        },
      ],
    });
    const parsed = JSON.parse(text) as { ok: boolean; results: Array<{ error?: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("stage_failed");

    const staged = await spawnGitAsync(dir, ["diff", "--cached", "--name-only"]);
    expect(staged.stdout.trim()).toBe("");
    expect(staged.stdout).not.toContain("good.ts");
  });

  test("rejects '.' whole-tree pathspec", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "new.ts"), "const n = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "bad", files: ["."] }],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ error?: string; detail?: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("invalid_paths");
    expect(parsed.results[0]?.detail).toContain(".");
  });

  test("rejects directory pathspec", async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, "subdir"));
    writeFileSync(join(dir, "subdir", "a.ts"), "const a = 1;\n");
    gitCmd(dir, "add", "subdir/a.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "bad", files: ["subdir"] }],
    });
    const parsed = JSON.parse(text) as { ok: boolean; results: Array<{ error?: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("invalid_paths");
  });
});

// ---------------------------------------------------------------------------
// dryRun isolation + overlapping pre-staged cleanup
// ---------------------------------------------------------------------------

describe("batch_commit dryRun isolation", () => {
  test("dryRun multi-entry diffStat is isolated per entry", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "file1.ts"), "const a = 1;\n");
    writeFileSync(join(dir, "file2.ts"), "const b = 2;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      dryRun: true,
      commits: [
        { message: "feat: first", files: ["file1.ts"] },
        { message: "feat: second", files: ["file2.ts"] },
      ],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ diffStat?: string; staged?: string[] }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]?.diffStat).toContain("file1.ts");
    expect(parsed.results[0]?.diffStat).not.toContain("file2.ts");
    expect(parsed.results[1]?.diffStat).toContain("file2.ts");
    expect(parsed.results[1]?.diffStat).not.toContain("file1.ts");
  });

  test("dryRun restores overlapping pre-staged path after staging same path", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "shared.ts"), "line1\nline2\nline3\nline4\nline5\n");
    gitCmd(dir, "add", "shared.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    // Stage an edit to lines 1-2, leave more edits unstaged for dryRun lines staging
    writeFileSync(join(dir, "shared.ts"), "LINE1\nLINE2\nline3\nline4\nline5\n");
    gitCmd(dir, "add", "shared.ts");
    writeFileSync(join(dir, "shared.ts"), "LINE1\nLINE2\nLINE3\nline4\nline5\n");

    const before = await spawnGitAsync(dir, ["diff", "--cached"]);
    expect(before.stdout).toContain("LINE1");

    const run = captureTool(registerBatchCommitTool);
    await run({
      workspaceRoot: dir,
      dryRun: true,
      commits: [
        {
          message: "feat: preview more lines",
          files: [{ path: "shared.ts", lines: { from: 3, to: 3 } }],
        },
      ],
    });

    // Index must match pre-call staged state (LINE1/LINE2 staged, LINE3 not)
    const afterCached = await spawnGitAsync(dir, ["diff", "--cached"]);
    expect(afterCached.stdout).toContain("LINE1");
    expect(afterCached.stdout).toContain("LINE2");
    expect(afterCached.stdout).not.toContain("LINE3");
    const afterUnstaged = await spawnGitAsync(dir, ["diff", "--", "shared.ts"]);
    expect(afterUnstaged.stdout).toContain("LINE3");
  });
});

// ---------------------------------------------------------------------------
// commit_failed / push_failed / push_detached_head / invalid_line_range
// ---------------------------------------------------------------------------

describe("batch_commit commit_failed and push errors", () => {
  test("commit_failed when pre-commit hook rejects", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.ts"), "const b = 0;\n");
    gitCmd(dir, "add", "base.ts");
    gitCmd(dir, "commit", "-m", "chore: base");

    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho hook-reject\nexit 1\n");
    chmodSync(hook, 0o755);

    writeFileSync(join(dir, "new.ts"), "const n = 1;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [{ message: "feat: hook fail", files: ["new.ts"] }],
    });
    const parsed = JSON.parse(text) as {
      ok: boolean;
      results: Array<{ error?: string; detail?: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("commit_failed");
  });

  test('push: "after" on detached HEAD returns push_detached_head', async () => {
    const { work } = makeRepoWithUpstream();
    const sha = gitCmd(work, "rev-parse", "HEAD").trim();
    gitCmd(work, "checkout", "--detach", sha);
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
      committed: number;
      push?: { ok: boolean; error?: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);
    expect(parsed.push?.ok).toBe(false);
    expect(parsed.push?.error).toBe("push_detached_head");
  });

  test('push: "after" returns push_failed when remote rejects', async () => {
    const { work, remote } = makeRepoWithUpstream();
    // Point origin at a non-existent path so push fails after commits succeed.
    gitCmd(work, "remote", "set-url", "origin", join(remote, "does-not-exist.git"));
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
      committed: number;
      push?: { ok: boolean; error?: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(1);
    expect(parsed.push?.ok).toBe(false);
    expect(parsed.push?.error).toBe("push_failed");
  });

  test("invalid_line_range when from > to", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "code.ts"), "const a = 1;\n");
    gitCmd(dir, "add", "code.ts");
    gitCmd(dir, "commit", "-m", "chore: base");
    writeFileSync(join(dir, "code.ts"), "const a = 2;\n");

    const run = captureTool(registerBatchCommitTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      commits: [
        {
          message: "bad range",
          files: [{ path: "code.ts", lines: { from: 10, to: 1 } }],
        },
      ],
    });
    const parsed = JSON.parse(text) as { ok: boolean; results: Array<{ error?: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]?.error).toBe("invalid_line_range");
  });
});
