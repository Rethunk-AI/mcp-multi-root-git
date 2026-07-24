import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { validateRepoPath } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { conflictPaths } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConflictState = "merge" | "cherry-pick" | "revert" | "rebase";

/** Conflict subtype derived from `git status --porcelain` XY codes. */
type ConflictType =
  | "both-modified"
  | "both-added"
  | "both-deleted"
  | "added-by-us"
  | "added-by-them"
  | "deleted-by-us"
  | "deleted-by-them";

/** Maps `git status --porcelain=v1` unmerged XY codes to a named conflict type. */
const CONFLICT_TYPE_BY_STATUS_CODE: Record<string, ConflictType> = {
  UU: "both-modified",
  AA: "both-added",
  DD: "both-deleted",
  AU: "added-by-us",
  UA: "added-by-them",
  DU: "deleted-by-us",
  UD: "deleted-by-them",
};

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
  error?: string;
  conflictType?: ConflictType;
  hunks?: ConflictHunk[];
  truncated?: boolean;
}

type ConflictsJson = {
  state?: ConflictState;
  files: ConflictFileJson[];
};

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
export async function detectConflictState(gitTop: string): Promise<ConflictState | undefined> {
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

/**
 * Classify each conflicted path via `git status --porcelain=v1` XY codes
 * (UU/AA/DD/AU/UA/DU/UD) into a named conflict type. Paths whose code isn't
 * one of the known unmerged codes (shouldn't happen for genuinely conflicted
 * paths) are simply absent from the returned map.
 */
export async function getConflictTypes(gitTop: string): Promise<Map<string, ConflictType>> {
  const map = new Map<string, ConflictType>();
  const r = await spawnGitAsync(gitTop, ["status", "--porcelain=v1", "-z"]);
  if (!r.ok) return map;
  for (const entry of r.stdout.split("\0")) {
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    const type = CONFLICT_TYPE_BY_STATUS_CODE[code];
    if (type) map.set(path, type);
  }
  return map;
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
 * rather than emitted half-formed. An incomplete hunk at EOF (corrupt/missing
 * closing marker within the scan window) also sets `truncated: true`.
 */
export function parseConflictHunks(
  text: string,
  maxLinesPerFile: number,
): { hunks: ConflictHunk[]; truncated: boolean } {
  const allLines = text.split("\n");
  const truncatedByCap = allLines.length > maxLinesPerFile;
  const lines = truncatedByCap ? allLines.slice(0, maxLinesPerFile) : allLines;

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

  // Incomplete open hunk at EOF (or at the line-cap) → flag truncated so callers
  // know markers were present but not fully parsed.
  const truncated = truncatedByCap || cur !== null;
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

const BINARY_SNIFF_BYTES = 8000;
/** Heuristic average bytes/line for the bounded initial read (see readBoundedText). */
const BOUNDED_READ_BYTES_PER_LINE = 200;
const BOUNDED_READ_MARGIN_LINES = 50;
const BOUNDED_READ_MAX_ATTEMPTS = 6;

/**
 * Read up to roughly `maxLinesPerFile` (+ margin) lines worth of bytes
 * without loading the whole file, doubling the read budget (quadrupling,
 * really) until enough newlines are seen or the file is exhausted. Falls
 * back to a full read for pathological files (e.g. one huge line) after
 * BOUNDED_READ_MAX_ATTEMPTS — no worse than the previous always-full-read
 * behavior for that edge case, while the common case (and the large-binary
 * case, handled separately before this is ever called) now avoids it.
 */
function readBoundedText(fd: number, size: number, maxLinesPerFile: number): string {
  let budget = (maxLinesPerFile + BOUNDED_READ_MARGIN_LINES) * BOUNDED_READ_BYTES_PER_LINE;
  for (let attempt = 0; attempt < BOUNDED_READ_MAX_ATTEMPTS; attempt++) {
    const readLen = Math.min(size, budget);
    const buf = Buffer.alloc(readLen);
    if (readLen > 0) readSync(fd, buf, 0, readLen, 0);
    if (readLen >= size) return buf.toString("utf8");
    const text = buf.toString("utf8");
    let newlineCount = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") newlineCount++;
    }
    if (newlineCount > maxLinesPerFile) return text;
    budget *= 4;
  }
  const buf = Buffer.alloc(size);
  if (size > 0) readSync(fd, buf, 0, size, 0);
  return buf.toString("utf8");
}

// ---------------------------------------------------------------------------
// Per-file resolution
// ---------------------------------------------------------------------------

export function readConflictFile(
  gitTop: string,
  relPath: string,
  maxLinesPerFile: number,
): ConflictFileJson {
  const { abs: resolved, underTop } = validateRepoPath(relPath, gitTop);
  if (!underTop) {
    return { path: relPath, error: ERROR_CODES.PATH_ESCAPES_REPO };
  }

  let fd: number;
  try {
    fd = openSync(resolved, "r");
  } catch {
    return { path: relPath };
  }

  let hunks: ConflictHunk[];
  let truncated: boolean;
  try {
    const size = fstatSync(fd).size;

    // Sniff only the first BINARY_SNIFF_BYTES — never load a huge binary
    // file entirely just to discover it's binary and discard it.
    const sniffLen = Math.min(size, BINARY_SNIFF_BYTES);
    const sniffBuf = Buffer.alloc(sniffLen);
    if (sniffLen > 0) readSync(fd, sniffBuf, 0, sniffLen, 0);
    if (isLikelyBinary(sniffBuf)) {
      return { path: relPath };
    }

    const text = readBoundedText(fd, size, maxLinesPerFile);
    ({ hunks, truncated } = parseConflictHunks(text, maxLinesPerFile));
  } catch {
    return { path: relPath };
  } finally {
    closeSync(fd);
  }

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
    if (f.conflictType) lines.push(`_type: ${f.conflictType}_`);
    if (f.error) lines.push(`_error: ${f.error}_`);
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
      "per conflicted file, its conflictType (both-modified/both-added/both-deleted/" +
      "added-by-us/added-by-them/deleted-by-us/deleted-by-them) plus the parsed ours/theirs " +
      "(and base, for diff3-style markers) hunks.",
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
      const [paths, conflictTypes] = await Promise.all([
        conflictPaths(gitTop),
        getConflictTypes(gitTop),
      ]);
      const withHunks = args.withHunks !== false;
      const maxLinesPerFile = typeof args.maxLinesPerFile === "number" ? args.maxLinesPerFile : 200;

      const files: ConflictFileJson[] = paths.map((p) => {
        const base = withHunks ? readConflictFile(gitTop, p, maxLinesPerFile) : { path: p };
        return {
          ...base,
          ...spreadDefined("conflictType", conflictTypes.get(p)),
        };
      });

      const result: ConflictsJson = {
        ...spreadDefined("state", state),
        files,
      };

      if (args.format === "json") {
        return jsonRespond(result);
      }
      return renderConflictsMarkdown(result);
    },
  });
}
