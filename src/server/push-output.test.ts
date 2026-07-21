/**
 * Unit tests for condensePushOutput.
 */

import { describe, expect, test } from "bun:test";

import { condenseCommitOutput, condensePushOutput } from "./push-output.js";

describe("condensePushOutput", () => {
  test("keeps destination and ref-update lines from stderr", () => {
    const stderr = "To github.com:owner/repo.git\n   8dd82ea..e36aa4d  main -> main\n";
    expect(condensePushOutput("", stderr)).toBe(
      "To github.com:owner/repo.git\n   8dd82ea..e36aa4d  main -> main",
    );
  });

  test("keeps new-branch, new-tag, and tracking lines", () => {
    const stderr = [
      "To github.com:owner/repo.git",
      " * [new branch]      feature -> feature",
      " * [new tag]         v2.2.0 -> v2.2.0",
      "branch 'feature' set up to track 'origin/feature'.",
    ].join("\n");
    expect(condensePushOutput("", stderr)).toBe(stderr);
  });

  test("keeps remote: banners (vulnerability notices, PR links)", () => {
    const stderr = [
      "remote: GitHub found 3 vulnerabilities on owner/repo's default branch (1 high).",
      "To github.com:owner/repo.git",
      "   aaa1111..bbb2222  main -> main",
    ].join("\n");
    expect(condensePushOutput("", stderr)).toBe(stderr);
  });

  test("drops hook noise from stdout and reports the omitted count", () => {
    const stdout = [
      "yarn install v4.15.0",
      "RUN v4.1.10 /repo",
      "Test Files  85 passed (85)",
      "Tests  853 passed (853)",
    ].join("\n");
    const stderr = "To github.com:owner/repo.git\n   aaa1111..bbb2222  main -> main";
    expect(condensePushOutput(stdout, stderr)).toBe(
      "To github.com:owner/repo.git\n" +
        "   aaa1111..bbb2222  main -> main\n" +
        "(4 lines of hook/progress output omitted)",
    );
  });

  test("singular omitted-line message", () => {
    const out = condensePushOutput("pre-push: checks passed", "Everything up-to-date");
    expect(out).toBe("Everything up-to-date\n(1 line of hook/progress output omitted)");
  });

  test("merges both streams (state lines survive a noisy stdout)", () => {
    const stdout = "hook chatter\n";
    const stderr = "   aaa1111..bbb2222  main -> main\n";
    const out = condensePushOutput(stdout, stderr);
    expect(out).toContain("main -> main");
    expect(out).not.toContain("hook chatter");
  });

  test("empty input returns empty string", () => {
    expect(condensePushOutput("", "")).toBe("");
    expect(condensePushOutput("\n", "  \n")).toBe("");
  });

  test("blank lines are not counted as omitted", () => {
    const out = condensePushOutput("\n\n\n", "To github.com:owner/repo.git");
    expect(out).toBe("To github.com:owner/repo.git");
  });
});

describe("condenseCommitOutput", () => {
  test("drops the redundant [branch sha] subject line, keeps the diffstat", () => {
    const stdout =
      "[main 4ececa8] fix(batch-commit): stage submodule gitlink pointer bumps\n" +
      " 2 files changed, 41 insertions(+), 2 deletions(-)";
    expect(condenseCommitOutput(stdout, "")).toBe(
      "2 files changed, 41 insertions(+), 2 deletions(-)\n" +
        "(1 line of commit confirmation/hook output omitted)",
    );
  });

  test("keeps create/delete mode and rename-detection lines", () => {
    const stdout = [
      "[main abc1234] chore: rename and add",
      " 3 files changed, 2 insertions(+)",
      " create mode 100644 new.ts",
      " delete mode 100644 old.ts",
      " rename src/{a.ts => b.ts} (100%)",
    ].join("\n");
    const out = condenseCommitOutput(stdout, "");
    expect(out).toContain("create mode 100644 new.ts");
    expect(out).toContain("delete mode 100644 old.ts");
    expect(out).toContain("rename src/{a.ts => b.ts} (100%)");
    expect(out).not.toContain("[main abc1234]");
  });

  test("drops pre-commit hook noise", () => {
    const stdout = "[main abc1234] chore: base\n 1 file changed, 1 insertion(+)";
    const stderr = "husky > pre-commit hook\nrunning lint...\nlint passed";
    const out = condenseCommitOutput(stdout, stderr);
    expect(out).toContain("1 file changed, 1 insertion(+)");
    expect(out).not.toContain("husky");
    expect(out).not.toContain("lint");
  });

  test("empty input returns empty string", () => {
    expect(condenseCommitOutput("", "")).toBe("");
  });
});
