import { join } from "node:path";

import type { FastMCP } from "fastmcp";
import { gitTopLevel } from "./git.js";
import { jsonRespond, spreadDefined } from "./json.js";
import { loadPresetsFromGitTop, PRESET_FILE_PATH, presetLoadErrorPayload } from "./presets.js";
import { requireGitAndRoots } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

export function registerListPresetsTool(server: FastMCP): void {
  server.addTool({
    name: "list_presets",
    description:
      "List named entries from `.rethunk/git-mcp-presets.json` at the git toplevel for the resolved workspace root.",
    parameters: WorkspacePickSchema.pick({
      workspaceRoot: true,
      rootIndex: true,
      allWorkspaceRoots: true,
      format: true,
    }),
    execute: async (args) => {
      const pre = requireGitAndRoots(server, args, undefined);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const out: {
        workspaceRoot: string;
        gitTop: string | null;
        presetFile: string;
        fileExists: boolean;
        presetSchemaVersion?: string;
        presets: {
          name: string;
          nestedRootsCount: number;
          parityPairsCount: number;
          workspaceRootHint?: string;
        }[];
        error?: Record<string, unknown>;
      }[] = [];

      for (const ws of pre.roots) {
        const top = gitTopLevel(ws);
        const presetFile = top ? join(top, PRESET_FILE_PATH) : join(ws, PRESET_FILE_PATH);
        if (!top) {
          out.push({
            workspaceRoot: ws,
            gitTop: null,
            presetFile,
            fileExists: false,
            presets: [],
            error: { error: "not_a_git_repository", path: ws },
          });
          continue;
        }
        const loaded = loadPresetsFromGitTop(top);
        if (!loaded.ok) {
          if (loaded.reason === "missing") {
            out.push({
              workspaceRoot: ws,
              gitTop: top,
              presetFile,
              fileExists: false,
              presets: [],
            });
          } else {
            out.push({
              workspaceRoot: ws,
              gitTop: top,
              presetFile,
              fileExists: true,
              presets: [],
              error: presetLoadErrorPayload(top, loaded),
            });
          }
          continue;
        }
        const presets = Object.entries(loaded.data).map(([name, e]) => ({
          name,
          nestedRootsCount: e.nestedRoots?.length ?? 0,
          parityPairsCount: e.parityPairs?.length ?? 0,
          ...spreadDefined(
            "workspaceRootHint",
            e.workspaceRootHint ? e.workspaceRootHint : undefined,
          ),
        }));
        out.push({
          workspaceRoot: ws,
          gitTop: top,
          presetFile,
          fileExists: true,
          ...spreadDefined("presetSchemaVersion", loaded.schemaVersion),
          presets,
        });
      }

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
          lines.push(
            `- **${p.name}**: nestedRoots=${p.nestedRootsCount}, parityPairs=${p.parityPairsCount}` +
              (p.workspaceRootHint ? `, hint=${p.workspaceRootHint}` : ""),
          );
        }
        lines.push("");
      }
      return lines.join("\n");
    },
  });
}
