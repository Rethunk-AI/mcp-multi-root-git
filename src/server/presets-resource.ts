import { join } from "node:path";

import type { FastMCP } from "fastmcp";

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
      const pre = requireGitAndRoots(server, {}, undefined);
      if (!pre.ok) {
        return { text: jsonRespond(pre.error) };
      }
      const ws = pre.roots[0];
      if (!ws) {
        return { text: jsonRespond({ error: "no_workspace_root" }) };
      }
      const top = gitTopLevel(ws);
      if (!top) {
        return { text: jsonRespond({ error: "not_a_git_repository", path: ws }) };
      }
      const loaded = loadPresetsFromGitTop(top);
      if (!loaded.ok) {
        if (loaded.reason === "missing") {
          return {
            text: jsonRespond({
              presetFile: join(top, PRESET_FILE_PATH),
              fileExists: false,
              presets: {},
            }),
          };
        }
        return { text: jsonRespond(presetLoadErrorPayload(top, loaded)) };
      }
      return {
        text: jsonRespond({
          presetFile: join(top, PRESET_FILE_PATH),
          fileExists: true,
          ...spreadDefined("presetSchemaVersion", loaded.schemaVersion),
          presets: loaded.data,
        }),
      };
    },
  });
}
