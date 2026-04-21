import { spawnGitAsync } from "./git.js";

// ---------------------------------------------------------------------------
// Merge conflict helpers (shared between git_merge and git_cherry_pick)
// ---------------------------------------------------------------------------

/** Paths with unresolved merge conflicts (`--diff-filter=U`). */
export async function conflictPaths(gitTop: string): Promise<string[]> {
  const r = await spawnGitAsync(gitTop, ["diff", "--name-only", "--diff-filter=U"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Protected branch names — never auto-delete, never cascade destructive ops onto
// ---------------------------------------------------------------------------

const PROTECTED_EXACT = new Set([
  "main",
  "master",
  "dev",
  "develop",
  "stable",
  "trunk",
  "prod",
  "production",
  "HEAD",
]);

const PROTECTED_PATTERN = /^(release|hotfix)[-/].+$/i;

/** True when a branch name is on the protected list and must not be auto-deleted. */
export function isProtectedBranch(name: string): boolean {
  const t = name.trim();
  if (t === "") return true;
  if (PROTECTED_EXACT.has(t)) return true;
  return PROTECTED_PATTERN.test(t);
}

// ---------------------------------------------------------------------------
// Ref/branch name validation (argv-safe subset of git's ref-format rules)
// ---------------------------------------------------------------------------

/**
 * Conservative check for branch/ref names passed to git argv.
 * Rejects anything outside the ASCII subset `A-Z a-z 0-9 _ . / + -`,
 * sequences git itself rejects (`..`, `@{`, leading `-`, trailing `.lock`/`/`),
 * and pathological tokens.
 */
export function isSafeGitRefToken(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 256) return false;
  if (t.startsWith("-")) return false;
  if (t.endsWith("/") || t.endsWith(".lock") || t.endsWith(".")) return false;
  if (t.includes("..")) return false;
  if (t.includes("@{")) return false;
  if (t.includes("//")) return false;
  return /^[A-Za-z0-9_./+-]+$/.test(t);
}

/**
 * Same as `isSafeGitRefToken` but also allows `~N` / `^N` ancestor notation used
 * by `git reset --soft HEAD~3`. Permits `~` and `^` suffix characters.
 */
export function isSafeGitAncestorRef(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 256) return false;
  if (t.startsWith("-")) return false;
  return /^[A-Za-z0-9_./+~^-]+$/.test(t);
}

/**
 * Same as `isSafeGitRefToken` but also allows the `A..B` / `A...B` range forms
 * used by `git log` / `git cherry-pick`. Splits once and validates each side.
 */
export function isSafeGitRangeToken(s: string): boolean {
  const t = s.trim();
  if (t.includes("...")) {
    const parts = t.split("...");
    return parts.length === 2 && parts.every((p) => isSafeGitRefToken(p));
  }
  if (t.includes("..")) {
    const parts = t.split("..");
    return parts.length === 2 && parts.every((p) => isSafeGitRefToken(p));
  }
  return isSafeGitRefToken(t);
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/** Current branch name; `null` if detached HEAD. */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const r = await spawnGitAsync(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!r.ok) return null;
  const name = r.stdout.trim();
  return name === "" ? null : name;
}

/** Resolve a ref to its full SHA; `null` if unknown. */
export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  if (!isSafeGitRefToken(ref)) return null;
  const r = await spawnGitAsync(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!r.ok) return null;
  const sha = r.stdout.trim();
  return sha === "" ? null : sha;
}

/** Working tree clean (no staged, no unstaged, no untracked). */
export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const r = await spawnGitAsync(cwd, ["status", "--porcelain"]);
  if (!r.ok) return false;
  return r.stdout.trim() === "";
}

/** True when every commit on `branch` is reachable from `target`. */
export async function isFullyMergedInto(
  cwd: string,
  branch: string,
  target: string,
): Promise<boolean> {
  if (!isSafeGitRefToken(branch) || !isSafeGitRefToken(target)) return false;
  const r = await spawnGitAsync(cwd, ["merge-base", "--is-ancestor", branch, target]);
  return r.ok;
}

/**
 * SHAs of commits in `exclude..include`, oldest-first (cherry-pick feed order).
 * Returns `null` on git failure.
 */
export async function commitListBetween(
  cwd: string,
  excludeRef: string,
  includeRef: string,
): Promise<string[] | null> {
  if (!isSafeGitRefToken(excludeRef) || !isSafeGitRefToken(includeRef)) return null;
  const r = await spawnGitAsync(cwd, ["rev-list", "--reverse", `${excludeRef}..${includeRef}`]);
  if (!r.ok) return null;
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Worktree lookup
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
}

/** Parse `git worktree list --porcelain` into structured entries. */
export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const r = await spawnGitAsync(cwd, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path)
        out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? null });
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      // e.g. `branch refs/heads/foo`
      const ref = line.slice("branch ".length).trim();
      cur.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "detached") {
      cur.branch = null;
    }
  }
  if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? null });
  return out;
}

/** Path of the worktree currently checked out on `branch`; `null` if none. */
export async function worktreeForBranch(cwd: string, branch: string): Promise<string | null> {
  const trees = await listWorktrees(cwd);
  const hit = trees.find((t) => t.branch === branch);
  return hit?.path ?? null;
}

// ---------------------------------------------------------------------------
// Push helpers
// ---------------------------------------------------------------------------

/**
 * Probe `@{u}` and extract the remote name from the tracking ref.
 * Returns an error payload when no upstream is configured.
 */
export async function inferRemoteFromUpstream(
  cwd: string,
): Promise<{ ok: true; remote: string; upstream: string } | { ok: false; detail: string }> {
  const r = await spawnGitAsync(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!r.ok) return { ok: false, detail: (r.stderr || r.stdout).trim() };
  const upstream = r.stdout.trim();
  const slash = upstream.indexOf("/");
  const remote = slash > 0 ? upstream.slice(0, slash) : "origin";
  return { ok: true, remote, upstream };
}
