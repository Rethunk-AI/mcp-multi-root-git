import type { FastMCP } from "fastmcp";

import { ERROR_CODES } from "./error-codes.js";
import { jsonRespond, spreadDefined } from "./json.js";
import { forEachPresetRoot, type PresetFile } from "./presets.js";
import { requireGitAndRoots } from "./roots.js";

export function registerPresetsResource(server: FastMCP): void {
  server.addResource({
    uri: "rethunk-git://presets",
    name: "git-mcp-presets",
    mimeType: "application/json",
    async load() {
      const pre = requireGitAndRoots(server, { root: "*" }, undefined);
      if (!pre.ok) {
        return { text: jsonRespond(pre.error) };
      }
      if (pre.roots.length === 0) {
        return { text: jsonRespond({ error: ERROR_CODES.NO_WORKSPACE_ROOT }) };
      }

      const roots = forEachPresetRoot(pre.roots, (base, data) => ({
        workspaceRoot: base.workspaceRoot,
        gitTop: base.gitTop,
        presetFile: base.presetFile,
        fileExists: base.fileExists,
        ...spreadDefined("presetSchemaVersion", base.presetSchemaVersion),
        presets: (data ?? {}) as PresetFile,
        ...spreadDefined("error", base.error),
      }));

      return { text: jsonRespond({ roots }) };
    },
  });
}
