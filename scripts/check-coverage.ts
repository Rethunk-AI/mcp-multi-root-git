import { readFileSync } from "node:fs";

import { parseAllFilesLineCoverage } from "../src/server/coverage.js";

export interface CheckCoverageResult {
  exitCode: number;
  message: string;
}

export function runCheckCoverage(
  file: string | undefined,
  minArg: string | undefined,
  readCoverageFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): CheckCoverageResult {
  const min = Number.parseFloat(minArg ?? "80");
  if (!file) {
    return {
      exitCode: 2,
      message: "Usage: bun scripts/check-coverage.ts <coverage-output-file> [min]\n",
    };
  }

  const coverage = parseAllFilesLineCoverage(readCoverageFile(file));
  if (coverage == null) {
    return { exitCode: 1, message: "No All files line coverage summary found.\n" };
  }
  if (coverage < min) {
    return {
      exitCode: 1,
      message: `Line coverage ${coverage.toFixed(2)}% is below minimum ${min.toFixed(2)}%\n`,
    };
  }
  return { exitCode: 0, message: `Line coverage OK: ${coverage.toFixed(2)}%` };
}

function main(): void {
  const result = runCheckCoverage(process.argv[2], process.argv[3]);
  if (result.exitCode === 0) {
    console.log(result.message);
  } else {
    process.stderr.write(result.message);
  }
  process.exit(result.exitCode);
}

if (import.meta.main) {
  main();
}
