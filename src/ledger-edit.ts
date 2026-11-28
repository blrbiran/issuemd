/**
 * Pure line-level primitives for ledger writes.
 *
 * Nothing here touches the disk: every function takes a line array and
 * returns a new one. The CLI owns the read, the validation gate and the
 * atomic write, so `--dry-run` and a real write share the same computation.
 *
 * Line numbers are 1-indexed, matching `parseLedger`; array indices are not.
 */

import type { LedgerRow, TableKind } from "./ledger.js";
import { KEPT_BODY_VERSION_V3, KEPT_BODY_START, keptBodyLinesMarker, KEPT_BODY_END } from "./ledger.js";
import { STATUS_CLASSES } from "./ledger-check.js";
import { inlineCodeRanges, fencedLines, isEscapedMarkdownChar, multilineInlineCodeRanges, scanFences } from "./scan.js";
export { fencedLines } from "./scan.js";

// ---- cells -------------------------------------------------------------

/** GFM requires a literal pipe inside a cell to be escaped; a newline breaks the row. */
export function escapeCell(text: string): string {
  // Escape only unescaped pipes: a title that already contains `\|` must not
  // become `\\|`, which would split the cell (E108).
  // A pipe is already escaped only when an *odd* number of backslashes
  // precede it: `\\|` is a literal backslash followed by a cell break.
  return text.replace(/(\\*)\|/g, (_, slashes: string) => slashes.length % 2 === 1 ? `${slashes}|` : `${slashes}\\|`)
    .replace(/[\r\n]+/g, " ");
}

/**
 * Split a table row into raw cells, keeping every character between the
 * unescaped pipes (so whitespace and padding survive a round trip).
 * `"| a | b |"` → `["", " a ", " b ", ""]`.
 */
function rawCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let slashes = 0;
  for (const char of line.trim()) {
    if (char === "|" && slashes % 2 === 0) {
      cells.push(cell);
      cell = "";
    } else {
      if (char === "|") cell = cell.slice(0, -1);
      cell += char;
    }
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  cells.push(cell);
  return cells;
}

/**
 * Inverse of `escapeCell`, matching how `splitCells` reads a cell: a pipe
 * after an odd number of backslashes loses one of them; `\\|` keeps both.
 */
export function unescapeCell(text: string): string {
  return text.replace(/(\\+)\|/g, (_, slashes: string) => slashes.length % 2 === 1 ? `${slashes.slice(1)}|` : `${slashes}|`);
}

/** Unescaped text of data cell `index` (0 = `#`, 1 = `状态`, …). */
export function cellAt(line: string, index: number): string {
  const raw = rawCells(line)[index + 1];
  return unescapeCell((raw ?? "").trim());
}

/** Offsets of the unescaped `|` characters in `text`. */
function pipeOffsets(text: string): number[] {
  const out: number[] = [];
  let slashes = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "|" && slashes % 2 === 0) out.push(i);
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  return out;
}

/**
 * Replace data cell `index` by splicing the original text, keeping the
 * padding of the cell it overwrites.
 *
 * Splicing rather than re-joining decoded cells is deliberate: an escaped
 * `\|` in a cell that is *not* being replaced must survive untouched, and
 * re-joining the decoded cells would silently un-escape it (turning a 5-cell
 * row into a 6-cell one).
 */
export function replaceCell(line: string, index: number, value: string): string {
  const pipes = pipeOffsets(line);
  if (pipes.length < 2 || index < 0) return line;
  const start = pipes[index];
  // A row without a trailing pipe ends its last cell at end-of-line.
  const end = pipes[index + 1] ?? line.length;
  if (start === undefined) return line;
  const original = line.slice(start + 1, end);
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  const escaped = escapeCell(value);
  const trailingSlashes = /\\+$/.exec(escaped)?.[0].length ?? 0;
  const safeTrail = trail || (pipes[index + 1] != null && trailingSlashes % 2 === 1 ? " " : "");
  return `${line.slice(0, start + 1)}${lead}${escaped}${safeTrail}${line.slice(end)}`;
}

export function formatRow(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

// ---- lines -------------------------------------------------------------

/** Insert `added` so that the first added line lands on 1-indexed `at`. */
export function insertLines(lines: string[], at: number, added: string[]): string[] {
  return [...lines.slice(0, at - 1), ...added, ...lines.slice(at - 1)];
}

/**
 * Insert a block (a body, an archive) at 1-indexed `at` so that exactly one
 * blank line separates it from non-blank neighbours. `insertLines` alone left
 * `### Issue N:` glued to the previous body when that body was the last thing
 * in 正文 and ended without a blank line (dogfood #48).
 */
export function insertBlock(lines: string[], at: number, block: string[]): string[] {
  let start = 0;
  let end = block.length;
  while (start < end && block[start]!.trim() === "") start++;
  while (end > start && block[end - 1]!.trim() === "") end--;
  const core = block.slice(start, end);
  const before = lines[at - 2];
  const after = lines[at - 1];
  const padded = [
    ...(before !== undefined && before.trim() !== "" ? [""] : []),
    ...core,
    ...(after !== undefined && after.trim() !== "" ? [""] : []),
  ];
  return insertLines(lines, at, padded);
}

/** Remove `count` lines starting at 1-indexed `at`. */
export function removeLines(lines: string[], at: number, count: number): string[] {
  return [...lines.slice(0, at - 1), ...lines.slice(at - 1 + count)];
}

// ---- tables ------------------------------------------------------------

/** The physical range of a table, header and separator included. */
export function tableRange(
  ledger: ReturnType<typeof import("./ledger.js").parseLedger>,
  kind: TableKind,
): { start: number; end: number } | undefined {
  const title = kind === "open" ? "索引" : "已关闭";
  const section = ledger.sections.find((candidate) => candidate.level === 2 && candidate.title === title);
  if (!section) return undefined;
  const block = ledger.blocks.find(
    (candidate) => candidate.line > section.line_start && candidate.line <= section.line_end,
  );
  if (!block) return undefined;
  return { start: block.line, end: block.line + block.rows.length - 1 };
}

/** `true` when every data row in the table is ascending by first id. */
export function ascendingRows(rows: LedgerRow[]): boolean {
  return rows.every((row, index) => index === 0 || rows[index - 1]!.ids[0]!.start < row.ids[0]!.start);
}

// ---- fences ------------------------------------------------------------

/** True when the last line leaves a code fence open. */
export function endsInFence(lines: string[], inBody = false): boolean {
  return scanFences(lines, inBody).unclosed !== undefined;
}

// ---- bodies ------------------------------------------------------------

/**
 * The one archive format for a closed issue's body kept in 附录, written by
 * `close --keep-body` and by `adopt`, read back by `reopen`, renamed by
 * `rename`, and reported by `check` (W250/W251/W252). It is deliberately not
 * an `Issue N:` heading: 附录 must not hold issue headings (E123).
 */
export { ARCHIVE_HEADING, KEPT_BODY_VERSION, KEPT_BODY_VERSION_V2, KEPT_BODY_VERSION_V3, KEPT_BODY_START, KEPT_BODY_LINES_PREFIX, keptBodyLinesMarker, KEPT_BODY_SEPARATOR, KEPT_BODY_END } from "./ledger.js";
export const archiveHeading = (id: string, summary: string) => `### #${id} ${summary}（已关闭，正文保留）`;

/** Serialize a counted v3 payload; payload records may contain marker text verbatim. */
export function serializeKeptBodyV3(id: string, summary: string, payloadLines: string[]): string[] {
  return [
    archiveHeading(id, summary),
    KEPT_BODY_VERSION_V3,
    KEPT_BODY_START,
    keptBodyLinesMarker(payloadLines.length),
    ...payloadLines,
    "",
    KEPT_BODY_END,
  ];
}

export function bodySkeleton(id: string, title: string, criteria = ""): string[] {
  return [
    `### Issue ${id}: ${title}`,
    "",
    "**现象**：",
    "",
    "**根因**：",
    "",
    "**期望**：",
    "",
    `**验收判据**：${criteria}`,
    "",
  ];
}

/** A line-level view of comments in one issue body; raw lines are never changed. */
export type BodyVisibility = { hidden: boolean[]; text: string[] };
export function bodyVisibility(lines: string[], fenced: boolean[]): BodyVisibility {
  const hidden = Array(lines.length).fill(false) as boolean[];
  const text = [...lines];
  const multilineCode = multilineInlineCodeRanges(lines, fenced);
  let inComment = false;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    // The issue heading is a structural boundary, not body prose. A literal
    // HTML opener in its title must not hide the body's labels (dogfood #100).
    if (index === 0 && /^ {0,3}#{1,3}[ \t]+/.test(raw)) continue;
    if (fenced[index] || /^ {0,3}\|/.test(raw)) continue;
    if (inComment) {
      hidden[index] = true;
      const closeAt = raw.indexOf("-->");
      if (closeAt >= 0) {
        inComment = false;
        text[index] = raw.slice(closeAt + 3);
        hidden[index] = text[index]!.trim() === "";
      }
      continue;
    }
    if (!raw.includes("<!--")) continue;
    const code = inlineCodeRanges(raw);
    const crossLineCode = multilineCode.get(index) ?? [];
    let cursor = 0;
    let rendered = "";
    for (;;) {
      const open = raw.indexOf("<!--", cursor);
      if (open < 0) {
        rendered += raw.slice(cursor);
        break;
      }
      const codeRange = code.find(([start, end]) => start <= open && open < end) ??
        crossLineCode.find(([start, end]) => start <= open && open < end);
      if (codeRange) {
        rendered += raw.slice(cursor, codeRange[1]);
        cursor = codeRange[1];
        continue;
      }
      if (isEscapedMarkdownChar(raw, open)) {
        rendered += raw.slice(cursor, open + 4);
        cursor = open + 4;
        continue;
      }
      const close = raw.indexOf("-->", open + 4);
      rendered += raw.slice(cursor, open);
      if (close < 0) {
        inComment = true;
        hidden[index] = true;
        cursor = raw.length;
        break;
      }
      cursor = close + 3;
    }
    text[index] = rendered;
    if (raw.includes("<!--") && rendered.trim() === "") hidden[index] = true;
  }
  return { hidden, text };
}

/** A bold label is standalone, colon-separated, or has its colon inside bold. */
const LABEL_LINE = /^ {0,3}\*\*(?:([^*]+[:：])\*\*(?:\s*(.*))|([^*]+)\*\*(?:\s*[:：]\s*(.*)|[ \t]*))$/;
const QUALIFIED_LABEL_START = /^ {0,3}\*\*([^*]+)\*\*(?=[（(])/;
function qualifiedLabelLine(line: string): { label: string; rest: string } | undefined {
  const start = QUALIFIED_LABEL_START.exec(line);
  if (!start) return;
  const from = start[0].length;
  const closers: string[] = [];
  for (let index = from; index < line.length; index++) {
    const char = line[index];
    if (char === "(" || char === "（") closers.push(char === "(" ? ")" : "）");
    else if (char === ")" || char === "）") {
      if (closers.pop() !== char) return;
      if (closers.length !== 0) continue;
      const rest = /^[ \t]*[:：][ \t]*(.*)$/.exec(line.slice(index + 1));
      if (rest) return { label: start[1]! + line.slice(from, index + 1), rest: rest[1]! };
      return;
    }
  }
}
function parseLabelLine(line: string): { label: string; rest: string } | undefined {
  const match = LABEL_LINE.exec(line);
  if (!match) return qualifiedLabelLine(line);
  return match[1] != null
    ? { label: match[1], rest: match[2] ?? "" }
    : { label: match[3]!, rest: match[4] ?? "" };
}

/** `**验收判据：**` and `**验收判据**：` name the same label. */
export const labelName = (raw: string) => raw.trim().replace(/[:：]\s*$/, "").trim();
export function* bodyLabels(lines: string[], start: number, end: number, fenced = fencedLines(lines, true), visibility = bodyVisibility(lines, fenced)) {
  for (let line = start; line <= end && line <= lines.length; line++) {
    if (fenced[line - 1] || visibility.hidden[line - 1]) continue;
    const match = parseLabelLine(visibility.text[line - 1]!);
    if (match) yield { label: labelName(match.label), line };
  }
}

/** Suggest a correction without treating a loosely named block as criteria. */
export function criteriaLabelHint(lines: string[], offset = 0, fenced?: boolean[]) {
  for (const { label, line } of bodyLabels(lines, 1, lines.length, fenced)) {
    if (label !== "验收判据" && label.includes("判据")) {
      return { line: line + offset, message: `L${line + offset}: rename **${label}** to **验收判据** if this block contains acceptance criteria` };
    }
  }
}

export function isCriteriaAlias(label: string): boolean {
  return label === "判据" || label.endsWith("的判据") || ["验收判据", "追加判据", "修复判据", "判据（"].some((prefix) => label.startsWith(prefix));
}

export type CriteriaAliasRepair = {
  candidates: { label: string; line: number }[];
  eligible?: { label: string; line: number };
  reason?: string;
};

/** Share the exact automatic-rename eligibility used by `sync --criteria-labels`. */
export function criteriaAliasRepair(lines: string[], offset = 0, fenced = fencedLines(lines, true)): CriteriaAliasRepair | undefined {
  const labels = [...bodyLabels(lines, 1, lines.length, fenced)];
  const canonical = labels.find(({ label }) => label === "验收判据");
  const aliases = labels.filter(({ label }) => label !== "验收判据" && isCriteriaAlias(label));
  const relevant = canonical ? aliases.filter(({ line }) => line > canonical.line) : aliases;
  if (relevant.length === 0) return undefined;
  const candidates = relevant.map(({ label, line }) => ({ label, line: line + offset }));
  if (canonical) return { candidates, reason: "a canonical **验收判据** label already exists" };
  const nonEmpty = relevant.filter(({ label, line }) => {
    const block = labelBlock(lines, line, lines.length, label, fenced);
    return !!block && blockHasVisibleContent(block.lines) && !!block.text.trim();
  });
  if (nonEmpty.length > 1) return { candidates, reason: "multiple nearby criteria labels need review" };
  if (nonEmpty.length === 0) return { candidates, reason: "all nearby criteria labels are empty" };
  const eligible = nonEmpty[0]!;
  const visibility = bodyVisibility(lines, fenced);
  if (qualifiedLabelLine(visibility.text[eligible.line - 1]!)) {
    return { candidates, reason: "a qualifier outside the bold label needs manual review" };
  }
  return { candidates, eligible: { label: eligible.label, line: eligible.line + offset } };
}

/** Every non-empty recognized supplement after the canonical block may hold unpromoted criteria. */
export function criteriaSupplementHints(lines: string[], offset = 0, fenced?: boolean[]) {
  return criteriaOccurrences(lines, offset, fenced)
    .filter((occurrence) => occurrence.kind === "supplement" && !occurrence.alreadyCovered)
    .map(({ label, line }) => ({ line, label, message: `L${line}: review **${label}**; it is not included in the canonical criteria` }));
}
export function criteriaSupplementHint(lines: string[], offset = 0, fenced?: boolean[]) {
  return criteriaSupplementHints(lines, offset, fenced)[0];
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
type ListMargins = { startColumn: number; contentColumn: number };
function advanceColumns(text: string, start = 0): number {
  let column = start;
  for (const char of text) column = char === "\t" ? column + 4 - column % 4 : column + 1;
  return column;
}
function listItemMargins(line: string): ListMargins | undefined {
  const match = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)/.exec(line);
  if (!match) return undefined;
  const startColumn = advanceColumns(match[1]!);
  const afterMarker = advanceColumns(match[2]!, startColumn);
  return { startColumn, contentColumn: advanceColumns(match[3]!, afterMarker) };
}
function isListContinuation(line: string, margins: ListMargins[]): boolean {
  const indent = /^[ \t]+/.exec(line)?.[0];
  if (!indent) return false;
  const column = advanceColumns(indent);
  return margins.some((margin) => column >= margin.contentColumn);
}
const UNORDERED_MARKER = /^\s*[-*+]\s+/;

export type LabelBlock = {
  label: string;
  /** 1-indexed line of the `**label**` line, in the coordinates passed in. */
  line: number;
  /** The label line and everything that belongs to it, verbatim. */
  lines: string[];
  /**
   * One-line form for a table cell or JSON: paragraphs and list items are
   * joined with `；`, soft wraps with a space, unordered markers dropped.
   */
  text: string;
  /** Inline label content before flattening or whitespace normalization. */
  inline: string;
  boundary?: { line: number; sawListItem: boolean };
  ambiguousProse?: number;
};

/**
 * The block a `**label**` owns inside `lines[start-1..end]` (1-indexed): from
 * the label to the next label line, heading, or the end of the range. Blank
 * lines do not end it — `**验收判据**：` followed by a blank line and a list is
 * the most common way to write criteria, and what `new`'s skeleton invites.
 * Fenced lines are content (never a label or a boundary), minus the fences.
 */
export function labelBlock(
  lines: string[],
  start: number,
  end: number,
  label: string,
  fenced = fencedLines(lines, true),
  visibility = bodyVisibility(lines, fenced),
): LabelBlock | undefined {
  const last = Math.min(end, lines.length);
  for (let line = start; line <= last; line++) {
    if (fenced[line - 1] || visibility.hidden[line - 1]) continue;
    const match = parseLabelLine(visibility.text[line - 1]!);
    if (!match || labelName(match.label) !== label) continue;
    let stop = line + 1;
    let boundary: LabelBlock["boundary"];
    let ambiguousProse: number | undefined;
    let nextContinuation = 0;
    const listMargins: ListMargins[] = [];
    while (stop <= last) {
      const text = visibility.text[stop - 1]!;
      if (!fenced[stop - 1] && !visibility.hidden[stop - 1]) {
        if (parseLabelLine(text)) {
          boundary = { line: stop, sawListItem: listMargins.length > 0 };
          break;
        }
        if (/^ {0,3}#{1,6}(?:\s|$)/.test(text)) break;
      }
      if (label === "验收判据" && listMargins.length > 0 && !visibility.hidden[stop - 1] && text.trim() === "") {
        let look = stop + 1;
        while (look <= last && (visibility.hidden[look - 1] || visibility.text[look - 1]!.trim() === "")) look++;
        if (look <= last && !fenced[look - 1] && parseLabelLine(visibility.text[look - 1]!)) {
          boundary = { line: look, sawListItem: true };
          break;
        }
        if (look <= last && !fenced[look - 1] && !LIST_ITEM.test(visibility.text[look - 1]!) && !isListContinuation(visibility.text[look - 1]!, listMargins)) {
          const proseLine = look;
          if (nextContinuation <= look) {
            for (; look <= last; look++) {
              const candidate = visibility.text[look - 1]!;
              if (visibility.hidden[look - 1]) continue;
              if (!fenced[look - 1] && (parseLabelLine(candidate) != null || /^ {0,3}#{1,6}(?:\s|$)/.test(candidate))) break;
              if (LIST_ITEM.test(candidate) || isListContinuation(candidate, listMargins) || fenced[look - 1] || /^[ \t]*(?:`{3,}|~{3,})/.test(candidate)) {
                nextContinuation = look;
                break;
              }
            }
            if (nextContinuation < proseLine) break;
          }
          ambiguousProse ??= proseLine;
        }
      }
      if (!fenced[stop - 1] && !visibility.hidden[stop - 1]) {
        const item = listItemMargins(text);
        if (item) {
          while (listMargins.length > 0) {
            const parent = listMargins.at(-1)!;
            if (item.startColumn > parent.startColumn && item.startColumn >= parent.contentColumn) break;
            listMargins.pop();
          }
          listMargins.push(item);
        }
      }
      stop++;
    }
    const own = lines.slice(line - 1, stop - 1);
    while (own.length > 1 && own.at(-1)!.trim() === "") own.pop();

    const segments: string[] = [];
    let current: string[] = [];
    let blank = false;
    const flush = () => {
      if (current.length) segments.push(current.join(" "));
      current = [];
    };
    const first = match.rest.trim();
    if (first) current.push(first);
    // Inside the block, fences may be indented by a list item; they are still
    // examples when extended.
    const ownFenced = fencedLines(own, true);
    for (let index = 1; index < own.length; index++) {
      const raw = own[index]!;
      if (visibility.hidden[line + index - 1]) continue;
      const visibleRaw = visibility.text[line + index - 1]!;
      if (visibleRaw.trim() === "") {
        blank = true;
        continue;
      }
      // Fence delimiters are markup; the code inside is kept, one line each.
      if (ownFenced[index] && /^[ \t]*(`{3,}|~{3,})/.test(raw)) {
        flush();
        blank = false;
        continue;
      }
      // A line that is this very label inside a fence is an *example* of the
      // label, not a second criteria block (dogfood #61: `close` already
      // promised this). Other bold-leading lines in the fence are content —
      // Gherkin steps (`**Given** …`) must survive (review 13).
      const fencedLabel = /^[ \t]*\*\*([^*]+)\*\*/.exec(raw);
      if (ownFenced[index] && fencedLabel && labelName(fencedLabel[1]!) === label) {
        flush();
        blank = false;
        continue;
      }
      if (blank || LIST_ITEM.test(visibleRaw) || ownFenced[index]) flush();
      blank = false;
      current.push(visibleRaw.replace(UNORDERED_MARKER, "").trim());
      if (ownFenced[index]) flush();
    }
    flush();
    const text = joinClauses(segments).replace(/[ \t]+/g, " ").trim();
    return { label, line, lines: own, text, inline: match.rest, boundary, ambiguousProse };
  }
  return undefined;
}

export function labelBlocksIn(
  lines: string[],
  start = 1,
  end = lines.length,
  fenced = fencedLines(lines, true),
  visibility = bodyVisibility(lines, fenced),
): LabelBlock[] {
  const blocks: LabelBlock[] = [];
  for (const { label, line } of bodyLabels(lines, start, end, fenced, visibility)) {
    const found = labelBlock(lines, line, end, label, fenced, visibility);
    if (found) blocks.push(found);
  }
  return blocks;
}

/** The `**验收判据**` block of a body as one line; undefined when absent or empty. */
/** `；`-join, but a part that already ends in a clause mark keeps its own. */
export function joinClauses(parts: string[]): string {
  return parts.reduce((out, part, at) => (at === 0 ? part : /[；;]\s*$/.test(out) ? out + part : `${out}；${part}`), "");
}

/**
 * Whether a label block has anything a reader can see. A bare HTML comment
 * renders as nothing, so a block holding only comments is empty; text beside
 * a comment counts, and fenced content is visible even when it looks like a
 * comment. (The first cut flattened the block and matched greedily, which
 * swallowed `<!-- x --> 正文 <!-- y -->` — round 14 review.)
 */
function blockHasVisibleContent(own: string[]): boolean {
  const fenced = fencedLines(own, true);
  const first = parseLabelLine(own[0] ?? "")?.rest ?? "";
  const plain: string[] = [first];
  let fencedContent = false;
  for (let index = 1; index < own.length; index++) {
    const raw = own[index]!;
    if (fenced[index]) {
      if (!/^[ \t]*(`{3,}|~{3,})/.test(raw) && raw.trim() !== "") fencedContent = true;
      continue;
    }
    plain.push(raw);
  }
  if (fencedContent) return true;
  return plain.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim() !== "";
}

export function extractCriteria(
  bodyLines: string[],
  fenced = fencedLines(bodyLines, true),
  visibility = bodyVisibility(bodyLines, fenced),
): string | undefined {
  return criteriaTextFromOccurrences(criteriaOccurrences(bodyLines, 0, fenced, visibility));
}


export type CriteriaOccurrence = {
  line: number;
  label: string;
  kind: "canonical" | "supplement";
  lines: string[];
  text: string;
  alreadyCovered?: true;
};

export function criteriaTextFromOccurrences(occurrences: CriteriaOccurrence[]): string | undefined {
  const texts: string[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.kind === "canonical" && occurrence.text !== "" && !texts.includes(occurrence.text)) {
      texts.push(occurrence.text);
    }
  }
  return texts.length > 0 ? joinClauses(texts) : undefined;
}

// Automatic rename is deliberately stricter than the set of blocks that
// require review before deleting a body.
function isCriteriaSupplement(label: string): boolean {
  if (label === "关闭时判据") return false;
  return isCriteriaAlias(label) || /判据(?:（[^）]*）|\([^)]*\))?$/.test(label) ||
    ["判定标准", "完成标准", "验收标准", "必须满足"].includes(label);
}

export function isCriteriaLabel(label: string): boolean {
  return label === "验收判据" || isCriteriaSupplement(label);
}

function criteriaSourceKey(block: LabelBlock): string {
  const content = block.lines.slice(1);
  if (block.inline.trim() !== "") content.unshift(block.inline);
  const first = content.findIndex((line) => line.trim() !== "");
  return first < 0 ? "" : JSON.stringify([block.text, ...content.slice(first)]);
}

export function criteriaOccurrencesFromLabelBlocks(blocks: LabelBlock[], offset = 0): CriteriaOccurrence[] {
  const firstCanonical = blocks.findIndex(({ label }) => label === "验收判据");
  if (firstCanonical < 0) return [];
  const canonicalSources = new Set(blocks.filter(({ label, text }) => label === "验收判据" && text !== "").map(criteriaSourceKey));
  const occurrences: CriteriaOccurrence[] = [];
  for (let index = firstCanonical; index < blocks.length; index++) {
    const found = blocks[index]!;
    const kind = found.label === "验收判据" ? "canonical" : "supplement";
    if (kind === "supplement" && !isCriteriaSupplement(found.label)) continue;
    if (kind === "supplement" && found.text === "") continue;
    const alreadyCovered = kind === "supplement" && canonicalSources.has(criteriaSourceKey(found));
    occurrences.push({ line: found.line + offset, label: found.label, kind, lines: found.lines, text: found.text,
      ...(alreadyCovered ? { alreadyCovered: true } : {}),
    });
  }
  return occurrences;
}

/** Preserve every canonical and recognized later supplement block in source order. */
export function criteriaOccurrences(
  lines: string[],
  offset = 0,
  fenced = fencedLines(lines, true),
  visibility = bodyVisibility(lines, fenced),
): CriteriaOccurrence[] {
  return criteriaOccurrencesFromLabelBlocks(labelBlocksIn(lines, 1, lines.length, fenced, visibility), offset);
}

export function criteriaBoundaryHints(
  lines: string[],
  offset = 0,
  fenced = fencedLines(lines, true),
  visibility = bodyVisibility(lines, fenced),
  blocks = labelBlocksIn(lines, 1, lines.length, fenced, visibility),
): { line: number; detail: string }[] {
  const hints: { line: number; detail: string }[] = [];
  for (const block of blocks) {
    if (block.label !== "验收判据") continue;
    if (block.ambiguousProse != null) {
      hints.push({ line: block.ambiguousProse + offset, detail: "prose between criteria and a later list or fence may be a separate section" });
    }
    const boundary = block.boundary;
    if (!boundary?.sawListItem) continue;
    const standalone = /^ {0,3}\*\*([^*]+)\*\*[ \t]*$/.exec(visibility.text[boundary.line - 1]!);
    if (!standalone || isCriteriaLabel(labelName(standalone[1]!))) continue;
    const stop = blocks.find(({ line }) => line > boundary.line)?.line ?? lines.length + 1;
    for (let next = boundary.line; next < stop - 1; next++) {
      if (visibility.hidden[next] || fenced[next]) continue;
      const text = visibility.text[next]!;
      if (/^ {0,3}#{1,6}(?:\s|$)/.test(text)) break;
      if (LIST_ITEM.test(text)) {
        hints.push({ line: boundary.line + offset, detail: `standalone bold label **${standalone[1]}** separates possible criteria items` });
        break;
      }
    }
  }
  return hints;
}

// ---- controlled blocks -------------------------------------------------

export function statusBlockLines(): string[] {
  return [
    "| 状态 | 分类 |",
    "|---|---|",
    ...Object.entries(STATUS_CLASSES).map(([status, kind]) => `| ${status} | ${kind} |`),
  ];
}

export function guideBlockLines(): string[] {
  return [
    "| 你想做什么 | 命令 |",
    "|---|---|",
    "| 查看开放项 | `issuemd list FILE` |",
    "| 读一条 | `issuemd show FILE ID` |",
    "| 新增 | `issuemd new FILE --title \"…\"` |",
    "| 关闭 | `issuemd close FILE ID --criteria-from-body` |",
    "| 改状态 | `issuemd status FILE ID 状态` |",
    "| 重命名 | `issuemd rename FILE ID \"新标题\"` |",
    "| 校验 | `issuemd check FILE` |",
  ];
}

/**
 * Locate `begin` / `end` markers, optionally only inside one section
 * (`range` is a 1-indexed inclusive line span). Markers in another section —
 * even indented inside a list item — must not count: only the section that
 * owns the block decides whether the pair is valid.
 */
export function markerPair(
  lines: string[],
  begin: string,
  end: string,
  range?: { start: number; end: number },
): { begin: number; end: number } | null {
  const fenced = fencedLines(lines);
  const lo = range ? range.start - 1 : 0;
  const hi = range ? Math.min(range.end, lines.length) : lines.length;
  const indexes = (needle: string) => {
    const out: number[] = [];
    for (let index = Math.max(0, lo); index < hi; index++) {
      if (!fenced[index] && lines[index]!.trim() === needle) out.push(index);
    }
    return out;
  };
  const begins = indexes(begin);
  const ends = indexes(end);
  if (begins.length !== 1 || ends.length !== 1) return null;
  if (ends[0]! <= begins[0]!) return null;
  return { begin: begins[0]!, end: ends[0]! };
}

/**
 * Replace the lines strictly between `begin` and `end` markers. Returns the
 * input unchanged when either marker is missing or duplicated — the checker
 * reports that as E112, and a write verb should never guess.
 */
export function rewriteBlock(
  lines: string[],
  begin: string,
  end: string,
  content: string[],
  range?: { start: number; end: number },
): string[] {
  // Only real markers count. A marker pair quoted inside a fenced example in
  // the appendix must not be mistaken for the controlled block.
  const pair = markerPair(lines, begin, end, range);
  if (!pair) return lines;
  return [...lines.slice(0, pair.begin + 1), ...content, ...lines.slice(pair.end)];
}