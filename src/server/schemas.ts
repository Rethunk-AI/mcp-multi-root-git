import { z } from "zod";

import { MAX_INVENTORY_ROOTS_DEFAULT } from "./inventory.js";

const FormatSchema = z.enum(["markdown", "json"]).optional().default("markdown");

/** Max entries when `root` is an array (matches `git_inventory` `maxRoots` hard cap). */
export const MAX_ROOT_PATHS = 256;

/** Single-repo tools: one optional repo-path override plus output format. */
export const WorkspacePickSchema = z.object({
  workspaceRoot: z.string().optional().describe("Repo path. Default: first MCP root / cwd."),
  format: FormatSchema,
});

/**
 * Fan-out tools: one polymorphic routing param plus output format.
 *
 * Array length is intentionally uncapped here so `resolveRootPathList` can
 * return the structured `{ error: root_list_too_many, max, count }` JSON
 * payload. Zod `.max(MAX_ROOT_PATHS)` would reject with `too_big` before execute.
 * The `"*"` sentinel is a plain string (no redundant `z.literal("*")`).
 */
export const RootPickSchema = z.object({
  root: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Repo path, array of paths, or "*" for all MCP roots.'),
  format: FormatSchema,
});

export { MAX_INVENTORY_ROOTS_DEFAULT };
