import { execFileSync } from "node:child_process";

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
  "head",
]);

const PROTECTED_PATTERN = /^(release|hotfix)[-/].+$/i;

/** True when a branch name is on the protected list and must not be auto-deleted. */
export function isProtectedBranch(name: string): boolean {
  // Normalize: trim whitespace, strip leading refs/heads/ prefix, then lowercase.
  const trimmed = name.trim();
  if (trimmed === "") return true;
  const stripped = trimmed.startsWith("refs/heads/")
    ? trimmed.slice("refs/heads/".length)
    : trimmed;
  const normalized = stripped.toLowerCase();
  if (normalized === "") return true;
  if (PROTECTED_EXACT.has(normalized)) return true;
  return PROTECTED_PATTERN.test(normalized);
}

// ---------------------------------------------------------------------------
// Ref/branch name validation (argv-safe subset of git's ref-format rules)
// ---------------------------------------------------------------------------

/**
 * Conservative check for branch/ref names passed to git argv.
 * Rejects anything outside the ASCII subset `A-Z a-z 0-9 _ . / + -`,
 * sequences git itself rejects (`..`, `@{`, leading `-`, trailing `.lock`/`/`),
 * leading `+` (git force-refspec), and pathological tokens.
 */
export function isSafeGitRefToken(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 256) return false;
  // Leading `-` is a git option; leading `+` is a force-update refspec.
  if (t.startsWith("-") || t.startsWith("+")) return false;
  if (t.endsWith("/") || t.endsWith(".lock") || t.endsWith(".")) return false;
  if (t.includes("..")) return false;
  if (t.includes("@{")) return false;
  if (t.includes("//")) return false;
  return /^[A-Za-z0-9_./+-]+$/.test(t);
}

/**
 * Same as `isSafeGitCommitIsh` — trailing `~N` / `^N` ancestor notation used
 * by `git reset --soft HEAD~3`, plus the full `isSafeGitRefToken` base guards
 * (`..`, `.lock`, `//`, `@{`, leading `+/-`, etc.). Kept as a named export for
 * call sites that only need ancestor-capable single refs (not ranges).
 */
export function isSafeGitAncestorRef(s: string): boolean {
  return isSafeGitCommitIsh(s);
}

/**
 * Same as `isSafeGitRefToken`, but also accepts a trailing run of ancestor
 * operators (`~N` / `^N`, mixable and order-independent, e.g. `HEAD~3`,
 * `main^2`, `v1.0.0~2^1`) as used by commit-ish arguments to `git diff`,
 * `git blame`, and `git show`. The base name (everything before the first
 * ancestor operator) must itself pass `isSafeGitRefToken` — so all of that
 * function's guards (leading `-`/`+`, `..`, `.lock` suffix, `//`, `@{`,
 * whitespace, `:`, etc.) still apply. Ancestor operators are only permitted
 * as a trailing suffix run, not embedded mid-name (e.g. `a~b` is rejected).
 */
export function isSafeGitCommitIsh(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 256) return false;
  const suffixMatch = /(?:[~^][0-9]*)+$/.exec(t);
  const base = suffixMatch ? t.slice(0, suffixMatch.index) : t;
  if (base.length === 0) return false;
  return isSafeGitRefToken(base);
}

/**
 * Same as `isSafeGitRefToken` but also allows the `A..B` / `A...B` range forms
 * used by `git log` / `git cherry-pick` / `git_diff_summary`. Splits once and
 * validates each side (and the no-range single-ref fallthrough) with
 * `isSafeGitCommitIsh`, so ancestor notation (`HEAD~3`, `main^2`) is accepted
 * on either endpoint, e.g. `HEAD~3..HEAD` or `main...feature^2`.
 */
export function isSafeGitRangeToken(s: string): boolean {
  const t = s.trim();
  if (t.includes("...")) {
    const parts = t.split("...");
    return parts.length === 2 && parts.every((p) => isSafeGitCommitIsh(p));
  }
  if (t.includes("..")) {
    const parts = t.split("..");
    return parts.length === 2 && parts.every((p) => isSafeGitCommitIsh(p));
  }
  return isSafeGitCommitIsh(t);
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
 * Returns the git patch-id for a single commit, or undefined on failure.
 * Uses execFileSync to pipe `git diff-tree --patch -r <sha>` into `git patch-id --stable`.
 */
function commitPatchId(cwd: string, sha: string): string | undefined {
  try {
    const diff = execFileSync("git", ["diff-tree", "--patch", "-r", sha], {
      cwd,
      encoding: "utf8",
    });
    const out = execFileSync("git", ["patch-id", "--stable"], {
      cwd,
      encoding: "utf8",
      input: diff,
    });
    return out.trim().split(" ")[0] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when every commit reachable from `branch` but not from `target` has a
 * patch-equivalent commit already in `target` (content-equivalent merge check for
 * cherry-pick workflows where SHA differs but diff is identical).
 *
 * Falls back to ref-equality (`isFullyMergedInto`) when patch-id comparison fails.
 */
export async function isContentEquivalentlyMergedInto(
  cwd: string,
  branch: string,
  target: string,
): Promise<boolean> {
  if (!isSafeGitRefToken(branch) || !isSafeGitRefToken(target)) return false;

  // Fast path: ref equality (normal merge).
  const refMerged = await spawnGitAsync(cwd, ["merge-base", "--is-ancestor", branch, target]);
  if (refMerged.ok) return true;

  // Collect commits in branch not reachable from target.
  const srcList = await spawnGitAsync(cwd, ["rev-list", "--no-merges", `${branch}`, `^${target}`]);
  if (!srcList.ok) return false;
  const srcShas = srcList.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (srcShas.length === 0) return true; // nothing to check

  // Build patch-id set for target commits since merge-base.
  const base = await spawnGitAsync(cwd, ["merge-base", branch, target]);
  if (!base.ok) return false;
  const baseSha = base.stdout.trim();

  const destList = await spawnGitAsync(cwd, ["rev-list", "--no-merges", `${baseSha}..${target}`]);
  if (!destList.ok) return false;
  const destShas = destList.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const destPatchIds = new Set<string>();
  for (const sha of destShas) {
    const patchId = commitPatchId(cwd, sha);
    if (patchId) destPatchIds.add(patchId);
  }

  // Every source commit must have its patch-id present in destination.
  for (const sha of srcShas) {
    const patchId = commitPatchId(cwd, sha);
    if (!patchId || !destPatchIds.has(patchId)) return false;
  }

  return true;
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

/**
 * Parse `git worktree list --porcelain` into structured entries.
 * Returns `{ ok: false, detail }` when git fails — callers must not treat
 * failure as an empty worktree list.
 */
export async function listWorktrees(
  cwd: string,
): Promise<{ ok: true; worktrees: WorktreeEntry[] } | { ok: false; detail: string }> {
  const r = await spawnGitAsync(cwd, ["worktree", "list", "--porcelain"]);
  if (!r.ok) {
    return { ok: false, detail: (r.stderr || r.stdout).trim() || "git worktree list failed" };
  }
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
  return { ok: true, worktrees: out };
}

/**
 * Path of the worktree currently checked out on `branch`; `null` if none
 * or if listing worktrees failed (fail closed for destructive callers).
 */
export async function worktreeForBranch(cwd: string, branch: string): Promise<string | null> {
  const listed = await listWorktrees(cwd);
  if (!listed.ok) return null;
  const hit = listed.worktrees.find((t) => t.branch === branch);
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
