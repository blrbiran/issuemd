/**
 * Read-only views over a parsed ledger: the rows `list` prints, the single
 * issue `show` renders, and the counted summary `counts` emits.
 *
 * Everything here is pure and derived from `parseLedger`; no command in this
 * module writes to disk.
 */

import type { IdSpan } from "./issue-id.js";
import { bodyBlocks, parseLedger, type LedgerRow, type TableKind } from "./ledger.js";
import { STATUS_CLASSES } from "./ledger-check.js";

export type ListedIssue = {
  id: string;
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

export function toListedIssue(row: LedgerRow, table: TableKind): ListedIssue {
  const issue: ListedIssue = {
    id: rowIds(row),
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

export type LabeledParagraph = { label: string; text: string; line: number };

/** Find a `**label**：` paragraph inside `lines[start-1..end)` (1-indexed). */
export function findLabel(
  lines: string[],
  start: number,
  end: number,
  label: string,
): LabeledParagraph | undefined {
  const canonical = (text: string) => text.trim().replace(/\s+/g, " ");
  for (let line = start; line <= end && line <= lines.length; line++) {
    const match = /^ {0,3}\*\*([^*]+)\*\*\s*[:：]?\s*(.*)$/.exec(lines[line - 1]!);
    if (!match || match[1]!.trim() !== label) continue;
    const parts = [match[2]!.trim()];
    for (let next = line + 1; next <= end && next <= lines.length; next++) {
      const text = lines[next - 1]!;
      if (text.trim() === "" || /^ {0,3}\*\*[^*]+\*\*/.test(text)) break;
      parts.push(text.trim());
    }
    return { label, text: canonical(parts.filter(Boolean).join(" ")), line };
  }
  return undefined;
}

/** Every distinct `**label**` in a line range, in document order. */
export function labelsIn(lines: string[], start: number, end: number): string[] {
  const out: string[] = [];
  for (let line = start; line <= end && line <= lines.length; line++) {
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
  line: number;
  end: number;
  body?: { line: number; end: number; text: string };
};

/** The full view `show` renders: table row plus the body block when one exists. */
export function viewIssue(
  ledger: ReturnType<typeof parseLedger>,
  id: string,
): IssueView | undefined {
  const found = findRow(ledger, id);
  if (!found) return undefined;
  const block = bodyBlocks(ledger).find((candidate) => candidate.id.start === found.span.start);
  const view: IssueView = {
    id: found.id,
    table: found.table,
    status: found.row.status,
    priority: found.row.priority,
    summary: found.row.summary,
    line: found.row.line,
    end: found.row.line,
  };
  if (found.table === "closed") view.criteria = found.row.criteria;
  if (block) {
    view.body = {
      line: block.line,
      end: block.end,
      text: ledger.lines.slice(block.line - 1, block.end).join("\n").replace(/\n+$/, ""),
    };
  }
  return view;
}