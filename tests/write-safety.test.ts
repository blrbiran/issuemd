/**
 * Write-safety regression tests for P1's byte guarantees.
 *
 * These used to run end-to-end through `set` / `rename`. Those generic
 * commands are gone, so the guarantees are asserted directly against the
 * three functions that implement them: `readDocument`, `joinDocument`,
 * `writeAtomically`. Ledger verbs add the end-to-end layer again in
 * `cli-write.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readDocument, joinDocument, writeAtomically } from "../src/io.js";
import { scan } from "../src/scan.js";

let dir: string;
function file(name: string, bytes: string | Buffer): string {
  dir ??= mkdtempSync(join(tmpdir(), "issuemd-p1-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}
const read = (path: string) => readFileSync(path);
/** Split a Document's text into physical lines without the EOF sentinel. */
const linesOf = (doc: { text: string; finalNewline: boolean }) =>
  doc.text === "" ? [] : (doc.finalNewline ? doc.text.slice(0, -1) : doc.text).split("\n");

describe("D1 — a BOM is preserved and does not hide the first heading", () => {
  test("readDocument strips it for parsing and joinDocument restores it", () => {
    const path = file("bom.md", "﻿# Title\n\n## Section\ntext\n");
    const doc = readDocument(path);
    expect(doc.bom).toBe(true);
    expect(doc.text.startsWith("# Title")).toBe(true);
    expect(scan(doc.text).map((heading) => heading.title)).toEqual(["Title", "Section"]);
    expect(joinDocument(linesOf(doc), doc).startsWith("﻿# Title")).toBe(true);
  });

  test("a BOM-free file stays BOM-free", () => {
    const path = file("no-bom.md", "# Title\n");
    expect(joinDocument(linesOf(readDocument(path)), readDocument(path))).toBe("# Title\n");
  });
});

describe("D2 — fenced heading-lookalikes are content", () => {
  test("scan ignores ## inside a fence", () => {
    const src = "# T\n\n## A\n\n```md\n## not a heading\n```\n\n## B\n";
    expect(scan(src).map((heading) => heading.title)).toEqual(["T", "A", "B"]);
  });

  test("a heading after an unclosed fence is not counted", () => {
    expect(scan("# T\n\n```\n## hidden\n").map((heading) => heading.title)).toEqual(["T"]);
  });
});

describe("D4 — line endings and the trailing-newline flag", () => {
  test("CRLF round-trips with no stray LF", () => {
    const path = file("crlf.md", "# T\r\n\r\n## A\r\n\r\nold\r\n");
    const doc = readDocument(path);
    expect(doc.eol).toBe("\r\n");
    const out = joinDocument(linesOf(doc), doc);
    expect(out).toBe("# T\r\n\r\n## A\r\n\r\nold\r\n");
    expect(out.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("an unterminated file stays unterminated", () => {
    const path = file("no-final.md", "# T\n\n## A\n\nold");
    const doc = readDocument(path);
    expect(doc.finalNewline).toBe(false);
    expect(joinDocument(["# T", "", "## A", "", "new"], doc)).toBe("# T\n\n## A\n\nnew");
  });

  test("a terminated file keeps exactly one final newline", () => {
    const path = file("final.md", "# T\n\n## A\n\nold\n");
    const doc = readDocument(path);
    expect(doc.finalNewline).toBe(true);
    expect(joinDocument(["# T", "", "## A", "", "new"], doc)).toBe("# T\n\n## A\n\nnew\n");
  });

  test("trailing blank lines are physical lines, not sentinels", () => {
    const source = "﻿# T\r\n\r\n## A\r\nbody\r\n\r\n\r\n";
    const doc = readDocument(file("blank-tail.md", source));
    expect(joinDocument(linesOf(doc), doc)).toBe(source);
  });
});

describe("write safety", () => {
  test("a successful atomic write replaces the content and keeps the mode", () => {
    const path = file("mode.md", "# T\n");
    chmodSync(path, 0o600);
    expect(writeAtomically(path, "# U\n", readDocument(path).stat)).toEqual({ ok: true });
    expect(read(path).toString()).toBe("# U\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a successful write leaves no temp file behind", () => {
    const path = file("cleanup.md", "# T\n");
    const before = readdirSync(dir).sort();
    expect(writeAtomically(path, "# U\n", readDocument(path).stat)).toEqual({ ok: true });
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  test("a stale read is rejected before writing", () => {
    const path = file("race.md", "# T\n\n## A\n\nold\n");
    const stale = readDocument(path).stat;
    const modified = "# T\n\n## A\n\nchanged elsewhere\n";
    writeFileSync(path, modified);
    utimesSync(path, new Date(stale.mtimeMs), new Date(stale.mtimeMs));
    expect(writeAtomically(path, "# T\n\n## A\n\nafter\n", stale)).toEqual({ ok: false, stale: true });
    expect(read(path).toString()).toBe(modified);
  });

  test("a replacement with the same size and mtime still invalidates the snapshot", () => {
    const path = file("replaced.md", "# Old\n");
    utimesSync(path, 10000, 10000);
    const snapshot = readDocument(path);
    const replacement = file("replacement.md", "# New\n");
    utimesSync(replacement, 10000, 10000);
    renameSync(replacement, path);
    const entries = readdirSync(dir).sort();
    expect(writeAtomically(path, "# Lost\n", snapshot.stat)).toEqual({ ok: false, stale: true });
    expect(read(path).toString()).toBe("# New\n");
    expect(readdirSync(dir).sort()).toEqual(entries);
  });

  test("a change during temp-file fsync aborts the replacement and cleans up", () => {
    const path = file("publish-race.md", "# Original\n");
    const io = new URL("../dist/src/io.js", import.meta.url).href;
    const child = spawnSync("node", ["--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { dirname } from "node:path";
      const [path, io] = process.argv.slice(1);
      const originalFsync = fs.fsyncSync;
      fs.fsyncSync = (fd) => {
        originalFsync(fd);
        fs.writeFileSync(path, "# Other writer\\n");
      };
      syncBuiltinESMExports();
      const { readDocument, writeAtomically } = await import(io);
      const before = fs.readdirSync(dirname(path)).sort();
      const result = writeAtomically(path, "# Replacement\\n", readDocument(path).stat);
      const after = fs.readdirSync(dirname(path)).sort();
      console.log(JSON.stringify({ result, before, after }));
    `, path, io], { encoding: "utf8", timeout: 5000 });
    expect(child.status).toBe(0);
    const { result, before, after } = JSON.parse(child.stdout);
    expect(result).toEqual({ ok: false, stale: true });
    expect(after).toEqual(before);
    expect(read(path).toString()).toBe("# Other writer\n");
  });

  test("a snapshot recorded by the reader still matches after an unrelated read", () => {
    const path = file("stable.md", "# T\n");
    const snapshot = readDocument(path).stat;
    readDocument(path);
    expect(writeAtomically(path, "# U\n", snapshot)).toEqual({ ok: true });
  });
});