import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { run } from "../src/cli.js";

let dir: string;
function file(name: string, bytes: string | Buffer): string {
  dir ??= mkdtempSync(join(tmpdir(), "issuemd-p1-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}
const read = (path: string) => readFileSync(path);

describe("D1 — BOM must not hide the first heading", () => {
  test("toc lists the H1 that follows a UTF-8 BOM", async () => {
    const path = file("bom.md", "﻿# Title\n\n## Section\ntext\n");
    const result = await run([path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Title");
    expect(result.stdout).toContain("2 headings");
  });

  test("a write keeps the BOM and still addresses the H1", async () => {
    const path = file("bom-write.md", "﻿# Title\n\nbody\n");
    const result = await run(["rename", path, "=Title", "Renamed"]);
    expect(result.code).toBe(0);
    expect(read(path).toString("utf8")).toBe("﻿# Renamed\n\nbody\n");
  });
});

describe("D2 — heading-lookalikes inside fences are content", () => {
  test("demote leaves fenced headings byte-identical", async () => {
    const source = "# T\n\n## A\n\nbody\n\n```md\n## not a heading\n```\n\n## B\n\nb\n";
    const path = file("fence.md", source);
    const result = await run(["demote", path, "=A"]);
    expect(result.code).toBe(0);
    expect(read(path).toString("utf8")).toContain("```md\n## not a heading\n```");
  });

  test("promote leaves fenced headings byte-identical", async () => {
    const source = "# T\n\n### A\n\n```\n#### inside\n```\n";
    const path = file("fence-promote.md", source);
    const result = await run(["promote", path, "=A"]);
    expect(result.code).toBe(0);
    const bytes = read(path).toString("utf8");
    expect(bytes).toContain("```\n#### inside\n```");
    expect(bytes).toContain("\n## A\n");
  });
});

describe("D3 — an ambiguous selector refuses instead of guessing", () => {
  test("set with two matches exits 2, lists both, writes nothing", async () => {
    const path = file("dup.md", "# T\n\n## Dup\n\none\n\n## Dup\n\ntwo\n");
    const before = read(path);
    const result = await run(["set", path, "=Dup", "--body", "X"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("L3");
    expect(result.stderr).toContain("L7");
    expect(read(path)).toEqual(before);
  });

  test("rename with several matches refuses", async () => {
    const path = file("dup-rename.md", "# T\n\n## Dup\n\na\n\n## Dup\n\nb\n");
    const result = await run(["rename", path, "=Dup", "New"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/ambiguous|more than one|2 matches/i);
  });
});

describe("D4 — the file keeps its line endings", () => {
  test("set on a CRLF file writes CRLF only", async () => {
    const path = file("crlf.md", "# T\r\n\r\n## A\r\n\r\nold\r\n");
    const result = await run(["set", path, "=A", "--body", "new"]);
    expect(result.code).toBe(0);
    const bytes = read(path).toString("utf8");
    expect(bytes.replaceAll("\r\n", "")).not.toContain("\n");
    expect(bytes).toContain("# T\r\n");
  });

  test("a file without a final newline keeps none", async () => {
    const path = file("no-final.md", "# T\n\n## A\n\nold");
    const result = await run(["set", path, "=A", "--body", "\nnew\n"]);
    expect(result.code).toBe(0);
    expect(read(path).toString("utf8")).toBe("# T\n\n## A\n\nnew");
  });

  test("a file with a final newline keeps exactly one", async () => {
    const path = file("final.md", "# T\n\n## A\n\nold\n");
    await run(["set", path, "=A", "--body", "\nnew\n"]);
    expect(read(path).toString("utf8")).toBe("# T\n\n## A\n\nnew\n");
  });
});

describe("D5 — stdin is a real body source", () => {
  test("a real shell pipe reaches set without any flag", () => {
    const path = file("stdin.md", "# T\n\n## A\n\nold\n");
    const bin = fileURLToPath(new URL("../dist/bin/issuemd.js", import.meta.url));
    const result = spawnSync("sh", ["-c", `printf 'from-stdin\\n' | "${process.execPath}" "${bin}" set "${path}" "=A"`], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(read(path).toString("utf8")).toContain("from-stdin");
  });

  test("a redirected file reaches set without any flag", () => {
    const path = file("redirect.md", "# T\n\n## A\n\nold\n");
    const body = file("body.txt", "via-redirect\n");
    const bin = fileURLToPath(new URL("../dist/bin/issuemd.js", import.meta.url));
    const result = spawnSync("sh", ["-c", `"${process.execPath}" "${bin}" set "${path}" "=A" < "${body}"`], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(read(path).toString("utf8")).toContain("via-redirect");
  });

  test("--body-file - reads the body from stdin", () => {
    const path = file("bodyfile.md", "# T\n\n## A\n\nold\n");
    const bin = fileURLToPath(new URL("../dist/bin/issuemd.js", import.meta.url));
    const result = spawnSync("sh", ["-c", `printf 'via-body-file\\n' | "${process.execPath}" "${bin}" set "${path}" "=A" --body-file -`], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(read(path).toString("utf8")).toContain("via-body-file");
  });
});

describe("D6 — heading levels never collide with an ancestor", () => {
  test("promote refuses when the result equals the parent level", async () => {
    const path = file("collide.md", "# T\n\n## A\n\n### deep\n\nx\n");
    const before = read(path);
    const result = await run(["promote", path, "=deep"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/mv|same level|ancestor/i);
    expect(read(path)).toEqual(before);
  });
});

describe("D7 — ledgers are not edited with generic tools", () => {
  test("rm refuses on a ledger and points at close", async () => {
    const path = file(
      "ledger.md",
      "# L\n\n## 索引\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 未决 | P2 | x |\n\n## 已关闭\n\n## 正文\n\n### Issue 1: x\n\nbody\n",
    );
    const before = read(path);
    const result = await run(["rm", path, "/Issue 1:/"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/close|ledger|台账/i);
    expect(read(path)).toEqual(before);
  });
});

describe("write safety", () => {
  test("file mode bits survive a write", async () => {
    const path = file("mode.md", "# T\n\n## A\n\nold\n");
    chmodSync(path, 0o600);
    await run(["set", path, "=A", "--body", "new"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a stale read is rejected before writing", async () => {
    const path = file("race.md", "# T\n\n## A\n\nold\n");
    const before = read(path);
    const stale = statSync(path);
    // Change size and restore the timestamp: only a (size, mtime) check that
    // looks at both catches this.
    writeFileSync(path, "# T\n\n## A\n\nchanged elsewhere\n");
    utimesSync(path, stale.atime, stale.mtime);

    const { readDocument, writeAtomically } = await import("../src/io.js");
    const doc = readDocument(path);
    const result = writeAtomically(path, "# T\n\n## A\n\nafter\n", {
      size: before.length, // the size the caller saw when it read
      mtimeMs: stale.mtimeMs,
    });
    expect(doc.text).toContain("changed elsewhere");
    expect(result).toEqual({ ok: false, stale: true });
    expect(read(path)).not.toEqual(Buffer.from("# T\n\n## A\n\nafter\n"));
  });
});