import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { gitRevParseHead, gitTopLevel } from "./git.js";
import { validateRepoPath } from "./inventory.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { applyPresetParityPairs, type ParityPair } from "./presets.js";
import { requireGitAndRoots } from "./roots.js";
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

export function registerGitParityTool(server: FastMCP): void {
  server.addTool({
    name: "git_parity",
    description: "Read-only HEAD parity for path pairs.",
    annotations: {
      readOnlyHint: true,
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
      const pre = requireGitAndRoots(server, args, args.preset, context.sessionId);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }
      const warning = pre.warning;

      const maxPairs = args.maxPairs ?? MAX_PAIRS_DEFAULT;

      const results: {
        workspaceRoot: string;
        presetSchemaVersion?: string;
        status: "OK" | "MISMATCH";
        pairs: {
          label: string;
          leftPath: string;
          rightPath: string;
          match: boolean;
          sha?: string;
          leftSha?: string;
          rightSha?: string;
          error?: string;
        }[];
        pairsTruncated?: boolean;
        pairsOmittedCount?: number;
        error?: Record<string, unknown>;
      }[] = [];

      const mdParts: string[] = [];

      for (const workspaceRoot of pre.roots) {
        const top = gitTopLevel(workspaceRoot);
        if (!top) {
          const errDesc = `not a git repository: ${workspaceRoot}`;
          if (args.format === "json") {
            results.push({
              workspaceRoot: workspaceRoot,
              status: "MISMATCH",
              pairs: [{ label: "—", leftPath: "", rightPath: "", match: false, error: errDesc }],
            });
          } else {
            mdParts.push(
              [
                "# Git HEAD parity",
                "",
                `status: MISMATCH`,
                "",
                `## — — error`,
                "```text",
                errDesc,
                "```",
                "",
              ].join("\n"),
            );
          }
          continue;
        }

        let pairs: ParityPair[] | undefined = args.pairs;
        let parityPresetSchemaVersion: string | undefined;
        if (args.preset) {
          const applied = applyPresetParityPairs(top, args.preset, args.presetMerge, pairs);
          if (!applied.ok) {
            // Never abort the whole sweep for one root's preset problem — record a
            // per-root error entry (same shape as the not-a-git-repo entries above)
            // and move on to the remaining roots.
            if (args.format === "json") {
              results.push({
                workspaceRoot: top,
                status: "MISMATCH",
                pairs: [],
                error: applied.error,
              });
            } else {
              mdParts.push(
                [
                  "# Git HEAD parity",
                  "",
                  "status: MISMATCH",
                  "",
                  `## ${top} — preset error`,
                  "```json",
                  JSON.stringify(applied.error),
                  "```",
                  "",
                ].join("\n"),
              );
            }
            continue;
          }
          pairs = applied.pairs;
          parityPresetSchemaVersion = applied.presetSchemaVersion;
        }

        if (!pairs?.length) {
          const noPairsError = { error: ERROR_CODES.NO_PAIRS };
          if (args.format === "json") {
            results.push({
              workspaceRoot: top,
              status: "MISMATCH",
              pairs: [],
              error: noPairsError,
            });
          } else {
            mdParts.push(
              [
                "# Git HEAD parity",
                "",
                "status: MISMATCH",
                "",
                `## ${top} — error`,
                "```json",
                JSON.stringify(noPairsError),
                "```",
                "",
              ].join("\n"),
            );
          }
          continue;
        }

        pairs = dedupePairs(pairs);
        let pairsTruncated = false;
        let pairsOmittedCount = 0;
        if (pairs.length > maxPairs) {
          pairsOmittedCount = pairs.length - maxPairs;
          pairs = pairs.slice(0, maxPairs);
          pairsTruncated = true;
        }

        let allOk = true;
        const pairResults: (typeof results)[0]["pairs"] = [];

        for (const pair of pairs) {
          const pa = validateRepoPath(pair.left, top);
          const pb = validateRepoPath(pair.right, top);
          const label = pair.label ?? `${pair.left} / ${pair.right}`;

          if (!pa.underTop || !pb.underTop) {
            allOk = false;
            pairResults.push({
              label,
              leftPath: pa.abs,
              rightPath: pb.abs,
              match: false,
              error: "path escapes git toplevel — rejected",
            });
            continue;
          }

          const ha = gitRevParseHead(pa.abs);
          const hb = gitRevParseHead(pb.abs);

          if (!ha.ok || !hb.ok) {
            allOk = false;
            pairResults.push({
              label,
              leftPath: pa.abs,
              rightPath: pb.abs,
              match: false,
              error: [!ha.ok ? `left: ${ha.text}` : "", !hb.ok ? `right: ${hb.text}` : ""]
                .filter(Boolean)
                .join("\n"),
            });
            continue;
          }
          if (ha.sha !== hb.sha) {
            allOk = false;
            pairResults.push({
              label,
              leftPath: pa.abs,
              rightPath: pb.abs,
              match: false,
              leftSha: ha.sha,
              rightSha: hb.sha,
            });
          } else {
            pairResults.push({
              label,
              leftPath: pa.abs,
              rightPath: pb.abs,
              match: true,
              sha: ha.sha,
            });
          }
        }

        results.push({
          workspaceRoot: top,
          ...spreadDefined("presetSchemaVersion", parityPresetSchemaVersion),
          status: allOk ? "OK" : "MISMATCH",
          pairs: pairResults,
          ...spreadWhen(pairsTruncated, { pairsTruncated: true, pairsOmittedCount }),
        });

        if (args.format !== "json") {
          const lines: string[] = [
            "# Git HEAD parity",
            "",
            `status: ${allOk ? "OK" : "MISMATCH"}`,
            "",
          ];
          if (pairsTruncated) {
            lines.push(
              `pairs_truncated: ${pairsOmittedCount} pair(s) not evaluated (maxPairs=${maxPairs})`,
              "",
            );
          }
          for (const pr of pairResults) {
            if (pr.error) {
              lines.push(`## ${pr.label} — error`, "```text", pr.error, "```", "");
            } else if (pr.match) {
              lines.push(`## ${pr.label} — OK`, "```text", `SHA: ${pr.sha}`, "```", "");
            } else {
              lines.push(
                `## ${pr.label} — MISMATCH`,
                "```text",
                `left:  ${pr.leftSha}`,
                `right: ${pr.rightSha}`,
                "```",
                "",
              );
            }
          }
          mdParts.push(lines.join("\n"));
        }
      }

      if (args.format === "json") {
        return jsonRespond({ ...spreadDefined("warning", warning), parity: results });
      }
      return [...(warning ? [`_(warning: ${JSON.stringify(warning)})_`] : []), ...mdParts].join(
        "\n\n---\n\n",
      );
    },
  });
}
