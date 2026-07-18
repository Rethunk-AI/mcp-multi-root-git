/**
 * Unit tests for src/server/json.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { jsonRespond, readMcpServerVersion, spreadDefined, spreadWhen } from "./json.js";

describe("MCP_JSON_FORMAT_VERSION", () => {
  test('server.ts exports "5" and embeds it in FastMCP instructions', () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    expect(src).toMatch(/export const MCP_JSON_FORMAT_VERSION = "5"/);
    expect(src).toContain("JSON payload contract: format version ${MCP_JSON_FORMAT_VERSION}");
  });
});

describe("readMcpServerVersion", () => {
  test("returns a valid major.minor.patch string satisfying the FastMCP version type", () => {
    const v = readMcpServerVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    const parts = v.split(".").map(Number);
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("jsonRespond", () => {
  test("serialises objects, including nested ones", () => {
    expect(jsonRespond({ ok: true })).toBe('{"ok":true}');
    const result = jsonRespond({ error: "not_found", path: "/a/b" });
    expect(JSON.parse(result)).toEqual({ error: "not_found", path: "/a/b" });
  });
});

describe("spreadWhen", () => {
  test("returns the fields when cond is true", () => {
    const result = spreadWhen(true, { foo: "bar" });
    expect(result).toEqual({ foo: "bar" });
  });

  test("returns an empty object when cond is false", () => {
    const result = spreadWhen(false, { foo: "bar" });
    expect(result).toEqual({});
  });
});

describe("spreadDefined", () => {
  test("spreads the key when value is defined", () => {
    const result = spreadDefined("count", 42);
    expect(result).toEqual({ count: 42 });
  });

  test("returns empty object when value is undefined", () => {
    const result = spreadDefined("count", undefined);
    expect(result).toEqual({});
  });

  test("false and 0 are treated as defined (not undefined)", () => {
    expect(spreadDefined("flag", false)).toEqual({ flag: false });
    expect(spreadDefined("num", 0)).toEqual({ num: 0 });
  });
});
