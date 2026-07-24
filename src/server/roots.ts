import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastMCP } from "fastmcp";

import { ERROR_CODES } from "./error-codes.js";
import { gateGit, gitTopLevel } from "./git.js";
import { loadPresetsFromGitTop } from "./presets.js";
import { MAX_ROOT_PATHS } from "./schemas.js";

function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * File roots for the current call. When `sessionId` matches a live session
 * (HTTP transports), scope to just that session's roots; otherwise (stdio,
 * or no matching session found) fall back to the prior aggregate-across-all-
 * sessions behavior.
 */
function listFileRoots(server: FastMCP, sessionId?: string): string[] {
  const allSessions = server.sessions;
  const scoped = sessionId ? allSessions.filter((s) => s.sessionId === sessionId) : [];
  const sessions = scoped.length > 0 ? scoped : allSessions;
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
  // Last resort: compare against the normalized hint too, so a trailing
  // slash/backslash on a single-segment hint (e.g. "myrepo/") still matches.
  return basename(rootPath) === normHint;
}

/**
 * Fan-out tool routing args. `root` is polymorphic:
 * - string   → single repo path
 * - string[] → explicit list of repo paths (sibling clones)
 * - "*"      → every `file://` MCP root
 * - omitted  → preset-aware default (first MCP root / cwd)
 */
export type RootPickArgs = { root?: string | string[] };

type ResolveRootsResult =
  | { ok: true; roots: string[]; warning?: Record<string, unknown> }
  | { ok: false; error: Record<string, unknown> };

/**
 * Resolve an explicit `root` path array to unique git toplevels
 * (stable order, first occurrence wins).
 */
export function resolveRootPathList(raw: string[]): ResolveRootsResult {
  if (raw.length > MAX_ROOT_PATHS) {
    return {
      ok: false,
      error: {
        error: ERROR_CODES.ROOT_LIST_TOO_MANY,
        max: MAX_ROOT_PATHS,
        count: raw.length,
      },
    };
  }
  const seen = new Set<string>();
  const tops: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: { error: ERROR_CODES.INVALID_ROOT_PATH, path: item } };
    }
    const abs = resolve(trimmed);
    const top = gitTopLevel(abs);
    if (!top) {
      return { ok: false, error: { error: ERROR_CODES.INVALID_ROOT_PATH, path: abs } };
    }
    if (seen.has(top)) continue;
    seen.add(top);
    tops.push(top);
  }
  if (tops.length === 0) {
    return { ok: false, error: { error: ERROR_CODES.ROOT_LIST_EMPTY } };
  }
  return { ok: true, roots: tops };
}

/** Default when `root` is omitted: first MCP file root, else cwd. */
function defaultRoots(fileRoots: string[]): ResolveRootsResult {
  const primary = fileRoots[0];
  return { ok: true, roots: [primary ?? process.cwd()] };
}

/**
 * When a preset name is requested and multiple MCP roots exist, pick the first root
 * whose git toplevel loads a preset file containing that name.
 *
 * A root whose preset file is missing or fails to parse never aborts this search —
 * it may simply be irrelevant to this preset name — it is just skipped in favor of
 * the remaining candidates. When a matching preset entry exists but its
 * `workspaceRootHint` fails to match any candidate root, the silent fallback to
 * `defaultRoots` is annotated with an explicit `warning` instead of looking
 * identical to "preset not found anywhere".
 */
function resolveRootsForPreset(
  server: FastMCP,
  presetName: string,
  sessionId?: string,
): ResolveRootsResult {
  const fileRoots = listFileRoots(server, sessionId);
  if (fileRoots.length <= 1) {
    return defaultRoots(fileRoots);
  }
  const matches: string[] = [];
  let hintMismatch: { hint: string } | undefined;
  for (const r of fileRoots) {
    const top = gitTopLevel(r);
    if (!top) continue;
    const loaded = loadPresetsFromGitTop(top);
    if (!loaded.ok) continue;
    const entry = loaded.data[presetName];
    if (!entry) continue;
    const hint = entry.workspaceRootHint?.trim();
    if (hint && !pathMatchesWorkspaceRootHint(r, hint)) {
      hintMismatch = { hint };
      continue;
    }
    matches.push(r);
  }
  const pick = matches[0];
  if (pick !== undefined) {
    return { ok: true, roots: [pick] };
  }
  const fallback = defaultRoots(fileRoots);
  if (fallback.ok && hintMismatch) {
    return {
      ok: true,
      roots: fallback.roots,
      warning: {
        code: "workspace_root_hint_mismatch",
        preset: presetName,
        hint: hintMismatch.hint,
      },
    };
  }
  return fallback;
}

type GitAndRootsResult =
  | { ok: true; roots: string[]; warning?: Record<string, unknown> }
  | { ok: false; error: Record<string, unknown> };

/**
 * `gateGit` plus `root` resolution; shared fan-out tool and resource prelude.
 * `sessionId` (from the tool's `Context.sessionId`, HTTP transports only) scopes
 * `"*"` / omitted-root MCP-file-root lookups to the calling session when known.
 */
export function requireGitAndRoots(
  server: FastMCP,
  args: RootPickArgs,
  presetName: string | undefined,
  sessionId?: string,
): GitAndRootsResult {
  const gg = gateGit();
  if (!gg.ok) {
    return { ok: false, error: gg.body };
  }

  const root = args.root;
  if (Array.isArray(root)) {
    if (presetName) {
      return { ok: false, error: { error: ERROR_CODES.ROOT_LIST_PRESET_CONFLICT } };
    }
    return resolveRootPathList(root);
  }

  const trimmed = root?.trim();
  if (trimmed === "*") {
    const fileRoots = listFileRoots(server, sessionId);
    if (fileRoots.length === 0) return defaultRoots(fileRoots);
    if (fileRoots.length > MAX_ROOT_PATHS) {
      return {
        ok: false,
        error: {
          error: ERROR_CODES.ROOT_LIST_TOO_MANY,
          max: MAX_ROOT_PATHS,
          count: fileRoots.length,
        },
      };
    }
    // Same gitTopLevel resolution + Set dedup as resolveRootPathList, so two
    // nested/overlapping MCP file roots that share a git toplevel collapse
    // into one entry instead of double-counting the same repo.
    const seen = new Set<string>();
    const tops: string[] = [];
    for (const r of fileRoots) {
      const top = gitTopLevel(r) ?? r;
      if (seen.has(top)) continue;
      seen.add(top);
      tops.push(top);
    }
    return { ok: true, roots: tops };
  }
  if (trimmed) {
    return { ok: true, roots: [resolve(trimmed)] };
  }

  if (presetName) {
    return resolveRootsForPreset(server, presetName, sessionId);
  }
  return defaultRoots(listFileRoots(server, sessionId));
}

type SingleRepoResult =
  | { ok: true; gitTop: string }
  | { ok: false; error: Record<string, unknown> };

/**
 * Prelude for single-repo tools: gate git, resolve `workspaceRoot` (or the first
 * MCP root / cwd), and resolve its git toplevel. Returns `{ ok: true, gitTop }`
 * or a structured error payload ready for `jsonRespond`.
 */
export function requireSingleRepo(
  server: FastMCP,
  args: { workspaceRoot?: string },
  sessionId?: string,
): SingleRepoResult {
  const gg = gateGit();
  if (!gg.ok) {
    return { ok: false, error: gg.body };
  }
  const ws = args.workspaceRoot?.trim();
  const rootInput = ws ? resolve(ws) : (listFileRoots(server, sessionId)[0] ?? process.cwd());
  const top = gitTopLevel(rootInput);
  if (!top)
    return { ok: false, error: { error: ERROR_CODES.NOT_A_GIT_REPOSITORY, path: rootInput } };
  return { ok: true, gitTop: top };
}
