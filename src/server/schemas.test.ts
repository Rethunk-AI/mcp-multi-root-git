/**
 * Direct unit tests for src/server/schemas.ts.
 */

import { describe, expect, test } from "bun:test";

import { MAX_ROOT_PATHS, RootPickSchema, WorkspacePickSchema } from "./schemas.js";

describe("MAX_ROOT_PATHS", () => {
  test("is 256", () => {
    expect(MAX_ROOT_PATHS).toBe(256);
  });
});

describe("WorkspacePickSchema", () => {
  test("workspaceRoot is optional", () => {
    const parsed = WorkspacePickSchema.parse({});
    expect(parsed.workspaceRoot).toBeUndefined();
  });

  test("accepts workspaceRoot", () => {
    const parsed = WorkspacePickSchema.parse({
      workspaceRoot: "/tmp/repo",
    });
    expect(parsed.workspaceRoot).toBe("/tmp/repo");
  });
});

describe("RootPickSchema", () => {
  test("root is optional", () => {
    const parsed = RootPickSchema.parse({});
    expect(parsed.root).toBeUndefined();
  });

  test('accepts root "*" as a string (no separate literal branch required)', () => {
    const parsed = RootPickSchema.parse({ root: "*" });
    expect(parsed.root).toBe("*");
  });

  test("accepts root string and root array without Zod max rejection", () => {
    expect(RootPickSchema.parse({ root: "/tmp/a" }).root).toBe("/tmp/a");
    const many = Array.from({ length: MAX_ROOT_PATHS + 1 }, (_, i) => `/tmp/r${i}`);
    // Length enforcement is in resolveRootPathList, not Zod — so parse succeeds.
    const parsed = RootPickSchema.parse({ root: many });
    expect(Array.isArray(parsed.root) && parsed.root.length).toBe(MAX_ROOT_PATHS + 1);
  });
});
