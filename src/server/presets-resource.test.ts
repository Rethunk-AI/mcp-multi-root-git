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
function makeFakeServerWithRoots(roots: string[]): FastMCP {
  let captured: CapturedResource | undefined;
  const server = {
    sessions: [{ roots: roots.map((root) => ({ uri: `file://${root}` })) }],
    addResource(resource: CapturedResource) {
      captured = resource;
    },
  } as unknown as FastMCP & { __captured: () => CapturedResource | undefined };
  Object.defineProperty(server, "__captured", { value: () => captured });
  return server;
}

async function loadResource(roots: string | string[]): Promise<Record<string, unknown>> {
  const rootList = Array.isArray(roots) ? roots : [roots];
  const server = makeFakeServerWithRoots(rootList);
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

function firstRoot(parsed: Record<string, unknown>): Record<string, unknown> {
  const roots = parsed.roots as Record<string, unknown>[] | undefined;
  if (!roots?.[0]) throw new Error("expected roots[0]");
  return roots[0];
}

describe("rethunk-git://presets resource", () => {
  test("loads presets from a valid preset file", async () => {
    const dir = makeRepoWithPresets();

    const parsed = await loadResource(dir);
    const row = firstRoot(parsed);

    expect(row.fileExists).toBe(true);
    expect(row.presetSchemaVersion).toBe("1");
    expect(row.presets).toEqual({ default: { nestedRoots: ["packages/a", "packages/b"] } });
  });

  test("reports invalid preset file (bad JSON)", async () => {
    const dir = mkTmpDir("mcp-git-presets-resource-invalid-");
    gitCmd(dir, "init", "-b", "main");
    writeTestGitConfig(dir);

    const presetDir = join(dir, ".rethunk");
    mkdirSync(presetDir);
    writeFileSync(join(presetDir, "git-mcp-presets.json"), "{ not valid json");

    const parsed = await loadResource(dir);
    const row = firstRoot(parsed);

    expect(row.error).toEqual(
      expect.objectContaining({
        error: "preset_file_invalid",
        kind: "invalid_json",
      }),
    );
  });

  test("reports schema error for invalid preset file content", async () => {
    const dir = mkTmpDir("mcp-git-presets-resource-schema-");
    gitCmd(dir, "init", "-b", "main");
    writeTestGitConfig(dir);

    const presetDir = join(dir, ".rethunk");
    mkdirSync(presetDir);
    writeFileSync(
      join(presetDir, "git-mcp-presets.json"),
      JSON.stringify({ schemaVersion: "2", presets: { p: { nestedRoots: ["a"] } } }),
    );

    const parsed = await loadResource(dir);
    const row = firstRoot(parsed);

    expect(row.error).toEqual(
      expect.objectContaining({
        error: "preset_file_invalid",
        kind: "schema",
      }),
    );
  });

  test("reports fileExists: false when no preset file is present", async () => {
    const dir = mkTmpDir("mcp-git-presets-resource-missing-");
    gitCmd(dir, "init", "-b", "main");
    writeTestGitConfig(dir);

    const parsed = await loadResource(dir);
    const row = firstRoot(parsed);

    expect(row.fileExists).toBe(false);
    expect(row.presets).toEqual({});
  });

  test("reports NOT_A_GIT_REPOSITORY when MCP root is outside a repo", async () => {
    const dir = mkTmpDir("mcp-git-presets-resource-nogit-");

    const parsed = await loadResource(dir);
    const row = firstRoot(parsed);

    expect(row.error).toEqual(
      expect.objectContaining({
        error: "not_a_git_repository",
        path: dir,
      }),
    );
  });

  test("fans out across every MCP root", async () => {
    const repoA = makeRepoWithPresets();
    const repoB = mkTmpDir("mcp-git-presets-resource-b-");
    gitCmd(repoB, "init", "-b", "main");
    writeTestGitConfig(repoB);

    const parsed = await loadResource([repoA, repoB]);
    const roots = parsed.roots as Record<string, unknown>[];

    expect(roots).toHaveLength(2);
    expect(roots[0]?.fileExists).toBe(true);
    expect(roots[1]?.fileExists).toBe(false);
  });
});
