/**
 * Lightweight test harness for MCP tool execute handlers.
 *
 * FastMCP does not expose a way to inject a custom transport, so the full
 * MCP client/server stack cannot be wired up in tests without stdio or HTTP.
 * Instead, we use a duck-typed fake server that satisfies the FastMCP interface
 * just enough for tool registration: it has `sessions` (empty — tools use
 * `workspaceRoot` arg which bypasses session root detection) and `addTool`
 * which captures the tool definition so we can call `execute` directly.
 *
 * Context passed to execute is a no-op stub — none of the current tools
 * use the context object (logging, progress, etc.).
 *
 * Usage:
 *   const tool = captureTool(registerBatchCommitTool);
 *   const result = await tool({ workspaceRoot: dir, commits: [...] });
 *   // result is string (markdown) or JSON-parseable string
 */

import { afterEach } from "bun:test";
import { type ExecSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastMCP } from "fastmcp";

import { PRESET_FILE_PATH } from "./presets.js";
import { makeFakeFastMcpServer } from "./tool-parameter-schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

type ExecuteFn = (args: AnyRecord, context: AnyRecord) => Promise<string | AnyRecord | undefined>;

interface CapturedTool {
  name: string;
  parameters?: unknown;
  execute: ExecuteFn;
}

// Stub context — no tool currently uses context
const STUB_CONTEXT: AnyRecord = {
  log: {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
  reportProgress: async () => undefined,
  session: undefined,
};

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle — prevents accumulating thousands of leaked test dirs.
// Each test file that calls mkTmpDir / makeRepo / trackTmpPath must register
// cleanup once at module scope:
//   registerTmpCleanup();
// (equivalent to afterEach(cleanupTmpPaths) but documents the contract.)
// Module-scope afterEach(...) in this file would only register once
// (first-importer wins) because the module is cached across test files.
// ---------------------------------------------------------------------------

const tmpPaths: string[] = [];

/** Register afterEach cleanup for dirs created via mkTmpDir / makeRepo. Call once per test file. */
export function registerTmpCleanup(): void {
  afterEach(cleanupTmpPaths);
}

export function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpPaths.push(dir);
  return dir;
}

export function trackTmpPath(path: string): string {
  tmpPaths.push(path);
  return path;
}

export function cleanupTmpPaths(): void {
  while (tmpPaths.length > 0) {
    const p = tmpPaths.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
}

export function writeTestGitConfig(repo: string): void {
  appendFileSync(
    join(repo, ".git", "config"),
    "\n[user]\n\temail = test@example.com\n\tname = Test User\n[commit]\n\tgpgsign = false\n",
  );
}

/** Write a `.rethunk/git-mcp-presets.json` fixture under `gitTop`. */
export function writePresetFixture(gitTop: string, content: unknown): void {
  mkdirSync(join(gitTop, ".rethunk"), { recursive: true });
  writeFileSync(join(gitTop, PRESET_FILE_PATH), JSON.stringify(content), "utf8");
}

// ---------------------------------------------------------------------------
// Process mutation guards — env var / stderr monkey-patching that always
// restores on throw. Extracted from duplicated per-file try/finally blocks;
// prefer these over hand-rolling the same guard in a new test file.
// ---------------------------------------------------------------------------

/**
 * Temporarily set (or, when `value` is undefined, delete) a single env var
 * for the duration of `fn`, restoring the prior value even if `fn` throws.
 */
export function withEnvVar(name: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    fn();
  } finally {
    if (saved !== undefined) process.env[name] = saved;
    else delete process.env[name];
  }
}

/**
 * Capture writes to `process.stderr` for the duration of `fn` (e.g. to
 * assert on, or silence, expected warnings), restoring the original writer
 * even if `fn` throws. Returns the captured chunks in write order.
 */
export function withStderrCapture(fn: () => void): string[] {
  const writes: string[] = [];
  // Not forwarded to, so no need to bind — captured only to restore identity.
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    writes.push(text);
    if (typeof encodingOrCb === "function") encodingOrCb();
    else if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return writes;
}

// ---------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------

function makeFakeServer(roots: string[] = []): { server: FastMCP; tools: CapturedTool[] } {
  const { server, tools } = makeFakeFastMcpServer(roots);
  // Tool execute handlers are always registered synchronously by tools.ts's
  // register* functions, so the shared factory's `execute?` is always
  // present here — narrow it back to the harness's required-execute shape.
  return { server, tools: tools as CapturedTool[] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register one tool and return a caller that invokes its execute handler.
 * The returned function accepts tool args (always include `workspaceRoot`)
 * and returns the raw result as a string.
 */
export function captureTool(
  register: (server: FastMCP) => void,
  toolName?: string,
  roots: string[] = [],
): (args: AnyRecord) => Promise<string> {
  const { server, tools } = makeFakeServer(roots);
  register(server);

  const pick = toolName ? tools.find((t) => t.name === toolName) : tools[0];

  if (!pick) {
    throw new Error(
      `captureTool: no tool captured${toolName ? ` named "${toolName}"` : ""}. Did you forget to call register?`,
    );
  }

  return async (args: AnyRecord): Promise<string> => {
    const result = await pick.execute(args, STUB_CONTEXT);
    if (typeof result === "string") return result;
    return JSON.stringify(result);
  };
}

export function captureToolDefinitions(register: (server: FastMCP) => void): CapturedTool[] {
  const { server, tools } = makeFakeServer();
  register(server);
  return tools;
}

// ---------------------------------------------------------------------------
// Shared git test helpers (extracted from per-file duplication)
// ---------------------------------------------------------------------------

// Lazily created (once per process) isolated HOME for git test subprocesses.
// A developer's real ~/.gitconfig, hooksPath, credential helpers, or aliases
// must never leak into the ~250 git invocations the suite makes — GIT_CONFIG_
// GLOBAL/SYSTEM below cover the config files themselves, but some git
// subsystems (credential cache socket path, GPG homedir, XDG-relative
// defaults) still consult $HOME directly.
let isolatedGitHome: string | undefined;

function getIsolatedGitHome(): string {
  if (isolatedGitHome === undefined) {
    const home = mkdtempSync(join(tmpdir(), "mcp-git-test-home-"));
    isolatedGitHome = home;
    process.once("exit", () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort cleanup at process exit
      }
    });
  }
  return isolatedGitHome;
}

/** Execute git command with standard test environment and encoding. */
export function gitCmd(cwd: string, ...args: string[]): string {
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    // execFileSync's default stdio leaves stdout piped (captured/returned)
    // but lets stderr inherit the parent's — without this override, git's
    // own stderr chatter (push/checkout/worktree status lines, hints, and
    // the deliberate failures exercised by error-path tests) spams bun's
    // test output across ~250 invocations. Fully piping stderr also means
    // execFileSync attaches it to the thrown Error on failure, so per-test
    // stderr assertions have something to read.
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
      // Hermeticity: never let a developer's global/system git config
      // (hooksPath, credential helpers, aliases) leak into test subprocesses.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      HOME: getIsolatedGitHome(),
    },
  };
  return execFileSync("git", args, opts);
}

/** Initialize a basic git repo with test config. */
export function makeRepo(prefix: string = "mcp-test-repo-"): string {
  const dir = mkTmpDir(prefix);
  gitCmd(dir, "init", "-b", "main");
  writeTestGitConfig(dir);
  return dir;
}

/** Initialize a repo with a seed commit (useful for branch/cherry-pick tests). */
export function makeRepoWithSeed(prefix: string = "mcp-test-repo-"): string {
  const dir = makeRepo(prefix);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  gitCmd(dir, "add", "seed.txt");
  gitCmd(dir, "commit", "-m", "chore: seed");
  return dir;
}

/** Initialize work repo + bare remote with tracking set up. */
export function makeRepoWithUpstream(
  workPrefix: string = "mcp-work-",
  remotePrefix: string = "mcp-remote-",
): { work: string; remote: string } {
  const remote = mkTmpDir(remotePrefix);
  gitCmd(remote, "init", "--bare", "-b", "main");

  const work = makeRepoWithSeed(workPrefix);
  gitCmd(work, "remote", "add", "origin", remote);
  gitCmd(work, "push", "-u", "origin", "main");

  return { work, remote };
}

/** Initialize a git repo with main branch and test config. */
export function gitInitMain(dir: string): void {
  gitCmd(dir, "init", "-b", "main");
  writeTestGitConfig(dir);
}

/** Add a commit to a repo with specified file content. */
export function addCommit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  gitCmd(dir, "add", file);
  gitCmd(dir, "commit", "-m", message);
}
