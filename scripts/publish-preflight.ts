import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const coverageDir = mkdtempSync(join(tmpdir(), "mcp-multi-root-git-coverage-"));
  const coverageFile = join(coverageDir, "coverage.txt");
  writeFileSync(coverageFile, output);
  run("bun", ["run", "coverage:check", coverageFile, "80"]);
}

assertCleanTree();
const version = assertVersionHasChangelog();
run("bun", ["install", "--frozen-lockfile"]);
run("bun", ["run", "schema:tools:check"]);
run("bun", ["run", "schema:individual:check"]);
run("bun", ["run", "build"]);
run("bun", ["run", "lint"]);
run("bun", ["run", "typecheck"]);
runCoverageGate();
run("npm", ["pack", "--dry-run"]);
console.log(`Publish preflight OK for v${version}.`);
