import { matchesGlob } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { isSafeGitRangeToken } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDE_PATTERNS = [
  "*.lock",
  "*.lockb",
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "*.min.js",
  "*.min.css",
  "vendor/**",
  "node_modules/**",
  "dist/**",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileDiff {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  oldPath?: string;
  /** Present (true) only when the diff body was cut at maxLinesPerFile. */
  truncated?: boolean;
  diff: string;
}

interface DiffSummary {
  range: string;
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: FileDiff[];
  truncatedFiles?: number;
  excludedFiles?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `git diff --numstat` output into exact per-file counts.
 * Format per line: "<additions>\t<deletions>\t<path>"
 * Binary files emit "-\t-\t<path>" and are recorded as 0/0.
 */
export function parseNumstatOutput(
  numstat: string,
): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addStr, delStr, ...pathParts] = parts;
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    const additions = addStr === "-" ? 0 : Number.parseInt(addStr ?? "0", 10);
    const deletions = delStr === "-" ? 0 : Number.parseInt(delStr ?? "0", 10);
    if (!Number.isNaN(additions) && !Number.isNaN(deletions)) {
      result.set(filePath, { additions, deletions });
    }
  }
  return result;
}

/**
 * Parse `git diff` output into per-file chunks.
 * Splits on "diff --git a/..." lines.
 */
function parseDiffOutput(diff: string): Array<{ header: string; body: string }> {
  const chunks: Array<{ header: string; body: string }> = [];
  // Each file section starts with "diff --git"
  const parts = diff.split(/(?=^diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) continue;
    const firstNewline = part.indexOf("\n");
    const header = firstNewline >= 0 ? part.slice(0, firstNewline) : part;
    const body = firstNewline >= 0 ? part.slice(firstNewline + 1) : "";
    chunks.push({ header, body });
  }
  return chunks;
}

/**
 * Extract file paths and status from a diff chunk header + body.
 * Header: "diff --git a/old b/new"
 * Body may contain "rename from", "rename to", "new file mode", "deleted file mode".
 */
function extractFileInfo(
  header: string,
  body: string,
): {
  path: string;
  oldPath?: string;
  status: FileDiff["status"];
} {
  // Parse "diff --git a/X b/Y". For non-renames X === Y; use midpoint split so
  // paths containing " b/" (e.g. "src/b/file.ts") are not mis-parsed by a greedy regex.
  const prefix = "diff --git a/";
  const raw = header.startsWith(prefix) ? header.slice(prefix.length) : "";
  const midLen = (raw.length - " b/".length) / 2;
  let aPath = "";
  let bPath = "";
  if (Number.isInteger(midLen) && midLen > 0) {
    const candidate = raw.slice(0, midLen);
    if (raw.slice(midLen) === ` b/${candidate}`) {
      aPath = candidate;
      bPath = candidate;
    }
  }
  if (!aPath) {
    // Fall back for renames (aPath ≠ bPath); rename paths also come from body lines.
    const headerMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
    aPath = headerMatch?.[1] ?? "";
    bPath = headerMatch?.[2] ?? aPath;
  }

  let status: FileDiff["status"] = "modified";
  let oldPath: string | undefined;

  if (/^new file mode/m.test(body)) {
    status = "added";
  } else if (/^deleted file mode/m.test(body)) {
    status = "deleted";
  } else if (/^rename from /m.test(body)) {
    status = "renamed";
    const fromMatch = /^rename from (.+)$/m.exec(body);
    oldPath = fromMatch?.[1];
    // Prefer the authoritative "rename to <path>" body line over the greedy
    // header regex split, which mis-parses paths containing the literal " b/".
    const toMatch = /^rename to (.+)$/m.exec(body);
    if (toMatch?.[1]) {
      bPath = toMatch[1];
    }
  }

  const path = status === "deleted" ? aPath : bPath;
  return { path, oldPath, status };
}

/**
 * Truncate diff body to at most `maxLines` lines (counting only hunk content lines).
 * Returns { text, truncated }.
 */
function truncateDiffBody(body: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = body.split("\n");
  if (lines.length <= maxLines) {
    return { text: body, truncated: false };
  }
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

/** Check whether a file path matches any of the given glob patterns. */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (matchesGlob(normalized, pattern)) return true;
    // Also match just the basename against simple patterns (e.g. "*.lock")
    const basename = normalized.split("/").at(-1) ?? normalized;
    if (matchesGlob(basename, pattern)) return true;
  }
  return false;
}

/** Build the diff args array from the `range` parameter. */
function buildDiffArgs(
  range: string | undefined,
): { ok: true; args: string[] } | { ok: false; error: string } {
  if (range === undefined || range === "") {
    return { ok: true, args: [] };
  }
  const normalized = range.trim().toLowerCase();
  if (normalized === "staged" || normalized === "cached") {
    return { ok: true, args: ["--cached"] };
  }
  if (normalized === "head") {
    return { ok: true, args: ["HEAD"] };
  }

  // "A..B", "A...B", or a single ref (ancestor notation like "HEAD~3" accepted
  // on any endpoint) — delegates to the shared range validator.
  const trimmed = range.trim();
  if (!isSafeGitRangeToken(trimmed)) {
    return { ok: false, error: `unsafe_range_token: ${range}` };
  }
  return { ok: true, args: [trimmed] };
}

/** Human-readable label for the range. */
function rangeLabel(range: string | undefined, diffArgs: string[]): string {
  if (!range || range === "") return "unstaged changes";
  if (diffArgs[0] === "--cached") return "staged changes";
  return range;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitDiffSummaryTool(server: FastMCP): void {
  server.addTool({
    name: "git_diff_summary",
    description:
      "Structured diff viewer: per-file diffs with counts, truncated to configurable limits. " +
      "Noise files (lock files, dist, etc.) excluded by default. Use `range` to target staged, HEAD, or a revision range.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.extend({
      range: z
        .string()
        .optional()
        .describe(
          'Diff range. Examples: "staged", "HEAD~3..HEAD", "main...feature". ' +
            "Default: unstaged changes.",
        ),
      fileFilter: z
        .string()
        .optional()
        .describe('Glob pattern to restrict output to matching files, e.g. "*.ts", "src/**".'),
      maxLinesPerFile: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .default(50)
        .describe("Max diff lines to include per file. Default: 50."),
      maxFiles: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(30)
        .describe("Max files to include in output. Default: 30."),
      excludePatterns: z
        .array(z.string())
        .optional()
        .describe("Glob patterns to exclude. Default: lock files, dist, vendor, etc."),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      // --- Build git diff args ---
      const diffArgsResult = buildDiffArgs(args.range);
      if (!diffArgsResult.ok) {
        return jsonRespond({ error: diffArgsResult.error });
      }
      const diffArgs = diffArgsResult.args;

      // --- Run git diff --numstat for exact addition/deletion counts ---
      const statResult = await spawnGitAsync(gitTop, ["diff", "--numstat", ...diffArgs]);
      if (!statResult.ok) {
        return jsonRespond({
          error: ERROR_CODES.GIT_DIFF_FAILED,
          detail: (statResult.stderr || statResult.stdout).trim(),
        });
      }
      const statMap = parseNumstatOutput(statResult.stdout);

      // --- Run git diff ---
      const diffResult = await spawnGitAsync(gitTop, ["diff", ...diffArgs]);
      if (!diffResult.ok) {
        return jsonRespond({
          error: ERROR_CODES.GIT_DIFF_FAILED,
          detail: (diffResult.stderr || diffResult.stdout).trim(),
        });
      }

      // --- Parse diff chunks ---
      const chunks = parseDiffOutput(diffResult.stdout);
      const totalFiles = chunks.length;

      // --- Apply excludePatterns and fileFilter ---
      const excludePatterns =
        args.excludePatterns !== undefined ? args.excludePatterns : DEFAULT_EXCLUDE_PATTERNS;
      const excludedFiles: string[] = [];
      const includedChunks: typeof chunks = [];

      for (const chunk of chunks) {
        const { path: filePath } = extractFileInfo(chunk.header, chunk.body);
        if (matchesAnyPattern(filePath, excludePatterns)) {
          excludedFiles.push(filePath);
          continue;
        }
        if (args.fileFilter && !matchesAnyPattern(filePath, [args.fileFilter])) {
          continue;
        }
        includedChunks.push(chunk);
      }

      // --- Truncate to maxFiles ---
      const maxFiles = args.maxFiles ?? 30;
      const maxLinesPerFile = args.maxLinesPerFile ?? 50;
      const truncatedFileCount =
        includedChunks.length > maxFiles ? includedChunks.length - maxFiles : 0;
      const processedChunks = includedChunks.slice(0, maxFiles);

      // --- Build FileDiff entries ---
      let totalAdditions = 0;
      let totalDeletions = 0;
      const files: FileDiff[] = [];

      for (const chunk of processedChunks) {
        const { path: filePath, oldPath, status } = extractFileInfo(chunk.header, chunk.body);
        const stat = statMap.get(filePath) ?? { additions: 0, deletions: 0 };
        totalAdditions += stat.additions;
        totalDeletions += stat.deletions;

        const { text: diffText, truncated } = truncateDiffBody(chunk.body, maxLinesPerFile);
        files.push({
          path: filePath,
          status,
          additions: stat.additions,
          deletions: stat.deletions,
          ...spreadDefined("oldPath", oldPath),
          ...spreadWhen(truncated, { truncated: true }),
          diff: diffText,
        });
      }

      const rangeStr = rangeLabel(args.range, diffArgs);
      const summary: DiffSummary = {
        range: rangeStr,
        totalFiles,
        totalAdditions,
        totalDeletions,
        files,
        ...spreadWhen(truncatedFileCount > 0, { truncatedFiles: truncatedFileCount }),
        ...spreadWhen(excludedFiles.length > 0, { excludedFiles }),
      };

      // --- Format output ---
      if (args.format === "json") {
        return jsonRespond(summary as unknown as Record<string, unknown>);
      }

      // --- Markdown output ---
      const lines: string[] = [];
      lines.push(`# Diff: ${rangeStr}`, "");

      // Summary line
      const fileWord = totalFiles === 1 ? "file" : "files";
      let summaryLine = `**${totalFiles} ${fileWord} changed** (+${totalAdditions} \u2212${totalDeletions})`;
      if (excludedFiles.length > 0) {
        const excWord = excludedFiles.length === 1 ? "file" : "files";
        summaryLine += `, ${excludedFiles.length} ${excWord} excluded (${excludedFiles.join(", ")})`;
      }
      if (truncatedFileCount > 0) {
        summaryLine += `, ${truncatedFileCount} more file(s) omitted (maxFiles=${maxFiles})`;
      }
      lines.push(summaryLine, "");

      for (const file of files) {
        // Section header
        const statusTag = file.status !== "modified" ? `, ${file.status}` : "";
        const renameTag = file.oldPath ? ` (from ${file.oldPath})` : "";
        lines.push(
          `## ${file.path}${renameTag} (+${file.additions} \u2212${file.deletions}${statusTag})`,
        );

        if (file.diff) {
          lines.push("```diff", file.diff.trimEnd(), "```");
        } else {
          lines.push("_(no diff content)_");
        }
        if (file.truncated) {
          lines.push(`_(diff truncated at ${maxLinesPerFile} lines)_`);
        }
        lines.push("");
      }

      return lines.join("\n");
    },
  });
}
