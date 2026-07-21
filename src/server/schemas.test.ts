/**
 * Direct unit tests for src/server/schemas.ts.
 */

import { describe, expect, test } from "bun:test";

import {
  MAX_INVENTORY_ROOTS_DEFAULT,
  MAX_ROOT_PATHS,
  RootPickSchema,
  WorkspacePickSchema,
} from "./schemas.js";

describe("MAX_ROOT_PATHS", () => {
  test("is 256", () => {
    expect(MAX_ROOT_PATHS).toBe(256);
  });
});

describe("WorkspacePickSchema", () => {
  test("defaults format to json", () => {
    const parsed = WorkspacePickSchema.parse({});
    expect(parsed.format).toBe("json");
    expect(parsed.workspaceRoot).toBeUndefined();
  });

  test("accepts workspaceRoot and json format", () => {
    const parsed = WorkspacePickSchema.parse({
      workspaceRoot: "/tmp/repo",
      format: "json",
    });
    expect(parsed.workspaceRoot).toBe("/tmp/repo");
    expect(parsed.format).toBe("json");
  });
});

describe("RootPickSchema", () => {
  test("defaults format to json when root omitted", () => {
    const parsed = RootPickSchema.parse({});
    expect(parsed.format).toBe("json");
    expect(parsed.root).toBeUndefined();
  });

  test('accepts root "*" as a string (no separate literal branch required)', () => {
    const parsed = RootPickSchema.parse({ root: "*", format: "json" });
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

describe("MAX_INVENTORY_ROOTS_DEFAULT", () => {
  test("is re-exported as a positive number", () => {
    expect(MAX_INVENTORY_ROOTS_DEFAULT).toBeGreaterThan(0);
  });
});
