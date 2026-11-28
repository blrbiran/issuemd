import { archiveInventory, bodyBlocks, parseLedger } from "./ledger.js";
import { parseId } from "./issue-id.js";
import { bodyLabels, bodyVisibility, criteriaBoundaryHints, criteriaOccurrences, endsInFence, fencedLines, insertBlock, insertLines, isCriteriaLabel, labelBlock, removeLines } from "./ledger-edit.js";
import { proseReferences } from "./ledger-search.js";

type Ledger = ReturnType<typeof parseLedger>;

type Move = {
  lines: string[];
  id: string;
  label: string;
  anchor: string;
  copied: string[];
  heading: string;
};

export type MoveEvidenceResult = { move: Move } | { error: string; code: 2 | 3 };

const fail = (error: string, code: 2 | 3 = 2): MoveEvidenceResult => ({ error, code });

function bodyFor(ledger: Ledger, id: string) {
  return bodyBlocks(ledger).filter((block) => `${block.id.start}${block.id.suffix}` === id);
}

function bodyText(ledger: Ledger, id: string): string[] | undefined {
  const block = bodyFor(ledger, id)[0];
  return block ? ledger.lines.slice(block.line, block.end) : undefined;
}

function moveAnchor(lines: string[], id: string): string {
  const html = lines.join("\n");
  const used = new Set([
    ...[...html.matchAll(/<[A-Za-z][\w:-]*\b[^>]*?\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gsi)]
      .map((match) => match[1] ?? match[2] ?? match[3]!),
    ...[...html.matchAll(/\{#([A-Za-z][\w:.-]*)\}/g)].map((match) => match[1]!),
  ]);
  const base = `issuemd-evidence-${id}`;
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix++) if (!used.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}

function archiveFingerprint(ledger: Ledger): string[] {
  const inventory = archiveInventory(ledger);
  const sections = inventory.archives.map(({ id, section }) =>
    `${id}\0${ledger.lines.slice(section.line_start - 1, section.line_end).join("\n")}`);
  const hidden = inventory.hiddenArchives.map(({ id, line, mask }) => `${id}\0${mask}\0${ledger.lines[line - 1]}`);
  return [...sections, ...hidden].sort();
}

function criteriaFingerprint(ledger: Ledger, id: string): string {
  const lines = bodyText(ledger, id) ?? [];
  return JSON.stringify({
    occurrences: criteriaOccurrences(lines).map(({ label, kind, lines: source, text, alreadyCovered }) => ({ label, kind, lines: source, text, alreadyCovered })),
    boundaries: criteriaBoundaryHints(lines).map(({ detail }) => detail),
  });
}

function reservationIds(ledger: Ledger): string[] {
  return [...new Set(proseReferences(ledger).map(({ id }) => id))].sort();
}

function visibleAppendixProblem(ledger: Ledger): string | undefined {
  const inventory = archiveInventory(ledger);
  if (inventory.appendices.length > 1) return "multiple visible ## 附录 sections; review the appendix before retrying";
  const appendixLine = /^ {0,3}##[ \t]+附录(?:[ \t]+#+)?[ \t]*$/;
  const masked = ledger.lines.findIndex((line, index) => appendixLine.test(line) &&
    (inventory.masks.fenced[index] || inventory.masks.comments[index] || inventory.masks.rawHtml[index]));
  if (masked >= 0) return `an ## 附录 heading is masked at L${masked + 1}; review it before retrying`;
  if (inventory.appendices.length === 0 && endsInFence(ledger.lines)) return "the ledger ends inside a code fence; cannot safely create ## 附录";
  return undefined;
}

export function buildMoveEvidence(ledger: Ledger, id: string, requestedLabel: string): MoveEvidenceResult {
  if (!requestedLabel || requestedLabel.trim() !== requestedLabel || /[\r\n]/.test(requestedLabel)) {
    return fail("provide one exact, non-empty visible label");
  }
  const target = parseId(id);
  if (!target) return fail(`#${id} is not a valid issue id`);
  const contains = (span: { start: number; end: number; suffix: string }) =>
    span.suffix === target.suffix && span.start <= target.start && target.start <= span.end;
  const owners = ledger.rows.open.flatMap((row) => row.ids.filter(contains).map((span) => ({ row, span })));
  if (owners.length !== 1 || owners[0]!.row.ids.length !== 1 || owners[0]!.span.start !== target.start ||
      owners[0]!.span.end !== target.start || owners[0]!.span.suffix !== target.suffix) {
    return fail(`#${id} must have one exact owning open singleton row`);
  }
  const conflictingRows = ledger.rows.closed.flatMap((row) => row.ids.filter(contains).map(() => row.line));
  const conflictingUnreadable = ledger.unreadable.flatMap((row) => (row.ids ?? []).filter(contains).map(() => row.line));
  if (conflictingRows.length || conflictingUnreadable.length) {
    return fail(`#${id} also overlaps a closed or unreadable row (L${[...conflictingRows, ...conflictingUnreadable].join(", L")})`);
  }
  const bodies = bodyFor(ledger, id);
  if (bodies.length !== 1) return fail(`#${id} must have exactly one managed body block`);
  const block = bodies[0]!;
  const source = ledger.lines.slice(block.line, block.end);
  const fence = fencedLines(source, true);
  const visibility = bodyVisibility(source, fence);
  const matches = [...bodyLabels(source, 1, source.length, fence, visibility)].filter(({ label }) => label === requestedLabel);
  if (matches.length !== 1) return fail(matches.length === 0
    ? `no visible **${requestedLabel}** label in #${id}`
    : `#${id} has ${matches.length} visible **${requestedLabel}** labels; choose a unique label`);
  if (isCriteriaLabel(requestedLabel) || requestedLabel === "关闭时判据") {
    return fail(`**${requestedLabel}** is criteria and cannot be moved`);
  }
  const found = labelBlock(source, matches[0]!.line, source.length, requestedLabel, fence, visibility);
  if (!found || (found.inline.trim() === "" && !found.lines.slice(1).some((line) => line.trim() !== ""))) {
    return fail(`**${requestedLabel}** has no content to move`);
  }
  for (let index = 0; index < found.lines.length; index++) {
    const line = found.line - 1 + index;
    if (visibility.text[line] !== source[line]) {
      return fail(`**${requestedLabel}** crosses masked source text at body L${line + 1}; review the HTML comment or raw block first`);
    }
  }
  if (found.lines.some((line) => /\]\(#issuemd-evidence-[^)]+\)/.test(line))) {
    return fail(`**${requestedLabel}** is already a generated evidence link`);
  }
  const appendixProblem = visibleAppendixProblem(ledger);
  if (appendixProblem) return fail(appendixProblem);

  const copied = [...found.lines];
  const nextBody = removeLines(source, found.line, found.lines.length);
  const lines = [...ledger.lines.slice(0, block.line), ...nextBody, ...ledger.lines.slice(block.end)];
  const anchor = moveAnchor(lines, id);
  const replacement = `**${requestedLabel}**： [移动证据](#${anchor})`;
  const rewrittenBody = insertLines(nextBody, found.line, [replacement]);
  const patchedBody = [...ledger.lines.slice(0, block.line), ...rewrittenBody, ...ledger.lines.slice(block.end)];
  const heading = `### Evidence from Issue #${id}`;
  const opening = "~".repeat(Math.max(3, ...copied.flatMap((line) => [...line.matchAll(/~+/g)].map((match) => match[0].length + 1))));
  const evidence = [`<a id="${anchor}"></a>`, "", heading, "", opening, ...copied, opening];
  const refreshed = parseLedger(patchedBody.join("\n"));
  const inventory = archiveInventory(refreshed);
  const appendix = inventory.appendices[0];
  if (!appendix) {
    const withAppendix = insertBlock(patchedBody, patchedBody.length + 1, ["## 附录", "", ...evidence]);
    return { move: { lines: withAppendix, id, label: requestedLabel, anchor, copied, heading } };
  }
  const child = refreshed.sections.find((section) => section.level === 3 && section.line_start > appendix.line_start && section.line_start <= appendix.line_end);
  let at = child?.line_start ?? appendix.line_end + 1;
  if (child) {
    const childIndex = child.line_start - 1;
    if (childIndex >= 2 && patchedBody[childIndex - 1]!.trim() === "" &&
        /<[A-Za-z][\w:-]*\b[^>]*\bid\s*=/.test(patchedBody[childIndex - 2]!)) {
      at = childIndex - 1;
    }
  }
  const withEvidence = insertBlock(patchedBody, at, evidence);
  return { move: { lines: withEvidence, id, label: requestedLabel, anchor, copied, heading } };
}

export function validateMoveEvidence(before: Ledger, after: Ledger, move: Move): string | undefined {
  if (JSON.stringify(archiveFingerprint(before)) !== JSON.stringify(archiveFingerprint(after))) {
    return "an existing archive heading or payload would change";
  }
  if (JSON.stringify(reservationIds(before)) !== JSON.stringify(reservationIds(after))) {
    const prior = new Set(reservationIds(before));
    const lost = reservationIds(after).length < prior.size ? [...prior].filter((id) => !reservationIds(after).includes(id)) : [];
    return `moving this block would change prose-reference reservations${lost.length ? ` (lost ${lost.map((id) => `#${id}`).join(", ")})` : ""}`;
  }
  if (criteriaFingerprint(before, move.id) !== criteriaFingerprint(after, move.id)) {
    return `moving **${move.label}** would change canonical criteria or W268 boundaries for #${move.id}`;
  }
  const inventory = archiveInventory(after);
  const appendix = inventory.appendices.length === 1 ? inventory.appendices[0] : undefined;
  const anchorLine = `<a id="${move.anchor}"></a>`;
  const anchorIndexes = after.lines.flatMap((line, index) => line === anchorLine ? [index] : []);
  if (!appendix || anchorIndexes.length !== 1) return "the evidence destination anchor is not unique inside a single ## 附录";
  const anchorIndex = anchorIndexes[0]!;
  const destination = after.sections.find((section) => section.level === 3 && section.line_start === anchorIndex + 3 &&
    section.title === move.heading.slice(4));
  if (!destination || destination.line_start <= appendix.line_start || destination.line_start > appendix.line_end ||
      inventory.masks.fenced[destination.line_start - 1] || inventory.masks.comments[destination.line_start - 1] ||
      inventory.masks.rawHtml[destination.line_start - 1]) {
    return "the evidence destination is not one visible child of a single ## 附录";
  }
  const headingLine = destination.line_start;
  const start = headingLine - 1;
  const opening = after.lines[start + 2];
  const closeAt = start + 3 + move.copied.length;
  if (!opening || !/^~{3,}$/.test(opening) || after.lines[closeAt] !== opening ||
      move.copied.some((line) => new RegExp(`~{${opening.length},}`).test(line)) ||
      endsInFence(after.lines.slice(start + 2, closeAt + 1), true)) {
    return "the evidence source cannot be represented safely inside a closed literal fence";
  }
  if (move.copied.some((line, index) => after.lines[start + 3 + index] !== line)) return "the copied evidence records differ from the source";
  const body = bodyText(after, move.id) ?? [];
  if (!body.includes(`**${move.label}**： [移动证据](#${move.anchor})`)) return "the active body link does not point to the evidence anchor";
  return undefined;
}
