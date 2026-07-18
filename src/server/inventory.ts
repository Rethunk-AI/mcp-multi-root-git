import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { fetchAheadBehind, gitStatusSnapshotAsync, spawnGitAsync } from "./git.js";

export const MAX_INVENTORY_ROOTS_DEFAULT = 64;

export type InventoryEntryJson = {
  label: string;
  path: string;
  upstreamMode: "auto" | "fixed";
  branchStatus?: string;
  detached?: true;
  headAbbrev?: string;
  upstreamRef?: string;
  ahead?: string;
  behind?: string;
  upstreamNote?: string;
  /** Ahead/behind between arbitrary local refs (`compareRefs` tool arg), independent of upstream. */
  compareRefs?: {
    left: string;
    right: string;
    ahead?: string;
    behind?: string;
    note?: string;
  };
  skipReason?: string;
};

export function validateRepoPath(rel: string, gitTop: string): { abs: string; underTop: boolean } {
  const abs = resolvePathForRepo(rel, gitTop);
  return { abs, underTop: assertRelativePathUnderTop(rel, abs, gitTop) };
}

export function makeSkipEntry(
  label: string,
  abs: string,
  upstreamMode: "auto" | "fixed",
  skipReason: string,
): InventoryEntryJson {
  return { label, path: abs, upstreamMode, skipReason };
}

export function buildInventorySectionMarkdown(e: InventoryEntryJson): string[] {
  const header = `## ${e.label} — ${e.path}`;
  if (e.skipReason) {
    return ["", header, e.skipReason];
  }
  const lines: string[] = [e.branchStatus || "(clean)"];
  if (e.detached) lines.push("detached HEAD");
  if (e.ahead !== undefined && e.behind !== undefined && e.upstreamRef) {
    lines.push(`${e.upstreamRef}: ahead ${e.ahead}, behind ${e.behind}`);
  } else if (e.upstreamNote) {
    lines.push(`upstream: ${e.upstreamNote}`);
  }
  if (e.compareRefs) {
    const cr = e.compareRefs;
    if (cr.ahead !== undefined && cr.behind !== undefined) {
      lines.push(`${cr.left}...${cr.right}: ahead ${cr.ahead}, behind ${cr.behind}`);
    } else if (cr.note) {
      lines.push(`compareRefs ${cr.left}...${cr.right}: ${cr.note}`);
    }
  }
  const single = lines.length === 1 ? lines[0] : undefined;
  if (single !== undefined && !single.includes("\n")) {
    return ["", header, single];
  }
  return ["", header, "```text", lines.join("\n"), "```"];
}

function upstreamNoteFor(ref: string, hasCounts: boolean): string {
  return hasCounts ? `tracking ${ref}` : `upstream ${ref} (counts unreadable)`;
}

function buildEntry(params: {
  label: string;
  absPath: string;
  branchStatus: string;
  detached: boolean;
  headAbbrev: string;
  upstreamMode: "auto" | "fixed";
  upstreamRef: string | null;
  ahead: string | null;
  behind: string | null;
  upstreamNote: string;
}): InventoryEntryJson {
  const out: InventoryEntryJson = {
    label: params.label,
    path: params.absPath,
    upstreamMode: params.upstreamMode,
  };
  if (params.branchStatus) out.branchStatus = params.branchStatus;
  if (params.detached) out.detached = true;
  if (params.headAbbrev) out.headAbbrev = params.headAbbrev;
  if (params.upstreamRef !== null) out.upstreamRef = params.upstreamRef;
  if (params.ahead !== null) out.ahead = params.ahead;
  if (params.behind !== null) out.behind = params.behind;
  if (params.upstreamNote) out.upstreamNote = params.upstreamNote;
  return out;
}

/**
 * Ahead = commits reachable from `right` but not `left` (`left..right`).
 * Behind = commits reachable from `left` but not `right` (`right..left`).
 */
async function fetchCompareAheadBehind(
  absPath: string,
  left: string,
  right: string,
): Promise<{ ahead: string | null; behind: string | null }> {
  const [aheadR, behindR] = await Promise.all([
    spawnGitAsync(absPath, ["rev-list", "--count", `${left}..${right}`]),
    spawnGitAsync(absPath, ["rev-list", "--count", `${right}..${left}`]),
  ]);
  return {
    ahead: aheadR.ok ? aheadR.stdout.trim() : null,
    behind: behindR.ok ? behindR.stdout.trim() : null,
  };
}

async function attachCompareRefs(
  entry: InventoryEntryJson,
  absPath: string,
  compareRefs: { left: string; right: string } | undefined,
): Promise<InventoryEntryJson> {
  if (!compareRefs) return entry;
  const left = compareRefs.left;
  const right = compareRefs.right;
  const [leftOk, rightOk] = await Promise.all([
    spawnGitAsync(absPath, ["rev-parse", "--verify", left]),
    spawnGitAsync(absPath, ["rev-parse", "--verify", right]),
  ]);
  if (!leftOk.ok || !rightOk.ok) {
    entry.compareRefs = {
      left,
      right,
      note: `(ref unreadable: ${[!leftOk.ok ? left : "", !rightOk.ok ? right : ""].filter(Boolean).join(", ")})`,
    };
    return entry;
  }
  const { ahead, behind } = await fetchCompareAheadBehind(absPath, left, right);
  entry.compareRefs = {
    left,
    right,
    ...(ahead != null ? { ahead } : {}),
    ...(behind != null ? { behind } : {}),
    ...(ahead == null || behind == null ? { note: "(counts unreadable)" } : {}),
  };
  return entry;
}

export async function collectInventoryEntry(
  label: string,
  absPath: string,
  fixedRemote: string | undefined,
  fixedBranch: string | undefined,
  compareRefs?: { left: string; right: string },
): Promise<InventoryEntryJson> {
  const [snap, headR] = await Promise.all([
    gitStatusSnapshotAsync(absPath),
    spawnGitAsync(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  const branchStatus = snap.branchLine;
  const headAbbrev = headR.ok ? headR.stdout.trim() : "";
  const detached = !headR.ok || headAbbrev === "HEAD" || headAbbrev.endsWith("/HEAD");
  const base = { label, absPath, branchStatus, detached, headAbbrev };

  let entry: InventoryEntryJson;
  if (fixedRemote !== undefined && fixedBranch !== undefined) {
    const ref = `${fixedRemote}/${fixedBranch}`;
    const verify = await spawnGitAsync(absPath, ["rev-parse", "--verify", ref]);
    if (!verify.ok) {
      entry = buildEntry({
        ...base,
        upstreamMode: "fixed",
        upstreamRef: ref,
        ahead: null,
        behind: null,
        upstreamNote: `(no local ref ${ref} or unreadable)`,
      });
    } else {
      const { ahead, behind } = await fetchAheadBehind(absPath, ref);
      entry = buildEntry({
        ...base,
        upstreamMode: "fixed",
        upstreamRef: ref,
        ahead,
        behind,
        upstreamNote: upstreamNoteFor(ref, ahead != null && behind != null),
      });
    }
  } else {
    const upVerify = await spawnGitAsync(absPath, ["rev-parse", "--verify", "@{u}"]);
    if (!upVerify.ok) {
      entry = buildEntry({
        ...base,
        upstreamMode: "auto",
        upstreamRef: null,
        ahead: null,
        behind: null,
        upstreamNote: detached ? "detached HEAD — no upstream" : "no upstream configured",
      });
    } else {
      const abbrevR = await spawnGitAsync(absPath, ["rev-parse", "--abbrev-ref", "@{u}"]);
      const upstreamRef = abbrevR.ok ? abbrevR.stdout.trim() : "@{u}";
      const { ahead, behind } = await fetchAheadBehind(absPath, "@{u}");
      entry = buildEntry({
        ...base,
        upstreamMode: "auto",
        upstreamRef,
        ahead,
        behind,
        upstreamNote: upstreamNoteFor(upstreamRef, ahead != null && behind != null),
      });
    }
  }

  return attachCompareRefs(entry, absPath, compareRefs);
}
