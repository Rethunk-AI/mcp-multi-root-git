import { z } from "zod";

import { MAX_INVENTORY_ROOTS_DEFAULT } from "./inventory.js";

const FormatSchema = z.enum(["markdown", "json"]).optional().default("markdown");

export const WorkspacePickSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe("Override workspace path. Wins over MCP roots, rootIndex, and allWorkspaceRoots."),
  rootIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Use the Nth file:// MCP root (0-based) when multiple workspace roots exist."),
  allWorkspaceRoots: z
    .boolean()
    .optional()
    .default(false)
    .describe("Run against every file:// MCP root and aggregate results."),
  format: FormatSchema.describe('Return "markdown" (default) or structured "json".'),
});

export { MAX_INVENTORY_ROOTS_DEFAULT };
