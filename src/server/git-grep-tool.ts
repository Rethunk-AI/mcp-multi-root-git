import { basename } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import {
  asyncPool,
  GIT_SUBPROCESS_PARALLELISM,
  gitTopLevel,
  resolveGitSubprocessMaxBufferBytes,
  spawnGitAsync,
} from "./git.js";
import { isSafeGitAncestorRef } from "./git-refs.js";
import { jsonRespond, spreadWhen } from "./json.js";
import { requireGitAndRoots } from "./roots.js";
import { RootPickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MATCHES_HARD_CAP = 1000;
const DEFAULT_MAX_MATCHES = 200;
/** Max entries accepted in `paths` per call. */
const MAX_PATHS = 256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PickaxeCommit {
  sha: string;
  subject: string;
}

interface GrepRootJson {
  root: string;
  repo: string;
  commits?: PickaxeCommit[];
  truncated?: boolean;
  error?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunPickaxeOpts {
  top: string;
  mode: "S" | "G";
  term: string;
  ref?: string;
  paths: string[];
  ignoreCase: boolean;
  maxMatches: number;
}

type RunPickaxeResult =
  | { commits: PickaxeCommit[]; truncated: boolean }
  | { error: string; detail: string };

/** Run `git log -S` / `-G` pickaxe history search for a single repo root. */
async function runPickaxe(opts: RunPickaxeOpts): Promise<RunPickaxeResult> {
  const { top, mode, term, ref, paths, ignoreCase, maxMatches } = opts;

  const args: string[] = [
    "log",
    "--pretty=format:%H%x01%s",
    "-n",
    String(maxMatches + 1),
    mode === "S" ? "-S" : "-G",
    term,
  ];
  // `-i` / `--regexp-ignore-case` affects `-G` (and `--grep`); harmless on `-S`.
  if (ignoreCase) args.push("-i");
  if (ref) args.push(ref);
  if (paths.length > 0) args.push("--", ...paths);

  const r = await spawnGitAsync(top, args, {
    maxBufferBytes: resolveGitSubprocessMaxBufferBytes(),
  });
  // A subprocess-level buffer cap (r.truncated) still yields a usable partial
  // commit list — parse and return it instead of failing outright.
  if (!r.ok && !r.truncated) {
    return {
      error: ERROR_CODES.GIT_GREP_FAILED,
      detail: r.stderr.trim() || r.stdout.trim(),
    };
  }

  const commits: PickaxeCommit[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const sep = line.indexOf("\x01");
    if (sep < 0) continue;
    const sha = line.slice(0, sep).trim();
    const subject = line.slice(sep + 1).trim();
    if (sha) commits.push({ sha, subject });
  }

  const capTruncated = commits.length > maxMatches;
  return {
    commits: capTruncated ? commits.slice(0, maxMatches) : commits,
    truncated: capTruncated || r.truncated === true,
  };
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

  const commits = group.commits ?? [];
  if (commits.length === 0) {
    lines.push("_(no pickaxe hits)_");
  } else {
    for (const c of commits) {
      lines.push(`- \`${c.sha.slice(0, 7)}\`  ${c.subject}`);
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
      "Pickaxe history search across one or more roots: which commits added or removed a term " +
      '(`git log -S`) or changed lines matching a regex (`git log -G`), via `pickaxe: { mode: "S"|"G", term }`. ' +
      "Returns `commits[]` (sha + subject) per root. Set `ref` to limit history to that tip. " +
      "Case-sensitive by default (opt into `ignoreCase`) — unlike `git_log`'s `grep`, which is " +
      "case-insensitive by default. `G` mode regex complexity is bounded only by the subprocess " +
      "timeout, not rejected upfront. " +
      "For working-tree content search use the client's native grep/rg tooling instead — " +
      "content mode was removed in v6.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: RootPickSchema.extend({
      pickaxe: z
        .object({
          mode: z
            .enum(["S", "G"])
            .describe("`S` = pickaxe string (`git log -S`); `G` = pickaxe regex (`git log -G`)."),
          term: z.string().min(1).max(500).describe("Search term / regex for pickaxe history."),
        })
        .describe("Pickaxe history search. Returns `commits[]` (sha + subject) per root."),
      ref: z
        .string()
        .optional()
        .describe("Commit/branch/tag to use as the history tip. Must be a safe ref token."),
      path: z.string().optional().describe("Limit history to this path. Unioned with `paths`."),
      paths: z
        .array(z.string())
        .max(MAX_PATHS)
        .optional()
        .describe(
          `Limit history to these paths (max ${MAX_PATHS}, must resolve within the repo root).`,
        ),
      ignoreCase: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Case-insensitive match (`-i`; affects `G` mode regexes). Default false (case-sensitive) — see `git_log`'s `grep`/`ignoreCase` for the opposite default.",
        ),
      maxMatches: z
        .number()
        .int()
        .min(1)
        .max(MAX_MATCHES_HARD_CAP)
        .optional()
        .default(DEFAULT_MAX_MATCHES)
        .describe(
          `Max commits per root (hard cap ${MAX_MATCHES_HARD_CAP}, default ${DEFAULT_MAX_MATCHES}).`,
        ),
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) return jsonRespond(pre.error);

      const pickaxe = args.pickaxe;

      if (args.ref !== undefined && !isSafeGitAncestorRef(args.ref)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: args.ref });
      }
      const ref = args.ref?.trim() || undefined;

      // Union singular `path` + `paths` array (dedup, order preserved).
      const rawPathsInput: string[] = [];
      const singlePath = args.path?.trim();
      if (singlePath) rawPathsInput.push(singlePath);
      if (Array.isArray(args.paths)) {
        for (const p of args.paths) {
          if (typeof p === "string" && p.trim()) rawPathsInput.push(p.trim());
        }
      }
      const rawPaths = [...new Set(rawPathsInput)];

      // The `??` fallbacks below are defense-in-depth: production calls are
      // always zod-validated (defaults applied) before reaching `execute`,
      // but the test harness invokes `execute` directly with raw args.
      const ignoreCase = args.ignoreCase ?? false;
      const maxMatches = Math.min(args.maxMatches ?? DEFAULT_MAX_MATCHES, MAX_MATCHES_HARD_CAP);

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

          const result = await runPickaxe({
            top,
            mode: pickaxe.mode,
            term: pickaxe.term,
            ref,
            paths: rawPaths,
            ignoreCase,
            maxMatches,
          });
          if ("error" in result) {
            return { root: top, repo: basename(top), error: result.error, detail: result.detail };
          }
          return {
            root: top,
            repo: basename(top),
            commits: result.commits,
            ...spreadWhen(result.truncated, { truncated: true }),
          };
        },
      );

      if (args.format === "json") {
        return jsonRespond({ results: groups });
      }

      const mdChunks = ["# git grep", ...groups.map((g) => renderGrepMarkdown(g))];
      return mdChunks.join("\n\n");
    },
  });
}
