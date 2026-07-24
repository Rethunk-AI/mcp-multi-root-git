import { describe, expect, test } from "bun:test";

import { parseAllFilesLineCoverage } from "./coverage.js";

describe("parseAllFilesLineCoverage", () => {
  test("reads % Lines rather than the first percentage column", () => {
    const output = `
-------------------------------------|---------|---------|-------------------
File                                 | % Funcs | % Lines | Uncovered Line #s
-------------------------------------|---------|---------|-------------------
All files                            |   90.64 |   80.47 |
 src/foo.ts                          |  100.00 |  100.00 |
-------------------------------------|---------|---------|-------------------
`;

    expect(parseAllFilesLineCoverage(output)).toBe(80.47);
  });

  test("returns null when the coverage table is absent", () => {
    expect(parseAllFilesLineCoverage("271 pass\n0 fail\n")).toBeNull();
  });

  test("strips ANSI color codes (bun FORCE_COLOR output) before parsing", () => {
    const e = String.fromCharCode(27);
    const output = [
      `${e}[1mFile${e}[0m${e}[2m | ${e}[0m% Funcs${e}[2m | ${e}[0m% Lines${e}[2m | ${e}[0mUncovered`,
      `${e}[31mAll files${e}[0m${e}[2m | ${e}[0m${e}[32m  95.88${e}[0m${e}[2m | ${e}[0m${e}[32m  90.13${e}[0m${e}[2m |${e}[0m`,
    ].join("\n");

    expect(parseAllFilesLineCoverage(output)).toBe(90.13);
  });

  test("multiple coverage tables in one input: pairs the first header with its own All files row", () => {
    // Two concatenated tables (e.g. a per-package run followed by a repeat/retry
    // run) with different column orders — the parser must not cross-match a
    // later table's "All files" row against an earlier table's header index.
    const output = `
-------------------------------------|---------|---------|-------------------
File                                 | % Funcs | % Lines | Uncovered Line #s
-------------------------------------|---------|---------|-------------------
All files                            |   90.64 |   80.47 |
 src/foo.ts                          |  100.00 |  100.00 |
-------------------------------------|---------|---------|-------------------

-------------------------------------|---------|---------|-------------------
File                                 | % Lines | % Funcs | Uncovered Line #s
-------------------------------------|---------|---------|-------------------
All files                            |   55.00 |   60.00 |
 src/bar.ts                          |   55.00 |   60.00 |
-------------------------------------|---------|---------|-------------------
`;

    // First table wins: header and "All files" are both the first match, so
    // they come from the same table even though the second table reorders columns.
    expect(parseAllFilesLineCoverage(output)).toBe(80.47);
  });
});
