import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isErrno(err: unknown, codes: readonly string[]): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && codes.includes(code);
}

/**
 * Canonicalize for confinement: realpath the longest existing prefix, then
 * append any missing trailing segments lexically.
 *
 * Fail closed (`null`) when realpath fails for a reason other than a missing
 * path component (ENOENT/ENOTDIR), or when nothing on the chain resolves —
 * never return the unresolved input (avoids symlink+missing-leaf false-accept).
 */
function realpathForConfinement(absPath: string): string | null {
  const abs = resolve(absPath);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const resolved = realpathSync(cur);
      return missing.length === 0 ? resolved : join(resolved, ...missing);
    } catch (err) {
      if (!isErrno(err, ["ENOENT", "ENOTDIR"])) {
        return null;
      }
      const parent = dirname(cur);
      if (parent === cur) {
        return null;
      }
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** True when `relative(top, path)` is inside or equal to top (not `..` / `../…`). */
function isRelativeInsideTop(rel: string): boolean {
  if (rel === "") return true;
  // Exact `..` or `../` / `..\` only — do not treat a segment named `..foo` as escape.
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

export function isStrictlyUnderGitTop(absPath: string, gitTop: string): boolean {
  let topR: string;
  try {
    topR = realpathSync(resolve(gitTop));
  } catch {
    return false;
  }
  const absR = realpathForConfinement(absPath);
  if (absR === null) return false;
  return isRelativeInsideTop(relative(topR, absR));
}

export function resolvePathForRepo(p: string, gitTop: string): string {
  const t = p.trim();
  return isAbsolute(t) ? resolve(t) : resolve(gitTop, t);
}

/** Resolved path must lie inside git toplevel (relative or absolute user input). */
export function assertRelativePathUnderTop(
  userPath: string,
  absResolved: string,
  gitTop: string,
): boolean {
  // Use the caller-supplied path: reject mismatched abs vs resolvePathForRepo.
  if (resolvePathForRepo(userPath, gitTop) !== absResolved) {
    return false;
  }
  return isStrictlyUnderGitTop(absResolved, gitTop);
}
