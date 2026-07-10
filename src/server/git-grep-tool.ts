import { basename } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { asyncPool, GIT_SUBPROCESS_PARALLELISM, gitTopLevel, spawnGitAsync } from "./git.js";
import { isSafeGitAncestorRef } from "./git-refs.js";
import { jsonRespond, spreadWhen } from "./json.js";
import { requireGitAndRoots } from "./roots.js";
import { RootPickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MATCHES_HARD_CAP = 1000;
const DEFAULT_MAX_MATCHES = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

interface GrepRootJson {
  root: string;
  repo: string;
  matches?: GrepMatch[];
  files?: string[];
  truncated?: boolean;
  error?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `git grep` prefixes each output line with `<ref>:` when a tree-ish is given
 * (e.g. `main:src/foo.ts:3:some text`). `isSafeGitAncestorRef` forbids `:` in
 * ref tokens, so a plain prefix strip is safe and unambiguous.
 */
function stripRefPrefix(line: string, ref: string | undefined): string {
  if (!ref) return line;
  const prefix = `${ref}:`;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

/**
 * Parse a `git grep -n` content line: `<file>:<line>:<text>`. File paths may
 * themselves contain digits or colons, so match non-greedily up to the first
 * `:<digits>:` boundary — the earliest such split is always the line-number field.
 */
function parseMatchLine(line: string): GrepMatch | undefined {
  const m = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!m) return undefined;
  const file = m[1] ?? "";
  if (!file) return undefined;
  return { file, line: Number.parseInt(m[2] ?? "0", 10), text: m[3] ?? "" };
}

interface RunGrepOpts {
  top: string;
  pattern: string;
  ref?: string;
  paths: string[];
  ignoreCase: boolean;
  filesOnly: boolean;
  maxMatches: number;
}

type RunGrepResult =
  | { matches: GrepMatch[]; truncated: boolean }
  | { files: string[]; truncated: boolean }
  | { error: string; detail: string };

/** Run `git grep` for a single repo root and return structured, truncation-capped results. */
async function runGitGrep(opts: RunGrepOpts): Promise<RunGrepResult> {
  const { top, pattern, ref, paths, ignoreCase, filesOnly, maxMatches } = opts;

  const args: string[] = ["grep", "-n"];
  if (ignoreCase) args.push("-i");
  if (filesOnly) args.push("-l");
  args.push("-e", pattern);
  if (ref) args.push(ref);
  if (paths.length > 0) args.push("--", ...paths);

  const r = await spawnGitAsync(top, args);

  if (!r.ok) {
    const stdoutTrimmed = r.stdout.trim();
    const stderrTrimmed = r.stderr.trim();
    // `git grep` exits 1 (not 0) when the pattern simply isn't found — that's
    // success with an empty result set, not a failure. A real failure (bad
    // pattern, unknown ref, etc.) always writes to stderr.
    if (stdoutTrimmed === "" && stderrTrimmed === "") {
      return filesOnly ? { files: [], truncated: false } : { matches: [], truncated: false };
    }
    return { error: ERROR_CODES.GIT_GREP_FAILED, detail: stderrTrimmed || stdoutTrimmed };
  }

  const rawLines = r.stdout.split("\n").filter((l) => l.length > 0);

  if (filesOnly) {
    const files = rawLines.map((l) => stripRefPrefix(l, ref)).filter((f) => f.length > 0);
    const truncated = files.length > maxMatches;
    return { files: truncated ? files.slice(0, maxMatches) : files, truncated };
  }

  const matches: GrepMatch[] = [];
  for (const line of rawLines) {
    const parsed = parseMatchLine(stripRefPrefix(line, ref));
    if (parsed) matches.push(parsed);
  }
  const truncated = matches.length > maxMatches;
  return { matches: truncated ? matches.slice(0, maxMatches) : matches, truncated };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderGrepMarkdown(group: GrepRootJson): string {
  const lines: string[] = [`### ${group.repo}`, `_root: ${group.root}_`, ""];

  if (group.error) {
    lines.push(`_error: ${group.error}${group.detail ? ` — ${group.detail}` : ""}_`);
    return lines.join("\n");
  }

  if (group.files) {
    if (group.files.length === 0) {
      lines.push("_(no matching files)_");
    } else {
      for (const f of group.files) lines.push(`- ${f}`);
    }
  } else {
    const matches = group.matches ?? [];
    if (matches.length === 0) {
      lines.push("_(no matches)_");
    } else {
      for (const m of matches) lines.push(`- \`${m.file}:${m.line}\`  ${m.text}`);
    }
  }

  if (group.truncated) {
    lines.push("", "_(truncated — raise `maxMatches` for the full result set)_");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitGrepTool(server: FastMCP): void {
  server.addTool({
    name: "git_grep",
    description:
      "Read-only content search (`git grep -n`) across one or more roots. `pattern` is always " +
      "passed via `-e`, so leading-dash patterns are safe; it is a basic git-grep regex, not literal text. " +
      "Set `ref` to search the tree at that commit/branch instead of the working tree. " +
      "`filesOnly: true` lists matching file paths instead of match lines. " +
      "Pickaxe / history content search (`-S`/`-G`) is out of scope — use `git_log` for commit metadata search.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: RootPickSchema.extend({
      pattern: z
        .string()
        .min(1)
        .max(500)
        .describe("Search pattern (basic regex), always passed as `-e <pattern>`."),
      ref: z
        .string()
        .optional()
        .describe(
          "Commit/branch/tag to search the tree at, instead of the working tree. Must be a safe ref token.",
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe("Limit search to these paths (must resolve within the repo root)."),
      ignoreCase: z.boolean().optional().default(false).describe("Case-insensitive match (`-i`)."),
      filesOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("List matching file paths only (`-l`), omitting line/text detail."),
      maxMatches: z
        .number()
        .int()
        .min(1)
        .max(MAX_MATCHES_HARD_CAP)
        .optional()
        .default(DEFAULT_MAX_MATCHES)
        .describe(
          `Max matches (or files, when \`filesOnly\`) per root (hard cap ${MAX_MATCHES_HARD_CAP}, default ${DEFAULT_MAX_MATCHES}).`,
        ),
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) return jsonRespond(pre.error);

      const pattern = args.pattern as string;

      if (args.ref !== undefined && !isSafeGitAncestorRef(args.ref as string)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.ref });
      }
      const ref = (args.ref as string | undefined)?.trim() || undefined;

      const rawPaths = Array.isArray(args.paths) ? (args.paths as string[]) : [];

      const ignoreCase = (args.ignoreCase as boolean | undefined) ?? false;
      const filesOnly = (args.filesOnly as boolean | undefined) ?? false;
      const maxMatches = Math.min(
        (args.maxMatches as number | undefined) ?? DEFAULT_MAX_MATCHES,
        MAX_MATCHES_HARD_CAP,
      );

      // Fan out across roots. Path confinement is per-root since each root has
      // its own git toplevel.
      const jobs = pre.roots.map((rootInput) => ({ rootInput }));
      const groups: GrepRootJson[] = await asyncPool(
        jobs,
        GIT_SUBPROCESS_PARALLELISM,
        async ({ rootInput }): Promise<GrepRootJson> => {
          const top = gitTopLevel(rootInput);
          if (!top) {
            return {
              root: rootInput,
              repo: basename(rootInput),
              error: ERROR_CODES.NOT_A_GIT_REPOSITORY,
              detail: rootInput,
            };
          }

          for (const p of rawPaths) {
            const resolved = resolvePathForRepo(p, top);
            if (!assertRelativePathUnderTop(p, resolved, top)) {
              return {
                root: top,
                repo: basename(top),
                error: ERROR_CODES.PATH_ESCAPES_REPO,
                detail: p,
              };
            }
          }

          const result = await runGitGrep({
            top,
            pattern,
            ref,
            paths: rawPaths,
            ignoreCase,
            filesOnly,
            maxMatches,
          });

          if ("error" in result) {
            return { root: top, repo: basename(top), error: result.error, detail: result.detail };
          }

          return {
            root: top,
            repo: basename(top),
            ...("files" in result
              ? { files: result.files }
              : { matches: (result as { matches: GrepMatch[] }).matches }),
            ...spreadWhen(result.truncated, { truncated: true }),
          };
        },
      );

      if (args.format === "json") {
        return jsonRespond({ results: groups } as unknown as Record<string, unknown>);
      }

      const mdChunks = ["# git grep", ...groups.map((g) => renderGrepMarkdown(g))];
      return mdChunks.join("\n\n");
    },
  });
}
