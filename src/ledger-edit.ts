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

/** Replace data cell `index`, keeping the padding of the cell it overwrites. */
export function replaceCell(line: string, index: number, value: string): string {
  const cells = rawCells(line);
  const position = index + 1;
  if (position < 1 || position >= cells.length - 1) return line;
  const original = cells[position]!;
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  cells[position] = `${lead}${escapeCell(value)}${trail}`;
  return cells.join("|");
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
  const start = bodyLines.findIndex((line) => /^ {0,3}\*\*验收判据\*\*\s*[:：]?\s*/.test(line));
  if (start < 0) return undefined;
  const first = bodyLines[start]!.replace(/^ {0,3}\*\*验收判据\*\*\s*[:：]?\s*/, "").trim();
  const parts = [first];
  for (let index = start + 1; index < bodyLines.length; index++) {
    const line = bodyLines[index]!;
    if (line.trim() === "" || /^ {0,3}\*\*[^*]+\*\*/.test(line)) break;
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
  const first = lines.indexOf(begin);
  const last = lines.indexOf(end);
  if (first < 0 || last < 0 || last <= first) return lines;
  if (lines.indexOf(begin, first + 1) >= 0 || lines.indexOf(end, last + 1) >= 0) return lines;
  return [...lines.slice(0, first + 1), ...content, ...lines.slice(last)];
}