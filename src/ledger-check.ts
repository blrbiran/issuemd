import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { compareIds, idText, IdSet, parseId, type IdSpan } from "./issue-id.js";
import { parseLedger, type Diagnostic, type LedgerRow, type TableKind } from "./ledger.js";
import { ARCHIVE_HEADING, labelName } from "./ledger-edit.js";

import { STATUS_CLASSES } from "./statuses.js";
export { STATUS_CLASSES };
/** Priorities `new` accepts and `check` knows; "" means "not prioritised". */
export const PRIORITIES: readonly string[] = ["P0", "P1", "P2", "P3", ""];
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
    if (/[（(]\d+[）)]\s*$/.test(title)) {
      errors.push({ code: "E121", line, message: "Heading contains a count; use a stable title" });
    }
    const inBody = line > body.line_start && line <= body.line_end;
    const issue = level === 3 ? /^Issue\s+([^:\s]+)\s*:\s*(.*)$/.exec(title) : null;
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

function checkBodies(ledger: Ledger, openEntries: RowId[], ids: Record<TableKind, IdSet>) {
  const { lines, visible, errors, warnings } = ledger;
  const { body, bodies } = checkHeadings(ledger);
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
    if (row && foldWhitespace(row.summary) !== foldWhitespace(title)) {
      errors.push({ code: "E106", line, id, message: "Body title and index summary differ", expected: row.summary, actual: title });
    }
    const labels = new Set<string>();
    for (let current = line + 1; current <= end; current++) {
      if (!visible.has(current)) continue;
      // `**X：**` followed by text is too often inline Q/A emphasis to count;
      // alone on its line it is the colon-inside form of a label.
      const label = /^ {0,3}\*\*([^*]+)\*\*(?:\s*[:：]|\s*$)/.exec(lines[current - 1]);
      if (!label) continue;
      const name = labelName(label[1]);
      if (labels.has(name)) warnings.push({ code: "W206", line: current, id, message: `Duplicate body label: ${name}` });
      labels.add(name);
    }
    if (end - line > 300 || Buffer.byteLength(lines.slice(line, end).join("\n")) > 20 * 1024) {
      warnings.push({ code: "W201", line, id, message: "Issue body exceeds 300 lines or 20 KiB" });
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
const PROGRESS = /已落地|仍缺|仍无|仍逐|仍走/;

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
      if (kind === "open" && PROGRESS.test(row.summary)) {
        warnings.push({ ...info, code: "W260", message: "Move progress text from the summary into the body" });
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
function checkAppendix(ledger: Ledger) {
  const { lines, visible, sections, warnings, rows } = ledger;
  const appendix = sections.find((section) => section.level === 2 && section.title === "附录");
  if (!appendix) return;
  const single = (kind: TableKind, id: string) =>
    rows[kind].find((row) => row.ids.length === 1 && idText(row.ids[0]) === id);
  // A second copy of one issue's body in 附录: an escaped `\### Issue N:`
  // (older adopt copied table-section bodies twice, dogfood #50) or a repeated
  // archive. The first archive of an open issue is W252's business.
  const seen = new Map<string, number>();
  const duplicate = (line: number, id: string, archive: boolean) => {
    const copies = (seen.get(id) ?? 0) + 1;
    seen.set(id, copies);
    const others = copies - 1 + (single("open", id) ? 1 : 0);
    if (others > 0 && (!archive || copies > 1)) {
      warnings.push({ code: "W253", line, id, message: "Another copy of this issue's body already exists (body, archive or escaped copy in 附录)" });
    }
  };
  for (let line = appendix.line_start + 1; line <= appendix.line_end; line++) {
    if (!visible.has(line)) continue;
    const escaped = /^\\#{1,6}[ \t]+Issue[ \t]+(\d+[a-z]?)[ \t]*:/.exec(lines[line - 1]);
    if (escaped) duplicate(line, escaped[1], false);
    const match = ARCHIVE_HEADING.exec(lines[line - 1]);
    if (!match) continue;
    duplicate(line, match[1], true);
    const [, id, summary] = match;
    warnings.push({ code: "W250", line, id, message: "Issue body kept in 附录 by close --keep-body" });
    const closedRow = single("closed", id);
    if (closedRow && foldWhitespace(closedRow.summary) !== foldWhitespace(summary)) {
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

/** Normalised summary for duplicate detection: width, case and spacing folded. */
export const summaryKey = (text: string) => text.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

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

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function checkHashes(ledger: Ledger, file: string, verify: boolean) {
  // Where a hash is *meant* to be: the closed table's 判据 column records the
  // commit that closed an issue (GLOSSARY: "a test count, a commit, …").
  // Those are verified by --verify-commits but are not "pinned" (W202).
  const closedLines = new Set(ledger.rows.closed.map((row) => row.line));
  // The last cell, raw (escaped pipes intact), so it can be cut out exactly.
  const lastCell = (line: string): [string, string] => {
    const trimmed = line.trimEnd();
    const end = trimmed.endsWith("|") ? trimmed.length - 1 : trimmed.length;
    let start = end - 1;
    while (start >= 0 && !(trimmed[start] === "|" && trimmed[start - 1] !== "\\")) start--;
    return [trimmed.slice(start + 1, end), trimmed.slice(0, start + 1)];
  };
  const hashes = new Map<string, { line: number; pinned: boolean }>();
  const collect = (text: string, line: number, pinned: boolean) => {
    for (const match of text.replace(UUID, " ").matchAll(/\b[0-9a-f]{7,40}\b/g)) {
      // Dates, millisecond timestamps and other plain numbers are not pinned
      // hashes. An all-digit run is only treated as a commit at full SHA-1
      // length; in between, `20261124` and `1732406400000` are far more
      // common than an all-numeric short hash.
      if (!/[a-f]/.test(match[0]) && match[0].length !== 40) continue;
      const known = hashes.get(match[0]);
      if (!known) hashes.set(match[0], { line, pinned });
      else if (pinned && !known.pinned) hashes.set(match[0], { line, pinned });
    }
  };
  ledger.lines.forEach((line, index) => {
    if (!ledger.visible.has(index + 1)) return;
    if (closedLines.has(index + 1)) {
      const [criteria, rest] = lastCell(line);
      collect(criteria, index + 1, false);
      collect(rest, index + 1, true);
    } else {
      collect(line, index + 1, true);
    }
  });
  if (hashes.size === 0) return;
  for (const [hash, { line, pinned }] of hashes) {
    if (pinned) ledger.warnings.push({ code: "W202", line, message: `Possible pinned commit hash: ${hash}` });
  }
  if (!verify) return;
  const hashesToCheck = [...hashes.keys()];
  const result = spawnSync("git", ["cat-file", "--batch-check=%(objecttype)"], {
    cwd: file === "-" ? process.cwd() : dirname(resolve(file)),
    input: hashesToCheck.map((hash) => `${hash}^{commit}\n`).join(""),
    encoding: "utf8", env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error("git cat-file could not verify commits in the ledger directory");
  const objects = result.stdout.split(/\r?\n/);
  for (const [index, hash] of hashesToCheck.entries()) {
    if (objects[index] !== "commit") {
      ledger.warnings.push({ code: "W240", line: hashes.get(hash)!.line, message: `Commit not found: ${hash}` });
    }
  }
}

export function checkLedger(src: string, file: string, options: Options = {}) {
  const ledger = parseLedger(src);
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

  if (!errors.some(({ code }) => code === "E120")) {
    checkStatusBlock(ledger);
    checkDuplicateIds(open, "open", errors);
    checkDuplicateIds(closed, "closed", errors);
    for (const { span, row } of closed) {
      const overlap = ids.open.firstOverlap(span);
      if (overlap !== undefined) {
        errors.push({ code: "E104", line: row.line, id: idText({ ...span, start: overlap }), message: "ID appears in both tables" });
      }
    }
    checkBodies(ledger, open, ids);
    checkRows(ledger, ids);
    checkDuplicateSummaries(ledger);
    checkAppendix(ledger);
    checkGuide(ledger);
    checkHashes(ledger, file, options.verifyCommits ?? false);
  }
  const compare = (a: Diagnostic, b: Diagnostic) => a.line - b.line || a.code.localeCompare(b.code);
  errors.sort(compare);
  warnings.sort(compare);
  // W250 records a deliberate `--keep-body` archive, not a defect. Failing
  // `--strict` on it would leave every ledger that used the escape hatch
  // permanently red, so it is reported but does not affect `ok`.
  const strictFailures = warnings.filter(({ code }) => code !== "W250");
  return { file, counts, errors, warnings, ok: errors.length === 0 && (!options.strict || strictFailures.length === 0) };
}
