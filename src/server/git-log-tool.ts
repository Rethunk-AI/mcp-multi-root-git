import { basename } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { asyncPool, GIT_SUBPROCESS_PARALLELISM, gitTopLevel, spawnGitAsync } from "./git.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireGitAndRoots } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_COMMITS_HARD_CAP = 500;
const DEFAULT_MAX_COMMITS = 50;
const DEFAULT_SINCE = "7.days";

// Field separator written by git into stdout — we use git's %x01 (SOH) escape.
// The format string itself is safe ASCII; git emits the byte.
const FIELD_SEP_OUT = "\x01"; // what git outputs (SOH)
const RECORD_SEP_OUT = "\x02"; // what git outputs (STX) — used as record-START marker

// git log --pretty tformat: sha7, shaFull, subject, author, email, ISO date, relative date.
// %x02 is placed at the START of each record (tformat adds \n as terminator after each).
// Splitting stdout on \x02 then gives empty-first-chunk + one chunk per commit,
// each structured as:  <fields>\x01\n\n <shortstat text>\n
// Fields are separated by %x01; the trailing \x01 before \n leaves one empty last field (ignored).
const PRETTY_FORMAT = "%x02%h%x01%H%x01%s%x01%aN%x01%aE%x01%aI%x01%ar%x01";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommitJson {
  sha7: string;
  shaFull: string;
  subject: string;
  author: string;
  email: string;
  date: string;
  ageRelative: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

interface LogGroupJson {
  workspace_root: string;
  repo: string;
  branch: string;
  commits: CommitJson[];
  truncated?: boolean;
  omittedCount?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a shortstat line like "3 files changed, 12 insertions(+), 5 deletions(-)"
 * Returns undefined when the line doesn't match (e.g. empty diff).
 */
function parseShortstat(
  line: string,
): { filesChanged: number; insertions: number; deletions: number } | undefined {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(
    line,
  );
  if (!m) return undefined;
  return {
    filesChanged: parseInt(m[1] ?? "0", 10),
    insertions: parseInt(m[2] ?? "0", 10),
    deletions: parseInt(m[3] ?? "0", 10),
  };
}

/**
 * Fetch the current branch name (or detached HEAD fallback).
 */
async function gitCurrentBranch(cwd: string, branchArg: string | undefined): Promise<string> {
  if (branchArg?.trim()) return branchArg.trim();
  const r = await spawnGitAsync(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.ok) return r.stdout.trim();
  return "HEAD";
}

interface LogResult {
  workspace_root: string;
  repo: string;
  branch: string;
  commits: CommitJson[];
  truncated: boolean;
  omittedCount: number;
}

/**
 * Run git log for a single repo root and return structured data.
 */
async function runGitLog(opts: {
  top: string;
  since: string;
  paths: string[];
  grep: string | undefined;
  author: string | undefined;
  maxCommits: number;
  branch: string | undefined;
}): Promise<LogResult | { error: string; path: string }> {
  const { top, since, paths, grep, author, maxCommits, branch } = opts;

  // Resolve branch first (needed for output metadata).
  const resolvedBranch = await gitCurrentBranch(top, branch);

  // Fetch one extra commit to detect truncation.
  const fetchLimit = maxCommits + 1;

  const logArgs: string[] = [
    "log",
    `--pretty=tformat:${PRETTY_FORMAT}`,
    "--shortstat",
    `-n`,
    String(fetchLimit),
    `--since=${since}`,
  ];

  if (branch?.trim()) {
    logArgs.push(branch.trim());
  }

  if (grep?.trim()) {
    logArgs.push(`--grep=${grep.trim()}`, "-i");
  }

  if (author?.trim()) {
    logArgs.push(`--author=${author.trim()}`);
  }

  if (paths.length > 0) {
    logArgs.push("--", ...paths);
  }

  const r = await spawnGitAsync(top, logArgs);
  if (!r.ok) {
    return {
      error: "git_log_failed",
      path: top,
    };
  }

  // Parse output.
  // git log --pretty=tformat:%x02<fields>%x01 --shortstat emits, per commit:
  //   \x02<fields separated by SOH>\x01\n\n <shortstat line>\n
  // The \x02 is a record-START marker. Splitting on \x02 gives an empty first chunk
  // followed by one chunk per commit. Each chunk is:
  //   <fields>\x01\n\n <shortstat>\n
  const raw = r.stdout;
  const recordChunks = raw.split(RECORD_SEP_OUT).slice(1); // drop leading empty

  const allCommits: CommitJson[] = [];

  for (const chunk of recordChunks) {
    if (!chunk.trim()) continue;
    // Fields before the first newline; shortstat (if any) follows blank line.
    const newlineIdx = chunk.indexOf("\n");
    const fieldsPart = newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk;
    const statPart = newlineIdx >= 0 ? chunk.slice(newlineIdx + 1) : "";

    const fields = fieldsPart.split(FIELD_SEP_OUT);
    const [sha7, shaFull, subject, authorName, email, date, ageRelative] = fields;

    if (!sha7 || !shaFull) continue;

    const stat = parseShortstat(statPart);

    const commit: CommitJson = {
      sha7: sha7.trim(),
      shaFull: shaFull.trim(),
      subject: subject?.trim() ?? "",
      author: authorName?.trim() ?? "",
      email: email?.trim() ?? "",
      date: date?.trim() ?? "",
      ageRelative: ageRelative?.trim() ?? "",
      ...spreadDefined("filesChanged", stat?.filesChanged),
      ...spreadDefined("insertions", stat?.insertions),
      ...spreadDefined("deletions", stat?.deletions),
    };
    allCommits.push(commit);
  }

  const truncated = allCommits.length > maxCommits;
  const commits = truncated ? allCommits.slice(0, maxCommits) : allCommits;
  const omittedCount = truncated ? allCommits.length - maxCommits : 0;

  return {
    workspace_root: top,
    repo: basename(top),
    branch: resolvedBranch,
    commits,
    truncated,
    omittedCount,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderLogMarkdown(group: LogResult, filterSummary: string): string {
  const lines: string[] = [];
  lines.push(`### ${group.repo} (${group.branch})${filterSummary ? `  —  ${filterSummary}` : ""}`);
  lines.push(`_root: ${group.workspace_root}_`);
  lines.push("");

  if (group.commits.length === 0) {
    lines.push("_(no commits match)_");
  } else {
    for (const c of group.commits) {
      lines.push(`- \`${c.sha7}\`  ${c.ageRelative}  ${c.subject}  —  ${c.author}`);
    }
  }

  if (group.truncated) {
    lines.push("");
    lines.push(
      `_(truncated — ${group.omittedCount} more commit(s) not shown; lower \`since\` or \`maxCommits\`)_`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitLogTool(server: FastMCP): void {
  server.addTool({
    name: "git_log",
    description:
      "Path-filtered, time-windowed read-only `git log` across one or more workspace roots. " +
      "Returns structured commit history with author, date, subject, and optional diff stats. " +
      "See docs/mcp-tools.md.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.extend({
      since: z
        .string()
        .optional()
        .describe(
          "Passed to `git log --since=`. Accepts ISO timestamps or git relative forms like " +
            "`48.hours` or `2.weeks.ago`. Default: `7.days`.",
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe("Limit to commits touching these paths (passed as `-- <paths>`)."),
      grep: z
        .string()
        .optional()
        .describe(
          "Filter commits whose message matches this regex (git `--grep`, case-insensitive).",
        ),
      author: z
        .string()
        .optional()
        .describe("Filter by author name or email (passed as `--author=`)."),
      maxCommits: z
        .number()
        .int()
        .min(1)
        .max(MAX_COMMITS_HARD_CAP)
        .optional()
        .default(DEFAULT_MAX_COMMITS)
        .describe(
          `Maximum commits to return per root (hard cap ${MAX_COMMITS_HARD_CAP}). Default ${DEFAULT_MAX_COMMITS}.`,
        ),
      branch: z.string().optional().describe("Ref/branch to log from. Default: HEAD."),
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) return jsonRespond(pre.error);

      // Validate `since` — reject obvious injection attempts (newlines, semicolons, shell chars).
      const rawSince = (args.since?.trim() ?? DEFAULT_SINCE) || DEFAULT_SINCE;
      if (/[\n\r;|&`$<>]/.test(rawSince)) {
        return jsonRespond({ error: "invalid_since", since: rawSince });
      }

      // Validate paths — reject anything with null bytes or shell meta.
      // Use charCodeAt(0) === 0 for the null byte to avoid a biome lint on control chars in regex.
      const rawPaths = args.paths ?? [];
      for (const p of rawPaths) {
        if (p.split("").some((c) => c.charCodeAt(0) === 0) || /[\n\r;|&`$<>]/.test(p)) {
          return jsonRespond({ error: "invalid_paths", path: p });
        }
      }

      const maxCommits = Math.min(args.maxCommits ?? DEFAULT_MAX_COMMITS, MAX_COMMITS_HARD_CAP);

      // Fan out across roots.
      const jobs = pre.roots.map((rootInput) => ({ rootInput }));
      const results = await asyncPool(jobs, GIT_SUBPROCESS_PARALLELISM, async ({ rootInput }) => {
        const top = gitTopLevel(rootInput);
        if (!top) {
          return { _error: true as const, workspace_root: rootInput, error: "not_a_git_repo" };
        }
        const r = await runGitLog({
          top,
          since: rawSince,
          paths: rawPaths,
          grep: args.grep,
          author: args.author,
          maxCommits,
          branch: args.branch,
        });
        if ("error" in r) {
          return { _error: true as const, workspace_root: rootInput, error: r.error };
        }
        return { _error: false as const, ...r };
      });

      // Build filter summary string for markdown.
      const filterParts: string[] = [`since: ${rawSince}`];
      if (rawPaths.length > 0) filterParts.push(`paths: ${rawPaths.join(", ")}`);
      if (args.grep) filterParts.push(`grep: ${args.grep}`);
      if (args.author) filterParts.push(`author: ${args.author}`);
      const filterSummary = filterParts.join(" | ");

      if (args.format === "json") {
        const groups: LogGroupJson[] = results.map((r) => {
          if (r._error) {
            return {
              workspace_root: r.workspace_root,
              repo: basename(r.workspace_root),
              branch: "",
              commits: [],
              ...spreadWhen(true, { error: r.error }),
            } as unknown as LogGroupJson;
          }
          const { _error: _e, ...rest } = r;
          return {
            ...rest,
            ...spreadWhen(r.truncated, { truncated: true, omittedCount: r.omittedCount }),
          } as LogGroupJson;
        });
        return jsonRespond({ groups } as unknown as Record<string, unknown>);
      }

      // Markdown
      const mdChunks: string[] = ["# Git log"];
      for (const r of results) {
        if (r._error) {
          mdChunks.push(`### ${r.workspace_root}\n_error: ${r.error}_`);
          continue;
        }
        const { _error: _e, ...group } = r;
        mdChunks.push(renderLogMarkdown(group, filterSummary));
      }
      return mdChunks.join("\n\n");
    },
  });
}
