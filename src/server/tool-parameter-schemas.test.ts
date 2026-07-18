import { describe, expect, test } from "bun:test";

import { buildToolParameterSchemaDocument } from "./tool-parameter-schemas.js";

describe("buildToolParameterSchemaDocument", () => {
  test("document metadata and git_push setUpstream stay stable", () => {
    const doc = buildToolParameterSchemaDocument();

    expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(doc.generatedBy).toBe("scripts/generate-tool-parameters-schema.ts");
    expect(doc.tools.git_push?.properties).toHaveProperty("setUpstream");
    expect(Object.keys(doc.tools).length).toBeGreaterThan(0);
  });
});
