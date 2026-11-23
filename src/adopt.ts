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
import { splitCells } from "./ledger.js";
import { parseIds } from "./issue-id.js";
import { STATUS_CLASSES } from "./ledger-check.js";
import { formatRow, guideBlockLines, statusBlockLines } from "./ledger-edit.js";

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
  | "missing-body";

export type Decision = {
  kind: DecisionKind;
  id?: string;
  line: number;
  message: string;
  table?: string;
  body?: string;
};

export type AdoptResult = {
  lines: string[];
  decisions: Decision[];
  /** Human-readable mechanical changes, for the report header. */
  changes: string[];
};

type Mapping = { id: number; status?: number; priority?: number; summary: number; criteria?: number };

type Row = {
  line: number;
  idText: string;
  firstId: number;
  ids: number[];
  status?: string;
  priority: string;
  summary: string;
  criteria: string;
  /** The H2 section the row was found in, used to infer its table. */
  section: string;
};

const STATUS_WORDS = new Set(Object.keys(STATUS_CLASSES));
/** A `## 已关闭`-style section, whatever it is exactly called. */
const isClosedSection = (title: string) => /已关闭|closed/i.test(title);
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

function mappingFor(header: string[] | undefined, width: number): Mapping | undefined {
  if (header) {
    const index = (name: string) => header.findIndex((cell) => cell === name);
    const id = index("#");
    const summary = index("摘要") >= 0 ? index("摘要") : index("标题");
    if (id >= 0 && summary >= 0) {
      return {
        id,
        status: index("状态") >= 0 ? index("状态") : undefined,
        priority: index("P") >= 0 ? index("P") : index("优先级") >= 0 ? index("优先级") : undefined,
        summary,
        criteria: index("判据") >= 0 ? index("判据") : undefined,
      };
    }
  }
  // Header-less blocks: width decides. `# | 摘要 | 判据` is the orca shape.
  if (width === 3) return { id: 0, summary: 1, criteria: 2 };
  if (width === 5) return { id: 0, status: 1, priority: 2, summary: 3, criteria: 4 };
  if (width === 4) return { id: 0, status: 1, priority: 2, summary: 3 };
  return undefined;
}

type Block = {
  line: number;
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
      const h3 = sections
        .filter((s) => s.level === 3 && s.line_start < start && s.line_start > (h2?.line_start ?? 0))
        .at(-1);
      out.push({
        line: start,
        cells: block.cells,
        mapping,
        groupStatus: h3 ? statusFromHeading(h3.title) : undefined,
        section: h2?.title ?? "",
      });
    }
    block = undefined;
  };
  lines.forEach((text, index) => {
    if (/^ {0,3}\|/.test(text)) {
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
      const status = declared && STATUS_WORDS.has(declared) ? declared : block.groupStatus;
      out.push({
        line: block.line + index,
        idText,
        firstId: ids[0]!,
        ids,
        status,
        priority: (mapping.priority != null ? cells[mapping.priority] : "")?.trim() ?? "",
        summary: (cells[mapping.summary] ?? "").trim(),
        criteria: (mapping.criteria != null ? cells[mapping.criteria] : "")?.trim() ?? "",
        section: block.section,
      });
    });
  }
  return out;
}

type Body = { idText: string; id: number; title: string; line: number; end: number };

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

/** `#### 现象` inside a body becomes `**现象**`; H3 is the issue heading. */
function demoteHeadings(lines: string[]): { lines: string[]; count: number } {
  let count = 0;
  const out = lines.map((line) => {
    const match = /^(#{4,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!match) return line;
    count++;
    return `**${match[2]}**`;
  });
  return { lines: out, count };
}

/** Add the missing separator row to each header-less block, once per block. */
function fixSeparators(lines: string[]): { lines: string[]; count: number } {
  const out: string[] = [];
  let count = 0;
  let index = 0;
  while (index < lines.length) {
    if (!/^ {0,3}\|/.test(lines[index]!)) {
      out.push(lines[index]!);
      index++;
      continue;
    }
    const start = index;
    while (index < lines.length && /^ {0,3}\|/.test(lines[index]!)) index++;
    const blockLines = lines.slice(start, index);
    const cells = blockLines.map((text) => splitCells(text));
    // A block whose second row is a separator is already well-formed.
    if (cells[1] && isSeparator(cells[1])) {
      out.push(...blockLines);
      continue;
    }
    out.push(blockLines[0]!);
    out.push(`|${"---|".repeat(cells[0]!.length)}`);
    out.push(...blockLines.slice(1));
    count++;
  }
  return { lines: out, count };
}

/** Any heading with a trailing `（N）` count loses it. */
function stripCounts(lines: string[]): { lines: string[]; count: number } {
  let count = 0;
  const out = lines.map((line) => {
    if (!/^#{1,6} /.test(line)) return line;
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
  const appendix = sections.find((section) => section.level === 2 && section.title === "附录");
  const bodySection = sections.find((section) => section.level === 2 && section.title === "正文");

  // ---- rows ----------------------------------------------------------
  const blocks = pipeBlocks(lines, sections);
  const rows = rowsOf(blocks);
  if (rows.length === 0) {
    throw Object.assign(
      new Error("no issue rows found; this does not look like a ledger, nothing to adopt"),
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
    // both.
    const withStatus = group.find((row) => row.status != null && STATUS_WORDS.has(row.status));
    const status = withStatus?.status;
    const closedSection = group.find((row) => isClosedSection(row.section));
    const category = status
      ? STATUS_CLASSES[status as keyof typeof STATUS_CLASSES]
      : closedSection
        ? "closed"
        : "open";
    const merged: Row = {
      ...group[0]!,
      idText,
      status,
      summary: (closedSection ?? group[0]!).summary || group[0]!.summary,
      criteria: group.reduce((best, row) => (row.criteria.length > best.length ? row.criteria : best), ""),
      priority: group.find((row) => row.priority !== "")?.priority ?? "",
    };

    const declared = group.find((row) => row.status != null && !STATUS_WORDS.has(row.status))?.status;
    if (declared != null) {
      decisions.push({
        kind: "unknown-status",
        id: idText,
        line: group[0]!.line,
        message: `状态「${declared}」不在词表里；按 ${category} 处理，需人工确认`,
      });
    }
    if (group.length > 1) {
      decisions.push({
        kind: "duplicate-row",
        id: idText,
        line: group[1]!.line,
        message: `#${idText} 在多张表里各有一行；已按字段合并（状态取自索引，判据取自已关闭表）`,
      });
    }
    if (merged.ids.length > 1) {
      decisions.push({
        kind: "multi-id-row",
        id: idText,
        line: merged.line,
        message: `一格多号（${idText}）；已原样保留`,
      });
    }
    if (/[–~-]/.test(idText)) {
      decisions.push({ kind: "id-range", id: idText, line: merged.line, message: `编号区间（${idText}）；已原样保留` });
    }

    if (category === "closed") closed.push({ ...merged, status: status ?? "已修" });
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
  const bodyById = new Map(bodies.map((body) => [body.id, body]));
  for (const row of open) {
    const body = bodyById.get(row.firstId);
    if (!body) {
      decisions.push({
        kind: "missing-body",
        id: row.idText,
        line: row.line,
        message: "索引有行、没有正文块；已补一个只有标签的骨架",
      });
      continue;
    }
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
    const body = bodyById.get(row.firstId);
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
    decisions.push({
      kind: "unknown-group",
      line: section.line_start,
      message: `分组标题「${section.title}」不对应任何状态词；其下的行需要人工分类`,
    });
  }

  // ---- assemble ------------------------------------------------------
  const sortedOpen = [...open].sort((a, b) => a.firstId - b.firstId);
  const bodyOut: string[] = [];
  for (const row of sortedOpen) {
    const body = bodyById.get(row.firstId);
    bodyOut.push(`### Issue ${row.idText}: ${row.summary}`, "");
    // `body.line` is the heading itself; the slice starts one line later.
    const slice = body ? lines.slice(body.line, body.end) : [];
    while (slice.length > 0 && slice[0]!.trim() === "") slice.shift();
    while (slice.length > 0 && slice.at(-1)!.trim() === "") slice.pop();
    const content = body ? slice : ["**现象**：", "", "**根因**：", "", "**期望**：", "", "**验收判据**：", ""];
    bodyOut.push(...content, "");
  }

  const archived = closed.filter((row) => bodyById.has(row.firstId));
  const appendixOut: string[] = [];
  if (appendix) {
    const existing = lines.slice(appendix.line_start, appendix.line_end);
    while (existing.length > 0 && existing[0]!.trim() === "") existing.shift();
    while (existing.length > 0 && existing.at(-1)!.trim() === "") existing.pop();
    if (existing.length > 0) appendixOut.push(...existing, "");
  }
  for (const row of archived) {
    const body = bodyById.get(row.firstId)!;
    appendixOut.push(`### #${row.idText} ${row.summary}（adopt 保留的已关闭正文）`, "");
    const content = lines.slice(body.line, body.end).filter((line) => line.trim() !== "");
    appendixOut.push(...(content.length ? content : ["（空）"]), "");
  }
  if (archived.length > 0) changes.push(`已关闭项的正文移入附录：${archived.length} 条`);
  changes.push("重写「怎么用」与「状态口径」受控块");
  if (bodySection) changes.push("正文块改为按编号升序");

  const out = [
    `# ${title}`,
    "",
    "> 唯一台账 + 唯一正文。状态只在下表；正文不写状态。编号不回收。",
    "> 读法：`issuemd list <file>` / `issuemd show <file> <id>` / `issuemd check <file>`",
    "",
    "## 怎么用",
    "",
    "<!-- issuemd:guide:begin -->",
    ...guideBlockLines(),
    "<!-- issuemd:guide:end -->",
    "",
    "## 状态口径",
    "",
    "<!-- issuemd:statuses:begin -->",
    ...statusBlockLines(),
    "<!-- issuemd:statuses:end -->",
    "",
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
    ...closed.map((row) => formatRow([row.idText, row.status ?? "已修", row.priority, row.summary, row.criteria])),
    "",
    "## 正文",
    "",
    ...bodyOut,
    ...(appendixOut.length > 0 ? ["## 附录", "", ...appendixOut] : []),
  ];
  while (out.at(-1) === "") out.pop();

  return { lines: out, decisions, changes };
}