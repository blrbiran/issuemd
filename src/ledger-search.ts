import { IdSet, idText, parseId, type IdSpan } from "./issue-id.js";
import { archiveInventory, bodyBlocks, highWaterRecords, htmlBlockLines, locateArchivePayload, maxIssueId, type parseLedger, type TableKind } from "./ledger.js";
import { hashRepairContextSkipReason, hashRepairRanges, hashRepairSkipReason } from "./hash-scan.js";
import { inlineCodeRanges, isEscapedMarkdownChar, multilineInlineCodeRanges } from "./scan.js";

type Ledger = ReturnType<typeof parseLedger>;
type SourceRange = { start: number; end: number; id?: string; table?: TableKind; where: "body" | "archive" };
export type ProseReference = { id: string; line: number; start: number; end: number; external?: string; local?: true };
export type SearchMatch = { id: string; table: TableKind; line: number; where: "summary" | "body" | "archive" | "reference"; text: string };

function coverage(spans: IdSpan[]): (id: IdSpan) => number {
  const endpoints = new Map<string, { starts: number[]; ends: number[] }>();
  for (const { suffix, start, end } of spans) {
    const group = endpoints.get(suffix) ?? { starts: [], ends: [] };
    group.starts.push(start);
    group.ends.push(end);
    endpoints.set(suffix, group);
  }
  for (const { starts, ends } of endpoints.values()) {
    starts.sort((a, b) => a - b);
    ends.sort((a, b) => a - b);
  }
  const before = (values: number[], point: number, includePoint: boolean) => {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (values[mid]! < point || (includePoint && values[mid] === point)) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  return ({ suffix, start }) => {
    const group = endpoints.get(suffix);
    return group ? before(group.starts, start, true) - before(group.ends, start, false) : 0;
  };
}

function sourceRanges(ledger: Ledger): SourceRange[] {
  const openIds = new IdSet(ledger.rows.open.flatMap(({ ids }) => ids));
  const ranges: SourceRange[] = bodyBlocks(ledger).map(({ id, line, end }) => ({
    start: line + 1, end, where: "body", ...(openIds.has(id) ? { id: idText(id), table: "open" } : {}),
  }));
  const inventory = archiveInventory(ledger);
  const archiveCounts = new Map<string, number>();
  for (const { id } of inventory.archives) archiveCounts.set(id, (archiveCounts.get(id) ?? 0) + 1);
  const countClosed = coverage(ledger.rows.closed.flatMap(({ ids }) => ids));
  const unreadable = new IdSet(ledger.unreadable.flatMap(({ ids }) => ids ?? []));
  let archiveIndex = 0;
  for (const appendix of inventory.appendices) {
    let next = appendix.line_start + 1;
    for (; inventory.archives[archiveIndex]?.appendix === appendix; archiveIndex++) {
      const { section, id } = inventory.archives[archiveIndex]!;
      if (section.line_start > next) ranges.push({ start: next, end: section.line_start - 1, where: "archive" });
      const located = locateArchivePayload(ledger, section, inventory.masks).range;
      const span = parseId(id);
      if (located && span && archiveCounts.get(id) === 1 && countClosed(span) === 1 &&
          !openIds.has(span) && !unreadable.has(span) &&
          !inventory.hiddenArchives.some(({ line }) => line >= located.start && line <= located.end)) {
        ranges.push({ start: located.start, end: located.end, id, table: "closed", where: "archive" });
      }
      // A broken envelope may straddle an apparent H3. Resume at the next
      // independently identified archive or the next appendix.
      const following = inventory.archives[archiveIndex + 1];
      next = located ? located.framingEnd + 1
        : following?.appendix === appendix ? following.section.line_start : appendix.line_end + 1;
    }
    if (next <= appendix.line_end) ranges.push({ start: next, end: appendix.line_end, where: "archive" });
  }
  return ranges;
}

const SELF_LEDGER = /^(?:本|该|这|此|同一|当前|current|本文|本文件|本文档|本份|这份|该份|当前这份|this)$/iu;
/**
 * Leading characters that can only belong to a reference verb or particle
 * (`见本`, `参考本`, `列入本`, `载于本`, `登记在本`, `根据本`, `按照本`).
 * Stripping by *character* handles compounds that a word list would miss —
 * an unrecognized verb would otherwise flip a self-reference to external and
 * silently stop reserving the id. `日本` is not stripped (日 is not listed).
 */
const REFERENCE_PREFIX_CHARS = new Set(Array.from("请另参见详见关于根据依据依照按照基于参考载列入写记录登见据按如在于附"));
const LEDGER_MENTION = /([\p{L}\p{N}_./-]+)[ \t]*(?:台账|ledger)/giu;
const LEDGER_FILE = /[^\s`]*?(?:dogfood|ledger|issue-\d{8})[^\s`]*?\.md/giu;

/** `见本`、`登记在本`、`the current` all name this ledger; `日本` does not. */
function selfLedgerName(name: string): boolean {
  let rest = name;
  while (rest.length > 0 && REFERENCE_PREFIX_CHARS.has(rest[0]!)) rest = rest.slice(1);
  return SELF_LEDGER.test(rest);
}

type LedgerContext = { kind: "external"; name?: string } | { kind: "local" };

/** Whether the nearest ledger mention before `column` belongs to another file. */
function externalLedgerContext(text: string, column: number): LedgerContext | undefined {
  const before = text.slice(0, column);
  let last: { kind: "external" | "local"; index: number; name?: string } | undefined;
  for (const match of before.matchAll(LEDGER_MENTION)) {
    const name = match[1]!;
    const end = match.index! + match[0].length;
    if (!last || end > last.index) last = { kind: selfLedgerName(name) ? "local" : "external", index: end, name };
  }
  for (const match of before.matchAll(LEDGER_FILE)) {
    const end = match.index! + match[0].length;
    if (!last || end > last.index) last = { kind: "external", index: end, name: match[0] };
  }
  if (!last) {
    if (/(?:^|[ \t])ledger[ \t]*[:：]?[ \t]*$/iu.test(before) &&
        !/(?:this|the current)[ \t]+ledger[ \t]*[:：]?[ \t]*$/iu.test(before)) {
      return { kind: "external", name: "another ledger" };
    }
    return undefined;
  }
  // The mention's scope ends at a sentence break, or at a semicolon followed
  // by prose rather than another `#N` in the same list.
  const rest = before.slice(last.index);
  if (/[。]/u.test(rest) || /[；;][ \t]*(?:另|其他|另外|参见|见|also|see|cf\.)/iu.test(rest) || /[.!?](?=\s)/u.test(rest)) return undefined;
  return last.kind === "local" ? { kind: "local" } : { kind: "external", name: last.name ?? "another ledger" };
}

export function proseReferences(ledger: Ledger, ranges = sourceRanges(ledger)): ProseReference[] {
  const { lines } = ledger;
  const candidates: ProseReference[] = [];
  const headingLines = new Set(ledger.sections.map(({ line_start }) => line_start));
  for (const { start, end } of ranges) {
    for (let line = start; line <= end; line++) {
      const text = lines[line - 1]!;
      if (!text.includes("#") || headingLines.has(line) || /^[ \t]*\|/.test(text)) continue;
      for (const match of text.matchAll(/#[1-9]\d*[a-z]?/g)) {
        const column = match.index!;
        const end = column + match[0].length;
        if (!parseId(match[0].slice(1)) || /[a-zA-Z0-9_#]/.test(text[end] ?? "") ||
            /[a-zA-Z0-9_#]/.test(text[column - 1] ?? "") || isEscapedMarkdownChar(text, column)) continue;
        const context = externalLedgerContext(text, column);
        candidates.push({
          id: match[0].slice(1), line, start: column, end,
          ...(context?.kind === "external" ? { external: context.name ?? "another ledger" } : context?.kind === "local" ? { local: true } : {}),
        });
      }
    }
  }
  if (!candidates.length) return candidates;
  const { masks } = archiveInventory(ledger);
  const literalHtml = htmlBlockLines(lines, masks.fenced, masks.comments);
  const protectedLines = lines.map((text, index) => masks.fenced[index] || masks.comments[index] || masks.rawHtml[index] || literalHtml[index]
    ? ""
    : text);
  const inline = multilineInlineCodeRanges(protectedLines, masks.fenced);
  const searchable = protectedLines.map((text, index) => {
    for (const [start, end] of [...inlineCodeRanges(text), ...(inline.get(index) ?? [])]) {
      text = `${text.slice(0, start)}${" ".repeat(end - start)}${text.slice(end)}`;
    }
    return text.replace(/<!--(?:.*?-->|.*$)/g, (comment) => " ".repeat(comment.length));
  });
  const context = hashRepairRanges(searchable, masks.fenced);
  return candidates.filter(({ id, line, start, end }) => {
    const index = line - 1;
    const source = searchable[index]!;
    if (source[start] !== "#" || inlineCodeRanges(lines[index]!).some(([from, to]) => start >= from && end <= to)) return false;
    const span = { hash: id, start, end };
    return !hashRepairContextSkipReason(source, index, span, context) && !hashRepairSkipReason(source, span);
  }).sort((a, b) => a.line - b.line || a.start - b.start);
}

/** The highest number this ledger can plausibly own: a bare `#N` above it is historical/foreign. */
export function referenceCeiling(ledger: Ledger): number {
  const highWater = highWaterRecords(ledger).reduce((top, record) => record.value == null ? top : Math.max(top, record.value), 0);
  return Math.max(maxIssueId(ledger.rows, ledger.unreadable), highWater) + 1;
}

/**
 * Prose references that reserve an id: explicit self-ledger mentions always
 * do; a bare `#N` only while it is plausibly local (≤ high-water + 1).
 * Explicit external mentions never do.
 */
export function reservedProseReferences(ledger: Ledger): ProseReference[] {
  const ceiling = referenceCeiling(ledger);
  return proseReferences(ledger).filter((reference) => {
    if (reference.external) return false;
    if (reference.local) return true;
    const parsed = parseId(reference.id);
    return parsed != null && parsed.start <= ceiling;
  });
}

export function missingProseReferences(ledger: Ledger): ProseReference[] {
  const known = new IdSet([
    ...ledger.rows.open.flatMap(({ ids }) => ids), ...ledger.rows.closed.flatMap(({ ids }) => ids),
    ...ledger.unreadable.flatMap(({ ids }) => ids ?? []), ...ledger.cited.flatMap(({ ids }) => ids ?? []),
  ]);
  const seen = new Set<string>();
  return reservedProseReferences(ledger).filter(({ id }) => {
    if (seen.has(id) || known.has(parseId(id)!)) return false;
    seen.add(id);
    return true;
  });
}

export function findLedgerText(ledger: Ledger, pattern: string): SearchMatch[] {
  const ranges = sourceRanges(ledger);
  const references = new Map<number, ProseReference[]>();
  for (const reference of proseReferences(ledger, ranges)) {
    const onLine = references.get(reference.line) ?? [];
    onLine.push(reference);
    references.set(reference.line, onLine);
  }
  const hits: SearchMatch[] = [];
  for (const table of ["open", "closed"] as const) {
    for (const row of ledger.rows[table]) {
      if (!row.summary.includes(pattern)) continue;
      const id = row.ids.map((span) => span.start === span.end ? idText(span) : `${span.start}–${span.end}`).join(", ");
      hits.push({ id, table, line: row.line, where: "summary", text: row.summary });
    }
  }
  for (const { start, end, id, table, where } of ranges) {
    if (!id || !table) continue;
    for (let line = start; line <= end; line++) {
      const text = ledger.lines[line - 1]!;
      const start = text.indexOf(pattern);
      if (start < 0) continue;
      const reference = references.get(line)?.some((token) => text.slice(token.start, token.end).includes(pattern));
      hits.push({ id, table, line, where: reference ? "reference" : where, text });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}
