import { readFileSync } from "node:fs";

import { parseAllFilesLineCoverage } from "../src/server/coverage.js";

function main(): void {
  const file = process.argv[2];
  const min = Number.parseFloat(process.argv[3] ?? "80");
  if (!file) {
    process.stderr.write("Usage: bun scripts/check-coverage.ts <coverage-output-file> [min]\n");
    process.exit(2);
  }

  const coverage = parseAllFilesLineCoverage(readFileSync(file, "utf8"));
  if (coverage == null) {
    process.stderr.write("No All files line coverage summary found.\n");
    process.exit(1);
  }
  if (coverage < min) {
    process.stderr.write(
      `Line coverage ${coverage.toFixed(2)}% is below minimum ${min.toFixed(2)}%\n`,
    );
    process.exit(1);
  }
  console.log(`Line coverage OK: ${coverage.toFixed(2)}%`);
}

if (import.meta.main) {
  main();
}
