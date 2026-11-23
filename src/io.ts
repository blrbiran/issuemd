/**
 * Byte-faithful document I/O.
 *
 * A ledger is edited by agents and read by humans, so every write must change
 * only the lines it means to change. The original file's encoding markers —
 * a UTF-8 BOM, its line-ending style, whether it ends with a newline, and its
 * permission bits — are recorded on read and restored on write.
 */

import { closeSync, fsyncSync, openSync, renameSync, statSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export type Document = {
  /** Source with BOM removed and CRLF normalised to LF. */
  text: string;
  bom: boolean;
  eol: "\n" | "\r\n";
  finalNewline: boolean;
  stat: { size: number; mtimeMs: number };
};

export type ExpectedStat = { size: number; mtimeMs: number };

export function readDocument(path: string): Document {
  const raw = readFileSync(path);
  const { size, mtimeMs } = statSync(path);
  let text = raw.toString("utf8");
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);

  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  if (eol === "\r\n") text = text.replaceAll("\r\n", "\n");

  const finalNewline = text.endsWith("\n");
  return { text, bom, eol, finalNewline, stat: { size, mtimeMs } };
}

/** Rebuild the on-disk byte string from logical lines. */
export function joinDocument(lines: string[], doc: Pick<Document, "bom" | "eol">): string {
  const body = lines.join("\n");
  const out = doc.eol === "\n" ? body : body.replaceAll("\n", "\r\n");
  return (doc.bom ? "﻿" : "") + out;
}

/**
 * Write `content` to `path` atomically, keeping its permission bits.
 *
 * `expected`, when supplied, is the stat captured when the file was read. If
 * the file changed in the meantime the write is refused and `stale` is
 * returned, so a concurrent edit is never silently overwritten.
 */
export function writeAtomically(
  path: string,
  content: string,
  expected?: ExpectedStat,
): { ok: true } | { ok: false; stale: true } {
  if (expected) {
    const now = statSync(path);
    if (now.size !== expected.size || now.mtimeMs !== expected.mtimeMs) {
      return { ok: false, stale: true };
    }
  }

  const mode = statSync(path).mode & 0o777;
  const temp = join(dirname(path), `.${process.pid}.${Date.now()}.issuemd.tmp`);
  const fd = openSync(temp, "w", mode);
  try {
    const bytes = Buffer.from(content, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  return { ok: true };
}