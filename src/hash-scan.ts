import { inlineCodeRanges, multilineInlineCodeRanges } from "./scan.js";

export type HashSpan = { hash: string; start: number; end: number };

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Find W202-shaped tokens in one original source line.
 * Offsets are UTF-16 code units so callers can slice/insert without re-encoding.
 * UUIDs and all-numeric date/timestamp runs are excluded using the checker's
 * existing classification rule.
 */
export function hashSpans(text: string): HashSpan[] {
  const searchable = text.replace(UUID, (uuid) => " ".repeat(uuid.length));
  const spans: HashSpan[] = [];
  for (const match of searchable.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    const hash = match[0];
    if (!/[a-f]/.test(hash) && hash.length !== 40) continue;
    const start = match.index!;
    spans.push({ hash, start, end: start + hash.length });
  }
  return spans;
}

export type HashRepairContext = {
  links: Map<number, [number, number][]>;
  tags: Map<number, [number, number][]>;
  multilineCode: Map<number, [number, number][]>;
};

function addRange(ranges: Map<number, [number, number][]>, line: number, start: number, end: number) {
  if (end <= start) return;
  const current = ranges.get(line);
  if (current) current.push([start, end]);
  else ranges.set(line, [[start, end]]);
}

function referenceLabelRanges(lines: string[], links: Map<number, [number, number][]>): void {
  const definitions = new Set<string>();
  for (const line of lines) {
    const match = /^ {0,3}\[([^\]]+)\]:/.exec(line);
    if (match) definitions.add(match[1]!.trim().toLowerCase());
  }
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line]!;
    for (const match of text.matchAll(/(!?)\[([^\]]+)\]/g)) {
      const start = match.index! + match[1]!.length + 1;
      const label = match[2]!.trim().toLowerCase();
      if (!definitions.has(label)) continue;
      const after = match.index! + match[0].length;
      if (/^\s*\[[^\]]+\]:/.test(text) && match.index! === text.indexOf("[")) continue;
      const next = text[after];
      if (next === "(") continue;
      addRange(links, line, start, start + match[2]!.length);
    }
  }
}

function referenceTitleRanges(lines: string[], links: Map<number, [number, number][]>): void {
  for (let line = 0; line < lines.length; line++) {
    if (!/^ {0,3}\[[^\]]+\]:/.test(lines[line]!)) continue;
    for (let titleLine = line + 1; titleLine < lines.length; titleLine++) {
      const next = lines[titleLine]!;
      if (!/^ {0,3}["'(]/.test(next)) break;
      addRange(links, titleLine, 0, next.length);
      if (/["')]\s*$/.test(next)) break;
    }
  }
}

export function hashRepairRanges(lines: string[], fenced: boolean[]): HashRepairContext {
  const links = markdownLinkDestinationRanges(lines);
  referenceLabelRanges(lines, links);
  referenceTitleRanges(lines, links);
  return {
    links,
    tags: htmlTagRanges(lines),
    multilineCode: multilineInlineCodeRanges(lines, fenced),
  };
}

export function hashRepairContextSkipReason(
  line: string,
  lineIndex: number,
  span: HashSpan,
  ranges: HashRepairContext,
): string | undefined {
  if ((ranges.links.get(lineIndex) ?? []).some(([start, end]) => span.start >= start && span.end <= end)) {
    return "Markdown link destination";
  }
  if ((ranges.tags.get(lineIndex) ?? []).some(([start, end]) => span.start >= start && span.end <= end)) {
    return "raw HTML tag or attribute";
  }
  if ((ranges.multilineCode.get(lineIndex) ?? []).some(([start, end]) => span.start >= start && span.end <= end)) {
    return "multiline inline-code span";
  }
  if (span.start > 0 && line[span.start - 1] === "\\") return "escaped by a preceding backslash";
  return undefined;
}

/** Why an otherwise-W202 source span is unsafe to wrap in inline code. */
export function hashRepairSkipReason(line: string, span: HashSpan): string | undefined {
  if (line.includes("<!--") || line.includes("-->")) return "HTML comment syntax";

  const codeRanges = inlineCodeRanges(line);
  for (const marker of line.matchAll(/`+/g)) {
    const at = marker.index!;
    if (!codeRanges.some(([start, end]) => start <= at && at < end)) return "unmatched inline-code delimiter";
  }

  for (const destination of markdownLinkDestinations(line)) {
    if (span.start >= destination.start && span.end <= destination.end) return "Markdown link destination";
  }
  if (/^\s*\[[^\]]+\]:/.test(line)) return "Markdown reference definition";

  for (const tag of htmlTagSpans(line)) {
    if (span.start >= tag.start && span.end <= tag.end) return "raw HTML tag or attribute";
  }
  if (/<[A-Za-z][^>]*$/.test(line)) return "unterminated raw HTML tag";

  for (const email of line.matchAll(/<?[A-Z0-9.!#$%&'*+\/?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z0-9-]+>?/gi)) {
    const start = email.index!;
    const end = start + email[0].length;
    if (span.start >= start && span.end <= end) return "email autolink";
  }
  for (const url of line.matchAll(/(?:\b[a-z][a-z0-9+.-]{0,31}:\/\/|\bwww\.)[^\s<>]+/gi)) {
    const start = url.index!;
    const end = start + url[0].length;
    if (span.start >= start && span.end <= end) return "bare URL";
  }
  return undefined;
}

function inlineLinkClose(source: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let at = from; at < source.length; at++) {
    const char = source[at]!;
    if (char === "\\") { at++; continue; }
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      if (depth === 0) return at;
      depth--;
    }
  }
  return source.length;
}

export function markdownLinkDestinationRanges(lines: string[]): Map<number, [number, number][]> {
  const source = lines.join("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const ranges = new Map<number, [number, number][]>();
  const add = (start: number, end: number) => {
    if (end <= start) return;
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid]! <= start) low = mid + 1;
      else high = mid;
    }
    let line = Math.max(0, low - 1);
    while (line < lines.length && lineStarts[line]! < end) {
      const from = Math.max(start, lineStarts[line]!) - lineStarts[line]!;
      const to = Math.min(end, lineStarts[line]! + lines[line]!.length) - lineStarts[line]!;
      if (to > from) {
        const current = ranges.get(line);
        if (current) current.push([from, to]);
        else ranges.set(line, [[from, to]]);
      }
      line++;
    }
  };
  const escaped = (at: number) => {
    let slashes = 0;
    for (let cursor = at - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) slashes++;
    return slashes % 2 === 1;
  };
  for (let line = 0; line < lines.length; line++) {
    const definition = /^ {0,3}\[[^\]]+\]:/.exec(lines[line]!);
    if (!definition) continue;
    const lineStart = lineStarts[line]!;
    add(lineStart + definition[0].length, lineStart + lines[line]!.length);
    for (let titleLine = line + 1; titleLine < lines.length && /^[ \t]+\S/.test(lines[titleLine]!); titleLine++) {
      add(lineStarts[titleLine]!, lineStarts[titleLine]! + lines[titleLine]!.length);
    }
  }

  for (const match of source.matchAll(/\]\(/g)) {
    const closeBracket = match.index!;
    if (escaped(closeBracket)) continue;
    let cursor = closeBracket + 2;
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    if (source[cursor] === "<") {
      const start = ++cursor;
      for (; cursor < source.length; cursor++) {
        if (source[cursor] === "\\") { cursor++; continue; }
        if (source[cursor] === ">") break;
      }
      add(start, inlineLinkClose(source, cursor + 1));
      continue;
    }

    const start = cursor;
    let depth = 0;
    for (; cursor < source.length; cursor++) {
      const char = source[cursor]!;
      if (char === "\\") { cursor++; continue; }
      if (char === "(") depth++;
      else if (char === ")") {
        if (depth === 0) break;
        depth--;
      } else if (/\s/.test(char) && depth === 0) break;
    }
    add(start, inlineLinkClose(source, cursor));
  }
  return ranges;
}

export function htmlTagRanges(lines: string[]): Map<number, [number, number][]> {
  const ranges = new Map<number, [number, number][]>();
  let pending: { line: number; start: number; end: number }[] | undefined;
  let quote = "";
  const add = (line: number, start: number, end: number) => {
    if (end <= start) return;
    const current = ranges.get(line);
    if (current) current.push([start, end]);
    else ranges.set(line, [[start, end]]);
  };

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line]!;
    let at = 0;
    if (pending) {
      for (; at < text.length; at++) {
        const char = text[at]!;
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === "'" || char === '"') {
          quote = char;
        } else if (char === ">") {
          pending.push({ line, start: 0, end: at + 1 });
          for (const span of pending) add(span.line, span.start, span.end);
          pending = undefined;
          at++;
          break;
        }
      }
      if (pending) {
        pending.push({ line, start: 0, end: text.length });
        continue;
      }
    }
    for (; at < text.length; at++) {
      if (text[at] !== "<" || !/[A-Za-z/]/.test(text[at + 1] ?? "")) continue;
      let end = at + 1;
      quote = "";
      for (; end < text.length; end++) {
        const char = text[end]!;
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === "'" || char === '"') {
          quote = char;
        } else if (char === ">") {
          add(line, at, end + 1);
          at = end;
          break;
        }
      }
      if (end >= text.length) {
        pending = [{ line, start: at, end: text.length }];
        break;
      }
    }
  }
  if (pending) for (const span of pending) add(span.line, span.start, span.end);
  return ranges;
}

function markdownLinkDestinations(line: string): { start: number; end: number }[] {
  const destinations: { start: number; end: number }[] = [];
  for (const match of line.matchAll(/\]\(/g)) {
    const open = match.index! + match[0].length - 1;
    let start = open + 1;
    if (line[start] === "<") {
      start++;
      const end = line.indexOf(">", start);
      if (end >= 0 && (line[end + 1] === ")" || /\s/.test(line[end + 1] ?? ""))) destinations.push({ start, end });
      continue;
    }
    let depth = 1;
    let escaped = false;
    for (let at = start; at < line.length; at++) {
      const char = line[at]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
      } else if (char === "(") {
        depth++;
      } else if (char === ")" && --depth === 0) {
        destinations.push({ start, end: at });
        break;
      }
    }
  }
  return destinations;
}

function htmlTagSpans(line: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (let at = 0; at < line.length; at++) {
    if (line[at] !== "<" || !/[A-Za-z/]/.test(line[at + 1] ?? "")) continue;
    let quote = "";
    let end = at + 1;
    for (; end < line.length; end++) {
      const char = line[end]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === "'" || char === '"') {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    spans.push({ start: at, end: Math.min(end + 1, line.length) });
    if (end < line.length) at = end;
    else break;
  }
  return spans;
}
