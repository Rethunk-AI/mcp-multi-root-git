import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { validateRepoPath } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import {
  asyncPool,
  createRevParseHeadMemo,
  createTopLevelMemo,
  GIT_SUBPROCESS_PARALLELISM,
} from "./git.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { applyPresetParityPairs, type ParityPair } from "./presets.js";
import { requireGitAndRootsAsync } from "./roots.js";
import { RootPickSchema } from "./schemas.js";

/** Default / hard cap on parity pairs evaluated per root. */
const MAX_PAIRS_DEFAULT = 64;
const MAX_PAIRS_HARD_CAP = 256;

/** Dedup pairs on (left, right), keeping first occurrence — mirrors the preset-merge dedup in presets.ts. */
function dedupePairs(pairs: ParityPair[]): ParityPair[] {
  const seen = new Set<string>();
  const out: ParityPair[] = [];
  for (const pair of pairs) {
    const key = `${pair.left}\0${pair.right}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out;
}

type ParityResultRow = {
  workspaceRoot: string;
  presetSchemaVersion?: string | undefined;
  status: "OK" | "MISMATCH";
  pairs: Array<{
    label: string;
    leftPath: string;
    rightPath: string;
    match: boolean;
    sha?: string | undefined;
    leftSha?: string | undefined;
    rightSha?: string | undefined;
    error?: string;
  }>;
  pairsTruncated?: boolean;
  pairsOmittedCount?: number;
  error?: Record<string, unknown>;
};

/** Build the `git_parity` JSON payload from the already-assembled per-root results. */
function buildGitParityJson(
  warning: Record<string, unknown> | undefined,
  results: ParityResultRow[],
): Record<string, unknown> {
  return { ...spreadDefined("warning", warning), parity: results };
}

export function registerGitParityTool(server: FastMCP): void {
  server.addTool({
    name: "git_parity",
    description: "Read-only HEAD parity for path pairs.",
    annotations: {
      title: "Git Parity",
      readOnlyHint: true,
      openWorldHint: false,
    },
    parameters: RootPickSchema.extend({
      pairs: z
        .array(
          z.object({
            left: z.string(),
            right: z.string(),
            label: z.string().optional(),
          }),
        )
        .optional(),
      preset: z.string().optional(),
      presetMerge: z.boolean().optional().default(false),
      maxPairs: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAIRS_HARD_CAP)
        .optional()
        .default(MAX_PAIRS_DEFAULT)
        .describe(`Max pairs evaluated per root (hard cap ${MAX_PAIRS_HARD_CAP}).`),
    }),
    execute: async (args, context) => {
      const pre = await requireGitAndRootsAsync(server, args, args.preset, context.sessionId);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }
      const warning = pre.warning;

      const maxPairs = args.maxPairs ?? MAX_PAIRS_DEFAULT;

      type PairResult = {
        label: string;
        leftPath: string;
        rightPath: string;
        match: boolean;
        sha?: string | undefined;
        leftSha?: string | undefined;
        rightSha?: string | undefined;
        error?: string;
      };
      type PairSlot = { type: "pending" } | { type: "result"; result: PairResult };
      type RootPlan =
        | { kind: "notRepo"; workspaceRoot: string }
        | { kind: "presetError"; top: string; error: Record<string, unknown> }
        | { kind: "noPairs"; top: string; error: Record<string, unknown> }
        | {
            kind: "ok";
            top: string;
            presetSchemaVersion?: string;
            pairsTruncated: boolean;
            pairsOmittedCount: number;
            slots: PairSlot[];
          };
      type PairJob = {
        rootIndex: number;
        slotIndex: number;
        label: string;
        leftAbs: string;
        rightAbs: string;
      };

      // Phase 1: resolve every root's toplevel concurrently (bounded pool,
      // per-call memoized) instead of one blocking call per root in sequence.
      const topMemo = createTopLevelMemo();
      const tops = await asyncPool(pre.roots, GIT_SUBPROCESS_PARALLELISM, (r) => topMemo(r));

      // Phase 2: per-root synchronous setup (no subprocess) — resolves preset
      // pairs, dedupes/caps, and validates each pair's paths. A pair with a
      // path-escape resolves immediately (no subprocess); a valid pair becomes
      // a PairJob queued for the head-resolution pool below.
      const pairJobs: PairJob[] = [];
      const plans: RootPlan[] = pre.roots.map((workspaceRoot, rootIndex) => {
        const top = tops[rootIndex];
        if (!top) return { kind: "notRepo", workspaceRoot };

        let pairs: ParityPair[] | undefined = args.pairs;
        let parityPresetSchemaVersion: string | undefined;
        if (args.preset) {
          const applied = applyPresetParityPairs(top, args.preset, args.presetMerge, pairs);
          if (!applied.ok) {
            // Never abort the whole sweep for one root's preset problem.
            return { kind: "presetError", top, error: applied.error };
          }
          pairs = applied.pairs;
          parityPresetSchemaVersion = applied.presetSchemaVersion;
        }

        if (!pairs?.length) {
          return { kind: "noPairs", top, error: { error: ERROR_CODES.NO_PAIRS } };
        }

        pairs = dedupePairs(pairs);
        let pairsTruncated = false;
        let pairsOmittedCount = 0;
        if (pairs.length > maxPairs) {
          pairsOmittedCount = pairs.length - maxPairs;
          pairs = pairs.slice(0, maxPairs);
          pairsTruncated = true;
        }

        const slots: PairSlot[] = pairs.map((pair, slotIndex) => {
          const pa = validateRepoPath(pair.left, top);
          const pb = validateRepoPath(pair.right, top);
          const label = pair.label ?? `${pair.left} / ${pair.right}`;
          if (!pa.underTop || !pb.underTop) {
            return {
              type: "result",
              result: {
                label,
                leftPath: pa.abs,
                rightPath: pb.abs,
                match: false,
                error: "path escapes git toplevel — rejected",
              },
            };
          }
          pairJobs.push({ rootIndex, slotIndex, label, leftAbs: pa.abs, rightAbs: pb.abs });
          return { type: "pending" };
        });

        return {
          kind: "ok",
          top,
          ...spreadDefined("presetSchemaVersion", parityPresetSchemaVersion),
          pairsTruncated,
          pairsOmittedCount,
          slots,
        };
      });

      // Phase 3: one global bounded pool resolving HEAD for every path
      // referenced by any pair across every root (left AND right, across
      // roots AND pairs) — a single flat pool instead of nested per-root /
      // per-pair pools, so total concurrency never exceeds the knob. The
      // per-call memo collapses repeated paths (e.g. the same left path
      // reused across pairs) to one subprocess.
      const headMemo = createRevParseHeadMemo();
      const headPathRequests: string[] = [];
      for (const job of pairJobs) {
        headPathRequests.push(job.leftAbs, job.rightAbs);
      }
      await asyncPool(headPathRequests, GIT_SUBPROCESS_PARALLELISM, (p) => headMemo(p));

      // Phase 4: fill in each PairJob's slot from the now-resolved (cached)
      // HEAD lookups — no further subprocess spawns, just reading the memo.
      for (const job of pairJobs) {
        const plan = plans[job.rootIndex];
        if (plan?.kind !== "ok") continue;
        const ha = await headMemo(job.leftAbs);
        const hb = await headMemo(job.rightAbs);
        let result: PairResult;
        if (!ha.ok || !hb.ok) {
          result = {
            label: job.label,
            leftPath: job.leftAbs,
            rightPath: job.rightAbs,
            match: false,
            error: [!ha.ok ? `left: ${ha.text}` : "", !hb.ok ? `right: ${hb.text}` : ""]
              .filter(Boolean)
              .join("\n"),
          };
        } else if (ha.sha !== hb.sha) {
          result = {
            label: job.label,
            leftPath: job.leftAbs,
            rightPath: job.rightAbs,
            match: false,
            leftSha: ha.sha,
            rightSha: hb.sha,
          };
        } else {
          result = {
            label: job.label,
            leftPath: job.leftAbs,
            rightPath: job.rightAbs,
            match: true,
            sha: ha.sha,
          };
        }
        plan.slots[job.slotIndex] = { type: "result", result };
      }

      // Phase 5: assemble output in pre.roots order (input-order deterministic
      // despite concurrent execution above).
      const results: ParityResultRow[] = [];

      for (const plan of plans) {
        if (plan.kind === "notRepo") {
          const errDesc = `not a git repository: ${plan.workspaceRoot}`;
          results.push({
            workspaceRoot: plan.workspaceRoot,
            status: "MISMATCH",
            pairs: [{ label: "—", leftPath: "", rightPath: "", match: false, error: errDesc }],
          });
          continue;
        }
        if (plan.kind === "presetError") {
          results.push({
            workspaceRoot: plan.top,
            status: "MISMATCH",
            pairs: [],
            error: plan.error,
          });
          continue;
        }
        if (plan.kind === "noPairs") {
          results.push({
            workspaceRoot: plan.top,
            status: "MISMATCH",
            pairs: [],
            error: plan.error,
          });
          continue;
        }

        const pairResults = plan.slots.map(
          (s) => (s as { type: "result"; result: PairResult }).result,
        );
        const allOk = pairResults.every((pr) => pr.match);

        results.push({
          workspaceRoot: plan.top,
          ...spreadDefined("presetSchemaVersion", plan.presetSchemaVersion),
          status: allOk ? "OK" : "MISMATCH",
          pairs: pairResults,
          ...spreadWhen(plan.pairsTruncated, {
            pairsTruncated: true,
            pairsOmittedCount: plan.pairsOmittedCount,
          }),
        });
      }

      return jsonRespond(buildGitParityJson(warning, results));
    },
  });
}
