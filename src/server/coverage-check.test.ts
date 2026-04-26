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
});
