/**
 * `--dry-run` rendering.
 *
 * Originally lilmd's line-level mutation helpers (attribution in
 * THIRD_PARTY_NOTICES.md); the generic Markdown verbs were removed with the
 * ledger-only surface (ADR 0006), leaving only this diff renderer. The
 * single-hunk prefix/suffix scan it started from was replaced: every ledger
 * write except `status` touches two or three distant regions (索引, 已关闭,
 * 正文, 附录), and one hunk spanning all of them printed thousands of
 * unchanged lines as -/+ pairs (dogfood #26).
 */

type Op = { kind: " " | "-" | "+"; text: string };

/**
 * Shortest edit script between two line arrays (Myers, O((N+M)·D)). Common
 * prefix and suffix are trimmed first, so a ledger write with a handful of
 * changed lines costs almost nothing even on a multi-thousand-line file.
 */
function editScript(old: string[], next: string[]): Op[] {
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < old.length - head && tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  ) tail++;
  const a = old.slice(head, old.length - tail);
  const b = next.slice(head, next.length - tail);

  const n = a.length;
  const m = b.length;
  const max = n + m;
  // Each step keeps only its own window of V (k in -d..d), so memory is
  // O(D²) rather than O(D·(N+M)); past MAX_D edits the middle falls back to
  // one block of deletions and insertions (still correct, just coarse).
  const MAX_D = 2000;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= Math.min(max, MAX_D) && !found; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
        ? v[offset + k + 1]!
        : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) {
    return [
      ...old.slice(0, head).map((text): Op => ({ kind: " ", text })),
      ...a.map((text): Op => ({ kind: "-", text })),
      ...b.map((text): Op => ({ kind: "+", text })),
      ...old.slice(old.length - tail).map((text): Op => ({ kind: " ", text })),
    ];
  }

  // Walk the trace backwards to recover the script. trace[d] holds V for
  // k in -(d+1)..(d+1), stored at index k + d + 1.
  const middle: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!;
    const at = (k: number) => vd[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      middle.push({ kind: " ", text: a[--x]! });
      y--;
    }
    if (d === 0) break;
    if (down) middle.push({ kind: "+", text: b[--y]! });
    else middle.push({ kind: "-", text: a[--x]! });
  }
  while (x > 0 && y > 0) {
    middle.push({ kind: " ", text: a[--x]! });
    y--;
  }
  middle.reverse();

  return [
    ...old.slice(0, head).map((text): Op => ({ kind: " ", text })),
    ...middle,
    ...old.slice(old.length - tail).map((text): Op => ({ kind: " ", text })),
  ];
}

/**
 * A unified diff of two versions of a file, one hunk per changed region
 * with three lines of context (regions closer than that are merged, as in
 * `diff -u`). Returns "" when the versions are identical.
 */
export function unifiedDiff(
  old: string[],
  next: string[],
  path: string,
): string {
  const CONTEXT = 3;
  const ops = editScript(old, next);
  if (ops.every((op) => op.kind === " ")) return "";

  // Line numbers (0-based) of each op on both sides.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 0;
  let nn = 0;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(nn);
    if (op.kind !== "+") o++;
    if (op.kind !== "-") nn++;
  }

  // Group changed ops into hunks: [first, last] op indices incl. context.
  const hunks: [number, number][] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === " ") continue;
    let j = i;
    while (j + 1 < ops.length && ops[j + 1]!.kind !== " ") j++;
    const start = Math.max(0, i - CONTEXT);
    const end = Math.min(ops.length - 1, j + CONTEXT);
    const last = hunks.at(-1);
    if (last && start <= last[1] + 1) last[1] = end;
    else hunks.push([start, end]);
    i = j;
  }

  // Absolute paths already start with `/`; a naive `a/` prefix would print
  // a confusing `a//tmp/...`.
  const label = (side: string) => (path.startsWith("/") ? `${side}${path}` : `${side}/${path}`);
  const out = [`--- ${label("a")}`, `+++ ${label("b")}`];
  for (const [start, end] of hunks) {
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    // `diff -u` convention: an empty side names the line *before* the hunk.
    const oldStart = oldCount === 0 ? oldAt[start]! : oldAt[start]! + 1;
    const newStart = newCount === 0 ? newAt[start]! : newAt[start]! + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return out.join("\n") + "\n";
}
