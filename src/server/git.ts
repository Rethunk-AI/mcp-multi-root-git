import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
// Function-body-level usage only — a benign circular import edge with
// git-refs.ts (which does not import from this module at module-eval time).
import { isSafeGitRefToken } from "./git-refs.js";

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
// Environment allowlist for git subprocesses
// ---------------------------------------------------------------------------

/**
 * Ambient env vars always forwarded to git child processes. Everything else
 * ambient is dropped — including other `GIT_*` vars such as `GIT_DIR`,
 * `GIT_WORK_TREE`, and `GIT_INDEX_FILE`, which would otherwise let ambient
 * process env smuggle a different repo/index context into a call the caller
 * believes targets `cwd`. Explicit per-call `SpawnGitOpts.env` always merges
 * on top of this filtered base. Extend via `RETHUNK_GIT_ENV_PASSTHROUGH`
 * (comma-separated names) rather than widening this list.
 */
const GIT_ENV_ALLOWLIST_EXACT: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_TERMINAL_PROMPT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
]);

function parseGitEnvPassthroughNames(envValue: string | undefined): ReadonlySet<string> {
  if (!envValue) return new Set();
  return new Set(
    envValue
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function isAllowlistedGitEnvName(name: string, extra: ReadonlySet<string>): boolean {
  return name.startsWith("LC_") || GIT_ENV_ALLOWLIST_EXACT.has(name) || extra.has(name);
}

/**
 * Build the filtered base env passed to every git child process: the fixed
 * allowlist plus any `RETHUNK_GIT_ENV_PASSTHROUGH` names, copied from
 * `ambientEnv`. Exported for tests; production call sites use the defaults
 * (real `process.env` / `process.env.RETHUNK_GIT_ENV_PASSTHROUGH`).
 */
export function buildFilteredGitEnv(
  ambientEnv: NodeJS.ProcessEnv = process.env,
  passthroughEnvValue: string | undefined = process.env.RETHUNK_GIT_ENV_PASSTHROUGH,
): Record<string, string> {
  const extra = parseGitEnvPassthroughNames(passthroughEnvValue);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambientEnv)) {
    if (value === undefined) continue;
    if (isAllowlistedGitEnvName(name, extra)) out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git on PATH (lazy probe)
// ---------------------------------------------------------------------------

type GitPathState = "unknown" | "ok" | "missing";

let gitPathState: GitPathState = "unknown";

const GIT_NOT_FOUND_BODY: Record<string, unknown> = {
  error: ERROR_CODES.GIT_NOT_FOUND,
};

/** How long a "missing" verdict is trusted before gateGit re-probes git on PATH (ms). */
export const GIT_MISSING_RECHECK_MS = 30_000;

let gitMissingAt = 0;

/** Test-only: reset the cached git-on-PATH probe. */
export function resetGitPathStateForTests(): void {
  gitPathState = "unknown";
  gitMissingAt = 0;
}

export interface GitVersionProbeResult {
  error?: NodeJS.ErrnoException;
  status: number | null;
}

function probeGitVersionSync(): GitVersionProbeResult {
  const r = spawnSync("git", ["--version"], {
    encoding: "utf8",
    timeout: GIT_SYNC_TIMEOUT_MS,
    env: buildFilteredGitEnv(),
  });
  return { error: r.error as NodeJS.ErrnoException | undefined, status: r.status };
}

export function gateGit(
  /** Test-only override — production callers always use the real spawnSync probe. */
  probe: () => GitVersionProbeResult = probeGitVersionSync,
): { ok: true } | { ok: false; body: Record<string, unknown> } {
  if (gitPathState === "ok") {
    return { ok: true };
  }
  if (gitPathState === "missing" && Date.now() - gitMissingAt < GIT_MISSING_RECHECK_MS) {
    return {
      ok: false,
      body: GIT_NOT_FOUND_BODY,
    };
  }
  const r = probe();
  if (r.error || r.status !== 0) {
    // Do not cache "missing" on timeout — a wedged git may recover.
    const timedOut = r.error !== undefined && r.error.code === "ETIMEDOUT";
    if (!timedOut) {
      gitPathState = "missing";
      gitMissingAt = Date.now();
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

/**
 * Sync git-toplevel probe. Kept alongside {@link gitTopLevelAsync} because
 * out-of-fence callers (`presets.ts`, `git-log-tool.ts`) still call this
 * synchronously — see git.ts change notes for the async fan-out paths.
 */
export function gitTopLevel(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: GIT_SYNC_TIMEOUT_MS,
    env: buildFilteredGitEnv(),
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim();
}

/**
 * Async twin of {@link gitTopLevel}, built on {@link spawnGitAsync} — does not
 * block the event loop. `opts` (e.g. `timeoutMs`) forwards straight through
 * to `spawnGitAsync`; production callers normally omit it (falls back to
 * `GIT_SUBPROCESS_TIMEOUT_MS`), tests use it to shrink the timeout for a
 * deliberately-hanging repo.
 */
export async function gitTopLevelAsync(cwd: string, opts?: SpawnGitOpts): Promise<string | null> {
  const r = await spawnGitAsync(cwd, ["rev-parse", "--show-toplevel"], opts);
  if (!r.ok) return null;
  return r.stdout.trim();
}

/** Async, non-blocking replacement for the former sync `gitRevParseGitDir` (no remaining sync callers). */
export async function gitRevParseGitDirAsync(cwd: string, opts?: SpawnGitOpts): Promise<boolean> {
  const r = await spawnGitAsync(cwd, ["rev-parse", "--git-dir"], opts);
  return r.ok;
}

/** Async, non-blocking replacement for the former sync `gitRevParseHead` (no remaining sync callers). */
export async function gitRevParseHeadAsync(
  cwd: string,
  opts?: SpawnGitOpts,
): Promise<{ ok: boolean; sha?: string; text: string }> {
  const r = await spawnGitAsync(cwd, ["rev-parse", "HEAD"], opts);
  if (!r.ok) {
    return { ok: false, text: (r.stderr || r.stdout || "git rev-parse HEAD failed").trim() };
  }
  return { ok: true, sha: r.stdout.trim(), text: r.stdout.trim() };
}

/**
 * Per-tool-invocation memoization for {@link gitTopLevelAsync}, keyed by
 * `cwd`. Create one instance per tool `execute()` call — never module-scope
 * — so repeated toplevel lookups for the same path within one call collapse
 * to a single subprocess, with no cross-call staleness.
 */
export function createTopLevelMemo(): (cwd: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (cwd: string) => {
    let p = cache.get(cwd);
    if (p === undefined) {
      p = gitTopLevelAsync(cwd);
      cache.set(cwd, p);
    }
    return p;
  };
}

/** Per-tool-invocation memoization for {@link gitRevParseHeadAsync}, keyed by `cwd`. See {@link createTopLevelMemo}. */
export function createRevParseHeadMemo(): (
  cwd: string,
) => Promise<{ ok: boolean; sha?: string; text: string }> {
  const cache = new Map<string, Promise<{ ok: boolean; sha?: string; text: string }>>();
  return (cwd: string) => {
    let p = cache.get(cwd);
    if (p === undefined) {
      p = gitRevParseHeadAsync(cwd);
      cache.set(cwd, p);
    }
    return p;
  };
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

/**
 * Conservative checks for remote/branch strings passed into git rev-parse /
 * rev-list argv. Delegates to isSafeGitRefToken's full guard set (leading
 * `-`/`+`, `..`, `.lock` suffix, `//`, `@{`, trailing `/`/`.`, whitespace,
 * shell metacharacters), plus one upstream-specific allowance: the literal
 * `@{u}` shorthand (a trusted constant passed by internal callers, not
 * user-controlled input).
 */
export function isSafeGitUpstreamToken(s: string): boolean {
  const t = s.trim();
  if (t === "@{u}") return true;
  return isSafeGitRefToken(t);
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
  /**
   * Explicit env vars for this call — merged ON TOP of the filtered ambient
   * base (see `buildFilteredGitEnv`), so callers (and tests) can still inject
   * e.g. `GIT_AUTHOR_*` / `GIT_CONFIG_*` even though ambient env is no longer
   * passed through wholesale.
   */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Orphan reaper — kills spawnGitAsync children left running on abrupt shutdown
// (the SIGKILL escalation timer is unref'd, so it does not by itself keep a
// child from being orphaned if the parent process exits first).
// ---------------------------------------------------------------------------

const liveGitChildren = new Set<ChildProcess>();

function reapLiveGitChildren(): void {
  for (const child of liveGitChildren) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    } catch {
      /* already dead */
    }
  }
}

/** Test-only: run the orphan-reaper's kill sweep directly, without a real process exit/signal. */
export function reapOrphanedGitChildrenForTests(): void {
  reapLiveGitChildren();
}

let orphanReaperInstalled = false;

function installOrphanReaper(): void {
  if (orphanReaperInstalled) return;
  orphanReaperInstalled = true;
  process.once("exit", reapLiveGitChildren);
  process.once("SIGTERM", () => {
    reapLiveGitChildren();
    process.exit(143);
  });
  process.once("SIGINT", () => {
    reapLiveGitChildren();
    process.exit(130);
  });
}

installOrphanReaper();

export function spawnGitAsync(
  cwd: string,
  args: string[],
  opts?: SpawnGitOpts,
): Promise<SpawnGitResult> {
  return new Promise((resolveP) => {
    const childEnv = opts?.env ? { ...buildFilteredGitEnv(), ...opts.env } : buildFilteredGitEnv();
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv });
    liveGitChildren.add(child);
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
      // Once settled (timeout/kill/abort/overflow), stop accumulating —
      // the resolved result already captured its snapshot of stdout/stderr.
      if (settled) return;
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
      liveGitChildren.delete(child);
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
    child.on("error", (err) => {
      // Surface the real Node spawn error (e.g. ENOENT: no git on PATH vs
      // EACCES: not executable) instead of silently discarding it — stdout/
      // stderr are typically empty here since the process never ran.
      const nodeErr = err as NodeJS.ErrnoException;
      const detail = nodeErr.code ? `${nodeErr.code}: ${nodeErr.message}` : nodeErr.message;
      settle({ ok: false, stdout, stderr: stderr ? `${stderr}\n${detail}` : detail });
    });
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
  // Fail closed on its own — do not rely solely on callers to pre-validate
  // upstreamSpec before it is interpolated into rev-list range argv.
  if (!isSafeGitUpstreamToken(upstreamSpec)) {
    return { ahead: null, behind: null };
  }
  const aheadR = await spawnGitAsync(absPath, ["rev-list", "--count", `${upstreamSpec}..HEAD`]);
  const behindR = await spawnGitAsync(absPath, ["rev-list", "--count", `HEAD..${upstreamSpec}`]);
  return {
    ahead: aheadR.ok ? aheadR.stdout.trim() : null,
    behind: behindR.ok ? behindR.stdout.trim() : null,
  };
}
