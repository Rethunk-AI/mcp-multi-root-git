import { z } from "zod";

import { MAX_INVENTORY_ROOTS_DEFAULT } from "./inventory.js";

const FormatSchema = z.enum(["markdown", "json"]).optional().default("markdown");

/** Max paths in `absoluteGitRoots` (matches `git_inventory` `maxRoots` hard cap). */
export const MAX_ABSOLUTE_GIT_ROOTS = 256;

export const WorkspacePickSchema = z.object({
  workspaceRoot: z.string().optional().describe("Highest-priority override."),
  rootIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based index into the MCP file roots list; ignored when workspaceRoot is set."),
  allWorkspaceRoots: z
    .boolean()
    .optional()
    .default(false)
    .describe("Fan out across all MCP file roots."),
  /** Independent git worktrees (sibling clones). Mutually exclusive with workspaceRoot, rootIndex, allWorkspaceRoots, and (git_inventory) preset/nestedRoots. */
  absoluteGitRoots: z
    .array(z.string())
    .max(MAX_ABSOLUTE_GIT_ROOTS)
    .optional()
    .describe(
      "Absolute paths to git repo roots. Use for many sibling clones under a non-git parent directory.",
    ),
  format: FormatSchema,
});

export { MAX_INVENTORY_ROOTS_DEFAULT };
