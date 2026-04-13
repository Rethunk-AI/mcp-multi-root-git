/**
 * Integration tests for git_log_tool helpers.
 *
 * Tests create throwaway git repos via `git init` in OS temp dirs
 * and exercise the private parse helpers indirectly through the
 * exported runGitLog-equivalent logic baked into the tool.
 *
 * We test:
 *  1. parseShortstat (unit)
 *  2. git log against a real throwaway repo (integration) — returns commits
 *  3. maxCommits truncation
 *  4. `since` filter excludes older commits
 *  5. `paths` filter limits to relevant commits
 *  6. `grep` filter matches subject
 *  7. not_a_git_repo error code for a non-git path
 *  8. author filter restricts results
 *  9. commit subject containing % is preserved intact
 */

import { describe, expect, test } from "bun:test";
import { type ExecSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitTopLevel, spawnGitAsync } from "./git.js";
import { registerGitLogTool } from "./git-log-tool.js";
import { captureTool } from "./test-harness.js";

// ---------------------------------------------------------------------------
// Separators — must match git-log-tool.ts constants
// ---------------------------------------------------------------------------

/** SOH — emitted by %x01 in git --pretty format; safe to pass in spawn args. */
const FS = "\x01";
/** STX — emitted by %x02 in git --pretty format; safe to pass in spawn args. */
const RS = "\x02";

/** Format string to pass as --pretty=tformat: argument (no raw control chars in the arg itself).
 * \x02 is a record-START marker; \x01 separates fields. tformat adds \n after each record. */
const PRETTY_FORMAT = "%x02%h%x01%H%x01%s%x01%aN%x01%aE%x01%aI%x01%ar%x01";

// ---------------------------------------------------------------------------
// Helpers
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
  const dir = mkdtempSync(join(tmpdir(), "mcp-git-log-test-"));
  gitCmd(dir, "init", "-b", "main");
  gitCmd(dir, "config", "user.email", "test@example.com");
  gitCmd(dir, "config", "user.name", "Test User");
  return dir;
}

let _seq = 0;
function addCommit(dir: string, file: string, message: string): void {
  // Include a unique counter so two commits to the same file always differ.
  writeFileSync(join(dir, file), `rev${++_seq}\n`);
  gitCmd(dir, "add", file);
  gitCmd(dir, "commit", "-m", message);
}

/** Parse records from git log output using the shared separators.
 * RS (\x02) is a record-START marker; FS (\x01) separates fields within each record. */
function parseRecords(stdout: string): string[][] {
  // Split on RS (record-start); first chunk is empty (before first record).
  return stdout
    .split(RS)
    .slice(1) // drop leading empty chunk
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      // Fields are on the first line (before the first \n); shortstat follows after blank line.
      const nlIdx = chunk.indexOf("\n");
      const fieldsPart = nlIdx >= 0 ? chunk.slice(0, nlIdx) : chunk;
      return fieldsPart.split(FS);
    });
}

// ---------------------------------------------------------------------------
// Unit: parseShortstat (local copy to test in isolation)
// ---------------------------------------------------------------------------

function parseShortstat(
  line: string,
): { filesChanged: number; insertions: number; deletions: number } | undefined {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(
    line,
  );
  if (!m) return undefined;
  return {
    filesChanged: parseInt(m[1] ?? "0", 10),
    insertions: parseInt(m[2] ?? "0", 10),
    deletions: parseInt(m[3] ?? "0", 10),
  };
}

describe("parseShortstat", () => {
  test("parses full line with insertions and deletions", () => {
    const r = parseShortstat(" 3 files changed, 12 insertions(+), 5 deletions(-)");
    expect(r).toEqual({ filesChanged: 3, insertions: 12, deletions: 5 });
  });

  test("parses line with only insertions", () => {
    const r = parseShortstat(" 1 file changed, 4 insertions(+)");
    expect(r).toEqual({ filesChanged: 1, insertions: 4, deletions: 0 });
  });

  test("parses line with only deletions", () => {
    const r = parseShortstat(" 2 files changed, 7 deletions(-)");
    expect(r).toEqual({ filesChanged: 2, insertions: 0, deletions: 7 });
  });

  test("returns undefined for blank line", () => {
    expect(parseShortstat("")).toBeUndefined();
  });

  test("returns undefined for unrelated text", () => {
    expect(parseShortstat("HEAD is now at abc123")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: git log against throwaway repos
// ---------------------------------------------------------------------------

describe("git_log integration", () => {
  test("returns commits from a repo", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.txt", "feat: add a");
    addCommit(dir, "b.txt", "feat: add b");

    const r = await spawnGitAsync(dir, [
      "log",
      `--pretty=tformat:${PRETTY_FORMAT}`,
      "--shortstat",
      "-n",
      "10",
      "--since=5.years",
    ]);
    expect(r.ok).toBe(true);

    const records = parseRecords(r.stdout);
    expect(records.length).toBe(2);

    const first = records[0] ?? [];
    expect(first[2]).toBe("feat: add b"); // most recent first
    expect(first[3]).toBe("Test User");
  });

  test("maxCommits truncation: fetching n+1 detects overflow", async () => {
    const dir = makeRepo();
    for (let i = 1; i <= 5; i++) {
      addCommit(dir, `f${i}.txt`, `chore: commit ${i}`);
    }

    const limit = 3;
    const fetchLimit = limit + 1; // 4

    const r = await spawnGitAsync(dir, [
      "log",
      `--pretty=tformat:${PRETTY_FORMAT}`,
      "--shortstat",
      "-n",
      String(fetchLimit),
      "--since=5.years",
    ]);
    expect(r.ok).toBe(true);

    const records = parseRecords(r.stdout);
    // Should return exactly fetchLimit (4) when ≥4 commits exist
    expect(records.length).toBe(fetchLimit);

    // Simulate truncation logic
    const truncated = records.length > limit;
    const commits = truncated ? records.slice(0, limit) : records;
    const omittedCount = truncated ? records.length - limit : 0;
    expect(truncated).toBe(true);
    expect(commits.length).toBe(3);
    expect(omittedCount).toBe(1);
  });

  test("paths filter limits commits to those touching a specific file", async () => {
    const dir = makeRepo();
    addCommit(dir, "important.ts", "feat: touch important");
    addCommit(dir, "other.ts", "chore: unrelated");
    addCommit(dir, "important.ts", "fix: touch important again");

    const r = await spawnGitAsync(dir, [
      "log",
      `--pretty=tformat:${PRETTY_FORMAT}`,
      "--shortstat",
      "-n",
      "50",
      "--since=5.years",
      "--",
      "important.ts",
    ]);
    expect(r.ok).toBe(true);

    const records = parseRecords(r.stdout);
    expect(records.length).toBe(2);
    for (const rec of records) {
      expect(rec[2]).toMatch(/important/);
    }
  });

  test("grep filter matches subject", async () => {
    const dir = makeRepo();
    addCommit(dir, "x.ts", "feat: add feature X");
    addCommit(dir, "y.ts", "chore: update lockfile");
    addCommit(dir, "z.ts", "feat: add feature Z");

    const r = await spawnGitAsync(dir, [
      "log",
      `--pretty=tformat:${PRETTY_FORMAT}`,
      "--shortstat",
      "-n",
      "50",
      "--since=5.years",
      "--grep=add feature",
      "-i",
    ]);
    expect(r.ok).toBe(true);

    const records = parseRecords(r.stdout);
    expect(records.length).toBe(2);
    for (const rec of records) {
      expect(rec[2]).toMatch(/add feature/i);
    }
  });

  test("since filter excludes commits older than the window", async () => {
    const dir = makeRepo();
    // All commits use GIT_AUTHOR_DATE=2025-01-01; ask since 2026-01-01 — none match.
    addCommit(dir, "old.ts", "chore: old commit");

    const r = await spawnGitAsync(dir, [
      "log",
      `--pretty=tformat:${PRETTY_FORMAT}`,
      "--shortstat",
      "-n",
      "50",
      "--since=2026-01-01",
    ]);
    expect(r.ok).toBe(true);

    const records = parseRecords(r.stdout);
    expect(records.length).toBe(0);
  });

  test("not_a_git_repo: gitTopLevel returns null for a plain directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-not-git-"));
    const top = gitTopLevel(dir);
    expect(top).toBeNull();
  });

  test("author filter restricts results to matching author", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.ts", "feat: by test user");

    const r = await spawnGitAsync(dir, [
      "log",
      `--pretty=tformat:${PRETTY_FORMAT}`,
      "--shortstat",
      "-n",
      "50",
      "--since=5.years",
      "--author=NoSuchAuthor",
    ]);
    expect(r.ok).toBe(true);

    const records = parseRecords(r.stdout);
    expect(records.length).toBe(0);
  });

  test("commit subject containing % is preserved intact", async () => {
    const dir = makeRepo();
    addCommit(dir, "pct.ts", "fix: handle 100% edge case");

    const r = await spawnGitAsync(dir, [
      "log",
      `--pretty=tformat:${PRETTY_FORMAT}`,
      "--shortstat",
      "-n",
      "10",
      "--since=5.years",
    ]);
    expect(r.ok).toBe(true);

    const records = parseRecords(r.stdout);
    expect(records.length).toBe(1);
    expect(records[0]?.[2]).toBe("fix: handle 100% edge case");
  });
});

// ---------------------------------------------------------------------------
// Execute handler: end-to-end via fake server harness
// ---------------------------------------------------------------------------

// JSON output shape: { groups: [{ workspace_root, repo, commits, truncated? }] }
// Commits use GIT_AUTHOR_DATE=2025-01-01 — must pass since beyond 7-day default.
const SINCE_WIDE = "2.years";

describe("git_log execute handler", () => {
  test("returns commits in json format", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.txt", "feat: commit A");
    addCommit(dir, "b.txt", "feat: commit B");

    const run = captureTool(registerGitLogTool);
    const text = await run({ workspaceRoot: dir, format: "json", since: SINCE_WIDE });
    const parsed = JSON.parse(text) as {
      groups: Array<{ commits: Array<{ subject: string }> }>;
    };
    const commits = parsed.groups[0]?.commits ?? [];
    expect(commits.length).toBeGreaterThanOrEqual(2);
    const subjects = commits.map((c) => c.subject);
    expect(subjects).toContain("feat: commit B");
    expect(subjects).toContain("feat: commit A");
  });

  test("markdown output contains commit subjects", async () => {
    const dir = makeRepo();
    addCommit(dir, "x.txt", "chore: markdown test");

    const run = captureTool(registerGitLogTool);
    const text = await run({ workspaceRoot: dir, since: SINCE_WIDE });
    expect(text).toContain("chore: markdown test");
  });

  test("maxCommits caps number of commits returned", async () => {
    const dir = makeRepo();
    for (let i = 1; i <= 5; i++) {
      addCommit(dir, `f${i}.txt`, `chore: commit ${i}`);
    }

    const run = captureTool(registerGitLogTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      since: SINCE_WIDE,
      maxCommits: 3,
    });
    const parsed = JSON.parse(text) as {
      groups: Array<{ commits: Array<{ subject: string }>; truncated?: boolean }>;
    };
    const group = parsed.groups[0];
    expect(group?.commits.length).toBe(3);
    expect(group?.truncated).toBe(true);
  });

  test("non-git workspaceRoot → not_a_git_repo error in group", async () => {
    const plain = mkdtempSync(join(tmpdir(), "mcp-plain-log-"));

    const run = captureTool(registerGitLogTool);
    const text = await run({ workspaceRoot: plain, format: "json" });
    const parsed = JSON.parse(text) as {
      groups: Array<{ error?: string }>;
    };
    expect(parsed.groups[0]?.error).toBe("not_a_git_repo");
  });

  test("paths filter limits commits to those touching a specific file", async () => {
    const dir = makeRepo();
    addCommit(dir, "important.ts", "feat: touch important");
    addCommit(dir, "other.ts", "chore: unrelated");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      workspaceRoot: dir,
      format: "json",
      since: SINCE_WIDE,
      paths: ["important.ts"],
    });
    const parsed = JSON.parse(text) as {
      groups: Array<{ commits: Array<{ subject: string }> }>;
    };
    const commits = parsed.groups[0]?.commits ?? [];
    expect(commits.length).toBe(1);
    expect(commits[0]?.subject).toContain("important");
  });
});
