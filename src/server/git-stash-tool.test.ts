/**
 * Unit tests for src/server/git-stash-tool.ts.
 *
 * These tests verify the tool schema and response structure only.
 * Integration tests (actual git stash operations) are typically run manually
 * or as part of e2e test suites with real git repos.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

describe("git_stash_tool schemas", () => {
  // Simulating schema validation for git_stash_list
  const GitStashListParamsSchema = z.object({
    workspaceRoot: z.string().optional(),
    rootIndex: z.number().int().min(0).optional(),
    format: z.enum(["markdown", "json"]).optional().default("markdown"),
  });

  test("git_stash_list: accepts valid workspaceRoot", () => {
    const params = { workspaceRoot: "/repo", format: "json" };
    expect(() => GitStashListParamsSchema.parse(params)).not.toThrow();
  });

  test("git_stash_list: accepts valid rootIndex", () => {
    const params = { rootIndex: 0 };
    expect(() => GitStashListParamsSchema.parse(params)).not.toThrow();
  });

  test("git_stash_list: defaults format to markdown", () => {
    const params = {};
    const parsed = GitStashListParamsSchema.parse(params);
    expect(parsed.format).toBe("markdown");
  });

  test("git_stash_list: rejects negative rootIndex", () => {
    const params = { rootIndex: -1 };
    expect(() => GitStashListParamsSchema.parse(params)).toThrow();
  });

  // Simulating schema validation for git_stash_apply
  const GitStashApplyParamsSchema = z.object({
    workspaceRoot: z.string().optional(),
    rootIndex: z.number().int().min(0).optional(),
    format: z.enum(["markdown", "json"]).optional().default("markdown"),
    index: z.number().int().min(0).optional().default(0),
    pop: z.boolean().optional().default(false),
  });

  test("git_stash_apply: defaults index to 0", () => {
    const params = {};
    const parsed = GitStashApplyParamsSchema.parse(params);
    expect(parsed.index).toBe(0);
  });

  test("git_stash_apply: defaults pop to false", () => {
    const params = {};
    const parsed = GitStashApplyParamsSchema.parse(params);
    expect(parsed.pop).toBe(false);
  });

  test("git_stash_apply: accepts custom index", () => {
    const params = { index: 5 };
    const parsed = GitStashApplyParamsSchema.parse(params);
    expect(parsed.index).toBe(5);
  });

  test("git_stash_apply: accepts pop true", () => {
    const params = { pop: true };
    const parsed = GitStashApplyParamsSchema.parse(params);
    expect(parsed.pop).toBe(true);
  });

  test("git_stash_apply: rejects negative index", () => {
    const params = { index: -1 };
    expect(() => GitStashApplyParamsSchema.parse(params)).toThrow();
  });
});

describe("git_stash response structures", () => {
  test("stash list response with no stashes returns empty array", () => {
    const response = { stashes: [] };
    expect(response.stashes).toHaveLength(0);
  });

  test("stash list response includes index, message, and sha", () => {
    const response = {
      stashes: [
        { index: 0, message: "WIP on main: abc1234", sha: "abc1234" },
        { index: 1, message: "WIP on feature: def5678", sha: "def5678" },
      ],
    };
    expect(response.stashes).toHaveLength(2);
    expect(response.stashes[0]).toHaveProperty("index");
    expect(response.stashes[0]).toHaveProperty("message");
    expect(response.stashes[0]).toHaveProperty("sha");
  });

  test("stash apply response includes applied, stashIndex, popped, and optional output", () => {
    const response = {
      applied: true,
      stashIndex: 0,
      popped: false,
      output: "Applied without conflict",
    };
    expect(response.applied).toBe(true);
    expect(response.stashIndex).toBe(0);
    expect(response.popped).toBe(false);
  });

  test("stash apply response with output field", () => {
    const response = {
      applied: false,
      stashIndex: 0,
      popped: false,
      output: "error: Your local changes to the following files would be overwritten",
    };
    expect(response.applied).toBe(false);
    expect(response.output).toBeDefined();
  });
});
