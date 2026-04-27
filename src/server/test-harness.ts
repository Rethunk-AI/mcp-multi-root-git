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

import { type ExecSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastMCP } from "fastmcp";

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
// Each test file must register the hook itself:
//   afterEach(cleanupTmpPaths);
// Module-scope afterEach(...) would only register once (first-importer wins)
// because the module is cached across test files in the same bun test run.
// ---------------------------------------------------------------------------

const tmpPaths: string[] = [];

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

// ---------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------

function makeFakeServer(): { server: FastMCP; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const server = {
    sessions: [],
    addTool(tool: { name: string; parameters?: unknown; execute: ExecuteFn }) {
      tools.push({ name: tool.name, parameters: tool.parameters, execute: tool.execute });
    },
    addResource() {
      // Resource tests do not need transport behavior; tool-surface tests only need registration to complete.
    },
  } as unknown as FastMCP;
  return { server, tools };
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
): (args: AnyRecord) => Promise<string> {
  const { server, tools } = makeFakeServer();
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

/** Execute git command with standard test environment and encoding. */
export function gitCmd(cwd: string, ...args: string[]): string {
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
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

/** Add a commit to a repo with specified file content. */
export function addCommit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  gitCmd(dir, "add", file);
  gitCmd(dir, "commit", "-m", message);
}
