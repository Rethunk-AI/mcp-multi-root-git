import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastMCP } from "fastmcp";

import { ERROR_CODES } from "./error-codes.js";
import { gateGit, gitTopLevel } from "./git.js";
import { loadPresetsFromGitTop, presetLoadErrorPayload } from "./presets.js";
import { MAX_ROOT_PATHS } from "./schemas.js";

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

/**
 * Fan-out tool routing args. `root` is polymorphic:
 * - string   → single repo path
 * - string[] → explicit list of repo paths (sibling clones)
 * - "*"      → every `file://` MCP root
 * - omitted  → preset-aware default (first MCP root / cwd)
 */
export type RootPickArgs = { root?: string | string[] };

type ResolveRootsResult =
  | { ok: true; roots: string[] }
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
 */
function resolveRootsForPreset(server: FastMCP, presetName: string): ResolveRootsResult {
  const fileRoots = listFileRoots(server);
  if (fileRoots.length <= 1) {
    return defaultRoots(fileRoots);
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
  return defaultRoots(fileRoots);
}

type GitAndRootsResult =
  | { ok: true; roots: string[] }
  | { ok: false; error: Record<string, unknown> };

/** `gateGit` plus `root` resolution; shared fan-out tool and resource prelude. */
export function requireGitAndRoots(
  server: FastMCP,
  args: RootPickArgs,
  presetName: string | undefined,
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
    const fileRoots = listFileRoots(server);
    return fileRoots.length === 0 ? defaultRoots(fileRoots) : { ok: true, roots: fileRoots };
  }
  if (trimmed) {
    return { ok: true, roots: [resolve(trimmed)] };
  }

  if (presetName) {
    return resolveRootsForPreset(server, presetName);
  }
  return defaultRoots(listFileRoots(server));
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
): SingleRepoResult {
  const gg = gateGit();
  if (!gg.ok) {
    return { ok: false, error: gg.body };
  }
  const ws = args.workspaceRoot?.trim();
  const rootInput = ws ? resolve(ws) : (listFileRoots(server)[0] ?? process.cwd());
  const top = gitTopLevel(rootInput);
  if (!top)
    return { ok: false, error: { error: ERROR_CODES.NOT_A_GIT_REPOSITORY, path: rootInput } };
  return { ok: true, gitTop: top };
}
