/**
 * Markdown heading scanner — the engine behind every read-path command.
 *
 * Instead of building a full CommonMark AST we walk the source line by line
 * and recognize only what `lilmd` actually needs: ATX headings and fenced code
 * blocks (so `#` inside code doesn't count as a heading).
 *
 * Numbers on MDN content (see BENCHMARK.md): ~180 MB/s end-to-end on a
 * 10 MB fixture, roughly 7x faster than markdown-it and ~1000x faster than
 * mdast-util-from-markdown while returning the exact same section.
 *
 * Deliberate limitations:
 * - Setext headings (`===` / `---` underlines) are NOT recognized. lilmd is
 *   aimed at agent-authored markdown where ATX is ubiquitous.
 * - HTML blocks are not detected. A `<pre>` containing an ATX-looking line
 *   would be misread as a heading. That's an acceptable tradeoff for 100x
 *   speed; a future `--strict` flag could hand off to markdown-it.
 * - Fenced code blocks *inside a list item* that are indented 4+ spaces are
 *   not recognized as fences — we only look at the first 3 columns for the
 *   fence opener. A `# fake` line inside such a block would be scanned as a
 *   heading. Rare in practice; document-your-way-out rather than fix.
 * - An unclosed fence at EOF leaves the scanner in "still in fence" state
 *   to the end of the file, so any `#`-looking lines after it are ignored.
 *   That's the conservative choice — prefer under-counting to over-counting.
 */

export type Heading = {
  /** 1..6 */
  level: number;
  /** Heading text with trailing closing hashes stripped. */
  title: string;
  /** 1-indexed line number. */
  line: number;
};

/**
 * Return every ATX heading in `src`, in document order.
 * Runs in a single pass; O(n) in source length, O(headings) in space.
 */
export function scan(src: string, outsideFence?: (line: number) => void): Heading[] {
  // A UTF-8 BOM is an encoding marker, not content; without this the first
  // heading is invisible and the file appears to have none.
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const out: Heading[] = [];
  const len = src.length;

  let i = 0;
  let lineNo = 0;

  // Fence state: when inFence is true every line is ignored until we see a
  // matching closing fence (same char, length >= opening length).
  let inFence = false;
  let fenceChar = 0; // charCode of ` or ~
  let fenceLen = 0;

  while (i <= len) {
    // Slice one line without the trailing newline. A trailing \r from CRLF
    // is stripped below.
    const start = i;
    while (i < len && src.charCodeAt(i) !== 10 /* \n */) i++;
    let line = src.slice(start, i);
    if (line.length > 0 && line.charCodeAt(line.length - 1) === 13 /* \r */) {
      line = line.slice(0, line.length - 1);
    }
    lineNo++;

    const fence = matchFence(line);
    if (fence) {
      if (!inFence && !(fence.char === 96 && fence.rest.includes("`"))) {
        inFence = true;
        fenceChar = fence.char;
        fenceLen = fence.len;
      } else if (inFence && fence.char === fenceChar && fence.len >= fenceLen && /^[ \t]*$/.test(fence.rest)) {
        inFence = false;
      }
    } else if (!inFence) {
      outsideFence?.(lineNo);
      const h = matchHeading(line, lineNo);
      if (h) out.push(h);
    }

    if (i >= len) break;
    i++; // skip the \n
  }

  return out;
}

/**
 * If `line` opens or closes a fenced code block, return the fence char code
 * (` or ~) and the number of fence characters. Otherwise null.
 *
 * A fence is 0–3 spaces, then 3+ of a single fence char, then optional info
 * string. The caller uses the remaining text to distinguish a closer from
 * a fence-like line inside the block.
 */
function matchFence(line: string): { char: number; len: number; rest: string } | null {
  // Skip up to 3 leading spaces.
  let p = 0;
  while (p < 3 && line.charCodeAt(p) === 32) p++;
  const ch = line.charCodeAt(p);
  if (ch !== 96 /* ` */ && ch !== 126 /* ~ */) return null;
  let run = 0;
  while (line.charCodeAt(p + run) === ch) run++;
  if (run < 3) return null;
  return { char: ch, len: run, rest: line.slice(p + run) };
}

/**
 * If `line` is an ATX heading, return it. Otherwise null.
 *
 * Rules (CommonMark, simplified):
 * - 0–3 spaces of indent
 * - 1–6 `#`
 * - EITHER end-of-line OR a space/tab followed by content
 * - optional closing sequence: whitespace + trailing `#`s (stripped)
 */
function matchHeading(line: string, lineNo: number): Heading | null {
  // Skip up to 3 leading spaces.
  let p = 0;
  while (p < 3 && line.charCodeAt(p) === 32) p++;
  if (line.charCodeAt(p) !== 35 /* # */) return null;

  let hashes = 0;
  while (line.charCodeAt(p + hashes) === 35) hashes++;
  if (hashes < 1 || hashes > 6) return null;

  const after = p + hashes;
  const afterCh = line.charCodeAt(after);

  // After the hashes we need either end-of-line or a space/tab. Anything else
  // (including `#` which is caught above by the hashes loop) disqualifies.
  if (after < line.length && afterCh !== 32 && afterCh !== 9 /* \t */) {
    return null;
  }

  // Trim leading whitespace of content and trailing whitespace + closing #s.
  let contentStart = after;
  while (
    contentStart < line.length &&
    (line.charCodeAt(contentStart) === 32 || line.charCodeAt(contentStart) === 9)
  ) {
    contentStart++;
  }

  let end = line.length;
  // Trim trailing whitespace first.
  while (
    end > contentStart &&
    (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)
  ) {
    end--;
  }
  // Strip closing `#`s only if they are preceded by whitespace (CommonMark
  // requires the closing sequence to be separated from the content).
  let closing = end;
  while (closing > contentStart && line.charCodeAt(closing - 1) === 35) closing--;
  if (
    closing < end &&
    (closing === contentStart ||
      line.charCodeAt(closing - 1) === 32 ||
      line.charCodeAt(closing - 1) === 9)
  ) {
    end = closing;
    while (
      end > contentStart &&
      (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)
    ) {
      end--;
    }
  }

  const title = line.slice(contentStart, end);
  return { level: hashes, title, line: lineNo };
}

/**
 * `true` for every 0-based line index that is *inside* or *is* a fence
 * (delimiters included). Both the criteria extractor and the controlled-block
 * rewriter must ignore fenced lookalikes: a code block in an issue body or the
 * appendix can legitimately contain `**验收判据**：…` or a marker pair.
 *
 * Body consumers also recognize fences relative to a list item's content margin.
 * A standalone indented code block does not open a fence.
 */
export function fencedLines(lines: string[], inBody = false): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false);
  let fence: { char: string; len: number; margin: number } | undefined;
  let listMargin = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const leading = /^[ \t]*/.exec(line)![0];
    let indent = 0;
    for (const char of leading) indent += char === "\t" ? 4 - (indent % 4) : 1;
    const text = line.slice(leading.length);
    if (fence && fence.margin > indent && text) fence = undefined;
    if (!fence && inBody && text && indent < listMargin) listMargin = 0;
    const margin = fence?.margin ?? listMargin;
    const delimiter = indent >= margin && indent - margin <= 3 ? /^(`{3,}|~{3,})(.*)$/.exec(text) : null;
    if (!fence) {
      if (delimiter && !(delimiter[1]!.startsWith("`") && delimiter[2]!.includes("`"))) {
        fence = { char: delimiter[1]![0]!, len: delimiter[1]!.length, margin };
        out[index] = true;
      } else if (inBody && indent - listMargin <= 3) {
        const item = /^(?:[-*+]|\d{1,9}[.)])( {1,4})(?=\S)/.exec(text);
        if (item) listMargin = indent + item[0].length;
      }
      continue;
    }
    out[index] = true;
    if (delimiter && delimiter[1]![0] === fence.char &&
        delimiter[1]!.length >= fence.len && /^[ \t]*$/.test(delimiter[2]!)) {
      fence = undefined;
    }
  }
  return out;
}

/** Same-line Markdown code spans delimited by equal backtick runs. */
export function inlineCodeRanges(text: string): [number, number][] {
  const ticks = [...text.matchAll(/`+/g)];
  const ranges: [number, number][] = [];
  for (let at = 0; at < ticks.length; at++) {
    const opening = ticks[at]!;
    const closingAt = ticks.findIndex((candidate, index) => index > at && candidate[0].length === opening[0].length);
    if (closingAt < 0) continue;
    const closing = ticks[closingAt]!;
    ranges.push([opening.index!, closing.index! + closing[0].length]);
    at = closingAt;
  }
  return ranges;
}
