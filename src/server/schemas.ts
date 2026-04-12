import { z } from "zod";

import { MAX_INVENTORY_ROOTS_DEFAULT } from "./inventory.js";

const FormatSchema = z.enum(["markdown", "json"]).optional().default("markdown");

export const WorkspacePickSchema = z.object({
  workspaceRoot: z.string().optional().describe("Highest-priority override."),
  rootIndex: z.number().int().min(0).optional(),
  allWorkspaceRoots: z.boolean().optional().default(false),
  format: FormatSchema,
});

export { MAX_INVENTORY_ROOTS_DEFAULT };
