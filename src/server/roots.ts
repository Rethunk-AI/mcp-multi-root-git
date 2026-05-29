import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastMCP } from "fastmcp";

import { ERROR_CODES } from "./error-codes.js";
import { gateGit, gitTopLevel } from "./git.js";
import { loadPresetsFromGitTop, presetLoadErrorPayload } from "./presets.js";
import { MAX_ABSOLUTE_GIT_ROOTS } from "./schemas.js";

function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function listFileRoots(server: FastMCP): string[] {
  const sessions = server.sessions;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    for (const root of session.roots ?? []) {
      const p = uriToPath(root.uri);
      if (!p || seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}

/** Basename or trailing path segment; compares using normalized slashes so Windows backslashes match. */
function pathMatchesWorkspaceRootHint(rootPath: string, hint: string): boolean {
  const h = hint.trim();
  if (!h) return true;
  const absRoot = resolve(rootPath);
  const normRoot = absRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normHint = h.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/+/, "");
  if (!normHint) return true;
  if (normRoot === normHint) return true;
  if (normRoot.endsWith(`/${normHint}`)) return true;
  return basename(rootPath) === h;
}

type RootPick = {
  workspaceRoot?: string;
  rootIndex?: number;
  allWorkspaceRoots?: boolean;
  absoluteGitRoots?: string[];
};

/** Workspace pick args including optional `absoluteGitRoots` (same shape as tool args). */
export type GitRootPickArgs = RootPick;

type ResolveRootsResult =
  | { ok: true; roots: string[] }
  | { ok: false; error: Record<string, unknown> };

function hasExclusiveWorkspacePick(args: RootPick): boolean {
  if (args.workspaceRoot?.trim()) return true;
  if (args.rootIndex != null) return true;
  if (args.allWorkspaceRoots === true) return true;
  return false;
}

/**
 * Resolve `absoluteGitRoots` to unique git toplevels (stable order, first occurrence wins).
 */
export function resolveAbsoluteGitRootsList(raw: string[]): ResolveRootsResult {
  if (raw.length > MAX_ABSOLUTE_GIT_ROOTS) {
    return {
      ok: false,
      error: {
        error: ERROR_CODES.ABSOLUTE_GIT_ROOTS_TOO_MANY,
        max: MAX_ABSOLUTE_GIT_ROOTS,
        count: raw.length,
      },
    };
  }
  const seen = new Set<string>();
  const tops: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: { error: ERROR_CODES.INVALID_ABSOLUTE_GIT_ROOT, path: item } };
    }
    const abs = resolve(trimmed);
    const top = gitTopLevel(abs);
    if (!top) {
      return { ok: false, error: { error: ERROR_CODES.INVALID_ABSOLUTE_GIT_ROOT, path: abs } };
    }
    if (seen.has(top)) continue;
    seen.add(top);
    tops.push(top);
  }
  if (tops.length === 0) {
    return { ok: false, error: { error: ERROR_CODES.ABSOLUTE_GIT_ROOTS_EMPTY } };
  }
  return { ok: true, roots: tops };
}

function resolveWorkspaceRoots(server: FastMCP, args: RootPick): ResolveRootsResult {
  if (args.workspaceRoot?.trim()) {
    return { ok: true, roots: [resolve(args.workspaceRoot.trim())] };
  }
  const fileRoots = listFileRoots(server);
  const fallback: ResolveRootsResult = { ok: true, roots: [process.cwd()] };
  if (args.allWorkspaceRoots) {
    return fileRoots.length === 0 ? fallback : { ok: true, roots: fileRoots };
  }
  if (args.rootIndex != null) {
    const r = fileRoots[args.rootIndex];
    if (!r) {
      return {
        ok: false,
        error: {
          error: ERROR_CODES.ROOT_INDEX_OUT_OF_RANGE,
          rootIndex: args.rootIndex,
          rootCount: fileRoots.length,
        },
      };
    }
    return { ok: true, roots: [r] };
  }
  const primary = fileRoots[0];
  return primary !== undefined ? { ok: true, roots: [primary] } : fallback;
}

/**
 * When a preset name is requested and multiple MCP roots exist, pick the first root
 * whose git toplevel loads a preset file containing that name.
 */
function resolveRootsForPreset(
  server: FastMCP,
  args: RootPick,
  presetName: string,
): ResolveRootsResult {
  if (args.workspaceRoot?.trim() || args.allWorkspaceRoots || args.rootIndex != null) {
    return resolveWorkspaceRoots(server, args);
  }
  const fileRoots = listFileRoots(server);
  if (fileRoots.length <= 1) {
    return resolveWorkspaceRoots(server, args);
  }
  const matches: string[] = [];
  for (const r of fileRoots) {
    const top = gitTopLevel(r);
    if (!top) continue;
    const loaded = loadPresetsFromGitTop(top);
    if (!loaded.ok && loaded.reason !== "missing") {
      return { ok: false, error: presetLoadErrorPayload(top, loaded) };
    }
    if (!loaded.ok) continue;
    const entry = loaded.data[presetName];
    if (!entry) continue;
    const hint = entry.workspaceRootHint?.trim();
    if (hint) {
      if (!pathMatchesWorkspaceRootHint(r, hint)) continue;
    }
    matches.push(r);
  }
  const pick = matches[0];
  if (pick !== undefined) {
    return { ok: true, roots: [pick] };
  }
  return resolveWorkspaceRoots(server, args);
}

type GitAndRootsResult =
  | { ok: true; roots: string[] }
  | { ok: false; error: Record<string, unknown> };

/** `gateGit` plus workspace / preset root resolution; shared tool and resource prelude. */
export function requireGitAndRoots(
  server: FastMCP,
  args: RootPick,
  presetName: string | undefined,
): GitAndRootsResult {
  const gg = gateGit();
  if (!gg.ok) {
    return { ok: false, error: gg.body };
  }

  const abs = args.absoluteGitRoots;
  if (abs != null && abs.length > 0) {
    if (presetName) {
      return { ok: false, error: { error: ERROR_CODES.ABSOLUTE_GIT_ROOTS_PRESET_CONFLICT } };
    }
    if (hasExclusiveWorkspacePick(args)) {
      return { ok: false, error: { error: ERROR_CODES.ABSOLUTE_GIT_ROOTS_EXCLUSIVE } };
    }
    return resolveAbsoluteGitRootsList(abs);
  }

  const rootsRes = presetName
    ? resolveRootsForPreset(server, args, presetName)
    : resolveWorkspaceRoots(server, args);
  if (!rootsRes.ok) {
    return { ok: false, error: rootsRes.error };
  }
  return { ok: true, roots: rootsRes.roots };
}

type SingleRepoResult =
  | { ok: true; gitTop: string }
  | { ok: false; error: Record<string, unknown> };

/**
 * Convenience wrapper for single-repo tools: gate git, resolve roots, pick the first
 * root, and resolve its git toplevel. Returns `{ ok: true, gitTop }` or a structured
 * error payload ready for `jsonRespond`.
 */
export function requireSingleRepo(
  server: FastMCP,
  args: RootPick,
  presetName: string | undefined = undefined,
): SingleRepoResult {
  const pre = requireGitAndRoots(server, args, presetName);
  if (!pre.ok) return pre;
  if (args.absoluteGitRoots != null && args.absoluteGitRoots.length > 0 && pre.roots.length !== 1) {
    return {
      ok: false,
      error: {
        error: ERROR_CODES.ABSOLUTE_GIT_ROOTS_SINGLE_REPO_ONLY,
        rootCount: pre.roots.length,
      },
    };
  }
  const rootInput = pre.roots[0];
  if (!rootInput) return { ok: false, error: { error: ERROR_CODES.NO_WORKSPACE_ROOT } };
  const top = gitTopLevel(rootInput);
  if (!top)
    return { ok: false, error: { error: ERROR_CODES.NOT_A_GIT_REPOSITORY, path: rootInput } };
  return { ok: true, gitTop: top };
}
