import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastMCP } from "fastmcp";

import { gateGit, gitTopLevel } from "./git.js";
import { loadPresetsFromGitTop, presetLoadErrorPayload } from "./presets.js";

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
  const roots = sessions[0]?.roots ?? [];
  const paths: string[] = [];
  for (const root of roots) {
    const p = uriToPath(root.uri);
    if (p) paths.push(p);
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
};

type ResolveRootsResult =
  | { ok: true; roots: string[] }
  | { ok: false; error: Record<string, unknown> };

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
          error: "root_index_out_of_range",
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
  const rootsRes = presetName
    ? resolveRootsForPreset(server, args, presetName)
    : resolveWorkspaceRoots(server, args);
  if (!rootsRes.ok) {
    return { ok: false, error: rootsRes.error };
  }
  return { ok: true, roots: rootsRes.roots };
}
