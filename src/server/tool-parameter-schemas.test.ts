import { describe, expect, test } from "bun:test";

import {
  buildToolParameterSchemaDocument,
  MUTATING_TOOLS,
  READ_ONLY_ABSOLUTE_ROOT_TOOLS,
} from "./tool-parameter-schemas.js";

describe("buildToolParameterSchemaDocument", () => {
  test("generates a stable schema document for every tool", () => {
    const doc = buildToolParameterSchemaDocument();
    const toolNames = Object.keys(doc.tools).sort();

    expect(toolNames).toEqual(
      [...READ_ONLY_ABSOLUTE_ROOT_TOOLS, "git_worktree_list", ...MUTATING_TOOLS].sort(),
    );
    expect(doc.tools.git_push.properties).toHaveProperty("setUpstream");
  });
});
