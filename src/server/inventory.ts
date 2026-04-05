import { assertRelativePathUnderTop, resolvePathForRepo } from "../repo-paths.js";
import { fetchAheadBehind, gitStatusSnapshotAsync, spawnGitAsync } from "./git.js";

export const MAX_INVENTORY_ROOTS_DEFAULT = 64;

export type InventoryEntryJson = {
  label: string;
  path: string;
  branchStatus: string;
  shortStatus: string;
  detached: boolean;
  headAbbrev: string;
  upstreamMode: "auto" | "fixed";
  upstreamRef: string | null;
  ahead: string | null;
  behind: string | null;
  upstreamNote: string;
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
  return {
    label,
    path: abs,
    branchStatus: "",
    shortStatus: "",
    detached: false,
    headAbbrev: "",
    upstreamMode,
    upstreamRef: null,
    ahead: null,
    behind: null,
    upstreamNote: "",
    skipReason,
  };
}

export function buildInventorySectionMarkdown(e: InventoryEntryJson): string[] {
  if (e.skipReason) {
    return [`## ${e.label}`, `path: ${e.path}`, "```text", e.skipReason, "```", ``];
  }
  const lines: string[] = [];
  lines.push(e.branchStatus);
  lines.push("");
  lines.push("short:");
  lines.push(e.shortStatus || "(clean)");
  lines.push("");
  if (e.detached) {
    lines.push("branch: (detached HEAD)");
    lines.push("");
  }
  if (e.ahead != null && e.behind != null && e.upstreamRef) {
    lines.push(`ahead_of_${e.upstreamRef.replace(/\//g, "_")}: ${e.ahead}`);
    lines.push(`behind_${e.upstreamRef.replace(/\//g, "_")}: ${e.behind}`);
  } else {
    lines.push(`upstream: ${e.upstreamNote}`);
  }
  return [`## ${e.label}`, `path: ${e.path}`, "```text", lines.join("\n"), "```", ``];
}

function upstreamNoteFor(ref: string, ahead: string | null, behind: string | null): string {
  return ahead != null && behind != null
    ? `tracking ${ref}`
    : `upstream ${ref} (counts unreadable)`;
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
  const shortStatus = snap.shortLine;
  const headAbbrev = headR.ok ? headR.stdout.trim() : "";
  const detached = !headR.ok || headAbbrev === "HEAD" || headAbbrev.endsWith("/HEAD");

  const useFixed = fixedRemote !== undefined && fixedBranch !== undefined;

  if (useFixed) {
    const remote = fixedRemote;
    const branch = fixedBranch;
    const verify = await spawnGitAsync(absPath, ["rev-parse", "--verify", `${remote}/${branch}`]);
    if (!verify.ok) {
      return {
        label,
        path: absPath,
        branchStatus,
        shortStatus,
        detached,
        headAbbrev: headAbbrev || "(unknown)",
        upstreamMode: "fixed",
        upstreamRef: `${remote}/${branch}`,
        ahead: null,
        behind: null,
        upstreamNote: `(no local ref ${remote}/${branch} or unreadable)`,
      };
    }
    const ref = `${remote}/${branch}`;
    const { ahead, behind } = await fetchAheadBehind(absPath, ref);
    return {
      label,
      path: absPath,
      branchStatus,
      shortStatus,
      detached,
      headAbbrev: headAbbrev || "(unknown)",
      upstreamMode: "fixed",
      upstreamRef: ref,
      ahead,
      behind,
      upstreamNote: upstreamNoteFor(ref, ahead, behind),
    };
  }

  const upVerify = await spawnGitAsync(absPath, ["rev-parse", "--verify", "@{u}"]);
  if (!upVerify.ok) {
    let note = "no upstream configured";
    if (detached) {
      note = "detached HEAD — no upstream";
    }
    return {
      label,
      path: absPath,
      branchStatus,
      shortStatus,
      detached,
      headAbbrev: headAbbrev || "(unknown)",
      upstreamMode: "auto",
      upstreamRef: null,
      ahead: null,
      behind: null,
      upstreamNote: note,
    };
  }

  const abbrevR = await spawnGitAsync(absPath, ["rev-parse", "--abbrev-ref", "@{u}"]);
  const upstreamRef = abbrevR.ok ? abbrevR.stdout.trim() : "@{u}";
  const { ahead, behind } = await fetchAheadBehind(absPath, "@{u}");

  return {
    label,
    path: absPath,
    branchStatus,
    shortStatus,
    detached,
    headAbbrev: headAbbrev || "(unknown)",
    upstreamMode: "auto",
    upstreamRef,
    ahead,
    behind,
    upstreamNote: upstreamNoteFor(upstreamRef, ahead, behind),
  };
}
