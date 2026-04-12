import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_JSON_FORMAT_VERSION = "1" as const;

export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "..", "package.json");
  try {
    const j = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return j.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** FastMCP types require major.minor.patch; strip prerelease suffixes from package.json. */
export function readMcpServerVersion(): `${number}.${number}.${number}` {
  const raw = readPackageVersion().trim();
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
    return `${m[1]}.${m[2]}.${m[3]}` as `${number}.${number}.${number}`;
  }
  return "0.0.0";
}

export function jsonRespond(body: Record<string, unknown>): string {
  return JSON.stringify({
    ...body,
    rethunkGitMcp: {
      jsonFormatVersion: MCP_JSON_FORMAT_VERSION,
      packageVersion: readPackageVersion(),
    },
  });
}

/** Spread into an object literal only when `cond` is true; otherwise `{}`. */
export function spreadWhen<T extends Record<string, unknown>>(
  cond: boolean,
  fields: T,
): T | Record<string, never> {
  return cond ? fields : {};
}

/** Spread `{ [key]: value }` only when `value` is not `undefined`. */
export function spreadDefined<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return spreadWhen(value !== undefined, { [key]: value } as Record<K, V>);
}
