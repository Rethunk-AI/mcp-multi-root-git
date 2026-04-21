import { z } from "zod";

import { MAX_INVENTORY_ROOTS_DEFAULT } from "./inventory.js";

const FormatSchema = z.enum(["markdown", "json"]).optional().default("markdown");

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
  format: FormatSchema,
});

export { MAX_INVENTORY_ROOTS_DEFAULT };
