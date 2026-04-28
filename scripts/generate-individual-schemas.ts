import { mkdirSync, writeFileSync } from "node:fs";
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
  // Ensure schemas directory exists
  mkdirSync(SCHEMAS_DIR, { recursive: true });

  // Get all tool schemas
  const doc = buildToolParameterSchemaDocument();
  const toolSchemas = doc.tools;

  // Write individual schema files for each tool
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

    const fileName = `${toolName}.json`;
    const filePath = join(SCHEMAS_DIR, fileName);
    const content = formatSchema(toolName, schema);
    writeFileSync(filePath, content);
    console.log(`Wrote ${filePath}`);

    schemaMetadata.push({
      name: toolName,
      file: `${toolName}.json`,
      description: `Parameter schema for the '${toolName}' MCP tool.`,
    });
  }

  // Write index.json
  const indexPath = join(SCHEMAS_DIR, "index.json");
  const indexContent = `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "@rethunk/mcp-multi-root-git tool schemas index",
      description: "Index of all available MCP tool parameter schemas.",
      generatedBy: "scripts/generate-individual-schemas.ts",
      tools: schemaMetadata,
    },
    null,
    2,
  )}\n`;

  writeFileSync(indexPath, indexContent);
  console.log(`Wrote ${indexPath}`);
  console.log(`Generated schemas for ${schemaMetadata.length} tools.`);
}

if (import.meta.main) {
  main();
}
