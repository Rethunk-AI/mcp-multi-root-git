/**
 * Condense successful-push output.
 *
 * Pre-push hooks inherit git's stdio, so repos with extensive checks (test
 * suites, package installs) flood the tool result with progress noise. On
 * success only the state-bearing lines matter; failures must keep the full
 * output, so callers only run this on the success path.
 */

const KEEP_PATTERNS: RegExp[] = [
  /^To\s\S/, // destination line ("To github.com:owner/repo.git")
  /^remote:/, // server-side messages (vulnerability banners, PR links)
  /^\s*[0-9a-f]+\.\.[0-9a-f]+\s+\S+\s+->\s+\S+/, // fast-forward ref update
  /^\s*\*\s+\[new (?:branch|tag|ref)\]/, // newly created ref
  /^branch '.+' set up to track/, // -u tracking notice
  /^Everything up-to-date$/,
];

/**
 * Merge both streams (git splits state across stdout/stderr and hooks write to
 * either), keep only state-bearing lines, and account for what was dropped.
 */
export function condensePushOutput(stdout: string, stderr: string): string {
  const lines = [stdout, stderr]
    .join("\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const kept = lines.filter((line) => KEEP_PATTERNS.some((p) => p.test(line)));
  const omitted = lines.length - kept.length;
  if (omitted > 0) {
    kept.push(`(${omitted} line${omitted === 1 ? "" : "s"} of hook/progress output omitted)`);
  }
  return kept.join("\n").trim();
}
