/**
 * `--dry-run` rendering.
 *
 * Originally lilmd's line-level mutation helpers (attribution in
 * THIRD_PARTY_NOTICES.md); the generic Markdown verbs were removed with the
 * ledger-only surface (ADR 0006), leaving only this diff renderer.
 */

/**
 * Produce a single-hunk unified diff for two versions of a file.
 * Returns "" if old and next are identical.
 *
 * Uses a simple prefix/suffix scan to find the changed region; works
 * correctly for all targeted single-region edits (`new`, `close`, `rename`, …).
 * An edit in two distant places (`close --keep-body` touching 正文 and 附录)
 * yields one hunk that also prints the unchanged lines in between.
 */
export function unifiedDiff(
  old: string[],
  next: string[],
  path: string,
): string {
  const CONTEXT = 3;

  // Find first differing index.
  let lo = 0;
  while (lo < old.length && lo < next.length && old[lo] === next[lo]) lo++;

  if (lo === old.length && lo === next.length) return ""; // identical

  // Find last differing index from the end.
  let oldHi = old.length - 1;
  let newHi = next.length - 1;
  while (oldHi >= lo && newHi >= lo && old[oldHi] === next[newHi]) {
    oldHi--;
    newHi--;
  }

  const ctxLo = Math.max(0, lo - CONTEXT);
  const ctxOldHi = Math.min(old.length - 1, oldHi + CONTEXT);

  const ctxBefore = lo - ctxLo;
  const removedCount = oldHi - lo + 1;
  const addedCount = newHi - lo + 1;
  const ctxAfter = ctxOldHi - oldHi;

  const oldTotal = ctxBefore + removedCount + ctxAfter;
  const newTotal = ctxBefore + addedCount + ctxAfter;

  // Absolute paths already start with `/`; a naive `a/` prefix would print
  // a confusing `a//tmp/...`.
  const label = (side: string) => (path.startsWith("/") ? `${side}${path}` : `${side}/${path}`);
  const lines: string[] = [
    `--- ${label("a")}`,
    `+++ ${label("b")}`,
    `@@ -${ctxLo + 1},${oldTotal} +${ctxLo + 1},${newTotal} @@`,
  ];

  for (let i = ctxLo; i < lo; i++) lines.push(` ${old[i]}`);
  for (let i = lo; i <= oldHi; i++) lines.push(`-${old[i]!}`);
  for (let i = lo; i <= newHi; i++) lines.push(`+${next[i]!}`);
  for (let i = oldHi + 1; i <= ctxOldHi; i++) lines.push(` ${old[i]!}`);

  return lines.join("\n") + "\n";
}
