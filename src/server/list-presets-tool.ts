import type { FastMCP } from "fastmcp";

import { jsonRespond, spreadDefined } from "./json.js";
import { forEachPresetRoot, type PresetEntry } from "./presets.js";
import { requireGitAndRoots } from "./roots.js";
import { RootPickSchema } from "./schemas.js";

type PresetRow = {
  name: string;
  nestedRoots?: PresetEntry["nestedRoots"];
  parityPairs?: PresetEntry["parityPairs"];
  workspaceRootHint?: string;
};

type PresetRootRow = {
  workspaceRoot: string;
  gitTop: string | null;
  presetFile: string;
  fileExists: boolean;
  presetSchemaVersion?: string;
  presets: PresetRow[];
  error?: Record<string, unknown>;
};

export function registerListPresetsTool(server: FastMCP): void {
  server.addTool({
    name: "list_presets",
    description:
      "List presets (name, nestedRoots, parityPairs) from .rethunk/git-mcp-presets.json.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: RootPickSchema,
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const out = forEachPresetRoot<PresetRootRow>(pre.roots, (base, data) => {
        const presets: PresetRow[] = data
          ? Object.entries(data).map(([name, e]) => ({
              name,
              ...spreadDefined("nestedRoots", e.nestedRoots?.length ? e.nestedRoots : undefined),
              ...spreadDefined("parityPairs", e.parityPairs?.length ? e.parityPairs : undefined),
              ...spreadDefined(
                "workspaceRootHint",
                e.workspaceRootHint ? e.workspaceRootHint : undefined,
              ),
            }))
          : [];
        return {
          workspaceRoot: base.workspaceRoot,
          gitTop: base.gitTop,
          presetFile: base.presetFile,
          fileExists: base.fileExists,
          ...spreadDefined("presetSchemaVersion", base.presetSchemaVersion),
          presets,
          ...spreadDefined("error", base.error),
        };
      });

      if (args.format === "json") {
        return jsonRespond({ roots: out });
      }
      const lines: string[] = ["# Git MCP presets", ""];
      for (const row of out) {
        lines.push(
          `## ${row.workspaceRoot}`,
          `git_top: ${row.gitTop ?? "(none)"}`,
          `preset_file: ${row.presetFile}`,
          "",
        );
        if (row.error) {
          lines.push("```json", JSON.stringify(row.error, null, 2), "```", "");
          continue;
        }
        if (!row.fileExists) {
          lines.push("(no preset file)", "");
          continue;
        }
        if (row.presets.length === 0) {
          lines.push("(empty preset file)", "");
          continue;
        }
        if (row.presetSchemaVersion !== undefined) {
          lines.push(`preset_schema_version: ${row.presetSchemaVersion}`, "");
        }
        for (const p of row.presets) {
          const parts: string[] = [];
          if (p.nestedRoots?.length) parts.push(`nestedRoots=${p.nestedRoots.join(",")}`);
          if (p.parityPairs?.length) {
            parts.push(
              `parityPairs=${p.parityPairs.map((pp) => `${pp.left}->${pp.right}`).join(",")}`,
            );
          }
          if (p.workspaceRootHint) parts.push(`hint=${p.workspaceRootHint}`);
          lines.push(`- **${p.name}**${parts.length ? `: ${parts.join(", ")}` : ""}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    },
  });
}
