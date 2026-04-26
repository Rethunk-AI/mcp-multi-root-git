import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildToolParameterSchemaDocument } from "../src/server/tool-parameter-schemas.js";

const OUTPUT_PATH = resolve(
  join(fileURLToPath(new URL("..", import.meta.url)), "tool-parameters.schema.json"),
);

function renderSchema(): string {
  return `${JSON.stringify(buildToolParameterSchemaDocument(), null, 2)}\n`;
}

function main(): void {
  const next = renderSchema();
  if (process.argv.includes("--check")) {
    const current = readFileSync(OUTPUT_PATH, "utf8");
    if (current !== next) {
      process.stderr.write(`${OUTPUT_PATH} is out of date. Run bun run schema:tools.\n`);
      process.exit(1);
    }
    console.log(`${OUTPUT_PATH} is up to date.`);
    return;
  }

  writeFileSync(OUTPUT_PATH, next);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

if (import.meta.main) {
  main();
}
