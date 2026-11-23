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
  return text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
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

/** Unescaped text of data cell `index` (0 = `#`, 1 = `状态`, …). */
export function cellAt(line: string, index: number): string {
  const raw = rawCells(line)[index + 1];
  return (raw ?? "").trim().replace(/\\\|/g, "|");
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

/** Indices of `needle` occurrences that sit outside every fence. */
function unfencedIndexes(lines: string[], needle: string): number[] {
  const fenced = fencedLines(lines);
  const out: number[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === needle && !fenced[index]) out.push(index);
  });
  return out;
}

// ---- bodies ------------------------------------------------------------

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

/**
 * The `**验收判据**` paragraph of a body, whitespace-folded: the text from
 * the label to the next blank line or `**label**`, with soft wraps joined.
 */
export function extractCriteria(bodyLines: string[]): string | undefined {
  const fenced = fencedLines(bodyLines);
  const start = bodyLines.findIndex(
    (line, index) => !fenced[index] && /^ {0,3}\*\*验收判据\*\*\s*[:：]?\s*/.test(line),
  );
  if (start < 0) return undefined;
  const first = bodyLines[start]!.replace(/^ {0,3}\*\*验收判据\*\*\s*[:：]?\s*/, "").trim();
  const parts = [first];
  for (let index = start + 1; index < bodyLines.length; index++) {
    const line = bodyLines[index]!;
    // A fence ends the paragraph: its contents are an example, not criteria.
    if (fenced[index] || line.trim() === "" || /^ {0,3}\*\*[^*]+\*\*/.test(line)) break;
    parts.push(line.trim());
  }
  const text = parts.filter(Boolean).join(" ").replace(/\s+/g, " ");
  return text === "" ? undefined : text;
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
 * Replace the lines strictly between `begin` and `end` markers. Returns the
 * input unchanged when either marker is missing or duplicated — the checker
 * reports that as E112, and a write verb should never guess.
 */
export function rewriteBlock(lines: string[], begin: string, end: string, content: string[]): string[] {
  // Only real markers count. A marker pair quoted inside a fenced example in
  // the appendix must not be mistaken for the controlled block.
  const begins = unfencedIndexes(lines, begin);
  const ends = unfencedIndexes(lines, end);
  if (begins.length !== 1 || ends.length !== 1) return lines;
  const first = begins[0]!;
  const last = ends[0]!;
  if (last <= first) return lines;
  return [...lines.slice(0, first + 1), ...content, ...lines.slice(last)];
}