import { inlineCodeRanges } from "./scan.js";

type ProgressCue = { cue: string; column: number };

const CUE = /已修[，,、\s]*待(?:现场)?复核|本轮已落地|已落地|仍缺(?:现场)?验证|仍缺/g;
const QUOTES = new Map([
  ["\"", "\""],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
]);

function literalRanges(text: string): [number, number][] {
  const code = inlineCodeRanges(text);
  const quotes: [number, number][] = [];
  let closer: string | undefined;
  let start = -1;
  let codeIndex = 0;
  for (let index = 0; index < text.length; index++) {
    const span = code[codeIndex];
    if (span && index >= span[0]) {
      index = span[1] - 1;
      codeIndex++;
      continue;
    }
    const char = text[index]!;
    if (char === "\\") {
      index++;
      continue;
    }
    // A word-internal apostrophe does not start or end quoted prose.
    if ((char === "'" || char === "’") && /[a-z0-9]/i.test(text[index - 1] ?? "") &&
        /[a-z0-9]/i.test(text[index + 1] ?? "")) continue;
    if (closer == null) {
      closer = QUOTES.get(char);
      start = index;
    } else if (char === closer) {
      quotes.push([start, index + 1]);
      closer = undefined;
    }
  }
  return [...code, ...quotes];
}

export function matchProgressCue(summary: string): ProgressCue | undefined {
  const quoted = literalRanges(summary);
  for (const match of summary.matchAll(CUE)) {
    const start = match.index!;
    if (quoted.some(([from, to]) => start >= from && start < to)) continue;
    return { cue: match[0], column: Array.from(summary.slice(0, start)).length + 1 };
  }
  return undefined;
}
