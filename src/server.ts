#!/usr/bin/env node
import { FastMCP } from "fastmcp";

import { readMcpServerVersion } from "./server/json.js";
import { registerRethunkGitTools } from "./server/tools.js";

const server = new FastMCP({
  name: "rethunk-git",
  version: readMcpServerVersion(),
  roots: { enabled: true },
});

registerRethunkGitTools(server);

void server.start({ transportType: "stdio" });
