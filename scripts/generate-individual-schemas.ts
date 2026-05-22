import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_PARAMETER_SCHEMA_TOOLS,
  buildToolParameterSchemaDocument,
} from "../src/server/tool-parameter-schemas.js";

const SCHEMAS_DIR = resolve(join(fileURLToPath(new URL("..", import.meta.url)), "schemas"));

function formatSchema(toolName: string, schema: Record<string, unknown>): string {
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `@rethunk/mcp-multi-root-git: ${toolName}`,
      description: `Parameter schema for the '${toolName}' MCP tool.`,
      ...schema,
    },
    null,
    2,
  )}\n`;
}

function main(): void {
  const checkOnly = process.argv.includes("--check");

  // Ensure schemas directory exists (write mode only)
  if (!checkOnly) mkdirSync(SCHEMAS_DIR, { recursive: true });

  // Get all tool schemas
  const doc = buildToolParameterSchemaDocument();
  const toolSchemas = doc.tools;

  // Build the expected content for every file, then either write or compare.
  const expected = new Map<string, string>();
  const schemaMetadata: Array<{
    name: string;
    file: string;
    description: string;
  }> = [];

  for (const toolName of ALL_PARAMETER_SCHEMA_TOOLS) {
    const schema = toolSchemas[toolName];
    if (!schema) {
      console.warn(`Warning: No schema found for tool '${toolName}'`);
      continue;
    }

    expected.set(join(SCHEMAS_DIR, `${toolName}.json`), formatSchema(toolName, schema));
    schemaMetadata.push({
      name: toolName,
      file: `${toolName}.json`,
      description: `Parameter schema for the '${toolName}' MCP tool.`,
    });
  }

  const indexPath = join(SCHEMAS_DIR, "index.json");
  expected.set(
    indexPath,
    `${JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "@rethunk/mcp-multi-root-git tool schemas index",
        description: "Index of all available MCP tool parameter schemas.",
        generatedBy: "scripts/generate-individual-schemas.ts",
        tools: schemaMetadata,
      },
      null,
      2,
    )}\n`,
  );

  if (checkOnly) {
    const stale: string[] = [];
    for (const [filePath, content] of expected) {
      let current: string | undefined;
      try {
        current = readFileSync(filePath, "utf8");
      } catch {
        current = undefined;
      }
      if (current !== content) stale.push(filePath);
    }
    if (stale.length > 0) {
      process.stderr.write(
        `Individual schema artifacts are out of date. Run bun run schema:individual.\n${stale
          .map((f) => `  - ${f}`)
          .join("\n")}\n`,
      );
      process.exit(1);
    }
    console.log(`All ${expected.size} individual schema artifacts are up to date.`);
    return;
  }

  for (const [filePath, content] of expected) {
    writeFileSync(filePath, content);
    console.log(`Wrote ${filePath}`);
  }
  console.log(`Generated schemas for ${schemaMetadata.length} tools.`);
}

if (import.meta.main) {
  main();
}
