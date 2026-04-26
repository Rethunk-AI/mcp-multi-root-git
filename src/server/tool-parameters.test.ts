/**
 * Tool parameter surface checks.
 */

import { describe, expect, test } from "bun:test";

import {
  ALL_PARAMETER_SCHEMA_TOOLS,
  captureToolParameterSchemas,
  MUTATING_TOOLS,
  READ_ONLY_ABSOLUTE_ROOT_TOOLS,
} from "./tool-parameter-schemas.js";

describe("tool parameter schemas", () => {
  test("generates JSON Schema for every registered tool", () => {
    const schemas = captureToolParameterSchemas();
    expect(Object.keys(schemas).sort()).toEqual([...ALL_PARAMETER_SCHEMA_TOOLS].sort());
    for (const [name, schema] of Object.entries(schemas)) {
      expect(name.length).toBeGreaterThan(0);
      expect(schema.properties).toBeDefined();
    }
  });

  test("read-only batch tools expose absoluteGitRoots", () => {
    const schemas = captureToolParameterSchemas();
    for (const name of READ_ONLY_ABSOLUTE_ROOT_TOOLS) {
      expect(schemas[name]?.properties).toHaveProperty("absoluteGitRoots");
    }
  });

  test("mutating tools do not expose absoluteGitRoots", () => {
    const schemas = captureToolParameterSchemas();
    for (const name of MUTATING_TOOLS) {
      expect(schemas[name]?.properties).not.toHaveProperty("absoluteGitRoots");
    }
  });

  test("standalone git_push exposes push-only parameters", () => {
    const schema = captureToolParameterSchemas().git_push;
    expect(schema?.properties).toHaveProperty("remote");
    expect(schema?.properties).toHaveProperty("branch");
    expect(schema?.properties).toHaveProperty("setUpstream");
    expect(schema?.properties).not.toHaveProperty("commits");
  });
});
