import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { isSafeGitUpstreamToken, spawnGitAsync } from "./git.js";
import { jsonRespond } from "./json.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TagResult {
  tag: string;
  type: "annotated" | "lightweight" | "deleted";
  sha: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the SHA of a given ref (tag, commit, branch, etc).
 */
async function getRefSha(gitTop: string, ref: string): Promise<string | null> {
  const result = await spawnGitAsync(gitTop, ["rev-parse", ref]);
  if (!result.ok) return null;
  return result.stdout.trim();
}

/**
 * Check if a tag is annotated or lightweight.
 */
async function getTagType(
  gitTop: string,
  tag: string,
): Promise<"annotated" | "lightweight" | null> {
  // For annotated tags, `git cat-file -t <tag>` returns "tag"
  // For lightweight tags, it returns "commit"
  const result = await spawnGitAsync(gitTop, ["cat-file", "-t", tag]);
  if (!result.ok) return null;
  const type = result.stdout.trim();
  if (type === "tag") return "annotated";
  if (type === "commit") return "lightweight";
  return null;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGitTagTool(server: FastMCP): void {
  server.addTool({
    name: "git_tag",
    description:
      "Create, delete, or inspect git tags. Create annotated tags (with message) or lightweight tags (ref only). " +
      "Returns tag name, type, and SHA.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
    },
    parameters: WorkspacePickSchema.omit({ absoluteGitRoots: true }).extend({
      tag: z.string().min(1).describe("Tag name (e.g. 'v1.2.3')."),
      message: z
        .string()
        .optional()
        .describe(
          "If provided, create an annotated tag with this message. If absent, create a lightweight tag.",
        ),
      ref: z
        .string()
        .optional()
        .describe("Commit/ref to tag (default: HEAD). Ignored if `delete` is true."),
      delete: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, delete the named tag instead of creating it."),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const gitTop = pre.gitTop;

      const tag = args.tag.trim();
      if (!tag) {
        return jsonRespond({ error: "tag_empty" });
      }

      // Validate tag name: no shell metacharacters
      if (!isSafeGitUpstreamToken(tag)) {
        return jsonRespond({ error: "tag_unsafe", tag });
      }

      // Handle deletion
      if (args.delete === true) {
        const delResult = await spawnGitAsync(gitTop, ["tag", "-d", tag]);
        if (!delResult.ok) {
          return jsonRespond({
            error: "tag_delete_failed",
            detail: (delResult.stderr || delResult.stdout).trim(),
          });
        }

        if (args.format === "json") {
          return jsonRespond({
            tag,
            type: "deleted",
            sha: "", // Deleted tags have no SHA
          } as unknown as Record<string, unknown>);
        }

        return `Deleted tag: ${tag}`;
      }

      // Determine the ref to tag (default HEAD)
      const ref = (args.ref ?? "HEAD").trim();
      if (!isSafeGitUpstreamToken(ref)) {
        return jsonRespond({ error: "ref_unsafe", ref });
      }

      // Get the SHA of the ref to tag
      const sha = await getRefSha(gitTop, ref);
      if (!sha) {
        return jsonRespond({
          error: "ref_not_found",
          ref,
        });
      }

      // Create tag (annotated or lightweight)
      const tagArgs: string[] = ["tag"];

      if (args.message) {
        // Annotated tag
        tagArgs.push("-a", "-m", args.message);
      } else {
        // Lightweight tag (just the tag name and ref)
      }

      tagArgs.push(tag, ref);

      const createResult = await spawnGitAsync(gitTop, tagArgs);
      if (!createResult.ok) {
        return jsonRespond({
          error: "tag_create_failed",
          detail: (createResult.stderr || createResult.stdout).trim(),
        });
      }

      // Verify the tag was created and get its type
      const tagType = await getTagType(gitTop, tag);
      if (!tagType) {
        return jsonRespond({
          error: "tag_verification_failed",
          tag,
        });
      }

      const result: TagResult = {
        tag,
        type: tagType,
        sha,
      };

      if (args.format === "json") {
        return jsonRespond(result as unknown as Record<string, unknown>);
      }

      // Markdown output
      const lines: string[] = [];
      lines.push(`# Tag: ${tag}`);
      lines.push("");
      lines.push(`**Type:** ${tagType}`);
      lines.push(`**SHA:** \`${sha}\``);
      if (args.message) {
        lines.push("");
        lines.push("**Message:**");
        lines.push("");
        lines.push("```");
        lines.push(args.message);
        lines.push("```");
      }

      return lines.join("\n");
    },
  });
}
