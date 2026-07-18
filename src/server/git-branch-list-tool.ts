import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { jsonRespond, spreadDefined, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BranchEntry {
  name: string;
  sha: string;
  current: boolean;
  upstream?: string;
}

interface RemoteEntry {
  name: string;
  sha: string;
}

interface BranchListJson {
  branches: BranchEntry[];
  remotes?: RemoteEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runBranchList(opts: {
  top: string;
  includeRemotes: boolean;
}): Promise<BranchListJson | { error: string; detail: string }> {
  const { top, includeRemotes } = opts;

  // Local branches: name, full SHA, upstream (may be empty), HEAD marker (* or space)
  const localR = await spawnGitAsync(top, [
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)",
    "refs/heads",
  ]);

  if (!localR.ok) {
    return {
      error: ERROR_CODES.BRANCH_LIST_FAILED,
      detail: (localR.stderr || localR.stdout).trim(),
    };
  }

  const branches: BranchEntry[] = [];
  const localLines = (localR.stdout || "").split("\n").filter((l) => l.length > 0);

  for (const line of localLines) {
    const parts = line.split("\x00");
    const name = parts[0] ?? "";
    const sha = parts[1] ?? "";
    const upstream = parts[2] ?? "";
    const headMarker = parts[3] ?? "";
    if (!name || !sha) continue;
    branches.push({
      name,
      sha,
      current: headMarker === "*",
      ...spreadDefined("upstream", upstream || undefined),
    });
  }

  if (!includeRemotes) {
    return { branches };
  }

  // Remote branches: name, full SHA — skip symbolic origin/HEAD refs
  const remoteR = await spawnGitAsync(top, [
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)",
    "refs/remotes",
  ]);

  if (!remoteR.ok) {
    return {
      error: ERROR_CODES.BRANCH_LIST_FAILED,
      detail: (remoteR.stderr || remoteR.stdout).trim(),
    };
  }

  const remotes: RemoteEntry[] = [];
  const remoteLines = (remoteR.stdout || "").split("\n").filter((l) => l.length > 0);

  for (const line of remoteLines) {
    const parts = line.split("\x00");
    const name = parts[0] ?? "";
    const sha = parts[1] ?? "";
    // Skip symbolic origin/HEAD
    if (!name || !sha || name.endsWith("/HEAD")) continue;
    remotes.push({ name, sha });
  }

  return {
    branches,
    ...spreadWhen(remotes.length > 0, { remotes }),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderBranchListMarkdown(result: BranchListJson): string {
  const lines: string[] = ["# git branch list", "", "## Branches", ""];

  if (result.branches.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const b of result.branches) {
      const prefix = b.current ? "* " : "  ";
      const upstream = b.upstream ? ` → ${b.upstream}` : "";
      lines.push(`${prefix}**${b.name}**${upstream}  (\`${b.sha}\`)`);
    }
  }

  if (result.remotes && result.remotes.length > 0) {
    lines.push("");
    lines.push("## Remote branches");
    lines.push("");
    for (const r of result.remotes) {
      lines.push(`- **${r.name}**  (\`${r.sha}\`)`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitBranchListTool(server: FastMCP): void {
  server.addTool({
    name: "git_branch_list",
    description:
      "List local (and optionally remote-tracking) branches. Current branch marked `current: true`. Set `includeRemotes: true` for remotes.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.extend({
      includeRemotes: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include remote-tracking branches from refs/remotes (symbolic origin/HEAD excluded).",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      const result = await runBranchList({
        top: gitTop,
        includeRemotes: (args.includeRemotes as boolean | undefined) ?? false,
      });

      if ("error" in result) {
        return jsonRespond(result as unknown as Record<string, unknown>);
      }

      if (args.format === "json") {
        return jsonRespond(result as unknown as Record<string, unknown>);
      }

      return renderBranchListMarkdown(result);
    },
  });
}
