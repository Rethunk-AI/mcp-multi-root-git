import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

import { ERROR_CODES } from "./error-codes.js";

/**
 * Parallel git subprocesses for inventory rows and git_status submodule rows.
 * Reads from GIT_SUBPROCESS_PARALLELISM env var (default 4), clamped to [1, 2×CPU_COUNT].
 */
function resolveGitSubprocessParallelism(): number {
  const env = process.env.GIT_SUBPROCESS_PARALLELISM;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (!Number.isNaN(n) && n >= 1) {
      const cpuCount = cpus().length;
      const maxParallel = cpuCount * 2;
      return Math.min(n, maxParallel);
    }
  }
  return 4;
}

export const GIT_SUBPROCESS_PARALLELISM = resolveGitSubprocessParallelism();

/**
 * Default timeout for git subprocesses spawned by spawnGitAsync.
 * Reads from GIT_SUBPROCESS_TIMEOUT_MS env var (default 120000 ms = 2 min).
 * A value of 0 (or negative/NaN) disables the timeout — use for operations
 * like large clones where unbounded wait is intentional.
 */
function resolveGitSubprocessTimeoutMs(): number {
  const env = process.env.GIT_SUBPROCESS_TIMEOUT_MS;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (!Number.isNaN(n) && n > 0) return n;
    // 0 or negative → disabled
    if (!Number.isNaN(n)) return 0;
  }
  return 120_000;
}

export const GIT_SUBPROCESS_TIMEOUT_MS = resolveGitSubprocessTimeoutMs();

// ---------------------------------------------------------------------------
// Git on PATH (lazy probe)
// ---------------------------------------------------------------------------

type GitPathState = "unknown" | "ok" | "missing";

let gitPathState: GitPathState = "unknown";

const GIT_NOT_FOUND_BODY: Record<string, unknown> = {
  error: ERROR_CODES.GIT_NOT_FOUND,
};

export function gateGit(): { ok: true } | { ok: false; body: Record<string, unknown> } {
  if (gitPathState === "ok") {
    return { ok: true };
  }
  if (gitPathState === "missing") {
    return {
      ok: false,
      body: GIT_NOT_FOUND_BODY,
    };
  }
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (r.status !== 0) {
    gitPathState = "missing";
    return {
      ok: false,
      body: GIT_NOT_FOUND_BODY,
    };
  }
  gitPathState = "ok";
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Git helpers (sync — used where async batching not needed)
// ---------------------------------------------------------------------------

export function gitTopLevel(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

export function gitRevParseGitDir(cwd: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0;
}

export function gitRevParseHead(cwd: string): { ok: boolean; sha?: string; text: string } {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return { ok: false, text: (r.stderr || r.stdout || "git rev-parse HEAD failed").trim() };
  }
  return { ok: true, sha: r.stdout.trim(), text: r.stdout.trim() };
}

export function parseGitSubmodulePaths(gitRoot: string): string[] {
  const f = join(gitRoot, ".gitmodules");
  // Skip non-regular files (character devices, sockets, etc.) — common in
  // Claude Code sandbox environments where stub device files shadow paths.
  // Use a single try/catch to avoid TOCTOU between existence check and open.
  let text: string;
  try {
    if (!lstatSync(f).isFile()) return [];
    text = readFileSync(f, "utf8");
  } catch {
    return [];
  }
  const paths: string[] = [];
  let inSubmoduleSection = false;
  for (const rawLine of text.split("\n")) {
    // Strip inline and whole-line comments (; and #)
    const commentIdx = rawLine.search(/\s*[;#]/);
    const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    // Track INI section header
    const sectionMatch = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sectionMatch) {
      inSubmoduleSection = /^submodule\s+"/.test(sectionMatch[1] ?? "");
      continue;
    }
    // Only collect path = lines inside a [submodule "..."] section
    if (!inSubmoduleSection) continue;
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (m?.[1]) paths.push(m[1]);
  }
  return paths;
}

export function hasGitMetadata(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Conservative checks for remote/branch strings passed into git rev-parse / rev-list argv. */
export function isSafeGitUpstreamToken(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 256) return false;
  if (t.includes("..")) return false;
  return /^(?!-)[A-Za-z0-9_./+-]+$/.test(t);
}

// ---------------------------------------------------------------------------
// Async pool for parallel git (inventory)
// ---------------------------------------------------------------------------

export async function asyncPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      const item = items[i];
      if (item === undefined) break;
      results[i] = await fn(item);
    }
  }
  const n = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export interface SpawnGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface SpawnGitOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function spawnGitAsync(
  cwd: string,
  args: string[],
  opts?: SpawnGitOpts,
): Promise<SpawnGitResult> {
  return new Promise((resolveP) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });

    const effectiveTimeout = opts?.timeoutMs ?? GIT_SUBPROCESS_TIMEOUT_MS;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    function cleanup() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (abortListener !== undefined && opts?.signal) {
        opts.signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    }

    function settle(result: SpawnGitResult) {
      if (settled) return;
      settled = true;
      cleanup();
      resolveP(result);
    }

    // AbortSignal: kill immediately if already aborted, else listen
    if (opts?.signal) {
      if (opts.signal.aborted) {
        child.kill("SIGTERM");
        settle({ ok: false, stdout, stderr, aborted: true });
        return;
      }
      abortListener = () => {
        child.kill("SIGTERM");
        settle({ ok: false, stdout, stderr, aborted: true });
      };
      opts.signal.addEventListener("abort", abortListener, { once: true });
    }

    // Timeout: set timer if effectiveTimeout > 0
    if (effectiveTimeout > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        settle({
          ok: false,
          stdout,
          stderr: `${stderr}\n<git timed out after ${effectiveTimeout}ms>`,
          timedOut: true,
        });
      }, effectiveTimeout);
    }

    child.on("error", () => settle({ ok: false, stdout, stderr }));
    child.on("close", (code) => settle({ ok: code === 0, stdout, stderr }));
  });
}

function gitStatusFailText(r: { stderr: string; stdout: string }): string {
  return (r.stderr || r.stdout || "git status failed").trim();
}

export async function gitStatusSnapshotAsync(cwd: string): Promise<{
  branchLine: string;
  branchOk: boolean;
}> {
  const r = await spawnGitAsync(cwd, ["status", "--short", "-b"]);
  if (!r.ok) {
    return { branchOk: false, branchLine: gitStatusFailText(r) };
  }
  return { branchOk: true, branchLine: r.stdout.trimEnd() };
}

export async function gitStatusShortBranchAsync(
  cwd: string,
): Promise<{ ok: boolean; text: string }> {
  const s = await gitStatusSnapshotAsync(cwd);
  return { ok: s.branchOk, text: s.branchLine };
}

export async function fetchAheadBehind(
  absPath: string,
  upstreamSpec: string,
): Promise<{ ahead: string | null; behind: string | null }> {
  const aheadR = await spawnGitAsync(absPath, ["rev-list", "--count", `${upstreamSpec}..HEAD`]);
  const behindR = await spawnGitAsync(absPath, ["rev-list", "--count", `HEAD..${upstreamSpec}`]);
  return {
    ahead: aheadR.ok ? aheadR.stdout.trim() : null,
    behind: behindR.ok ? behindR.stdout.trim() : null,
  };
}
