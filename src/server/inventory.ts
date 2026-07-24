import { fetchAheadBehind, gitStatusSnapshotAsync, spawnGitAsync } from "./git.js";
import { isSafeGitAncestorRef } from "./git-refs.js";

export const MAX_INVENTORY_ROOTS_DEFAULT = 64;

/** Default cap on raw `branchStatus` text lines retained per repo entry. */
export const MAX_BRANCH_STATUS_LINES_DEFAULT = 500;

export type InventoryEntryJson = {
  label: string;
  path: string;
  upstreamMode: "auto" | "fixed";
  branchStatus?: string;
  /** True when `branchStatus` was cut to `maxBranchStatusLines`. */
  branchStatusTruncated?: true;
  /** Line count omitted from `branchStatus` due to `maxBranchStatusLines`. */
  branchStatusOmittedLines?: number;
  detached?: true;
  headAbbrev?: string;
  upstreamRef?: string;
  ahead?: string;
  behind?: string;
  /** True when exactly one of ahead/behind was fetched — an explicit partial state, never an inconsistent one. */
  partial?: true;
  upstreamNote?: string;
  /** Ahead/behind between arbitrary local refs (`compareRefs` tool arg), independent of upstream. */
  compareRefs?: {
    left: string;
    right: string;
    ahead?: string;
    behind?: string;
    /** True when exactly one of ahead/behind was fetched. */
    partial?: true;
    note?: string;
  };
  skipReason?: string;
};

export function makeSkipEntry(
  label: string,
  abs: string,
  upstreamMode: "auto" | "fixed",
  skipReason: string,
): InventoryEntryJson {
  return { label, path: abs, upstreamMode, skipReason };
}

function upstreamNoteFor(ref: string, hasCounts: boolean): string {
  return hasCounts ? `tracking ${ref}` : `upstream ${ref} (counts unreadable)`;
}

function buildEntry(params: {
  label: string;
  absPath: string;
  branchStatus: string;
  branchStatusTruncated?: boolean;
  branchStatusOmittedLines?: number;
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
  if (params.branchStatusTruncated) {
    out.branchStatusTruncated = true;
    out.branchStatusOmittedLines = params.branchStatusOmittedLines;
  }
  if (params.detached) out.detached = true;
  if (params.headAbbrev) out.headAbbrev = params.headAbbrev;
  if (params.upstreamRef !== null) out.upstreamRef = params.upstreamRef;
  const aheadOk = params.ahead !== null;
  const behindOk = params.behind !== null;
  if (aheadOk) out.ahead = params.ahead as string;
  if (behindOk) out.behind = params.behind as string;
  // Exactly one of ahead/behind fetched — mark explicitly partial rather than
  // shipping a half-populated entry that looks complete.
  if (aheadOk !== behindOk) out.partial = true;
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
  // Defense in depth: re-validate here too, since this is an exported function
  // and a future caller may not have validated tokens before passing them in.
  if (!isSafeGitAncestorRef(left) || !isSafeGitAncestorRef(right)) {
    entry.compareRefs = { left, right, note: "(unsafe ref token rejected)" };
    return entry;
  }
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
  const aheadOk = ahead != null;
  const behindOk = behind != null;
  entry.compareRefs = {
    left,
    right,
    ...(aheadOk ? { ahead } : {}),
    ...(behindOk ? { behind } : {}),
    ...(aheadOk !== behindOk ? { partial: true } : {}),
    ...(!aheadOk && !behindOk ? { note: "(counts unreadable)" } : {}),
  };
  return entry;
}

export async function collectInventoryEntry(
  label: string,
  absPath: string,
  fixedRemote: string | undefined,
  fixedBranch: string | undefined,
  compareRefs?: { left: string; right: string },
  maxBranchStatusLines: number = MAX_BRANCH_STATUS_LINES_DEFAULT,
): Promise<InventoryEntryJson> {
  const [snap, headR] = await Promise.all([
    gitStatusSnapshotAsync(absPath),
    spawnGitAsync(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  let branchStatus = snap.branchLine;
  let branchStatusTruncated = false;
  let branchStatusOmittedLines = 0;
  if (maxBranchStatusLines > 0) {
    const statusLines = branchStatus.split("\n");
    if (statusLines.length > maxBranchStatusLines) {
      branchStatusOmittedLines = statusLines.length - maxBranchStatusLines;
      branchStatus = statusLines.slice(0, maxBranchStatusLines).join("\n");
      branchStatusTruncated = true;
    }
  }
  const headAbbrev = headR.ok ? headR.stdout.trim() : "";
  const detached = !headR.ok || headAbbrev === "HEAD" || headAbbrev.endsWith("/HEAD");
  const base = {
    label,
    absPath,
    branchStatus,
    branchStatusTruncated,
    branchStatusOmittedLines,
    detached,
    headAbbrev,
  };

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
