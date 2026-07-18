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
});
