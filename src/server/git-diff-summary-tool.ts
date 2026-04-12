import { matchesGlob } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { gitTopLevel, isSafeGitUpstreamToken, spawnGitAsync } from "./git.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireGitAndRoots } from "./roots.js";
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
  truncated: boolean;
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
 * Parse `git diff --stat` output into per-file stats.
 * Format: " path/to/file | N ++++---"
 * Final line: " N files changed, N insertions(+), N deletions(-)"
 */
function parseStatOutput(stat: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of stat.split("\n")) {
    // Skip the summary line and blank lines
    if (!line.includes("|")) continue;
    const pipeIdx = line.indexOf("|");
    const filePart = line.slice(0, pipeIdx).trim();
    const statPart = line.slice(pipeIdx + 1).trim();
    // statPart looks like "5 ++---" or "3 +++", count + and -
    const additions = (statPart.match(/\+/g) ?? []).length;
    const deletions = (statPart.match(/-/g) ?? []).length;
    result.set(filePart, { additions, deletions });
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
  // Parse "diff --git a/X b/Y"
  const headerMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  const aPath = headerMatch?.[1] ?? "";
  const bPath = headerMatch?.[2] ?? aPath;

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

  // Range like "A..B", "A...B", or a single ref
  // Split on ".." or "..." separators to validate each token
  const separatorMatch = /^(.+?)(\.{2,3})(.+)$/.exec(range.trim());
  if (separatorMatch) {
    const [, left, sep, right] = separatorMatch;
    if (!isSafeGitUpstreamToken(left ?? "") || !isSafeGitUpstreamToken(right ?? "")) {
      return { ok: false, error: `unsafe_range_token: ${range}` };
    }
    return { ok: true, args: [`${left}${sep}${right}`] };
  }

  // Single ref
  if (!isSafeGitUpstreamToken(range.trim())) {
    return { ok: false, error: `unsafe_range_token: ${range}` };
  }
  return { ok: true, args: [range.trim()] };
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
      "Structured, token-efficient diff viewer. Returns per-file diffs with additions/deletions, " +
      "truncated to configurable line limits, with noise files (lock files, dist, etc.) excluded by default. " +
      "Use `range` to target staged, HEAD, or any revision range. See docs/mcp-tools.md.",
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
        .describe(
          "Glob patterns to exclude. Defaults to common noise: lock files, dist, vendor, etc.",
        ),
    }),
    execute: async (args) => {
      // --- Standard prelude ---
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) return jsonRespond(pre.error);

      const rootInput = pre.roots[0];
      if (!rootInput) return jsonRespond({ error: "no_workspace_root" });

      const gitTop = gitTopLevel(rootInput);
      if (!gitTop) {
        return jsonRespond({ error: "not_a_git_repository", path: rootInput });
      }

      // --- Build git diff args ---
      const diffArgsResult = buildDiffArgs(args.range);
      if (!diffArgsResult.ok) {
        return jsonRespond({ error: diffArgsResult.error });
      }
      const diffArgs = diffArgsResult.args;

      // --- Run git diff --stat ---
      const statResult = await spawnGitAsync(gitTop, ["diff", "--stat", ...diffArgs]);
      if (!statResult.ok) {
        return jsonRespond({
          error: "git_diff_failed",
          detail: (statResult.stderr || statResult.stdout).trim(),
        });
      }
      const statMap = parseStatOutput(statResult.stdout);

      // --- Run git diff ---
      const diffResult = await spawnGitAsync(gitTop, ["diff", ...diffArgs]);
      if (!diffResult.ok) {
        return jsonRespond({
          error: "git_diff_failed",
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
          truncated,
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
