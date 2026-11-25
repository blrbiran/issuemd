/**
 * Read-only views over a parsed ledger: the rows `list` prints, the single
 * issue `show` renders, and the counted summary `counts` emits.
 *
 * Everything here is pure and derived from `parseLedger`; no command in this
 * module writes to disk.
 */

import type { IdSpan } from "./issue-id.js";
import { bodyBlocks, parseLedger, type LedgerRow, type TableKind } from "./ledger.js";
import { fencedLines, labelBlock, labelName, type LabelBlock, extractCriteria } from "./ledger-edit.js";
import { STATUS_CLASSES } from "./ledger-check.js";

export type ListedIssue = {
  /** The id cell as written: `7`, `20, 24, 29`, `7–20`. */
  id: string;
  /** Each id or range in the cell, spelled as the table spells it. */
  ids: string[];
  /** How many issues the row stands for (`7–20` is 14); `counts` sums these. */
  count: number;
  status: string;
  priority: string;
  summary: string;
  criteria?: string;
  /** `--with-body`: where `criteria` came from (open: the body; closed: the column). */
  criteriaSource?: "body" | "table";
  /** `--with-body`: the id whose body supplied labels/criteria when it is a sibling's. */
  bodyFrom?: string;
  /** `--with-body`: every body label, one-line form (same as `show --json`). */
  labels?: Record<string, string>;
};

/** Render a span the way the table spells it: `7`, `393b`, or `7–20`. */
export function spanText(span: IdSpan): string {
  return span.start === span.end ? `${span.start}${span.suffix}` : `${span.start}–${span.end}`;
}

/** True when `id` is one of the numbers a row cell's span covers. */
function covers(span: IdSpan, id: IdSpan): boolean {
  return span.suffix === id.suffix && span.start <= id.start && id.start <= span.end;
}

export function filterRows(
  rows: LedgerRow[],
  opts: { status?: string; priority?: string },
): LedgerRow[] {
  return rows.filter(
    (row) =>
      (opts.status == null || row.status === opts.status) &&
      (opts.priority == null || row.priority === opts.priority),
  );
}

/** `20, 24, 29` — every id in a row, spelled the way the cell spells them. */
export function rowIds(row: LedgerRow): string {
  return row.ids.map(spanText).join(", ");
}

/** `2  未决  P1  侧栏宽度不可调`; an empty priority reads as `-`. */
export function formatIssueRow(row: LedgerRow): string {
  return [rowIds(row), row.status, row.priority || "-", row.summary].join("  ");
}

/** Text form of one `list` entry; closed rows carry their criteria. */
export function formatListedIssue(issue: ListedIssue): string {
  const cells = [issue.id, issue.status, issue.priority || "-", issue.summary];
  if (issue.count > 1) cells.push(`(${issue.count} ids)`);
  if (issue.criteria) cells.push(`判据: ${issue.criteria}`);
  return cells.join("  ");
}

/** `--expand`: one entry per id. Undefined when that would be absurdly long. */
export function expandIssues(issues: ListedIssue[], limit = 100_000): ListedIssue[] | undefined {
  const out: ListedIssue[] = [];
  for (const issue of issues) {
    for (const spelled of issue.ids) {
      const range = /^(\d+)–(\d+)$/.exec(spelled);
      // Size first: building a 900-million-entry array just to count it
      // crashed the process (probe 11).
      if (range && Number(range[2]) - Number(range[1]) + 1 + out.length > limit) return undefined;
      const ids = range
        ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, at) => String(Number(range[1]) + at))
        : [spelled];
      for (const id of ids) {
        out.push({ ...issue, id, ids: [id], count: 1 });
        if (out.length > limit) return undefined;
      }
    }
  }
  return out;
}

export function toListedIssue(row: LedgerRow, table: TableKind): ListedIssue {
  const issue: ListedIssue = {
    id: rowIds(row),
    ids: row.ids.map(spanText),
    count: row.ids.reduce((sum, span) => sum + (span.end - span.start + 1), 0),
    status: row.status,
    priority: row.priority,
    summary: row.summary,
  };
  if (table === "closed") issue.criteria = row.criteria;
  return issue;
}

/**
 * `list --json --with-body`: attach the body facts `show --json` exposes, from
 * one parse of the file. Without it a batch analysis of 60 open issues meant
 * 60 `show` calls and 60 snapshots that could disagree (dogfood #67).
 * Resolution matches `viewIssue`: the row's first addressable id, then any
 * body the row owns; `bodyFrom` says when it is a sibling's.
 */
export function withBody(
  ledger: ReturnType<typeof parseLedger>,
  issue: ListedIssue,
  blocks = bodyBlocks(ledger),
): ListedIssue {
  if (issue.criteria != null) return { ...issue, criteriaSource: "table" }; // closed rows carry their own column
  const first = issue.ids[0];
  if (!first) return issue;
  const row = findRow(ledger, first);
  if (!row || row.table !== "open") return issue;
  const key = (span: IdSpan) => `${span.start}${span.suffix}`;
  const exact = blocks.find((candidate) => key(candidate.id) === row.id);
  // A range row (`5–7`) may keep its body under an interior id; a comma row
  // under any of its ids. Either is the row's body (`bodyFrom` says which).
  const block = exact ?? blocks.find((candidate) => row.row.ids.some((span) => covers(span, candidate.id)));
  if (!block) return issue;
  const bodyLines = ledger.lines.slice(block.line - 1, block.end);
  const labels: Record<string, string> = {};
  for (const name of labelsIn(bodyLines, 1, bodyLines.length)) {
    labels[name] = labelBlock(bodyLines, 1, bodyLines.length, name)?.text ?? "";
  }
  const out: ListedIssue = { ...issue, labels };
  const owner = key(block.id);
  if (owner !== row.id) out.bodyFrom = owner;
  const criteria = extractCriteria(bodyLines);
  if (criteria) {
    out.criteria = criteria;
    out.criteriaSource = "body";
  }
  return out;
}

/**
 * The summary line `check` and `counts` share. Only statuses that actually
 * occur are listed, in vocabulary order, so the line is stable run to run.
 */
export function summaryLine(counts: {
  open: number | null;
  closed: number | null;
  byStatus: Record<string, number | null>;
}): string {
  const open = Object.entries(STATUS_CLASSES)
    .filter(([status, kind]) => kind === "open" && Object.hasOwn(counts.byStatus, status))
    .map(([status]) => `${status} ${counts.byStatus[status] ?? "?"}`);
  const breakdown = open.length ? ` (${open.join(", ")})` : "";
  return `open ${counts.open ?? "?"}${breakdown}   closed ${counts.closed ?? "?"}`;
}

export type FoundRow = {
  row: LedgerRow;
  table: TableKind;
  /** The row's own span; for a bare number inside a range this is the range. */
  span: IdSpan;
  /** The id the caller asked for, resolved (`8` for a `7–20` row). */
  id: string;
  /** True when the id is only covered by a range, not a row of its own. */
  inRange: boolean;
};

/** Locate an issue by exact id, or by a bare number covered by a range row. */
export function findRow(
  ledger: ReturnType<typeof parseLedger>,
  id: string,
): FoundRow | undefined {
  const bare = /^\d+$/.test(id) ? Number(id) : undefined;
  for (const table of ["open", "closed"] as const) {
    for (const row of ledger.rows[table]) {
      for (const span of row.ids) {
        if (spanText(span) === id) {
          return { row, table, span, id, inRange: span.start !== span.end };
        }
        if (bare !== undefined && span.start !== span.end && span.start <= bare && bare <= span.end) {
          return { row, table, span, id: String(bare), inRange: true };
        }
      }
    }
  }
  return undefined;
}

export type LabeledParagraph = LabelBlock;

/**
 * Find a `**label**` block inside `lines[start-1..end]` (1-indexed). The block
 * runs to the next label or heading, so `**验收判据**：` + blank line + list is
 * read in full (see `labelBlock`). A fenced lookalike is an example, not a label.
 */
export function findLabel(
  lines: string[],
  start: number,
  end: number,
  label: string,
): LabeledParagraph | undefined {
  return labelBlock(lines, start, end, label);
}

/** Every distinct `**label**` in a line range, in document order. */
export function labelsIn(lines: string[], start: number, end: number): string[] {
  const out: string[] = [];
  // A fence nested in a list item may be indented past three columns; its
  // lines are still examples, not labels.
  const fenced = fencedLines(lines, Infinity);
  for (let line = start; line <= end && line <= lines.length; line++) {
    if (fenced[line - 1]) continue;
    const match = /^ {0,3}\*\*([^*]+)\*\*/.exec(lines[line - 1]!);
    if (match && !out.includes(labelName(match[1]!))) out.push(labelName(match[1]!));
  }
  return out;
}

export type IssueView = {
  id: string;
  table: TableKind;
  status: string;
  priority: string;
  summary: string;
  criteria?: string;
  /** Where `criteria` came from: the closed table's column, or the open body's **验收判据**. */
  criteriaSource?: "table" | "body";
  /** The id whose body supplied `criteria`, when that body is a row sibling's. */
  criteriaFrom?: string;
  line: number;
  end: number;
  /**
   * The body block shown for this id. `id` is the issue the block's heading
   * names; when a multi-id row keeps one body under its first id, `show 24`
   * still finds it, but `inherited` says the text is not #24's own (dogfood
   * #69) — `check` reports E102 for the ids without one.
   */
  body?: { line: number; end: number; text: string; id: string; inherited?: true };
  /** Every `**label**` block in the body, one-line form (as `--label` and `close` read them). */
  labels?: Record<string, string>;
};

/** The full view `show` renders: table row plus the body block when one exists. */
export function viewIssue(
  ledger: ReturnType<typeof parseLedger>,
  id: string,
): IssueView | undefined {
  const found = findRow(ledger, id);
  if (!found) return undefined;
  // A body block is identified by its full id (`2` and `2a` are distinct
  // issues). Prefer an exact match, then fall back to the row's other ids:
  // `| 4, 24 |` keeps one body under 4, and `show 24` should still find it —
  // but the view then says whose body it is instead of silently borrowing it.
  const blocks = bodyBlocks(ledger);
  const key = (span: IdSpan) => `${span.start}${span.suffix}`;
  const exact = blocks.find((candidate) => key(candidate.id) === found.id);
  // A range row (`5–7`) may keep its body under an interior id, exactly like
  // `withBody` reads it; a comma row under any of its ids. Without `covers`,
  // `show 5`/`show 7` said "(无正文块)" while `show 6` and `list --with-body`
  // found it (round 14 black-box finding).
  const block = exact ??
    blocks.find((candidate) => found.row.ids.some((span) => covers(span, candidate.id)));
  const owner = block ? key(block.id) : undefined;
  const view: IssueView = {
    id: found.id,
    table: found.table,
    status: found.row.status,
    priority: found.row.priority,
    summary: found.row.summary,
    line: found.row.line,
    end: found.row.line,
  };
  if (found.table === "closed") {
    view.criteria = found.row.criteria;
    view.criteriaSource = "table";
  }
  if (block) {
    view.body = {
      line: block.line,
      end: block.end,
      text: ledger.lines.slice(block.line - 1, block.end).join("\n").replace(/\n+$/, ""),
      id: owner!,
    };
    if (owner !== found.id) view.body.inherited = true;
    // Work on the block's own slice: `fencedLines` and the label scan then
    // cost O(body), not O(file) per label (review 13 performance finding).
    const bodyLines = ledger.lines.slice(block.line - 1, block.end);
    const labels: Record<string, string> = {};
    for (const name of labelsIn(bodyLines, 1, bodyLines.length)) {
      labels[name] = labelBlock(bodyLines, 1, bodyLines.length, name)?.text ?? "";
    }
    view.labels = labels;
    // Open issues keep their criteria in the body; expose them the same way
    // a closed issue exposes its column, so consumers need not parse Markdown.
    // Same text `close` would promote (every non-empty 验收判据 block).
    const promoted = found.table === "open" ? extractCriteria(bodyLines) : undefined;
    if (promoted) {
      view.criteria = promoted;
      view.criteriaSource = "body";
      if (owner !== found.id) view.criteriaFrom = owner;
    }
  }
  return view;
}