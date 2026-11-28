/**
 * Read-only views over a parsed ledger: the rows `list` prints, the single
 * issue `show` renders, and the counted summary `counts` emits.
 *
 * Everything here is pure and derived from `parseLedger`; no command in this
 * module writes to disk.
 */

import { parseId, type IdSpan } from "./issue-id.js";
import { archiveInventory, archivePayloadRange, bodyBlocks, parseLedger, type BodyBlock, type LedgerRow, type TableKind } from "./ledger.js";
import { fencedLines } from "./scan.js";
import { bodyLabels, bodyVisibility, type BodyVisibility, labelBlock, labelBlocksIn, type LabelBlock, criteriaOccurrences, criteriaOccurrencesFromLabelBlocks, criteriaItemsFromOccurrences, criteriaTextFromOccurrences } from "./ledger-edit.js";
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
  /** Item boundaries when they can be recovered from a body/archive block. */
  criteriaItems?: string[];
  /** The criteria came from a flat table cell; `；` item boundaries are lost. */
  criteriaJoined?: true;
  /** `--with-body`: where `criteria` came from (open: the body; closed: the column). */
  criteriaSource?: "body" | "table";
  /** `--with-body`: the id whose body supplied labels/criteria when it is a sibling's. */
  bodyFrom?: string;
  /** `--with-body`: every body label, one-line form (same as `show --json`). */
  labels?: Record<string, string>;
  /** `--with-body`: original lines for each label block, including markup. */
  labelBlocks?: Record<string, string[]>;
  /** `--with-body`: source-preserving canonical and later supplement criteria blocks. */
  criteriaBlocks?: { line: number; label: string; kind: "canonical" | "supplement"; lines: string[] }[];
  /** `--with-body`: an editable body payload, without its issue heading. */
  body?: { archived?: true; line: number; end: number; lineCount?: number; text: string; content: string; id: string };
};

/** Render a span the way the table spells it: `7`, `393b`, or `7–20`. */
export function spanText(span: IdSpan): string {
  return span.start === span.end ? `${span.start}${span.suffix}` : `${span.start}–${span.end}`;
}

/** True when `id` is one of the numbers a row cell's span covers. */
function covers(span: IdSpan, id: IdSpan): boolean {
  return span.suffix === id.suffix && span.start <= id.start && id.start <= span.end;
}

/**
 * A body under `candidate` may belong to a multi-id row only when no *other*
 * row spells that id itself: an overlapping id means the body belongs to that
 * row, and presenting it as "same row" would be wrong (E103 is a broken
 * ledger; round 14 review).
 */
function mayBorrow(ledger: ReturnType<typeof parseLedger>, rowLine: number, candidate: BodyBlock): boolean {
  const wanted = `${candidate.id.start}${candidate.id.suffix}`;
  return ![...ledger.rows.open, ...ledger.rows.closed].some((row) =>
    row.line !== rowLine && row.ids.some((span) => spanText(span) === wanted));
}

export type WithBodyIndex = {
  rowsById: Map<string, FoundRow>;
  exactBodiesById: Map<string, BodyBlock>;
  bodiesBySuffix: Map<string, BodyBlock[]>;
  explicitRowsById: Map<string, Set<number>>;
  fallbackBodiesByRowLine: Map<number, BodyBlock | null>;
  archiveBodiesById: Map<string, ArchivedBody | null>;
};

function bodyContent(lines: string[], headingLine: number, endLine: number): string {
  const content = lines.slice(headingLine, endLine);
  while (content[0]?.trim() === "") content.shift();
  while (content.at(-1)?.trim() === "") content.pop();
  return content.join("\n");
}

function criteriaBlockViews(occurrences: ReturnType<typeof criteriaOccurrences>) {
  return occurrences.map(({ line, label, kind, lines }) => ({ line, label, kind, lines }));
}

/** A flat closed-table cell cannot be split non-destructively; flag that. */
function criteriaItemsFallback(criteria: string | undefined): { criteriaItems?: string[]; criteriaJoined?: true } {
  if (criteria == null || criteria === "") return {};
  return { criteriaItems: [criteria], ...(criteria.includes("；") ? { criteriaJoined: true as const } : {}) };
}

type ArchivedBody = NonNullable<ListedIssue["body"]>;

function archivePayload(
  ledger: ReturnType<typeof parseLedger>,
  section: ReturnType<typeof parseLedger>["sections"][number],
  id: string,
  fenced: boolean[],
): ArchivedBody | undefined {
  const range = archivePayloadRange(ledger, section, fenced);
  if (!range) return undefined;
  const { start, end, finalNewline } = range;
  const payloadLines = ledger.lines.slice(start - 1, end);
  const textFinalNewline = range.version === "v3" ? range.payloadLineCount > 0 : finalNewline;
  const text = payloadLines.length ? payloadLines.join("\n") + (textFinalNewline ? "\n" : "") : "";
  return {
    archived: true,
    id,
    line: start,
    end,
    lineCount: range.payloadLineCount,
    text,
    content: text,
  };
}

function archiveBodies(
  ledger: ReturnType<typeof parseLedger>,
  requestedIds: Set<string>,
): Map<string, ArchivedBody | null> {
  const result = new Map<string, ArchivedBody | null>();
  if (requestedIds.size === 0) return result;
  const candidates = archiveInventory(ledger).archives.filter(({ id }) => requestedIds.has(id));
  const fenced = fencedLines(ledger.lines, true);
  for (const { section, id } of candidates) {
    if (result.has(id)) {
      result.set(id, null);
      continue;
    }
    result.set(id, archivePayload(ledger, section, id, fenced) ?? null);
  }
  return result;
}

function archivedBodyForRow(
  ledger: ReturnType<typeof parseLedger>,
  row: LedgerRow,
  requestedId: string,
): ArchivedBody | undefined {
  const wanted = new Set<string>();
  const requestedSpan = parseId(requestedId);
  if (requestedSpan && row.ids.some((span) => covers(span, requestedSpan))) wanted.add(requestedId);
  for (const { id } of archiveInventory(ledger).archives) {
    const span = parseId(id);
    if (span && row.ids.some((range) => covers(range, span))) wanted.add(id);
  }
  const candidates = archiveBodies(ledger, wanted);
  if (candidates.has(requestedId)) return candidates.get(requestedId) ?? undefined;
  const usable = [...candidates.values()].filter((body): body is ArchivedBody => body != null);
  return usable.length === 1 ? usable[0] : undefined;
}

/** Build lookups only for IDs the current list view will request. */
export function indexWithBody(
  ledger: ReturnType<typeof parseLedger>,
  issues: ListedIssue[] = [...ledger.rows.open.map((row) => toListedIssue(row, "open")),
    ...ledger.rows.closed.map((row) => toListedIssue(row, "closed"))],
  blocks = bodyBlocks(ledger),
): WithBodyIndex {
  const requested = new Set(issues.map((issue) => issue.ids[0]).filter((id): id is string => id != null));
  const requestedNumbers = [...requested]
    .filter((id) => /^\d+$/.test(id))
    .map(Number)
    .sort((a, b) => a - b);
  const numericIndex = new Map(requestedNumbers.map((id, index) => [String(id), index]));
  const next = Array.from({ length: requestedNumbers.length + 1 }, (_, index) => index);
  const findNext = (at: number): number => {
    let root = at;
    while (next[root] !== root) root = next[root]!;
    while (next[at] !== at) {
      const following = next[at]!;
      next[at] = root;
      at = following;
    }
    return root;
  };
  const rowsById = new Map<string, FoundRow>();
  const explicitRowsById = new Map<string, Set<number>>();
  const claimNextNumber = (index: number, found: FoundRow) => {
    const id = String(requestedNumbers[index]!);
    if (!rowsById.has(id)) rowsById.set(id, { ...found, id, inRange: found.span.start !== found.span.end });
    next[index] = findNext(index + 1);
  };
  for (const table of ["open", "closed"] as const) {
    for (const row of ledger.rows[table]) {
      for (const span of row.ids) {
        const written = spanText(span);
        const found: FoundRow = { row, table, span, id: written, inRange: span.start !== span.end };
        if (requested.has(written) && !rowsById.has(written)) rowsById.set(written, found);
        if (span.start === span.end) {
          const lines = explicitRowsById.get(written) ?? new Set<number>();
          lines.add(row.line);
          explicitRowsById.set(written, lines);
          const index = numericIndex.get(written);
          if (index != null && findNext(index) === index) next[index] = findNext(index + 1);
        } else if (span.suffix === "") {
          let low = 0;
          let high = requestedNumbers.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (requestedNumbers[middle]! < span.start) low = middle + 1;
            else high = middle;
          }
          for (let index = findNext(low); index < requestedNumbers.length && requestedNumbers[index]! <= span.end;) {
            claimNextNumber(index, found);
            index = findNext(index);
          }
        }
      }
    }
  }
  const exactBodiesById = new Map<string, BodyBlock>();
  const bodiesBySuffix = new Map<string, BodyBlock[]>();
  for (const block of blocks) {
    const key = `${block.id.start}${block.id.suffix}`;
    if (!exactBodiesById.has(key)) exactBodiesById.set(key, block);
    const sameSuffix = bodiesBySuffix.get(block.id.suffix) ?? [];
    sameSuffix.push(block);
    bodiesBySuffix.set(block.id.suffix, sameSuffix);
  }
  for (const sameSuffix of bodiesBySuffix.values()) {
    sameSuffix.sort((a, b) => a.id.start - b.id.start || a.line - b.line);
  }
  const closedRows = issues.filter((issue) => issue.criteria != null)
    .map((issue) => rowsById.get(issue.ids[0] ?? issue.id)?.row)
    .filter((row): row is LedgerRow => row != null);
  const archivedIds = new Set<string>();
  const rangedRows: LedgerRow[] = [];
  for (const row of closedRows) {
    for (const span of row.ids) {
      if (span.start === span.end) archivedIds.add(`${span.start}${span.suffix}`);
      else rangedRows.push(row);
    }
  }
  if (rangedRows.length > 0) {
    for (const { id } of archiveInventory(ledger).archives) {
      const span = parseId(id);
      if (span && rangedRows.some((row) => row.ids.some((range) => covers(range, span)))) archivedIds.add(id);
    }
  }
  const archiveBodiesById = archiveBodies(ledger, archivedIds);
  return {
    rowsById,
    exactBodiesById,
    bodiesBySuffix,
    explicitRowsById,
    fallbackBodiesByRowLine: new Map(),
    archiveBodiesById,
  };
}

function indexedArchiveForRow(index: WithBodyIndex, row: LedgerRow, requestedId: string): ArchivedBody | undefined {
  if (index.archiveBodiesById.has(requestedId)) return index.archiveBodiesById.get(requestedId) ?? undefined;
  const candidates = [...index.archiveBodiesById.entries()]
    .filter(([id]) => {
      const span = parseId(id);
      return span != null && row.ids.some((range) => covers(range, span));
    })
    .map(([, body]) => body)
    .filter((body): body is ArchivedBody => body != null);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function rangeBodies(index: WithBodyIndex, span: IdSpan): BodyBlock[] {
  const sameSuffix = index.bodiesBySuffix.get(span.suffix) ?? [];
  let low = 0;
  let high = sameSuffix.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sameSuffix[middle]!.id.start < span.start) low = middle + 1;
    else high = middle;
  }
  const found: BodyBlock[] = [];
  for (let at = low; at < sameSuffix.length && sameSuffix[at]!.id.start <= span.end; at++) found.push(sameSuffix[at]!);
  return found;
}

function indexedBody(index: WithBodyIndex, row: FoundRow): BodyBlock | undefined {
  const key = (span: IdSpan) => `${span.start}${span.suffix}`;
  const exact = index.exactBodiesById.get(row.id);
  if (exact) return exact;
  if (index.fallbackBodiesByRowLine.has(row.row.line)) {
    return index.fallbackBodiesByRowLine.get(row.row.line) ?? undefined;
  }
  let earliest: BodyBlock | undefined;
  for (const span of row.row.ids) {
    const candidates = span.start === span.end
      ? [index.exactBodiesById.get(key(span))].filter((block): block is BodyBlock => block != null)
      : rangeBodies(index, span);
    for (const candidate of candidates) {
      const owner = key(candidate.id);
      const explicitRows = index.explicitRowsById.get(owner);
      if (explicitRows && [...explicitRows].some((line) => line !== row.row.line)) continue;
      if (!earliest || candidate.line < earliest.line) earliest = candidate;
    }
  }
  index.fallbackBodiesByRowLine.set(row.row.line, earliest ?? null);
  return earliest;
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
  index = indexWithBody(ledger),
): ListedIssue {
  if (issue.criteria != null) {
    const first = issue.ids[0] ?? issue.id;
    const row = index.rowsById.get(first);
    const archived = row ? indexedArchiveForRow(index, row.row, first) : index.archiveBodiesById.get(first) ?? undefined;
    if (!archived) return { ...issue, criteriaSource: "table", ...criteriaItemsFallback(issue.criteria) };
    const bodyLines = ledger.lines.slice(archived.line - 1, archived.end);
    const occurrences = criteriaOccurrences(bodyLines, archived.line - 1);
    const items = criteriaTextFromOccurrences(occurrences) === issue.criteria
      ? criteriaItemsFromOccurrences(occurrences)
      : undefined;
    return {
      ...issue,
      criteriaSource: "table",
      body: archived,
      criteriaBlocks: criteriaBlockViews(occurrences),
      ...(items ? { criteriaItems: items } : criteriaItemsFallback(issue.criteria)),
    };
  }
  const first = issue.ids[0];
  if (!first) return issue;
  const row = index.rowsById.get(first);
  if (!row || row.table !== "open") return issue;
  // Prefer the first id's exact body, then the earliest body owned by any id
  // in this row. The index keeps overlap checks constant-time and range lookup
  // logarithmic instead of scanning all rows and blocks for every issue.
  const block = indexedBody(index, row);
  if (!block) return issue;
  const bodyLines = ledger.lines.slice(block.line - 1, block.end);
  const fenced = fencedLines(bodyLines, true);
  const visibility = bodyVisibility(bodyLines, fenced);
  const sourceBlocks = labelBlocksIn(bodyLines, 1, bodyLines.length, fenced, visibility);
  const labels: Record<string, string> = {};
  const labelBlocks: Record<string, string[]> = {};
  for (const found of sourceBlocks) {
    if (!Object.hasOwn(labels, found.label)) {
      labels[found.label] = found.text;
      labelBlocks[found.label] = found.lines;
    }
  }
  const occurrences = criteriaOccurrencesFromLabelBlocks(sourceBlocks, block.line - 1);
  const owner = `${block.id.start}${block.id.suffix}`;
  const out: ListedIssue = {
    ...issue,
    labels,
    labelBlocks,
    criteriaBlocks: criteriaBlockViews(occurrences),
    body: {
      line: block.line,
      end: block.end,
      text: ledger.lines.slice(block.line - 1, block.end).join("\n").replace(/\n+$/, ""),
      content: bodyContent(ledger.lines, block.line, block.end),
      id: owner,
    },
  };
  if (owner !== row.id) out.bodyFrom = owner;
  const criteria = criteriaTextFromOccurrences(occurrences);
  if (criteria) {
    out.criteria = criteria;
    out.criteriaSource = "body";
    const items = criteriaItemsFromOccurrences(occurrences);
    if (items) out.criteriaItems = items;
  }
  return out;
}


export type LedgerSize = { bytes: number; lines: number; bodyLines: number; archivedLines: number; archivedBlocks: number };

/**
 * How big this ledger is, and how much of it is issue bodies versus frozen
 * archives (`check --json size`, dogfood #115). Without these numbers an agent
 * can only tell "0 errors" from "0 errors": a 300-line ledger and a 12,000-line
 * one look the same.
 */
export function ledgerSize(ledger: ReturnType<typeof parseLedger>, src: string): LedgerSize {
  const blocks = bodyBlocks(ledger);
  const bodyLines = blocks.reduce((total, block) => total + (block.end - block.line), 0);
  let archivedLines = 0;
  let archivedBlocks = 0;
  const archives = archiveInventory(ledger).archives;
  if (archives.length > 0) {
    const fenced = fencedLines(ledger.lines, true);
    for (const { section } of archives) {
      const range = archivePayloadRange(ledger, section, fenced);
      archivedBlocks++;
      if (range) archivedLines += range.end - range.start + 1;
    }
  }
  return { bytes: Buffer.byteLength(src), lines: ledger.lines.length, bodyLines, archivedLines, archivedBlocks };
}

export function openStatusCounts(rows: LedgerRow[]): Record<string, number | null> {
  const counts = new Map<string, bigint>();
  for (const row of rows) {
    const rowCount = row.ids.reduce((sum, span) => sum + BigInt(span.end - span.start + 1), 0n);
    counts.set(row.status, (counts.get(row.status) ?? 0n) + rowCount);
  }
  return Object.fromEntries([...counts].map(([status, count]) => [
    status,
    count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null,
  ]));
}

/**
 * The summary line shared by `check` and `counts`. Include raw open-table
 * statuses too: W220 must not make the status breakdown appear smaller than
 * the open total.
 */
export function summaryLine(
  counts: { open: number | null; closed: number | null; byStatus: Record<string, number | null> },
  openByStatus: Record<string, number | null>,
): string {
  const knownOpen = Object.keys(STATUS_CLASSES).filter((status) => STATUS_CLASSES[status as keyof typeof STATUS_CLASSES] === "open");
  const ordered = [
    ...knownOpen.filter((status) => Object.hasOwn(openByStatus, status)),
    ...Object.keys(openByStatus).filter((status) => !Object.hasOwn(STATUS_CLASSES, status)),
  ];
  const open = ordered.map((status) => `${status} ${openByStatus[status] ?? "?"}`);
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
export function labelsIn(
  lines: string[],
  start: number,
  end: number,
  fenced = fencedLines(lines, true),
  visibility: BodyVisibility = bodyVisibility(lines, fenced),
): string[] {
  const out: string[] = [];
  for (const { label } of bodyLabels(lines, start, end, fenced, visibility)) {
    if (!out.includes(label)) out.push(label);
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
  /** Item boundaries when they can be recovered from a body/archive block. */
  criteriaItems?: string[];
  /** The criteria came from a flat table cell; `；` item boundaries are lost. */
  criteriaJoined?: true;
  /** Where `criteria` came from: the closed table's column, or the open body's **验收判据**. */
  criteriaSource?: "table" | "body";
  /** The id whose body supplied `criteria`, when that body is a row sibling's. */
  criteriaFrom?: string;
  line: number;
  end: number;
  /**
   * The body block shown for this id. `id` names the issue the block belongs
   * to; `archived` marks a payload read from a unique kept-body archive.
   */
  body?: { line: number; end: number; lineCount?: number; text: string; content: string; id: string; inherited?: true; archived?: true };
  /** Every `**label**` block in the body, one-line form (as `--label` and `close` read them). */
  labels?: Record<string, string>;
  /** Original lines for each label block, including Markdown fences and blank lines. */
  labelBlocks?: Record<string, string[]>;
  /** Source-preserving canonical and later supplement criteria blocks. */
  criteriaBlocks?: { line: number; label: string; kind: "canonical" | "supplement"; lines: string[] }[];
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
  const block = exact ?? blocks.find((candidate) =>
    found.row.ids.some((span) => covers(span, candidate.id)) && mayBorrow(ledger, found.row.line, candidate));
  const owner = block ? key(block.id) : undefined;
  const archived = found.table === "closed" && !block
    ? archivedBodyForRow(ledger, found.row, found.id)
    : undefined;
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
  const displayedBody = block ?? archived;
  if (displayedBody) {
    view.body = {
      line: displayedBody.line,
      end: displayedBody.end,
      text: block
        ? ledger.lines.slice(block.line - 1, block.end).join("\n").replace(/\n+$/, "")
        : archived!.text,
      content: block ? bodyContent(ledger.lines, block.line, block.end) : archived!.content,
      id: block ? owner! : archived!.id,
      ...(archived ? { archived: true as const, lineCount: archived.lineCount } : {}),
    };
    if (owner && owner !== found.id) view.body!.inherited = true;
    // Work on the body's own slice: `fencedLines` and the label scan then cost
    // O(body), not O(file) per label (review 13 performance finding).
    const bodyLines = ledger.lines.slice(displayedBody.line - 1, displayedBody.end);
    const fenced = fencedLines(bodyLines, true);
    const visibility = bodyVisibility(bodyLines, fenced);
    const sourceBlocks = labelBlocksIn(bodyLines, 1, bodyLines.length, fenced, visibility);
    const labels: Record<string, string> = {};
    const labelBlocks: Record<string, string[]> = {};
    for (const candidate of sourceBlocks) {
      if (!Object.hasOwn(labels, candidate.label)) {
        labels[candidate.label] = candidate.text;
        labelBlocks[candidate.label] = candidate.lines;
      }
    }
    const occurrences = criteriaOccurrencesFromLabelBlocks(sourceBlocks, displayedBody.line - 1);
    view.labels = labels;
    view.labelBlocks = labelBlocks;
    view.criteriaBlocks = criteriaBlockViews(occurrences);
    // Open issues keep their criteria in the body; expose them the same way
    // a closed issue exposes its column, so consumers need not parse Markdown.
    // Same text `close` would promote (every non-empty 验收判据 block).
    const promoted = found.table === "open" ? criteriaTextFromOccurrences(occurrences) : undefined;
    if (promoted) {
      view.criteria = promoted;
      view.criteriaSource = "body";
      if (owner !== found.id) view.criteriaFrom = owner;
      const items = criteriaItemsFromOccurrences(occurrences);
      if (items) view.criteriaItems = items;
    }
    if (found.table === "closed" && archived && criteriaTextFromOccurrences(occurrences) === found.row.criteria) {
      const items = criteriaItemsFromOccurrences(occurrences);
      if (items) view.criteriaItems = items;
    }
  }
  if (found.table === "closed" && view.criteriaItems == null) Object.assign(view, criteriaItemsFallback(view.criteria));
  return view;
}