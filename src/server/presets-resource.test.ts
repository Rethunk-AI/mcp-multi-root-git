import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastMCP } from "fastmcp";

import { registerPresetsResource } from "./presets-resource.js";
import { cleanupTmpPaths, gitCmd, mkTmpDir, writeTestGitConfig } from "./test-harness.js";

afterEach(cleanupTmpPaths);

type CapturedResource = { load: () => Promise<{ text: string }> };

/**
 * `captureTool` (test-harness.ts) treats `addResource` as a no-op stub since
 * tool tests don't need it. Resources aren't invoked with per-call args (no
 * `execute(args)`), so the only way to point `registerPresetsResource` at a
 * given repo is via the fake server's MCP session file roots — build a
 * minimal fake server here that captures the registered resource instead.
 */
function makeFakeServerWithRoot(root: string): FastMCP {
  let captured: CapturedResource | undefined;
  const server = {
    sessions: [{ roots: [{ uri: `file://${root}` }] }],
    addResource(resource: CapturedResource) {
      captured = resource;
    },
  } as unknown as FastMCP & { __captured: () => CapturedResource | undefined };
  Object.defineProperty(server, "__captured", { value: () => captured });
  return server;
}

async function loadResource(root: string): Promise<Record<string, unknown>> {
  const server = makeFakeServerWithRoot(root);
  registerPresetsResource(server);
  const captured = (server as unknown as { __captured: () => CapturedResource }).__captured();
  if (!captured) throw new Error("registerPresetsResource did not register a resource");
  const result = await captured.load();
  return JSON.parse(result.text) as Record<string, unknown>;
}

function makeRepoWithPresets(): string {
  const dir = mkTmpDir("mcp-git-presets-resource-test-");
  gitCmd(dir, "init", "-b", "main");
  writeTestGitConfig(dir);

  const presetDir = join(dir, ".rethunk");
  mkdirSync(presetDir);
  writeFileSync(
    join(presetDir, "git-mcp-presets.json"),
    JSON.stringify({
      schemaVersion: "1",
      presets: {
        default: {
          nestedRoots: ["packages/a", "packages/b"],
        },
      },
    }),
  );

  return dir;
}

describe("rethunk-git://presets resource", () => {
  test("loads presets from a valid preset file", async () => {
    const dir = makeRepoWithPresets();

    const parsed = await loadResource(dir);

    expect(parsed.fileExists).toBe(true);
    expect(parsed.presetSchemaVersion).toBe("1");
    expect(parsed.presets).toEqual({ default: { nestedRoots: ["packages/a", "packages/b"] } });
  });

  test("reports invalid preset file (bad JSON)", async () => {
    const dir = mkTmpDir("mcp-git-presets-resource-invalid-");
    gitCmd(dir, "init", "-b", "main");
    writeTestGitConfig(dir);

    const presetDir = join(dir, ".rethunk");
    mkdirSync(presetDir);
    writeFileSync(join(presetDir, "git-mcp-presets.json"), "{ not valid json");

    const parsed = await loadResource(dir);

    expect(parsed.error).toBe("preset_file_invalid");
    expect(parsed.kind).toBe("invalid_json");
  });

  test("reports fileExists: false when no preset file is present", async () => {
    const dir = mkTmpDir("mcp-git-presets-resource-missing-");
    gitCmd(dir, "init", "-b", "main");
    writeTestGitConfig(dir);

    const parsed = await loadResource(dir);

    expect(parsed.fileExists).toBe(false);
    expect(parsed.presets).toEqual({});
  });
});
