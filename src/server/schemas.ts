import { z } from "zod";

/** Max entries when `root` is an array (matches `git_inventory` `maxRoots` hard cap). */
export const MAX_ROOT_PATHS = 256;

/** Single-repo tools: one optional repo-path override. Output is always JSON (v7+). */
export const WorkspacePickSchema = z.object({
  workspaceRoot: z.string().optional().describe("Repo path. Default: first MCP root / cwd."),
});

/**
 * Fan-out tools: one polymorphic routing param. Output is always JSON (v7+).
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
});
