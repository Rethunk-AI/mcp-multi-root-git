import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { spawnGitAsync } from "./git.js";
import { isSafeGitAncestorRef } from "./git-refs.js";
import { jsonRespond } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DescribeResult {
  describe: string;
  tag: string;
  distance: number;
  sha: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Conservative check for the `--match` glob token passed to `git describe`.
 * Restricted to a safe glob subset (`A-Za-z0-9_.*?/[]-`) and must not start
 * with `-` (would otherwise be interpreted as another flag by git's argv).
 */
export function isSafeMatchPattern(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 256) return false;
  if (t.startsWith("-")) return false;
  return /^[A-Za-z0-9_.*?/[\]-]+$/.test(t);
}

/** True when git's stderr indicates no tag was reachable from the described ref. */
function isNoTagFoundError(stderr: string): boolean {
  return /No names found, cannot describe anything|No tags can describe|No annotated tags can describe/i.test(
    stderr,
  );
}

/**
 * Parse `git describe --long` output of the form `<tag>-<distance>-g<sha>`.
 * The tag itself may contain hyphens, so the regex greedily captures
 * everything up to the final `-<digits>-g<hex>` suffix.
 */
export function parseDescribeOutput(describe: string): DescribeResult | null {
  const m = /^(.+)-(\d+)-g([0-9a-fA-F]+)$/.exec(describe);
  if (!m) return null;
  const tag = m[1];
  const distanceStr = m[2];
  const sha = m[3];
  if (tag === undefined || distanceStr === undefined || sha === undefined) return null;
  const distance = Number.parseInt(distanceStr, 10);
  if (Number.isNaN(distance)) return null;
  return { describe, tag, distance, sha };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderDescribeMarkdown(result: DescribeResult): string {
  const lines: string[] = ["# git describe"];
  lines.push("");
  lines.push(`**Describe:** \`${result.describe}\``);
  lines.push(`**Tag:** ${result.tag}`);
  lines.push(`**Distance:** ${result.distance}`);
  lines.push(`**SHA:** \`${result.sha}\``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitDescribeTool(server: FastMCP): void {
  server.addTool({
    name: "git_describe",
    description:
      "Describe a commit relative to the nearest reachable tag (`git describe --long`). " +
      "Returns the raw describe string plus parsed tag, distance (commits since tag), and short SHA.",
    annotations: {
      readOnlyHint: true,
    },
    parameters: WorkspacePickSchema.extend({
      ref: z.string().optional().describe("Commit-ish to describe (default: HEAD)."),
      tags: z
        .boolean()
        .optional()
        .default(true)
        .describe("When true (default), pass --tags so lightweight tags are also considered."),
      match: z
        .string()
        .optional()
        .describe(
          "Optional glob to restrict candidate tags (passed as --match). Safe glob subset only.",
        ),
      abbrev: z
        .number()
        .int()
        .min(0)
        .max(40)
        .optional()
        .describe("Number of hex digits for the abbreviated SHA (passed as --abbrev=<n>)."),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const top = pre.gitTop;

      const ref = (args.ref ?? "HEAD").trim();
      if (!isSafeGitAncestorRef(ref)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref });
      }

      const match = args.match?.trim();
      if (match !== undefined && !isSafeMatchPattern(match)) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_MATCH_PATTERN, match });
      }

      const describeArgs: string[] = ["describe", "--long"];
      if (args.tags !== false) {
        describeArgs.push("--tags");
      }
      if (match !== undefined) {
        describeArgs.push("--match", match);
      }
      if (args.abbrev !== undefined) {
        describeArgs.push(`--abbrev=${args.abbrev}`);
      }
      describeArgs.push(ref);

      const r = await spawnGitAsync(top, describeArgs);
      if (!r.ok) {
        const stderr = (r.stderr || r.stdout).trim();
        if (isNoTagFoundError(stderr)) {
          return jsonRespond({ error: ERROR_CODES.NO_TAG_FOUND, ref });
        }
        return jsonRespond({ error: ERROR_CODES.DESCRIBE_FAILED, detail: stderr });
      }

      const describe = r.stdout.trim();
      const parsed = parseDescribeOutput(describe);
      if (!parsed) {
        return jsonRespond({ error: ERROR_CODES.DESCRIBE_FAILED, detail: describe });
      }

      if (args.format === "json") {
        return jsonRespond(parsed as unknown as Record<string, unknown>);
      }

      return renderDescribeMarkdown(parsed);
    },
  });
}
