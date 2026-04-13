/**
 * Tests for git_diff_summary_tool helpers.
 *
 * Private helpers are copied locally so they can be tested in isolation
 * without exporting them from the module (same pattern as git-log-tool.test.ts).
 *
 * We test:
 *  1. parseStatOutput — parses git diff --stat per-file lines
 *  2. parseDiffOutput — splits unified diff into per-file chunks
 *  3. extractFileInfo — determines path and status from chunk header/body
 *  4. truncateDiffBody — caps diff output to N lines
 *  5. matchesAnyPattern — glob exclusion/filter matching
 *  6. buildDiffArgs — maps range param to git CLI args
 *  7. Integration: real diff against a throwaway repo
 */

import { describe, expect, test } from "bun:test";
import { type ExecSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { isSafeGitUpstreamToken, spawnGitAsync } from "./git.js";
import { registerGitDiffSummaryTool } from "./git-diff-summary-tool.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Local copies of private helpers (mirrors git-diff-summary-tool.ts)
// ---------------------------------------------------------------------------

function parseStatOutput(stat: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of stat.split("\n")) {
    if (!line.includes("|")) continue;
    const pipeIdx = line.indexOf("|");
    const filePart = line.slice(0, pipeIdx).trim();
    const statPart = line.slice(pipeIdx + 1).trim();
    const additions = (statPart.match(/\+/g) ?? []).length;
    const deletions = (statPart.match(/-/g) ?? []).length;
    result.set(filePart, { additions, deletions });
  }
  return result;
}

function parseDiffOutput(diff: string): Array<{ header: string; body: string }> {
  const chunks: Array<{ header: string; body: string }> = [];
  const parts = diff.split(/(?=^diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) continue;
    const firstNewline = part.indexOf("\n");
    const header = firstNewline >= 0 ? part.slice(0, firstNewline) : part;
    const body = firstNewline >= 0 ? part.slice(firstNewline + 1) : "";
    chunks.push({ header, body });
  }
  return chunks;
}

function extractFileInfo(
  header: string,
  body: string,
): {
  path: string;
  oldPath?: string;
  status: "modified" | "added" | "deleted" | "renamed";
} {
  const headerMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  const aPath = headerMatch?.[1] ?? "";
  const bPath = headerMatch?.[2] ?? aPath;

  let status: "modified" | "added" | "deleted" | "renamed" = "modified";
  let oldPath: string | undefined;

  if (/^new file mode/m.test(body)) {
    status = "added";
  } else if (/^deleted file mode/m.test(body)) {
    status = "deleted";
  } else if (/^rename from /m.test(body)) {
    status = "renamed";
    const fromMatch = /^rename from (.+)$/m.exec(body);
    oldPath = fromMatch?.[1];
  }

  const path = status === "deleted" ? aPath : bPath;
  return { path, oldPath, status };
}

function truncateDiffBody(body: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = body.split("\n");
  if (lines.length <= maxLines) {
    return { text: body, truncated: false };
  }
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (matchesGlob(normalized, pattern)) return true;
    const basename = normalized.split("/").at(-1) ?? normalized;
    if (matchesGlob(basename, pattern)) return true;
  }
  return false;
}

function buildDiffArgs(
  range: string | undefined,
): { ok: true; args: string[] } | { ok: false; error: string } {
  if (range === undefined || range === "") {
    return { ok: true, args: [] };
  }
  const normalized = range.trim().toLowerCase();
  if (normalized === "staged" || normalized === "cached") {
    return { ok: true, args: ["--cached"] };
  }
  if (normalized === "head") {
    return { ok: true, args: ["HEAD"] };
  }

  const separatorMatch = /^(.+?)(\.{2,3})(.+)$/.exec(range.trim());
  if (separatorMatch) {
    const [, left, sep, right] = separatorMatch;
    if (!isSafeGitUpstreamToken(left ?? "") || !isSafeGitUpstreamToken(right ?? "")) {
      return { ok: false, error: `unsafe_range_token: ${range}` };
    }
    return { ok: true, args: [`${left}${sep}${right}`] };
  }

  if (!isSafeGitUpstreamToken(range.trim())) {
    return { ok: false, error: `unsafe_range_token: ${range}` };
  }
  return { ok: true, args: [range.trim()] };
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
  const dir = mkdtempSync(join(tmpdir(), "mcp-git-diff-test-"));
  gitCmd(dir, "init", "-b", "main");
  gitCmd(dir, "config", "user.email", "test@example.com");
  gitCmd(dir, "config", "user.name", "Test User");
  return dir;
}

function addCommit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  gitCmd(dir, "add", file);
  gitCmd(dir, "commit", "-m", message);
}

// ---------------------------------------------------------------------------
// Unit: parseStatOutput
// ---------------------------------------------------------------------------

describe("parseStatOutput", () => {
  test("parses single modified file", () => {
    const stat = " src/foo.ts | 3 ++- ";
    const m = parseStatOutput(stat);
    expect(m.get("src/foo.ts")).toEqual({ additions: 2, deletions: 1 });
  });

  test("parses multiple files", () => {
    const stat = [
      " src/a.ts | 5 +++++",
      " src/b.ts | 2 +-",
      " 2 files changed, 5 insertions(+), 1 deletion(-)",
    ].join("\n");
    const m = parseStatOutput(stat);
    expect(m.get("src/a.ts")).toEqual({ additions: 5, deletions: 0 });
    expect(m.get("src/b.ts")).toEqual({ additions: 1, deletions: 1 });
  });

  test("skips summary line (no pipe)", () => {
    const stat = " 2 files changed, 5 insertions(+)";
    const m = parseStatOutput(stat);
    expect(m.size).toBe(0);
  });

  test("returns empty map for empty input", () => {
    expect(parseStatOutput("").size).toBe(0);
  });

  test("handles file with only deletions", () => {
    const stat = " old.ts | 3 ---";
    const m = parseStatOutput(stat);
    expect(m.get("old.ts")).toEqual({ additions: 0, deletions: 3 });
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
      "+++ b/a.ts",
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
});

// ---------------------------------------------------------------------------
// Unit: truncateDiffBody
// ---------------------------------------------------------------------------

describe("truncateDiffBody", () => {
  test("no truncation when at limit", () => {
    const body = ["line1", "line2", "line3"].join("\n");
    const { text, truncated } = truncateDiffBody(body, 3);
    expect(truncated).toBe(false);
    expect(text).toBe(body);
  });

  test("no truncation when under limit", () => {
    const body = "line1\nline2";
    const { truncated } = truncateDiffBody(body, 10);
    expect(truncated).toBe(false);
  });

  test("truncates when over limit", () => {
    const body = ["a", "b", "c", "d", "e"].join("\n");
    const { text, truncated } = truncateDiffBody(body, 3);
    expect(truncated).toBe(true);
    expect(text).toBe("a\nb\nc");
  });

  test("single line body is not truncated", () => {
    const { truncated } = truncateDiffBody("only one line", 1);
    expect(truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: matchesAnyPattern
// ---------------------------------------------------------------------------

describe("matchesAnyPattern", () => {
  test("matches *.lock basename pattern", () => {
    expect(matchesAnyPattern("package-lock.json", ["*.lock", "package-lock.json"])).toBe(true);
  });

  test("matches yarn.lock by exact name pattern", () => {
    expect(matchesAnyPattern("yarn.lock", ["*.lock"])).toBe(true);
  });

  test("matches nested lock file by basename", () => {
    expect(matchesAnyPattern("packages/app/bun.lock", ["bun.lock"])).toBe(true);
  });

  test("matches vendor/** glob", () => {
    expect(matchesAnyPattern("vendor/some/lib.js", ["vendor/**"])).toBe(true);
  });

  test("does not match unrelated file", () => {
    expect(matchesAnyPattern("src/main.ts", ["*.lock", "vendor/**", "dist/**"])).toBe(false);
  });

  test("matches *.min.js pattern", () => {
    expect(matchesAnyPattern("public/bundle.min.js", ["*.min.js"])).toBe(true);
  });

  test("empty patterns list never matches", () => {
    expect(matchesAnyPattern("anything.ts", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: buildDiffArgs
// ---------------------------------------------------------------------------

describe("buildDiffArgs", () => {
  test("undefined → empty args (unstaged)", () => {
    const r = buildDiffArgs(undefined);
    expect(r).toEqual({ ok: true, args: [] });
  });

  test("empty string → empty args", () => {
    const r = buildDiffArgs("");
    expect(r).toEqual({ ok: true, args: [] });
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

  test("two-dot range → single range arg", () => {
    const r = buildDiffArgs("main..feature");
    expect(r).toEqual({ ok: true, args: ["main..feature"] });
  });

  test("three-dot range → single range arg", () => {
    const r = buildDiffArgs("main...feature");
    expect(r).toEqual({ ok: true, args: ["main...feature"] });
  });

  test("single safe ref → single arg", () => {
    const r = buildDiffArgs("abc1234");
    expect(r).toEqual({ ok: true, args: ["abc1234"] });
  });

  test("tilde in ref is rejected (not in safe charset)", () => {
    const r = buildDiffArgs("HEAD~3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unsafe_range_token");
  });

  test("unsafe token returns error", () => {
    const r = buildDiffArgs("; rm -rf /");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unsafe_range_token");
  });
});

// ---------------------------------------------------------------------------
// Integration: real diff against throwaway repo
// ---------------------------------------------------------------------------

describe("git diff integration", () => {
  test("diff stat parses correctly for a real modified file", async () => {
    const dir = makeRepo();
    addCommit(dir, "hello.ts", `export const x = 1;\n`, "chore: initial");

    // Modify the file
    writeFileSync(join(dir, "hello.ts"), `export const x = 2;\nexport const y = 3;\n`);

    const statResult = await spawnGitAsync(dir, ["diff", "--stat"]);
    expect(statResult.ok).toBe(true);

    const m = parseStatOutput(statResult.stdout);
    expect(m.has("hello.ts")).toBe(true);
  });

  test("diff output parses into correct chunk count", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.ts", "const a = 1;\n", "chore: add a");
    addCommit(dir, "b.ts", "const b = 2;\n", "chore: add b");

    // Unstaged modifications to both files
    writeFileSync(join(dir, "a.ts"), "const a = 99;\n");
    writeFileSync(join(dir, "b.ts"), "const b = 99;\n");

    const diffResult = await spawnGitAsync(dir, ["diff"]);
    expect(diffResult.ok).toBe(true);

    const chunks = parseDiffOutput(diffResult.stdout);
    expect(chunks.length).toBe(2);
    const paths = chunks.map((c) => extractFileInfo(c.header, c.body).path);
    expect(paths).toContain("a.ts");
    expect(paths).toContain("b.ts");
  });

  test("staged diff (--cached) reflects only staged changes", async () => {
    const dir = makeRepo();
    addCommit(dir, "staged.ts", "const s = 1;\n", "chore: initial");

    // Stage a change
    writeFileSync(join(dir, "staged.ts"), "const s = 2;\n");
    gitCmd(dir, "add", "staged.ts");

    // Also make an unstaged change to another file
    writeFileSync(join(dir, "unstaged.ts"), "const u = 9;\n");

    const stagedDiff = await spawnGitAsync(dir, ["diff", "--cached"]);
    expect(stagedDiff.ok).toBe(true);

    const chunks = parseDiffOutput(stagedDiff.stdout);
    const paths = chunks.map((c) => extractFileInfo(c.header, c.body).path);
    expect(paths).toContain("staged.ts");
    expect(paths).not.toContain("unstaged.ts");
  });

  test("no diff output for clean working tree", async () => {
    const dir = makeRepo();
    addCommit(dir, "clean.ts", "const c = 1;\n", "chore: initial");

    const diffResult = await spawnGitAsync(dir, ["diff"]);
    expect(diffResult.ok).toBe(true);
    expect(parseDiffOutput(diffResult.stdout)).toHaveLength(0);
  });

  test("lock file excluded by default patterns", () => {
    const DEFAULT_EXCLUDE_PATTERNS = [
      "*.lock",
      "*.lockb",
      "bun.lock",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "*.min.js",
      "*.min.css",
      "vendor/**",
      "node_modules/**",
      "dist/**",
    ];
    expect(matchesAnyPattern("yarn.lock", DEFAULT_EXCLUDE_PATTERNS)).toBe(true);
    expect(matchesAnyPattern("bun.lock", DEFAULT_EXCLUDE_PATTERNS)).toBe(true);
    expect(matchesAnyPattern("src/index.ts", DEFAULT_EXCLUDE_PATTERNS)).toBe(false);
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
    const parsed = JSON.parse(text) as { files: Array<{ path: string }> };
    const paths = parsed.files.map((f) => f.path);
    expect(paths).toContain("foo.ts");
    expect(paths).not.toContain("bar.md");
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
    const plain = mkdtempSync(join(tmpdir(), "mcp-plain-diff-"));

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
});
