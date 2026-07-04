import { describe, expect, test } from "bun:test";

import {
  buildToolParameterSchemaDocument,
  FAN_OUT_ROOT_TOOLS,
  MUTATING_TOOLS,
  READ_ONLY_SINGLE_REPO_TOOLS,
} from "./tool-parameter-schemas.js";

describe("buildToolParameterSchemaDocument", () => {
  test("generates a stable schema document for every tool", () => {
    const doc = buildToolParameterSchemaDocument();
    const toolNames = Object.keys(doc.tools).sort();

    expect(toolNames).toEqual(
      [...FAN_OUT_ROOT_TOOLS, ...READ_ONLY_SINGLE_REPO_TOOLS, ...MUTATING_TOOLS].sort(),
    );
    expect(doc.tools.git_push?.properties).toHaveProperty("setUpstream");
  });
});
