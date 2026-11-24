/**
 * Read-only views over a parsed ledger: the rows `list` prints, the single
 * issue `show` renders, and the counted summary `counts` emits.
 *
 * Everything here is pure and derived from `parseLedger`; no command in this
 * module writes to disk.
 */

import type { IdSpan } from "./issue-id.js";
import { bodyBlocks, parseLedger, type LedgerRow, type TableKind } from "./ledger.js";
import { fencedLines, labelBlock, type LabelBlock } from "./ledger-edit.js";
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
};

/** Render a span the way the table spells it: `7`, `393b`, or `7–20`. */
export function spanText(span: IdSpan): string {
  return span.start === span.end ? `${span.start}${span.suffix}` : `${span.start}–${span.end}`;
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
  const fenced = fencedLines(lines);
  for (let line = start; line <= end && line <= lines.length; line++) {
    if (fenced[line - 1]) continue;
    const match = /^ {0,3}\*\*([^*]+)\*\*/.exec(lines[line - 1]!);
    if (match && !out.includes(match[1]!.trim())) out.push(match[1]!.trim());
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
  line: number;
  end: number;
  body?: { line: number; end: number; text: string };
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
  // `| 4, 24 |` keeps one body under 4, and `show 24` should still find it.
  const blocks = bodyBlocks(ledger);
  const key = (span: IdSpan) => `${span.start}${span.suffix}`;
  const block =
    blocks.find((candidate) => key(candidate.id) === found.id) ??
    found.row.ids
      .map((span) => blocks.find((candidate) => key(candidate.id) === key(span)))
      .find((candidate) => candidate != null);
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
    };
    const labels: Record<string, string> = {};
    for (const name of labelsIn(ledger.lines, block.line, block.end)) {
      labels[name] = labelBlock(ledger.lines, block.line, block.end, name)?.text ?? "";
    }
    view.labels = labels;
    // Open issues keep their criteria in the body; expose them the same way
    // a closed issue exposes its column, so consumers need not parse Markdown.
    if (found.table === "open" && labels["验收判据"]) {
      view.criteria = labels["验收判据"];
      view.criteriaSource = "body";
    }
  }
  return view;
}