import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

import { ERROR_CODES } from "./error-codes.js";

/**
 * Parallel git subprocesses for inventory rows and git_status submodule rows.
 * Reads from GIT_SUBPROCESS_PARALLELISM env var (default 4), clamped to [1, 2×CPU_COUNT].
 */
export function resolveGitSubprocessParallelism(
  envValue: string | undefined = process.env.GIT_SUBPROCESS_PARALLELISM,
  cpuCount: number = cpus().length,
): number {
  if (envValue) {
    const n = Number.parseInt(envValue, 10);
    if (!Number.isNaN(n) && n >= 1) {
      const maxParallel = Math.max(1, cpuCount * 2);
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
export function resolveGitSubprocessTimeoutMs(
  envValue: string | undefined = process.env.GIT_SUBPROCESS_TIMEOUT_MS,
): number {
  if (envValue) {
    const n = Number.parseInt(envValue, 10);
    if (!Number.isNaN(n) && n > 0) return n;
    // 0 or negative → disabled
    if (!Number.isNaN(n)) return 0;
  }
  return 120_000;
}

export const GIT_SUBPROCESS_TIMEOUT_MS = resolveGitSubprocessTimeoutMs();

/**
 * Max combined stdout+stderr bytes retained from spawnGitAsync.
 * Env: GIT_SUBPROCESS_MAX_BUFFER_BYTES (default 16 MiB). Exceeding kills the child.
 */
export function resolveGitSubprocessMaxBufferBytes(
  envValue: string | undefined = process.env.GIT_SUBPROCESS_MAX_BUFFER_BYTES,
): number {
  if (envValue) {
    const n = Number.parseInt(envValue, 10);
    if (!Number.isNaN(n) && n >= 1024) return n;
  }
  return 16 * 1024 * 1024;
}

export const GIT_SUBPROCESS_MAX_BUFFER_BYTES = resolveGitSubprocessMaxBufferBytes();

/** Delay after SIGTERM before escalating to SIGKILL (spawnGitAsync timeout/abort/overflow). */
export const GIT_SUBPROCESS_SIGKILL_ESCALATION_MS = 2_000;

/** Timeout for sync spawnSync helpers (gateGit, rev-parse). */
export const GIT_SYNC_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Git on PATH (lazy probe)
// ---------------------------------------------------------------------------

type GitPathState = "unknown" | "ok" | "missing";

let gitPathState: GitPathState = "unknown";

const GIT_NOT_FOUND_BODY: Record<string, unknown> = {
  error: ERROR_CODES.GIT_NOT_FOUND,
};

/** Test-only: reset the cached git-on-PATH probe. */
export function resetGitPathStateForTests(): void {
  gitPathState = "unknown";
}

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
  const r = spawnSync("git", ["--version"], {
    encoding: "utf8",
    timeout: GIT_SYNC_TIMEOUT_MS,
  });
  if (r.error || r.status !== 0) {
    // Do not cache "missing" on timeout — a wedged git may recover.
    const timedOut =
      r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    if (!timedOut) {
      gitPathState = "missing";
    }
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
    timeout: GIT_SYNC_TIMEOUT_MS,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim();
}

export function gitRevParseGitDir(cwd: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd,
    encoding: "utf8",
    timeout: GIT_SYNC_TIMEOUT_MS,
  });
  return !r.error && r.status === 0;
}

export function gitRevParseHead(cwd: string): { ok: boolean; sha?: string; text: string } {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: GIT_SYNC_TIMEOUT_MS,
  });
  if (r.error || r.status !== 0) {
    return { ok: false, text: (r.stderr || r.stdout || "git rev-parse HEAD failed").trim() };
  }
  return { ok: true, sha: r.stdout.trim(), text: r.stdout.trim() };
}

export function parseGitSubmodulePaths(gitRoot: string): string[] {
  const f = join(gitRoot, ".gitmodules");
  // Open once and check/read via the same fd — avoids a TOCTOU window between
  // a separate stat and a separate open/read (the path could be swapped out
  // from under a name-based check). O_NOFOLLOW rejects symlinks, matching the
  // prior lstat-based behavior of skipping non-regular files (character
  // devices, sockets, symlinks, etc. — common in Claude Code sandbox
  // environments where stub device files shadow paths).
  let text: string;
  let fd: number;
  try {
    fd = openSync(f, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return [];
  }
  try {
    if (!fstatSync(fd).isFile()) return [];
    text = readFileSync(fd, "utf8");
  } catch {
    return [];
  } finally {
    closeSync(fd);
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
  /** True when stdout/stderr hit GIT_SUBPROCESS_MAX_BUFFER_BYTES. */
  truncated?: boolean;
}

export interface SpawnGitOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * When true, leave stdin open (do not end). Used by tests so commands like
   * `git cat-file --batch` hang until timeout/abort.
   */
  holdStdin?: boolean;
  /** Override max stdout+stderr bytes (default GIT_SUBPROCESS_MAX_BUFFER_BYTES). */
  maxBufferBytes?: number;
  /** Override SIGKILL escalation delay after SIGTERM (default 2000 ms). */
  sigkillAfterMs?: number;
}

export function spawnGitAsync(
  cwd: string,
  args: string[],
  opts?: SpawnGitOpts,
): Promise<SpawnGitResult> {
  return new Promise((resolveP) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const maxBuffer = opts?.maxBufferBytes ?? GIT_SUBPROCESS_MAX_BUFFER_BYTES;
    const sigkillAfter = opts?.sigkillAfterMs ?? GIT_SUBPROCESS_SIGKILL_ESCALATION_MS;

    if (!opts?.holdStdin) {
      child.stdin?.end();
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    function escalateKill() {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      if (sigkillTimer !== undefined) return;
      sigkillTimer = setTimeout(() => {
        sigkillTimer = undefined;
        try {
          if (!settled && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        } catch {
          /* already dead */
        }
      }, sigkillAfter);
      // Do not keep the process alive solely for SIGKILL escalation.
      if (typeof sigkillTimer === "object" && "unref" in sigkillTimer) {
        sigkillTimer.unref();
      }
    }

    function onChunk(stream: "stdout" | "stderr", chunk: string) {
      const byteLen = Buffer.byteLength(chunk, "utf8");
      if (stream === "stdout") {
        stdoutBytes += byteLen;
        stdout += chunk;
      } else {
        stderrBytes += byteLen;
        stderr += chunk;
      }
      if (stdoutBytes + stderrBytes > maxBuffer) {
        escalateKill();
        settle({
          ok: false,
          stdout,
          stderr: `${stderr}\n<git output exceeded ${maxBuffer} bytes>`,
          truncated: true,
        });
      }
    }

    child.stdout?.on("data", (c: string) => {
      onChunk("stdout", c);
    });
    child.stderr?.on("data", (c: string) => {
      onChunk("stderr", c);
    });

    const effectiveTimeout = opts?.timeoutMs ?? GIT_SUBPROCESS_TIMEOUT_MS;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    function cleanup() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (sigkillTimer !== undefined) {
        clearTimeout(sigkillTimer);
        sigkillTimer = undefined;
      }
      if (abortListener !== undefined && opts?.signal) {
        opts.signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
      try {
        child.stdin?.destroy();
      } catch {
        /* ignore */
      }
    }

    function settle(result: SpawnGitResult) {
      if (settled) return;
      settled = true;
      cleanup();
      resolveP(result);
    }

    // Register lifecycle handlers before any early kill so close/error are observed.
    child.on("error", () => settle({ ok: false, stdout, stderr }));
    child.on("close", (code) => settle({ ok: code === 0, stdout, stderr }));

    // AbortSignal: kill immediately if already aborted, else listen
    if (opts?.signal) {
      if (opts.signal.aborted) {
        escalateKill();
        settle({ ok: false, stdout, stderr, aborted: true });
        return;
      }
      abortListener = () => {
        escalateKill();
        settle({ ok: false, stdout, stderr, aborted: true });
      };
      opts.signal.addEventListener("abort", abortListener, { once: true });
    }

    // Timeout: set timer if effectiveTimeout > 0
    if (effectiveTimeout > 0) {
      timer = setTimeout(() => {
        escalateKill();
        settle({
          ok: false,
          stdout,
          stderr: `${stderr}\n<git timed out after ${effectiveTimeout}ms>`,
          timedOut: true,
        });
      }, effectiveTimeout);
    }
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
