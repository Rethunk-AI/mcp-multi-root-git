/**
 * Unit tests for src/server/presets.ts.
 *
 * Pure filesystem interactions — no git subprocess needed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPresetNestedRoots,
  applyPresetParityPairs,
  loadPresetsFromGitTop,
  PRESET_FILE_PATH,
  presetLoadErrorPayload,
} from "./presets.js";

const dirs: string[] = [];

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mcp-preset-test-"));
  dirs.push(d);
  return d;
}

function writePresetJson(gitTop: string, content: unknown): void {
  mkdirSync(join(gitTop, ".rethunk"), { recursive: true });
  writeFileSync(join(gitTop, PRESET_FILE_PATH), JSON.stringify(content), "utf8");
}

afterEach(() => {
  while (dirs.length > 0) {
    const p = dirs.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadPresetsFromGitTop — missing file
// ---------------------------------------------------------------------------

describe("loadPresetsFromGitTop — missing", () => {
  test("returns missing when preset file does not exist", () => {
    const dir = makeDir();
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// loadPresetsFromGitTop — invalid JSON
// ---------------------------------------------------------------------------

describe("loadPresetsFromGitTop — invalid JSON", () => {
  test("returns invalid_json for malformed JSON content", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".rethunk"), { recursive: true });
    writeFileSync(join(dir, PRESET_FILE_PATH), "{ not: json }", "utf8");
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_json");
      expect(typeof (result as { message: string }).message).toBe("string");
    }
  });

  test("returns invalid_json when root is an array", () => {
    const dir = makeDir();
    writePresetJson(dir, [1, 2, 3]);
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_json");
  });

  test("returns invalid_json when root is null", () => {
    const dir = makeDir();
    writePresetJson(dir, null);
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_json");
  });

  test("returns invalid_json when root is a string", () => {
    const dir = makeDir();
    writePresetJson(dir, "just a string");
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_json");
  });
});

// ---------------------------------------------------------------------------
// loadPresetsFromGitTop — schema errors
// ---------------------------------------------------------------------------

describe("loadPresetsFromGitTop — schema errors", () => {
  test("returns schema error when nestedRoots is not an array", () => {
    const dir = makeDir();
    writePresetJson(dir, { myPreset: { nestedRoots: "not-an-array" } });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });

  test("returns schema error when parityPairs entry is missing required fields", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { parityPairs: [{ left: "a" }] } }); // missing right
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });

  test("returns schema error for unknown preset entry keys", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { nestedRoots: ["a"], orphan: true } });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });

  test("returns schema error when schemaVersion is not 1", () => {
    const dir = makeDir();
    writePresetJson(dir, {
      schemaVersion: "2",
      presets: { p: { nestedRoots: ["a"] } },
    });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });

  test("returns schema error for empty preset map", () => {
    const dir = makeDir();
    writePresetJson(dir, { schemaVersion: "1", presets: {} });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });

  test("returns schema error when wrapped layout has extra top-level keys", () => {
    const dir = makeDir();
    writePresetJson(dir, {
      presets: { a: { nestedRoots: ["x"] } },
      orphan: { nestedRoots: ["y"] },
    });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });
});

// ---------------------------------------------------------------------------
// loadPresetsFromGitTop — valid flat format
// ---------------------------------------------------------------------------

describe("loadPresetsFromGitTop — valid flat format", () => {
  test("loads nestedRoots, parityPairs, schemaVersion, $schema, and workspaceRootHint together", () => {
    const dir = makeDir();
    writePresetJson(dir, {
      schemaVersion: "1",
      $schema: "https://example.com/schema.json",
      myPreset: { nestedRoots: ["packages/a", "packages/b"], workspaceRootHint: "my-workspace" },
      parity: { parityPairs: [{ left: "pkg/a", right: "pkg/b", label: "A vs B" }] },
    });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // schemaVersion is a string here, exercising the `typeof sv === "string" ? sv : undefined`
      // ternary's true-side inside splitPresetFileRaw.
      expect(result.schemaVersion).toBe("1");
      expect(result.data.$schema).toBeUndefined();
      expect(result.data.myPreset?.nestedRoots).toEqual(["packages/a", "packages/b"]);
      expect(result.data.myPreset?.workspaceRootHint).toBe("my-workspace");
      expect(result.data.parity?.parityPairs).toHaveLength(1);
      expect(result.data.parity?.parityPairs?.[0]?.label).toBe("A vs B");
    }
  });
});

// ---------------------------------------------------------------------------
// loadPresetsFromGitTop — wrapped format (presets key)
// ---------------------------------------------------------------------------

describe("loadPresetsFromGitTop — wrapped format", () => {
  test("loads wrapped format with presets key and schemaVersion 1", () => {
    const dir = makeDir();
    writePresetJson(dir, {
      schemaVersion: "1",
      presets: { myPreset: { nestedRoots: ["packages/c"] } },
    });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schemaVersion).toBe("1");
      expect(result.data.myPreset?.nestedRoots).toEqual(["packages/c"]);
    }
  });

  test("wrapped format without schemaVersion still loads", () => {
    const dir = makeDir();
    writePresetJson(dir, {
      presets: { p: { parityPairs: [{ left: "x", right: "y" }] } },
    });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schemaVersion).toBeUndefined();
  });

  test("legacy flat map supports a preset literally named presets", () => {
    const dir = makeDir();
    writePresetJson(dir, { presets: { nestedRoots: ["packages/a"] } });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.presets?.nestedRoots).toEqual(["packages/a"]);
    }
  });
});

// ---------------------------------------------------------------------------
// presetLoadErrorPayload
// ---------------------------------------------------------------------------

describe("presetLoadErrorPayload", () => {
  test("invalid_json reason includes kind and message", () => {
    const payload = presetLoadErrorPayload("/repo", {
      ok: false,
      reason: "invalid_json",
      message: "Unexpected token",
    });
    expect(payload.error).toBe("preset_file_invalid");
    expect(payload.kind).toBe("invalid_json");
    expect(payload.message).toBe("Unexpected token");
    expect(typeof payload.presetFile).toBe("string");
  });

  test("schema reason includes kind and issues", () => {
    const payload = presetLoadErrorPayload("/repo", {
      ok: false,
      reason: "schema",
      issues: [],
    });
    expect(payload.error).toBe("preset_file_invalid");
    expect(payload.kind).toBe("schema");
    expect(payload.issues).toEqual([]);
  });

  test("missing reason falls back to generic error (no kind)", () => {
    const payload = presetLoadErrorPayload("/repo", {
      ok: false,
      reason: "missing",
    });
    expect(payload.error).toBe("preset_file_invalid");
    expect(payload.kind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyPresetNestedRoots
// ---------------------------------------------------------------------------

describe("applyPresetNestedRoots", () => {
  test("returns preset_not_found when file is missing", () => {
    const dir = makeDir();
    const result = applyPresetNestedRoots(dir, "myPreset", false, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("preset_not_found");
  });

  test("returns preset_not_found when preset name is absent from file", () => {
    const dir = makeDir();
    writePresetJson(dir, { other: { nestedRoots: ["a"] } });
    const result = applyPresetNestedRoots(dir, "myPreset", false, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("preset_not_found");
  });

  test("uses preset roots when no inline provided (presetMerge=false)", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { nestedRoots: ["pkg/a", "pkg/b"] } });
    const result = applyPresetNestedRoots(dir, "p", false, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nestedRoots).toEqual(["pkg/a", "pkg/b"]);
  });

  test("uses inline roots when provided (presetMerge=false)", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { nestedRoots: ["pkg/a"] } });
    const result = applyPresetNestedRoots(dir, "p", false, ["inline/x"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nestedRoots).toEqual(["inline/x"]);
  });

  test("merges preset and inline when presetMerge=true", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { nestedRoots: ["pkg/a"] } });
    const result = applyPresetNestedRoots(dir, "p", true, ["pkg/b"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nestedRoots).toContain("pkg/a");
      expect(result.nestedRoots).toContain("pkg/b");
    }
  });

  test("deduplicates when merging overlapping roots", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { nestedRoots: ["pkg/a", "pkg/b"] } });
    const result = applyPresetNestedRoots(dir, "p", true, ["pkg/a", "pkg/c"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const roots = result.nestedRoots ?? [];
      expect(roots.filter((r) => r === "pkg/a")).toHaveLength(1);
      expect(roots).toContain("pkg/c");
    }
  });

  test("returns error from invalid preset file", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".rethunk"), { recursive: true });
    writeFileSync(join(dir, PRESET_FILE_PATH), "{ bad json", "utf8");
    const result = applyPresetNestedRoots(dir, "p", false, undefined);
    expect(result.ok).toBe(false);
  });

  test("exposes schemaVersion from a wrapped preset", () => {
    const dir = makeDir();
    writePresetJson(dir, {
      schemaVersion: "1",
      presets: { p: { nestedRoots: ["a"] } },
    });
    const result = applyPresetNestedRoots(dir, "p", false, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.presetSchemaVersion).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// applyPresetParityPairs
// ---------------------------------------------------------------------------

describe("applyPresetParityPairs", () => {
  test("returns error when preset not found", () => {
    const dir = makeDir();
    const result = applyPresetParityPairs(dir, "missing", false, undefined);
    expect(result.ok).toBe(false);
  });

  test("uses preset pairs when no inline provided", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { parityPairs: [{ left: "a", right: "b" }] } });
    const result = applyPresetParityPairs(dir, "p", false, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs?.[0]).toMatchObject({ left: "a", right: "b" });
    }
  });

  test("uses inline pairs when provided (presetMerge=false)", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { parityPairs: [{ left: "a", right: "b" }] } });
    const result = applyPresetParityPairs(dir, "p", false, [{ left: "x", right: "y" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs?.[0]).toMatchObject({ left: "x", right: "y" });
    }
  });

  test("merges pairs when presetMerge=true", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { parityPairs: [{ left: "a", right: "b" }] } });
    const result = applyPresetParityPairs(dir, "p", true, [{ left: "x", right: "y" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pairs).toHaveLength(2);
  });

  test("deduplicates identical pairs when presetMerge=true", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { parityPairs: [{ left: "a", right: "b", label: "from preset" }] } });
    const result = applyPresetParityPairs(dir, "p", true, [
      { left: "a", right: "b", label: "inline" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs?.[0]?.label).toBe("from preset");
    }
  });

  test("returns error when preset file has invalid JSON", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".rethunk"), { recursive: true });
    writeFileSync(join(dir, PRESET_FILE_PATH), "bad json", "utf8");
    const result = applyPresetParityPairs(dir, "p", false, undefined);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zod ↔ git-mcp-presets.schema.json alignment gate
// ---------------------------------------------------------------------------

describe("preset schema alignment gate", () => {
  test("rejects schemaVersion values other than 1", () => {
    for (const version of ["2", "3", "0"]) {
      const dir = makeDir();
      writePresetJson(dir, { schemaVersion: version, presets: { p: { nestedRoots: ["a"] } } });
      const result = loadPresetsFromGitTop(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("schema");
    }
  });

  test("rejects unknown preset entry fields (strict Zod)", () => {
    const dir = makeDir();
    writePresetJson(dir, { p: { nestedRoots: ["a"], extraField: 1 } });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });

  test("rejects empty legacy map after stripping metadata", () => {
    const dir = makeDir();
    writePresetJson(dir, { schemaVersion: "1", $schema: "https://example.com/schema.json" });
    const result = loadPresetsFromGitTop(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });
});
