import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function realPathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function isStrictlyUnderGitTop(absPath: string, gitTop: string): boolean {
  const absR = realPathOrSelf(resolve(absPath));
  const topR = realPathOrSelf(resolve(gitTop));
  const rel = relative(topR, absR);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function resolvePathForRepo(p: string, gitTop: string): string {
  const t = p.trim();
  return isAbsolute(t) ? resolve(t) : resolve(gitTop, t);
}

/** Resolved path must lie inside git toplevel (relative or absolute user input). */
export function assertRelativePathUnderTop(
  _relPath: string,
  absResolved: string,
  gitTop: string,
): boolean {
  return isStrictlyUnderGitTop(absResolved, gitTop);
}
