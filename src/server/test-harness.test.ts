import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { registerGitStatusTool } from "./git-status-tool.js";
import {
  captureTool,
  captureToolDefinitions,
  cleanupTmpPaths,
  gitCmd,
  makeRepo,
  makeRepoWithSeed,
  mkTmpDir,
  registerTmpCleanup,
  trackTmpPath,
  withEnvVar,
  withStderrCapture,
} from "./test-harness.js";

registerTmpCleanup();

describe("captureTool", () => {
  test("throws when register adds no tools", () => {
    expect(() => captureTool(() => undefined)).toThrow(/no tool captured/);
  });

  test("throws when named tool is missing", () => {
    expect(() =>
      captureTool((server) => {
        server.addTool({
          name: "other_tool",
          execute: async () => "ok",
        });
      }, "missing_tool"),
    ).toThrow(/named "missing_tool"/);
  });

  test("invokes execute and returns string results", async () => {
    const run = captureTool(registerGitStatusTool);
    const text = await run({ format: "json" });
    const parsed = JSON.parse(text) as { groups?: unknown; error?: string };
    expect(parsed.groups !== undefined || parsed.error !== undefined).toBe(true);
  });
});

describe("captureToolDefinitions", () => {
  test("returns all registered tools", () => {
    const tools = captureToolDefinitions(registerGitStatusTool);
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("git_status");
    expect(typeof tools[0]?.execute).toBe("function");
  });

  test("fake server addResource stub accepts registration", () => {
    expect(() => {
      captureToolDefinitions((server) => {
        server.addResource?.({
          name: "presets",
          uri: "rethunk-git://presets",
          load: async () => ({ text: "{}" }),
        });
      });
    }).not.toThrow();
  });
});

describe("tmp dir lifecycle", () => {
  afterEach(cleanupTmpPaths);

  test("mkTmpDir + cleanupTmpPaths removes tracked directories", () => {
    const dir = mkTmpDir("harness-cleanup-");
    expect(existsSync(dir)).toBe(true);
    cleanupTmpPaths();
    expect(existsSync(dir)).toBe(false);
  });

  test("cleanupTmpPaths removes multiple tracked paths", () => {
    const a = mkTmpDir("harness-multi-a-");
    const b = mkTmpDir("harness-multi-b-");
    trackTmpPath(join(a, "nested-only-tracked-for-rmSync-recursive"));
    cleanupTmpPaths();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  test("cleanupTmpPaths is safe when nothing is tracked", () => {
    expect(() => cleanupTmpPaths()).not.toThrow();
  });
});

describe("git helpers", () => {
  test("makeRepo initializes a git repo with main branch", () => {
    const dir = makeRepo("harness-repo-");
    expect(existsSync(join(dir, ".git"))).toBe(true);
    const branch = gitCmd(dir, "branch", "--show-current").trim();
    expect(branch).toBe("main");
    cleanupTmpPaths();
  });

  test("makeRepoWithSeed creates an initial commit", () => {
    const dir = makeRepoWithSeed("harness-seed-");
    const log = gitCmd(dir, "log", "--oneline").trim();
    expect(log).toMatch(/^[\da-f]+ chore: seed$/);
    cleanupTmpPaths();
  });

  test("registerTmpCleanup is exported for per-file setup", () => {
    expect(typeof registerTmpCleanup).toBe("function");
  });

  test("gitCmd failures do not leak stderr to the parent process, and attach it to the thrown error", () => {
    const dir = makeRepo("harness-stderr-");
    let caughtStderr: string | undefined;
    const writes = withStderrCapture(() => {
      try {
        gitCmd(dir, "show", "refs/does-not-exist");
      } catch (err) {
        caughtStderr = (err as { stderr?: string }).stderr;
      }
    });
    expect(writes).toEqual([]);
    expect(caughtStderr).toBeTruthy();
    cleanupTmpPaths();
  });
});

describe("withEnvVar", () => {
  const PROBE = "MCP_TEST_HARNESS_ENV_PROBE";

  afterEach(() => {
    delete process.env[PROBE];
  });

  test("sets the value for the duration of fn and restores the previous value", () => {
    process.env[PROBE] = "before";
    withEnvVar(PROBE, "during", () => {
      expect(process.env[PROBE]).toBe("during");
    });
    expect(process.env[PROBE]).toBe("before");
  });

  test("deletes the var when value is undefined, then restores the previous value", () => {
    process.env[PROBE] = "before";
    withEnvVar(PROBE, undefined, () => {
      expect(process.env[PROBE]).toBeUndefined();
    });
    expect(process.env[PROBE]).toBe("before");
  });

  test("restores to unset when the var was unset beforehand", () => {
    delete process.env[PROBE];
    withEnvVar(PROBE, "during", () => {
      expect(process.env[PROBE]).toBe("during");
    });
    expect(process.env[PROBE]).toBeUndefined();
  });

  test("restores the previous value even when fn throws", () => {
    process.env[PROBE] = "before";
    expect(() =>
      withEnvVar(PROBE, "during", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(process.env[PROBE]).toBe("before");
  });
});

describe("withStderrCapture", () => {
  test("captures writes in order and restores the original writer", () => {
    const orig = process.stderr.write;
    const writes = withStderrCapture(() => {
      process.stderr.write("first\n");
      process.stderr.write("second\n");
    });
    expect(writes).toEqual(["first\n", "second\n"]);
    expect(process.stderr.write).toBe(orig);
  });

  test("restores the original writer even when fn throws", () => {
    const orig = process.stderr.write;
    expect(() =>
      withStderrCapture(() => {
        process.stderr.write("oops\n");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(process.stderr.write).toBe(orig);
  });
});
