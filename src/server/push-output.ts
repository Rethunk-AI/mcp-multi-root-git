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

const COMMIT_KEEP_PATTERNS: RegExp[] = [
  /^\s*\d+\s+files?\s+changed/, // diffstat summary ("2 files changed, 41 insertions(+), 2 deletions(-)")
  /^\s*(create|delete) mode \d+ /, // new/removed file mode lines
  /^\s*rename .+=>.+\(\d+%\)/, // rename detection
];

/**
 * Condense successful-commit output for `batch_commit`.
 *
 * `git commit`'s own confirmation line (`[branch sha] subject`) restates data
 * already returned as the separate `sha`/`message` fields, and pre-commit
 * hooks inherit stdio the same way pre-push hooks do (`condensePushOutput`)
 * — both are noise on the success path. Keep only the diffstat/mode/rename
 * lines, which carry information not available elsewhere in the response.
 * Failures must keep the full output, so callers only run this on success.
 */
export function condenseCommitOutput(stdout: string, stderr: string): string {
  const lines = [stdout, stderr]
    .join("\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const kept = lines.filter((line) => COMMIT_KEEP_PATTERNS.some((p) => p.test(line)));
  const omitted = lines.length - kept.length;
  if (omitted > 0) {
    kept.push(
      `(${omitted} line${omitted === 1 ? "" : "s"} of commit confirmation/hook output omitted)`,
    );
  }
  return kept.join("\n").trim();
}
