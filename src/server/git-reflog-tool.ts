import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { spawnGitAsync } from "./git.js";
import { isSafeGitRefToken } from "./git-refs.js";
import { jsonRespond } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ENTRIES_HARD_CAP = 200;
const DEFAULT_MAX_ENTRIES = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReflogEntry {
  sha: string;
  selector: string;
  message: string;
}

interface ReflogJson {
  ref: string;
  entries: ReflogEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run git reflog for a single ref and return structured data.
 * Uses NUL-delimited fields within each line for robust parsing.
 */
async function runGitReflog(opts: {
  top: string;
  ref: string;
  maxEntries: number;
}): Promise<ReflogJson | { error: string; detail?: string }> {
  const { top, ref, maxEntries } = opts;

  // %h = short sha, %H = full sha, %gd = selector (HEAD@{0}), %gs = reflog subject
  const reflogArgs = [
    "reflog",
    "show",
    ref,
    "--format=%h%x00%H%x00%gd%x00%gs",
    `-n`,
    String(maxEntries),
  ];

  const r = await spawnGitAsync(top, reflogArgs);
  if (!r.ok) {
    return {
      error: "reflog_failed",
      detail: (r.stderr || r.stdout || "git reflog failed").trim(),
    };
  }

  const entries: ReflogEntry[] = [];
  const lines = r.stdout.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split("\x00");
    // Expect 4 fields: shaShort, shaFull, selector, message
    if (parts.length < 4) continue;
    const [, shaFull, selector, message] = parts;
    if (!shaFull) continue;

    entries.push({
      sha: shaFull.trim(),
      selector: (selector ?? "").trim(),
      message: (message ?? "").trim(),
    });
  }

  return { ref, entries };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderReflogMarkdown(result: ReflogJson): string {
  const lines: string[] = [];
  lines.push(`## Reflog (${result.ref})`);
  lines.push("");

  if (result.entries.length === 0) {
    lines.push("_(no reflog entries)_");
  } else {
    for (const entry of result.entries) {
      lines.push(`${entry.selector}  ${entry.sha.slice(0, 7)}  ${entry.message}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitReflogTool(server: FastMCP): void {
  server.addTool({
    name: "git_reflog",
    description:
      "Show the reflog for a ref (default HEAD). Returns a list of recent HEAD movements with selector (e.g. HEAD@{0}), full SHA, and message. Useful for recovering lost commits or inspecting reset/checkout history.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.omit({ absoluteGitRoots: true, allWorkspaceRoots: true })
      .pick({
        workspaceRoot: true,
        rootIndex: true,
        format: true,
      })
      .extend({
        ref: z
          .string()
          .optional()
          .default("HEAD")
          .describe("Ref whose reflog to show (branch name, HEAD, etc.). Default: HEAD."),
        maxEntries: z
          .number()
          .int()
          .min(1)
          .max(MAX_ENTRIES_HARD_CAP)
          .optional()
          .default(DEFAULT_MAX_ENTRIES)
          .describe(
            `Maximum reflog entries to return (hard cap ${MAX_ENTRIES_HARD_CAP}). Default ${DEFAULT_MAX_ENTRIES}.`,
          ),
      }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const top = pre.gitTop;

      const ref = (args.ref as string | undefined) ?? "HEAD";

      if (!isSafeGitRefToken(ref)) {
        return jsonRespond({ error: "unsafe_ref_token", ref });
      }

      const maxEntries = Math.min(
        (args.maxEntries as number | undefined) ?? DEFAULT_MAX_ENTRIES,
        MAX_ENTRIES_HARD_CAP,
      );

      const result = await runGitReflog({ top, ref, maxEntries });

      if ("error" in result) {
        return jsonRespond(result as Record<string, unknown>);
      }

      if (args.format === "json") {
        return jsonRespond(result as unknown as Record<string, unknown>);
      }

      return renderReflogMarkdown(result);
    },
  });
}
