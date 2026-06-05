export function parseAllFilesLineCoverage(output: string): number | null {
  // Strip ANSI color codes (bun emits them when FORCE_COLOR is set, which would
  // otherwise prefix the "All files"/"File" rows and defeat the matchers).
  // Built via fromCharCode to keep a literal control character out of the source.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const rows = output
    .split(/\r?\n/)
    .map((line) => line.replace(ansi, "").trim())
    .filter((line) => line.includes("|"));
  const header = rows.find((line) => /^File\s*\|/i.test(line));
  if (!header) return null;

  const columns = header.split("|").map((column) => column.trim().toLowerCase());
  const lineIndex = columns.indexOf("% lines");
  if (lineIndex === -1) return null;

  const allFiles = rows.find((line) => /^All files\s*\|/i.test(line));
  if (!allFiles) return null;

  const cells = allFiles.split("|").map((cell) => cell.trim());
  const raw = cells[lineIndex];
  if (!raw) return null;

  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}
