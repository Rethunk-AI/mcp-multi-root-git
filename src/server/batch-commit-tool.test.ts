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

import { describe, expect, test } from "bun:test";
import { type ExecSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isStrictlyUnderGitTop, resolvePathForRepo } from "../repo-paths.js";
import { spawnGitAsync } from "./git.js";

// ---------------------------------------------------------------------------
// Mirrors the SHA extraction regex from batch-commit-tool.ts
// ---------------------------------------------------------------------------

function extractSha(commitOutput: string): string | undefined {
  return /\[[\w/.-]+\s+([0-9a-f]+)\]/.exec(commitOutput)?.[1];
}

// ---------------------------------------------------------------------------
// Throwaway repo helpers
// ---------------------------------------------------------------------------

function gitCmd(cwd: string, ...args: string[]): string {
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
    },
  };
  return execFileSync("git", args, opts);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-batch-commit-test-"));
  gitCmd(dir, "init", "-b", "main");
  gitCmd(dir, "config", "user.email", "test@example.com");
  gitCmd(dir, "config", "user.name", "Test User");
  return dir;
}

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
    const gitTop = mkdtempSync(join(tmpdir(), "mcp-top-"));
    const rel = "../../etc/passwd";
    const abs = resolvePathForRepo(rel, gitTop);
    expect(isStrictlyUnderGitTop(abs, gitTop)).toBe(false);
  });

  test("normal nested path is accepted", () => {
    const gitTop = mkdtempSync(join(tmpdir(), "mcp-top-"));
    const rel = "src/foo.ts";
    const abs = resolvePathForRepo(rel, gitTop);
    expect(isStrictlyUnderGitTop(abs, gitTop)).toBe(true);
  });

  test("absolute path outside root is rejected", () => {
    const gitTop = mkdtempSync(join(tmpdir(), "mcp-top-"));
    const outside = mkdtempSync(join(tmpdir(), "mcp-other-"));
    expect(isStrictlyUnderGitTop(outside, gitTop)).toBe(false);
  });

  test("path equal to git root is accepted", () => {
    const gitTop = mkdtempSync(join(tmpdir(), "mcp-top-"));
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

let _seq = 0;
