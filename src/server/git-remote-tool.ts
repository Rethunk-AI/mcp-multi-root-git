import type { FastMCP } from "fastmcp";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { jsonRespond, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RemoteEntry {
  name: string;
  fetchUrl: string;
  pushUrl?: string;
}

interface RemoteListResult {
  remotes: RemoteEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `git remote -v` output into structured entries.
 * Each remote appears on up to two lines: `<name>\t<url> (fetch)` and
 * `<name>\t<url> (push)`. `pushUrl` is only included when it differs from
 * `fetchUrl` (the common case — most remotes share one URL for both).
 */
export function parseGitRemoteOutput(output: string): RemoteEntry[] {
  const fetchUrls = new Map<string, string>();
  const pushUrls = new Map<string, string>();
  const order: string[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!m) continue;
    const name = m[1] ?? "";
    const url = m[2] ?? "";
    const kind = m[3];
    if (!name) continue;
    if (!order.includes(name)) order.push(name);
    if (kind === "fetch") {
      fetchUrls.set(name, url);
    } else if (kind === "push") {
      pushUrls.set(name, url);
    }
  }

  return order.map((name) => {
    const fetchUrl = fetchUrls.get(name) ?? "";
    const pushUrl = pushUrls.get(name);
    return {
      name,
      fetchUrl,
      ...spreadWhen(pushUrl !== undefined && pushUrl !== fetchUrl, { pushUrl: pushUrl ?? "" }),
    };
  });
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderRemoteMarkdown(result: RemoteListResult): string {
  const lines: string[] = ["# git remote"];
  if (result.remotes.length === 0) {
    lines.push("", "_(no remotes configured)_");
    return lines.join("\n");
  }
  lines.push("");
  for (const r of result.remotes) {
    lines.push(`- **${r.name}**: ${r.fetchUrl}${r.pushUrl ? ` (push: ${r.pushUrl})` : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitRemoteTool(server: FastMCP): void {
  server.addTool({
    name: "git_remote",
    description:
      "List configured git remotes for one repo (`git remote -v`). Returns name, fetchUrl, " +
      "and pushUrl (omitted when identical to fetchUrl).",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema,
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const top = pre.gitTop;

      const r = await spawnGitAsync(top, ["remote", "-v"]);
      if (!r.ok) {
        return jsonRespond({
          error: ERROR_CODES.REMOTE_LIST_FAILED,
          detail: (r.stderr || r.stdout).trim(),
        });
      }

      const result: RemoteListResult = {
        remotes: parseGitRemoteOutput(r.stdout),
      };

      if (args.format === "json") {
        return jsonRespond(result as unknown as Record<string, unknown>);
      }

      return renderRemoteMarkdown(result);
    },
  });
}
