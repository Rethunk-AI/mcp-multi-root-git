/**
 * Tests for git_diff_summary_tool helpers and execute handler.
 *
 * Helpers are imported from the source module (exported for testability).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDiffArgs,
  extractFileInfo,
  matchesAnyPattern,
  parseDiffOutput,
  parseNumstatOutput,
  registerGitDiffSummaryTool,
  truncateDiffBody,
} from "./git-diff-summary-tool.js";
import {
  addCommit,
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  makeRepoWithSeed,
  mkTmpDir,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

// ---------------------------------------------------------------------------
// Throwaway repo helpers
// ---------------------------------------------------------------------------

function makeRepo(): string {
  return makeRepoWithSeed("mcp-git-diff-test-");
}

// ---------------------------------------------------------------------------
// Unit: parseNumstatOutput
// ---------------------------------------------------------------------------

describe("parseNumstatOutput", () => {
  test("parses normal add/del counts", () => {
    const numstat = ["12\t3\tsrc/foo.ts", "0\t7\told.ts"].join("\n");
    const m = parseNumstatOutput(numstat);
    expect(m.get("src/foo.ts")).toEqual({ additions: 12, deletions: 3 });
    expect(m.get("old.ts")).toEqual({ additions: 0, deletions: 7 });
  });

  test("binary file emits '-\\t-\\tpath' and is recorded as 0/0", () => {
    const m = parseNumstatOutput("-\t-\timage.png");
    expect(m.get("image.png")).toEqual({ additions: 0, deletions: 0 });
  });

  test("path containing a literal tab is rejoined via pathParts.join", () => {
    const m = parseNumstatOutput("3\t1\tdir\tsub/file.ts");
    expect(m.get("dir\tsub/file.ts")).toEqual({ additions: 3, deletions: 1 });
  });

  test("skips malformed lines with fewer than 3 tab-separated parts", () => {
    const m = parseNumstatOutput("just one field");
    expect(m.size).toBe(0);
  });

  test("returns empty map for empty input", () => {
    expect(parseNumstatOutput("").size).toBe(0);
  });

  test("rename path 'old => new' is keyed by the new path", () => {
    const m = parseNumstatOutput("10\t5\told.ts => new.ts");
    expect(m.get("new.ts")).toEqual({ additions: 10, deletions: 5 });
    expect(m.get("old.ts => new.ts")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit: parseDiffOutput
// ---------------------------------------------------------------------------

describe("parseDiffOutput", () => {
  test("returns empty array for empty string", () => {
    expect(parseDiffOutput("")).toHaveLength(0);
  });

  test("parses single file chunk", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc123..def456 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const chunks = parseDiffOutput(diff);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.header).toBe("diff --git a/src/foo.ts b/src/foo.ts");
    expect(chunks[0]?.body).toContain("-old");
    expect(chunks[0]?.body).toContain("+new");
  });

  test("parses two file chunks", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ a/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-b",
      "+B",
    ].join("\n");
    const chunks = parseDiffOutput(diff);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.header).toBe("diff --git a/a.ts b/a.ts");
    expect(chunks[1]?.header).toBe("diff --git a/b.ts b/b.ts");
  });

  test("ignores leading content before first diff --git", () => {
    const diff = ["some preamble", "diff --git a/x.ts b/x.ts", "--- a/x.ts"].join("\n");
    const chunks = parseDiffOutput(diff);
    expect(chunks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unit: extractFileInfo
// ---------------------------------------------------------------------------

describe("extractFileInfo", () => {
  test("detects modified file", () => {
    const { path, status, oldPath } = extractFileInfo(
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc..def 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts",
    );
    expect(path).toBe("src/foo.ts");
    expect(status).toBe("modified");
    expect(oldPath).toBeUndefined();
  });

  test("detects added file", () => {
    const { path, status } = extractFileInfo(
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644\nindex 000000..abc123\n--- /dev/null\n+++ b/new.ts",
    );
    expect(path).toBe("new.ts");
    expect(status).toBe("added");
  });

  test("detects deleted file", () => {
    const { path, status } = extractFileInfo(
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644\nindex abc123..000000\n--- a/old.ts\n+++ /dev/null",
    );
    expect(path).toBe("old.ts");
    expect(status).toBe("deleted");
  });

  test("detects renamed file", () => {
    const { path, status, oldPath } = extractFileInfo(
      "diff --git a/old.ts b/new.ts",
      "similarity index 95%\nrename from old.ts\nrename to new.ts",
    );
    expect(path).toBe("new.ts");
    expect(status).toBe("renamed");
    expect(oldPath).toBe("old.ts");
  });

  test("rename whose new path contains ' b/' parses with correct new path", () => {
    const header = "diff --git a/src/old.ts b/src/b/widget.ts";
    const body =
      "similarity index 90%\nrename from src/old.ts\nrename to src/b/widget.ts\n--- a/src/old.ts\n+++ b/src/b/widget.ts";
    const { path, status, oldPath } = extractFileInfo(header, body);
    expect(status).toBe("renamed");
    expect(path).toBe("src/b/widget.ts");
    expect(oldPath).toBe("src/old.ts");
  });
});

// ---------------------------------------------------------------------------
// Unit: truncateDiffBody
// ---------------------------------------------------------------------------

describe("truncateDiffBody", () => {
  test("lines.length <= maxLines never truncates (at limit, under limit, single line)", () => {
    const atLimit = ["line1", "line2", "line3"].join("\n");
    const atLimitResult = truncateDiffBody(atLimit, 3);
    expect(atLimitResult.truncated).toBe(false);
    expect(atLimitResult.text).toBe(atLimit);

    const underLimitResult = truncateDiffBody("line1\nline2", 10);
    expect(underLimitResult.truncated).toBe(false);

    const singleLineResult = truncateDiffBody("only one line", 1);
    expect(singleLineResult.truncated).toBe(false);
  });

  test("truncates when over limit", () => {
    const body = ["a", "b", "c", "d", "e"].join("\n");
    const { text, truncated } = truncateDiffBody(body, 3);
    expect(truncated).toBe(true);
    expect(text).toBe("a\nb\nc");
  });
});

// ---------------------------------------------------------------------------
// Unit: matchesAnyPattern
// ---------------------------------------------------------------------------

describe("matchesAnyPattern", () => {
  test("matches *.lock / yarn.lock / vendor/** / *.min.js on the direct matchesGlob(normalized) check", () => {
    expect(matchesAnyPattern("package-lock.json", ["*.lock", "package-lock.json"])).toBe(true);
    expect(matchesAnyPattern("yarn.lock", ["*.lock"])).toBe(true);
    expect(matchesAnyPattern("vendor/some/lib.js", ["vendor/**"])).toBe(true);
    expect(matchesAnyPattern("public/bundle.min.js", ["*.min.js"])).toBe(true);
  });

  test("matches nested lock file by basename", () => {
    expect(matchesAnyPattern("packages/app/bun.lock", ["bun.lock"])).toBe(true);
  });

  test("does not match unrelated file", () => {
    expect(matchesAnyPattern("src/main.ts", ["*.lock", "vendor/**", "dist/**"])).toBe(false);
  });

  test("empty patterns list never matches", () => {
    expect(matchesAnyPattern("anything.ts", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: buildDiffArgs
// ---------------------------------------------------------------------------

describe("buildDiffArgs", () => {
  test('undefined and empty string both → empty args (range === undefined || range === "")', () => {
    expect(buildDiffArgs(undefined)).toEqual({ ok: true, args: [] });
    expect(buildDiffArgs("")).toEqual({ ok: true, args: [] });
  });

  test('"staged" → --cached', () => {
    expect(buildDiffArgs("staged")).toEqual({ ok: true, args: ["--cached"] });
  });

  test('"cached" → --cached (alias)', () => {
    expect(buildDiffArgs("cached")).toEqual({ ok: true, args: ["--cached"] });
  });

  test('"HEAD" → HEAD arg', () => {
    expect(buildDiffArgs("HEAD")).toEqual({ ok: true, args: ["HEAD"] });
  });

  test("two-dot and three-dot ranges both → single range arg (separatorMatch branch)", () => {
    expect(buildDiffArgs("main..feature")).toEqual({ ok: true, args: ["main..feature"] });
    expect(buildDiffArgs("main...feature")).toEqual({ ok: true, args: ["main...feature"] });
  });

  test("single safe ref → single arg", () => {
    const r = buildDiffArgs("abc1234");
    expect(r).toEqual({ ok: true, args: ["abc1234"] });
  });

  test("ancestor notation is accepted, on a single ref and on either range endpoint", () => {
    expect(buildDiffArgs("HEAD~3")).toEqual({ ok: true, args: ["HEAD~3"] });
    expect(buildDiffArgs("HEAD~3..HEAD")).toEqual({ ok: true, args: ["HEAD~3..HEAD"] });
    expect(buildDiffArgs("main...feature^2")).toEqual({ ok: true, args: ["main...feature^2"] });
  });

  test("unsafe tokens are rejected with bare ERROR_CODES.UNSAFE_RANGE_TOKEN", () => {
    const injectionResult = buildDiffArgs("; rm -rf /");
    expect(injectionResult.ok).toBe(false);
    if (!injectionResult.ok) expect(injectionResult.error).toBe("unsafe_range_token");

    const rangeInjectionResult = buildDiffArgs("-x..HEAD");
    expect(rangeInjectionResult.ok).toBe(false);
    if (!rangeInjectionResult.ok) expect(rangeInjectionResult.error).toBe("unsafe_range_token");
  });
});

// ---------------------------------------------------------------------------
// Execute handler: end-to-end via fake server harness
// ---------------------------------------------------------------------------

describe("git_diff_summary execute handler", () => {
  test("unstaged changes appear in markdown output", async () => {
    const dir = makeRepo();
    addCommit(dir, "foo.ts", "const x = 1;\n", "chore: initial");
    writeFileSync(join(dir, "foo.ts"), "const x = 2;\n");

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({ workspaceRoot: dir });
    expect(text).toContain("foo.ts");
  });

  test("json format returns structured DiffSummary", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.ts", "const a = 1;\n", "chore: initial");
    writeFileSync(join(dir, "a.ts"), "const a = 99;\n");

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      range: string;
      totalFiles: number;
      files: Array<{ path: string; status: string }>;
    };
    expect(parsed.totalFiles).toBe(1);
    expect(parsed.files[0]?.path).toBe("a.ts");
    expect(parsed.files[0]?.status).toBe("modified");
    expect(parsed.range).toBe("unstaged changes");
  });

  test("staged range shows only staged files", async () => {
    const dir = makeRepo();
    addCommit(dir, "staged.ts", "const s = 1;\n", "chore: initial");
    writeFileSync(join(dir, "staged.ts"), "const s = 2;\n");
    gitCmd(dir, "add", "staged.ts");
    writeFileSync(join(dir, "unstaged.ts"), "const u = 9;\n");

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({ workspaceRoot: dir, format: "json", range: "staged" });
    const parsed = JSON.parse(text) as {
      range: string;
      files: Array<{ path: string }>;
    };
    expect(parsed.range).toBe("staged changes");
    const paths = parsed.files.map((f) => f.path);
    expect(paths).toContain("staged.ts");
    expect(paths).not.toContain("unstaged.ts");
  });

  test("fileFilter restricts output to matching files only", async () => {
    const dir = makeRepo();
    addCommit(dir, "foo.ts", "const f = 1;\n", "chore: initial");
    addCommit(dir, "bar.md", "# Doc\n", "docs: add readme");
    writeFileSync(join(dir, "foo.ts"), "const f = 2;\n");
    writeFileSync(join(dir, "bar.md"), "# Updated\n");

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({ workspaceRoot: dir, format: "json", fileFilter: "*.ts" });
    const parsed = JSON.parse(text) as {
      files: Array<{ path: string }>;
      excludedFiles?: string[];
      totalFiles: number;
    };
    const paths = parsed.files.map((f) => f.path);
    expect(paths).toContain("foo.ts");
    expect(paths).not.toContain("bar.md");
    expect(parsed.totalFiles).toBe(1);
    expect(parsed.excludedFiles).toContain("bar.md");
  });

  test("ancestor-notation range (HEAD~1..HEAD) diffs the two commits", async () => {
    const dir = makeRepo();
    addCommit(dir, "range.ts", "const v = 1;\n", "chore: initial");
    addCommit(dir, "range.ts", "const v = 2;\n", "chore: bump");

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({ workspaceRoot: dir, format: "json", range: "HEAD~1..HEAD" });
    const parsed = JSON.parse(text) as {
      range: string;
      files: Array<{ path: string }>;
    };
    expect(parsed.range).toBe("HEAD~1..HEAD");
    expect(parsed.files.map((f) => f.path)).toContain("range.ts");
  });

  test("clean working tree returns empty files array", async () => {
    const dir = makeRepo();
    addCommit(dir, "clean.ts", "const c = 1;\n", "chore: initial");

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as { totalFiles: number; files: unknown[] };
    expect(parsed.totalFiles).toBe(0);
    expect(parsed.files).toHaveLength(0);
  });

  test("non-git workspaceRoot → not_a_git_repository error", async () => {
    const plain = mkTmpDir("mcp-plain-diff-");

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({ workspaceRoot: plain, format: "json" });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("not_a_git_repository");
  });

  test("maxLinesPerFile truncates long diffs", async () => {
    const dir = makeRepo();
    addCommit(
      dir,
      "big.ts",
      `${Array.from({ length: 5 }, (_, i) => `const v${i} = ${i};`).join("\n")}\n`,
      "chore: initial",
    );
    writeFileSync(
      join(dir, "big.ts"),
      `${Array.from({ length: 5 }, (_, i) => `const v${i} = ${i * 10};`).join("\n")}\n`,
    );

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({ workspaceRoot: dir, format: "json", maxLinesPerFile: 2 });
    const parsed = JSON.parse(text) as { files: Array<{ truncated: boolean }> };
    expect(parsed.files[0]?.truncated).toBe(true);
  });

  test("maxFiles truncates and sets truncatedFiles", async () => {
    const dir = makeRepo();
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      addCommit(dir, name, `const ${name[0]} = 1;\n`, `chore: ${name}`);
      writeFileSync(join(dir, name), `const ${name[0]} = 2;\n`);
    }

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      maxFiles: 1,
      excludePatterns: [],
    });
    const parsed = JSON.parse(text) as {
      totalFiles: number;
      truncatedFiles?: number;
      files: unknown[];
    };
    expect(parsed.totalFiles).toBe(3);
    expect(parsed.truncatedFiles).toBe(2);
    expect(parsed.files).toHaveLength(1);
  });

  test("default excludePatterns lists lock files in excludedFiles", async () => {
    const dir = makeRepo();
    addCommit(dir, "app.ts", "const x = 1;\n", "chore: app");
    addCommit(dir, "yarn.lock", "lock1\n", "chore: lock");
    writeFileSync(join(dir, "app.ts"), "const x = 2;\n");
    writeFileSync(join(dir, "yarn.lock"), "lock2\n");

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({ workspaceRoot: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      files: Array<{ path: string }>;
      excludedFiles?: string[];
      totalFiles: number;
    };
    expect(parsed.files.map((f) => f.path)).toContain("app.ts");
    expect(parsed.files.map((f) => f.path)).not.toContain("yarn.lock");
    expect(parsed.excludedFiles).toContain("yarn.lock");
    expect(parsed.totalFiles).toBe(1);
  });

  test("unsafe range returns exact error===unsafe_range_token on the wire", async () => {
    const dir = makeRepo();
    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      range: "; rm -rf /",
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("unsafe_range_token");
  });

  test("rename with content edits reports non-zero numstat counts", async () => {
    const dir = makeRepo();
    // Keep similarity high so git detects a rename (default -M threshold).
    addCommit(
      dir,
      "old.ts",
      "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
      "chore: old",
    );
    gitCmd(dir, "mv", "old.ts", "new.ts");
    writeFileSync(join(dir, "new.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 99;\n");
    gitCmd(dir, "add", "new.ts");

    const run = captureTool(registerGitDiffSummaryTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      range: "staged",
      excludePatterns: [],
    });
    const parsed = JSON.parse(text) as {
      files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
        oldPath?: string;
      }>;
    };
    const renamed = parsed.files.find((f) => f.path === "new.ts" || f.status === "renamed");
    expect(renamed).toBeDefined();
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.oldPath).toBe("old.ts");
    expect((renamed?.additions ?? 0) + (renamed?.deletions ?? 0)).toBeGreaterThan(0);
  });
});
