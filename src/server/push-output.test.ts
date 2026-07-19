/**
 * Unit tests for condensePushOutput.
 */

import { describe, expect, test } from "bun:test";

import { condensePushOutput } from "./push-output.js";

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
