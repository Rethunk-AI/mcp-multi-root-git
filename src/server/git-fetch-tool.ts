import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { isSafeGitUpstreamToken, spawnGitAsync } from "./git.js";
import { jsonRespond, spreadWhen } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpdatedRefDelta {
  ref: string;
  oldSha: string;
  newSha: string;
  flag: string;
}

interface CreatedRefDelta {
  ref: string;
  newSha: string;
  flag: string;
}

interface PrunedRefDelta {
  ref: string;
}

interface GitFetchResult {
  ok: boolean;
  remote: string;
  updatedRefs: string[];
  newRefs: string[];
  output: string;
  // Structured deltas — present only when non-empty (v3 "omit when empty" convention)
  updated?: UpdatedRefDelta[];
  created?: CreatedRefDelta[];
  pruned?: PrunedRefDelta[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `git fetch` output to extract updated and new refs.
 * Lines containing "[new" indicate new refs (new branch, new tag, new ref).
 * Lines with " -> " but not containing "[new" indicate updated refs.
 */
export function parseGitFetchOutput(output: string): { updatedRefs: string[]; newRefs: string[] } {
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

const ZEROS_SHA = "0000000000000000000000000000000000000000";

/**
 * Parse `git fetch --porcelain` stdout.
 *
 * Machine-readable lines have the form:
 *   <flag><SP><old-sha><SP><new-sha><SP><local-ref>
 *
 * Flags:
 *   ' ' = fast-forward update
 *   '+' = forced update
 *   '*' = new ref
 *   '-' = pruned (deleted)
 *   '!' = rejected
 *   '=' = up-to-date (no change)
 *   't' = tag update
 */
function parsePorcelainOutput(stdout: string): {
  updated: UpdatedRefDelta[];
  created: CreatedRefDelta[];
  pruned: PrunedRefDelta[];
} {
  const updated: UpdatedRefDelta[] = [];
  const created: CreatedRefDelta[] = [];
  const pruned: PrunedRefDelta[] = [];

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    // Porcelain lines: flag(1) + space(1) + old-sha + space + new-sha + space + ref
    // Minimum viable line: 1 flag + 1 space + at least some content
    if (line.length < 3) continue;

    const flag = line[0];
    const rest = line.slice(2); // skip "flag " prefix
    const parts = rest.split(" ");
    // Expected: [old-sha, new-sha, ref...]
    if (parts.length < 3) continue;

    const oldSha = parts[0] ?? "";
    const newSha = parts[1] ?? "";
    const ref = parts.slice(2).join(" ");

    if (!ref) continue;

    if (flag === "-") {
      pruned.push({ ref });
    } else if (flag === "*" || oldSha === ZEROS_SHA) {
      // New ref: flag is '*' OR old-sha is all-zeros
      created.push({ ref, newSha, flag: flag ?? "*" });
    } else if (flag === " " || flag === "+" || flag === "t") {
      // Update: old and new differ
      if (oldSha !== newSha) {
        updated.push({ ref, oldSha, newSha, flag: flag ?? " " });
      }
    }
    // '!' (rejected) and '=' (up-to-date) are intentionally ignored
  }

  return { updated, created, pruned };
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
    parameters: WorkspacePickSchema.omit({ absoluteGitRoots: true, allWorkspaceRoots: true })
      .pick({
        workspaceRoot: true,
        rootIndex: true,
        format: true,
      })
      .extend({
        remote: z
          .string()
          .optional()
          .default("origin")
          .describe("Remote to fetch from (default: origin)."),
        branch: z
          .string()
          .optional()
          .describe("If specified: fetch only this branch (e.g. 'main')."),
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
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) {
        return jsonRespond(pre.error);
      }

      const gitTop = pre.gitTop;
      const remote = (args.remote ?? "origin").trim();
      const branch = args.branch?.trim();
      const prune = args.prune === true;
      const tags = args.tags === true;

      // Validate remote and branch to prevent argument injection.
      if (!isSafeGitUpstreamToken(remote)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REMOTE_TOKEN, remote });
      }
      if (branch && !isSafeGitUpstreamToken(branch)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, branch });
      }

      // Build base fetch args (without --porcelain for now)
      const baseArgs: string[] = ["fetch"];

      if (prune) {
        baseArgs.push("--prune");
      }

      if (tags) {
        baseArgs.push("--tags");
      }

      baseArgs.push(remote);

      if (branch) {
        baseArgs.push(branch);
      }

      // --- Attempt structured fetch with --porcelain (requires git >= 2.41) ---
      let structured: {
        updated: UpdatedRefDelta[];
        created: CreatedRefDelta[];
        pruned: PrunedRefDelta[];
      } | null = null;
      let result: { ok: boolean; stdout: string; stderr: string };

      const porcelainArgs = ["fetch", "--porcelain"];
      if (prune) porcelainArgs.push("--prune");
      if (tags) porcelainArgs.push("--tags");
      porcelainArgs.push(remote);
      if (branch) porcelainArgs.push(branch);

      const porcelainResult = await spawnGitAsync(gitTop, porcelainArgs);

      if (
        !porcelainResult.ok &&
        (porcelainResult.stderr.includes("unknown option") ||
          porcelainResult.stderr.includes("unknown switch") ||
          porcelainResult.stderr.includes("invalid option"))
      ) {
        // --porcelain not supported: fall back to plain fetch
        result = await spawnGitAsync(gitTop, baseArgs);
        structured = null;
      } else {
        // Use porcelain result (ok or actual fetch error)
        result = porcelainResult;
        if (porcelainResult.ok || !porcelainResult.stderr.includes("unknown option")) {
          structured = parsePorcelainOutput(porcelainResult.stdout);
        }
      }

      // Legacy string-line parse: use combined output when porcelain is unavailable.
      // When porcelain succeeded, derive legacy fields from structured data so
      // that callers who rely on updatedRefs/newRefs still get useful values.
      let updatedRefs: string[];
      let newRefs: string[];
      if (structured !== null) {
        // Derive legacy string arrays from structured deltas
        updatedRefs = structured.updated.map(
          (d) => `${d.oldSha.slice(0, 7)}..${d.newSha.slice(0, 7)}  ${d.ref}`,
        );
        newRefs = structured.created.map((d) => `[new ref] ${d.ref} -> ${d.newSha.slice(0, 7)}`);
      } else {
        const parsed = parseGitFetchOutput(result.stdout + result.stderr);
        updatedRefs = parsed.updatedRefs;
        newRefs = parsed.newRefs;
      }

      const fetchResult: GitFetchResult = {
        ok: result.ok,
        remote,
        updatedRefs,
        newRefs,
        output: (result.stdout + result.stderr).trim(),
        ...spreadWhen(structured !== null && structured.updated.length > 0, {
          updated: structured?.updated ?? [],
        }),
        ...spreadWhen(structured !== null && structured.created.length > 0, {
          created: structured?.created ?? [],
        }),
        ...spreadWhen(structured !== null && structured.pruned.length > 0, {
          pruned: structured?.pruned ?? [],
        }),
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

      // Prefer structured deltas in markdown when available
      if (structured !== null && structured.updated.length > 0) {
        lines.push("## Updated refs", "");
        for (const d of structured.updated) {
          lines.push(`- \`${d.ref}\` ${d.oldSha.slice(0, 7)}→${d.newSha.slice(0, 7)}`);
        }
      } else if (updatedRefs.length > 0) {
        lines.push("## Updated refs", "");
        for (const ref of updatedRefs) {
          lines.push(`- ${ref}`);
        }
      }

      if (structured !== null && structured.created.length > 0) {
        lines.push("", "## New refs", "");
        for (const d of structured.created) {
          lines.push(`- \`${d.ref}\` (new, ${d.newSha.slice(0, 7)})`);
        }
      } else if (newRefs.length > 0) {
        lines.push("", "## New refs", "");
        for (const ref of newRefs) {
          lines.push(`- ${ref}`);
        }
      }

      if (structured !== null && structured.pruned.length > 0) {
        lines.push("", "## Pruned refs", "");
        for (const d of structured.pruned) {
          lines.push(`- \`${d.ref}\` (deleted)`);
        }
      }

      if (
        updatedRefs.length === 0 &&
        newRefs.length === 0 &&
        (structured === null ||
          (structured.updated.length === 0 && structured.created.length === 0)) &&
        result.stdout.trim()
      ) {
        lines.push("", "## Output", "", "```", result.stdout.trim(), "```");
      }

      return lines.join("\n");
    },
  });
}
