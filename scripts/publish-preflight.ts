import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { parseAllFilesLineCoverage } from "../src/server/coverage.js";

function run(command: string, args: string[]): string {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return `${result.stdout}${result.stderr}`;
}

function assertCleanTree(): void {
  const status = run("git", ["status", "--porcelain"]);
  if (status.trim()) {
    process.stderr.write("Working tree is dirty; commit or stash changes before publishing.\n");
    process.exit(1);
  }
}

function assertVersionHasChangelog(): string {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
  if (!pkg.version) {
    process.stderr.write("package.json has no version.\n");
    process.exit(1);
  }
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  if (!changelog.includes(`## [${pkg.version}]`)) {
    process.stderr.write(`CHANGELOG.md is missing a ## [${pkg.version}] entry.\n`);
    process.exit(1);
  }
  return pkg.version;
}

function runCoverageGate(): void {
  const output = run("bun", ["run", "test:coverage"]);
  writeFileSync("/tmp/mcp-multi-root-git-publish-coverage.txt", output);
  const coverage = parseAllFilesLineCoverage(output);
  if (coverage == null) {
    process.stderr.write("No All files line coverage summary found.\n");
    process.exit(1);
  }
  if (coverage < 80) {
    process.stderr.write(`Line coverage ${coverage.toFixed(2)}% is below minimum 80.00%\n`);
    process.exit(1);
  }
  console.log(`Line coverage OK: ${coverage.toFixed(2)}%`);
}

assertCleanTree();
const version = assertVersionHasChangelog();
run("bun", ["install", "--frozen-lockfile"]);
run("bun", ["run", "schema:tools:check"]);
run("bun", ["run", "build"]);
run("bun", ["run", "check"]);
runCoverageGate();
run("npm", ["pack", "--dry-run"]);
console.log(`Publish preflight OK for v${version}.`);
