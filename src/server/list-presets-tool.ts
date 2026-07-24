import type { FastMCP } from "fastmcp";

import { jsonRespond, spreadDefined } from "./json.js";
import { forEachPresetRoot, type PresetEntry } from "./presets.js";
import { requireGitAndRootsAsync } from "./roots.js";
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

/** Build the `list_presets` JSON payload from the already-assembled per-root rows. */
function buildListPresetsJson(roots: PresetRootRow[]): Record<string, unknown> {
  return { roots };
}

export function registerListPresetsTool(server: FastMCP): void {
  server.addTool({
    name: "list_presets",
    description:
      "List presets (name, nestedRoots, parityPairs) from .rethunk/git-mcp-presets.json.",
    annotations: {
      title: "List Presets",
      readOnlyHint: true,
      openWorldHint: false,
    },
    parameters: RootPickSchema,
    execute: async (args) => {
      const pre = await requireGitAndRootsAsync(server, args, undefined);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const out = await forEachPresetRoot<PresetRootRow>(pre.roots, (base, data) => {
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

      return jsonRespond(buildListPresetsJson(out));
    },
  });
}
