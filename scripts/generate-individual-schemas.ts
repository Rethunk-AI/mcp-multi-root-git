import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildToolParameterSchemaDocument } from "../src/server/tool-parameter-schemas.js";

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

  // Get all tool schemas from live registrar capture (tools.ts source of truth)
  const doc = buildToolParameterSchemaDocument();
  const toolSchemas = doc.tools;
  const toolNames = Object.keys(toolSchemas);

  if (toolNames.length === 0) {
    process.stderr.write("Error: capture produced zero tool schemas.\n");
    process.exit(1);
  }

  // Build the expected content for every file, then either write or compare.
  const expected = new Map<string, string>();
  const schemaMetadata: Array<{
    name: string;
    file: string;
    description: string;
  }> = [];
  const missing: string[] = [];

  for (const toolName of toolNames) {
    const schema = toolSchemas[toolName];
    if (!schema) {
      missing.push(toolName);
      continue;
    }

    expected.set(join(SCHEMAS_DIR, `${toolName}.json`), formatSchema(toolName, schema));
    schemaMetadata.push({
      name: toolName,
      file: `${toolName}.json`,
      description: `Parameter schema for the '${toolName}' MCP tool.`,
    });
  }

  if (missing.length > 0) {
    process.stderr.write(
      `Error: capture listed tool name(s) without a schema object:\n${missing
        .map((n) => `  - ${n}`)
        .join("\n")}\n`,
    );
    process.exit(1);
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

  const expectedBasenames = new Set([...expected.keys()].map((p) => basename(p)));
  let onDisk: string[] = [];
  try {
    onDisk = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    onDisk = [];
  }
  const orphans = onDisk.filter((f) => !expectedBasenames.has(f));

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
    if (stale.length > 0 || orphans.length > 0) {
      const lines: string[] = [];
      if (stale.length > 0) {
        lines.push("Out of date / missing:");
        for (const f of stale) lines.push(`  - ${f}`);
      }
      if (orphans.length > 0) {
        lines.push("Orphan schema files (not produced by current capture):");
        for (const f of orphans) lines.push(`  - ${join(SCHEMAS_DIR, f)}`);
      }
      process.stderr.write(
        `Individual schema artifacts are out of date. Run bun run schema:individual.\n${lines.join("\n")}\n`,
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
  for (const orphan of orphans) {
    const orphanPath = join(SCHEMAS_DIR, orphan);
    unlinkSync(orphanPath);
    console.log(`Removed orphan ${orphanPath}`);
  }
  console.log(`Generated schemas for ${schemaMetadata.length} tools.`);
}

if (import.meta.main) {
  main();
}
