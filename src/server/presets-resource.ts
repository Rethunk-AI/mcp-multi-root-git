import { join } from "node:path";

import type { FastMCP } from "fastmcp";

import { ERROR_CODES } from "./error-codes.js";
import { gitTopLevel } from "./git.js";
import { jsonRespond, spreadDefined } from "./json.js";
import { loadPresetsFromGitTop, PRESET_FILE_PATH, presetLoadErrorPayload } from "./presets.js";
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

      const roots = pre.roots.map((ws) => {
        const top = gitTopLevel(ws);
        const presetFile = top ? join(top, PRESET_FILE_PATH) : join(ws, PRESET_FILE_PATH);
        if (!top) {
          return {
            workspaceRoot: ws,
            gitTop: null,
            presetFile,
            fileExists: false,
            presets: {},
            error: { error: ERROR_CODES.NOT_A_GIT_REPOSITORY, path: ws },
          };
        }
        const loaded = loadPresetsFromGitTop(top);
        if (!loaded.ok) {
          if (loaded.reason === "missing") {
            return {
              workspaceRoot: ws,
              gitTop: top,
              presetFile,
              fileExists: false,
              presets: {},
            };
          }
          return {
            workspaceRoot: ws,
            gitTop: top,
            presetFile,
            fileExists: true,
            presets: {},
            error: presetLoadErrorPayload(top, loaded),
          };
        }
        return {
          workspaceRoot: ws,
          gitTop: top,
          presetFile,
          fileExists: true,
          ...spreadDefined("presetSchemaVersion", loaded.schemaVersion),
          presets: loaded.data,
        };
      });

      return { text: jsonRespond({ roots }) };
    },
  });
}
