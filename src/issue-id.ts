export type IdSpan = { start: number; end: number; suffix: string };

export function parseId(value: string): IdSpan | undefined {
  const match = /^(\d+)([a-z]?)$/.exec(value);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return { start: number, end: number, suffix: match[2] };
}

export function parseIds(cell: string): IdSpan[] | undefined {
  const spans: IdSpan[] = [];
  for (const part of cell.split(/[,，、/]/)) {
    const token = part.trim();
    const range = /^(\d+)\s*[–~-]\s*(\d+)$/.exec(token);
    if (range) {
      const first = parseId(range[1]);
      const last = parseId(range[2]);
      if (!first || !last || first.start > last.start) return undefined;
      spans.push({ start: first.start, end: last.start, suffix: "" });
    } else {
      const id = parseId(token);
      if (!id) return undefined;
      spans.push(id);
    }
  }
  return spans;
}

export const idText = (id: IdSpan): string => `${id.start}${id.suffix}`;
export const compareIds = (a: IdSpan, b: IdSpan): number =>
  a.start - b.start || (a.suffix < b.suffix ? -1 : a.suffix > b.suffix ? 1 : 0);

/** A compact set of IDs with sorted disjoint intervals per suffix. */
export class IdSet {
  private readonly groups = new Map<string, IdSpan[]>();
  readonly count: bigint;

  constructor(spans: readonly IdSpan[]) {
    for (const span of [...spans].sort(compareIds)) {
      const group = this.groups.get(span.suffix) ?? [];
      const last = group.at(-1);
      if (last && span.start <= last.end) {
        last.end = Math.max(last.end, span.end);
      } else {
        group.push({ ...span });
      }
      this.groups.set(span.suffix, group);
    }
    let count = 0n;
    for (const group of this.groups.values()) {
      for (const span of group) count += BigInt(span.end - span.start + 1);
    }
    this.count = count;
  }

  firstOverlap(span: IdSpan): number | undefined {
    const group = this.groups.get(span.suffix);
    if (!group) return undefined;
    let low = 0;
    let high = group.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (group[mid].end < span.start) low = mid + 1;
      else high = mid;
    }
    const match = group[low];
    return match && match.start <= span.end ? Math.max(match.start, span.start) : undefined;
  }

  has(id: IdSpan): boolean {
    return this.firstOverlap(id) !== undefined;
  }
}
