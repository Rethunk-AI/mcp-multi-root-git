#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FastMCP } from "fastmcp";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Package version (read from package.json next to dist/ or src/)
// ---------------------------------------------------------------------------

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  try {
    const j = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return j.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Preset file schema
// ---------------------------------------------------------------------------

/**
 * Schema for `.rethunk/git-mcp-presets.json` at the workspace root.
 * Each named entry defines roots for `git_inventory` and/or pairs for `git_parity`.
 */
const PresetEntrySchema = z.object({
  nestedRoots: z.array(z.string()).optional(),
  parityPairs: z
    .array(
      z.object({
        left: z.string(),
        right: z.string(),
        label: z.string().optional(),
      }),
    )
    .optional(),
  /** When multiple MCP file roots exist, prefer one whose path basename or suffix matches this hint. */
  workspaceRootHint: z.string().optional(),
});

const PresetFileSchema = z.record(z.string(), PresetEntrySchema);

type PresetEntry = z.infer<typeof PresetEntrySchema>;
type PresetFile = z.infer<typeof PresetFileSchema>;

const PRESET_FILE_PATH = ".rethunk/git-mcp-presets.json";

const MAX_INVENTORY_ROOTS_DEFAULT = 64;
/** Parallel git subprocesses for inventory rows and git_status submodule rows. */
const GIT_SUBPROCESS_PARALLELISM = 4;

const MCP_JSON_FORMAT_VERSION = "1" as const;

// ---------------------------------------------------------------------------
// Git on PATH (lazy probe)
// ---------------------------------------------------------------------------

type GitPathState = "unknown" | "ok" | "missing";

let gitPathState: GitPathState = "unknown";

function gateGit(): { ok: true } | { ok: false; body: Record<string, unknown> } {
  if (gitPathState === "ok") {
    return { ok: true };
  }
  if (gitPathState === "missing") {
    return {
      ok: false,
      body: {
        error: "git_not_found",
        message:
          "The `git` binary was not found on PATH or failed `git --version`. Install Git and ensure it is available to the MCP server process.",
      },
    };
  }
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (r.status !== 0) {
    gitPathState = "missing";
    return {
      ok: false,
      body: {
        error: "git_not_found",
        message:
          "The `git` binary was not found on PATH or failed `git --version`. Install Git and ensure it is available to the MCP server process.",
      },
    };
  }
  gitPathState = "ok";
  return { ok: true };
}

function jsonRespond(body: Record<string, unknown>): string {
  return JSON.stringify(
    {
      ...body,
      rethunkGitMcp: {
        jsonFormatVersion: MCP_JSON_FORMAT_VERSION,
        packageVersion: readPackageVersion(),
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Workspace / MCP roots
// ---------------------------------------------------------------------------

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
  if (basename(rootPath) === h) return true;
  const absRoot = resolve(rootPath);
  if (absRoot === h) return true;
  try {
    if (isAbsolute(h) && resolve(h) === absRoot) return true;
  } catch {
    /* invalid absolute hint */
  }
  const normRoot = absRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normHint = h.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/+/, "");
  if (!normHint) return true;
  if (normRoot === normHint) return true;
  return normRoot.endsWith(`/${normHint}`);
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
  if (args.allWorkspaceRoots) {
    if (fileRoots.length === 0) {
      return { ok: true, roots: [process.cwd()] };
    }
    return { ok: true, roots: fileRoots };
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
  if (primary !== undefined) {
    return { ok: true, roots: [primary] };
  }
  return { ok: true, roots: [process.cwd()] };
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

// ---------------------------------------------------------------------------
// Preset file loader
// ---------------------------------------------------------------------------

type PresetLoadFail =
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid_json"; message: string }
  | { ok: false; reason: "schema"; issues: z.ZodIssue[] };

type PresetLoadOk = { ok: true; data: PresetFile; schemaVersion?: string };

type PresetLoadResult = PresetLoadOk | PresetLoadFail;

/**
 * Supports:
 * - Wrapped: `{ "schemaVersion": "1", "presets": { "name": { ... } } }`
 * - Legacy: `{ "name": { ... }, ... }` with optional top-level `schemaVersion` / `$schema` (editor hints).
 */
function splitPresetFileRaw(raw: unknown): { mapRaw: unknown; schemaVersion?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid_root");
  }
  const o = raw as Record<string, unknown>;
  if (
    "presets" in o &&
    o.presets !== null &&
    typeof o.presets === "object" &&
    !Array.isArray(o.presets)
  ) {
    const sv = o.schemaVersion;
    return {
      mapRaw: o.presets,
      schemaVersion: typeof sv === "string" ? sv : undefined,
    };
  }
  const rest: Record<string, unknown> = { ...o };
  const sv = rest.schemaVersion;
  delete rest.schemaVersion;
  delete rest.$schema;
  return {
    mapRaw: rest,
    schemaVersion: typeof sv === "string" ? sv : undefined,
  };
}

function loadPresetsFromGitTop(gitTop: string): PresetLoadResult {
  const presetPath = join(gitTop, PRESET_FILE_PATH);
  if (!existsSync(presetPath)) {
    return { ok: false, reason: "missing" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(presetPath, "utf8")) as unknown;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "invalid_json", message };
  }
  let mapRaw: unknown;
  let schemaVersion: string | undefined;
  try {
    const s = splitPresetFileRaw(raw);
    mapRaw = s.mapRaw;
    schemaVersion = s.schemaVersion;
  } catch {
    return {
      ok: false,
      reason: "invalid_json",
      message: "Preset file root must be a JSON object",
    };
  }
  const parsed = PresetFileSchema.safeParse(mapRaw);
  if (!parsed.success) {
    return { ok: false, reason: "schema", issues: parsed.error.issues };
  }
  return { ok: true, data: parsed.data, schemaVersion };
}

function presetLoadErrorPayload(gitTop: string, fail: PresetLoadFail): Record<string, unknown> {
  const presetFile = join(gitTop, PRESET_FILE_PATH);
  if (fail.reason === "invalid_json") {
    return {
      error: "preset_file_invalid",
      kind: "invalid_json",
      presetFile,
      message: fail.message,
    };
  }
  if (fail.reason === "schema") {
    return { error: "preset_file_invalid", kind: "schema", presetFile, issues: fail.issues };
  }
  return { error: "preset_file_invalid", presetFile };
}

function getPresetEntry(
  gitTop: string,
  presetName: string,
): { entry: PresetEntry; presetSchemaVersion?: string } | { error: Record<string, unknown> } {
  const loaded = loadPresetsFromGitTop(gitTop);
  if (!loaded.ok) {
    if (loaded.reason === "missing") {
      return {
        error: {
          error: "preset_not_found",
          preset: presetName,
          presetFile: join(gitTop, PRESET_FILE_PATH),
          message: "Preset file missing",
        },
      };
    }
    return { error: presetLoadErrorPayload(gitTop, loaded) };
  }
  const entry = loaded.data[presetName];
  if (!entry) {
    return {
      error: {
        error: "preset_not_found",
        preset: presetName,
        presetFile: join(gitTop, PRESET_FILE_PATH),
      },
    };
  }
  return { entry, presetSchemaVersion: loaded.schemaVersion };
}

function mergeNestedRoots(
  preset: string[] | undefined,
  inline: string[] | undefined,
): string[] | undefined {
  const a = preset ?? [];
  const b = inline ?? [];
  if (a.length === 0 && b.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...a, ...b]) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function mergePairs<T extends { left: string; right: string; label?: string }>(
  preset: T[] | undefined,
  inline: T[] | undefined,
): T[] | undefined {
  const a = preset ?? [];
  const b = inline ?? [];
  if (a.length === 0 && b.length === 0) return undefined;
  return [...a, ...b];
}

// ---------------------------------------------------------------------------
// Path safety (relative paths must stay under git toplevel)
// ---------------------------------------------------------------------------

function realPathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isStrictlyUnderGitTop(absPath: string, gitTop: string): boolean {
  const absR = realPathOrSelf(resolve(absPath));
  const topR = realPathOrSelf(resolve(gitTop));
  const rel = relative(topR, absR);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function resolvePathForRepo(p: string, gitTop: string): string {
  const t = p.trim();
  return isAbsolute(t) ? resolve(t) : resolve(gitTop, t);
}

function assertRelativePathUnderTop(relPath: string, absResolved: string, gitTop: string): boolean {
  if (isAbsolute(relPath.trim())) {
    return true;
  }
  return isStrictlyUnderGitTop(absResolved, gitTop);
}

// ---------------------------------------------------------------------------
// Git helpers (sync — used where async batching not needed)
// ---------------------------------------------------------------------------

function gitTopLevel(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function gitRevParseGitDir(cwd: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0;
}

async function gitStatusShortBranchAsync(cwd: string): Promise<{ ok: boolean; text: string }> {
  const r = await spawnGitAsync(cwd, ["status", "--short", "-b"]);
  if (!r.ok) {
    return { ok: false, text: (r.stderr || r.stdout || "git status failed").trim() };
  }
  return { ok: true, text: r.stdout.trimEnd() };
}

function gitRevParseHead(cwd: string): { ok: boolean; sha?: string; text: string } {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return { ok: false, text: (r.stderr || r.stdout || "git rev-parse HEAD failed").trim() };
  }
  return { ok: true, sha: r.stdout.trim(), text: r.stdout.trim() };
}

function parseGitSubmodulePaths(gitRoot: string): string[] {
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

function hasGitMetadata(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

// ---------------------------------------------------------------------------
// Async pool for parallel git (inventory)
// ---------------------------------------------------------------------------

async function asyncPool<T, R>(
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

function spawnGitAsync(
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

type InventoryEntryJson = {
  label: string;
  path: string;
  branchStatus: string;
  shortStatus: string;
  detached: boolean;
  headAbbrev: string;
  upstreamMode: "auto" | "fixed";
  upstreamRef: string | null;
  ahead: string | null;
  behind: string | null;
  upstreamNote: string;
  skipReason?: string;
};

function buildInventorySectionMarkdown(e: InventoryEntryJson): string[] {
  if (e.skipReason) {
    return [`## ${e.label}`, `path: ${e.path}`, "```text", e.skipReason, "```", ``];
  }
  const lines: string[] = [];
  lines.push(e.branchStatus);
  lines.push("");
  lines.push("short:");
  lines.push(e.shortStatus || "(clean)");
  lines.push("");
  if (e.detached) {
    lines.push("branch: (detached HEAD)");
    lines.push("");
  }
  if (e.ahead != null && e.behind != null && e.upstreamRef) {
    lines.push(`ahead_of_${e.upstreamRef.replace(/\//g, "_")}: ${e.ahead}`);
    lines.push(`behind_${e.upstreamRef.replace(/\//g, "_")}: ${e.behind}`);
  } else {
    lines.push(`upstream: ${e.upstreamNote}`);
  }
  return [`## ${e.label}`, `path: ${e.path}`, "```text", lines.join("\n"), "```", ``];
}

async function collectInventoryEntry(
  label: string,
  absPath: string,
  fixedRemote: string | undefined,
  fixedBranch: string | undefined,
): Promise<InventoryEntryJson> {
  const brP = spawnGitAsync(absPath, ["status", "--short", "-b"]);
  const shP = spawnGitAsync(absPath, ["status", "--short"]);
  const headP = spawnGitAsync(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const [br, sh, headR] = await Promise.all([brP, shP, headP]);

  const branchStatus = br.ok
    ? br.stdout.trimEnd()
    : (br.stderr || br.stdout || "git status failed").trim();
  const shortStatus = sh.ok
    ? sh.stdout.trimEnd()
    : (sh.stderr || sh.stdout || "git status failed").trim();
  const headAbbrev = headR.ok ? headR.stdout.trim() : "";
  const detached = !headR.ok || headAbbrev === "HEAD" || headAbbrev.endsWith("/HEAD");

  const useFixed = fixedRemote !== undefined && fixedBranch !== undefined;

  if (useFixed) {
    const remote = fixedRemote;
    const branch = fixedBranch;
    const verify = await spawnGitAsync(absPath, ["rev-parse", "--verify", `${remote}/${branch}`]);
    if (!verify.ok) {
      return {
        label,
        path: absPath,
        branchStatus,
        shortStatus,
        detached,
        headAbbrev: headAbbrev || "(unknown)",
        upstreamMode: "fixed",
        upstreamRef: `${remote}/${branch}`,
        ahead: null,
        behind: null,
        upstreamNote: `(no local ref ${remote}/${branch} or unreadable)`,
      };
    }
    const aheadR = await spawnGitAsync(absPath, [
      "rev-list",
      "--count",
      `${remote}/${branch}..HEAD`,
    ]);
    const behindR = await spawnGitAsync(absPath, [
      "rev-list",
      "--count",
      `HEAD..${remote}/${branch}`,
    ]);
    const ahead = aheadR.ok ? aheadR.stdout.trim() : null;
    const behind = behindR.ok ? behindR.stdout.trim() : null;
    return {
      label,
      path: absPath,
      branchStatus,
      shortStatus,
      detached,
      headAbbrev: headAbbrev || "(unknown)",
      upstreamMode: "fixed",
      upstreamRef: `${remote}/${branch}`,
      ahead,
      behind,
      upstreamNote:
        ahead != null && behind != null
          ? `tracking ${remote}/${branch}`
          : `upstream ${remote}/${branch} (counts unreadable)`,
    };
  }

  const upVerify = await spawnGitAsync(absPath, ["rev-parse", "--verify", "@{u}"]);
  if (!upVerify.ok) {
    let note = "no upstream configured";
    if (detached) {
      note = "detached HEAD — no upstream";
    }
    return {
      label,
      path: absPath,
      branchStatus,
      shortStatus,
      detached,
      headAbbrev: headAbbrev || "(unknown)",
      upstreamMode: "auto",
      upstreamRef: null,
      ahead: null,
      behind: null,
      upstreamNote: note,
    };
  }

  const abbrevR = await spawnGitAsync(absPath, ["rev-parse", "--abbrev-ref", "@{u}"]);
  const upstreamRef = abbrevR.ok ? abbrevR.stdout.trim() : "@{u}";
  const aheadR = await spawnGitAsync(absPath, ["rev-list", "--count", "@{u}..HEAD"]);
  const behindR = await spawnGitAsync(absPath, ["rev-list", "--count", "HEAD..@{u}"]);
  const ahead = aheadR.ok ? aheadR.stdout.trim() : null;
  const behind = behindR.ok ? behindR.stdout.trim() : null;

  return {
    label,
    path: absPath,
    branchStatus,
    shortStatus,
    detached,
    headAbbrev: headAbbrev || "(unknown)",
    upstreamMode: "auto",
    upstreamRef,
    ahead,
    behind,
    upstreamNote:
      ahead != null && behind != null
        ? `tracking ${upstreamRef}`
        : `upstream ${upstreamRef} (counts unreadable)`,
  };
}

// ---------------------------------------------------------------------------
// Shared Zod fragments
// ---------------------------------------------------------------------------

const FormatSchema = z.enum(["markdown", "json"]).optional().default("markdown");

const WorkspacePickSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe("Override workspace path. Wins over MCP roots, rootIndex, and allWorkspaceRoots."),
  rootIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Use the Nth file:// MCP root (0-based) when multiple workspace roots exist."),
  allWorkspaceRoots: z
    .boolean()
    .optional()
    .default(false)
    .describe("Run against every file:// MCP root and aggregate results."),
  format: FormatSchema.describe('Return "markdown" (default) or structured "json".'),
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new FastMCP({
  name: "rethunk-git",
  version: readPackageVersion() as `${number}.${number}.${number}`,
  roots: { enabled: true },
});

// ---------------------------------------------------------------------------
// Tool: git_status
// ---------------------------------------------------------------------------

server.addTool({
  name: "git_status",
  description:
    "Run `git status --short -b` in the workspace root and (optionally) each path from `.gitmodules`. " +
    "Read-only. Supports multi-root MCP workspaces via `allWorkspaceRoots` or `rootIndex`.",
  parameters: WorkspacePickSchema.extend({
    includeSubmodules: z
      .boolean()
      .optional()
      .default(true)
      .describe("When true (default), include submodule paths listed in .gitmodules."),
  }),
  execute: async (args) => {
    const gg = gateGit();
    if (!gg.ok) {
      return jsonRespond(gg.body);
    }

    const rootsRes = resolveWorkspaceRoots(server, args);
    if (!rootsRes.ok) {
      return jsonRespond(rootsRes.error);
    }

    type RepoRow = { label: string; path: string; statusText: string; ok: boolean };
    type Group = { mcpRoot: string; repos: RepoRow[] };
    const groups: Group[] = [];

    for (const rootInput of rootsRes.roots) {
      const repos: RepoRow[] = [];
      const top = gitTopLevel(rootInput);
      if (!top) {
        repos.push({
          label: rootInput,
          path: rootInput,
          statusText: "not a git repository",
          ok: false,
        });
        groups.push({ mcpRoot: rootInput, repos });
        continue;
      }

      const includeSubmodules = args.includeSubmodules !== false;
      const meta = await gitStatusShortBranchAsync(top);
      repos.push({ label: ".", path: top, statusText: meta.text, ok: meta.ok });

      if (includeSubmodules) {
        const rels = parseGitSubmodulePaths(top);
        const subRows = await asyncPool(rels, GIT_SUBPROCESS_PARALLELISM, async (rel) => {
          const subPath = join(top, rel);
          if (!hasGitMetadata(subPath)) {
            return {
              label: rel,
              path: subPath,
              statusText: "(no .git — submodule not checked out?)",
              ok: false,
            };
          }
          const st = await gitStatusShortBranchAsync(subPath);
          return { label: rel, path: subPath, statusText: st.text, ok: st.ok };
        });
        repos.push(...subRows);
      }
      groups.push({ mcpRoot: rootInput, repos });
    }

    if (args.format === "json") {
      return jsonRespond({ groups });
    }

    const sections: string[] = ["# Multi-root git status", ""];
    for (const g of groups) {
      if (groups.length > 1) {
        sections.push(`### MCP root: ${g.mcpRoot}`, "");
      }
      for (const row of g.repos) {
        sections.push(
          `## ${row.label}`,
          `path: ${row.path}`,
          "```text",
          row.statusText || "(empty)",
          "```",
          ``,
        );
      }
    }
    return sections.join("\n");
  },
});

// ---------------------------------------------------------------------------
// Tool: git_inventory
// ---------------------------------------------------------------------------

server.addTool({
  name: "git_inventory",
  description:
    "Read-only push-prep inventory: status + ahead/behind per root. " +
    "Uses each repo's configured upstream (`@{u}`) unless both `remote` and `branch` are set. " +
    "Presets from `.rethunk/git-mcp-presets.json`; use `presetMerge` to combine with inline paths.",
  parameters: WorkspacePickSchema.extend({
    nestedRoots: z
      .array(z.string())
      .optional()
      .describe(
        "Paths relative to git toplevel. If empty/omitted, only the repo root is listed. With `presetMerge`, merged with preset paths.",
      ),
    preset: z
      .string()
      .optional()
      .describe("Named preset from .rethunk/git-mcp-presets.json (at git toplevel)."),
    presetMerge: z
      .boolean()
      .optional()
      .default(false)
      .describe("When true, merge `nestedRoots` with preset nestedRoots instead of replacing."),
    remote: z
      .string()
      .optional()
      .describe(
        "Fixed upstream remote; must be set together with `branch` to override auto upstream.",
      ),
    branch: z
      .string()
      .optional()
      .describe("Fixed upstream branch name; must be set together with `remote`."),
    maxRoots: z
      .number()
      .int()
      .min(1)
      .max(256)
      .optional()
      .default(MAX_INVENTORY_ROOTS_DEFAULT)
      .describe("Max nested roots to process (cap)."),
  }),
  execute: async (args) => {
    const gg = gateGit();
    if (!gg.ok) {
      return jsonRespond(gg.body);
    }

    const rootsRes = args.preset
      ? resolveRootsForPreset(server, args, args.preset)
      : resolveWorkspaceRoots(server, args);
    if (!rootsRes.ok) {
      return jsonRespond(rootsRes.error);
    }

    const fixedRemote = args.remote;
    const fixedBranch = args.branch;
    const hasRemote = fixedRemote !== undefined && fixedRemote.trim() !== "";
    const hasBranch = fixedBranch !== undefined && fixedBranch.trim() !== "";
    if (hasRemote !== hasBranch) {
      return jsonRespond({
        error: "remote_branch_mismatch",
        message: "Set both `remote` and `branch` for fixed upstream, or omit both for auto `@{u}`.",
      });
    }
    const useFixed = hasRemote && hasBranch;

    const allJson: {
      workspace_root: string;
      presetSchemaVersion?: string;
      upstream: { mode: "auto" | "fixed"; remote?: string; branch?: string };
      entries: InventoryEntryJson[];
    }[] = [];

    const mdChunks: string[] = [];

    for (const workspaceRoot of rootsRes.roots) {
      const top = gitTopLevel(workspaceRoot);
      if (!top) {
        const err = { error: "not_a_git_repository", path: workspaceRoot };
        if (args.format === "json") {
          allJson.push({
            workspace_root: workspaceRoot,
            upstream: {
              mode: useFixed ? "fixed" : "auto",
              remote: fixedRemote,
              branch: fixedBranch,
            },
            entries: [
              {
                label: workspaceRoot,
                path: workspaceRoot,
                branchStatus: "",
                shortStatus: "",
                detached: false,
                headAbbrev: "",
                upstreamMode: useFixed ? "fixed" : "auto",
                upstreamRef: null,
                ahead: null,
                behind: null,
                upstreamNote: "",
                skipReason: JSON.stringify(err),
              },
            ],
          });
        } else {
          mdChunks.push(`# Git inventory`, "", jsonRespond(err), "");
        }
        continue;
      }

      let nestedRoots: string[] | undefined = args.nestedRoots;
      let presetSchemaVersion: string | undefined;

      if (args.preset) {
        const got = getPresetEntry(top, args.preset);
        if ("error" in got) {
          return jsonRespond(got.error);
        }
        presetSchemaVersion = got.presetSchemaVersion;
        const fromPreset = got.entry.nestedRoots;
        if (args.presetMerge) {
          nestedRoots = mergeNestedRoots(fromPreset, nestedRoots);
        } else if (!nestedRoots?.length) {
          nestedRoots = fromPreset;
        }
      }

      const maxRoots = args.maxRoots ?? MAX_INVENTORY_ROOTS_DEFAULT;
      if (nestedRoots && nestedRoots.length > maxRoots) {
        nestedRoots = nestedRoots.slice(0, maxRoots);
      }

      const headerNote = useFixed
        ? `remote/branch (fixed): ${fixedRemote}/${fixedBranch}`
        : "upstream: per-repo @{u} (configured upstream)";

      const entries: InventoryEntryJson[] = [];

      if (nestedRoots?.length) {
        const jobs: { label: string; abs: string }[] = [];
        for (const rel of nestedRoots) {
          const abs = resolvePathForRepo(rel, top);
          if (!assertRelativePathUnderTop(rel, abs, top)) {
            entries.push({
              label: rel,
              path: abs,
              branchStatus: "",
              shortStatus: "",
              detached: false,
              headAbbrev: "",
              upstreamMode: useFixed ? "fixed" : "auto",
              upstreamRef: null,
              ahead: null,
              behind: null,
              upstreamNote: "",
              skipReason: "(path escapes git toplevel — rejected)",
            });
            continue;
          }
          if (!gitRevParseGitDir(abs)) {
            entries.push({
              label: rel,
              path: abs,
              branchStatus: "",
              shortStatus: "",
              detached: false,
              headAbbrev: "",
              upstreamMode: useFixed ? "fixed" : "auto",
              upstreamRef: null,
              ahead: null,
              behind: null,
              upstreamNote: "",
              skipReason: "(not a git work tree — skip)",
            });
            continue;
          }
          jobs.push({ label: rel, abs });
        }
        const computed = await asyncPool(jobs, GIT_SUBPROCESS_PARALLELISM, (j) =>
          collectInventoryEntry(
            j.label,
            j.abs,
            useFixed ? fixedRemote : undefined,
            useFixed ? fixedBranch : undefined,
          ),
        );
        entries.push(...computed);
      } else if (!gitRevParseGitDir(top)) {
        entries.push({
          label: ".",
          path: top,
          branchStatus: "",
          shortStatus: "",
          detached: false,
          headAbbrev: "",
          upstreamMode: useFixed ? "fixed" : "auto",
          upstreamRef: null,
          ahead: null,
          behind: null,
          upstreamNote: "",
          skipReason: "(not a git work tree — unexpected)",
        });
      } else {
        const one = await collectInventoryEntry(
          ".",
          top,
          useFixed ? fixedRemote : undefined,
          useFixed ? fixedBranch : undefined,
        );
        entries.push(one);
      }

      if (args.format === "json") {
        allJson.push({
          workspace_root: top,
          ...(presetSchemaVersion !== undefined ? { presetSchemaVersion } : {}),
          upstream: useFixed
            ? { mode: "fixed", remote: fixedRemote, branch: fixedBranch }
            : { mode: "auto" },
          entries,
        });
      } else {
        const sections: string[] = [
          "# Git inventory",
          "",
          `workspace_root: ${top}`,
          headerNote,
          "",
        ];
        for (const e of entries) {
          sections.push(...buildInventorySectionMarkdown(e));
        }
        mdChunks.push(sections.join("\n"));
      }
    }

    if (args.format === "json") {
      return jsonRespond({ inventories: allJson });
    }
    return mdChunks.join("\n\n---\n\n");
  },
});

// ---------------------------------------------------------------------------
// Tool: git_parity
// ---------------------------------------------------------------------------

server.addTool({
  name: "git_parity",
  description:
    "Read-only: compare `git rev-parse HEAD` for path pairs. Presets or inline `pairs`; `presetMerge` merges with inline pairs.",
  parameters: WorkspacePickSchema.extend({
    pairs: z
      .array(
        z.object({
          left: z.string(),
          right: z.string(),
          label: z.string().optional(),
        }),
      )
      .optional(),
    preset: z.string().optional(),
    presetMerge: z.boolean().optional().default(false),
  }),
  execute: async (args) => {
    const gg = gateGit();
    if (!gg.ok) {
      return jsonRespond(gg.body);
    }

    const rootsRes = args.preset
      ? resolveRootsForPreset(server, args, args.preset)
      : resolveWorkspaceRoots(server, args);
    if (!rootsRes.ok) {
      return jsonRespond(rootsRes.error);
    }

    type Pair = { left: string; right: string; label?: string };
    const results: {
      workspace_root: string;
      presetSchemaVersion?: string;
      status: "OK" | "MISMATCH";
      pairs: {
        label: string;
        leftPath: string;
        rightPath: string;
        match: boolean;
        sha?: string;
        leftSha?: string;
        rightSha?: string;
        error?: string;
      }[];
    }[] = [];

    const mdParts: string[] = [];

    for (const workspaceRoot of rootsRes.roots) {
      const top = gitTopLevel(workspaceRoot);
      if (!top) {
        const errPayload = { error: "not_a_git_repository", path: workspaceRoot };
        const err = jsonRespond(errPayload);
        if (args.format === "json") {
          results.push({
            workspace_root: workspaceRoot,
            status: "MISMATCH",
            pairs: [{ label: "—", leftPath: "", rightPath: "", match: false, error: err }],
          });
        } else {
          mdParts.push(err);
        }
        continue;
      }

      let pairs: Pair[] | undefined = args.pairs;
      let parityPresetSchemaVersion: string | undefined;
      if (args.preset) {
        const got = getPresetEntry(top, args.preset);
        if ("error" in got) {
          return jsonRespond(got.error);
        }
        parityPresetSchemaVersion = got.presetSchemaVersion;
        const fromPreset = got.entry.parityPairs as Pair[] | undefined;
        if (args.presetMerge) {
          pairs = mergePairs(fromPreset, pairs);
        } else if (!pairs?.length) {
          pairs = fromPreset;
        }
      }

      if (!pairs?.length) {
        return jsonRespond({
          error: "no_pairs",
          message: "Pass `pairs` directly or a `preset` with parityPairs (or presetMerge).",
        });
      }

      let allOk = true;
      const pairResults: (typeof results)[0]["pairs"] = [];

      for (const pair of pairs) {
        const pathA = resolvePathForRepo(pair.left, top);
        const pathB = resolvePathForRepo(pair.right, top);
        const underA = assertRelativePathUnderTop(pair.left, pathA, top);
        const underB = assertRelativePathUnderTop(pair.right, pathB, top);
        const label = pair.label ?? `${pair.left} / ${pair.right}`;

        if (!underA || !underB) {
          allOk = false;
          pairResults.push({
            label,
            leftPath: pathA,
            rightPath: pathB,
            match: false,
            error: "path escapes git toplevel — rejected",
          });
          continue;
        }

        const ha = gitRevParseHead(pathA);
        const hb = gitRevParseHead(pathB);

        if (!ha.ok || !hb.ok) {
          allOk = false;
          pairResults.push({
            label,
            leftPath: pathA,
            rightPath: pathB,
            match: false,
            error: [!ha.ok ? `left: ${ha.text}` : "", !hb.ok ? `right: ${hb.text}` : ""]
              .filter(Boolean)
              .join("\n"),
          });
          continue;
        }
        if (ha.sha !== hb.sha) {
          allOk = false;
          pairResults.push({
            label,
            leftPath: pathA,
            rightPath: pathB,
            match: false,
            leftSha: ha.sha,
            rightSha: hb.sha,
          });
        } else {
          pairResults.push({
            label,
            leftPath: pathA,
            rightPath: pathB,
            match: true,
            sha: ha.sha,
          });
        }
      }

      results.push({
        workspace_root: top,
        ...(parityPresetSchemaVersion !== undefined
          ? { presetSchemaVersion: parityPresetSchemaVersion }
          : {}),
        status: allOk ? "OK" : "MISMATCH",
        pairs: pairResults,
      });

      if (args.format !== "json") {
        const lines: string[] = [
          "# Git HEAD parity",
          "",
          `status: ${allOk ? "OK" : "MISMATCH"}`,
          "",
        ];
        for (const pr of pairResults) {
          if (pr.error) {
            lines.push(`## ${pr.label} — error`, "```text", pr.error, "```", "");
          } else if (pr.match) {
            lines.push(`## ${pr.label} — OK`, "```text", `SHA: ${pr.sha}`, "```", "");
          } else {
            lines.push(
              `## ${pr.label} — MISMATCH`,
              "```text",
              `left:  ${pr.leftSha}`,
              `right: ${pr.rightSha}`,
              "```",
              "",
            );
          }
        }
        mdParts.push(lines.join("\n"));
      }
    }

    if (args.format === "json") {
      return jsonRespond({ parity: results });
    }
    return mdParts.join("\n\n---\n\n");
  },
});

// ---------------------------------------------------------------------------
// Tool: list_presets
// ---------------------------------------------------------------------------

server.addTool({
  name: "list_presets",
  description:
    "List named entries from `.rethunk/git-mcp-presets.json` at the git toplevel for the resolved workspace root.",
  parameters: WorkspacePickSchema.pick({
    workspaceRoot: true,
    rootIndex: true,
    allWorkspaceRoots: true,
    format: true,
  }),
  execute: async (args) => {
    const gg = gateGit();
    if (!gg.ok) {
      return jsonRespond(gg.body);
    }

    const rootsRes = resolveWorkspaceRoots(server, args);
    if (!rootsRes.ok) {
      return jsonRespond(rootsRes.error);
    }

    const out: {
      workspaceRoot: string;
      gitTop: string | null;
      presetFile: string;
      fileExists: boolean;
      presetSchemaVersion?: string;
      presets: {
        name: string;
        nestedRootsCount: number;
        parityPairsCount: number;
        workspaceRootHint?: string;
      }[];
      error?: Record<string, unknown>;
    }[] = [];

    for (const ws of rootsRes.roots) {
      const top = gitTopLevel(ws);
      const presetFile = top ? join(top, PRESET_FILE_PATH) : join(ws, PRESET_FILE_PATH);
      if (!top) {
        out.push({
          workspaceRoot: ws,
          gitTop: null,
          presetFile,
          fileExists: false,
          presets: [],
          error: { error: "not_a_git_repository", path: ws },
        });
        continue;
      }
      const loaded = loadPresetsFromGitTop(top);
      if (!loaded.ok) {
        if (loaded.reason === "missing") {
          out.push({
            workspaceRoot: ws,
            gitTop: top,
            presetFile,
            fileExists: false,
            presets: [],
          });
        } else {
          out.push({
            workspaceRoot: ws,
            gitTop: top,
            presetFile,
            fileExists: true,
            presets: [],
            error: presetLoadErrorPayload(top, loaded),
          });
        }
        continue;
      }
      const presets = Object.entries(loaded.data).map(([name, e]) => ({
        name,
        nestedRootsCount: e.nestedRoots?.length ?? 0,
        parityPairsCount: e.parityPairs?.length ?? 0,
        ...(e.workspaceRootHint ? { workspaceRootHint: e.workspaceRootHint } : {}),
      }));
      out.push({
        workspaceRoot: ws,
        gitTop: top,
        presetFile,
        fileExists: true,
        ...(loaded.schemaVersion !== undefined
          ? { presetSchemaVersion: loaded.schemaVersion }
          : {}),
        presets,
      });
    }

    if (args.format === "json") {
      return jsonRespond({ roots: out });
    }
    const lines: string[] = ["# Git MCP presets", ""];
    for (const row of out) {
      lines.push(
        `## ${row.workspaceRoot}`,
        `git_top: ${row.gitTop ?? "(none)"}`,
        `preset_file: ${row.presetFile}`,
        "",
      );
      if (row.error) {
        lines.push("```json", JSON.stringify(row.error, null, 2), "```", "");
        continue;
      }
      if (!row.fileExists) {
        lines.push("(no preset file)", "");
        continue;
      }
      if (row.presets.length === 0) {
        lines.push("(empty preset file)", "");
        continue;
      }
      if (row.presetSchemaVersion !== undefined) {
        lines.push(`preset_schema_version: ${row.presetSchemaVersion}`, "");
      }
      for (const p of row.presets) {
        lines.push(
          `- **${p.name}**: nestedRoots=${p.nestedRootsCount}, parityPairs=${p.parityPairsCount}` +
            (p.workspaceRootHint ? `, hint=${p.workspaceRootHint}` : ""),
        );
      }
      lines.push("");
    }
    return lines.join("\n");
  },
});

// ---------------------------------------------------------------------------
// Resource: preset manifest
// ---------------------------------------------------------------------------

server.addResource({
  uri: "rethunk-git://presets",
  name: "git-mcp-presets",
  mimeType: "application/json",
  async load() {
    const gg = gateGit();
    if (!gg.ok) {
      return { text: jsonRespond(gg.body) };
    }

    const rootsRes = resolveWorkspaceRoots(server, {});
    if (!rootsRes.ok) {
      return { text: jsonRespond(rootsRes.error) };
    }
    const ws = rootsRes.roots[0];
    if (!ws) {
      return { text: jsonRespond({ error: "no_workspace_root" }) };
    }
    const top = gitTopLevel(ws);
    if (!top) {
      return { text: jsonRespond({ error: "not_a_git_repository", path: ws }) };
    }
    const loaded = loadPresetsFromGitTop(top);
    if (!loaded.ok) {
      if (loaded.reason === "missing") {
        return {
          text: jsonRespond({
            presetFile: join(top, PRESET_FILE_PATH),
            fileExists: false,
            presets: {},
          }),
        };
      }
      return { text: jsonRespond(presetLoadErrorPayload(top, loaded)) };
    }
    return {
      text: jsonRespond({
        presetFile: join(top, PRESET_FILE_PATH),
        fileExists: true,
        ...(loaded.schemaVersion !== undefined
          ? { presetSchemaVersion: loaded.schemaVersion }
          : {}),
        presets: loaded.data,
      }),
    };
  },
});

// ---------------------------------------------------------------------------

void server.start({ transportType: "stdio" });
