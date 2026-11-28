import { fencedLines, inlineCodeRanges, isEscapedMarkdownChar, multilineInlineCodeRanges, scan } from "./scan.js";
import { buildSections, type Section } from "./sections.js";
import { idText, parseId, parseIds, type IdSpan } from "./issue-id.js";
import { STATUS_CLASSES } from "./statuses.js";

export const ARCHIVE_HEADING = /^ {0,3}###[ \t]+#([1-9]\d*[a-z]?)[ \t]+([\s\S]*?)（已关闭，正文保留）(?:[ \t]+#+)?[ \t]*$/;

export const KEPT_BODY_VERSION_V2 = "<!-- issuemd:kept-body:v2 -->";
export const KEPT_BODY_VERSION_V3 = "<!-- issuemd:kept-body:v3 -->";
/** Compatibility alias for the archive format emitted by the current writer until Task 3 switches it to v3. */
export const KEPT_BODY_VERSION = KEPT_BODY_VERSION_V2;
export const KEPT_BODY_START = "<!-- issuemd:kept-body:start -->";
export const KEPT_BODY_LINES_PREFIX = "<!-- issuemd:kept-body:lines:";
export const keptBodyLinesMarker = (count: number) => `${KEPT_BODY_LINES_PREFIX}${count} -->`;
export const KEPT_BODY_SEPARATOR = "<!-- issuemd:kept-body:separator -->";
export const KEPT_BODY_END = "<!-- issuemd:kept-body:end -->";
export const HIGH_WATER_MARKER = "<!-- issuemd:high-water:";

const CORE = ["索引", "已关闭", "正文"] as const;

export type TableKind = "open" | "closed";
export type Diagnostic = {
  code: string;
  line: number;
  column?: number;
  cue?: string;
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

/**
 * The trailing `（N）` count of a heading (E121), or null. A four-digit year
 * (19xx/20xx) is not a count: `## 发布（2025）` is a stable title. check
 * (E121), new/rename/reopen (`titleProblem`) and adopt (`stripCounts`) all use
 * this one rule, so adopt never strips what check accepts and vice versa.
 * Full-width digits (`（２）`) count too. `title` is the heading text without
 * its `#` markers (adopt strips ATX closing hashes before asking).
 */
export function countSuffix(title: string): RegExpExecArray | null {
  const match = /[ \t]*[（(]\s*([0-9０-９]+)\s*[）)]\s*$/.exec(title);
  if (!match || /^(?:19|20)\d\d$/.test(match[1]!.normalize("NFKC"))) return null;
  // A title that is nothing but a bracketed number is the title itself.
  return title.slice(0, match.index).trim() ? match : null;
}

/** `title` without any trailing counts (`甲（2）（3）` → `甲`; years stay). */
export function stripCountSuffixes(title: string): string {
  for (let suffix = countSuffix(title); suffix; suffix = countSuffix(title)) title = title.slice(0, suffix.index);
  return title;
}

/** A cell holding exactly a default status word (`未决`, `**已修**`), nothing more. */
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


type CommentScan = { hidden: Set<number>; unclosed: Map<number, number>; unclosedOpeners: number[] };

/** Comments may hide example tables within one structural scope. */
function commentSpans(lines: string[], visible: Set<number>, boundaries: Map<number, boolean>): CommentScan {
  const hidden = new Set<number>();
  const unclosed = new Map<number, number>();
  const unclosedOpeners: number[] = [];
  const fenced = fencedLines(lines, true);
  let opener: number | undefined;
  let inArchive = false;
  const endScope = (line: number) => {
    if (opener === undefined) return;
    unclosedOpeners.push(opener);
    for (let covered = opener + 1; covered < line; covered++) unclosed.set(covered, opener);
    opener = undefined;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const text = lines[index]!;
    const archiveStart = boundaries.get(line);
    if (archiveStart !== undefined) {
      endScope(line);
      inArchive = archiveStart;
      continue;
    }
    if (fenced[index] || !visible.has(line) || /^ {0,3}\|/.test(text)) continue;
    if (inArchive && text.trim() === KEPT_BODY_END) {
      endScope(line);
      inArchive = false;
      continue;
    }

    let cursor = 0;
    if (opener !== undefined) {
      // A standalone closer can end a multiline comment. Incidental mentions
      // elsewhere on a line cannot change the visibility of earlier tables.
      const close = /^[ \t]*-->/.exec(text);
      if (!close) continue;
      for (let covered = opener + 1; covered <= line; covered++) hidden.add(covered);
      opener = undefined;
      cursor = close[0].length;
    }
    if (!text.includes("<!--", cursor)) continue;
    const code = inlineCodeRanges(text.slice(cursor));
    const codeOffset = cursor;
    let range = 0;
    for (let open = text.indexOf("<!--", cursor); open >= 0; open = text.indexOf("<!--", cursor)) {
      while (range < code.length && code[range]![1] + codeOffset <= open) range++;
      if (range < code.length && code[range]![0] + codeOffset <= open) {
        cursor = code[range]![1] + codeOffset;
        continue;
      }
      const close = text.indexOf("-->", open + 4);
      if (close < 0) {
        opener = line;
        break;
      }
      cursor = close + 3;
    }
  }
  endScope(lines.length + 1);
  return { hidden, unclosed, unclosedOpeners };
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
 * row sits where the header goes. In other tables with an ID and a 状态
 * column, only rows using ledger status words reserve IDs, without W225.
 */
function strayRows(
  blocks: PipeBlock[],
  h2s: Section[],
  errors: Diagnostic[],
  warnings: Diagnostic[],
  unreadable: UnreadableRow[],
  cited: UnreadableRow[],
  lines: string[],
  visible: Set<number>,
  boundaries: Map<number, boolean>,
) {
  const comments = commentSpans(lines, visible, boundaries);
  for (const line of comments.unclosedOpeners) {
    warnings.push({ code: "W262", line, message: "Unclosed HTML comment; following free-form issue tables remain reserved" });
  }
  for (const block of blocks) {
    const h2 = h2s.filter((section) => section.line_start < block.line).at(-1);
    if (!h2) continue;
    const freeform = h2.title === "正文" || h2.title === "附录";
    // Canonical issue tables are read elsewhere; guide/status sections are
    // controlled text. 正文/附录 stay free-form, but visible issue-shaped rows
    // still reserve IDs so archiving a body cannot make an ID reusable.
    if (OWN_TABLES.has(h2.title) && !freeform && h2s.find((section) => section.title === h2.title) === h2) continue;
    const header = tableHeader(block.rows);
    const width = (header ?? block.rows[0]).length;
    if (!isTableSection(h2.title)) {
      // Pipe lines without a separator render as a paragraph, not a table.
      if (!block.header || (freeform && !block.separator)) continue;
      const statusAt = header?.indexOf("状态") ?? -1;
      const idAt = header ? header.findIndex((cell) => ID_COLUMN.includes(cell)) : 0;
      if (idAt < 0) continue;
      const warn = header
        ? header.length === 2 || header.some((cell) => cell === "摘要" || cell === "标题")
        : !!mappingFor(undefined, width);
      if (!warn && (!block.separator || statusAt < 0)) continue;
      const commentOpener = comments.unclosed.get(block.line);
      if (!(warn && !freeform) && comments.hidden.has(block.line)) continue;
      const reason = freeform
        ? `cited in a free-form table under '## ${h2.title}'${commentOpener !== undefined ? ` inside an unclosed HTML comment from L${commentOpener}` : ""}`
        : `table under '## ${h2.title}' looks like an issue table but is not tracked (adopt keeps it as text); ` +
          "its ids are reserved, so new will not reuse them; if its rows are issues, move them into 索引/已关闭 by hand; " +
          "if not, rename its '#' column";
      let warned = false;
      for (const { cells, index } of dataRows(block.rows, header)) {
        if (!warn && !isStatusWord(cells[statusAt] ?? "")) continue;
        const ids = parseIds(cells[idAt] ?? "");
        if (!ids) continue;
        const line = block.line + index;
        if (warn && !freeform && !warned) {
          warnings.push({ code: "W225", line, message: reason });
          warned = true;
        }
        const source = `${warn ? (freeform ? "free-form issue table" : "W225") : "ledger status"}` +
          `${freeform && commentOpener !== undefined ? `; unclosed HTML comment from L${commentOpener}` : ""}`;
        cited.push({ line, table: "cited", reason: `cited in a table under '## ${h2.title}' (${source})`, ids });
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
      // Name the row: E124 is about one issue row, so a JSON consumer can
      // point at `#500` instead of only a line number (round 14).
      const first = ids[0]!;
      const id = first.start === first.end ? idText(first) : `${first.start}–${first.end}`;
      const reason = `issue row under '## ${h2.title}' (outside 索引/已关闭) is not read; run 'issuemd adopt FILE' to move it`;
      errors.push({ code: "E124", line, id, message: reason });
      unreadable.push({ line, table: "stray", reason, ids });
    }
  }
}

type PipeBlock = { line: number; rows: string[][]; header: boolean; separator: boolean };
export type { PipeBlock };
export type BodyBlock = { id: IdSpan; title: string; line: number; end: number };
export const ISSUE_HEADING = /^Issue\s+([^:\s]+)\s*:\s*([\s\S]*)$/;
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
  const finalNewline = src.endsWith("\n");
  const lines = src.replace(/^﻿/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const visible = new Set<number>();
  const sections = buildSections(scan(src, (line) => visible.add(line)), lines.length);
  const h2s = sections.filter((section) => section.level === 2);
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const rows: Record<TableKind, LedgerRow[]> = { open: [], closed: [] };
  const unreadable: UnreadableRow[] = [];
  /** IDs cited by external tables and reserved for allocation. */
  const cited: UnreadableRow[] = [];
  const missing = CORE.filter((title) => !h2s.some((section) => section.title === title));
  if (missing.length > 0) {
    errors.push({ code: "E120", line: 1, message: `Canonical ledger sections missing: ${missing.join(", ")}` });
    return { lines, finalNewline, visible, sections, rows, unreadable, cited, blocks: [] as PipeBlock[], errors, warnings };
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
  const commentBoundaries = new Map<number, boolean>();
  const masks = archiveMasks(lines);
  const hiddenHeading = (line: number) => masks.fenced[line - 1] || masks.rawHtml[line - 1];
  for (const section of sections) {
    if (hiddenHeading(section.line_start)) continue;
    if (section.level <= 2) commentBoundaries.set(section.line_start, false);
    if (section.level !== 3) continue;
    if (section.parent?.title === "正文" && ISSUE_HEADING.test(section.title)) {
      commentBoundaries.set(section.line_start, false);
    }
    if (section.parent?.title === "附录" && ARCHIVE_HEADING.test(lines[section.line_start - 1]!)) {
      commentBoundaries.set(section.line_start, true);
    }
  }
  strayRows(blocks, h2s, errors, warnings, unreadable, cited, lines, visible, commentBoundaries);
  return { lines, finalNewline, visible, sections, rows, unreadable, cited, blocks, errors, warnings };
}

export type HighWaterRecord = { line: number; value?: number };

/** Read the optional allocation high-water mark from the document preamble. */
export function highWaterRecords(ledger: { lines: string[]; sections: Section[] }): HighWaterRecord[] {
  const firstH2 = ledger.sections.find((section) => section.level === 2)?.line_start ?? ledger.lines.length + 1;
  const fenced = fencedLines(ledger.lines, true);
  const records: HighWaterRecord[] = [];
  for (let index = 0; index < firstH2 - 1; index++) {
    const line = ledger.lines[index]!;
    if (fenced[index] || !/^ {0,3}<!-- issuemd:high-water:/.test(line)) continue;
    const match = /^ {0,3}<!-- issuemd:high-water: ([1-9]\d*) -->[ \t]*$/.exec(line);
    const value = match ? Number(match[1]) : undefined;
    records.push({ line: index + 1, ...(value != null && Number.isSafeInteger(value) ? { value } : {}) });
  }
  return records;
}

export type ArchiveMasks = { fenced: boolean[]; rawHtml: boolean[]; comments: boolean[] };
const archiveMaskCache = new WeakMap<string[], ArchiveMasks>();

/** One pass over Markdown blocks: comment syntax inside raw HTML stays raw text. */
function markdownBlockMasks(lines: string[], fenced: boolean[]): { rawHtml: boolean[]; comments: boolean[] } {
  const rawHtml = Array(lines.length).fill(false) as boolean[];
  const comments = Array(lines.length).fill(false) as boolean[];
  let state: { kind: "comment" } | { kind: "raw"; end: RegExp } | { kind: "blank" } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (state?.kind === "comment") {
      comments[index] = true;
      if (line.includes("-->")) state = undefined;
      continue;
    }
    if (state?.kind === "raw") {
      rawHtml[index] = true;
      if (state.end.test(line)) state = undefined;
      continue;
    }
    if (state?.kind === "blank") {
      if (/^[ \t]*$/.test(line)) {
        state = undefined;
        continue;
      }
      rawHtml[index] = true;
      continue;
    }
    if (fenced[index]) continue;

    if (/^ {0,3}<!\[CDATA\[/.test(line)) {
      rawHtml[index] = true;
      if (!line.includes("]]>")) state = { kind: "raw", end: /\]\]>/ };
      continue;
    }
    if (/^ {0,3}<\?/.test(line)) {
      rawHtml[index] = true;
      if (!line.includes("?>")) state = { kind: "raw", end: /\?>/ };
      continue;
    }
    if (/^ {0,3}<![A-Z]/.test(line)) {
      rawHtml[index] = true;
      if (!line.includes(">")) state = { kind: "raw", end: />/ };
      continue;
    }
    const rawOpen = /^ {0,3}<(pre|script|style|textarea)(?=[ \t>]|$)/i.exec(line);
    if (rawOpen) {
      rawHtml[index] = true;
      const close = new RegExp(`</${rawOpen[1]}\\s*>`, "i");
      if (!close.test(line)) state = { kind: "raw", end: close };
      continue;
    }

    const code = inlineCodeRanges(line);
    let open = line.indexOf("<!--");
    while (open >= 0 && code.some(([start, end]) => open >= start && open < end)) open = line.indexOf("<!--", open + 4);
    if (open >= 0 && line.indexOf("-->", open + 4) < 0) {
      comments[index] = true;
      state = { kind: "comment" };
      continue;
    }

    const match = /^ {0,3}<(\/)?([a-z][a-z0-9-]*)(?=[ \t/>]|$)/i.exec(line);
    if (!match) continue;
    const closing = match[1] != null;
    const tag = match[2]!.toLowerCase();
    rawHtml[index] = true;
    if (!HTML_BLOCK_TAGS.has(tag)) {
      const standaloneTag = /^ {0,3}<\/?[a-z][a-z0-9:-]*(?:[ \t]+[^<>]*)?\/?>[ \t]*$/i.test(line);
      if (tag.includes("-") || standaloneTag) state = { kind: "blank" };
      continue;
    }
    if (closing) {
      state = { kind: "blank" };
      continue;
    }
    const closingTag = new RegExp(`</${tag}\\s*>`, "i");
    if (!closingTag.test(line)) state = { kind: "blank" };
  }
  return { rawHtml, comments };
}

function archiveMasks(lines: string[], fenced: boolean[] = fencedLines(lines, true)): ArchiveMasks {
  const cached = archiveMaskCache.get(lines);
  if (cached) return cached;
  const { comments, rawHtml } = markdownBlockMasks(lines, fenced);
  const masks = { fenced, comments, rawHtml };
  archiveMaskCache.set(lines, masks);
  return masks;
}

export type ArchiveSection = { appendix: Section; section: Section; id: string };
export type HiddenArchive = { id: string; line: number; mask: "code fence" | "HTML comment" | "raw HTML" };
export type ArchiveInventory = {
  appendices: Section[];
  archives: ArchiveSection[];
  hiddenArchives: HiddenArchive[];
  masks: ArchiveMasks;
};

export function hiddenArchiveReason({ mask }: HiddenArchive): string {
  return `kept-body archive heading is hidden by ${mask}`;
}

export function hiddenArchiveRefusal(inventory: ArchiveInventory, id: string): ArchivePruneRefusal | undefined {
  const candidates = inventory.hiddenArchives.filter((candidate) => candidate.id === id);
  if (candidates.length === 0) return undefined;
  const reasons = [...new Set(candidates.map(hiddenArchiveReason))];
  return {
    code: 2,
    reason: `${reasons.join(", ")}; review the masked archive before retrying`,
    lines: candidates.map(({ line }) => line),
  };
}

/** Discover genuine appendix/archive headings after applying shared visibility masks. */
export function archiveInventory(ledger: ReturnType<typeof parseLedger>): ArchiveInventory {
  const lines = ledger.lines;
  const masks = archiveMasks(lines);
  const hidden = (line: number) => masks.fenced[line - 1] || masks.rawHtml[line - 1] || masks.comments[line - 1];
  const headings = ledger.sections.filter((section) => !hidden(section.line_start))
    .sort((left, right) => left.line_start - right.line_start);
  const firstAfter = (start: number, maxLevel: number, limit: number) =>
    headings.find((section) => section.line_start > start && section.line_start < limit && section.level <= maxLevel)?.line_start;
  const appendices = headings
    .filter((section) => section.level === 2 && section.title === "附录")
    .map((section) => ({
      ...section,
      line_end: (firstAfter(section.line_start, 2, lines.length + 1) ?? lines.length + 1) - 1,
    }));
  const archives: ArchiveSection[] = [];
  for (const appendix of appendices) {
    const children = headings.filter((section) => section.level === 3 &&
      section.line_start > appendix.line_start && section.line_start <= appendix.line_end);
    for (const heading of children) {
      const match = ARCHIVE_HEADING.exec(lines[heading.line_start - 1] ?? "");
      if (!match) continue;
      const end = (firstAfter(heading.line_start, 3, appendix.line_end + 1) ?? appendix.line_end + 1) - 1;
      const section = { ...heading, line_end: end, parent: appendix };
      archives.push({ appendix, section, id: match[1]! });
    }
  }
  const hiddenArchives: HiddenArchive[] = [];
  let archiveIndex = 0;
  let containingPayload: ArchivePayloadRange | undefined;
  for (const appendix of appendices) {
    for (let line = appendix.line_start + 1; line + 2 <= appendix.line_end; line++) {
      if (!hidden(line) || lines[line + 1]!.trim() !== KEPT_BODY_START) continue;
      const version = lines[line]!.trim();
      if (version !== KEPT_BODY_VERSION_V2 && version !== KEPT_BODY_VERSION_V3) continue;
      const match = ARCHIVE_HEADING.exec(lines[line - 1]!);
      if (!match) continue;
      while (archives[archiveIndex] && archives[archiveIndex]!.section.line_start < line) {
        const { section } = archives[archiveIndex++]!;
        containingPayload = section.line_end >= line ? locateArchivePayload(ledger, section, masks).range : undefined;
      }
      if (containingPayload && containingPayload.version !== "legacy" &&
          line >= containingPayload.start && line + 2 <= containingPayload.end) continue;
      const mask = masks.fenced[line - 1] ? "code fence" : masks.rawHtml[line - 1] ? "raw HTML" : "HTML comment";
      hiddenArchives.push({ id: match[1]!, line, mask });
    }
  }
  return { appendices, archives, hiddenArchives, masks };
}

export type ArchivePayloadVersion = "v2" | "v3" | "legacy";
export type ArchivePayloadRange = {
  version: ArchivePayloadVersion;
  start: number;
  end: number;
  finalNewline: boolean;
  payloadLineCount: number;
  framingEnd: number;
};
export type ArchivePayloadRefusal = { line: number; reason: string; recognized: boolean };
export type ArchivePayloadResult = { range?: ArchivePayloadRange; refusal?: ArchivePayloadRefusal };

export function locateArchivePayload(
  ledger: { lines: string[]; finalNewline: boolean },
  section: Section,
  masks = archiveMasks(ledger.lines),
): ArchivePayloadResult {
  const lines = ledger.lines;
  const { fenced, rawHtml, comments } = masks;
  const hidden = (line: number) => fenced[line - 1] || rawHtml[line - 1] || comments[line - 1];
  const refusal = (line: number, reason: string, recognized = true): ArchivePayloadResult => ({
    refusal: { line, reason, recognized },
  });
  const visibleLine = (line: number) => line >= 1 && line <= lines.length && !hidden(line);
  if (hidden(section.line_start)) return refusal(section.line_start, "archive heading is hidden inside a literal block", false);

  const headingLine = section.line_start;
  const versionLine = headingLine + 1;
  const versionText = lines[versionLine - 1] ?? "";
  const version = versionText.trim() === KEPT_BODY_VERSION_V2 ? "v2"
    : versionText.trim() === KEPT_BODY_VERSION_V3 ? "v3"
      : undefined;
  const versionish = /^\s*<!-- issuemd:kept-body:v\d+ -->\s*$/.test(versionText);
  // A visible archive heading may have its envelope lines wrapped in a fence,
  // comment, or raw HTML block. Detect only the compact header position; legacy
  // payload is unrestricted text and may contain marker-looking examples.
  const hiddenHeaderMarker = (() => {
    const candidates = [headingLine + 1, headingLine + 2, headingLine + 3]
      .filter((line) => line <= section.line_end);
    for (const line of candidates) {
      const text = lines[line - 1]!.trim();
      const versionMarker = /^<!-- issuemd:kept-body:v\d+ -->$/.test(text);
      const startMarker = text === KEPT_BODY_START;
      const countMarker = /^<!-- issuemd:kept-body:lines:(0|[1-9]\d*) -->$/.test(text);
      if (versionMarker && hidden(line)) return line;
      if ((startMarker || countMarker) && hidden(line) && candidates.some((prior) => prior < line && /^<!-- issuemd:kept-body:v\d+ -->$/.test(lines[prior - 1]!.trim()))) return line;
    }
    return undefined;
  })();
  if (hiddenHeaderMarker != null) return refusal(hiddenHeaderMarker, "kept-body envelope marker is hidden inside a literal block");
  const displacedVersion = (() => {
    for (let line = headingLine + 1; line <= Math.min(section.line_end, headingLine + 3); line++) {
      if (!visibleLine(line)) continue;
      if (/^\s*<!-- issuemd:kept-body:v\d+ -->\s*$/.test(lines[line - 1]!)) return line;
    }
    return undefined;
  })();
  if (!version) {
    if (versionish) return refusal(versionLine, "unsupported or malformed kept-body version marker");
    if (displacedVersion != null) return refusal(displacedVersion, "kept-body version marker is displaced from the archive header");
    const envelopePrefix = [lines[headingLine]?.trim(), lines[headingLine + 1]?.trim()];
    if (envelopePrefix.some((text) => text === KEPT_BODY_START || /^<!-- issuemd:kept-body:lines:(0|[1-9]\d*) -->$/.test(text ?? ""))) {
      return refusal(headingLine + 1, "counted archive is missing its version marker");
    }

    let endMarker: number | undefined;
    for (let line = headingLine + 1; line <= section.line_end; line++) {
      if (visibleLine(line) && lines[line - 1]?.trim() === KEPT_BODY_END) endMarker = line;
    }
    const end = endMarker ?? section.line_end; // inclusive removal bound
    const payloadEnd = endMarker == null ? section.line_end : endMarker - 1;
    const start = headingLine + 1;
    return { range: {
      version: "legacy",
      start,
      end: payloadEnd,
      finalNewline: endMarker != null || section.line_end < lines.length || ledger.finalNewline,
      payloadLineCount: Math.max(0, payloadEnd - start + 1),
      framingEnd: end,
    } };
  }
  if (!visibleLine(versionLine)) return refusal(versionLine, "kept-body version marker is hidden inside a literal block");
  const startLine = versionLine + 1;
  if (lines[startLine - 1]?.trim() !== KEPT_BODY_START || !visibleLine(startLine)) {
    return refusal(startLine, "archive payload start marker is missing or misplaced");
  }

  if (version === "v2") {
    const endMarkers: number[] = [];
    const separatorLines: number[] = [];
    for (let line = startLine + 1; line <= section.line_end; line++) {
      if (!visibleLine(line)) continue;
      if (lines[line - 1]?.trim() === KEPT_BODY_END) endMarkers.push(line);
      if (lines[line - 1]?.trim() === KEPT_BODY_SEPARATOR) separatorLines.push(line);
    }
    if (endMarkers.length !== 1) {
      return refusal(endMarkers[0] ?? startLine, endMarkers.length === 0
        ? "v2 archive has no unique visible end marker"
        : "v2 archive has duplicate visible end markers");
    }
    const end = endMarkers[0]!;
    if (end <= startLine) return refusal(end, "v2 archive end marker precedes its payload start");
    const positionalSeparator = separatorLines.find((line) => line + 1 === end && lines[line - 2]?.trim() === "");
    const payloadEnd = positionalSeparator == null ? end - 1 : positionalSeparator - 2;
    return { range: {
      version: "v2", start: startLine + 1, end: payloadEnd, finalNewline: true,
      payloadLineCount: Math.max(0, payloadEnd - startLine), framingEnd: end,
    } };
  }

  const linesMetaLine = startLine + 1;
  const metaMatch = /^<!-- issuemd:kept-body:lines:(0|[1-9]\d*) -->$/.exec(lines[linesMetaLine - 1] ?? "");
  const count = metaMatch ? Number(metaMatch[1]) : undefined;
  if (!visibleLine(linesMetaLine) || count == null || !Number.isSafeInteger(count)) {
    return refusal(linesMetaLine, "v3 archive has invalid payload line-count metadata");
  }
  const payloadStart = linesMetaLine + 1;
  const frameLine = payloadStart + count;
  const endLine = frameLine + 1;
  if (endLine > section.line_end) return refusal(linesMetaLine, "v3 archive payload line count exceeds its H3 boundary");
  if (lines[frameLine - 1] !== "" || fenced[frameLine - 1] || rawHtml[frameLine - 1]) {
    return refusal(frameLine, "v3 archive frame must be one empty line outside fences and raw HTML blocks");
  }
  if (lines[endLine - 1] !== KEPT_BODY_END || fenced[endLine - 1] || rawHtml[endLine - 1]) {
    return refusal(endLine, "v3 archive end marker is missing, hidden by a fence/raw HTML block, or misplaced");
  }
  return { range: {
    version: "v3", start: payloadStart, end: payloadStart + count - 1,
    finalNewline: false, payloadLineCount: count, framingEnd: endLine,
  } };
}

/** Compatibility wrapper for callers that only need a usable payload range. */
export function archivePayloadRange(
  ledger: { lines: string[]; finalNewline: boolean }, section: Section, fenced: boolean[],
): ArchivePayloadRange | undefined {
  return locateArchivePayload(ledger, section, archiveMasks(ledger.lines, fenced)).range;
}

export function validateSerializedArchive(
  ledger: ReturnType<typeof parseLedger>,
  id: string,
  expectedPayload: string[],
): string | undefined {
  const archives = archiveInventory(ledger).archives.filter((archive) => archive.id === id);
  if (archives.length !== 1) return `expected one visible archive for #${id}; found ${archives.length}`;
  const result = locateArchivePayload(ledger, archives[0]!.section);
  if (!result.range) return result.refusal?.reason ?? `archive for #${id} has no usable payload range`;
  if (result.range.version !== "v3") return `archive for #${id} was not serialized as v3`;
  const actual = ledger.lines.slice(result.range.start - 1, result.range.end);
  if (actual.length !== expectedPayload.length || actual.some((line, index) => line !== expectedPayload[index])) {
    return `archive payload for #${id} differs from the requested source records`;
  }
  return undefined;
}

export function archivePayloadSnapshot(ledger: ReturnType<typeof parseLedger>, excludeId?: string): string {
  const inventory = archiveInventory(ledger);
  const entries: string[] = [];
  for (const { id, section } of inventory.archives) {
    if (id === excludeId) continue;
    const located = locateArchivePayload(ledger, section, inventory.masks);
    if (!located.range) {
      entries.push(`${id}:!${located.refusal?.reason ?? "missing payload"}`);
      continue;
    }
    entries.push(`${id}:${located.range.version}:${ledger.lines.slice(located.range.start - 1, located.range.end).join("\n")}`);
  }
  return entries.sort().join("\n---\n");
}

export function archiveFramingSnapshot(ledger: ReturnType<typeof parseLedger>, excludeId?: string): string {
  const inventory = archiveInventory(ledger);
  const entries = inventory.archives.flatMap(({ id, section }) => {
    if (id === excludeId) return [];
    const located = locateArchivePayload(ledger, section, inventory.masks);
    if (!located.range) return [`${id}:!${located.refusal?.reason ?? "missing framing"}`];
    return [`${id}:${ledger.lines.slice(section.line_start - 1, located.range.framingEnd).join("\n")}`];
  });
  return entries.sort().join("\n---\n");
}

export function archiveEnvelopeDiagnostics(ledger: ReturnType<typeof parseLedger>): Diagnostic[] {
  const inventory = archiveInventory(ledger);
  const diagnostics: Diagnostic[] = [];
  for (const { section, id } of inventory.archives) {
    const result = locateArchivePayload(ledger, section, inventory.masks);
    if (!result.refusal?.recognized) continue;
    diagnostics.push({
      code: "W269", line: result.refusal.line, id,
      message: `Malformed kept-body archive: ${result.refusal.reason}`,
    });
  }
  return diagnostics;
}


export type ArchivePruneRefusal = { code: 1 | 2; reason: string; lines: number[] };
export type ArchivePruneTarget = { section: Section; start: number; end: number };

/** Locate one uniquely-owned, visible v2/v3 archive eligible for explicit pruning. */
export function prunableArchive(
  ledger: ReturnType<typeof parseLedger>,
  id: string,
): { target: ArchivePruneTarget; refusal?: undefined } | { refusal: ArchivePruneRefusal; target?: undefined } {
  const span = parseId(id);
  if (!span) return { refusal: { code: 2, reason: `${id} is not an issue id`, lines: [] } };
  const owners: { table: TableKind | "unreadable"; line: number; exact: boolean }[] = [];
  for (const table of ["open", "closed"] as const) {
    for (const row of ledger.rows[table]) {
      for (const candidate of row.ids) {
        if (candidate.suffix === span.suffix && candidate.start <= span.start && span.start <= candidate.end) {
          owners.push({ table, line: row.line, exact: candidate.start === candidate.end && row.ids.length === 1 });
        }
      }
    }
  }
  for (const row of ledger.unreadable) {
    for (const candidate of row.ids ?? []) {
      if (candidate.suffix === span.suffix && candidate.start <= span.start && span.start <= candidate.end) {
        owners.push({ table: "unreadable", line: row.line, exact: false });
      }
    }
  }
  if (owners.length === 0) return { refusal: { code: 1, reason: `no issue with id ${id}`, lines: [] } };
  if (owners.length !== 1) {
    return { refusal: { code: 2, reason: `id ${id} has conflicting owners`, lines: owners.map((owner) => owner.line) } };
  }
  const owner = owners[0]!;
  if (owner.table === "unreadable") {
    return { refusal: { code: 2, reason: `id ${id} also appears in an unreadable row`, lines: [owner.line] } };
  }
  if (owner.table !== "closed" || !owner.exact) {
    return { refusal: { code: 2, reason: `id ${id} is not a closed singleton row`, lines: [owner.line] } };
  }

  const inventory = archiveInventory(ledger);
  const appendices = inventory.appendices;
  if (appendices.length > 1) {
    return { refusal: { code: 2, reason: "multiple ## 附录 sections (W266)", lines: appendices.map((section) => section.line_start) } };
  }
  if (appendices.length === 0) return { refusal: { code: 1, reason: `no kept-body archive for #${id}`, lines: [] } };

  const candidates = inventory.archives.filter((archive) => archive.appendix.line_start === appendices[0]!.line_start && archive.id === id);
  if (candidates.length === 0) return { refusal: hiddenArchiveRefusal(inventory, id) ?? {
    code: 1, reason: `no kept-body archive for #${id}`, lines: [],
  } };
  if (candidates.length > 1) {
    return { refusal: { code: 2, reason: `multiple archives for #${id}`, lines: candidates.map(({ section }) => section.line_start) } };
  }

  const { section } = candidates[0]!;
  const located = locateArchivePayload(ledger, section, inventory.masks);
  if (!located.range || located.range.version === "legacy") {
    return { refusal: {
      code: 2,
      reason: located.refusal?.reason ?? "legacy archive has no verified envelope boundary and cannot be pruned safely",
      lines: located.refusal ? [located.refusal.line] : [section.line_start],
    } };
  }
  const end = located.range.framingEnd;
  for (let line = end + 1; line <= section.line_end; line++) {
    if (ledger.lines[line - 1]!.trim() !== "") {
      return { refusal: { code: 2, reason: "archive has user text after its end marker", lines: [line] } };
    }
  }
  return { target: { section, start: section.line_start, end } };
}

export const LIMITS_MARKER = "<!-- issuemd:limits:";
/** W201 defaults. Kept here so `check`, the write verbs and the docs agree. */
export const DEFAULT_LIMITS = { bodyBytes: 20 * 1024, bodyLines: 300 } as const;
const HTML_BLOCK_TAGS = new Set([
  "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col", "colgroup",
  "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "iframe",
  "legend", "li", "link", "main", "menu", "menuitem", "meta", "nav", "noframes", "ol", "optgroup", "option",
  "p", "param", "pre", "script", "search", "section", "style", "summary", "table", "tbody", "td", "textarea",
  "tfoot", "th", "thead", "title", "tr", "track", "ul",
]);

/** Lines inside raw HTML blocks; fences are supplied by the caller. */
export function htmlBlockLines(
  lines: string[],
  fenced: boolean[],
  comments = multilineCommentLines(lines, fenced),
): boolean[] {
  const hidden = Array(lines.length).fill(false) as boolean[];
  let endTag: RegExp | undefined;
  let untilBlank = false;
  const rawTextTags = new Set(["pre", "script", "style", "textarea"]);
  for (let index = 0; index < lines.length; index++) {
    if (fenced[index] || comments[index]) continue;
    const line = lines[index]!;
    if (endTag) {
      if (untilBlank && /^[ \t]*$/.test(line)) {
        endTag = undefined;
        untilBlank = false;
        continue;
      }
      hidden[index] = true;
      if (!untilBlank && endTag.test(line)) endTag = undefined;
      continue;
    }
    if (/^ {0,3}<!\[CDATA\[/.test(line)) {
      hidden[index] = true;
      if (!line.includes("]]>")) {
        endTag = /\]\]>/;
        untilBlank = false;
      }
      continue;
    }
    if (/^ {0,3}<\?/.test(line)) {
      hidden[index] = true;
      if (!line.includes("?>")) {
        endTag = /\?>/;
        untilBlank = false;
      }
      continue;
    }
    if (/^ {0,3}<![A-Z]/.test(line)) {
      hidden[index] = true;
      if (!line.includes(">")) {
        endTag = />/;
        untilBlank = false;
      }
      continue;
    }
    const match = /^ {0,3}<(\/)?([a-z][a-z0-9-]*)(?=[ \t/>]|$)/i.exec(line);
    if (!match) continue;
    const closing = match[1] != null;
    const tag = match[2]!.toLowerCase();
    hidden[index] = true;
    if (!HTML_BLOCK_TAGS.has(tag)) {
      const standaloneTag = /^ {0,3}<\/?[a-z][a-z0-9:-]*(?:[ \t]+[^<>]*)?\/?>[ \t]*$/i.test(line);
      if (tag.includes("-") || standaloneTag) {
        // Unknown custom/standalone tags are treated conservatively as raw
        // blocks so archive-shaped examples cannot become prune targets.
        endTag = /$a/;
        untilBlank = true;
      }
      continue;
    }
    const closingTag = new RegExp(`</${tag}\\s*>`, "i");
    if (closing) {
      if (!rawTextTags.has(tag)) {
        endTag = /$a/;
        untilBlank = true;
      }
      continue;
    }
    if (rawTextTags.has(tag)) {
      if (!closingTag.test(line)) endTag = closingTag;
    } else {
      // CommonMark's block-tag HTML forms end at a blank line, not merely at
      // a matching closing tag. Void tags such as <hr> follow this same rule.
      endTag = closingTag;
      untilBlank = true;
    }
  }
  return hidden;
}

/** Lines inside a multiline HTML comment; standalone markers are not hidden. */
export function multilineCommentLines(lines: string[], fenced: boolean[]): boolean[] {
  const hidden = Array(lines.length).fill(false) as boolean[];
  const multilineCode = multilineInlineCodeRanges(lines, fenced);
  let inComment = false;
  for (let index = 0; index < lines.length; index++) {
    if (fenced[index]) continue;
    const line = lines[index]!;
    if (inComment) {
      hidden[index] = true;
      if (line.includes("-->")) inComment = false;
      continue;
    }
    const codeRanges = inlineCodeRanges(line);
    const crossLineRanges = multilineCode.get(index) ?? [];
    let open = line.indexOf("<!--");
    while (open >= 0 && (
      isEscapedMarkdownChar(line, open) ||
      codeRanges.some(([start, end]) => open >= start && open < end) ||
      crossLineRanges.some(([start, end]) => open >= start && open < end)
    )) {
      open = line.indexOf("<!--", open + 4);
    }
    if (open >= 0 && line.indexOf("-->", open + 4) < 0) {
      hidden[index] = true;
      inComment = true;
    }
  }
  return hidden;
}

export type LimitsRecord = { line: number; bodyBytes?: number; bodyLines?: number; problem?: string; unsafeToRewrite?: true };
export type EffectiveLimits = { bodyBytes: number; bodyLines: number; source: "ledger" | "default" };

/**
 * Read the optional W201 limits from the document preamble. A marker outside
 * the preamble (after the first H2) is user prose and is ignored, the same
 * rule the high-water mark follows.
 */
export function limitsRecords(ledger: { lines: string[]; sections: Section[] }): LimitsRecord[] {
  const firstH2 = ledger.sections.find((section) => section.level === 2)?.line_start ?? ledger.lines.length + 1;
  const fenced = fencedLines(ledger.lines, true);
  const rawHtml = htmlBlockLines(ledger.lines, fenced);
  const records: LimitsRecord[] = [];
  let commentEnd: RegExp | undefined;
  for (let index = 0; index < firstH2 - 1; index++) {
    const line = ledger.lines[index]!;
    if (commentEnd) {
      if (commentEnd.test(line)) commentEnd = undefined;
      continue;
    }
    if (fenced[index] || rawHtml[index]) continue;
    if (!/^ {0,3}<!-- issuemd:limits:/.test(line)) {
      if (/^ {0,3}<!--(?:(?!-->).)*$/.test(line)) commentEnd = /-->/;
      continue;
    }
    const match = /^ {0,3}<!-- issuemd:limits:((?:(?!<!--|-->).)*)-->[ \t]*$/.exec(line);
    if (!match) {
      records.push({ line: index + 1, problem: "limits marker must be a standalone comment", unsafeToRewrite: true });
      continue;
    }
    const record: LimitsRecord = { line: index + 1 };
    for (const part of match[1]!.trim().split(/\s+/).filter(Boolean)) {
      const [key, value, ...rest] = part.split("=");
      const parsed = value != null && rest.length === 0 && /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
      if (parsed == null || !Number.isSafeInteger(parsed)) {
        record.problem = `bad limits entry '${part}'`;
        break;
      }
      if (key === "body-bytes" && record.bodyBytes == null) record.bodyBytes = parsed;
      else if (key === "body-lines" && record.bodyLines == null) record.bodyLines = parsed;
      else {
        record.problem = `unknown or duplicate limits key '${key ?? ""}'`;
        break;
      }
    }
    if (record.bodyBytes == null && record.bodyLines == null) record.problem ??= "missing limits entries";
    records.push(record);
  }
  return records;
}

/** The limits W201 actually uses: exactly one well-formed marker, or defaults. */
export function effectiveLimits(ledger: { lines: string[]; sections: Section[] }): EffectiveLimits {
  const records = limitsRecords(ledger);
  if (records.length === 1 && !records[0]!.problem) {
    return {
      bodyBytes: records[0]!.bodyBytes ?? DEFAULT_LIMITS.bodyBytes,
      bodyLines: records[0]!.bodyLines ?? DEFAULT_LIMITS.bodyLines,
      source: "ledger",
    };
  }
  return { ...DEFAULT_LIMITS, source: "default" };
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
