import { inlineCodeRanges, multilineInlineCodeRanges } from "./scan.js";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { compareIds, idText, IdSet, parseId, type IdSpan } from "./issue-id.js";
import { archiveInventory, hiddenArchiveReason, locateArchivePayload, archivePayloadRange, bodyBlocks, countSuffix, effectiveLimits, type EffectiveLimits, highWaterRecords, limitsRecords, maxIssueId, parseLedger, ISSUE_HEADING, type Diagnostic, type LedgerRow, type TableKind } from "./ledger.js";
import { hashSpans } from "./hash-scan.js";
import { matchProgressCue } from "./progress-matcher.js";
import { missingProseReferences } from "./ledger-search.js";
import { ARCHIVE_HEADING, bodyLabels, bodyVisibility, criteriaBoundaryHints, criteriaLabelHint, criteriaOccurrencesFromLabelBlocks, criteriaTextFromOccurrences, fencedLines, labelBlocksIn, unescapeCell } from "./ledger-edit.js";
import { scanFences } from "./scan.js";

import { STATUS_CLASSES } from "./statuses.js";
export { STATUS_CLASSES };
/** Priorities `new` accepts and `check` knows; "" means "not prioritised". */
export const PRIORITIES: readonly string[] = ["P0", "P1", "P2", "P3", ""];
/**
 * Advisory warnings: they have a mechanical exit (or are guarded by close /
 * prune) and must not make a long-lived ledger permanently fail `--strict`.
 */
export const STRICT_EXEMPT_WARNINGS: ReadonlySet<string> = new Set(["W201", "W202", "W250", "W264"]);
const STATUS_LINES = [
  "| 状态 | 分类 |", "|---|---|",
  ...Object.entries(STATUS_CLASSES).map(([status, kind]) => `| ${status} | ${kind} |`),
];

type Ledger = ReturnType<typeof parseLedger>;
type Options = { strict?: boolean; verifyCommits?: boolean };
type RowId = { span: IdSpan; row: LedgerRow };
const flatten = (rows: LedgerRow[]): RowId[] => rows.flatMap((row) => row.ids.map((span) => ({ span, row })));

function checkDuplicateIds(entries: RowId[], kind: TableKind, errors: Diagnostic[]) {
  const rightmost = new Map<string, number>();
  for (const { span, row } of [...entries].sort((a, b) => compareIds(a.span, b.span) || a.row.line - b.row.line)) {
    const end = rightmost.get(span.suffix) ?? 0;
    if (span.start <= end) {
      errors.push({ code: "E103", line: row.line, id: idText(span), message: `Duplicate ID in ${kind} table` });
    }
    rightmost.set(span.suffix, Math.max(end, span.end));
  }
}

function checkHeadings(ledger: Ledger) {
  const { sections, errors } = ledger;
  const body = sections.find((section) => section.level === 2 && section.title === "正文")!;
  const bodies: { id: IdSpan; title: string; line: number; end: number }[] = [];
  for (const section of sections) {
    const { level, title, line_start: line } = section;
    const inBody = line > body.line_start && line <= body.line_end;
    const issue = level === 3 ? ISSUE_HEADING.exec(title) : null;
    if (!inBody) {
      if (level === 3 && /^Issue(?:\s|$)/.test(title)) {
        errors.push({ code: "E123", line, message: "Issue headings belong in 正文" });
      }
      continue;
    }
    if (!issue) {
      errors.push({ code: "E110", line, message: "Only Issue headings are allowed in 正文; use bold labels for sections" });
      continue;
    }
    const id = parseId(issue[1]);
    if (!id) {
      errors.push({ code: "E109", line, message: `Invalid issue ID: ${issue[1]}` });
      continue;
    }
    bodies.push({ id, title: issue[2], line, end: section.line_end });
  }
  const headingLines = new Set(sections.map(({ line_start }) => line_start));
  for (let line = body.line_start + 2; line <= body.line_end; line++) {
    if (!ledger.visible.has(line) || !ledger.visible.has(line - 1) || headingLines.has(line - 1)) continue;
    const text = ledger.lines[line - 2];
    // A Setext underline follows a single-line paragraph on the immediately
    // preceding line. An indented line only starts a paragraph when the line
    // above it is blank; otherwise it is a list continuation (its `---` is a
    // thematic break). A blank line, ATX heading, or block starter ends the
    // paragraph.
    const unindented = /^\S/.test(text);
    const indented = /^ {1,3}\S/.test(text) &&
      (line <= 2 || (ledger.lines[line - 3] ?? "").trim() === "");
    const paragraph = (unindented || indented) &&
      !/^ {0,3}(?:[>|<]|[-*+]\s|\d+[.)]\s|(?:-+|=+|\*{3,}|_{3,})\s*$)/.test(text);
    if (paragraph && /^ {0,3}(?:-+|=+)[ \t]*$/.test(ledger.lines[line - 1])) {
      errors.push({ code: "E110", line: line - 1, message: "Setext headings are not allowed in 正文" });
    }
  }
  return { body, bodies };
}

function checkStatusBlock(ledger: Ledger) {
  const { lines, sections, visible, errors } = ledger;
  const status = sections.find((section) => section.level === 2 && section.title === "状态口径");
  if (!status) return;
  const begin: number[] = [];
  const end: number[] = [];
  for (let line = status.line_start + 1; line <= status.line_end; line++) {
    if (!visible.has(line)) continue;
    const text = lines[line - 1];
    if (text === "<!-- issuemd:statuses:begin -->") begin.push(line);
    if (text === "<!-- issuemd:statuses:end -->") end.push(line);
  }
  if (begin.length !== 1 || end.length !== 1 || end[0] <= begin[0] ||
      lines.slice(begin[0], end[0] - 1).join("\n") !== STATUS_LINES.join("\n")) {
    errors.push({ code: "E112", line: begin[0] ?? status.line_start, message: "状态口径 block must match the canonical status table" });
  }
}

/**
 * W201: one issue body is longer than the ledger's limits. Only the
 * dimensions that actually exceed are named; a bare "exceeds limits" left
 * users unable to tell whether to shorten, split, or raise the limit (#118).
 */
function ignoredFenceLines(
  lines: string[],
  masks: { fenced: boolean[]; comments: boolean[]; rawHtml: boolean[] },
  startLine: number,
  count: number,
): boolean[] {
  let hiddenFence: { char: string; length: number } | undefined;
  return Array.from({ length: count }, (_, index) => {
    const absoluteIndex = startLine + index - 1;
    const line = lines[absoluteIndex] ?? "";
    const delimiter = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/.exec(line);
    if (hiddenFence && delimiter && delimiter[1]![0] === hiddenFence.char &&
        delimiter[1]!.length >= hiddenFence.length && /^[ \t]*$/.test(delimiter[2]!)) {
      hiddenFence = undefined;
      return true;
    }
    const htmlHidden = masks.comments[absoluteIndex] || masks.rawHtml[absoluteIndex];
    if (htmlHidden && masks.fenced[absoluteIndex] && delimiter &&
        !(delimiter[1]!.startsWith("`") && delimiter[2]!.includes("`"))) {
      hiddenFence = { char: delimiter[1]![0]!, length: delimiter[1]!.length };
    }
    return !!htmlHidden;
  });
}

function checkBodySize(
  lines: string[],
  line: number,
  end: number,
  limits: EffectiveLimits,
  id: string | undefined,
  warnings: Diagnostic[],
  diagnosticLine = line,
  subject = "Issue body",
  finalNewline = false,
): void {
  const lineCount = end - line;
  const byteCount = Buffer.byteLength(lines.slice(line, end).join("\n")) + (lineCount > 0 && finalNewline ? 1 : 0);
  if (lineCount <= limits.bodyLines && byteCount <= limits.bodyBytes) return;
  const over: string[] = [];
  if (byteCount > limits.bodyBytes) {
    over.push(`${byteCount} UTF-8 bytes (limit ${limits.bodyBytes})`);
  }
  if (lineCount > limits.bodyLines) over.push(`${lineCount} lines (limit ${limits.bodyLines})`);
  warnings.push({ code: "W201", line: diagnosticLine, ...(id != null ? { id } : {}), message: `${subject} exceeds limits: ${over.join(", ")}` });
}

function checkBodies(ledger: Ledger, openEntries: RowId[], ids: Record<TableKind, IdSet>, limits: EffectiveLimits) {
  const { lines, visible, errors, warnings } = ledger;
  const { body, bodies } = checkHeadings(ledger);
  const markdownMasks = archiveInventory(ledger).masks;
  const byId = new Map<string, LedgerRow>();
  const ranges: RowId[] = [];
  for (const entry of openEntries) {
    if (entry.span.start === entry.span.end) byId.set(idText(entry.span), entry.row);
    else ranges.push(entry);
  }
  const bodyIds = new Set<string>();
  let previous: IdSpan | undefined;
  for (const entry of bodies) {
    const { id: span, line, title, end } = entry;
    const id = idText(span);
    if (bodyIds.has(id) || (previous && compareIds(previous, span) >= 0)) {
      errors.push({ code: "E105", line, id, message: "Body issue IDs must be unique and strictly increasing" });
    }
    previous = span;
    bodyIds.add(id);
    if (ids.closed.has(span)) {
      errors.push({ code: "E111", line, id, message: "Closed issue still has a body" });
    } else if (!ids.open.has(span)) {
      errors.push({ code: "E101", line, id, message: "Body has no index row" });
    }
    const row = byId.get(id) ?? (!span.suffix ? ranges.find(({ span: range }) => range.start <= span.start && span.start <= range.end)?.row : undefined);
    // `\|` in a heading renders as `|`, like the escaped cell it must match.
    if (row && foldWhitespace(row.summary) !== foldWhitespace(unescapeCell(title))) {
      errors.push({ code: "E106", line, id, message: "Body title and index summary differ", expected: row.summary, actual: title });
    }
    const bodyLines = lines.slice(line - 1, end);
    const ignored = ignoredFenceLines(lines, markdownMasks, line, bodyLines.length);
    const unclosedFence = scanFences(bodyLines, true, ignored).unclosed;
    if (unclosedFence) warnings.push({
      code: "W270", line: line + unclosedFence.line - 1, id,
      message: "Unclosed fenced code block; close it before modifying this issue section (close --keep-body and reopen refuse while the fence is unclosed)",
    });
    const fenced = fencedLines(bodyLines, true);
    const labelLines = new Map<string, number[]>();
    for (const { label: name, line: current } of bodyLabels(bodyLines, 2, bodyLines.length, fenced)) {
      // Bold Q/A dialogue is readable through show --label but is not a field
      // schema; repeated turns are not duplicate ledger labels.
      if (name === "Q" || name === "A") continue;
      const positions = labelLines.get(name) ?? [];
      positions.push(current);
      labelLines.set(name, positions);
    }
    for (const [name, positions] of labelLines) {
      if (positions.length < 2) continue;
      const locations = positions.map((current) => `L${line + current - 1}`).join(", ");
      for (const current of positions.slice(1)) {
        warnings.push({ code: "W206", line: line + current - 1, id, message: `Duplicate body label: ${name}; occurrences at ${locations}` });
      }
    }
    const visibility = bodyVisibility(bodyLines, fenced);
    const sourceBlocks = labelBlocksIn(bodyLines, 2, bodyLines.length, fenced, visibility);
    for (const hint of criteriaBoundaryHints(bodyLines, line - 1, fenced, visibility, sourceBlocks)) {
      warnings.push({
        code: "W268", line: hint.line, id,
        message: `L${hint.line}: ${hint.detail}. Mark review notes with **复核记录**： or close with --status S and reviewed --criteria TEXT, or use --keep-body`,
      });
    }
    checkBodySize(lines, line, end, limits, id, warnings);
    // An open issue whose body has no non-empty 验收判据 can never be closed
    // (`close --criteria-from-body` refuses it), so a bare `new` skeleton or a
    // deleted criteria block leaves an open item that is not verifiable at
    // all (dogfood #62). Closed rows keep criteria in their table column and
    // are deliberately not judged here.
    const occurrences = criteriaOccurrencesFromLabelBlocks(sourceBlocks, line - 1);
    const criteria = criteriaTextFromOccurrences(occurrences);
    if (ids.open.has(span) && !criteria) {
      const hint = criteriaLabelHint(bodyLines, line - 1, fenced);
      warnings.push({
        code: "W261", line: hint?.line ?? line, id,
        message: "Open issue has no non-empty **验收判据**; `close --criteria-from-body` will refuse it" +
          (hint ? `. ${hint.message}` : ""),
      });
    } else if (ids.open.has(span)) {
      for (const occurrence of occurrences) {
        if (occurrence.kind !== "supplement" || occurrence.alreadyCovered) continue;
        warnings.push({
          code: "W264", line: occurrence.line, id,
          message: `Possible additional criteria block is not included in the canonical criteria: L${occurrence.line}: review **${occurrence.label}**. ` +
            "Merge it into **验收判据** (renaming it would create a duplicate label), close with --keep-body, or pass reviewed --criteria TEXT",
        });
      }
    }
  }
  for (let line = body.line_start + 1; line <= body.line_end; line++) {
    if (visible.has(line) && /^ {0,3}\*\*状态\*\*/.test(lines[line - 1])) {
      errors.push({ code: "E107", line, message: "Status belongs in the table" });
    }
  }
  const inOrder = [...bodies].sort((a, b) => compareIds(a.id, b.id));
  const firstMissing = (span: IdSpan): number | undefined => {
    if (span.start === span.end) return bodyIds.has(idText(span)) ? undefined : span.start;
    // A range covers integers only. Skip a contiguous run of body IDs even
    // when the input range contains billions of missing IDs.
    let low = 0;
    let high = inOrder.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (inOrder[mid].id.start < span.start) low = mid + 1;
      else high = mid;
    }
    let next = span.start;
    for (let i = low; i < inOrder.length && next <= span.end; i++) {
      const id = inOrder[i].id;
      if (id.start > next) break;
      if (!id.suffix && id.start === next) next++;
    }
    return next <= span.end ? next : undefined;
  };
  for (const { span, row } of openEntries) {
    const missing = firstMissing(span);
    if (missing !== undefined) {
      errors.push({ code: "E102", line: row.line, id: idText({ ...span, start: missing }), message: "Index ID has no body" });
    }
  }
}

const foldWhitespace = (text: string) => text.trim().replace(/\s+/g, " ");

function checkRows(ledger: Ledger, ids: Record<TableKind, IdSet>) {
  const { rows, errors, warnings } = ledger;
  for (const kind of ["open", "closed"] as const) {
    for (const row of rows[kind]) {
      const id = idText(row.ids[0]);
      const info = { line: row.line, id };
      const category = Object.hasOwn(STATUS_CLASSES, row.status) ? STATUS_CLASSES[row.status as keyof typeof STATUS_CLASSES] : undefined;
      if (!PRIORITIES.includes(row.priority)) {
        warnings.push({ ...info, code: "W221", message: `Undeclared priority: ${row.priority} (expected P0–P3 or empty)` });
      }
      if (!category) warnings.push({ ...info, code: "W220", message: `Undeclared status: ${row.status}` });
      else if (category !== kind) errors.push({ ...info, code: "E112", message: `Status ${row.status} belongs in the ${category} table` });
      const progress = kind === "open" ? matchProgressCue(row.summary) : undefined;
      if (progress) {
        warnings.push({
          ...info,
          code: "W260",
          cue: progress.cue,
          column: progress.column,
          message: `Move progress text from the summary into the body (matched ${JSON.stringify(progress.cue)} at column ${progress.column})`,
        });
      }
      if (kind === "closed" && row.status === "并入") {
        const target = parseId(/#(\d+[a-z]?)\b/.exec(row.criteria)?.[1] ?? "");
        if (!target || (!ids.open.has(target) && !ids.closed.has(target))) {
          warnings.push({ ...info, code: "W210", message: "Merge target is missing from the ledger" });
        }
      }
    }
  }
}

/**
 * `close --keep-body` archives a body under `## 附录` as a plain heading
 * `### #N <summary>（已关闭，正文保留）`. That keeps 附录 free of `Issue N:`
 * headings (E123) while still recording where the text came from. The archive
 * heading is the only way `check` can tell a kept body apart from prose, so it
 * is what W250 keys on. Fenced lookalikes are not data.
 */
function checkAppendix(ledger: Ledger, limits: EffectiveLimits) {
  const { lines, warnings, rows } = ledger;
  const inventory = archiveInventory(ledger);
  const { appendices, archives, hiddenArchives, masks } = inventory;
  for (const candidate of hiddenArchives) {
    warnings.push({ code: "W269", line: candidate.line, id: candidate.id, message: hiddenArchiveReason(candidate) });
  }
  const isVisible = (line: number) => ledger.visible.has(line) && !masks.rawHtml[line - 1] && !masks.comments[line - 1];
  if (appendices.length > 1) {
    for (const appendix of appendices) warnings.push({
      code: "W266", line: appendix.line_start,
      message: `Duplicate ## 附录 heading (${appendices.length} found); resolve the ambiguity before reading the section or writing archives`,
    });
  }
  const archiveByLine = new Map(archives.map((archive) => [archive.section.line_start, archive] as const));
  const single = (kind: TableKind, id: string) =>
    rows[kind].find((row) => row.ids.length === 1 && idText(row.ids[0]) === id);
  const seen = new Map<string, number>();
  const duplicate = (line: number, id: string, archive: boolean) => {
    const copies = (seen.get(id) ?? 0) + 1;
    seen.set(id, copies);
    const others = copies - 1 + (single("open", id) ? 1 : 0);
    if (others > 0 && (!archive || copies > 1)) {
      warnings.push({ code: "W253", line, id, message: "Another copy of this issue's body already exists (body, archive or escaped copy in 附录)" });
    }
  };
  for (const appendix of appendices) {
    const appendixLines = lines.slice(appendix.line_start, appendix.line_end);
    const ignored = ignoredFenceLines(lines, masks, appendix.line_start + 1, appendixLines.length);
    for (const { section } of archives.filter(({ appendix: owner }) => owner.line_start === appendix.line_start)) {
      const located = locateArchivePayload(ledger, section, masks);
      if (!located.range || located.range.version === "legacy") continue;
      for (let line = section.line_start; line <= located.range.framingEnd; line++) {
        ignored[line - appendix.line_start - 1] = true;
      }
    }
    const unclosedFence = scanFences(appendixLines, true, ignored).unclosed;
    if (unclosedFence) warnings.push({
      code: "W270", line: appendix.line_start + unclosedFence.line,
      message: "Unclosed fenced code block; close the fence before modifying this appendix section",
    });
  }
  for (const appendix of appendices) {
    for (let line = appendix.line_start + 1; line <= appendix.line_end; line++) {
      if (!isVisible(line)) continue;
      const escaped = /^\\#{1,6}[ \t]+Issue[ \t]+(\d+[a-z]?)[ \t]*:/.exec(lines[line - 1]);
      if (escaped) duplicate(line, escaped[1], false);
      const archive = archiveByLine.get(line);
      if (!archive) continue;
      const match = ARCHIVE_HEADING.exec(lines[line - 1]);
      if (!match) continue;
      const id = archive.id;
      const summary = match[2]!;
      duplicate(line, id, true);
      warnings.push({ code: "W250", line, id, message: "Issue body kept in 附录 by close --keep-body; remove with 'issuemd prune FILE ID' when reopen is no longer needed (verified v2/v3 archives only)" });
      const located = locateArchivePayload(ledger, archive.section, masks);
      if (located.refusal?.recognized) warnings.push({
        code: "W269", line: located.refusal.line, id,
        message: `Malformed kept-body archive: ${located.refusal.reason}`,
      });
      if (located.range) {
        const range = located.range;
        checkBodySize(lines, range.start - 1, range.end, limits, id, warnings, line, "Archived body", range.finalNewline);
      }
      const closedRow = single("closed", id);
      if (closedRow && foldWhitespace(closedRow.summary) !== foldWhitespace(unescapeCell(summary))) {
        warnings.push({
          code: "W251", line, id, message: "Archive heading summary differs from the closed table",
          expected: closedRow.summary, actual: summary,
        });
      }
      if (single("open", id)) {
        warnings.push({ code: "W252", line, id, message: "Archive kept for an issue that is open again; reopen normally restores it" });
      }
    }
  }
}


function checkGuide(ledger: Ledger) {
  const { lines, visible, sections, warnings } = ledger;
  const guide = sections.find((section) => section.level === 2 && section.title === "怎么用");
  if (!guide) return;
  const headings = new Set(sections.map(({ level, title }) => `${"#".repeat(level)} ${title}`));
  for (let line = guide.line_start + 1; line <= guide.line_end; line++) {
    if (!visible.has(line)) continue;
    for (const match of lines[line - 1].matchAll(/`(#{1,6} [^`]+)`/g)) {
      if (!headings.has(match[1])) warnings.push({ code: "W203", line, message: `Guide refers to missing heading: ${match[1]}` });
    }
  }
}

/**
 * Normalised summary for duplicate detection: width and case folded, and every
 * whitespace character removed. A retried `new` almost always retypes the
 * title (`导出 CSV 丢空行` / `导出CSV丢空行`); folding spaces to one space let
 * those slips through (case 65). Chinese titles never carry meaning in a
 * space, and an English title written without its spaces is not a different
 * issue, so dropping them is the honest equivalence class.
 */
export const summaryKey = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");

/**
 * Two rows with the same summary are almost always one issue recorded twice
 * (a retried `new`, two agents filing the same thing). `new` cannot know, so
 * `check` makes the duplicate visible instead of letting it pass (W212).
 */
function checkDuplicateSummaries(ledger: Ledger) {
  const seen = new Map<string, LedgerRow>();
  // Open rows only: a duplicate that was closed (并入, 撤回…) is resolved,
  // and closed history legitimately repeats summaries.
  for (const row of [...ledger.rows.open].sort((a, b) => a.line - b.line)) {
    if (row.ids.length !== 1 || row.ids[0].start !== row.ids[0].end) continue;
    const key = summaryKey(row.summary);
    if (key === "") continue;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, row);
      continue;
    }
    ledger.warnings.push({
      code: "W212", line: row.line, id: idText(row.ids[0]),
      message: `Same summary as #${idText(first.ids[0])}: possibly a duplicate issue`,
    });
  }
}

function checkHashes(ledger: Ledger, file: string, verify: boolean) {
  // Where a hash is *meant* to be: the closed table's 判据 column records the
  // commit that closed an issue (GLOSSARY: "a test count, a commit, …").
  // Those are verified by --verify-commits but are not "pinned" (W202).
  const closedLines = new Set(ledger.rows.closed.map((row) => row.line));
  const lastCellRange = (line: string): [number, number] => {
    const trimmed = line.trimEnd();
    const end = trimmed.endsWith("|") ? trimmed.length - 1 : trimmed.length;
    let start = end - 1;
    while (start >= 0 && !(trimmed[start] === "|" && trimmed[start - 1] !== "\\")) start--;
    return [start + 1, end];
  };
  const verification = new Map<string, { line: number; pinned: boolean }>();
  const w202: { line: number; column: number; id?: string; hash: string }[] = [];
  const fullFences = fencedLines(ledger.lines, true);
  const multilineCode = multilineInlineCodeRanges(ledger.lines, fullFences);
  const archivePayloadLines = new Set<number>();
  for (const { section } of archiveInventory(ledger).archives) {
    const range = archivePayloadRange(ledger, section, fullFences);
    if (!range) continue;
    for (let line = range.start; line <= range.end; line++) archivePayloadLines.add(line);
  }
  const openIds = new IdSet(ledger.rows.open.flatMap((row) => row.ids));
  const closedIds = new IdSet(ledger.rows.closed.flatMap((row) => row.ids));
  const bodyOwners: { start: number; end: number; id: string }[] = [];
  for (const block of bodyBlocks(ledger)) {
    const id = `${block.id.start}${block.id.suffix}`;
    if (!openIds.has(block.id) || closedIds.has(block.id)) continue;
    bodyOwners.push({ start: block.line, end: block.end, id });
  }
  let bodyOwnerIndex = 0;
  ledger.lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (!ledger.visible.has(lineNo)) return;
    const codeRanges = inlineCodeRanges(line);
    const criteriaRange = closedLines.has(lineNo) ? lastCellRange(line) : undefined;
    for (const span of hashSpans(line)) {
      const inCode = codeRanges.some(([start, end]) => span.start > start && span.start < end) ||
        (multilineCode.get(index) ?? []).some(([start, end]) => span.start >= start && span.end <= end);
      const inClosedCriteria = criteriaRange != null && span.start >= criteriaRange[0] && span.end <= criteriaRange[1];
      const pinned = !inCode && !inClosedCriteria;
      const known = verification.get(span.hash);
      if (!known) verification.set(span.hash, { line: lineNo, pinned });
      else if (pinned && !known.pinned) verification.set(span.hash, { line: lineNo, pinned: true });
      if (!pinned || inCode || fullFences[index] || archivePayloadLines.has(lineNo)) continue;
      const column = Array.from(line.slice(0, span.start)).length + 1;
      while (bodyOwnerIndex < bodyOwners.length && lineNo > bodyOwners[bodyOwnerIndex]!.end) bodyOwnerIndex++;
      const bodyOwner = bodyOwners[bodyOwnerIndex];
      const id = bodyOwner && lineNo > bodyOwner.start && lineNo <= bodyOwner.end ? bodyOwner.id : undefined;
      w202.push({ line: lineNo, column, ...(id ? { id } : {}), hash: span.hash });
    }
  });
  for (const occurrence of w202) {
    ledger.warnings.push({
      code: "W202", line: occurrence.line, column: occurrence.column,
      ...(occurrence.id ? { id: occurrence.id } : {}),
      message: `Possible pinned commit hash: ${occurrence.hash}`,
    });
  }
  if (!verify || verification.size === 0) return;
  const hashesToCheck = [...verification.keys()];
  const cwd = file === "-" ? process.cwd() : dirname(resolve(file));
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
  const repository = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd, encoding: "utf8", env,
  });
  if (repository.error) throw new Error(`git rev-parse could not inspect the ledger directory: ${repository.error.message}`);
  if (repository.status !== 0 || repository.stdout.trim() !== "true") {
    if (repository.status !== 0 && !/not a git repository/i.test(repository.stderr)) {
      throw new Error("git rev-parse could not determine whether the ledger directory is a Git worktree");
    }
    const firstLine = verification.get(hashesToCheck[0]!)!.line;
    ledger.warnings.push({
      code: "W263",
      line: firstLine,
      message: "Commit verification skipped: the ledger directory is not a Git repository",
    });
    return;
  }
  const result = spawnSync("git", ["cat-file", "--batch-check=%(objecttype)"], {
    cwd,
    input: hashesToCheck.map((hash) => `${hash}^{commit}\n`).join(""),
    encoding: "utf8", env,
  });
  if (result.status !== 0) throw new Error("git cat-file could not verify commits in the ledger directory");
  const objects = result.stdout.split(/\r?\n/);
  for (const [index, hash] of hashesToCheck.entries()) {
    if (objects[index] !== "commit") {
      ledger.warnings.push({ code: "W240", line: verification.get(hash)!.line, message: `Commit not found: ${hash}` });
    }
  }
}

export function checkLedger(src: string, file: string, options: Options = {}) {
  return checkParsedLedger(parseLedger(src), file, options);
}

/** Validate the same parsed snapshot a read command uses for its view. */
export function checkParsedLedger(parsed: Ledger, file: string, options: Options = {}) {
  const ledger = {
    ...parsed,
    errors: parsed.errors.map((diagnostic) => ({ ...diagnostic })),
    warnings: parsed.warnings.map((diagnostic) => ({ ...diagnostic })),
  };
  const { rows, errors, warnings } = ledger;
  const open = flatten(rows.open);
  const closed = flatten(rows.closed);
  const ids = {
    open: new IdSet(open.map(({ span }) => span)),
    closed: new IdSet(closed.map(({ span }) => span)),
  };
  const byStatus = new Map<string, IdSpan[]>();
  for (const { span, row } of [...open, ...closed]) {
    const group = byStatus.get(row.status) ?? [];
    group.push(span);
    byStatus.set(row.status, group);
  }
  const safeCount = (count: bigint, label: string): number | null => {
    if (count <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(count);
    errors.push({ code: "E109", line: 1, message: `${label} count exceeds the supported integer range` });
    return null;
  };
  const counts = {
    open: safeCount(ids.open.count, "Open"),
    closed: safeCount(ids.closed.count, "Closed"),
    byStatus: Object.fromEntries([...byStatus].map(([status, spans]) => [status, safeCount(new IdSet(spans).count, status)])),
  };

  // A heading's count is judged even when the canonical section it was meant
  // to name is missing: `## 已关闭（3）` must report E120 (no section) *and*
  // E121 (count). The E120 guard below used to hide the count entirely
  // (round 14 black-box finding). An `Issue 2: （3）` heading is judged on its
  // title alone, as new/rename and adopt judge it.
  for (const { title, line_start: line } of ledger.sections) {
    if (countSuffix(/^Issue\s+[^:\s]+\s*:\s*(.*)$/.exec(title)?.[1] ?? title)) {
      errors.push({ code: "E121", line, message: "Heading contains a count; use a stable title" });
    }
  }

  if (!errors.some(({ code }) => code === "E120")) {
    const limits = effectiveLimits(ledger);
    checkStatusBlock(ledger);
    checkDuplicateIds(open, "open", errors);
    checkDuplicateIds(closed, "closed", errors);
    for (const { span, row } of closed) {
      const overlap = ids.open.firstOverlap(span);
      if (overlap !== undefined) {
        errors.push({ code: "E104", line: row.line, id: idText({ ...span, start: overlap }), message: "ID appears in both tables" });
      }
    }
    checkBodies(ledger, open, ids, limits);
    checkRows(ledger, ids);
    checkDuplicateSummaries(ledger);
    checkAppendix(ledger, limits);
    checkGuide(ledger);
    for (const { id, line, start } of missingProseReferences(parsed)) {
      warnings.push({ code: "W271", id, line, column: Array.from(parsed.lines[line - 1]!.slice(0, start)).length + 1,
        message: `Prose references #${id}, which is not tracked in this ledger. This ID is reserved against reuse here`,
      });
    }
    const highWater = highWaterRecords(ledger);
    if (highWater.length > 1 || highWater.some((record) => record.value == null)) {
      warnings.push({
        code: "W265",
        line: highWater[0]?.line ?? 1,
        message: "Allocation high-water metadata is malformed or duplicated; repair the preamble marker",
      });
    } else if (highWater[0] && highWater[0].value! > maxIssueId(ledger.rows, ledger.unreadable)) {
      const maximum = maxIssueId(ledger.rows, ledger.unreadable);
      warnings.push({
        code: "W265",
        line: highWater[0].line,
        id: String(highWater[0].value),
        message: `Allocation high-water mark ${highWater[0].value} exceeds the current highest issue id ${maximum}; a historical row may have been removed`,
      });
    }
    checkHashes(ledger, file, options.verifyCommits ?? false);
    const limitsRecordsFound = limitsRecords(ledger);
    if (limitsRecordsFound.length > 1 || limitsRecordsFound.some((record) => record.problem)) {
      warnings.push({
        code: "W267",
        line: limitsRecordsFound[0]?.line ?? 1,
        message: "The ledger limits marker is malformed or duplicated; default limits (20 KiB / 300 lines) are in effect",
      });
    }
  }
  const compare = (a: Diagnostic, b: Diagnostic) => a.line - b.line || a.code.localeCompare(b.code);
  errors.sort(compare);
  warnings.sort(compare);
  // W250 records a deliberate `--keep-body` archive, not a defect. Failing
  // `--strict` on it would leave every ledger that used the escape hatch
  // permanently red, so it is reported but does not affect `ok`.
  const strictFailures = warnings.filter(({ code }) => !STRICT_EXEMPT_WARNINGS.has(code));
  return { file, counts, errors, warnings, ok: errors.length === 0 && (!options.strict || strictFailures.length === 0) };
}
