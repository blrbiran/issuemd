/**
 * Pure line-level primitives for ledger writes.
 *
 * Nothing here touches the disk: every function takes a line array and
 * returns a new one. The CLI owns the read, the validation gate and the
 * atomic write, so `--dry-run` and a real write share the same computation.
 *
 * Line numbers are 1-indexed, matching `parseLedger`; array indices are not.
 */

import type { LedgerRow, TableKind } from "./ledger.js";
import { STATUS_CLASSES } from "./ledger-check.js";

// ---- cells -------------------------------------------------------------

/** GFM requires a literal pipe inside a cell to be escaped; a newline breaks the row. */
export function escapeCell(text: string): string {
  // Escape only unescaped pipes: a title that already contains `\|` must not
  // become `\\|`, which would split the cell (E108).
  // A pipe is already escaped only when an *odd* number of backslashes
  // precede it: `\\|` is a literal backslash followed by a cell break.
  return text.replace(/(\\*)\|/g, (_, slashes: string) => slashes.length % 2 === 1 ? `${slashes}|` : `${slashes}\\|`)
    .replace(/[\r\n]+/g, " ");
}

/**
 * Split a table row into raw cells, keeping every character between the
 * unescaped pipes (so whitespace and padding survive a round trip).
 * `"| a | b |"` → `["", " a ", " b ", ""]`.
 */
function rawCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let slashes = 0;
  for (const char of line.trim()) {
    if (char === "|" && slashes % 2 === 0) {
      cells.push(cell);
      cell = "";
    } else {
      if (char === "|") cell = cell.slice(0, -1);
      cell += char;
    }
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  cells.push(cell);
  return cells;
}

/**
 * Inverse of `escapeCell`, matching how `splitCells` reads a cell: a pipe
 * after an odd number of backslashes loses one of them; `\\|` keeps both.
 */
export function unescapeCell(text: string): string {
  return text.replace(/(\\+)\|/g, (_, slashes: string) => slashes.length % 2 === 1 ? `${slashes.slice(1)}|` : `${slashes}|`);
}

/** Unescaped text of data cell `index` (0 = `#`, 1 = `状态`, …). */
export function cellAt(line: string, index: number): string {
  const raw = rawCells(line)[index + 1];
  return unescapeCell((raw ?? "").trim());
}

/** Offsets of the unescaped `|` characters in `text`. */
function pipeOffsets(text: string): number[] {
  const out: number[] = [];
  let slashes = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "|" && slashes % 2 === 0) out.push(i);
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  return out;
}

/**
 * Replace data cell `index` by splicing the original text, keeping the
 * padding of the cell it overwrites.
 *
 * Splicing rather than re-joining decoded cells is deliberate: an escaped
 * `\|` in a cell that is *not* being replaced must survive untouched, and
 * re-joining the decoded cells would silently un-escape it (turning a 5-cell
 * row into a 6-cell one).
 */
export function replaceCell(line: string, index: number, value: string): string {
  const pipes = pipeOffsets(line);
  if (pipes.length < 2 || index < 0) return line;
  const start = pipes[index];
  // A row without a trailing pipe ends its last cell at end-of-line.
  const end = pipes[index + 1] ?? line.length;
  if (start === undefined) return line;
  const original = line.slice(start + 1, end);
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return `${line.slice(0, start + 1)}${lead}${escapeCell(value)}${trail}${line.slice(end)}`;
}

export function formatRow(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

// ---- lines -------------------------------------------------------------

/** Insert `added` so that the first added line lands on 1-indexed `at`. */
export function insertLines(lines: string[], at: number, added: string[]): string[] {
  return [...lines.slice(0, at - 1), ...added, ...lines.slice(at - 1)];
}

/**
 * Insert a block (a body, an archive) at 1-indexed `at` so that exactly one
 * blank line separates it from non-blank neighbours. `insertLines` alone left
 * `### Issue N:` glued to the previous body when that body was the last thing
 * in 正文 and ended without a blank line (dogfood #48).
 */
export function insertBlock(lines: string[], at: number, block: string[]): string[] {
  let start = 0;
  let end = block.length;
  while (start < end && block[start]!.trim() === "") start++;
  while (end > start && block[end - 1]!.trim() === "") end--;
  const core = block.slice(start, end);
  const before = lines[at - 2];
  const after = lines[at - 1];
  const padded = [
    ...(before !== undefined && before.trim() !== "" ? [""] : []),
    ...core,
    ...(after !== undefined && after.trim() !== "" ? [""] : []),
  ];
  return insertLines(lines, at, padded);
}

/** Remove `count` lines starting at 1-indexed `at`. */
export function removeLines(lines: string[], at: number, count: number): string[] {
  return [...lines.slice(0, at - 1), ...lines.slice(at - 1 + count)];
}

// ---- tables ------------------------------------------------------------

/** The physical range of a table, header and separator included. */
export function tableRange(
  ledger: ReturnType<typeof import("./ledger.js").parseLedger>,
  kind: TableKind,
): { start: number; end: number } | undefined {
  const title = kind === "open" ? "索引" : "已关闭";
  const section = ledger.sections.find((candidate) => candidate.level === 2 && candidate.title === title);
  if (!section) return undefined;
  const block = ledger.blocks.find(
    (candidate) => candidate.line > section.line_start && candidate.line <= section.line_end,
  );
  if (!block) return undefined;
  return { start: block.line, end: block.line + block.rows.length - 1 };
}

/** `true` when every data row in the table is ascending by first id. */
export function ascendingRows(rows: LedgerRow[]): boolean {
  return rows.every((row, index) => index === 0 || rows[index - 1]!.ids[0]!.start < row.ids[0]!.start);
}

// ---- fences ------------------------------------------------------------

/**
 * `true` for every 0-based line index that is *inside* or *is* a fence
 * (delimiters included). Both the criteria extractor and the controlled-block
 * rewriter must ignore fenced lookalikes: a code block in an issue body or the
 * appendix can legitimately contain `**验收判据**：…` or a marker pair.
 */
export function fencedLines(lines: string[]): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  let fence: { char: string; len: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      if (match && !(match[1]!.startsWith("`") && match[2]!.includes("`"))) {
        fence = { char: match[1]![0]!, len: match[1]!.length };
        out[index] = true;
      }
      continue;
    }
    out[index] = true;
    if (match && match[1]![0] === fence.char && match[1]!.length >= fence.len && /^[ \t]*$/.test(match[2]!)) {
      fence = undefined;
    }
  }
  return out;
}

/** True when the last line leaves a code fence open. */
export function endsInFence(lines: string[]): boolean {
  let fence: { char: string; len: number } | undefined;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      // A backtick fence's info string may not itself contain a backtick.
      if (match && !(match[1]!.startsWith("`") && match[2]!.includes("`"))) {
        fence = { char: match[1]![0]!, len: match[1]!.length };
      }
    } else if (match && match[1]![0] === fence.char && match[1]!.length >= fence.len && /^[ \t]*$/.test(match[2]!)) {
      fence = undefined;
    }
  }
  return fence !== undefined;
}

// ---- bodies ------------------------------------------------------------

/**
 * The one archive format for a closed issue's body kept in 附录, written by
 * `close --keep-body` and by `adopt`, read back by `reopen`, renamed by
 * `rename`, and reported by `check` (W250/W251/W252). It is deliberately not
 * an `Issue N:` heading: 附录 must not hold issue headings (E123).
 */
export const KEPT_BODY_END = "<!-- issuemd:kept-body:end -->";
export const archiveHeading = (id: string, summary: string) => `### #${id} ${summary}（已关闭，正文保留）`;
/** `### #<id> <summary>（已关闭，正文保留）` → id and summary. */
export const ARCHIVE_HEADING = /^ {0,3}###\s+#([1-9]\d*[a-z]?)\s+(.*?)（已关闭，正文保留）\s*$/;
/** The provenance note under the heading; `reopen` drops it when restoring. */
export const ARCHIVE_NOTE = /^>\s*(?:关闭时以 --keep-body\s*|adopt 时)保留了原正文/;

export function bodySkeleton(id: string, title: string, criteria = ""): string[] {
  return [
    `### Issue ${id}: ${title}`,
    "",
    "**现象**：",
    "",
    "**根因**：",
    "",
    "**期望**：",
    "",
    `**验收判据**：${criteria}`,
    "",
  ];
}

/** `**label**：rest` at the start of a line (up to three spaces of indent). */
const LABEL_LINE = /^ {0,3}\*\*([^*]+)\*\*\s*[:：]?\s*(.*)$/;
/** `**验收判据：**` and `**验收判据**：` name the same label. */
export const labelName = (raw: string) => raw.trim().replace(/[:：]\s*$/, "").trim();
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const UNORDERED_MARKER = /^\s*[-*+]\s+/;

export type LabelBlock = {
  label: string;
  /** 1-indexed line of the `**label**` line, in the coordinates passed in. */
  line: number;
  /** The label line and everything that belongs to it, verbatim. */
  lines: string[];
  /**
   * One-line form for a table cell or JSON: paragraphs and list items are
   * joined with `；`, soft wraps with a space, unordered markers dropped.
   */
  text: string;
};

/**
 * The block a `**label**` owns inside `lines[start-1..end]` (1-indexed): from
 * the label to the next label line, heading, or the end of the range. Blank
 * lines do not end it — `**验收判据**：` followed by a blank line and a list is
 * the most common way to write criteria, and what `new`'s skeleton invites.
 * Fenced lines are content (never a label or a boundary), minus the fences.
 */
export function labelBlock(
  lines: string[],
  start: number,
  end: number,
  label: string,
): LabelBlock | undefined {
  const fenced = fencedLines(lines);
  const last = Math.min(end, lines.length);
  for (let line = start; line <= last; line++) {
    if (fenced[line - 1]) continue;
    const match = LABEL_LINE.exec(lines[line - 1]!);
    if (!match || labelName(match[1]!) !== label) continue;
    let stop = line + 1;
    while (stop <= last) {
      const text = lines[stop - 1]!;
      if (!fenced[stop - 1] && (/^ {0,3}\*\*[^*]+\*\*/.test(text) || /^ {0,3}#{1,6}(?:\s|$)/.test(text))) break;
      stop++;
    }
    const own = lines.slice(line - 1, stop - 1);
    while (own.length > 1 && own.at(-1)!.trim() === "") own.pop();

    const segments: string[] = [];
    let current: string[] = [];
    let blank = false;
    const flush = () => {
      if (current.length) segments.push(current.join(" "));
      current = [];
    };
    const first = match[2]!.trim();
    if (first) current.push(first);
    const ownFenced = fencedLines(own);
    for (let index = 1; index < own.length; index++) {
      const raw = own[index]!;
      if (raw.trim() === "") {
        blank = true;
        continue;
      }
      // Fence delimiters are markup; the code inside is kept, one line each.
      if (ownFenced[index] && /^ {0,3}(`{3,}|~{3,})/.test(raw)) {
        flush();
        blank = false;
        continue;
      }
      if (blank || LIST_ITEM.test(raw) || ownFenced[index]) flush();
      blank = false;
      current.push(raw.replace(UNORDERED_MARKER, "").trim());
      if (ownFenced[index]) flush();
    }
    flush();
    const text = joinClauses(segments).replace(/[ \t]+/g, " ").trim();
    return { label, line, lines: own, text };
  }
  return undefined;
}

/** The `**验收判据**` block of a body as one line; undefined when absent or empty. */
/** `；`-join, but a part that already ends in a clause mark keeps its own. */
export function joinClauses(parts: string[]): string {
  return parts.reduce((out, part, at) => (at === 0 ? part : /[；;]\s*$/.test(out) ? out + part : `${out}；${part}`), "");
}

export function extractCriteria(bodyLines: string[]): string | undefined {
  // A body may repeat the label (W206); every distinct non-empty block counts,
  // or close would drop the second one without a word.
  const texts: string[] = [];
  let from = 1;
  for (;;) {
    const found = labelBlock(bodyLines, from, bodyLines.length, "验收判据");
    if (!found) break;
    if (found.text !== "" && !texts.includes(found.text)) texts.push(found.text);
    from = found.line + found.lines.length;
  }
  return texts.length > 0 ? joinClauses(texts) : undefined;
}

// ---- controlled blocks -------------------------------------------------

export function statusBlockLines(): string[] {
  return [
    "| 状态 | 分类 |",
    "|---|---|",
    ...Object.entries(STATUS_CLASSES).map(([status, kind]) => `| ${status} | ${kind} |`),
  ];
}

export function guideBlockLines(): string[] {
  return [
    "| 你想做什么 | 命令 |",
    "|---|---|",
    "| 查看开放项 | `issuemd list FILE` |",
    "| 读一条 | `issuemd show FILE ID` |",
    "| 新增 | `issuemd new FILE --title \"…\"` |",
    "| 关闭 | `issuemd close FILE ID --criteria-from-body` |",
    "| 改状态 | `issuemd status FILE ID 状态` |",
    "| 重命名 | `issuemd rename FILE ID \"新标题\"` |",
    "| 校验 | `issuemd check FILE` |",
  ];
}

/**
 * Locate `begin` / `end` markers, optionally only inside one section
 * (`range` is a 1-indexed inclusive line span). Markers in another section —
 * even indented inside a list item — must not count: only the section that
 * owns the block decides whether the pair is valid.
 */
export function markerPair(
  lines: string[],
  begin: string,
  end: string,
  range?: { start: number; end: number },
): { begin: number; end: number } | null {
  const fenced = fencedLines(lines);
  const lo = range ? range.start - 1 : 0;
  const hi = range ? Math.min(range.end, lines.length) : lines.length;
  const indexes = (needle: string) => {
    const out: number[] = [];
    for (let index = Math.max(0, lo); index < hi; index++) {
      if (!fenced[index] && lines[index]!.trim() === needle) out.push(index);
    }
    return out;
  };
  const begins = indexes(begin);
  const ends = indexes(end);
  if (begins.length !== 1 || ends.length !== 1) return null;
  if (ends[0]! <= begins[0]!) return null;
  return { begin: begins[0]!, end: ends[0]! };
}

/**
 * Replace the lines strictly between `begin` and `end` markers. Returns the
 * input unchanged when either marker is missing or duplicated — the checker
 * reports that as E112, and a write verb should never guess.
 */
export function rewriteBlock(
  lines: string[],
  begin: string,
  end: string,
  content: string[],
  range?: { start: number; end: number },
): string[] {
  // Only real markers count. A marker pair quoted inside a fenced example in
  // the appendix must not be mistaken for the controlled block.
  const pair = markerPair(lines, begin, end, range);
  if (!pair) return lines;
  return [...lines.slice(0, pair.begin + 1), ...content, ...lines.slice(pair.end)];
}