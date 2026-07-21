/**
 * Tests for git_log_tool.
 *
 * Tests create throwaway git repos via `git init` in OS temp dirs and exercise
 * the tool through `captureTool(registerGitLogTool)` (handler-level), plus a
 * local copy of the `parseShortstat` parse helper tested in isolation.
 *
 * We test:
 *  1. parseShortstat (unit)
 *  2. git_log execute handler: json/markdown/oneline output, maxCommits
 *     truncation, paths/grep/author/since filters, unsafe branch token,
 *     not_a_git_repository, multi-root oneline headers
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerGitLogTool } from "./git-log-tool.js";
import { captureTool, cleanupTmpPaths, gitCmd, makeRepo, mkTmpDir } from "./test-harness.js";

afterEach(cleanupTmpPaths);

// ---------------------------------------------------------------------------
// Helpers (gitCmd, makeRepo shared via test-harness.ts)
// ---------------------------------------------------------------------------

let _seq = 0;
function addCommit(dir: string, file: string, message: string): void {
  // Include a unique counter so two commits to the same file always differ.
  writeFileSync(join(dir, file), `rev${++_seq}\n`);
  gitCmd(dir, "add", file);
  gitCmd(dir, "commit", "-m", message);
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

  test("returns undefined when the regex doesn't match (blank line, unrelated text)", () => {
    expect(parseShortstat("")).toBeUndefined();
    expect(parseShortstat("HEAD is now at abc123")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Execute handler: end-to-end via fake server harness
// ---------------------------------------------------------------------------

// JSON output shape: { groups: [{ workspaceRoot, repo, commits, truncated? }] }
// Commits use GIT_AUTHOR_DATE=2025-01-01 — must pass since beyond 7-day default.
const SINCE_WIDE = "2.years";

describe("git_log execute handler", () => {
  test("returns commits in json format", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.txt", "feat: commit A");
    addCommit(dir, "b.txt", "feat: commit B");

    const run = captureTool(registerGitLogTool);
    const text = await run({ root: dir, format: "json", since: SINCE_WIDE });
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
    const text = await run({ root: dir, since: SINCE_WIDE, format: "markdown" });
    expect(text).toContain("chore: markdown test");
  });

  test("maxCommits caps number of commits returned", async () => {
    const dir = makeRepo();
    for (let i = 1; i <= 5; i++) {
      addCommit(dir, `f${i}.txt`, `chore: commit ${i}`);
    }

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
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

  test("non-git root → not_a_git_repository error in group", async () => {
    const plain = mkTmpDir("mcp-plain-log-");

    const run = captureTool(registerGitLogTool);
    const text = await run({ root: plain, format: "json" });
    const parsed = JSON.parse(text) as {
      groups: Array<{ error?: string }>;
    };
    expect(parsed.groups[0]?.error).toBe("not_a_git_repository");
  });

  test("paths filter limits commits to those touching a specific file", async () => {
    const dir = makeRepo();
    addCommit(dir, "important.ts", "feat: touch important");
    addCommit(dir, "other.ts", "chore: unrelated");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
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

  test("grep filter matches subject (if (grep?.trim()) branch)", async () => {
    const dir = makeRepo();
    addCommit(dir, "x.ts", "feat: add feature X");
    addCommit(dir, "y.ts", "chore: update lockfile");
    addCommit(dir, "z.ts", "feat: add feature Z");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
      format: "json",
      since: SINCE_WIDE,
      grep: "add feature",
    });
    const parsed = JSON.parse(text) as {
      groups: Array<{ commits: Array<{ subject: string }> }>;
    };
    const commits = parsed.groups[0]?.commits ?? [];
    expect(commits.length).toBe(2);
    for (const c of commits) {
      expect(c.subject).toMatch(/add feature/i);
    }
  });

  test("author filter restricts results to matching author (if (author?.trim()) branch)", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.ts", "feat: by test user");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
      format: "json",
      since: SINCE_WIDE,
      author: "NoSuchAuthor",
    });
    const parsed = JSON.parse(text) as {
      groups: Array<{ commits: Array<{ subject: string }> }>;
    };
    expect(parsed.groups[0]?.commits ?? []).toHaveLength(0);
  });

  test("since filter excludes commits older than the window", async () => {
    const dir = makeRepo();
    // Commits use GIT_AUTHOR_DATE=2025-01-01: a wide `since` finds it, a narrow
    // future `since` excludes it — proves `--since=` is actually applied.
    addCommit(dir, "old.ts", "chore: old commit");

    const run = captureTool(registerGitLogTool);

    const wideText = await run({ root: dir, format: "json", since: SINCE_WIDE });
    const wideParsed = JSON.parse(wideText) as {
      groups: Array<{ commits: Array<{ subject: string }> }>;
    };
    expect(wideParsed.groups[0]?.commits ?? []).toHaveLength(1);

    const narrowText = await run({ root: dir, format: "json", since: "2026-01-01" });
    const narrowParsed = JSON.parse(narrowText) as {
      groups: Array<{ commits: Array<{ subject: string }> }>;
    };
    expect(narrowParsed.groups[0]?.commits ?? []).toHaveLength(0);
  });

  test("commit subject containing % is preserved intact", async () => {
    const dir = makeRepo();
    addCommit(dir, "pct.ts", "fix: handle 100% edge case");

    const run = captureTool(registerGitLogTool);
    const text = await run({ root: dir, format: "json", since: SINCE_WIDE });
    const parsed = JSON.parse(text) as {
      groups: Array<{ commits: Array<{ subject: string }> }>;
    };
    const commits = parsed.groups[0]?.commits ?? [];
    expect(commits.length).toBe(1);
    expect(commits[0]?.subject).toBe("fix: handle 100% edge case");
  });

  test("format: oneline returns sha7 + subject lines, no headers (single root)", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.ts", "feat: alpha");
    addCommit(dir, "b.ts", "feat: beta");

    const run = captureTool(registerGitLogTool);
    const text = await run({ root: dir, format: "oneline", since: SINCE_WIDE });

    const lines = text.split("\n").filter((l) => l.trim());
    // Most recent first: beta then alpha
    expect(lines[0]).toMatch(/^[0-9a-f]{7} feat: beta$/);
    expect(lines[1]).toMatch(/^[0-9a-f]{7} feat: alpha$/);
    // No markdown headers or root paths
    expect(text).not.toContain("#");
    expect(text).not.toContain("_root:");
  });

  test("leading-dash branch is rejected with unsafe_ref_token", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.txt", "feat: commit A");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
      format: "json",
      since: SINCE_WIDE,
      branch: "--output=/tmp/x",
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("unsafe_ref_token");
  });

  test("format: oneline multi-root prefixes each group with ### repo (branch)", async () => {
    const dir1 = makeRepo();
    const dir2 = makeRepo();
    addCommit(dir1, "x.ts", "feat: in-repo1");
    addCommit(dir2, "y.ts", "feat: in-repo2");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: [dir1, dir2],
      format: "oneline",
      since: SINCE_WIDE,
    });

    expect(text).toContain("### ");
    expect(text).toContain("feat: in-repo1");
    expect(text).toContain("feat: in-repo2");
  });

  test("path-escape rejection: ../../etc/passwd → path_escapes_repo", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.txt", "feat: commit A");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
      format: "json",
      since: SINCE_WIDE,
      paths: ["../../etc/passwd"],
    });
    const parsed = JSON.parse(text) as { groups: Array<{ error?: string }> };
    expect(parsed.groups[0]?.error).toBe("path_escapes_repo");
  });

  test("follow: true requires exactly one path → invalid_paths", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.txt", "feat: a");

    const run = captureTool(registerGitLogTool);
    const none = JSON.parse(
      await run({ root: dir, format: "json", since: SINCE_WIDE, follow: true }),
    ) as { error: string };
    expect(none.error).toBe("invalid_paths");

    const multi = JSON.parse(
      await run({
        root: dir,
        format: "json",
        since: SINCE_WIDE,
        follow: true,
        paths: ["a.txt", "b.txt"],
      }),
    ) as { error: string };
    expect(multi.error).toBe("invalid_paths");
  });

  test("follow: true with one path returns rename-aware history", async () => {
    const dir = makeRepo();
    addCommit(dir, "old-name.ts", "feat: initial");
    // Pure rename (100% similarity) so git detects the rename for --follow.
    gitCmd(dir, "mv", "old-name.ts", "new-name.ts");
    gitCmd(dir, "commit", "-m", "refactor: rename old-name → new-name");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
      format: "json",
      since: SINCE_WIDE,
      paths: ["new-name.ts"],
      follow: true,
    });
    const parsed = JSON.parse(text) as {
      groups: Array<{ commits: Array<{ subject: string }> }>;
    };
    const subjects = (parsed.groups[0]?.commits ?? []).map((c) => c.subject);
    expect(subjects).toContain("feat: initial");
    expect(subjects).toContain("refactor: rename old-name → new-name");
  });

  test("invalid_since rejects shell metacharacters", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.txt", "feat: a");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
      format: "json",
      since: "7.days; rm -rf /",
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("invalid_since");
  });

  test("invalid_paths rejects shell metacharacters in a path entry", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.txt", "feat: a");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
      format: "json",
      since: SINCE_WIDE,
      paths: ["a.txt;evil"],
    });
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toBe("invalid_paths");
  });

  test("unknown branch → git_log_failed group error", async () => {
    const dir = makeRepo();
    addCommit(dir, "a.txt", "feat: a");

    const run = captureTool(registerGitLogTool);
    const text = await run({
      root: dir,
      format: "json",
      since: SINCE_WIDE,
      branch: "no-such-branch-xyz",
    });
    const parsed = JSON.parse(text) as { groups: Array<{ error?: string }> };
    expect(parsed.groups[0]?.error).toBe("git_log_failed");
  });
});
