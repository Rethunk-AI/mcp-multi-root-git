import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertRelativePathUnderTop,
  isStrictlyUnderGitTop,
  resolvePathForRepo,
} from "./repo-paths.js";

const created: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("isStrictlyUnderGitTop", () => {
  test("allows same directory as top", () => {
    const top = mkTmp("rg-top-");
    expect(isStrictlyUnderGitTop(top, top)).toBe(true);
  });

  test("allows child directory", () => {
    const top = mkTmp("rg-top-");
    const child = join(top, "packages", "a");
    mkdirSync(child, { recursive: true });
    expect(isStrictlyUnderGitTop(child, top)).toBe(true);
  });

  test("rejects sibling outside top", () => {
    const top = mkTmp("rg-top-");
    const outside = mkTmp("rg-out-");
    expect(isStrictlyUnderGitTop(outside, top)).toBe(false);
  });

  test("rejects path with dotdot past top", () => {
    const top = mkTmp("rg-top-");
    const nested = join(top, "sub", "mod");
    mkdirSync(nested, { recursive: true });
    const escaped = resolve(join(nested, "..", "..", ".."));
    expect(isStrictlyUnderGitTop(escaped, top)).toBe(false);
  });
});

describe("resolvePathForRepo + assertRelativePathUnderTop", () => {
  test("rejects relative segment that escapes top", () => {
    const top = mkTmp("rg-top-");
    const rel = join("..", "..", "etc");
    const abs = resolvePathForRepo(rel, top);
    expect(assertRelativePathUnderTop(rel, abs, top)).toBe(false);
  });

  test("allows normal nested relative path", () => {
    const top = mkTmp("rg-top-");
    const pkg = join(top, "pkg");
    mkdirSync(pkg);
    const abs = resolvePathForRepo("pkg", top);
    expect(assertRelativePathUnderTop("pkg", abs, top)).toBe(true);
  });
});
