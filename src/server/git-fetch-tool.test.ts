import { describe, expect, it } from "bun:test";

/**
 * Unit tests for git_fetch tool output parsing and behavior.
 * These are integration-style tests that validate output structure
 * without requiring a live git repository.
 */

// Simulated parseGitFetchOutput function for testing
function parseGitFetchOutput(output: string): { updatedRefs: string[]; newRefs: string[] } {
  const lines = output.split("\n");
  const updatedRefs: string[] = [];
  const newRefs: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.includes("[new")) {
      newRefs.push(trimmed);
    } else if (trimmed.includes(" -> ")) {
      updatedRefs.push(trimmed);
    }
  }

  return { updatedRefs, newRefs };
}

describe("git_fetch parseGitFetchOutput", () => {
  it("parses empty output", () => {
    const result = parseGitFetchOutput("");
    expect(result.updatedRefs).toEqual([]);
    expect(result.newRefs).toEqual([]);
  });

  it("parses updated refs with -> notation", () => {
    const output = `From origin
  abc1234..def5678  main       -> origin/main`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs).toContain("abc1234..def5678  main       -> origin/main");
    expect(result.newRefs).toEqual([]);
  });

  it("parses new refs with [new tag] notation", () => {
    const output = `From origin
 * [new tag]         v1.0.0     -> v1.0.0`;

    const result = parseGitFetchOutput(output);
    expect(result.newRefs.length).toBe(1);
    expect(result.newRefs[0]).toContain("[new tag]");
    expect(result.newRefs[0]).toContain("v1.0.0");
  });

  it("parses mixed updated and new refs", () => {
    const output = `From origin
  abc1234..def5678  main       -> origin/main
 * [new branch]     feature/x  -> origin/feature/x
 * [new tag]        v2.0.0     -> v2.0.0`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs.length).toBe(1);
    expect(result.updatedRefs).toContain("abc1234..def5678  main       -> origin/main");
    expect(result.newRefs.length).toBe(2);
    // New refs include both [new branch] and [new tag] lines
    expect(result.newRefs).toEqual([
      expect.stringContaining("[new branch]"),
      expect.stringContaining("[new tag]"),
    ]);
  });

  it("ignores lines without -> or [new prefix", () => {
    const output = `From origin
Fetching submodule foo
Some other message`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs).toEqual([]);
    expect(result.newRefs).toEqual([]);
  });

  it("handles whitespace correctly", () => {
    const output = `
    abc1234..def5678  main       -> origin/main
    [new tag]        v1.0.0     -> v1.0.0
    `;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs.length).toBe(1);
    expect(result.newRefs.length).toBe(1);
    expect(result.newRefs[0]).toContain("[new tag]");
  });

  it("parses pruned refs with -> notation", () => {
    const output = `From origin
 - [deleted]       origin/old-branch`;

    const result = parseGitFetchOutput(output);
    // Deleted branches typically don't have " -> " in output, so won't be captured as updatedRefs
    // This is expected behavior
    expect(result.updatedRefs).toEqual([]);
    expect(result.newRefs).toEqual([]);
  });

  it("captures branch tracking updates", () => {
    const output = `From origin
  d1e2f3..a4b5c6  main       -> origin/main
  1234567..abcdef  main       -> main`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs.length).toBe(2);
  });

  it("handles refs with special characters", () => {
    const output = `From origin
  abc1234..def5678  refs/pull/123/head -> origin/pull/123/head
 * [new ref]       refs/heads/feature/my-feature -> origin/feature/my-feature`;

    const result = parseGitFetchOutput(output);
    expect(result.updatedRefs.length).toBe(1);
    expect(result.updatedRefs[0]).toContain("refs/pull/123/head");
    expect(result.newRefs.length).toBe(1);
    expect(result.newRefs[0]).toContain("[new ref]");
  });
});
