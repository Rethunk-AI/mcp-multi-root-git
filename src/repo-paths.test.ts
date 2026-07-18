import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("allows a path segment named ..foo (not an escape)", () => {
    const top = mkTmp("rg-top-");
    const weird = join(top, "..foo");
    mkdirSync(weird);
    expect(isStrictlyUnderGitTop(weird, top)).toBe(true);
  });

  test("rejects symlink that escapes top (existing leaf)", () => {
    const top = mkTmp("rg-top-");
    const outside = mkTmp("rg-out-");
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(outside, join(top, "subdir"));
    expect(isStrictlyUnderGitTop(join(top, "subdir", "secret"), top)).toBe(false);
  });

  test("rejects intermediate symlink + missing leaf (fail closed)", () => {
    // Repro from audit: top/subdir -> outside, path subdir/missing must not
    // false-accept when realpathSync(ENOENT) used to fall back to unresolved.
    const top = mkTmp("rg-esc-real-");
    const outside = mkTmp("rg-esc-out-");
    symlinkSync(outside, join(top, "subdir"));
    expect(isStrictlyUnderGitTop(join(top, "subdir", "missing"), top)).toBe(false);
  });

  test("allows missing leaf under symlink alias of the same top", () => {
    // Absolute alias to the repo + deleted leaf (batch_commit deletion staging).
    const realTop = mkTmp("rg-alias-real-");
    const parent = mkTmp("rg-alias-parent-");
    const alias = join(parent, "alias");
    symlinkSync(realTop, alias);
    expect(isStrictlyUnderGitTop(join(alias, "deleted"), realTop)).toBe(true);
  });

  test("allows child when gitTop itself is a symlink", () => {
    const realTop = mkTmp("rg-link-real-");
    const child = join(realTop, "pkg");
    mkdirSync(child);
    const parent = mkTmp("rg-link-parent-");
    const linkTop = join(parent, "repo");
    symlinkSync(realTop, linkTop);
    expect(isStrictlyUnderGitTop(join(linkTop, "pkg"), linkTop)).toBe(true);
  });

  test("rejects when gitTop cannot be realpath'd", () => {
    const top = join(mkTmp("rg-missing-top-"), "does-not-exist");
    const outside = mkTmp("rg-any-");
    expect(isStrictlyUnderGitTop(outside, top)).toBe(false);
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

  test("rejects when absResolved does not match resolvePathForRepo(userPath)", () => {
    const top = mkTmp("rg-top-");
    const pkg = join(top, "pkg");
    mkdirSync(pkg);
    const abs = resolvePathForRepo("pkg", top);
    expect(assertRelativePathUnderTop("other", abs, top)).toBe(false);
  });

  test("rejects symlink escape via assertRelativePathUnderTop", () => {
    const top = mkTmp("rg-top-");
    const outside = mkTmp("rg-out-");
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(outside, join(top, "subdir"));
    const rel = join("subdir", "secret");
    const abs = resolvePathForRepo(rel, top);
    expect(assertRelativePathUnderTop(rel, abs, top)).toBe(false);
  });
});
