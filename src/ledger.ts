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

/**
 * A table row in 索引/已关闭 that could not be read (wrong cell count, bad id).
 * It is not in `rows`, but its ids — when the first cell still parses — are
 * real and must not be reused or reported as missing (dogfood #36).
 */
export type UnreadableRow = { line: number; table: TableKind | "stray"; reason: string; ids?: IdSpan[] };

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

/**
 * Issue rows sitting under an H2 the ledger does not read (dogfood #52). They
 * are invisible to every view, so they become E124 + unreadable rows: their
 * ids are reserved and `show` points at them instead of "no such issue".
 *
 * Only under a ledger-table heading (`isTableSection`) — exactly where adopt
 * migrates rows. An issue-shaped table under any other heading (`## 复核记录`)
 * is usually narrative citing existing ids; adopt keeps it as text, so it gets
 * W225 (once per table) instead of an error adopt could never clear (#54).
 */
function strayRows(
  blocks: PipeBlock[],
  h2s: Section[],
  errors: Diagnostic[],
  warnings: Diagnostic[],
  unreadable: UnreadableRow[],
) {
  for (const block of blocks) {
    const h2 = h2s.filter((section) => section.line_start < block.line).at(-1);
    if (!h2 || OWN_TABLES.has(h2.title.replace(/\s*[（(][^）)]*[）)]\s*$/, "").trim())) continue;
    let idAt: number;
    let first: number;
    if (!isTableSection(h2.title)) {
      // Outside ledger-table headings adopt keeps tables as text; one that
      // names an id and a summary column still gets a heads-up (W225, #54).
      if (!block.header) continue;
      const header = block.rows[0];
      const at = header.findIndex((cell) => ID_COLUMN.includes(cell));
      if (at < 0 || !header.some((cell) => cell === "摘要" || cell === "标题")) continue;
      const line = block.rows.slice(2).findIndex((cells) => parseIds(cells[at] ?? ""));
      if (line >= 0) {
        warnings.push({
          code: "W225",
          line: block.line + 2 + line,
          message: `table under '## ${h2.title}' looks like an issue table but is not tracked (adopt keeps it as text); ` +
            "if its rows are issues, move them into 索引/已关闭 by hand; if not, rename its '#' column",
        });
      }
      continue;
    }
    // Under a ledger-table heading: exactly the tables adopt migrates.
    const mapping = block.header
      ? mappingFor(block.rows[0], block.rows[0].length)
      : mappingFor(undefined, block.rows[0].length);
    if (!mapping) continue;
    idAt = mapping.id;
    first = block.header ? 2 : 0;
    block.rows.slice(first).forEach((cells, index) => {
      const ids = parseIds(cells[idAt] ?? "");
      if (!ids) return;
      const line = block.line + first + index;
      const reason = `issue row under '## ${h2.title}' (outside 索引/已关闭) is not read; run 'issuemd adopt FILE' to move it`;
      errors.push({ code: "E124", line, message: reason });
      unreadable.push({ line, table: "stray", reason, ids });
    });
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
  const missing = CORE.filter((title) => !h2s.some((section) => section.title === title));
  if (missing.length > 0) {
    errors.push({ code: "E120", line: 1, message: `Canonical ledger sections missing: ${missing.join(", ")}` });
    return { lines, visible, sections, rows, unreadable, blocks: [] as PipeBlock[], errors, warnings };
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
  strayRows(blocks, h2s, errors, warnings, unreadable);
  return { lines, visible, sections, rows, unreadable, blocks, errors, warnings };
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
