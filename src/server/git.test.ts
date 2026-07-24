/**
 * Tests for utility functions in src/server/git.ts.
 *
 * These cover the sync helpers and async pool that are not exercised
 * by the tool-level integration tests.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

import { ERROR_CODES } from "./error-codes.js";
import {
  asyncPool,
  buildFilteredGitEnv,
  createRevParseHeadMemo,
  createTopLevelMemo,
  fetchAheadBehind,
  GIT_MISSING_RECHECK_MS,
  GIT_SUBPROCESS_MAX_BUFFER_BYTES,
  GIT_SUBPROCESS_PARALLELISM,
  gateGit,
  gitRevParseGitDirAsync,
  gitRevParseHeadAsync,
  gitStatusShortBranchAsync,
  gitStatusSnapshotAsync,
  gitTopLevel,
  gitTopLevelAsync,
  hasGitMetadata,
  isSafeGitUpstreamToken,
  parseGitSubmodulePaths,
  reapOrphanedGitChildrenForTests,
  resetGitPathStateForTests,
  resolveGitSubprocessMaxBufferBytes,
  resolveGitSubprocessParallelism,
  resolveGitSubprocessTimeoutMs,
  spawnGitAsync,
} from "./git.js";
import { cleanupTmpPaths, gitCmd, makeRepoWithSeed, mkTmpDir, withEnvVar } from "./test-harness.js";

afterEach(cleanupTmpPaths);

// ---------------------------------------------------------------------------
// isSafeGitUpstreamToken
// ---------------------------------------------------------------------------

describe("isSafeGitUpstreamToken", () => {
  test("accepts simple remote names and remote/branch combos", () => {
    expect(isSafeGitUpstreamToken("origin")).toBe(true);
    expect(isSafeGitUpstreamToken("upstream")).toBe(true);
    expect(isSafeGitUpstreamToken("my-remote")).toBe(true);
    expect(isSafeGitUpstreamToken("origin/main")).toBe(true);
    expect(isSafeGitUpstreamToken("origin/feature/auth")).toBe(true);
  });

  test("rejects double-dots", () => {
    expect(isSafeGitUpstreamToken("a..b")).toBe(false);
  });

  test("rejects leading dash", () => {
    expect(isSafeGitUpstreamToken("-origin")).toBe(false);
  });

  test("rejects shell metacharacters", () => {
    expect(isSafeGitUpstreamToken("origin;evil")).toBe(false);
    expect(isSafeGitUpstreamToken("$(cmd)")).toBe(false);
    expect(isSafeGitUpstreamToken("a b")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isSafeGitUpstreamToken("")).toBe(false);
  });

  test("rejects string longer than 256 chars", () => {
    expect(isSafeGitUpstreamToken("a".repeat(257))).toBe(false);
  });

  test("accepts exactly 256 chars", () => {
    expect(isSafeGitUpstreamToken("a".repeat(256))).toBe(true);
  });

  test("accepts the @{u} upstream shorthand", () => {
    expect(isSafeGitUpstreamToken("@{u}")).toBe(true);
  });

  test("rejects leading plus (force-update refspec)", () => {
    expect(isSafeGitUpstreamToken("+origin")).toBe(false);
  });

  test("rejects trailing slash", () => {
    expect(isSafeGitUpstreamToken("origin/")).toBe(false);
  });

  test("rejects .lock suffix", () => {
    expect(isSafeGitUpstreamToken("origin.lock")).toBe(false);
  });

  test("rejects trailing dot", () => {
    expect(isSafeGitUpstreamToken("origin.")).toBe(false);
  });

  test("rejects doubled slash", () => {
    expect(isSafeGitUpstreamToken("origin//main")).toBe(false);
  });

  test("rejects @{ ref-log syntax other than the @{u} shorthand", () => {
    expect(isSafeGitUpstreamToken("origin@{1}")).toBe(false);
    expect(isSafeGitUpstreamToken("HEAD@{upstream}")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gitRevParseGitDirAsync
// ---------------------------------------------------------------------------

describe("gitRevParseGitDirAsync", () => {
  test("returns true for a valid git repository", async () => {
    const dir = makeRepoWithSeed();
    expect(await gitRevParseGitDirAsync(dir)).toBe(true);
  });

  test("returns false for a plain directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");
    expect(await gitRevParseGitDirAsync(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gitRevParseHeadAsync
// ---------------------------------------------------------------------------

describe("gitRevParseHeadAsync", () => {
  test("returns ok=true with a SHA for a repo that has commits", async () => {
    const dir = makeRepoWithSeed();
    const result = await gitRevParseHeadAsync(dir);
    expect(result.ok).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns ok=false for a plain directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");
    const result = await gitRevParseHeadAsync(dir);
    expect(result.ok).toBe(false);
    expect(result.sha).toBeUndefined();
    expect(typeof result.text).toBe("string");
  });

  test("timeoutMs opt lets a caller shrink the wait for a deliberately-hanging repo", async () => {
    // Not an actual hang (rev-parse HEAD is instant) — exercises that the opts
    // param reaches spawnGitAsync at all, independent of the real timeout path
    // covered by the spawnGitAsync describe block below.
    const dir = makeRepoWithSeed();
    const result = await gitRevParseHeadAsync(dir, { timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gitTopLevelAsync
// ---------------------------------------------------------------------------

describe("gitTopLevelAsync", () => {
  test("returns toplevel for a git repo", async () => {
    const dir = makeRepoWithSeed();
    expect(await gitTopLevelAsync(dir)).toBe(dir);
  });

  test("returns null for a non-git directory", async () => {
    const dir = mkTmpDir("mcp-nongit-toplevel-async-");
    expect(await gitTopLevelAsync(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createTopLevelMemo / createRevParseHeadMemo — per-call memoization
// ---------------------------------------------------------------------------

describe("createTopLevelMemo", () => {
  test("resolves the same toplevel for repeated lookups of the same path", async () => {
    const dir = makeRepoWithSeed();
    const memo = createTopLevelMemo();
    const [a, b] = await Promise.all([memo(dir), memo(dir)]);
    expect(a).toBe(dir);
    expect(b).toBe(dir);
  });

  test("caches the promise so a second call does not spawn a second subprocess", async () => {
    const dir = makeRepoWithSeed();
    const memo = createTopLevelMemo();
    const first = memo(dir);
    const second = memo(dir);
    // Same in-flight promise object — the second call never called gitTopLevelAsync again.
    expect(second).toBe(first);
    await first;
  });

  test("a fresh memo instance does not share cache with a prior one (no cross-call cache)", async () => {
    const dir = makeRepoWithSeed();
    const memoA = createTopLevelMemo();
    const memoB = createTopLevelMemo();
    expect(memoA(dir)).not.toBe(memoB(dir));
    await Promise.all([memoA(dir), memoB(dir)]);
  });
});

describe("createRevParseHeadMemo", () => {
  test("resolves the same SHA for repeated lookups of the same path", async () => {
    const dir = makeRepoWithSeed();
    const memo = createRevParseHeadMemo();
    const [a, b] = await Promise.all([memo(dir), memo(dir)]);
    expect(a.ok).toBe(true);
    expect(a.sha).toBe(b.sha);
  });
});

// ---------------------------------------------------------------------------
// parseGitSubmodulePaths
// ---------------------------------------------------------------------------

describe("parseGitSubmodulePaths", () => {
  test("returns [] when .gitmodules does not exist", () => {
    const dir = makeRepoWithSeed();
    expect(parseGitSubmodulePaths(dir)).toEqual([]);
  });

  test("returns parsed submodule paths when .gitmodules exists", () => {
    const dir = makeRepoWithSeed();
    writeFileSync(
      join(dir, ".gitmodules"),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/lib.git\n',
      "utf8",
    );
    const paths = parseGitSubmodulePaths(dir);
    expect(paths).toEqual(["vendor/lib"]);
  });

  test("returns multiple paths from a multi-submodule .gitmodules", () => {
    const dir = makeRepoWithSeed();
    writeFileSync(
      join(dir, ".gitmodules"),
      '[submodule "a"]\n\tpath = vendor/a\n\turl = https://a.example.com\n' +
        '[submodule "b"]\n\tpath = vendor/b\n\turl = https://b.example.com\n',
      "utf8",
    );
    const paths = parseGitSubmodulePaths(dir);
    expect(paths).toEqual(["vendor/a", "vendor/b"]);
  });

  test("does not collect path = lines outside a [submodule] section", () => {
    const dir = makeRepoWithSeed();
    // A stray "path = ..." under a non-submodule section must be ignored.
    writeFileSync(
      join(dir, ".gitmodules"),
      '[core]\n\tpath = should-be-ignored\n[submodule "real"]\n\tpath = vendor/real\n\turl = https://example.com/real.git\n',
      "utf8",
    );
    const paths = parseGitSubmodulePaths(dir);
    expect(paths).toEqual(["vendor/real"]);
    expect(paths).not.toContain("should-be-ignored");
  });

  test("strips inline comments from path values", () => {
    const dir = makeRepoWithSeed();
    writeFileSync(
      join(dir, ".gitmodules"),
      '[submodule "lib"]\n\tpath = vendor/lib ; inline comment\n\turl = https://example.com/lib.git\n',
      "utf8",
    );
    const paths = parseGitSubmodulePaths(dir);
    expect(paths).toEqual(["vendor/lib"]);
  });
});

// ---------------------------------------------------------------------------
// hasGitMetadata
// ---------------------------------------------------------------------------

describe("hasGitMetadata", () => {
  test("returns true for a directory that contains a .git folder", () => {
    const dir = makeRepoWithSeed();
    expect(hasGitMetadata(dir)).toBe(true);
  });

  test("returns false for a plain directory without .git", () => {
    const dir = mkTmpDir("mcp-nongit-");
    expect(hasGitMetadata(dir)).toBe(false);
  });

  test("returns false for a nested directory inside a repo", () => {
    const dir = makeRepoWithSeed();
    const sub = join(dir, "subdir");
    mkdirSync(sub, { recursive: true });
    expect(hasGitMetadata(sub)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// asyncPool
// ---------------------------------------------------------------------------

describe("asyncPool", () => {
  test("processes all items and returns results in index order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await asyncPool(items, 2, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  test("handles a single item", async () => {
    const results = await asyncPool([42], 4, async (x) => x + 1);
    expect(results).toEqual([43]);
  });

  test("handles an empty array", async () => {
    const results = await asyncPool([], 4, async (x: number) => x);
    expect(results).toEqual([]);
  });

  test("concurrency higher than item count doesn't error", async () => {
    const results = await asyncPool([1, 2], 100, async (x) => x * 3);
    expect(results).toEqual([3, 6]);
  });

  test("never runs more than `concurrency` jobs at once, and does reach the cap under load", async () => {
    const concurrency = 3;
    let current = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 9 }, (_, i) => i);
    await asyncPool(items, concurrency, async (i) => {
      current++;
      maxObserved = Math.max(maxObserved, current);
      await new Promise((r) => setTimeout(r, 20));
      current--;
      return i;
    });
    expect(maxObserved).toBeLessThanOrEqual(concurrency);
    expect(maxObserved).toBe(concurrency);
  });

  test("one hanging/slow job's own timeout does not block sibling jobs past it — real spawnGitAsync", async () => {
    // Every tool-level fan-out pool (git_status/git_inventory/git_parity) is
    // built on this exact primitive (asyncPool + spawnGitAsync). The hang is
    // simulated via holdStdin + a short timeoutMs test hook rather than an
    // uncontrolled real hang, so the test is fast and deterministic.
    const items = [
      { dir: makeRepoWithSeed(), hang: false },
      { dir: makeRepoWithSeed(), hang: true },
      { dir: makeRepoWithSeed(), hang: false },
    ];
    const start = Date.now();
    const results = await asyncPool(items, 3, async (item) => {
      if (item.hang) {
        return spawnGitAsync(item.dir, ["cat-file", "--batch"], {
          timeoutMs: 60,
          holdStdin: true,
          sigkillAfterMs: 30,
        });
      }
      return spawnGitAsync(item.dir, ["rev-parse", "HEAD"]);
    });
    const elapsed = Date.now() - start;
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.timedOut).toBe(true);
    expect(results[2]?.ok).toBe(true);
    // Bounded by the hanging job's own timeout, not serialized behind it —
    // a serialized implementation would need to wait out the hang before
    // even starting the other two, and this asserts it does not.
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// gitStatusSnapshotAsync / gitStatusShortBranchAsync
// ---------------------------------------------------------------------------

describe("gitStatusSnapshotAsync", () => {
  test("succeeds for a clean repo on main", async () => {
    const dir = makeRepoWithSeed();
    const snap = await gitStatusSnapshotAsync(dir);
    expect(snap.branchOk).toBe(true);
    expect(snap.branchLine).toContain("main");
  });

  test("fails gracefully for a non-git directory", async () => {
    const dir = mkTmpDir("mcp-nongit-");
    const snap = await gitStatusSnapshotAsync(dir);
    expect(snap.branchOk).toBe(false);
    expect(typeof snap.branchLine).toBe("string");
  });
});

describe("gitStatusShortBranchAsync", () => {
  test("returns ok=true and branch text for a valid repo", async () => {
    const dir = makeRepoWithSeed();
    const result = await gitStatusShortBranchAsync(dir);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("main");
  });
});

// ---------------------------------------------------------------------------
// fetchAheadBehind
// ---------------------------------------------------------------------------

describe("fetchAheadBehind", () => {
  test("returns ahead/behind counts relative to upstream", async () => {
    const dir = makeRepoWithSeed();
    const bare = mkTmpDir("mcp-git-utils-remote-");
    gitCmd(bare, "init", "--bare", "-b", "main");
    gitCmd(dir, "remote", "add", "origin", bare);
    gitCmd(dir, "push", "-u", "origin", "main");

    // Add a local commit ahead of origin
    writeFileSync(join(dir, "extra.ts"), "export const e = 1;\n");
    gitCmd(dir, "add", "extra.ts");
    gitCmd(dir, "commit", "-m", "feat: extra");

    const { ahead, behind } = await fetchAheadBehind(dir, "@{u}");
    expect(ahead).toBe("1");
    expect(behind).toBe("0");
  });

  test("returns null ahead/behind for an invalid upstream spec", async () => {
    const dir = makeRepoWithSeed();
    const { ahead, behind } = await fetchAheadBehind(dir, "nonexistent-spec");
    expect(ahead).toBeNull();
    expect(behind).toBeNull();
  });

  test("fails closed on an unsafe upstream token without ever building git argv from it", async () => {
    const dir = makeRepoWithSeed();
    const { ahead, behind } = await fetchAheadBehind(dir, "-evil");
    expect(ahead).toBeNull();
    expect(behind).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gateGit / gitTopLevel / parallelism env defaults
// ---------------------------------------------------------------------------

describe("gateGit", () => {
  afterEach(() => {
    resetGitPathStateForTests();
    setSystemTime();
  });

  test("returns ok when git is on PATH", () => {
    resetGitPathStateForTests();
    expect(gateGit()).toEqual({ ok: true });
    // Cached path still ok
    expect(gateGit()).toEqual({ ok: true });
  });

  test("GIT_NOT_FOUND branch: caches the failure verdict, then re-probes after the TTL elapses", () => {
    resetGitPathStateForTests();
    let calls = 0;
    const failingProbe = () => {
      calls++;
      return { status: 1 };
    };

    const r1 = gateGit(failingProbe);
    expect(r1).toEqual({ ok: false, body: { error: ERROR_CODES.GIT_NOT_FOUND } });
    expect(calls).toBe(1);

    // Cached failure verdict — probe not re-invoked before the TTL elapses.
    const r2 = gateGit(failingProbe);
    expect(r2).toEqual({ ok: false, body: { error: ERROR_CODES.GIT_NOT_FOUND } });
    expect(calls).toBe(1);

    // Advance past the recheck TTL — the cached "missing" verdict expires
    // and gateGit re-probes instead of trusting it permanently.
    setSystemTime(Date.now() + GIT_MISSING_RECHECK_MS + 1);
    const r3 = gateGit(failingProbe);
    expect(r3.ok).toBe(false);
    expect(calls).toBe(2);
  });

  test("ETIMEDOUT probe failure is never cached — re-probes on every subsequent call", () => {
    resetGitPathStateForTests();
    let calls = 0;
    const timeoutProbe = () => {
      calls++;
      const err = new Error("spawnSync git ETIMEDOUT") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      return { error: err, status: null };
    };

    const r1 = gateGit(timeoutProbe);
    expect(r1).toEqual({ ok: false, body: { error: ERROR_CODES.GIT_NOT_FOUND } });
    expect(calls).toBe(1);

    // Not cached — the very next call re-probes immediately (no TTL wait needed).
    const r2 = gateGit(timeoutProbe);
    expect(r2.ok).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("gitTopLevel", () => {
  test("returns toplevel for a git repo", () => {
    const dir = makeRepoWithSeed();
    expect(gitTopLevel(dir)).toBe(dir);
  });

  test("returns null for a non-git directory", () => {
    const dir = mkTmpDir("mcp-nongit-toplevel-");
    expect(gitTopLevel(dir)).toBeNull();
  });
});

describe("resolveGitSubprocessParallelism", () => {
  test("defaults to 4 when env unset", () => {
    expect(resolveGitSubprocessParallelism(undefined, 8)).toBe(4);
  });

  test("clamps env value to 2×CPU", () => {
    expect(resolveGitSubprocessParallelism("100", 4)).toBe(8);
  });

  test("accepts valid env within clamp", () => {
    expect(resolveGitSubprocessParallelism("3", 8)).toBe(3);
  });

  test("ignores invalid env and returns default 4", () => {
    expect(resolveGitSubprocessParallelism("0", 8)).toBe(4);
    expect(resolveGitSubprocessParallelism("nope", 8)).toBe(4);
  });

  test("module constant is a positive integer within clamp", () => {
    expect(GIT_SUBPROCESS_PARALLELISM).toBeGreaterThanOrEqual(1);
    expect(GIT_SUBPROCESS_PARALLELISM).toBeLessThanOrEqual(cpus().length * 2 || 4);
  });
});

describe("resolveGitSubprocessTimeoutMs", () => {
  test("defaults to 120000", () => {
    expect(resolveGitSubprocessTimeoutMs(undefined)).toBe(120_000);
  });

  test("0 disables timeout", () => {
    expect(resolveGitSubprocessTimeoutMs("0")).toBe(0);
  });
});

describe("resolveGitSubprocessMaxBufferBytes", () => {
  test("defaults to 16 MiB", () => {
    expect(resolveGitSubprocessMaxBufferBytes(undefined)).toBe(16 * 1024 * 1024);
    expect(GIT_SUBPROCESS_MAX_BUFFER_BYTES).toBe(16 * 1024 * 1024);
  });

  test("accepts env override ≥1024", () => {
    expect(resolveGitSubprocessMaxBufferBytes("4096")).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// spawnGitAsync — timeout + AbortSignal + buffer bound
// ---------------------------------------------------------------------------

describe("spawnGitAsync", () => {
  test("fast command completes normally — timedOut is falsy", async () => {
    const dir = makeRepoWithSeed();
    const result = await spawnGitAsync(dir, ["--version"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("git version");
    expect(result.timedOut).toBeFalsy();
    expect(result.aborted).toBeFalsy();
  });

  test("already-aborted signal resolves ok:false with aborted:true immediately", async () => {
    const dir = makeRepoWithSeed();
    const controller = new AbortController();
    controller.abort();
    const result = await spawnGitAsync(dir, ["--version"], {
      signal: controller.signal,
      sigkillAfterMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBeFalsy();
  });

  test("timeoutMs kills a hanging cat-file --batch and resolves timedOut:true", async () => {
    const dir = makeRepoWithSeed();
    // holdStdin keeps stdin open so `git cat-file --batch` waits for input —
    // deterministic hang without racing a fast command against a 1ms timer.
    const result = await spawnGitAsync(dir, ["cat-file", "--batch"], {
      timeoutMs: 80,
      holdStdin: true,
      sigkillAfterMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("git timed out after 80ms");
  });

  test("maxBufferBytes overflow settles truncated:true", async () => {
    const dir = makeRepoWithSeed();
    // Produce more than a few bytes of stdout; cap at 8 bytes.
    const result = await spawnGitAsync(dir, ["--version"], {
      maxBufferBytes: 8,
      sigkillAfterMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.stderr).toContain("git output exceeded 8 bytes");
  });

  test("abort mid-flight via AbortController resolves ok:false with aborted:true", async () => {
    const dir = makeRepoWithSeed();
    const controller = new AbortController();
    const promise = spawnGitAsync(dir, ["cat-file", "--batch"], {
      timeoutMs: 5000,
      signal: controller.signal,
      holdStdin: true,
      sigkillAfterMs: 50,
    });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
  });

  test("child process spawn error (e.g. ENOENT) surfaces the real Node error in stderr", async () => {
    const dir = makeRepoWithSeed();
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent-mcp-git-test-path";
    try {
      const result = await spawnGitAsync(dir, ["--version"]);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("ENOENT");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

// ---------------------------------------------------------------------------
// buildFilteredGitEnv — env allowlist for git subprocesses
// ---------------------------------------------------------------------------

describe("buildFilteredGitEnv", () => {
  test("keeps allowlisted vars and drops everything else, including other GIT_* smuggling vectors", () => {
    const ambient = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      GIT_SSH_COMMAND: "ssh -i key",
      GIT_DIR: "/tmp/evil-git-dir",
      GIT_WORK_TREE: "/tmp/evil-worktree",
      GIT_INDEX_FILE: "/tmp/evil-index",
      RANDOM_SECRET: "shh",
    };
    const filtered = buildFilteredGitEnv(ambient, undefined);
    expect(filtered.PATH).toBe("/usr/bin");
    expect(filtered.HOME).toBe("/home/x");
    expect(filtered.GIT_SSH_COMMAND).toBe("ssh -i key");
    expect(filtered.GIT_DIR).toBeUndefined();
    expect(filtered.GIT_WORK_TREE).toBeUndefined();
    expect(filtered.GIT_INDEX_FILE).toBeUndefined();
    expect(filtered.RANDOM_SECRET).toBeUndefined();
  });

  test("keeps any LC_* prefixed var regardless of specific name", () => {
    const filtered = buildFilteredGitEnv(
      { LC_ALL: "C", LC_TIME: "en_US.UTF-8", NOT_LC: "x" },
      undefined,
    );
    expect(filtered.LC_ALL).toBe("C");
    expect(filtered.LC_TIME).toBe("en_US.UTF-8");
    expect(filtered.NOT_LC).toBeUndefined();
  });

  test("RETHUNK_GIT_ENV_PASSTHROUGH appends extra names, including other GIT_* vars", () => {
    const ambient = { PATH: "/usr/bin", GIT_DIR: "/tmp/evil", MY_CUSTOM: "val" };
    const filtered = buildFilteredGitEnv(ambient, "GIT_DIR,MY_CUSTOM");
    expect(filtered.GIT_DIR).toBe("/tmp/evil");
    expect(filtered.MY_CUSTOM).toBe("val");
  });

  test("passthrough list tolerates whitespace and empty entries", () => {
    const ambient = { PATH: "/usr/bin", FOO: "1", BAR: "2" };
    const filtered = buildFilteredGitEnv(ambient, " FOO ,, BAR ,");
    expect(filtered.FOO).toBe("1");
    expect(filtered.BAR).toBe("2");
  });

  test("omits ambient vars whose value is undefined", () => {
    const filtered = buildFilteredGitEnv(
      { PATH: undefined } as unknown as NodeJS.ProcessEnv,
      undefined,
    );
    expect(filtered.PATH).toBeUndefined();
  });

  test("defaults read real process.env / RETHUNK_GIT_ENV_PASSTHROUGH when args are omitted", () => {
    withEnvVar("RETHUNK_GIT_ENV_PASSTHROUGH", "MCP_GIT_TEST_PASSTHROUGH_VAR", () => {
      withEnvVar("MCP_GIT_TEST_PASSTHROUGH_VAR", "present", () => {
        const filtered = buildFilteredGitEnv();
        expect(filtered.MCP_GIT_TEST_PASSTHROUGH_VAR).toBe("present");
        expect(filtered.PATH).toBe(process.env.PATH);
      });
    });
  });
});

describe("spawnGitAsync — env allowlist enforcement", () => {
  test("a poisoned ambient GIT_INDEX_FILE does not reach the child", async () => {
    const dir = makeRepoWithSeed();
    const bogusIndex = join(dir, "not-a-real-index.bin");
    writeFileSync(bogusIndex, "not a valid git index\n");
    let promise!: ReturnType<typeof spawnGitAsync>;
    withEnvVar("GIT_INDEX_FILE", bogusIndex, () => {
      promise = spawnGitAsync(dir, ["status", "--short"]);
    });
    const result = await promise;
    // If the ambient GIT_INDEX_FILE reached the child, git would fail parsing
    // the garbage file as an index; the allowlist must keep it from reaching git.
    expect(result.ok).toBe(true);
  });

  test("RETHUNK_GIT_ENV_PASSTHROUGH lets an added ambient var reach the child (end-to-end)", async () => {
    const dir = makeRepoWithSeed();
    const bogusIndex = join(dir, "not-a-real-index-2.bin");
    writeFileSync(bogusIndex, "not a valid git index\n");
    let promise!: ReturnType<typeof spawnGitAsync>;
    // Without the passthrough, GIT_INDEX_FILE is dropped and the command
    // succeeds against the real index (see test above). With it added to the
    // passthrough list, the poisoned index reaches git and the command fails —
    // proving the passthrough path actually widens what reaches the child.
    withEnvVar("RETHUNK_GIT_ENV_PASSTHROUGH", "GIT_INDEX_FILE", () => {
      withEnvVar("GIT_INDEX_FILE", bogusIndex, () => {
        promise = spawnGitAsync(dir, ["status", "--short"]);
      });
    });
    const result = await promise;
    expect(result.ok).toBe(false);
  });

  test("opts.env merges on top of the filtered ambient base (GIT_AUTHOR_*/GIT_CONFIG_* injection)", async () => {
    const dir = mkTmpDir("mcp-env-merge-test-");
    const initResult = await spawnGitAsync(dir, ["init", "-b", "main"]);
    expect(initResult.ok).toBe(true);
    writeFileSync(join(dir, "f.txt"), "hi\n");
    await spawnGitAsync(dir, ["add", "f.txt"]);
    const commitResult = await spawnGitAsync(dir, ["commit", "-m", "test"], {
      env: {
        GIT_AUTHOR_NAME: "Test User",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test User",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    expect(commitResult.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// spawnGitAsync — orphan reaper (module-level live-children tracking)
// ---------------------------------------------------------------------------

describe("orphan reaper", () => {
  test("reapOrphanedGitChildrenForTests kills a live spawnGitAsync child, settling its promise", async () => {
    const dir = makeRepoWithSeed();
    // holdStdin keeps stdin open so `git cat-file --batch` hangs until killed —
    // without the reaper sweep this would otherwise wait out the timeout.
    const promise = spawnGitAsync(dir, ["cat-file", "--batch"], {
      timeoutMs: 10_000,
      holdStdin: true,
      sigkillAfterMs: 50,
    });
    // Give the child a moment to actually spawn and register itself.
    await new Promise((r) => setTimeout(r, 50));

    reapOrphanedGitChildrenForTests();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBeFalsy();
  });
});
