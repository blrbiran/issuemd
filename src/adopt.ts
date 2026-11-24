/**
 * `adopt`: one-time conversion of a non-canonical ledger into the canonical
 * layout.
 *
 * The promise is narrow and deliberate: only *mechanical* edits — the ones a
 * machine can justify without judgement. Everything else becomes a decision
 * for a human. It never picks a winner between conflicting titles, never
 * decides whether progress text matters, and never invents a status word.
 *
 * Three input shapes are recognized:
 *   - cafe: one index table mixing open and closed rows plus a second closed
 *     table that duplicates them; bodies for everything; `####` headings.
 *   - orca: `## 待处理` / `## 已关闭`, each split into status-named H3 groups
 *     whose pipe blocks are header-less 3-column rows.
 *   - canonical-ish: anything already close to the target.
 *
 * Tables are mapped by header name when there is one, by width otherwise;
 * column *order* differs between the real ledgers and a positional guess
 * silently swaps status for priority.
 */

import { scan } from "./scan.js";
import { buildSections, type Section } from "./sections.js";
import { isTableSection, parseLedger, splitCells } from "./ledger.js";
import { archiveHeading, fencedLines, formatRow, guideBlockLines, KEPT_BODY_END, statusBlockLines } from "./ledger-edit.js";
import { compareIds, parseId, parseIds, type IdSpan } from "./issue-id.js";
import { checkLedger, STATUS_CLASSES } from "./ledger-check.js";


export type DecisionKind =
  | "open-title-conflict"
  | "closed-title-conflict"
  | "progress-text"
  | "closed-with-body"
  | "unknown-status"
  | "multi-id-row"
  | "id-range"
  | "unknown-group"
  | "duplicate-row"
  | "missing-body"
  | "foreign-section"
  | "preamble"
  | "orphan-body"
  | "status-in-body"
  | "section-prose"
  | "kept-section-text"
  | "extra-columns";

export type Decision = {
  kind: DecisionKind;
  id?: string;
  line: number;
  /**
   * The line in the *input* file (1-indexed). `line` points at the output,
   * which is what a reader opens after the write; when nothing in the output
   * can be located (`line === 0`) this is the only usable coordinate.
   */
  sourceLine?: number;
  message: string;
  /** Exact text of the output line this decision belongs to, when it has no id. */
  anchor?: string;
  table?: string;
  body?: string;
};

export type AdoptResult = {
  lines: string[];
  decisions: Decision[];
  /** Human-readable mechanical changes, for the report header. */
  changes: string[];
};

type Mapping = {
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

type Row = {
  line: number;
  idText: string;
  firstId: number;
  ids: number[];
  status?: string;
  priority: string;
  summary: string;
  criteria: string;
  /**
   * Text from columns that are not criteria (`负责人：alice`, overflow cells).
   * Kept apart so it is never mistaken for an open issue's 验收判据.
   */
  extras: string;
  /** The H2 section the row was found in, used to infer its table. */
  section: string;
};

const STATUS_WORDS = new Set(Object.keys(STATUS_CLASSES));
/** A `## 已关闭`-style section, whatever it is exactly called. */
const isClosedSection = (title: string) => /已关闭|closed/i.test(title);
/** Sections adopt regenerates itself; every other H2 is preserved verbatim. */
const KNOWN_SECTION = /^(怎么用|状态口径|索引|已关闭|正文|附录)(?:\s*[（(][^）)]*[）)])?$/;
/**
 * `## 正文（按编号）` is the canonical 正文 with a note attached. Matching the
 * bare name only made adopt copy the whole section to 附录 *and* use its
 * bodies, duplicating every open issue.
 */
const canonicalName = (title: string) => title.replace(/\s*[（(][^）)]*[）)]\s*$/, "").trim();
const isCanonical = (section: Section, name: string) => section.level === 2 && canonicalName(section.title) === name;
const fold = (text: string) => text.trim().replace(/\s+/g, " ");
const PROGRESS = /已落地|仍缺|仍无|仍逐|仍走/;
const isSeparator = (cells: string[]) => cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
const isHeader = (cells: string[]) => cells.length > 0 && cells.every((cell) => !/\d/.test(cell));

/** A status word on a group heading, with any `（N）` count stripped. */
function statusFromHeading(title: string): string | undefined {
  const bare = title.replace(/[（(]\s*\d+\s*[）)]\s*$/, "").trim();
  if (STATUS_WORDS.has(bare)) return bare;
  return [...STATUS_WORDS].filter((word) => bare.startsWith(word)).sort((a, b) => b.length - a.length)[0];
}

/** Columns that explain why an issue is closed; criteria when there is no 判据. */
const VERDICT_COLUMNS = ["裁决", "说明", "理由", "原因", "结论", "备注"];

function mappingFor(header: string[] | undefined, width: number): Mapping | undefined {
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

type Block = {
  line: number;
  /** Number of source lines in the block. */
  length: number;
  cells: string[][];
  mapping: Mapping;
  /** Status declared by the enclosing H3 group, if any. */
  groupStatus?: string;
  /** Which H2 section the block sits in. */
  section: string;
};

/** Group consecutive `|`-lines into blocks and attach the enclosing group status. */
function pipeBlocks(lines: string[], sections: Section[]): Block[] {
  const out: Block[] = [];
  let block: { line: number; cells: string[][] } | undefined;
  const finish = () => {
    if (!block) return;
    const start = block.line;
    const header = block.cells[0] && isHeader(block.cells[0]) ? block.cells[0] : undefined;
    const width = (header ?? block.cells[0] ?? []).length;
    const mapping = mappingFor(header, width);
    if (mapping) {
      const h2 = sections.filter((s) => s.level === 2 && s.line_start < start).at(-1);
      // Width-only mappings are a guess; only trust them inside a section that
      // is known to hold ledger tables. A 3-column table inside an issue body
      // or 附录 is content, and turning it into rows invents issues.
      if ((!header || mapping.guess) && !isTableSection(h2?.title ?? "")) {
        block = undefined;
        return;
      }
      const h3 = sections
        .filter((s) => s.level === 3 && s.line_start < start && s.line_start > (h2?.line_start ?? 0))
        .at(-1);
      out.push({
        line: start,
        length: block.cells.length,
        cells: block.cells,
        mapping,
        groupStatus: h3 ? statusFromHeading(h3.title) : undefined,
        section: h2?.title ?? "",
      });
    }
    block = undefined;
  };
  const fenced = fencedLines(lines);
  lines.forEach((text, index) => {
    // A table quoted inside a fence is an example, not data.
    if (!fenced[index] && /^ {0,3}\|/.test(text)) {
      if (!block) block = { line: index + 1, cells: [] };
      block.cells.push(splitCells(text));
    } else {
      finish();
    }
  });
  finish();
  return out;
}

function rowsOf(blocks: Block[]): Row[] {
  const out: Row[] = [];
  for (const block of blocks) {
    const { mapping } = block;
    block.cells.forEach((cells, index) => {
      // A header row (`# | 状态 | P | 摘要`) carries no number; it is layout,
      // not an issue, and must never become a data row.
      if (isSeparator(cells) || isHeader(cells)) return;
      const idText = (cells[mapping.id] ?? "").trim();
      // `7–20` is *one* span, not the ids 7 and 20; multi-id means several
      // comma-separated spans.
      const spans = parseIds(idText);
      if (!spans) return;
      const ids = spans.map((span) => span.start);
      const declared = mapping.status != null ? cells[mapping.status]?.trim() : undefined;
      let criteria = (mapping.criteria != null ? cells[mapping.criteria] : "")?.trim() ?? "";
      // `决定不改：没有逐条可执行清单` in a verdict column is the row's own
      // status plus its reason. It is more specific than a group heading.
      const verdict = /^([^：:\s]+)\s*[：:]\s*(.*)$/.exec(criteria);
      const fromCell = !declared && verdict && STATUS_WORDS.has(verdict[1]!) ? verdict[1] : undefined;
      if (fromCell) criteria = verdict![2]!.trim();
      const extras: string[] = [];
      for (const { index: at, name } of mapping.extra ?? []) {
        const value = (cells[at] ?? "").trim();
        if (value) extras.push(`${name}：${value}`);
      }
      // Cells past the mapped columns (a row wider than its header, usually
      // an unescaped pipe) are text too; they must not vanish with the row.
      const mapped = new Set([mapping.id, mapping.status, mapping.priority, mapping.summary, mapping.criteria,
        ...(mapping.extra ?? []).map(({ index: at }) => at)].filter((at) => at != null));
      cells.forEach((cell, at) => {
        const value = cell.trim();
        if (mapped.has(at) || value === "") return;
        extras.push(value);
      });
      // Keep the declared string even when it is not in the vocabulary, so
      // the decision report can name what the ledger actually said. A group
      // heading wins only when the row itself declares nothing.
      const status = declared || fromCell || block.groupStatus;
      out.push({
        line: block.line + index,
        idText,
        firstId: ids[0]!,
        ids,
        status,
        priority: (mapping.priority != null ? cells[mapping.priority] : "")?.trim() ?? "",
        summary: (cells[mapping.summary] ?? "").trim(),
        criteria,
        extras: extras.join("；"),
        section: block.section,
      });
    });
  }
  return out;
}

type Body = { idText: string; id: number; title: string; line: number; end: number };

/** The identity of an issue: `2` and `2a` are different issues. */
const fullId = (row: { idText: string }) => row.idText.replace(/\s+/g, "");

function bodyHeadings(sections: Section[]): Body[] {
  const out: Body[] = [];
  for (const section of sections) {
    if (section.level !== 3) continue;
    const match = /^Issue\s+(\d+[a-z]?)\s*:\s*(.*)$/.exec(section.title);
    if (!match) continue;
    out.push({
      idText: match[1]!,
      id: Number.parseInt(match[1]!, 10),
      title: match[2]!,
      line: section.line_start,
      end: section.line_end,
    });
  }
  return out;
}

/** The `**验收判据**` paragraph of a body slice, whitespace-folded. */
function criteriaOf(bodyLines: string[]): string | undefined {
  const start = bodyLines.findIndex((line) => /^\*\*验收判据\*\*/.test(line));
  if (start < 0) return undefined;
  const parts = [bodyLines[start]!.replace(/^\*\*验收判据\*\*\s*[:：]?\s*/, "")];
  for (const line of bodyLines.slice(start + 1)) {
    if (line.trim() === "" || /^\*\*/.test(line)) break;
    parts.push(line.trim());
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** Drop leading and trailing blank lines; internal blank lines are content. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/** A `**状态**：…` line belongs in the table, never in a body (E107). */
function dropStatusLabels(
  content: string[],
  decisions: Decision[],
  id: string,
  line: number,
): string[] {
  const fenced = fencedLines(content);
  let dropped = 0;
  const kept = content.filter((text, index) => {
    if (!fenced[index] && /^\s*\*\*状态\*\*\s*[:：]/.test(text)) {
      dropped++;
      return false;
    }
    return true;
  });
  if (dropped > 0) {
    decisions.push({
      kind: "status-in-body",
      id,
      line,
      message: `正文里的 **状态** 标签已删除（状态只存在于表格）`,
    });
  }
  return kept;
}

/**
 * Preserved text lands in 附录. `### Issue N:` there would be E123, and an
 * extra H1 breaks the single-H1 rule (E112); escape the former and demote the
 * latter so the text renders literally without losing its wording.
 */
function neutralizePreserved(content: string[]): string[] {
  const fenced = fencedLines(content);
  return content.map((line, index) => {
    if (fenced[index]) return line;
    return line
      .replace(/^(#{1,6})([ \t]+Issue\b)/, "\\$1$2")
      .replace(/^#([ \t])/, "##$1");
  });
}

/** `#### 现象` inside a body becomes `**现象**`; H3 is the issue heading. */
function demoteHeadings(lines: string[]): { lines: string[]; count: number } {
  let count = 0;
  const fenced = fencedLines(lines);
  const out = lines.map((line, index) => {
    if (fenced[index]) return line;
    // Closing `#`s are stripped only when whitespace separates them from the
    // text, as in CommonMark — `#### Use C#` keeps its `#`.
    const match = /^(#{4,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!match) return line;
    count++;
    return `**${match[2]}**`;
  });
  return { lines: out, count };
}

/**
 * Add the missing separator row to each header-less block, once per block.
 * `origin[i]` is the 1-indexed input line output line `i` came from; an
 * inserted separator borrows the line of the row above it.
 */
function fixSeparators(lines: string[]): { lines: string[]; count: number; origin: number[] } {
  const out: string[] = [];
  const origin: number[] = [];
  const fenced = fencedLines(lines);
  let count = 0;
  let index = 0;
  while (index < lines.length) {
    if (fenced[index] || !/^ {0,3}\|/.test(lines[index]!)) {
      out.push(lines[index]!);
      origin.push(index + 1);
      index++;
      continue;
    }
    const start = index;
    while (index < lines.length && !fenced[index] && /^ {0,3}\|/.test(lines[index]!)) index++;
    const blockLines = lines.slice(start, index);
    const cells = blockLines.map((text) => splitCells(text));
    // A block whose second row is a separator is already well-formed.
    if (cells[1] && isSeparator(cells[1])) {
      out.push(...blockLines);
      blockLines.forEach((_, at) => origin.push(start + at + 1));
      continue;
    }
    out.push(blockLines[0]!);
    out.push(`|${"---|".repeat(cells[0]!.length)}`);
    out.push(...blockLines.slice(1));
    origin.push(start + 1, start + 1);
    blockLines.slice(1).forEach((_, at) => origin.push(start + at + 2));
    count++;
  }
  return { lines: out, count, origin };
}

/** Any heading with a trailing `（N）` count loses it. */
function stripCounts(lines: string[]): { lines: string[]; count: number } {
  let count = 0;
  const fenced = fencedLines(lines);
  const out = lines.map((line, index) => {
    if (fenced[index] || !/^#{1,6} /.test(line)) return line;
    const next = line.replace(/[ \t]*[（(]\s*\d+\s*[）)]\s*$/, "");
    if (next !== line) count++;
    return next;
  });
  return { lines: out, count };
}

export function adopt(src: string): AdoptResult {
  const decisions: Decision[] = [];
  const changes: string[] = [];
  const original = src.replace(/^﻿/, "").replaceAll("\r\n", "\n").split("\n");
  if (original.at(-1) === "") original.pop();

  // A ledger that already passes `check` has nothing mechanical left to do.
  // Re-running the conversion on it used to delete an empty `## 附录` and
  // reject the empty TEMPLATE.md as "not a ledger".
  const precheck = checkLedger(src, "");
  // W220 (a status outside the vocabulary) is the one warning adopt itself
  // reports on, so such a ledger still goes through the conversion.
  if (precheck.errors.length === 0 && !precheck.warnings.some(({ code }) => code === "W220")) {
    return { lines: original, decisions: [], changes: ["已是规范台账（check 0 error），无需转换"] };
  }

  // Mechanical rewrites first, so every later coordinate refers to the text
  // that will actually be written.
  const demoted = demoteHeadings(original);
  if (demoted.count > 0) changes.push(`正文 H4 → **加粗标签**：${demoted.count} 处`);
  const stripped = stripCounts(demoted.lines);
  if (stripped.count > 0) changes.push(`去掉标题里的（N）计数：${stripped.count} 处`);
  const separated = fixSeparators(stripped.lines);
  if (separated.count > 0) changes.push(`补表格分隔行：${separated.count} 处`);
  const lines = separated.lines;

  const sections = buildSections(scan(lines.join("\n")), lines.length);
  const h1 = sections.find((section) => section.level === 1);
  const title = h1?.title ?? "Issue 台账";
  const appendix = sections.find((section) => isCanonical(section, "附录"));
  const bodySection = sections.find((section) => isCanonical(section, "正文"));
  const annotated = sections.filter((section) =>
    section.level === 2 && KNOWN_SECTION.test(section.title) && canonicalName(section.title) !== section.title);
  if (annotated.length > 0) {
    changes.push(`规范小节标题去掉括注：${annotated.map((section) => `${section.title} → ${canonicalName(section.title)}`).join("，")}`);
  }

  // ---- rows ----------------------------------------------------------
  const blocks = pipeBlocks(lines, sections);
  const rows = rowsOf(blocks);
  // Lines that became table rows (plus their block's header/separator) are
  // the only input lines adopt is allowed to rewrite rather than copy.
  const rowLines = new Set(rows.map((row) => row.line));
  const consumedBlocks = blocks.filter((block) =>
    rows.some((row) => row.line >= block.line && row.line < block.line + block.length));
  const consumedBlockLines = new Set<number>();
  const layoutLines = new Set<number>();
  for (const block of consumedBlocks) {
    for (let at = 0; at < block.length; at++) {
      consumedBlockLines.add(block.line + at);
      const cells = block.cells[at]!;
      if (isSeparator(cells) || isHeader(cells)) layoutLines.add(block.line + at);
    }
  }
  // An empty canonical table (header + separator, no rows) is regenerated
  // too; a mixed file — canonical skeleton plus a legacy `## 待处理` table
  // (dogfood #52) — otherwise had both empty headers copied into 附录.
  for (const block of blocks) {
    if (consumedBlocks.includes(block) || !isTableSection(block.section)) continue;
    if (block.cells.every((cells) => isSeparator(cells) || isHeader(cells))) {
      for (let at = 0; at < block.length; at++) layoutLines.add(block.line + at);
    }
  }
  if (rows.length === 0) {
    throw Object.assign(
      new Error(
        "no issue rows to migrate (no table with a '#' column and issue ids); file left unchanged. " +
          "For a notes-only file, start from TEMPLATE.md and keep the prose under '## 附录'",
      ),
      { code: "no-rows" },
    );
  }
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.idText) ?? [];
    group.push(row);
    groups.set(row.idText, group);
  }

  const open: Row[] = [];
  const closed: Row[] = [];
  for (const [idText, group] of groups) {
    // Rows are merged field by field, not row by row: cafe's index keeps the
    // status, its closed table keeps the criteria, and neither copy alone has
    // both. The index copy (outside 已关闭) is authoritative for status, since
    // that is the table people edit; the closed table fills in the criteria.
    const closedSection = group.find((row) => isClosedSection(row.section));
    const indexCopy = group.find((row) => !isClosedSection(row.section));
    const withStatus =
      indexCopy?.status != null && STATUS_WORDS.has(indexCopy.status)
        ? indexCopy
        : group.find((row) => row.status != null && STATUS_WORDS.has(row.status));
    const status = withStatus?.status;
    const category = status
      ? STATUS_CLASSES[status as keyof typeof STATUS_CLASSES]
      : closedSection
        ? "closed"
        : "open";
    const merged: Row = {
      ...group[0]!,
      idText,
      status,
      // The summary follows the table the issue ends up in: a closed issue
      // keeps the closed table's wording, one that stays open the index's.
      summary: ((category === "closed" ? closedSection : indexCopy) ?? group[0]!).summary || group[0]!.summary,
      // Every distinct criterion survives: closed-table copy first (that is
      // where criteria live), then the others.
      criteria: [...new Set([closedSection, ...group].filter((row): row is Row => row != null)
        .map((row) => row.criteria).filter((value) => value !== ""))].join("；"),
      extras: [...new Set(group.map((row) => row.extras).filter((value) => value !== ""))].join("；"),
      priority: indexCopy?.priority || (group.find((row) => row.priority !== "")?.priority ?? ""),
    };
    const priorities = [...new Set(group.map((row) => row.priority).filter((value) => value !== ""))];

    const declared = group.find((row) => row.status != null && !STATUS_WORDS.has(row.status))?.status;
    if (declared != null) {
      decisions.push({
        kind: "unknown-status",
        id: idText,
        line: group[0]!.line,
        message: `状态「${declared}」不在词表里；按 ${category} 处理，需人工确认`,
      });
    } else if (status == null) {
      // A row with no status column and no status-named group is the other way
      // to invent a status by accident: say so instead of writing 已修/未决
      // silently.
      // 未分类 is the vocabulary's word for "unknown". 已修 claims a fix
      // nobody made: a ruling like 不是缺陷 must never read as fixed.
      const assumed = category === "closed" ? "未分类" : "未决";
      decisions.push({
        kind: "unknown-status",
        id: idText,
        line: group[0]!.line,
        message: `这一行没有声明状态；暂按「${assumed}」处理，需人工确认`,
      });
    }
    if (group.length > 1) {
      const declaredStatuses = [...new Set(group.map((row) => row.status).filter((value) => value != null))];
      const where = new Set(group.map((row) => row.section)).size > 1
        ? "在多张表里各有一行"
        : `在同一张表里有 ${group.length} 行`;
      // Only one summary survives; every other wording is named here so the
      // merge never loses text silently. The closed-vs-index pair of a closed
      // issue is reported (with both texts) as closed-title-conflict below.
      const coveredByConflict = (row: Row) =>
        category === "closed" && closedSection != null && !isClosedSection(row.section);
      const dropped = [...new Set(
        group.filter((row) => !coveredByConflict(row) && row.summary !== "" && fold(row.summary) !== fold(merged.summary))
          .map((row) => row.summary),
      )];
      decisions.push({
        kind: "duplicate-row",
        id: idText,
        line: group[1]!.line,
        message:
          `#${idText} ${where}；已按字段合并（状态与优先级取索引，各处不同的判据都保留，以「；」连接）` +
          (dropped.length > 0
            ? `；摘要取「${merged.summary}」，未采用：${dropped.map((text) => `「${text}」`).join("、")}`
            : "") +
          (declaredStatuses.length > 1
            ? `；两处状态矛盾（${declaredStatuses.join(" / ")}），需人工确认`
            : "") +
          (priorities.length > 1 ? `；优先级不一致（${priorities.join(" / ")}），采用 ${merged.priority}` : ""),
      });
    }
    if (merged.ids.length > 1) {
      decisions.push({
        kind: "multi-id-row",
        id: idText,
        line: merged.line,
        message: `一格多号（${idText}）；已原样保留，需要逐条操作时用 issuemd split FILE ${idText.split(/[,，、\s]+/)[0]} 拆行`,
      });
    }
    if (/[–~-]/.test(idText)) {
      decisions.push({ kind: "id-range", id: idText, line: merged.line, message: `编号区间（${idText}）；已原样保留` });
      // An older ledger may also carry an explicit row for an id inside the
      // range. That is E103 in the canonical format, so name it here rather
      // than letting the final check refuse the whole conversion blind.
      // Only a single numeric range counts, and only bare ids overlap it:
      // `8a` is a different issue from `8`, and `3, 7–20` is not low = 3.
      const idSpans = parseIds(idText);
      const range = idSpans?.length === 1 && idSpans[0]!.start !== idSpans[0]!.end ? idSpans[0]! : undefined;
      for (const [otherId, otherGroup] of range ? groups : []) {
        if (otherId === idText) continue;
        const other = parseId(otherId);
        if (!other || other.suffix !== "") continue;
        if (other.start < range!.start || other.start > range!.end) continue;
        decisions.push({
          kind: "id-range",
          id: otherId,
          line: otherGroup[0]!.line,
          message: `#${otherId} 已被区间 ${idText} 覆盖；规范化后是 E103，需要人工删掉其中一行`,
        });
      }
    }

    if (category === "closed") closed.push({ ...merged, status: status ?? "未分类" });
    else open.push({ ...merged, status: status ?? "未决" });

    // A closed-table summary that differs from the index summary is the
    // "third copy" drift the spec measured at 60/61.
    if (category === "closed" && closedSection) {
      const indexCopy = group.find((row) => !isClosedSection(row.section));
      if (indexCopy && fold(indexCopy.summary) !== fold(closedSection.summary)) {
        decisions.push({
          kind: "closed-title-conflict",
          id: idText,
          line: closedSection.line,
          message: "已关闭表摘要与索引摘要不一致；默认采用已关闭表的摘要",
          table: indexCopy.summary,
          body: closedSection.summary,
        });
      }
    }
  }
  if (rows.length !== groups.size) changes.push(`合并重复表行：${rows.length - groups.size} 行`);

  // ---- bodies --------------------------------------------------------
  const bodies = bodyHeadings(sections);
  // Keyed by the full id text (`2` vs `2a`), not the numeric part.
  const bodyById = new Map(bodies.map((body) => [body.idText, body]));
  const isMultiId = (row: Row) => row.ids.length > 1 || /[–~-]/.test(row.idText);
  for (const row of open) {
    const body = bodyById.get(fullId(row));
    if (!body) {
      // A multi-id row never gets a generated body (there is no single id to
      // hang it on), so claiming a skeleton was added would be a lie.
      if (!isMultiId(row)) {
        decisions.push({
          kind: "missing-body",
          id: row.idText,
          line: row.line,
          message: "索引有行、没有正文块；已补一个只有标签的骨架",
        });
      }
      continue;
    }
    if (isMultiId(row)) continue;
    if (fold(row.summary) !== fold(body.title)) {
      decisions.push({
        kind: "open-title-conflict",
        id: row.idText,
        line: body.line,
        message: "表格摘要与正文标题不一致；默认按 --prefer=body 采用正文标题",
        table: row.summary,
        body: body.title,
      });
      row.summary = body.title;
    }
  }
  for (const row of closed) {
    const body = bodyById.get(fullId(row));
    if (!body) continue;
    decisions.push({
      kind: "closed-with-body",
      id: row.idText,
      line: body.line,
      message: "已关闭但仍有正文；判据提升进表，正文移入附录",
    });
    if (!row.criteria) row.criteria = criteriaOf(lines.slice(body.line, body.end)) ?? "";
  }
  // Progress detection reads the *table* summary. By the time this runs the
  // open rows may already carry the body title, which is the clean string and
  // by definition free of progress wording.
  const tableSummary = new Map([...groups].map(([id, group]) => [id, group[0]!.summary]));
  for (const row of [...open, ...closed]) {
    const summary = tableSummary.get(row.idText) ?? row.summary;
    if (PROGRESS.test(summary)) {
      decisions.push({
        kind: "progress-text",
        id: row.idText,
        line: row.line,
        message: "摘要含进展词；建议移进正文（--move-progress）或明确丢弃（--drop-progress）",
      });
    }
  }
  const tableSectionLines = new Set(blocks.map((block) => block.line));
  for (const section of sections) {
    if (section.level !== 3 || /^Issue\s/.test(section.title)) continue;
    if (statusFromHeading(section.title)) continue;
    // Only group headings that actually introduce table rows are table
    // structure; an H3 in 附录 is free prose.
    const introducesRows = [...tableSectionLines].some(
      (line) => line > section.line_start && line < section.line_end,
    );
    if (!introducesRows) continue;
    const ids = rows
      .filter((row) => row.line > section.line_start && row.line <= section.line_end)
      .map((row) => row.idText);
    decisions.push({
      kind: "unknown-group",
      line: section.line_start,
      message:
        `分组标题「${section.title}」不对应任何状态词；其下 ${ids.length} 行（${ids.join("、")}）` +
        "按行内状态处理，行内也没有的记为「未分类」，需人工确认",
    });
  }

  // ---- assemble ------------------------------------------------------
  const sortKey = (row: Row) => parseId(row.idText) ?? { start: row.firstId, end: row.firstId, suffix: "" };
  // Full ids, not the numeric part: `2` must precede `2a` (E105).
  const sortedOpen = [...open].sort((a, b) => compareIds(sortKey(a), sortKey(b)));
  const usedBodyIds = new Set<string>();
  // One body per id, sorted by full id across all rows (E105): an open row
  // `2, 30` needs bodies #2 and #30 (E102), on either side of #10's.
  const bodyEntries: { span: IdSpan; lines: string[] }[] = [];
  const MAX_EXPANDED = 1000;
  for (const row of open) {
    const spans = parseIds(row.idText) ?? [];
    const ids: IdSpan[] = [];
    for (const span of spans) {
      for (let n = span.start; n <= span.end && ids.length <= MAX_EXPANDED; n++) {
        ids.push({ start: n, end: n, suffix: span.start === span.end ? span.suffix : "" });
      }
    }
    if (ids.length === 0 || ids.length > MAX_EXPANDED) {
      decisions.push({
        kind: "id-range",
        id: row.idText,
        line: row.line,
        message: `开放的区间/多号行 ${row.idText} 超过 ${MAX_EXPANDED} 个编号，没有逐号生成正文；请先人工拆分或关闭`,
      });
      continue;
    }
    const multi = isMultiId(row);
    const skeletonIds: string[] = [];
    let leftoverReported = false;
    for (const span of ids) {
      const id = `${span.start}${span.suffix}`;
      const body = bodyById.get(id);
      if (body) usedBodyIds.add(body.idText);
      else if (multi) skeletonIds.push(id);
      if (multi && body && fold(body.title) !== fold(row.summary)) {
        decisions.push({
          kind: "open-title-conflict",
          id,
          line: body.line,
          message: `多号行 ${row.idText} 的每条正文标题必须等于行摘要；#${id} 的正文标题已改为行摘要，原标题留在正文开头的 **原正文标题**`,
          table: row.summary,
          body: body.title,
        });
      }
      const out = [`### Issue ${id}: ${row.summary}`, ""];
      // The heading must carry the row summary; the old title stays as text.
      const retitled = multi && body != null && fold(body.title) !== fold(row.summary);
      if (retitled) out.push(`**原正文标题**：${body!.title}`, "");
      // `body.line` is the heading itself; the slice starts one line later.
      const content = body
        ? trimBlankEdges(dropStatusLabels(lines.slice(body.line, body.end), decisions, id, body.line))
        : ["**现象**：", "", "**根因**：", "", "**期望**：", "", `**验收判据**：${row.criteria}`];
      // The index has no criteria column. Criteria (or extra columns) an open
      // row carried in the old table go into its body instead of vanishing.
      // Extra columns are never 验收判据: a later `close` would promote them.
      const leftover = [
        body && row.criteria !== "" && !content.some((line) => line.includes(row.criteria)) ? row.criteria : "",
        row.extras,
      ].filter((value) => value !== "").join("；");
      if (leftover !== "") {
        content.push("", `**原表格判据**：${leftover}`);
        if (!leftoverReported) {
          decisions.push({
            kind: "extra-columns",
            id: row.idText,
            line: row.line,
            message: "开放项的表格里带有判据/附加列；已追加到正文末尾的 **原表格判据**，请人工合并",
          });
          leftoverReported = true;
        }
      }
      bodyEntries.push({ span, lines: [...out, ...content, ""] });
    }
    if (skeletonIds.length > 0) {
      decisions.push({
        kind: "missing-body",
        id: row.idText,
        line: row.line,
        message: `多号行里 ${skeletonIds.map((id) => `#${id}`).join("、")} 没有正文块；已各补一个只有标签的骨架`,
      });
    }
  }
  const bodyOut = bodyEntries.sort((a, b) => compareIds(a.span, b.span)).flatMap((entry) => entry.lines);

  const archived = closed.filter((row) => bodyById.has(fullId(row)));
  // Anything adopt does not recognize is kept verbatim in 附录 rather than
  // dropped: the tool may decline to decide, but it must not lose text.
  // A section only counts as "converted" when it actually supplied rows — an
  // H2 called `Open questions` is prose, not a table, despite the word.
  const rowSections = new Set(rows.map((row) => row.section));
  const preservedLines = new Set<number>();
  const foreignOut: string[] = [];
  const keep = (heading: string | undefined, content: string[], line: number, message: string) => {
    const body = neutralizePreserved(content);
    if (heading) foreignOut.push(...neutralizePreserved([heading]), "");
    foreignOut.push(...body, "");
    decisions.push(
      heading
        ? { kind: "foreign-section", line, anchor: heading, message }
        : { kind: "foreign-section", line, anchor: body[0], message },
    );
  };
  // A foreign H1's subtree contains the canonical H2s; copying them would
  // duplicate 正文 or a converted table. Carve those out of the copy.
  const excludedSections = sections.filter(
    (section) => section.level === 2 &&
      (KNOWN_SECTION.test(section.title) ||
        (isTableSection(section.title) && rowSections.has(section.title))),
  );
  const excluded = (line: number) =>
    excludedSections.some((section) => line >= section.line_start && line <= section.line_end);
  let preservedSections = 0;
  for (const section of sections) {
    if (section.level !== 1 && section.level !== 2) continue;
    if (section.line_start === h1?.line_start) continue; // the H1 is regenerated
    if (section.level === 2 && KNOWN_SECTION.test(section.title)) continue;
    if (section.level === 2 && isTableSection(section.title) && rowSections.has(section.title)) continue;
    const heading = lines[section.line_start - 1]!;
    const content: string[] = [];
    for (let line = section.line_start + 1; line <= section.line_end; line++) {
      if (excluded(line)) continue;
      content.push(lines[line - 1]!);
      preservedLines.add(line);
    }
    keep(heading, trimBlankEdges(content), section.line_start,
      `未识别的小节「${section.title}」；原样移入附录`);
    preservedSections++;
  }
  // Inside a converted table section only the rows are data. Group notes
  // (`> owner 裁决：…`), narrative H3s (`### 第二十轮 diff 复核`) and tables
  // adopt could not map used to vanish with the rebuilt section; they are
  // copied to 附录 under their own heading instead.
  const sectionProseOut: string[] = [];
  let sectionProseCount = 0;
  const tableSections = sections.filter(
    (section) => section.level === 2 &&
      (isCanonical(section, "索引") || isCanonical(section, "已关闭") ||
        (isTableSection(section.title) && rowSections.has(section.title))),
  );
  // An `### Issue N:` block inside a table section is an issue body, not
  // prose: the body logic already puts it in 正文, an archive or the orphan
  // list. Copying it here as well would keep it twice (dogfood #50).
  const bodyStarts = new Set(bodies.map((body) => body.line));
  for (const section of tableSections) {
    const groups = sections.filter((candidate) =>
      candidate.level === 3 && candidate.line_start > section.line_start && candidate.line_start <= section.line_end);
    const starts = [section.line_start, ...groups.map((group) => group.line_start)];
    starts.forEach((start, at) => {
      const end = at + 1 < starts.length ? starts[at + 1]! - 1 : section.line_end;
      if (at > 0 && bodyStarts.has(start)) return;
      const content: string[] = [];
      for (let line = start + 1; line <= end; line++) {
        if (layoutLines.has(line) || rowLines.has(line)) continue;
        const text = lines[line - 1]!;
        // A non-row line left inside a converted block (a `| — | 无 |`
        // placeholder) can no longer form a table; escape it so it stays text.
        content.push(consumedBlockLines.has(line) ? `\\${text.trimStart()}` : text);
        preservedLines.add(line);
      }
      const kept = trimBlankEdges(content);
      if (kept.length === 0) return;
      const own = at === 0 ? undefined : groups[at - 1]!;
      const heading = own ? lines[own.line_start - 1]! : `### 「${section.title}」小节的说明`;
      sectionProseOut.push(...neutralizePreserved([heading]), "", ...neutralizePreserved(kept), "");
      sectionProseCount++;
      decisions.push({
        kind: "section-prose",
        line: start,
        anchor: neutralizePreserved([heading])[0],
        message: `「${section.title}${own ? ` › ${own.title}` : ""}」里表格行以外的内容（${kept.length} 行）；原样移入附录`,
      });
    });
  }
  // Front matter and prose that sits directly under the H1 are not part of
  // any section, so the loop above never sees them.
  const firstTop = sections.find((section) => section.level <= 2);
  const preambleEnd = firstTop ? firstTop.line_start - 1 : lines.length;
  const preamble = trimBlankEdges(lines.slice(0, preambleEnd))
    .filter((line) => !/^>\s*(?:唯一台账|读法：)/.test(line));
  if (preamble.length > 0) {
    foreignOut.push(...preamble, "");
    decisions.push({
      kind: "preamble",
      line: 1,
      anchor: preamble[0],
      message: "标题之前或与标题并列的说明文字；原样移入附录",
    });
  }
  // Prose directly inside 正文 (before/between issue bodies) and H3s that are
  // not `Issue N:` would otherwise vanish with the rebuilt 正文 section.
  if (bodySection) {
    const h3 = sections.filter(
      (section) => section.level === 3 && section.line_start > bodySection.line_start &&
        section.line_start <= bodySection.line_end,
    );
    const claimed = new Set<number>();
    for (const section of h3) {
      for (let line = section.line_start; line <= section.line_end; line++) claimed.add(line);
    }
    for (const section of h3) {
      if (/^Issue\s/.test(section.title)) continue;
      const heading = lines[section.line_start - 1]!;
      keep(heading, trimBlankEdges(lines.slice(section.line_start, section.line_end)), section.line_start,
        `正文里的非 Issue 小节「${section.title}」；原样移入附录`);
      for (let line = section.line_start + 1; line <= section.line_end; line++) preservedLines.add(line);
    }
    const prose: string[] = [];
    for (let line = bodySection.line_start + 1; line <= bodySection.line_end; line++) {
      if (!claimed.has(line)) prose.push(lines[line - 1]!);
    }
    const proseContent = trimBlankEdges(prose);
    if (proseContent.some((line) => line.trim() !== "")) {
      keep(undefined, proseContent, bodySection.line_start, "正文里不属于任何 Issue 的段落；原样移入附录");
    }
  }
  const appendixOut: string[] = [];
  if (appendix) {
    const existing = trimBlankEdges(lines.slice(appendix.line_start, appendix.line_end));
    if (existing.length > 0) appendixOut.push(...existing, "");
  }
  for (const row of archived) {
    const body = bodyById.get(fullId(row))!;
    usedBodyIds.add(body.idText);
    // Same format as `close --keep-body`, so check (W250), rename and
    // reopen treat an adopted archive exactly like one close wrote.
    appendixOut.push(archiveHeading(row.idText, row.summary), "", "> adopt 时保留了原正文；状态见「已关闭」表。", "");
    const content = trimBlankEdges(dropStatusLabels(lines.slice(body.line, body.end), decisions, row.idText, body.line));
    appendixOut.push(...(content.length ? content : ["（空）"]), KEPT_BODY_END, "");
  }
  // A body that lives inside preserved text is already copied with it; do not
  // archive a second copy.
  for (const body of bodies) {
    if (preservedLines.has(body.line)) usedBodyIds.add(body.idText);
  }
  const orphans = bodies.filter((body) => !usedBodyIds.has(body.idText));
  for (const body of orphans) {
    appendixOut.push(`### #${body.idText} ${body.title}（adopt 保留的孤立正文）`, "");
    const content = trimBlankEdges(dropStatusLabels(lines.slice(body.line, body.end), decisions, body.idText, body.line));
    appendixOut.push(...(content.length ? content : ["（空）"]), "");
    decisions.push({
      kind: "orphan-body",
      id: body.idText,
      line: body.line,
      message: `正文块 #${body.idText} 在表格里没有对应行（或多号行无法挂载）；已原样移入附录`,
    });
  }
  // Section prose comes before foreign sections, whose H2 would otherwise
  // adopt these H3s as children. Foreign sections go last: an H2 would end
  // 附录 and swallow the archived bodies, preamble and orphan text after it.
  appendixOut.push(...sectionProseOut, ...foreignOut);
  if (archived.length > 0) changes.push(`已关闭项的正文移入附录：${archived.length} 条`);
  if (preservedSections > 0) changes.push(`未识别的小节原样移入附录：${preservedSections} 处`);
  if (sectionProseCount > 0) changes.push(`表格小节里的说明文字/叙述小节移入附录：${sectionProseCount} 处`);

  // The H1's own prose (scope notes, criteria conventions) stays where it
  // was; the template blurb is only a default for a ledger without one.
  // Up to the first H2: an H3 directly under the H1 is header prose too.
  const afterH1 = h1 ? sections.find((section) => section.line_start > h1.line_start && section.level <= 2) : undefined;
  const headerOwn = h1
    ? trimBlankEdges(lines.slice(h1.line_start, (afterH1?.line_start ?? lines.length + 1) - 1))
    : [];
  const header = headerOwn.length > 0
    ? neutralizePreserved(headerOwn)
    : [
      "> 唯一台账 + 唯一正文。状态只在下表；正文不写状态。编号不回收。",
      "> 读法：`issuemd list <file>` / `issuemd show <file> <id>` / `issuemd check <file>`",
    ];
  if (headerOwn.length > 0) changes.push(`保留 H1 下的原有说明：${headerOwn.length} 行`);

  // Only the marker block is regenerated; the rest of 怎么用/状态口径
  // (writing conventions, command notes) is kept around it.
  const controlled = (name: string, begin: string, end: string) => {
    const section = sections.find((candidate) => isCanonical(candidate, name));
    if (!section) return { before: [] as string[], after: [] as string[], block: undefined };
    const fenced = fencedLines(lines);
    const inside = (target: string) => {
      for (let line = section.line_start + 1; line <= section.line_end; line++) {
        if (!fenced[line - 1] && lines[line - 1]!.trim() === target) return line;
      }
      return undefined;
    };
    const from = inside(begin);
    const to = inside(end);
    const own = (a: number, b: number) =>
      trimBlankEdges(lines.slice(a - 1, b).filter((text) => text.trim() !== begin && text.trim() !== end));
    const ordered = from != null && to != null && from < to;
    const before = ordered ? own(section.line_start + 1, from - 1) : [];
    const after = ordered ? own(to + 1, section.line_end) : own(section.line_start + 1, section.line_end);
    const kept = before.length + after.length;
    if (before.concat(after).some((text) => text.trim() !== "")) {
      decisions.push({
        kind: "kept-section-text",
        line: section.line_start,
        anchor: `## ${name}`,
        message: `「${name}」里受控块以外的文字（${kept} 行）已原样保留；如已过时请手动删改`,
      });
    }
    return { before, after, block: ordered ? { from: from!, to: to! } : undefined };
  };
  const guide = controlled("怎么用", "<!-- issuemd:guide:begin -->", "<!-- issuemd:guide:end -->");
  const statusText = controlled("状态口径", "<!-- issuemd:statuses:begin -->", "<!-- issuemd:statuses:end -->");
  const around = (part: string[]) => (part.length > 0 ? [...neutralizePreserved(part), ""] : []);
  changes.push("重写「怎么用」与「状态口径」受控块（块外文字保留）");
  if (bodySection) changes.push("正文块改为按编号升序");

  const out = [
    `# ${title}`,
    "",
    ...header,
    "",
    "## 怎么用",
    "",
    ...around(guide.before),
    "<!-- issuemd:guide:begin -->",
    ...guideBlockLines(),
    "<!-- issuemd:guide:end -->",
    "",
    ...around(guide.after),
    "## 状态口径",
    "",
    ...around(statusText.before),
    "<!-- issuemd:statuses:begin -->",
    ...statusBlockLines(),
    "<!-- issuemd:statuses:end -->",
    "",
    ...around(statusText.after),
    "## 索引",
    "",
    formatRow(["#", "状态", "P", "摘要"]),
    "|---|---|---|---|",
    ...sortedOpen.map((row) => formatRow([row.idText, row.status ?? "未决", row.priority, row.summary])),
    "",
    "## 已关闭",
    "",
    formatRow(["#", "状态", "P", "摘要", "判据"]),
    "|---|---|---|---|---|",
    ...closed.map((row) => formatRow([row.idText, row.status ?? "未分类", row.priority, row.summary,
      [row.criteria, row.extras].filter((value) => value !== "").join("；")])),
    "",
    "## 正文",
    "",
    ...bodyOut,
    // An existing (even empty) 附录 is kept: deleting it is not a mechanical fix.
    ...(appendixOut.length > 0 || appendix ? ["## 附录", "", ...appendixOut] : []),
  ];
  while (out.at(-1) === "") out.pop();

  // ---- conservation guard ---------------------------------------------
  // Every input line adopt did not deliberately consume must still be in the
  // output. This is the check that would have caught each silent loss found
  // in dogfooding (#41, #42, #49): refuse rather than write a smaller file.
  const regenerated = new Set<number>([...rowLines, ...layoutLines]);
  if (h1) regenerated.add(h1.line_start);
  for (const section of sections) {
    const inTable = tableSections.some((table) =>
      section.line_start > table.line_start && section.line_start <= table.line_end);
    if (section.level === 2 && (KNOWN_SECTION.test(section.title) || tableSections.includes(section))) {
      regenerated.add(section.line_start);
    }
    if (section.level === 3 && (inTable || /^Issue\s/.test(section.title))) regenerated.add(section.line_start);
  }
  for (const block of [guide.block, statusText.block]) {
    if (!block) continue;
    for (let line = block.from; line <= block.to; line++) regenerated.add(line);
  }
  const outSet = new Set(out);
  const lost: number[] = [];
  lines.forEach((text, index) => {
    if (text.trim() === "" || regenerated.has(index + 1)) return;
    if (/^\s*\*\*状态\*\*\s*[:：]/.test(text) || /^>\s*(?:唯一台账|读法：)/.test(text)) return;
    if (/^ {0,3}<!-- issuemd:(?:guide|statuses):(?:begin|end) -->\s*$/.test(text)) return;
    if (outSet.has(text) || outSet.has(neutralizePreserved([text])[0]!) || outSet.has(`\\${text.trimStart()}`)) return;
    lost.push(index + 1);
  });
  if (lost.length > 0) {
    const sample = lost.slice(0, 10)
      .map((line) => `  source L${separated.origin[line - 1] ?? line}: ${lines[line - 1]!.trim().slice(0, 80)}`)
      .join("\n");
    throw Object.assign(
      new Error(
        `refusing to convert: ${lost.length} input line(s) would not survive the conversion\n${sample}` +
          (lost.length > 10 ? `\n  … (${lost.length - 10} more)` : ""),
      ),
      { code: "lost-content" },
    );
  }

  // Every issue id the input tables held must be in the output tables too, and
  // the count goes into the report so a reviewer can see the check ran (#46).
  const idKeys = (cells: string[]) => {
    const keys = new Set<string>();
    for (const cell of cells) {
      for (const span of parseIds(cell) ?? []) {
        if (span.end - span.start > 100_000) return undefined;
        for (let n = span.start; n <= span.end; n++) keys.add(`${n}${span.suffix}`);
      }
    }
    return keys;
  };
  const before = idKeys(rows.map((row) => row.idText));
  const outLedger = parseLedger(out.join("\n"));
  const outCells = [...outLedger.rows.open, ...outLedger.rows.closed]
    .map((row) => row.ids.map((span) => span.start === span.end ? `${span.start}${span.suffix}` : `${span.start}–${span.end}`).join(", "));
  const after = idKeys(outCells);
  if (before && after) {
    const missing = [...before].filter((key) => !after.has(key));
    if (missing.length > 0) {
      throw Object.assign(
        new Error(`refusing to convert: ${missing.length} issue id(s) would disappear: ${missing.slice(0, 10).join(", ")}`),
        { code: "lost-content" },
      );
    }
    const keptLines = lines.filter((text, index) => text.trim() !== "" && !regenerated.has(index + 1)).length;
    changes.push(`守恒自检：issue ${before.size} → ${after.size}；表格行以外的 ${keptLines} 行原文都在输出里`);
  }

  // Decision line numbers were collected while scanning the *input*; report
  // them against the output instead, so `adopt --report` points at the file
  // the reader will actually open. Anything no longer locatable keeps 0.
  const located = decisions.map((decision) => {
    const hint = decision.body ?? decision.table ?? "";
    const id = decision.id ?? "";
    const pattern = id === "" ? undefined : new RegExp(`^\\|?\\s*${escapeRegExp(id)}\\s*\\|`);
    // Prefer the id row: a summary hint can match an unrelated row with a
    // similar title. The hint is only a fallback for decisions without an id.
    const byRow = pattern ? out.findIndex((line) => pattern.test(line)) : -1;
    const byAnchor = decision.anchor != null ? out.findIndex((line) => line === decision.anchor) : -1;
    const index = byRow >= 0
      ? byRow
      : byAnchor >= 0
        ? byAnchor
        : hint !== ""
          ? out.findIndex((line) => line.includes(hint))
          : -1;
    // A conflict is best reported where the *body* heading now sits, not on
    // the table row that happens to hold the chosen string.
    // `pattern` was built for `| id |` table rows; a body heading is matched
    // by its own `### Issue <id>:` prefix instead.
    const bodyIndex = decision.kind.startsWith("open-title") && id !== ""
      ? out.findIndex((line) => line.startsWith(`### Issue ${id}:`))
      : decision.kind === "orphan-body" && id !== ""
        ? out.findIndex((line) => line.startsWith(`### #${id} `))
        : -1;
    const line = bodyIndex >= 0 ? bodyIndex : index;
    const sourceLine = decision.line > 0 ? separated.origin[decision.line - 1] ?? decision.line : undefined;
    return line >= 0 ? { ...decision, line: line + 1, sourceLine } : { ...decision, line: 0, sourceLine };
  });
  return { lines: out, decisions: located, changes };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");