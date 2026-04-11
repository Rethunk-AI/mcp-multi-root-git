import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Parallel git subprocesses for inventory rows and git_status submodule rows. */
export const GIT_SUBPROCESS_PARALLELISM = 4;

// ---------------------------------------------------------------------------
// Git on PATH (lazy probe)
// ---------------------------------------------------------------------------

type GitPathState = "unknown" | "ok" | "missing";

let gitPathState: GitPathState = "unknown";

const GIT_NOT_FOUND_BODY: Record<string, unknown> = {
  error: "git_not_found",
  message:
    "The `git` binary was not found on PATH or failed `git --version`. Install Git and ensure it is available to the MCP server process.",
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
  if (!existsSync(f)) return [];
  const text = readFileSync(f, "utf8");
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*path\s*=\s*(.+)\s*$/.exec(line);
    if (m?.[1]) paths.push(m[1].trim());
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
      results[i] = await fn(items[i]!);
    }
  }
  const n = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function spawnGitAsync(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", () => resolveP({ ok: false, stdout, stderr }));
    child.on("close", (code) => resolveP({ ok: code === 0, stdout, stderr }));
  });
}

function gitStatusFailText(r: { stderr: string; stdout: string }): string {
  return (r.stderr || r.stdout || "git status failed").trim();
}

export async function gitStatusSnapshotAsync(cwd: string): Promise<{
  branchLine: string;
  shortLine: string;
  branchOk: boolean;
  shortOk: boolean;
}> {
  const r = await spawnGitAsync(cwd, ["status", "--short", "-b"]);
  if (!r.ok) {
    const text = gitStatusFailText(r);
    return { branchOk: false, shortOk: false, branchLine: text, shortLine: text };
  }
  const full = r.stdout.trimEnd();
  const nl = full.indexOf("\n");
  const branchLine = full;
  const shortLine = nl >= 0 ? full.slice(nl + 1) : "";
  return { branchOk: true, shortOk: true, branchLine, shortLine };
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
