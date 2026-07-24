import { join, resolve } from "node:path";

import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { isStrictlyUnderGitTop } from "../repo-paths.js";
import {
  asyncPool,
  createTopLevelMemo,
  GIT_SUBPROCESS_PARALLELISM,
  gitStatusShortBranchAsync,
  hasGitMetadata,
  parseGitSubmodulePaths,
} from "./git.js";
import { jsonRespond, spreadWhen } from "./json.js";
import { requireGitAndRootsAsync } from "./roots.js";
import { RootPickSchema } from "./schemas.js";

/** Default / hard cap on changed-file lines retained per repo's statusText. */
const MAX_CHANGED_FILES_DEFAULT = 500;
const MAX_CHANGED_FILES_HARD_CAP = 20000;

/** Default / hard cap on submodules fanned out to per root. */
const MAX_SUBMODULES_DEFAULT = 64;
const MAX_SUBMODULES_HARD_CAP = 256;

/**
 * Cap the changed-file lines in a `git status --short -b` text blob, keeping
 * the leading `##` branch header (if present) uncapped.
 */
function capChangedFileLines(
  text: string,
  maxChangedFiles: number,
): { text: string; truncated: boolean; omittedCount: number } {
  if (!text) return { text, truncated: false, omittedCount: 0 };
  const lines = text.split("\n");
  const headerLines = lines[0]?.startsWith("##") ? 1 : 0;
  const fileLines = lines.slice(headerLines);
  if (fileLines.length <= maxChangedFiles) {
    return { text, truncated: false, omittedCount: 0 };
  }
  const omittedCount = fileLines.length - maxChangedFiles;
  const capped = [...lines.slice(0, headerLines), ...fileLines.slice(0, maxChangedFiles)];
  return { text: capped.join("\n"), truncated: true, omittedCount };
}

export function registerGitStatusTool(server: FastMCP): void {
  server.addTool({
    name: "git_status",
    description: "Read-only `git status --short -b` per root + submodules.",
    annotations: {
      title: "Git Status",
      readOnlyHint: true,
      openWorldHint: false,
    },
    parameters: RootPickSchema.extend({
      includeSubmodules: z.boolean().optional().default(true),
      maxChangedFiles: z
        .number()
        .int()
        .min(1)
        .max(MAX_CHANGED_FILES_HARD_CAP)
        .optional()
        .default(MAX_CHANGED_FILES_DEFAULT)
        .describe(`Cap changed-file lines per repo (hard cap ${MAX_CHANGED_FILES_HARD_CAP}).`),
      maxSubmodules: z
        .number()
        .int()
        .min(1)
        .max(MAX_SUBMODULES_HARD_CAP)
        .optional()
        .default(MAX_SUBMODULES_DEFAULT)
        .describe(`Cap submodules fanned out to per root (hard cap ${MAX_SUBMODULES_HARD_CAP}).`),
    }),
    execute: async (args, context) => {
      const pre = await requireGitAndRootsAsync(server, args, undefined, context.sessionId);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const maxChangedFiles = args.maxChangedFiles ?? MAX_CHANGED_FILES_DEFAULT;
      const maxSubmodules = args.maxSubmodules ?? MAX_SUBMODULES_DEFAULT;
      const includeSubmodules = args.includeSubmodules !== false;

      type RepoRow = {
        label: string;
        path: string;
        statusText: string;
        ok: boolean;
        changedFilesTruncated?: boolean;
        changedFilesOmittedCount?: number;
      };
      type Group = {
        mcpRoot: string;
        repos: RepoRow[];
        submodulesTruncated?: boolean;
        submodulesOmittedCount?: number;
      };
      type Job =
        | { kind: "self"; rootIndex: number; top: string }
        | { kind: "submodule"; rootIndex: number; top: string; rel: string };

      async function runJob(job: Job): Promise<RepoRow> {
        if (job.kind === "self") {
          const meta = await gitStatusShortBranchAsync(job.top);
          const metaCap = meta.ok ? capChangedFileLines(meta.text, maxChangedFiles) : undefined;
          return {
            label: ".",
            path: job.top,
            statusText: metaCap ? metaCap.text : meta.text,
            ok: meta.ok,
            ...spreadWhen(metaCap?.truncated ?? false, {
              changedFilesTruncated: true,
              changedFilesOmittedCount: metaCap?.omittedCount ?? 0,
            }),
          };
        }
        // One throwing job must not fail the whole batch — contain it as a
        // per-submodule error row instead of letting asyncPool's Promise.all reject.
        try {
          const subPath = resolve(join(job.top, job.rel));
          if (!isStrictlyUnderGitTop(subPath, job.top)) {
            return {
              label: job.rel,
              path: subPath,
              statusText: "(submodule path escapes repository — rejected)",
              ok: false,
            };
          }
          if (!hasGitMetadata(subPath)) {
            return {
              label: job.rel,
              path: subPath,
              statusText: "(no .git — submodule not checked out?)",
              ok: false,
            };
          }
          const st = await gitStatusShortBranchAsync(subPath);
          const stCap = st.ok ? capChangedFileLines(st.text, maxChangedFiles) : undefined;
          return {
            label: job.rel,
            path: subPath,
            statusText: stCap ? stCap.text : st.text,
            ok: st.ok,
            ...spreadWhen(stCap?.truncated ?? false, {
              changedFilesTruncated: true,
              changedFilesOmittedCount: stCap?.omittedCount ?? 0,
            }),
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            label: job.rel,
            path: resolve(join(job.top, job.rel)),
            statusText: `(submodule status collection failed: ${msg})`,
            ok: false,
          };
        }
      }

      // Phase 1: resolve every root's toplevel concurrently (bounded pool,
      // per-call memoized) instead of one blocking call per root in sequence.
      const topMemo = createTopLevelMemo();
      const tops = await asyncPool(pre.roots, GIT_SUBPROCESS_PARALLELISM, (r) => topMemo(r));

      // Phase 2: per-root synchronous setup (no subprocess) — scaffold each
      // group and flatten all "self" + submodule status jobs across every
      // root into one job list, so Phase 3 stays within a single bounded
      // pool budget instead of nesting a pool-per-root inside a pool-per-root.
      const jobs: Job[] = [];
      const groups: Group[] = pre.roots.map((rootInput, rootIndex) => {
        const top = tops[rootIndex];
        if (!top) {
          return {
            mcpRoot: rootInput,
            repos: [
              { label: rootInput, path: rootInput, statusText: "not a git repository", ok: false },
            ],
          };
        }
        jobs.push({ kind: "self", rootIndex, top });

        let submodulesTruncated = false;
        let submodulesOmittedCount = 0;
        if (includeSubmodules) {
          let rels = parseGitSubmodulePaths(top);
          if (rels.length > maxSubmodules) {
            submodulesOmittedCount = rels.length - maxSubmodules;
            rels = rels.slice(0, maxSubmodules);
            submodulesTruncated = true;
          }
          for (const rel of rels) {
            jobs.push({ kind: "submodule", rootIndex, top, rel });
          }
        }
        return {
          mcpRoot: rootInput,
          repos: [],
          ...spreadWhen(submodulesTruncated, { submodulesTruncated: true, submodulesOmittedCount }),
        };
      });

      // Phase 3: one global bounded pool over every job from every root.
      const jobResults = await asyncPool(jobs, GIT_SUBPROCESS_PARALLELISM, runJob);

      // Phase 4: regroup in job order (== per-root self-then-submodules order),
      // preserving input-order-deterministic output despite concurrent execution.
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i] as Job;
        const row = jobResults[i] as RepoRow;
        (groups[job.rootIndex] as Group).repos.push(row);
      }

      return jsonRespond({ groups });
    },
  });
}
