import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { isSafeGitCommitIsh } from "./git-refs.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlameLine {
  line: number;
  sha: string;
  author: string;
  date: string;
  summary: string;
  content: string;
}

/** One contiguous run of lines last touched by the same commit. */
interface BlameGroup {
  sha: string;
  author: string;
  date: string;
  summary: string;
  startLine: number;
  endLine: number;
  lines: { line: number; content: string }[];
}

interface BlameJson {
  ref?: string;
  path: string;
  groups: BlameGroup[];
  truncated?: boolean;
  omittedLines?: number;
}

// ---------------------------------------------------------------------------
// Porcelain parser
// ---------------------------------------------------------------------------

interface ShaMetaCache {
  author: string;
  authorTime: number;
  authorTz: string;
  summary: string;
}

/**
 * Convert a Unix epoch + timezone offset string (e.g. "+0200") to an ISO 8601 string.
 * The tz offset is in the format ±HHMM as emitted by git blame --porcelain.
 */
function epochTzToIso(epoch: number, tz: string): string {
  // tz looks like "+0200" or "-0500"
  const sign = tz.startsWith("-") ? -1 : 1;
  const tzBody = tz.replace(/^[+-]/, "");
  const tzHours = Number.parseInt(tzBody.slice(0, 2), 10);
  const tzMins = Number.parseInt(tzBody.slice(2), 10);
  const offsetMs = sign * (tzHours * 60 + tzMins) * 60 * 1000;
  const localMs = epoch * 1000 + offsetMs;
  const d = new Date(localMs);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const datePart = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const timePart = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  const tzSign = sign >= 0 ? "+" : "-";
  const tzStr = `${tzSign}${pad2(tzHours)}:${pad2(tzMins)}`;
  return `${datePart}T${timePart}${tzStr}`;
}

/**
 * Parse `git blame --porcelain` output into structured lines.
 *
 * Porcelain format per commit block:
 *   <sha> <orig-line> <final-line> [<num-lines>]
 *   author <name>
 *   author-mail <email>
 *   author-time <epoch>
 *   author-tz <±HHMM>
 *   committer ...
 *   summary <msg>
 *   ...
 *   \t<line content>
 *
 * Key-value header lines only appear for the FIRST occurrence of a SHA.
 * Subsequent blocks for the same SHA have only the header line + TAB line.
 */
function parsePorcelain(output: string): BlameLine[] {
  const lines = output.split("\n");
  const metaCache = new Map<string, ShaMetaCache>();
  const result: BlameLine[] = [];

  let i = 0;
  while (i < lines.length) {
    const headerLine = lines[i];
    if (headerLine === undefined || headerLine.trim() === "") {
      i++;
      continue;
    }

    // Header: "<sha40> <origLine> <finalLine> [numLines]"
    const headerMatch = /^([0-9a-f]{40}) \d+ (\d+)/.exec(headerLine);
    if (!headerMatch) {
      i++;
      continue;
    }

    const sha = headerMatch[1] ?? "";
    const finalLine = Number.parseInt(headerMatch[2] ?? "0", 10);
    i++;

    // Collect key-value lines until the TAB-prefixed content line
    let author = "";
    let authorTime = 0;
    let authorTz = "+0000";
    let summary = "";
    let content = "";
    let foundContent = false;

    while (i < lines.length) {
      const l = lines[i];
      if (l === undefined) {
        i++;
        break;
      }
      if (l.startsWith("\t")) {
        content = l.slice(1);
        foundContent = true;
        i++;
        break;
      }
      // Parse known key-value pairs
      if (l.startsWith("author ") && !l.startsWith("author-")) {
        author = l.slice("author ".length);
      } else if (l.startsWith("author-time ")) {
        authorTime = Number.parseInt(l.slice("author-time ".length), 10);
      } else if (l.startsWith("author-tz ")) {
        authorTz = l.slice("author-tz ".length).trim();
      } else if (l.startsWith("summary ")) {
        summary = l.slice("summary ".length);
      }
      i++;
    }

    if (!foundContent) continue;

    // Merge with cache: first occurrence populates cache; subsequent occurrences read it.
    const cached = metaCache.get(sha);
    if (cached === undefined) {
      // First occurrence — we collected the metadata
      metaCache.set(sha, { author, authorTime, summary, authorTz });
    } else {
      // Subsequent occurrence — restore from cache
      author = cached.author;
      authorTime = cached.authorTime;
      authorTz = cached.authorTz;
      summary = cached.summary;
    }

    const date = epochTzToIso(authorTime, authorTz);

    result.push({
      line: finalLine,
      sha,
      author,
      date,
      summary,
      content,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Run-length grouping
// ---------------------------------------------------------------------------

/**
 * Collapse per-line blame records into one group per contiguous same-commit
 * run, so commit metadata (sha/author/date/summary) is emitted once per run
 * instead of once per line.
 */
function groupBlameLines(lines: BlameLine[]): BlameGroup[] {
  const groups: BlameGroup[] = [];
  let current: BlameGroup | undefined;
  for (const l of lines) {
    if (current && current.sha === l.sha && current.endLine === l.line - 1) {
      current.endLine = l.line;
      current.lines.push({ line: l.line, content: l.content });
      continue;
    }
    current = {
      sha: l.sha,
      author: l.author,
      date: l.date,
      summary: l.summary,
      startLine: l.line,
      endLine: l.line,
      lines: [{ line: l.line, content: l.content }],
    };
    groups.push(current);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderBlameMarkdown(result: BlameJson): string {
  const header =
    result.ref !== undefined
      ? `# git blame ${result.ref} -- ${result.path}`
      : `# git blame ${result.path}`;
  const out: string[] = [header];
  for (const g of result.groups) {
    out.push(
      "",
      `## ${g.sha.slice(0, 7)} ${g.author} ${g.date} — ${g.summary} (lines ${g.startLine}–${g.endLine})`,
      "```",
      ...g.lines.map((l) => `${l.line}: ${l.content}`),
      "```",
    );
  }
  if (result.truncated) {
    out.push("", `_(truncated — ${result.omittedLines} more line(s) not shown; raise maxLines)_`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitBlameTool(server: FastMCP): void {
  server.addTool({
    name: "git_blame",
    description:
      "File authorship, grouped into contiguous same-commit line runs (sha, author, date, summary once per run). Optionally restrict to a commit-ish ref and/or a line range.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.extend({
      path: z.string().min(1).describe("Repo-relative path to the file to blame."),
      ref: z
        .string()
        .optional()
        .describe(
          'Optional commit-ish (SHA, branch, tag) to blame at. Ancestor notation is accepted (e.g. "HEAD~3", "main^2").',
        ),
      startLine: z
        .number()
        .int()
        .min(1)
        .max(1000000)
        .optional()
        .describe("First line of the range to blame (1-based). Requires endLine."),
      endLine: z
        .number()
        .int()
        .min(1)
        .max(1000000)
        .optional()
        .describe("Last line of the range to blame (1-based, inclusive). Requires startLine."),
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .default(2000)
        .describe("Max blamed lines to return. Default: 2000."),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const top = pre.gitTop;

      // Path confinement
      const resolved = resolvePathForRepo(args.path as string, top);
      if (!assertRelativePathUnderTop(args.path as string, resolved, top)) {
        return jsonRespond({ error: ERROR_CODES.PATH_ESCAPES_REPO, path: args.path });
      }

      // Ref validation
      if (args.ref !== undefined) {
        if (!isSafeGitCommitIsh(args.ref as string)) {
          return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.ref });
        }
      }

      // Line range validation
      const startLine = args.startLine as number | undefined;
      const endLine = args.endLine as number | undefined;
      if (startLine !== undefined || endLine !== undefined) {
        if (startLine === undefined || endLine === undefined) {
          return jsonRespond({ error: ERROR_CODES.INVALID_LINE_RANGE });
        }
        if (startLine > endLine) {
          return jsonRespond({ error: ERROR_CODES.INVALID_LINE_RANGE });
        }
      }

      // Build git blame args
      const blameArgs: string[] = ["blame", "--porcelain"];
      if (args.ref !== undefined) {
        blameArgs.push(args.ref as string);
      }
      if (startLine !== undefined && endLine !== undefined) {
        blameArgs.push(`-L${startLine},${endLine}`);
      }
      blameArgs.push("--", args.path as string);

      const r = await spawnGitAsync(top, blameArgs);
      if (!r.ok) {
        return jsonRespond({
          error: ERROR_CODES.GIT_BLAME_FAILED,
          detail: (r.stderr || r.stdout).trim(),
        });
      }

      const allLines = parsePorcelain(r.stdout);
      const maxLines = (args.maxLines as number | undefined) ?? 2000;
      const truncated = allLines.length > maxLines;
      const blameLines = truncated ? allLines.slice(0, maxLines) : allLines;

      const blameJson: BlameJson = {
        ...spreadDefined("ref", args.ref as string | undefined),
        path: args.path as string,
        groups: groupBlameLines(blameLines),
        ...spreadWhen(truncated, {
          truncated: true,
          omittedLines: allLines.length - maxLines,
        }),
      };

      if (args.format === "json") {
        return jsonRespond(blameJson as unknown as Record<string, unknown>);
      }

      return renderBlameMarkdown(blameJson);
    },
  });
}
