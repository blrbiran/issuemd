import { scan } from "./scan.js";
import { buildSections, type Section } from "./sections.js";
import { parseId, parseIds, type IdSpan } from "./issue-id.js";
import { STATUS_CLASSES } from "./statuses.js";

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

/**
 * A table row in 索引/已关闭 that could not be read (wrong cell count, bad id).
 * It is not in `rows`, but its ids — when the first cell still parses — are
 * real and must not be reused or reported as missing (dogfood #36).
 */
export type UnreadableRow = { line: number; table: TableKind | "stray" | "cited"; reason: string; ids?: IdSpan[] };

/**
 * H2 titles whose tables are ledger data in the pre-canonical layouts (cafe
 * `## 状态总览`, orca `## 待处理`). adopt migrates them; check reports them.
 */
export const isTableSection = (title: string) => /索引|总览|待处理|待办|已关闭|closed|open|issues?/i.test(title);
/** How adopt reads an issue table's columns; also the one definition of
 * "issue table" that E124 uses, so check flags exactly what adopt migrates. */
export type Mapping = {
  id: number;
  status?: number;
  priority?: number;
  summary: number;
  criteria?: number;
  /** Header cells not mapped to a field; their text is appended to criteria. */
  extra?: { index: number; name: string }[];
  /** True when the mapping is a guess (no 摘要/标题 header): table sections only. */
  guess?: boolean;
};

/** Columns that explain why an issue is closed; criteria when there is no 判据. */
const VERDICT_COLUMNS = ["裁决", "说明", "理由", "原因", "结论", "备注"];

export function mappingFor(header: string[] | undefined, width: number): Mapping | undefined {
  if (header) {
    const index = (...names: string[]) => header.findIndex((cell) => names.includes(cell));
    const id = index("#", "编号", "ID", "Id", "id");
    if (id < 0) return undefined; // a header that names no id column is not an issue table
    const status = index("状态");
    const priority = index("P", "优先级");
    const named = index("摘要", "标题");
    let criteria = index("判据");
    const taken = new Set([id, status, priority, named, criteria].filter((at) => at >= 0));
    if (criteria < 0) criteria = header.findIndex((cell, at) => !taken.has(at) && VERDICT_COLUMNS.includes(cell));
    if (criteria >= 0) taken.add(criteria);
    // Without 摘要/标题 the summary is the first column the header does not
    // name otherwise — but only when the header names something else we know
    // (`| # | 状态 | 说明 |`) or is just `| # | X |`. Reading an unknown wide
    // header by position turned 状态 into the summary; such tables are kept
    // verbatim instead.
    let summary = named;
    if (summary < 0) {
      const knows = status >= 0 || priority >= 0 || criteria >= 0;
      if (!knows && width !== 2) return undefined;
      summary = header.findIndex((_, at) => !taken.has(at));
      if (summary < 0 && criteria >= 0) {
        // `| # | 判据 |`: the only text there is is the summary.
        summary = criteria;
        criteria = -1;
      }
      if (summary < 0) return undefined;
    }
    const used = new Set([id, status, priority, summary, criteria].filter((at) => at >= 0));
    const extra = header.flatMap((name, at) => (used.has(at) ? [] : [{ index: at, name }]));
    return {
      id,
      status: status >= 0 ? status : undefined,
      priority: priority >= 0 ? priority : undefined,
      summary,
      criteria: criteria >= 0 ? criteria : undefined,
      extra: extra.length ? extra : undefined,
      guess: named < 0,
    };
  }
  // Header-less blocks: width decides (`# | 摘要 | 判据` is the orca shape).
  // A guess, trusted only inside a ledger table section; wider blocks are
  // kept verbatim.
  if (width === 2) return { id: 0, summary: 1 };
  if (width === 3) return { id: 0, summary: 1, criteria: 2 };
  if (width === 5) return { id: 0, status: 1, priority: 2, summary: 3, criteria: 4 };
  if (width === 4) return { id: 0, status: 1, priority: 2, summary: 3 };
  return undefined;
}

const OWN_TABLES = new Set(["怎么用", "状态口径", "索引", "已关闭", "正文", "附录"]);
const ID_COLUMN = ["#", "编号", "ID", "Id", "id"];

const isSeparatorRow = (cells: string[]) => cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));

/** A cell holding exactly a default status word (`未决`, `**已修**`), nothing more. */
/**
 * The trailing `（N）` count of a heading (E121), or null. A four-digit year
 * (19xx/20xx) is not a count: `## 发布（2025）` is a stable title. check
 * (E121), new/rename/reopen (`titleProblem`) and adopt (`stripCounts`) all use
 * this one rule, so adopt never strips what check accepts and vice versa.
 */
export function countSuffix(title: string): RegExpExecArray | null {
  const match = /[ \t]*[（(]\s*(\d+)\s*[）)]\s*$/.exec(title);
  return match && !/^(?:19|20)\d\d$/.test(match[1]!) ? match : null;
}

export function isStatusWord(cell: string): boolean {
  return Object.hasOwn(STATUS_CLASSES, cell.replace(/\*\*|__/g, "").trim());
}

/**
 * The header of a pipe block, read the way adopt reads it — the one rule both
 * use (#56/#57):
 * - a first row with no digit at all is a header;
 * - a first row above a real separator is a header (`| 2026 | 开放 | 关闭 |`,
 *   `负责人2`) unless it is plainly an issue row written where the header goes:
 *   its first cell is an id next to text, and its second cell is a status
 *   word, or nothing follows the separator, or some row below is such an id
 *   row too (`| 7 | 甲 | 乙 |` + `|---|` + `| 8 | 丙 | 丁 |`; a stats table
 *   `| 2026 | 开放 | 关闭 |` over `| 12 | 3 | 4 |` stays a header);
 * - no separator, or `synthetic` (adopt inserted it under the first row of a
 *   header-less block): a row with a digit-leading cell is data.
 */
export function tableHeader(rows: string[][], synthetic = false): string[] | undefined {
  const first = rows[0];
  if (!first || first.length === 0) return undefined;
  if (first.every((cell) => !/\d/.test(cell))) return first;
  // No separator: adopt puts one under the first row (fixSeparators), so read
  // it exactly as adopt will (review 13: `| 负责人2 | … |` over `| 7 | … |`).
  if (!rows[1] || !isSeparatorRow(rows[1]) || synthetic) {
    return first.every((cell) => !/^\d/.test(cell)) ? first : undefined;
  }
  // An id plus some text (not just numbers): `| 7 | 甲 |` yes, `| 12 | 3 | 4 |` no.
  const issueLike = (cells: string[]) =>
    parseIds(cells[0] ?? "") != null && cells.slice(1).some((cell) => cell !== "" && !/^[\d.,%\s-]+$/.test(cell));
  const below = rows.slice(2);
  const issueRow = issueLike(first) &&
    (below.length === 0 || isStatusWord(first[1] ?? "") || below.some(issueLike));
  return issueRow ? undefined : first;
}

/** Data rows of a pipe block: everything but its header and separators. */
function dataRows(rows: string[][], header: string[] | undefined): { cells: string[]; index: number }[] {
  return rows.flatMap((cells, index) =>
    (header && index === 0) || isSeparatorRow(cells) ? [] : [{ cells, index }]);
}


/**
 * Issue rows sitting under an H2 the ledger does not read (dogfood #52). They
 * are invisible to every view, so they become E124 + unreadable rows: their
 * ids are reserved and `show` points at them instead of "no such issue".
 *
 * Only under a ledger-table heading (`isTableSection`) — exactly where adopt
 * migrates rows (`tableHeader` + `mappingFor`, the shared definition). An
 * issue-shaped table under any other heading (`## 复核记录`) is usually
 * narrative citing ids; adopt keeps it as text, so it gets W225 (once per
 * table) instead of an error adopt could never clear (#54). Its ids are still
 * reserved (`cited`): `new` will not hand one out again (#56).
 *
 * Outside ledger headings a table counts when its header names an id column
 * and either a 摘要/标题 column or nothing else (`| # | 说明 |`), or when an id
 * row sits where the header goes. `| ID | 状态 | 说明 |` (a roadmap) does not.
 */
function strayRows(
  blocks: PipeBlock[],
  h2s: Section[],
  errors: Diagnostic[],
  warnings: Diagnostic[],
  unreadable: UnreadableRow[],
  cited: UnreadableRow[],
) {
  for (const block of blocks) {
    const h2 = h2s.filter((section) => section.line_start < block.line).at(-1);
    // Only the section the ledger actually reads is skipped: `## 索引（旧）`,
    // `## 已关闭（2025）` or a second `## 索引` hide rows otherwise (probe 11).
    if (!h2 || (OWN_TABLES.has(h2.title) && h2s.find((section) => section.title === h2.title) === h2)) continue;
    const header = tableHeader(block.rows);
    const width = (header ?? block.rows[0]).length;
    if (!isTableSection(h2.title)) {
      // Pipe lines without a separator render as a paragraph, not a table.
      if (!block.header) continue;
      let idAt = -1;
      if (header) {
        const at = header.findIndex((cell) => ID_COLUMN.includes(cell));
        if (at >= 0 && (header.length === 2 || header.some((cell) => cell === "摘要" || cell === "标题"))) idAt = at;
      } else if (mappingFor(undefined, width)) {
        idAt = 0; // an id row in the header slot renders as a table
      }
      if (idAt < 0) continue;
      const reason = `table under '## ${h2.title}' looks like an issue table but is not tracked (adopt keeps it as text); ` +
        "its ids are reserved, so new will not reuse them; if its rows are issues, move them into 索引/已关闭 by hand; " +
        "if not, rename its '#' column";
      let warned = false;
      for (const { cells, index } of dataRows(block.rows, header)) {
        const ids = parseIds(cells[idAt] ?? "");
        if (!ids) continue;
        const line = block.line + index;
        if (!warned) warnings.push({ code: "W225", line, message: reason });
        warned = true;
        cited.push({ line, table: "cited", reason: `cited in a table under '## ${h2.title}' (W225)`, ids });
      }
      continue;
    }
    // Under a ledger-table heading: exactly the tables adopt migrates.
    const mapping = mappingFor(header, width);
    if (!mapping) continue;
    for (const { cells, index } of dataRows(block.rows, header)) {
      const ids = parseIds(cells[mapping.id] ?? "");
      if (!ids) continue;
      const line = block.line + index;
      const reason = `issue row under '## ${h2.title}' (outside 索引/已关闭) is not read; run 'issuemd adopt FILE' to move it`;
      errors.push({ code: "E124", line, message: reason });
      unreadable.push({ line, table: "stray", reason, ids });
    }
  }
}

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

/** E108 text; extra cells are almost always an unescaped `|` inside a cell. */
function cellCountMessage(expected: number, found: number): string {
  const hint = found > expected ? " — likely an unescaped '|' inside a cell; write it as '\\|'" : "";
  return `Expected ${expected} cells, found ${found}${hint}`;
}

function readRows(
  block: PipeBlock,
  kind: TableKind,
  errors: Diagnostic[],
  warnings: Diagnostic[],
  unreadable: UnreadableRow[],
): LedgerRow[] {
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
      if (!block.header) errors.push({ code: "E108", line, message: cellCountMessage(columns.length, cells.length) });
      if (cells.length > columns.length) warnings.push({ code: "W205", line, message: "Check for an unescaped pipe in a cell" });
      unreadable.push({
        line, table: kind, reason: cellCountMessage(columns.length, cells.length), ids: parseIds(cells[0] ?? "") ?? undefined,
      });
      continue;
    }
    const ids = parseIds(cells[0]);
    if (!ids) {
      errors.push({ code: "E109", line, message: `Invalid issue IDs: ${cells[0]}` });
      unreadable.push({ line, table: kind, reason: `Invalid issue IDs: ${cells[0]}` });
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
  const unreadable: UnreadableRow[] = [];
  /** Ids cited by W225 tables: not issues the ledger tracks, but reserved. */
  const cited: UnreadableRow[] = [];
  const missing = CORE.filter((title) => !h2s.some((section) => section.title === title));
  if (missing.length > 0) {
    errors.push({ code: "E120", line: 1, message: `Canonical ledger sections missing: ${missing.join(", ")}` });
    return { lines, visible, sections, rows, unreadable, cited, blocks: [] as PipeBlock[], errors, warnings };
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
          errors.push({ code: "E108", line, message: cellCountMessage(width, cells.length) });
        }
      });
    }
  }
  for (const [kind, title] of [["open", "索引"], ["closed", "已关闭"]] as const) {
    const section = h2s.find((candidate) => candidate.title === title)!;
    const tables = blocks.filter((block) => block.line > section.line_start && block.line <= section.line_end);
    if (tables.length !== 1) errors.push({ code: "E112", line: section.line_start, message: `${title} must contain one table` });
    rows[kind] = tables.flatMap((table) => readRows(table, kind, errors, warnings, unreadable));
  }
  strayRows(blocks, h2s, errors, warnings, unreadable, cited);
  return { lines, visible, sections, rows, unreadable, cited, blocks, errors, warnings };
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
export function maxIssueId(rows: { open: LedgerRow[]; closed: LedgerRow[] }, unreadable: UnreadableRow[] = []): number {
  let max = 0;
  for (const row of [...rows.open, ...rows.closed]) {
    for (const span of row.ids) max = Math.max(max, span.end);
  }
  for (const row of unreadable) {
    for (const span of row.ids ?? []) max = Math.max(max, span.end);
  }
  return max;
}
