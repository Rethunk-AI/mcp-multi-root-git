import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { spawnGitAsync } from "./git.js";
import { conflictPaths } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConflictState = "merge" | "cherry-pick" | "revert" | "rebase";

interface ConflictHunk {
  startLine: number;
  ours: string;
  theirs: string;
  base?: string;
  oursLabel?: string;
  theirsLabel?: string;
}

interface ConflictFileJson {
  path: string;
  hunks?: ConflictHunk[];
  truncated?: boolean;
}

interface ConflictsJson {
  state?: ConflictState;
  files: ConflictFileJson[];
}

// ---------------------------------------------------------------------------
// Operation-state detection
// ---------------------------------------------------------------------------

/** Resolve the repo's git directory (handles worktrees, where it is not literally `<top>/.git`). */
async function resolveGitDir(gitTop: string): Promise<string | null> {
  const r = await spawnGitAsync(gitTop, ["rev-parse", "--git-dir"]);
  if (!r.ok) return null;
  const raw = r.stdout.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : join(gitTop, raw);
}

/** Detect the in-progress operation, if any, via marker files/dirs under the git dir. */
async function detectConflictState(gitTop: string): Promise<ConflictState | undefined> {
  const gitDir = await resolveGitDir(gitTop);
  if (!gitDir) return undefined;
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Conflict marker parsing
// ---------------------------------------------------------------------------

const OURS_MARKER = "<<<<<<<";
const BASE_MARKER = "|||||||";
const SPLIT_MARKER = "=======";
const THEIRS_MARKER = ">>>>>>>";

function labelAfterMarker(line: string, marker: string): string | undefined {
  const rest = line.slice(marker.length).trim();
  return rest.length > 0 ? rest : undefined;
}

interface HunkInProgress {
  startLine: number;
  oursLines: string[];
  baseLines: string[];
  theirsLines: string[];
  oursLabel?: string;
  theirsLabel?: string;
}

/**
 * Parse `<<<<<<<`/`|||||||`/`=======`/`>>>>>>>` conflict markers out of file text.
 * Only the first `maxLinesPerFile` lines are scanned; when the file is longer,
 * `truncated: true` is reported and any hunk still open at the cutoff is dropped
 * rather than emitted half-formed.
 */
function parseConflictHunks(
  text: string,
  maxLinesPerFile: number,
): { hunks: ConflictHunk[]; truncated: boolean } {
  const allLines = text.split("\n");
  const truncated = allLines.length > maxLinesPerFile;
  const lines = truncated ? allLines.slice(0, maxLinesPerFile) : allLines;

  const hunks: ConflictHunk[] = [];
  let state: "outside" | "ours" | "base" | "theirs" = "outside";
  let cur: HunkInProgress | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    if (line.startsWith(OURS_MARKER)) {
      cur = {
        startLine: lineNo,
        oursLines: [],
        baseLines: [],
        theirsLines: [],
        oursLabel: labelAfterMarker(line, OURS_MARKER),
      };
      state = "ours";
      continue;
    }
    if (state === "ours" && line.startsWith(BASE_MARKER)) {
      state = "base";
      continue;
    }
    if ((state === "ours" || state === "base") && line.startsWith(SPLIT_MARKER)) {
      state = "theirs";
      continue;
    }
    if (state === "theirs" && line.startsWith(THEIRS_MARKER) && cur) {
      cur.theirsLabel = labelAfterMarker(line, THEIRS_MARKER);
      hunks.push({
        startLine: cur.startLine,
        ours: cur.oursLines.join("\n"),
        theirs: cur.theirsLines.join("\n"),
        ...spreadWhen(cur.baseLines.length > 0, { base: cur.baseLines.join("\n") }),
        ...spreadDefined("oursLabel", cur.oursLabel),
        ...spreadDefined("theirsLabel", cur.theirsLabel),
      });
      cur = null;
      state = "outside";
      continue;
    }

    if (!cur) continue;
    if (state === "ours") cur.oursLines.push(line);
    else if (state === "base") cur.baseLines.push(line);
    else if (state === "theirs") cur.theirsLines.push(line);
  }

  return { hunks, truncated };
}

/** Conservative binary sniff: a NUL byte in the first 8000 bytes. */
function isLikelyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-file resolution
// ---------------------------------------------------------------------------

function readConflictFile(
  gitTop: string,
  relPath: string,
  maxLinesPerFile: number,
): ConflictFileJson {
  const resolved = resolvePathForRepo(relPath, gitTop);
  if (!assertRelativePathUnderTop(relPath, resolved, gitTop)) {
    return { path: relPath };
  }

  let buf: Buffer;
  try {
    buf = readFileSync(resolved);
  } catch {
    return { path: relPath };
  }
  if (isLikelyBinary(buf)) {
    return { path: relPath };
  }

  const { hunks, truncated } = parseConflictHunks(buf.toString("utf8"), maxLinesPerFile);
  return {
    path: relPath,
    ...spreadWhen(hunks.length > 0, { hunks }),
    ...spreadWhen(truncated, { truncated: true }),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderConflictsMarkdown(result: ConflictsJson): string {
  const lines: string[] = ["# Git conflicts"];
  if (result.state) lines.push(`_state: ${result.state}_`);
  lines.push("");

  if (result.files.length === 0) {
    lines.push("_(no conflicts)_");
    return lines.join("\n");
  }

  for (const f of result.files) {
    lines.push(`## ${f.path}`);
    if (f.truncated) lines.push("_(truncated)_");
    if (!f.hunks || f.hunks.length === 0) {
      lines.push("_(no parsed hunks — unreadable, binary, or no markers found)_", "");
      continue;
    }
    for (const h of f.hunks) {
      lines.push(`### hunk @ line ${h.startLine}`);
      lines.push(`**ours${h.oursLabel ? ` (${h.oursLabel})` : ""}:**`, "```", h.ours, "```");
      if (h.base !== undefined) {
        lines.push("**base:**", "```", h.base, "```");
      }
      lines.push(
        `**theirs${h.theirsLabel ? ` (${h.theirsLabel})` : ""}:**`,
        "```",
        h.theirs,
        "```",
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitConflictsTool(server: FastMCP): void {
  server.addTool({
    name: "git_conflicts",
    description:
      "Inspect unresolved merge conflicts after git_merge/git_cherry_pick reports them. " +
      "Reports the in-progress operation (merge/cherry-pick/revert/rebase, when detectable) and, " +
      "per conflicted file, the parsed ours/theirs (and base, for diff3-style markers) hunks.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.extend({
      withHunks: z
        .boolean()
        .optional()
        .default(true)
        .describe("Parse conflict-marker hunks per file. Set false for just the path list."),
      maxLinesPerFile: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .default(200)
        .describe("Cap on lines scanned per file before marking `truncated: true`."),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      const state = await detectConflictState(gitTop);
      const paths = await conflictPaths(gitTop);
      const withHunks = args.withHunks !== false;
      const maxLinesPerFile = typeof args.maxLinesPerFile === "number" ? args.maxLinesPerFile : 200;

      const files: ConflictFileJson[] = paths.map((p) =>
        withHunks ? readConflictFile(gitTop, p, maxLinesPerFile) : { path: p },
      );

      const result: ConflictsJson = {
        ...spreadDefined("state", state),
        files,
      };

      if (args.format === "json") {
        return jsonRespond(result as unknown as Record<string, unknown>);
      }
      return renderConflictsMarkdown(result);
    },
  });
}
