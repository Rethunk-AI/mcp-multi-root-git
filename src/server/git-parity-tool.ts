import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { gitRevParseHead, gitTopLevel } from "./git.js";
import { validateRepoPath } from "./inventory.js";
import { jsonRespond, spreadDefined } from "./json.js";
import { applyPresetParityPairs, type ParityPair } from "./presets.js";
import { requireGitAndRoots } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

export function registerGitParityTool(server: FastMCP): void {
  server.addTool({
    name: "git_parity",
    description: "Read-only HEAD parity for path pairs.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.extend({
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
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, args.preset);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const results: {
        workspace_root: string;
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
      }[] = [];

      const mdParts: string[] = [];

      for (const workspaceRoot of pre.roots) {
        const top = gitTopLevel(workspaceRoot);
        if (!top) {
          const errPayload = { error: "not_a_git_repository", path: workspaceRoot };
          const err = jsonRespond(errPayload);
          if (args.format === "json") {
            results.push({
              workspace_root: workspaceRoot,
              status: "MISMATCH",
              pairs: [{ label: "—", leftPath: "", rightPath: "", match: false, error: err }],
            });
          } else {
            mdParts.push(err);
          }
          continue;
        }

        let pairs: ParityPair[] | undefined = args.pairs;
        let parityPresetSchemaVersion: string | undefined;
        if (args.preset) {
          const applied = applyPresetParityPairs(top, args.preset, args.presetMerge, pairs);
          if (!applied.ok) {
            return jsonRespond(applied.error);
          }
          pairs = applied.pairs;
          parityPresetSchemaVersion = applied.presetSchemaVersion;
        }

        if (!pairs?.length) {
          return jsonRespond({ error: "no_pairs" });
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
          workspace_root: top,
          ...spreadDefined("presetSchemaVersion", parityPresetSchemaVersion),
          status: allOk ? "OK" : "MISMATCH",
          pairs: pairResults,
        });

        if (args.format !== "json") {
          const lines: string[] = [
            "# Git HEAD parity",
            "",
            `status: ${allOk ? "OK" : "MISMATCH"}`,
            "",
          ];
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
        return jsonRespond({ parity: results });
      }
      return mdParts.join("\n\n---\n\n");
    },
  });
}
