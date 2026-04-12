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
  if (e.skipReason) {
    return [`## ${e.label}`, `path: ${e.path}`, "```text", e.skipReason, "```", ``];
  }
  const lines: string[] = [];
  lines.push(e.branchStatus || "(clean)");
  lines.push("");
  if (e.detached) {
    lines.push("branch: (detached HEAD)");
    lines.push("");
  }
  if (e.ahead !== undefined && e.behind !== undefined && e.upstreamRef) {
    lines.push(`ahead_of_${e.upstreamRef.replace(/\//g, "_")}: ${e.ahead}`);
    lines.push(`behind_${e.upstreamRef.replace(/\//g, "_")}: ${e.behind}`);
  } else if (e.upstreamNote) {
    lines.push(`upstream: ${e.upstreamNote}`);
  }
  return [`## ${e.label}`, `path: ${e.path}`, "```text", lines.join("\n"), "```", ``];
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

export async function collectInventoryEntry(
  label: string,
  absPath: string,
  fixedRemote: string | undefined,
  fixedBranch: string | undefined,
): Promise<InventoryEntryJson> {
  const [snap, headR] = await Promise.all([
    gitStatusSnapshotAsync(absPath),
    spawnGitAsync(absPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  const branchStatus = snap.branchLine;
  const headAbbrev = headR.ok ? headR.stdout.trim() : "";
  const detached = !headR.ok || headAbbrev === "HEAD" || headAbbrev.endsWith("/HEAD");
  const base = { label, absPath, branchStatus, detached, headAbbrev };

  if (fixedRemote !== undefined && fixedBranch !== undefined) {
    const ref = `${fixedRemote}/${fixedBranch}`;
    const verify = await spawnGitAsync(absPath, ["rev-parse", "--verify", ref]);
    if (!verify.ok) {
      return buildEntry({
        ...base,
        upstreamMode: "fixed",
        upstreamRef: ref,
        ahead: null,
        behind: null,
        upstreamNote: `(no local ref ${ref} or unreadable)`,
      });
    }
    const { ahead, behind } = await fetchAheadBehind(absPath, ref);
    return buildEntry({
      ...base,
      upstreamMode: "fixed",
      upstreamRef: ref,
      ahead,
      behind,
      upstreamNote: upstreamNoteFor(ref, ahead != null && behind != null),
    });
  }

  const upVerify = await spawnGitAsync(absPath, ["rev-parse", "--verify", "@{u}"]);
  if (!upVerify.ok) {
    return buildEntry({
      ...base,
      upstreamMode: "auto",
      upstreamRef: null,
      ahead: null,
      behind: null,
      upstreamNote: detached ? "detached HEAD — no upstream" : "no upstream configured",
    });
  }

  const abbrevR = await spawnGitAsync(absPath, ["rev-parse", "--abbrev-ref", "@{u}"]);
  const upstreamRef = abbrevR.ok ? abbrevR.stdout.trim() : "@{u}";
  const { ahead, behind } = await fetchAheadBehind(absPath, "@{u}");
  return buildEntry({
    ...base,
    upstreamMode: "auto",
    upstreamRef,
    ahead,
    behind,
    upstreamNote: upstreamNoteFor(upstreamRef, ahead != null && behind != null),
  });
}
