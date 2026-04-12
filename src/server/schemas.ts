import { z } from "zod";

import { MAX_INVENTORY_ROOTS_DEFAULT } from "./inventory.js";

const FormatSchema = z.enum(["markdown", "json"]).optional().default("markdown");

export const WorkspacePickSchema = z.object({
  workspaceRoot: z.string().optional().describe("Override workspace path (highest priority)."),
  rootIndex: z.number().int().min(0).optional().describe("Nth MCP root (0-based)."),
  allWorkspaceRoots: z.boolean().optional().default(false).describe("Run against every MCP root."),
  format: FormatSchema,
});

export { MAX_INVENTORY_ROOTS_DEFAULT };
