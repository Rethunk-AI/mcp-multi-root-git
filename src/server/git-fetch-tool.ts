import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { spawnGitAsync } from "./git.js";
import { jsonRespond } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitFetchResult {
  remote: string;
  updatedRefs: string[];
  newRefs: string[];
  output: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `git fetch` output to extract updated and new refs.
 * Lines containing "[new" indicate new refs (new branch, new tag, new ref).
 * Lines with " -> " but not containing "[new" indicate updated refs.
 */
function parseGitFetchOutput(output: string): { updatedRefs: string[]; newRefs: string[] } {
  const lines = output.split("\n");
  const updatedRefs: string[] = [];
  const newRefs: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Lines containing "[new" indicate new refs (e.g. "[new branch]", "[new tag]", "[new ref]")
    if (trimmed.includes("[new")) {
      newRefs.push(trimmed);
    }
    // Lines with " -> " that don't contain "[new" indicate ref updates
    else if (trimmed.includes(" -> ")) {
      updatedRefs.push(trimmed);
    }
  }

  return { updatedRefs, newRefs };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitFetchTool(server: FastMCP): void {
  server.addTool({
    name: "git_fetch",
    description:
      "Fetch updates from a remote repository without modifying the working tree. " +
      "Returns structured output distinguishing updated refs from new refs.",
    annotations: {
      readOnlyHint: false, // Fetch modifies refs but not working tree; not strictly read-only but safe
    },
    parameters: WorkspacePickSchema.extend({
      remote: z
        .string()
        .optional()
        .default("origin")
        .describe("Remote to fetch from (default: origin)."),
      branch: z.string().optional().describe("If specified: fetch only this branch (e.g. 'main')."),
      prune: z
        .boolean()
        .optional()
        .default(false)
        .describe("Pass --prune to remove deleted remote branches (default: false)."),
      tags: z
        .boolean()
        .optional()
        .default(false)
        .describe("Pass --tags to also fetch all tags (default: false)."),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args, undefined);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const gitTop = pre.gitTop;
      const remote = (args.remote ?? "origin").trim();
      const branch = args.branch?.trim();
      const prune = args.prune === true;
      const tags = args.tags === true;

      // Build git fetch command
      const fetchArgs: string[] = ["fetch"];

      if (prune) {
        fetchArgs.push("--prune");
      }

      if (tags) {
        fetchArgs.push("--tags");
      }

      fetchArgs.push(remote);

      if (branch) {
        fetchArgs.push(branch);
      }

      const result = await spawnGitAsync(gitTop, fetchArgs);
      const { updatedRefs, newRefs } = parseGitFetchOutput(result.stdout + result.stderr);

      const fetchResult: GitFetchResult = {
        remote,
        updatedRefs,
        newRefs,
        output: (result.stdout + result.stderr).trim(),
      };

      if (args.format === "json") {
        return jsonRespond(fetchResult as unknown as Record<string, unknown>);
      }

      // Markdown output
      const lines: string[] = [`# Git fetch from '${remote}'`];

      if (!result.ok) {
        lines.push("", "**Status**: Failed", "");
        lines.push("```", result.stdout || result.stderr || "(no output)", "```");
        return lines.join("\n");
      }

      lines.push("", "**Status**: Success", "");

      if (updatedRefs.length > 0) {
        lines.push("## Updated refs", "");
        for (const ref of updatedRefs) {
          lines.push(`- ${ref}`);
        }
      }

      if (newRefs.length > 0) {
        lines.push("", "## New refs", "");
        for (const ref of newRefs) {
          lines.push(`- ${ref}`);
        }
      }

      if (updatedRefs.length === 0 && newRefs.length === 0 && result.stdout.trim()) {
        lines.push("", "## Output", "", "```", result.stdout.trim(), "```");
      }

      return lines.join("\n");
    },
  });
}
