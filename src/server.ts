#!/usr/bin/env node
import { FastMCP } from "fastmcp";

import { readMcpServerVersion } from "./server/json.js";
import { registerRethunkGitTools } from "./server/tools.js";

/**
 * JSON payload contract version. Bump on incompatible JSON output changes
 * (renamed/nested/omitted fields). Surfaced via the FastMCP `instructions`
 * field below, so it is discoverable in the MCP `initialize` response.
 */
export const MCP_JSON_FORMAT_VERSION = "5";

const server = new FastMCP({
  name: "rethunk-git",
  version: readMcpServerVersion(),
  instructions: `rethunk-git MCP server. JSON payload contract: format version ${MCP_JSON_FORMAT_VERSION} (minified, no envelope; optional fields omitted when empty/null/false).`,
  roots: { enabled: true },
});

registerRethunkGitTools(server);

void server.start({ transportType: "stdio" });
