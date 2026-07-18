import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";

/**
 * Schema for `.rethunk/git-mcp-presets.json` at the workspace root.
 * Each named entry defines roots for `git_inventory` and/or pairs for `git_parity`.
 * Must stay aligned with `git-mcp-presets.schema.json`.
 */
const ParityPairSchema = z
  .object({
    left: z.string(),
    right: z.string(),
    label: z.string().optional(),
  })
  .strict();

const PresetEntrySchema = z
  .object({
    nestedRoots: z.array(z.string()).optional(),
    parityPairs: z.array(ParityPairSchema).optional(),
    /** When multiple MCP file roots exist, prefer one whose path basename or suffix matches this hint. */
    workspaceRootHint: z.string().optional(),
  })
  .strict();

const PresetFileSchema = z.record(z.string(), PresetEntrySchema);

type PresetEntry = z.infer<typeof PresetEntrySchema>;
type PresetFile = z.infer<typeof PresetFileSchema>;

export const PRESET_FILE_PATH = ".rethunk/git-mcp-presets.json";

const PRESET_ENTRY_FIELD_NAMES = new Set(["nestedRoots", "parityPairs", "workspaceRootHint"]);
const WRAPPED_META_KEYS = new Set(["$schema", "schemaVersion", "presets"]);
const PRESET_SCHEMA_VERSION = "1";

type PresetLoadFail =
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid_json"; message: string }
  | { ok: false; reason: "schema"; issues: z.ZodIssue[] };

type PresetLoadOk = { ok: true; data: PresetFile; schemaVersion?: string };

type PresetLoadResult = PresetLoadOk | PresetLoadFail;

function looksLikePresetEntryObject(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 0) return true;
  return keys.every((k) => PRESET_ENTRY_FIELD_NAMES.has(k));
}

function isWrappedLayout(o: Record<string, unknown>): boolean {
  if (!("presets" in o)) return false;
  const inner = o.presets;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
    return false;
  }
  const innerObj = inner as Record<string, unknown>;

  // Non-empty inner with only PresetEntry field names → legacy preset named "presets".
  if (looksLikePresetEntryObject(innerObj) && Object.keys(innerObj).length > 0) {
    return false;
  }

  // Empty inner: wrapped when top level has only metadata + presets.
  if (Object.keys(innerObj).length === 0) {
    const topKeys = Object.keys(o);
    return topKeys.every((k) => WRAPPED_META_KEYS.has(k));
  }

  return true;
}

function schemaIssue(message: string, path: (string | number)[] = []): z.ZodIssue {
  return { code: "custom", path, message };
}

/**
 * Supports:
 * - Wrapped: `{ "schemaVersion": "1", "presets": { "name": { ... } } }`
 * - Legacy: `{ "name": { ... }, ... }` with optional top-level `schemaVersion` / `$schema` (editor hints).
 */
function splitPresetFileRaw(raw: unknown): { mapRaw: unknown; schemaVersion?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid_root");
  }
  const o = raw as Record<string, unknown>;
  if (isWrappedLayout(o)) {
    for (const key of Object.keys(o)) {
      if (!WRAPPED_META_KEYS.has(key)) {
        throw new Error("wrapped_extra_keys");
      }
    }
    const sv = o.schemaVersion;
    return {
      mapRaw: o.presets,
      schemaVersion: typeof sv === "string" ? sv : undefined,
    };
  }
  const rest: Record<string, unknown> = { ...o };
  const sv = rest.schemaVersion;
  delete rest.schemaVersion;
  delete rest.$schema;
  return {
    mapRaw: rest,
    schemaVersion: typeof sv === "string" ? sv : undefined,
  };
}

export function loadPresetsFromGitTop(gitTop: string): PresetLoadResult {
  const presetPath = join(gitTop, PRESET_FILE_PATH);
  if (!existsSync(presetPath)) {
    return { ok: false, reason: "missing" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(presetPath, "utf8")) as unknown;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "invalid_json", message };
  }
  let mapRaw: unknown;
  let schemaVersion: string | undefined;
  try {
    const s = splitPresetFileRaw(raw);
    mapRaw = s.mapRaw;
    schemaVersion = s.schemaVersion;
  } catch (e) {
    if (e instanceof Error && e.message === "wrapped_extra_keys") {
      return {
        ok: false,
        reason: "schema",
        issues: [
          schemaIssue("Wrapped preset files allow only $schema, schemaVersion, and presets"),
        ],
      };
    }
    return {
      ok: false,
      reason: "invalid_json",
      message: "Preset file root must be a JSON object",
    };
  }
  if (schemaVersion !== undefined && schemaVersion !== PRESET_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "schema",
      issues: [schemaIssue(`schemaVersion must be "${PRESET_SCHEMA_VERSION}"`, ["schemaVersion"])],
    };
  }
  if (
    mapRaw === null ||
    typeof mapRaw !== "object" ||
    Array.isArray(mapRaw) ||
    Object.keys(mapRaw as object).length === 0
  ) {
    return {
      ok: false,
      reason: "schema",
      issues: [schemaIssue("Preset file must contain at least one preset")],
    };
  }
  const parsed = PresetFileSchema.safeParse(mapRaw);
  if (!parsed.success) {
    return { ok: false, reason: "schema", issues: parsed.error.issues };
  }
  return { ok: true, data: parsed.data, schemaVersion };
}

export function presetLoadErrorPayload(
  gitTop: string,
  fail: PresetLoadFail,
): Record<string, unknown> {
  const presetFile = join(gitTop, PRESET_FILE_PATH);
  if (fail.reason === "invalid_json") {
    return {
      error: ERROR_CODES.PRESET_FILE_INVALID,
      kind: "invalid_json",
      presetFile,
      message: fail.message,
    };
  }
  if (fail.reason === "schema") {
    return {
      error: ERROR_CODES.PRESET_FILE_INVALID,
      kind: "schema",
      presetFile,
      issues: fail.issues,
    };
  }
  return { error: ERROR_CODES.PRESET_FILE_INVALID, presetFile };
}

function getPresetEntry(
  gitTop: string,
  presetName: string,
):
  | { ok: true; entry: PresetEntry; presetSchemaVersion?: string }
  | { ok: false; error: Record<string, unknown> } {
  const loaded = loadPresetsFromGitTop(gitTop);
  if (!loaded.ok) {
    if (loaded.reason === "missing") {
      return {
        ok: false,
        error: {
          error: ERROR_CODES.PRESET_NOT_FOUND,
          preset: presetName,
          presetFile: join(gitTop, PRESET_FILE_PATH),
        },
      };
    }
    return { ok: false, error: presetLoadErrorPayload(gitTop, loaded) };
  }
  const entry = loaded.data[presetName];
  if (!entry) {
    return {
      ok: false,
      error: {
        error: ERROR_CODES.PRESET_NOT_FOUND,
        preset: presetName,
        presetFile: join(gitTop, PRESET_FILE_PATH),
      },
    };
  }
  return { ok: true, entry, presetSchemaVersion: loaded.schemaVersion };
}

function mergeNestedRoots(
  preset: string[] | undefined,
  inline: string[] | undefined,
): string[] | undefined {
  const a = preset ?? [];
  const b = inline ?? [];
  if (a.length === 0 && b.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...a, ...b]) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function mergePairs<T extends { left: string; right: string; label?: string }>(
  preset: T[] | undefined,
  inline: T[] | undefined,
): T[] | undefined {
  const a = preset ?? [];
  const b = inline ?? [];
  if (a.length === 0 && b.length === 0) return undefined;
  const seen = new Set<string>();
  const out: T[] = [];
  for (const pair of [...a, ...b]) {
    const key = `${pair.left}\0${pair.right}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(pair);
    }
  }
  return out;
}

export type ParityPair = { left: string; right: string; label?: string };

export function applyPresetNestedRoots(
  gitTop: string,
  presetName: string,
  presetMerge: boolean,
  inlineNestedRoots: string[] | undefined,
):
  | { ok: true; nestedRoots: string[] | undefined; presetSchemaVersion?: string }
  | { ok: false; error: Record<string, unknown> } {
  const got = getPresetEntry(gitTop, presetName);
  if (!got.ok) return { ok: false, error: got.error };
  const fromPreset = got.entry.nestedRoots;
  let nestedRoots: string[] | undefined = inlineNestedRoots;
  if (presetMerge) {
    nestedRoots = mergeNestedRoots(fromPreset, nestedRoots);
  } else if (!nestedRoots?.length) {
    nestedRoots = fromPreset;
  }
  return { ok: true, nestedRoots, presetSchemaVersion: got.presetSchemaVersion };
}

export function applyPresetParityPairs(
  gitTop: string,
  presetName: string,
  presetMerge: boolean,
  inlinePairs: ParityPair[] | undefined,
):
  | { ok: true; pairs: ParityPair[] | undefined; presetSchemaVersion?: string }
  | { ok: false; error: Record<string, unknown> } {
  const got = getPresetEntry(gitTop, presetName);
  if (!got.ok) return { ok: false, error: got.error };
  const fromPreset = got.entry.parityPairs;
  let pairs: ParityPair[] | undefined = inlinePairs;
  if (presetMerge) {
    pairs = mergePairs(fromPreset, pairs);
  } else if (!pairs?.length) {
    pairs = fromPreset;
  }
  return { ok: true, pairs, presetSchemaVersion: got.presetSchemaVersion };
}
