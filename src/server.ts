#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FastMCP } from "fastmcp";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Preset file schema
// ---------------------------------------------------------------------------

/**
 * Schema for `.rethunk/git-mcp-presets.json` at the workspace root.
 * Each named entry defines roots for `git_inventory` and/or pairs for `git_parity`.
 */
const PresetEntrySchema = z.object({
  /** Paths relative to the workspace root, inventory order. */
  nestedRoots: z.array(z.string()).optional(),
  /** Left/right/label triples for HEAD parity checks. */
  parityPairs: z
    .array(
      z.object({
        left: z.string(),
        right: z.string(),
        label: z.string().optional(),
      }),
    )
    .optional(),
});

const PresetFileSchema = z.record(z.string(), PresetEntrySchema);

type PresetEntry = z.infer<typeof PresetEntrySchema>;
type PresetFile = z.infer<typeof PresetFileSchema>;

const PRESET_FILE_PATH = ".rethunk/git-mcp-presets.json";

// ---------------------------------------------------------------------------
// Workspace root resolution
// ---------------------------------------------------------------------------

/**
 * Convert an MCP root URI (file://...) to an absolute path.
 * Returns null for non-file URIs.
 */
function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * Derive the effective workspace root:
 * 1. Explicit `workspaceRoot` arg (if provided and non-empty).
 * 2. First `file://` root from the MCP session.
 * 3. `process.cwd()` as a fallback (useful in CI / test harness).
 */
function resolveWorkspaceRoot(server: FastMCP, explicitRoot: string | undefined): string {
  if (explicitRoot?.trim()) return resolve(explicitRoot.trim());

  const sessions = server.sessions;
  const roots = sessions[0]?.roots ?? [];
  for (const root of roots) {
    const p = uriToPath(root.uri);
    if (p) return p;
  }

  return process.cwd();
}

// ---------------------------------------------------------------------------
// Preset file loader
// ---------------------------------------------------------------------------

function loadPresets(workspaceRoot: string): PresetFile | null {
  const presetPath = join(workspaceRoot, PRESET_FILE_PATH);
  if (!existsSync(presetPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(presetPath, "utf8")) as unknown;
    return PresetFileSchema.parse(raw);
  } catch {
    return null;
  }
}

function resolvePreset(workspaceRoot: string, presetName: string): PresetEntry | null {
  const presets = loadPresets(workspaceRoot);
  if (!presets) return null;
  return presets[presetName] ?? null;
}

// ---------------------------------------------------------------------------
// Git helpers
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

function gitStatusShortBranch(cwd: string): { ok: boolean; text: string } {
  const r = spawnSync("git", ["status", "--short", "-b"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10_000_000,
  });
  if (r.status !== 0) {
    return { ok: false, text: (r.stderr || r.stdout || "git status failed").trim() };
  }
  return { ok: true, text: r.stdout.trimEnd() };
}

function gitStatusShort(cwd: string): { ok: boolean; text: string } {
  const r = spawnSync("git", ["status", "--short"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10_000_000,
  });
  if (r.status !== 0) {
    return { ok: false, text: (r.stderr || r.stdout || "git status failed").trim() };
  }
  return { ok: true, text: r.stdout.trimEnd() };
}

function remoteTrackingRefExists(cwd: string, remote: string, branch: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--verify", `${remote}/${branch}`], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0;
}

function gitAheadBehindCounts(
  cwd: string,
  remote: string,
  branch: string,
): { ahead: string; behind: string } | null {
  if (!remoteTrackingRefExists(cwd, remote, branch)) return null;
  const aheadR = spawnSync("git", ["rev-list", "--count", `${remote}/${branch}..HEAD`], {
    cwd,
    encoding: "utf8",
  });
  const behindR = spawnSync("git", ["rev-list", "--count", `HEAD..${remote}/${branch}`], {
    cwd,
    encoding: "utf8",
  });
  if (aheadR.status !== 0 || behindR.status !== 0) return null;
  return { ahead: aheadR.stdout.trim(), behind: behindR.stdout.trim() };
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

function appendInventorySection(
  sections: string[],
  label: string,
  absPath: string,
  remote: string,
  branch: string,
): void {
  const br = gitStatusShortBranch(absPath);
  const sh = gitStatusShort(absPath);
  const lines: string[] = [];
  lines.push(br.text);
  lines.push("");
  lines.push("short:");
  lines.push(sh.ok ? sh.text || "(clean)" : sh.text);
  const ab = gitAheadBehindCounts(absPath, remote, branch);
  lines.push("");
  if (ab) {
    lines.push(`ahead_of_${remote}/${branch}: ${ab.ahead}`);
    lines.push(`behind_${remote}/${branch}: ${ab.behind}`);
  } else {
    lines.push(`upstream: (no local ref ${remote}/${branch} or unreadable)`);
  }
  sections.push(`## ${label}`, `path: ${absPath}`, "```text", lines.join("\n"), "```", ``);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new FastMCP({
  name: "rethunk-git",
  version: "1.0.0",
  roots: { enabled: true },
});

// ---------------------------------------------------------------------------
// Tool: git_status
// Run git status --short -b in the workspace root (and optionally submodules).
// ---------------------------------------------------------------------------

server.addTool({
  name: "git_status",
  description:
    "Run `git status --short -b` in the workspace root and (optionally) each path from `.gitmodules`. " +
    "Read-only. Workspace root defaults to the first MCP root; pass `workspaceRoot` to override.",
  parameters: z.object({
    workspaceRoot: z
      .string()
      .optional()
      .describe("Override for the workspace root path. Defaults to the first MCP root, then cwd."),
    includeSubmodules: z
      .boolean()
      .optional()
      .default(true)
      .describe("When true (default), include submodule paths listed in .gitmodules."),
  }),
  execute: async (args) => {
    const rootInput = resolveWorkspaceRoot(server, args.workspaceRoot);
    const top = gitTopLevel(rootInput);
    if (!top) {
      return JSON.stringify({ error: "not_a_git_repository", path: rootInput }, null, 2);
    }

    const includeSubmodules = args.includeSubmodules !== false;
    const sections: string[] = ["# Multi-root git status", ""];

    const report = (label: string, path: string, body: string) => {
      sections.push(`## ${label}`, `path: ${path}`, "```text", body || "(empty)", "```", ``);
    };

    const meta = gitStatusShortBranch(top);
    report(".", top, meta.ok ? meta.text : meta.text);

    if (includeSubmodules) {
      for (const rel of parseGitSubmodulePaths(top)) {
        const subPath = join(top, rel);
        if (!hasGitMetadata(subPath)) {
          report(rel, subPath, "(no .git — submodule not checked out?)");
          continue;
        }
        const st = gitStatusShortBranch(subPath);
        report(rel, subPath, st.ok ? st.text : st.text);
      }
    }

    return sections.join("\n");
  },
});

// ---------------------------------------------------------------------------
// Tool: git_inventory
// Per-root status + ahead/behind. Roots from nestedRoots[] or preset name.
// ---------------------------------------------------------------------------

server.addTool({
  name: "git_inventory",
  description:
    "Read-only push-prep inventory: status + ahead/behind vs remote for each listed root. " +
    "Pass `nestedRoots` (paths relative to workspace root) OR a `preset` name that resolves from " +
    `\`.rethunk/git-mcp-presets.json\` at the workspace root. ` +
    "Workspace root defaults to the first MCP root; pass `workspaceRoot` to override.",
  parameters: z.object({
    workspaceRoot: z
      .string()
      .optional()
      .describe("Override for the workspace root. Defaults to the first MCP root, then cwd."),
    nestedRoots: z
      .array(z.string())
      .optional()
      .describe(
        "Paths relative to workspaceRoot to include, in order. Omit to use a preset or just the root itself.",
      ),
    preset: z
      .string()
      .optional()
      .describe(
        `Named entry from \`.rethunk/git-mcp-presets.json\` at the workspace root. ` +
          "Provides nestedRoots and/or parityPairs. Ignored if nestedRoots is also given.",
      ),
    remote: z.string().optional().default("origin").describe("Remote name (default: origin)."),
    branch: z.string().optional().default("main").describe("Upstream branch name (default: main)."),
  }),
  execute: async (args) => {
    const workspaceRoot = resolveWorkspaceRoot(server, args.workspaceRoot);
    const top = gitTopLevel(workspaceRoot);
    if (!top) {
      return JSON.stringify({ error: "not_a_git_repository", path: workspaceRoot }, null, 2);
    }

    const remote = args.remote ?? "origin";
    const branch = args.branch ?? "main";

    let nestedRoots: string[] | undefined = args.nestedRoots;

    if (!nestedRoots && args.preset) {
      const entry = resolvePreset(top, args.preset);
      if (!entry) {
        return JSON.stringify(
          {
            error: "preset_not_found",
            preset: args.preset,
            presetFile: join(top, PRESET_FILE_PATH),
          },
          null,
          2,
        );
      }
      nestedRoots = entry.nestedRoots;
    }

    const sections: string[] = [
      "# Git inventory",
      "",
      `workspace_root: ${top}`,
      `remote/branch: ${remote}/${branch}`,
      "",
    ];

    if (nestedRoots?.length) {
      for (const rel of nestedRoots) {
        const abs = join(top, rel);
        if (!gitRevParseGitDir(abs)) {
          sections.push(
            `## ${rel}`,
            `path: ${abs}`,
            "```text",
            "(not a git work tree — skip)",
            "```",
            ``,
          );
          continue;
        }
        appendInventorySection(sections, rel, abs, remote, branch);
      }
    }

    if (!gitRevParseGitDir(top)) {
      sections.push(
        `## .`,
        `path: ${top}`,
        "```text",
        "(not a git work tree — unexpected)",
        "```",
        ``,
      );
    } else {
      appendInventorySection(sections, ".", top, remote, branch);
    }

    return sections.join("\n");
  },
});

// ---------------------------------------------------------------------------
// Tool: git_parity
// Compare git rev-parse HEAD for left/right path pairs.
// ---------------------------------------------------------------------------

server.addTool({
  name: "git_parity",
  description:
    "Read-only: compare `git rev-parse HEAD` for each pair of paths. " +
    "Pass `pairs` (inline left/right/label objects) OR a `preset` name from " +
    `\`.rethunk/git-mcp-presets.json\`. ` +
    "Paths are relative to the workspace root unless absolute.",
  parameters: z.object({
    workspaceRoot: z
      .string()
      .optional()
      .describe("Override for the workspace root. Defaults to the first MCP root, then cwd."),
    pairs: z
      .array(
        z.object({
          left: z.string().describe("Relative or absolute path to the first repo."),
          right: z.string().describe("Relative or absolute path to the second repo."),
          label: z.string().optional().describe("Display label for this pair."),
        }),
      )
      .optional()
      .describe("Inline pairs to compare. Ignored if `preset` resolves parityPairs."),
    preset: z
      .string()
      .optional()
      .describe(
        `Named entry from \`.rethunk/git-mcp-presets.json\`. Provides parityPairs. ` +
          "Ignored if `pairs` is also given.",
      ),
  }),
  execute: async (args) => {
    const workspaceRoot = resolveWorkspaceRoot(server, args.workspaceRoot);
    const top = gitTopLevel(workspaceRoot);
    if (!top) {
      return JSON.stringify({ error: "not_a_git_repository", path: workspaceRoot }, null, 2);
    }

    type Pair = { left: string; right: string; label?: string };
    let pairs: Pair[] | undefined = args.pairs;

    if (!pairs && args.preset) {
      const entry = resolvePreset(top, args.preset);
      if (!entry) {
        return JSON.stringify(
          {
            error: "preset_not_found",
            preset: args.preset,
            presetFile: join(top, PRESET_FILE_PATH),
          },
          null,
          2,
        );
      }
      pairs = entry.parityPairs;
    }

    if (!pairs?.length) {
      return JSON.stringify(
        { error: "no_pairs", message: "Pass `pairs` directly or a `preset` with parityPairs." },
        null,
        2,
      );
    }

    const resolveRelative = (p: string) =>
      resolve(p).startsWith("/") && existsSync(resolve(p)) ? resolve(p) : join(top, p);

    const lines: string[] = ["# Git HEAD parity", ""];
    let allOk = true;

    for (const pair of pairs) {
      const pathA = resolveRelative(pair.left);
      const pathB = resolveRelative(pair.right);
      const label = pair.label ?? `${pair.left} / ${pair.right}`;
      const ha = gitRevParseHead(pathA);
      const hb = gitRevParseHead(pathB);

      if (!ha.ok || !hb.ok) {
        allOk = false;
        lines.push(`## ${label} — error`, "```text");
        if (!ha.ok) lines.push(`left  (${pathA}): ${ha.text}`);
        if (!hb.ok) lines.push(`right (${pathB}): ${hb.text}`);
        lines.push("```", "");
        continue;
      }
      if (ha.sha !== hb.sha) {
        allOk = false;
        lines.push(
          `## ${label} — MISMATCH`,
          "```text",
          `left:  ${ha.sha}`,
          `right: ${hb.sha}`,
          "```",
          "",
        );
      } else {
        lines.push(`## ${label} — OK`, "```text", `SHA: ${ha.sha}`, "```", "");
      }
    }

    lines.unshift(`status: ${allOk ? "OK" : "MISMATCH"}`, "");

    return lines.join("\n");
  },
});

// ---------------------------------------------------------------------------

void server.start({ transportType: "stdio" });
