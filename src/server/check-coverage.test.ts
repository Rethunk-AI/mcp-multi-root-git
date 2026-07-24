/**
 * CLI decision-logic tests for the CI coverage gate (scripts/check-coverage.ts).
 * Imports the pure `runCheckCoverage` export directly rather than spawning a
 * subprocess — the injectable `readCoverageFile` param lets these run against
 * fixture strings without touching the filesystem.
 */

import { describe, expect, test } from "bun:test";

import { runCheckCoverage } from "../../scripts/check-coverage.js";

const TABLE_HEADER = "File | % Funcs | % Lines | Uncovered Line #s";

function coverageTable(percent: number): string {
  return [TABLE_HEADER, `All files | 90.00 | ${percent.toFixed(2)} |`].join("\n");
}

describe("runCheckCoverage", () => {
  test("missing coverage-output-file argument → exit 2, usage message", () => {
    const result = runCheckCoverage(undefined, undefined);
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/Usage: bun scripts\/check-coverage\.ts/);
  });

  test("no All files coverage summary in the input → exit 1", () => {
    const result = runCheckCoverage("coverage.txt", "80", () => "271 pass\n0 fail\n");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/No All files line coverage summary found/);
  });

  test("coverage below the minimum → exit 1, reports both percentages", () => {
    const result = runCheckCoverage("coverage.txt", "80", () => coverageTable(79.99));
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/79\.99% is below minimum 80\.00%/);
  });

  test("coverage exactly at the minimum → exit 0 (boundary is inclusive)", () => {
    const result = runCheckCoverage("coverage.txt", "80", () => coverageTable(80));
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/Line coverage OK: 80\.00%/);
  });

  test("coverage above the minimum → exit 0", () => {
    const result = runCheckCoverage("coverage.txt", "80", () => coverageTable(95.5));
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/Line coverage OK: 95\.50%/);
  });

  test("min argument omitted → defaults to 80", () => {
    const atDefault = runCheckCoverage("coverage.txt", undefined, () => coverageTable(80));
    expect(atDefault.exitCode).toBe(0);

    const belowDefault = runCheckCoverage("coverage.txt", undefined, () => coverageTable(79.9));
    expect(belowDefault.exitCode).toBe(1);
  });
});
