/**
 * Tool parameter surface checks — routing params + parity with tools.ts registrars.
 */

import { describe, expect, test } from "bun:test";

import { captureToolDefinitions } from "./test-harness.js";
import {
  ALL_PARAMETER_SCHEMA_TOOLS,
  captureToolParameterSchemas,
  FAN_OUT_ROOT_TOOLS,
  MUTATING_TOOLS,
  READ_ONLY_SINGLE_REPO_TOOLS,
} from "./tool-parameter-schemas.js";
import { registerRethunkGitTools } from "./tools.js";

describe("tool parameter schemas", () => {
  test("capture keys match registerRethunkGitTools and category union", () => {
    const prev = process.env.RETHUNK_GIT_TOOLS;
    delete process.env.RETHUNK_GIT_TOOLS;
    let registeredNames: string[];
    try {
      registeredNames = captureToolDefinitions((server) => {
        registerRethunkGitTools(server);
      }).map((t) => t.name);
    } finally {
      if (prev === undefined) {
        delete process.env.RETHUNK_GIT_TOOLS;
      } else {
        process.env.RETHUNK_GIT_TOOLS = prev;
      }
    }

    const schemas = captureToolParameterSchemas();
    const captureKeys = Object.keys(schemas);

    // Live tools.ts registrar path is the source of truth for capture.
    expect(captureKeys).toEqual(registeredNames);
    // Category arrays must classify every registered tool (and no extras).
    expect([...ALL_PARAMETER_SCHEMA_TOOLS].sort() as string[]).toEqual([...registeredNames].sort());

    for (const [name, schema] of Object.entries(schemas)) {
      expect(name.length).toBeGreaterThan(0);
      expect(schema.properties).toBeDefined();
    }
  });

  test("fan-out tools expose root and nothing else for routing", () => {
    const schemas = captureToolParameterSchemas();
    for (const name of FAN_OUT_ROOT_TOOLS) {
      expect(schemas[name]?.properties).toHaveProperty("root");
      expect(schemas[name]?.properties).not.toHaveProperty("workspaceRoot");
    }
  });

  test("single-repo and mutating tools expose only workspaceRoot for routing", () => {
    const schemas = captureToolParameterSchemas();
    for (const name of [...READ_ONLY_SINGLE_REPO_TOOLS, ...MUTATING_TOOLS]) {
      expect(schemas[name]?.properties).toHaveProperty("workspaceRoot");
      expect(schemas[name]?.properties).not.toHaveProperty("root");
      expect(schemas[name]?.properties).not.toHaveProperty("absoluteGitRoots");
      expect(schemas[name]?.properties).not.toHaveProperty("allWorkspaceRoots");
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
