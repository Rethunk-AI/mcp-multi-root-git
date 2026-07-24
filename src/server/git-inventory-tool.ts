import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { validateRepoPath } from "../repo-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import {
  asyncPool,
  createTopLevelMemo,
  GIT_SUBPROCESS_PARALLELISM,
  gitRevParseGitDirAsync,
  isSafeGitUpstreamToken,
} from "./git.js";
import { isSafeGitAncestorRef } from "./git-refs.js";
import {
  buildInventorySectionMarkdown,
  collectInventoryEntry,
  type InventoryEntryJson,
  MAX_BRANCH_STATUS_LINES_DEFAULT,
  MAX_INVENTORY_ROOTS_DEFAULT,
  makeSkipEntry,
} from "./inventory.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { applyPresetNestedRoots } from "./presets.js";
import { requireGitAndRootsAsync } from "./roots.js";
import { MAX_ROOT_PATHS, RootPickSchema } from "./schemas.js";

/** Reason a per-root inventory group could not be produced (preset/nestedRoots failure). Same shape as other per-root fan-out errors: an `error` code plus context. */
type InventoryGroupError = Record<string, unknown>;

export function registerGitInventoryTool(server: FastMCP): void {
  server.addTool({
    name: "git_inventory",
    description:
      "Read-only status + ahead/behind per root. Optional `compareRefs` adds ahead/behind between two local refs (independent of upstream).",
    annotations: {
      readOnlyHint: true,
    },
    parameters: RootPickSchema.extend({
      nestedRoots: z.array(z.string()).optional(),
      preset: z.string().optional(),
      presetMerge: z
        .boolean()
        .optional()
        .default(false)
        .describe("Merge with preset instead of replacing."),
      remote: z.string().optional().describe("Pair with `branch`."),
      branch: z.string().optional().describe("Pair with `remote`."),
      compareRefs: z
        .object({
          left: z.string().describe("Base ref (ahead = commits in right not in left)."),
          right: z.string().describe("Other ref (behind = commits in left not in right)."),
        })
        .optional()
        .describe(
          "Ahead/behind between two local refs (e.g. main vs a feature branch), independent of upstream tracking.",
        ),
      maxRoots: z
        .number()
        .int()
        .min(1)
        .max(MAX_ROOT_PATHS)
        .optional()
        .default(MAX_INVENTORY_ROOTS_DEFAULT),
      maxBranchStatusLines: z
        .number()
        .int()
        .min(1)
        .max(20000)
        .optional()
        .default(MAX_BRANCH_STATUS_LINES_DEFAULT)
        .describe("Cap raw branchStatus lines per repo (default 500)."),
    }),
    execute: async (args, context) => {
      if (Array.isArray(args.root)) {
        if (args.preset || (args.nestedRoots?.length ?? 0) > 0) {
          return jsonRespond({ error: ERROR_CODES.ROOT_LIST_NESTED_OR_PRESET_CONFLICT });
        }
      }
      const pre = await requireGitAndRootsAsync(server, args, args.preset, context.sessionId);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }
      const warning = pre.warning;

      const rawRemote = args.remote?.trim();
      const rawBranch = args.branch?.trim();
      const hasRemote = rawRemote !== undefined && rawRemote !== "";
      const hasBranch = rawBranch !== undefined && rawBranch !== "";
      if (hasRemote !== hasBranch) {
        return jsonRespond({ error: ERROR_CODES.REMOTE_BRANCH_MISMATCH });
      }

      type Upstream =
        | { mode: "fixed"; remote: string; branch: string }
        | { mode: "auto"; remote?: undefined; branch?: undefined };

      let upstream: Upstream = { mode: "auto" };
      if (hasRemote && hasBranch && rawRemote && rawBranch) {
        if (!isSafeGitUpstreamToken(rawRemote) || !isSafeGitUpstreamToken(rawBranch)) {
          return jsonRespond({ error: ERROR_CODES.INVALID_REMOTE_OR_BRANCH });
        }
        upstream = { mode: "fixed", remote: rawRemote, branch: rawBranch };
      }

      let compareRefs: { left: string; right: string } | undefined;
      if (args.compareRefs) {
        const left = args.compareRefs.left.trim();
        const right = args.compareRefs.right.trim();
        if (!isSafeGitAncestorRef(left) || !isSafeGitAncestorRef(right)) {
          return jsonRespond({
            error: ERROR_CODES.UNSAFE_REF_TOKEN,
            left: args.compareRefs.left,
            right: args.compareRefs.right,
          });
        }
        compareRefs = { left, right };
      }

      const useFixed = upstream.mode === "fixed";
      const fixedUpstream = upstream.mode === "fixed" ? upstream : undefined;

      const allJson: {
        workspaceRoot: string;
        presetSchemaVersion?: string;
        upstream?: { mode: "fixed"; remote: string; branch: string };
        entries: InventoryEntryJson[];
        error?: InventoryGroupError;
      }[] = [];

      const maxBranchStatusLines = args.maxBranchStatusLines ?? MAX_BRANCH_STATUS_LINES_DEFAULT;

      const mdChunks: string[] = [];
      const maxRoots = args.maxRoots ?? MAX_INVENTORY_ROOTS_DEFAULT;

      // ---------------------------------------------------------------------
      // Phase 1: resolve every root's toplevel concurrently (bounded pool,
      // per-call memoized) instead of one blocking call per root in sequence.
      // ---------------------------------------------------------------------
      const topMemo = createTopLevelMemo();
      const tops = await asyncPool(pre.roots, GIT_SUBPROCESS_PARALLELISM, (r) => topMemo(r));

      // One slot per nestedRoots position; filled in by the dir-check /
      // collect phases below. "skip" entries (path-escape or not-a-work-tree)
      // are grouped before "computed" entries in the final per-root output —
      // matching the pre-existing entries shape — but each group individually
      // preserves nestedRoots input order (see the Phase 4 filter below).
      type NestedSlot =
        | { type: "pending" }
        | { type: "skip"; entry: InventoryEntryJson }
        | { type: "computed"; entry: InventoryEntryJson };

      type RootPlan =
        | { kind: "notRepo"; workspaceRoot: string }
        | { kind: "presetError"; top: string; error: InventoryGroupError }
        | {
            kind: "loneTop";
            rootIndex: number;
            top: string;
            presetSchemaVersion?: string;
            headerNote: string;
          }
        | {
            kind: "nested";
            top: string;
            presetSchemaVersion?: string;
            nestedRootsTruncated: boolean;
            nestedRootsOmittedCount: number;
            headerNote: string;
            slots: NestedSlot[];
          };

      type DirCheckJob = { rootIndex: number; posIndex: number; label: string; abs: string };
      type ComputeJob = { rootIndex: number; posIndex: number; label: string; abs: string };
      type LoneTopJob = { rootIndex: number; top: string };

      const dirCheckJobs: DirCheckJob[] = [];
      const loneTopJobs: LoneTopJob[] = [];
      const headerNote = useFixed
        ? `upstream (fixed): ${upstream.remote}/${upstream.branch}`
        : "upstream: @{u}";

      // -----------------------------------------------------------------------
      // Phase 2: per-root synchronous setup (no subprocess) — resolves preset
      // nestedRoots, caps/dedupes, and classifies each nestedRoots entry as an
      // immediate skip (path escape, no subprocess needed) or a candidate for
      // the dir-check pool below. Builds one RootPlan per root and flattens
      // all subprocess-needing work across every root into global job lists.
      // -----------------------------------------------------------------------
      const plans: RootPlan[] = pre.roots.map((workspaceRoot, rootIndex) => {
        const top = tops[rootIndex];
        if (!top) return { kind: "notRepo", workspaceRoot };

        let nestedRoots: string[] | undefined = args.nestedRoots;
        let presetSchemaVersion: string | undefined;

        if (args.preset) {
          const applied = applyPresetNestedRoots(top, args.preset, args.presetMerge, nestedRoots);
          if (!applied.ok) {
            // Never abort the whole sweep for one root's preset problem.
            return { kind: "presetError", top, error: applied.error };
          }
          nestedRoots = applied.nestedRoots;
          presetSchemaVersion = applied.presetSchemaVersion;
        }

        // Dedup before the maxRoots cutoff so duplicate nestedRoots entries
        // (inline + merged preset, or a caller-supplied repeat) don't eat into
        // the truncation budget.
        if (nestedRoots && nestedRoots.length > 0) {
          const seen = new Set<string>();
          const deduped: string[] = [];
          for (const r of nestedRoots) {
            if (seen.has(r)) continue;
            seen.add(r);
            deduped.push(r);
          }
          nestedRoots = deduped;
        }

        let nestedRootsTruncated = false;
        let nestedRootsOmittedCount = 0;
        if (nestedRoots && nestedRoots.length > maxRoots) {
          nestedRootsOmittedCount = nestedRoots.length - maxRoots;
          nestedRoots = nestedRoots.slice(0, maxRoots);
          nestedRootsTruncated = true;
        }

        if (!nestedRoots?.length) {
          loneTopJobs.push({ rootIndex, top });
          return {
            kind: "loneTop",
            rootIndex,
            top,
            ...spreadDefined("presetSchemaVersion", presetSchemaVersion),
            headerNote,
          };
        }

        const slots: NestedSlot[] = nestedRoots.map((rel) => {
          const { abs, underTop } = validateRepoPath(rel, top);
          if (!underTop) {
            return {
              type: "skip",
              entry: makeSkipEntry(
                rel,
                abs,
                upstream.mode,
                "(path escapes git toplevel — rejected)",
              ),
            };
          }
          return { type: "pending" };
        });
        nestedRoots.forEach((rel, posIndex) => {
          if (slots[posIndex]?.type !== "pending") return;
          const { abs } = validateRepoPath(rel, top);
          dirCheckJobs.push({ rootIndex, posIndex, label: rel, abs });
        });

        return {
          kind: "nested",
          top,
          ...spreadDefined("presetSchemaVersion", presetSchemaVersion),
          nestedRootsTruncated,
          nestedRootsOmittedCount,
          headerNote,
          slots,
        };
      });

      // -----------------------------------------------------------------------
      // Phase 3a: one global bounded pool checking `git rev-parse --git-dir`
      // for every nestedRoots candidate across every root.
      // -----------------------------------------------------------------------
      const computeJobs: ComputeJob[] = [];
      await asyncPool(dirCheckJobs, GIT_SUBPROCESS_PARALLELISM, async (job) => {
        const isWorktree = await gitRevParseGitDirAsync(job.abs);
        const plan = plans[job.rootIndex];
        if (plan?.kind !== "nested") return;
        if (!isWorktree) {
          plan.slots[job.posIndex] = {
            type: "skip",
            entry: makeSkipEntry(job.label, job.abs, upstream.mode, "(not a git work tree — skip)"),
          };
          return;
        }
        computeJobs.push(job);
      });

      // -----------------------------------------------------------------------
      // Phase 3b: one global bounded pool running collectInventoryEntry for
      // every nestedRoots candidate that passed the dir-check above.
      // -----------------------------------------------------------------------
      await asyncPool(computeJobs, GIT_SUBPROCESS_PARALLELISM, async (job) => {
        const plan = plans[job.rootIndex];
        if (plan?.kind !== "nested") return;
        // One throwing job must not fail the whole batch — contain it as a
        // per-entry skip instead of letting asyncPool's Promise.all reject.
        try {
          const entry = await collectInventoryEntry(
            job.label,
            job.abs,
            upstream.remote,
            upstream.branch,
            compareRefs,
            maxBranchStatusLines,
          );
          plan.slots[job.posIndex] = { type: "computed", entry };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          plan.slots[job.posIndex] = {
            type: "skip",
            entry: makeSkipEntry(
              job.label,
              job.abs,
              upstream.mode,
              `(inventory collection failed: ${msg})`,
            ),
          };
        }
      });

      // -----------------------------------------------------------------------
      // Phase 3c: one global bounded pool for lone-top (no nestedRoots) roots.
      // Mirrors the pre-existing behavior exactly: the dir-check gates a skip
      // entry, but a throwing collectInventoryEntry is NOT contained here —
      // it propagates (rejecting the whole tool call), same as before.
      // -----------------------------------------------------------------------
      const loneTopResults = new Map<number, InventoryEntryJson>();
      await asyncPool(loneTopJobs, GIT_SUBPROCESS_PARALLELISM, async (job) => {
        const isWorktree = await gitRevParseGitDirAsync(job.top);
        if (!isWorktree) {
          loneTopResults.set(
            job.rootIndex,
            makeSkipEntry(".", job.top, upstream.mode, "(not a git work tree — unexpected)"),
          );
          return;
        }
        const entry = await collectInventoryEntry(
          ".",
          job.top,
          upstream.remote,
          upstream.branch,
          compareRefs,
          maxBranchStatusLines,
        );
        loneTopResults.set(job.rootIndex, entry);
      });

      // -----------------------------------------------------------------------
      // Phase 4: assemble output in pre.roots order (input-order deterministic
      // despite concurrent execution above).
      // -----------------------------------------------------------------------
      for (const plan of plans) {
        if (plan.kind === "notRepo") {
          if (args.format === "json") {
            allJson.push({
              workspaceRoot: plan.workspaceRoot,
              ...spreadDefined("upstream", fixedUpstream),
              entries: [
                makeSkipEntry(
                  plan.workspaceRoot,
                  plan.workspaceRoot,
                  upstream.mode,
                  "(not a git repository)",
                ),
              ],
            });
          } else {
            mdChunks.push(`### ${plan.workspaceRoot}\n(not a git repository)`);
          }
          continue;
        }
        if (plan.kind === "presetError") {
          if (args.format === "json") {
            allJson.push({
              workspaceRoot: plan.top,
              ...spreadDefined("upstream", fixedUpstream),
              entries: [],
              error: plan.error,
            });
          } else {
            mdChunks.push(
              [`### ${plan.top}`, "```json", JSON.stringify(plan.error), "```"].join("\n"),
            );
          }
          continue;
        }

        const entries: InventoryEntryJson[] =
          plan.kind === "loneTop"
            ? [loneTopResults.get(plan.rootIndex) as InventoryEntryJson]
            : [
                ...plan.slots.filter((s) => s.type === "skip").map((s) => s.entry),
                ...plan.slots.filter((s) => s.type === "computed").map((s) => s.entry),
              ];

        const nestedRootsTruncated = plan.kind === "nested" && plan.nestedRootsTruncated;
        const nestedRootsOmittedCount = plan.kind === "nested" ? plan.nestedRootsOmittedCount : 0;

        if (args.format === "json") {
          allJson.push({
            workspaceRoot: plan.top,
            ...spreadDefined("presetSchemaVersion", plan.presetSchemaVersion),
            ...spreadWhen(nestedRootsTruncated, {
              nestedRootsTruncated: true,
              nestedRootsOmittedCount,
            }),
            ...spreadDefined("upstream", fixedUpstream),
            entries,
          });
        } else {
          const sections: string[] = [`### ${plan.top}`, plan.headerNote];
          if (plan.kind === "nested" && plan.nestedRootsTruncated) {
            sections.push(
              `nested_roots_truncated: ${plan.nestedRootsOmittedCount} path(s) not listed (maxRoots=${maxRoots})`,
            );
          }
          for (const e of entries) {
            sections.push(...buildInventorySectionMarkdown(e));
          }
          mdChunks.push(sections.join("\n"));
        }
      }

      if (args.format === "json") {
        return jsonRespond({ ...spreadDefined("warning", warning), inventories: allJson });
      }
      return [
        "# Git inventory",
        ...(warning ? [`_(warning: ${JSON.stringify(warning)})_`] : []),
        ...mdChunks,
      ].join("\n\n");
    },
  });
}
