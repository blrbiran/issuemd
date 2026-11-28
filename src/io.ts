import { randomUUID } from "node:crypto";
import {
  closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

export type ExpectedStat = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">;

export type Document = {
  /** Source with BOM removed and CRLF normalised to LF. */
  text: string;
  bom: boolean;
  eol: "\n" | "\r\n";
  finalNewline: boolean;
  stat: ExpectedStat;
};

function sameSnapshot(a: ExpectedStat, b: ExpectedStat): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export function readRaw(path: string): { raw: Buffer; stat: ExpectedStat } {
  const fd = openSync(path, "r");
  let raw: Buffer;
  let stat: Stats;
  try {
    stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("expected a regular file");
    raw = readFileSync(fd);
    if (!sameSnapshot(stat, fstatSync(fd))) throw new Error("E130 file changed while being read");
  } finally {
    closeSync(fd);
  }
  return { raw, stat };
}

export function decodeDocument(raw: Buffer): Omit<Document, "stat"> {
  let text = raw.toString("utf8");
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (eol === "\r\n") text = text.replaceAll("\r\n", "\n");
  return { text, bom, eol, finalNewline: text.endsWith("\n") };
}

export function readDocument(path: string): Document {
  const { raw, stat } = readRaw(path);
  return { ...decodeDocument(raw), stat };
}
/** The line array holds physical lines without a split sentinel at EOF. */
export function joinDocument(lines: string[], doc: Document): string {
  const text = lines.join("\n");
  const body = doc.finalNewline && lines.length > 0 ? text + "\n" : text;
  return (doc.bom ? "﻿" : "") + (doc.eol === "\r\n" ? body.replaceAll("\n", "\r\n") : body);
}

function currentFile(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeAtomically(
  path: string,
  content: string,
  expected: ExpectedStat,
): { ok: true } | { ok: false; stale: true } {
  const before = currentFile(path);
  if (before && !before.isFile()) throw new Error("expected a regular file (symbolic links are unsupported)");
  if (!before || !sameSnapshot(expected, before)) return { ok: false, stale: true };

  const temp = join(dirname(path), `.issuemd-${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  let renamed = false;
  try {
    try {
      writeFileSync(fd, content, "utf8");
      fchmodSync(fd, before.mode & 0o7777);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // An external writer can still run between lstat and rename. Check the
    // path immediately before replacing it to keep that window as small as possible.
    const now = currentFile(path);
    if (!now?.isFile() || !sameSnapshot(expected, now)) return { ok: false, stale: true };
    renameSync(temp, path);
    renamed = true;
    return { ok: true };
  } finally {
    if (!renamed) unlinkSync(temp);
  }
}
