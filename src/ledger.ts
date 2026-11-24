import { scan } from "./scan.js";
import { buildSections, type Section } from "./sections.js";
import { parseId, parseIds, type IdSpan } from "./issue-id.js";

const CORE = ["索引", "已关闭", "正文"] as const;

export type TableKind = "open" | "closed";
export type Diagnostic = {
  code: string;
  line: number;
  message: string;
  id?: string;
  expected?: string;
  actual?: string;
};
export type LedgerRow = {
  line: number;
  ids: IdSpan[];
  status: string;
  priority: string;
  summary: string;
  criteria: string;
};

type PipeBlock = { line: number; rows: string[][]; header: boolean; separator: boolean };
export type { PipeBlock };
export type BodyBlock = { id: IdSpan; title: string; line: number; end: number };
export const ISSUE_HEADING = /^Issue\s+([^:\s]+)\s*:\s*(.*)$/;
const COLUMNS = {
  open: ["#", "状态", "P", "摘要"],
  closed: ["#", "状态", "P", "摘要", "判据"],
} as const;

export function isLedger(src: string): boolean {
  const titles = new Set(scan(src).filter((heading) => heading.level === 2).map((heading) => heading.title));
  return CORE.every((title) => titles.has(title));
}

/** Split a pipe row, decoding GFM's escape for literal pipes. */
export function splitCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let slashes = 0;
  let trailingPipe = false;
  for (const char of line.trim().slice(1)) {
    if (char === "|" && slashes % 2 === 0) {
      cells.push(cell.trim());
      cell = "";
      trailingPipe = true;
    } else {
      if (char === "|") cell = cell.slice(0, -1);
      cell += char;
      trailingPipe = false;
    }
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  if (!trailingPipe) cells.push(cell.trim());
  return cells;
}

function pipeBlocks(lines: string[], visible: Set<number>): PipeBlock[] {
  const blocks: PipeBlock[] = [];
  let rows: string[][] = [];
  let start = 0;
  function finish() {
    if (rows.length === 0) return;
    const second = rows[1];
    const header = second !== undefined && second.length > 0 && second.every((cell) => /^:?-+:?$/.test(cell));
    blocks.push({ line: start, rows, header, separator: header && second.length === rows[0].length });
    rows = [];
  }
  lines.forEach((text, index) => {
    const line = index + 1;
    if (visible.has(line) && /^ {0,3}\|/.test(text)) {
      if (rows.length === 0) start = line;
      rows.push(splitCells(text));
    } else {
      finish();
    }
  });
  finish();
  return blocks;
}

function readRows(block: PipeBlock, kind: TableKind, errors: Diagnostic[], warnings: Diagnostic[]): LedgerRow[] {
  const columns = COLUMNS[kind];
  const header = block.rows[0];
  if (block.header && (header.length !== columns.length || columns.some((name, i) => header[i] !== name))) {
    errors.push({ code: "E112", line: block.line, message: `Expected table columns ${columns.join(" | ")}` });
    return [];
  }
  // With a missing separator, retain every data row. A literal canonical
  // column-name row is recognizable even without a separator.
  const start = block.header ? 2 : columns.length === header.length && columns.every((name, i) => header[i] === name) ? 1 : 0;
  const rows: LedgerRow[] = [];
  for (let i = start; i < block.rows.length; i++) {
    const cells = block.rows[i];
    const line = block.line + i;
    if (cells.length !== columns.length) {
      if (!block.header) errors.push({ code: "E108", line, message: `Expected ${columns.length} cells, found ${cells.length}` });
      if (cells.length > columns.length) warnings.push({ code: "W205", line, message: "Check for an unescaped pipe in a cell" });
      continue;
    }
    const ids = parseIds(cells[0]);
    if (!ids) {
      errors.push({ code: "E109", line, message: `Invalid issue IDs: ${cells[0]}` });
      continue;
    }
    const [, status, priority, summary, criteria = ""] = cells;
    rows.push({ line, ids, status, priority, summary, criteria });
  }
  return rows;
}

/** Parse the canonical layout into source-referenced sections and table rows. */
export function parseLedger(src: string) {
  const lines = src.replace(/^﻿/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const visible = new Set<number>();
  const sections = buildSections(scan(src, (line) => visible.add(line)), lines.length);
  const h2s = sections.filter((section) => section.level === 2);
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const rows: Record<TableKind, LedgerRow[]> = { open: [], closed: [] };
  const missing = CORE.filter((title) => !h2s.some((section) => section.title === title));
  if (missing.length > 0) {
    errors.push({ code: "E120", line: 1, message: `Canonical ledger sections missing: ${missing.join(", ")}` });
    return { lines, visible, sections, rows, blocks: [] as PipeBlock[], errors, warnings };
  }

  const roots = sections.filter((section) => section.level === 1);
  if (roots.length !== 1 || roots[0].title === "" || h2s.some((section) => section.parent !== roots[0])) {
    errors.push({ code: "E112", line: roots[1]?.line_start ?? 1, message: "Expected a single H1 above the ledger sections" });
  }
  const guide = h2s.find((section) => section.title === "怎么用");
  if (guide) {
    const markers: string[] = [];
    for (let line = guide.line_start + 1; line <= guide.line_end; line++) {
      const text = lines[line - 1];
      if (visible.has(line) && /^<!-- issuemd:guide:(?:begin|end) -->$/.test(text)) markers.push(text);
    }
    if (markers.join("\n") !== "<!-- issuemd:guide:begin -->\n<!-- issuemd:guide:end -->") {
      errors.push({ code: "E112", line: guide.line_start, message: "怎么用 must contain one ordered guide marker pair" });
    }
  }

  const required = ["怎么用", "状态口径", ...CORE];
  let previous: Section | undefined;
  for (const title of required) {
    const matches = h2s.filter((section) => section.title === title);
    if (matches.length === 0) errors.push({ code: "E112", line: 1, message: `Missing section: ${title}` });
    for (const other of matches.slice(1)) {
      errors.push({ code: "E112", line: other.line_start, message: `Duplicate section: ${title}` });
    }
    const first = matches[0];
    if (first) {
      if (previous && previous.line_start > first.line_start) {
        errors.push({ code: "E112", line: first.line_start, message: `${title} must follow ${previous.title}` });
      }
      previous = first;
    }
  }

  const blocks = pipeBlocks(lines, visible);
  const tableSections = h2s.filter((section) => section.title === "索引" || section.title === "已关闭");
  const inTableSection = (line: number) =>
    tableSections.some((section) => line > section.line_start && line <= section.line_end);
  for (const block of blocks) {
    // A lone `|`-line outside the two tables is a prose paragraph in GFM, not
    // a table: `| 符号表示绝对值` starts a sentence. Inside 索引/已关闭 the
    // separator is mandatory even for a single row, so keep the error there.
    const loneProse = block.rows.length === 1 && !inTableSection(block.line);
    if (!block.separator && !loneProse) {
      errors.push({ code: "E122", line: block.line, message: "Pipe block lacks a matching separator row" });
    }
    if (block.header) {
      const width = block.rows[0].length;
      block.rows.slice(1).forEach((cells, index) => {
        const line = block.line + index + 1;
        if (cells.length !== width) {
          errors.push({ code: "E108", line, message: `Expected ${width} cells, found ${cells.length}` });
        }
      });
    }
  }
  for (const [kind, title] of [["open", "索引"], ["closed", "已关闭"]] as const) {
    const section = h2s.find((candidate) => candidate.title === title)!;
    const tables = blocks.filter((block) => block.line > section.line_start && block.line <= section.line_end);
    if (tables.length !== 1) errors.push({ code: "E112", line: section.line_start, message: `${title} must contain one table` });
    rows[kind] = tables.flatMap((table) => readRows(table, kind, errors, warnings));
  }
  return { lines, visible, sections, rows, blocks, errors, warnings };
}

/** Well-formed `### Issue N: title` bodies strictly inside `## 正文`. */
export function bodyBlocks(ledger: ReturnType<typeof parseLedger>): BodyBlock[] {
  // Without the skeleton there is no ledger to speak of; `show` reports E120
  // separately, so returning nothing here keeps the view honest.
  if (ledger.errors.some((error) => error.code === "E120")) return [];
  const body = ledger.sections.find((section) => section.level === 2 && section.title === "正文");
  if (!body) return [];
  const out: BodyBlock[] = [];
  for (const section of ledger.sections) {
    if (section.level !== 3) continue;
    if (section.line_start <= body.line_start || section.line_start > body.line_end) continue;
    const match = ISSUE_HEADING.exec(section.title);
    if (!match) continue;
    const id = parseId(match[1]!);
    if (!id) continue;
    out.push({ id, title: match[2]!, line: section.line_start, end: section.line_end });
  }
  return out;
}

/** Highest numbered issue anywhere in the tables, retired range ends included. */
export function maxIssueId(rows: { open: LedgerRow[]; closed: LedgerRow[] }): number {
  let max = 0;
  for (const row of [...rows.open, ...rows.closed]) {
    for (const span of row.ids) max = Math.max(max, span.end);
  }
  return max;
}
