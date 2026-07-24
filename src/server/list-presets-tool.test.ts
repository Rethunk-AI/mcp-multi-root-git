import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerListPresetsTool } from "./list-presets-tool.js";
import {
  captureTool,
  cleanupTmpPaths,
  gitCmd,
  mkTmpDir,
  writeTestGitConfig,
} from "./test-harness.js";

afterEach(cleanupTmpPaths);

function makeRepoWithPresets(): string {
  const dir = mkTmpDir("mcp-git-list-presets-test-");
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
          parityPairs: [{ left: "go.mod", right: "package.json" }],
        },
      },
    }),
  );

  return dir;
}

describe("list_presets", () => {
  test("lists presets from existing file (json), enriched with actual nestedRoots/parityPairs", async () => {
    const dir = makeRepoWithPresets();

    const run = captureTool(registerListPresetsTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      roots: Array<{
        presets: Array<{
          name: string;
          nestedRoots?: string[];
          parityPairs?: Array<{ left: string; right: string }>;
        }>;
      }>;
    };

    expect(parsed.roots).toHaveLength(1);
    expect(parsed.roots[0]?.presets).toHaveLength(1);
    const preset = parsed.roots[0]?.presets[0];
    expect(preset?.name).toBe("default");
    expect(preset?.nestedRoots).toEqual(["packages/a", "packages/b"]);
    expect(preset?.parityPairs).toEqual([{ left: "go.mod", right: "package.json" }]);
  });

  test("omits nestedRoots/parityPairs fields when a preset has neither", async () => {
    const dir = mkTmpDir("mcp-git-list-presets-hint-only-");
    gitCmd(dir, "init", "-b", "main");
    writeTestGitConfig(dir);

    const presetDir = join(dir, ".rethunk");
    mkdirSync(presetDir);
    writeFileSync(
      join(presetDir, "git-mcp-presets.json"),
      JSON.stringify({ hintOnly: { workspaceRootHint: "my-workspace" } }),
    );

    const run = captureTool(registerListPresetsTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as {
      roots: Array<{ presets: Array<Record<string, unknown>> }>;
    };
    const preset = parsed.roots[0]?.presets[0];

    expect(preset?.name).toBe("hintOnly");
    expect(preset?.workspaceRootHint).toBe("my-workspace");
    expect(preset).not.toHaveProperty("nestedRoots");
    expect(preset).not.toHaveProperty("parityPairs");
  });

  test("lists presets from existing file (markdown)", async () => {
    const dir = makeRepoWithPresets();

    const run = captureTool(registerListPresetsTool);
    const text = await run({ root: dir, format: "markdown" });

    expect(text).toContain("# Git MCP presets");
    expect(text).toContain("default");
    expect(text).toContain("nestedRoots=packages/a,packages/b");
    expect(text).toContain("parityPairs=go.mod->package.json");
  });

  test("handles missing preset file", async () => {
    const dir = mkTmpDir("mcp-git-list-presets-no-file-");
    gitCmd(dir, "init", "-b", "main");
    writeTestGitConfig(dir);

    const run = captureTool(registerListPresetsTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as { roots: Array<{ fileExists: boolean }> };

    expect(parsed.roots[0]?.fileExists).toBe(false);
  });

  test("handles non-git directory", async () => {
    const dir = mkTmpDir("mcp-git-list-presets-non-git-");

    const run = captureTool(registerListPresetsTool);
    const text = await run({ root: dir, format: "json" });
    const parsed = JSON.parse(text) as { roots: Array<{ error?: Record<string, unknown> }> };

    expect(parsed.roots[0]?.error).toBeDefined();
    expect(parsed.roots[0]?.error?.error).toBe("not_a_git_repository");
  });
});
