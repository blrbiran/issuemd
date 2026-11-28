/**
 * Round 22: W201 limits from the ledger preamble, W201 measurement and
 * appendix scope, write receipts, errno diagnostics, unique-appendix rules
 * and auto-created appendix cleanup.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSync } from "node:child_process";

import { run } from "./cli.js";
import { built } from "../tests/built.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-round22-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fixture = new URL("../fixtures/canonical-clean.md", import.meta.url).pathname;
let counter = 0;

/** Copy the canonical fixture, optionally inserting a preamble and a tail. */
function ledgerFrom(base: string, preamble = "", tail = ""): string {
  const src = readFileSync(base, "utf8");
  const at = src.search(/^## /m);
  const text = preamble ? `${src.slice(0, at)}${preamble}\n${src.slice(at)}` : src;
  const path = join(dir, `round22-${counter++}.md`);
  writeFileSync(path, text + tail);
  return path;
}

/** n lines of Chinese prose, comfortably over the default byte limit at ~400. */
function bigBody(n: number): string {
  const path = join(dir, `big-${counter++}.md`);
  writeFileSync(path, Array.from({ length: n }, (_, i) => `第${i + 1}行 内容内容内容内容内容内容内容内容`).join("\n") + "\n");
  return path;
}

const text = (path: string) => readFileSync(path, "utf8");

describe("W267: ledger limits marker", () => {
  test("a preamble marker changes the effective limits", async () => {
    const path = ledgerFrom(fixture, "<!-- issuemd:limits: body-bytes=40960 body-lines=600 -->\n");
    const doc = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(doc.limits).toEqual({ bodyBytes: 40960, bodyLines: 600, source: "ledger" });
  });

  test("no marker means defaults and source default", async () => {
    const doc = JSON.parse((await run(["check", fixture, "--json"])).stdout);
    expect(doc.limits).toEqual({ bodyBytes: 20480, bodyLines: 300, source: "default" });
  });

  test("a marker after the first H2 is ignored", async () => {
    const path = ledgerFrom(fixture, "", "\n## 附录\n\n<!-- issuemd:limits: body-bytes=1 -->\n");
    const doc = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(doc.limits.source).toBe("default");
  });

  test("a bad value warns W267 and falls back to defaults", async () => {
    const path = ledgerFrom(fixture, "<!-- issuemd:limits: body-bytes=0 -->\n");
    const doc = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(doc.limits.source).toBe("default");
    expect(doc.warnings.some((w: { code: string }) => w.code === "W267")).toBe(true);
  });
});
describe("limits verb", () => {
  test("sets, updates, and clears the marker", async () => {
    const path = ledgerFrom(fixture, "");
    expect((await run(["limits", path, "--body-bytes", "40960"])).code).toBe(0);
    expect(JSON.parse((await run(["check", path, "--json"])).stdout).limits.bodyBytes).toBe(40960);
    expect((await run(["limits", path, "--body-lines", "600"])).code).toBe(0);
    const both = JSON.parse((await run(["check", path, "--json"])).stdout).limits;
    expect([both.bodyBytes, both.bodyLines]).toEqual([40960, 600]);
    expect((await run(["limits", path, "--clear"])).code).toBe(0);
    expect(JSON.parse((await run(["check", path, "--json"])).stdout).limits.source).toBe("default");
  });

  test("--dry-run changes nothing; bad values exit 2", async () => {
    const path = ledgerFrom(fixture, "");
    const before = readFileSync(path, "utf8");
    const dry = await run(["limits", path, "--body-bytes", "40960", "--dry-run"]);
    expect(dry.stdout).toContain("+");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect((await run(["limits", path, "--body-bytes", "0"])).code).toBe(2);
    expect((await run(["limits", path])).code).toBe(2);
    expect((await run(["limits", path, "--clear", "--body-bytes", "1"])).code).toBe(2);
  });

  test("does not disturb the high-water marker", async () => {
    const path = ledgerFrom(fixture, "<!-- issuemd:high-water: 20 -->\n");
    await run(["limits", path, "--body-bytes", "40960"]);
    expect(text(path)).toContain("<!-- issuemd:high-water: 20 -->");
    expect(text(path)).toContain("body-bytes=40960");
  });
});

describe("W201 scope", () => {
  test("message names the measured value and the exceeded dimension", async () => {
    const path = ledgerFrom(fixture, "");
    await run(["body", path, "2", "--body-file", bigBody(400)]);
    const warnings = JSON.parse((await run(["check", path, "--json"])).stdout).warnings;
    const w201 = warnings.find((w: { code: string }) => w.code === "W201");
    expect(w201.message).toMatch(/\d+ lines \(limit 300\)/);
  });

  test("a kept-body archive over the limit still reports W201 with its id", async () => {
    const path = ledgerFrom(fixture, "");
    await run(["body", path, "2", "--body-file", bigBody(400)]);
    await run(["close", path, "2", "--status", "已修", "--criteria", "x", "--keep-body"]);
    const found = JSON.parse((await run(["check", path, "--json"])).stdout)
      .warnings.filter((w: { code: string; id?: string }) => w.code === "W201" && w.id === "2");
    expect(found.length).toBeGreaterThan(0);
  });

  test("a hand-written appendix is not measured", async () => {
    const path = ledgerFrom(fixture, "", `\n## 附录\n\n${readFileSync(bigBody(400), "utf8")}\n`);
    const codes = JSON.parse((await run(["check", path, "--json"])).stdout)
      .warnings.filter((w: { code: string }) => w.code === "W201");
    expect(codes).toHaveLength(0);
  });
});

describe("check size metrics", () => {
  test("text and JSON both report size", async () => {
    const json = JSON.parse((await run(["check", fixture, "--json"])).stdout);
    expect(Object.keys(json.size).sort()).toEqual(["archivedBlocks", "archivedLines", "bodyLines", "bytes", "lines"]);
    expect(json.size.bytes).toBeGreaterThan(0);
    const plain = (await run(["check", fixture])).stdout;
    expect(plain).toMatch(/\d+ lines · body \d+/);
  });

  test("json is valid for stdin", () => {
    const src = readFileSync(fixture, "utf8");
    const result = spawnSync("node", [built("bin/issuemd.js"), "check", "-", "--json"], { input: src, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).size.lines).toBeGreaterThan(0);
  });
});

describe("write-time W201 hint", () => {
  test("body --append warns when it pushes an issue over the limits", async () => {
    const path = ledgerFrom(fixture, "");
    const result = await run(["body", path, "2", "--append", "--body-file", bigBody(400)]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("W201");
  });

  test("body --body-file warns on a first crossing", async () => {
    const path = ledgerFrom(fixture, "");
    const result = await run(["body", path, "2", "--body-file", bigBody(400)]);
    expect(result.stderr).toContain("W201");
  });

  test("dry-run also warns and writes nothing", async () => {
    const path = ledgerFrom(fixture, "");
    const before = readFileSync(path, "utf8");
    const result = await run(["body", path, "2", "--body-file", bigBody(400), "--dry-run"]);
    expect(result.stderr).toContain("W201");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a body that stays under the limit says nothing about W201", async () => {
    const path = ledgerFrom(fixture, "");
    const result = await run(["body", path, "2", "--body-file", bigBody(5)]);
    expect(result.stderr).not.toContain("W201");
  });
});

test("close --keep-body warns when the archived body is over the limits", async () => {
  const path = ledgerFrom(fixture, "");
  await run(["body", path, "2", "--body-file", bigBody(400)]);
  const result = await run(["close", path, "2", "--status", "已修", "--criteria", "x", "--keep-body"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("W201");
});

describe("write receipts", () => {
  test("every write verb reports what it did and the new snapshot", async () => {
    const path = ledgerFrom(fixture, "");
    const status = await run(["status", path, "2", "观察"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toBe("");
    expect(status.stderr).toMatch(/^wrote .* #2 status 未决 → 观察 \(snapshot [0-9a-f]{16}\)$/m);
  });

  test("the receipt snapshot chains into --if-unchanged", async () => {
    const path = ledgerFrom(fixture, "");
    const first = await run(["status", path, "2", "观察"]);
    const snapshot = /snapshot ([0-9a-f]{16})/.exec(first.stderr)![1];
    const second = await run(["priority", path, "2", "P3", "--if-unchanged", snapshot]);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("#2 priority P1 → P3");
  });

  test("--dry-run and no-op writes keep their old output", async () => {
    const path = ledgerFrom(fixture, "");
    expect((await run(["status", path, "2", "未决"])).stdout).toBe("(no changes)\n");
    expect((await run(["status", path, "2", "观察", "--dry-run"])).stderr).not.toContain("wrote ");
  });

  test("body, close, reopen, new, split and limits all report", async () => {
    const path = ledgerFrom(fixture, "");
    const body = await run(["body", path, "2", "--append", "--body-file", bigBody(2)]);
    expect(body.stderr).toMatch(/wrote .*#2 body appended/);
    const closed = await run(["close", path, "2", "--status", "已修", "--criteria", "ok"]);
    expect(closed.stderr).toMatch(/wrote .*#2 closed as 已修/);
    const reopened = await run(["reopen", path, "2"]);
    expect(reopened.stderr).toMatch(/wrote .*#2 reopened as 未决/);
    const filed = await run(["new", path, "--title", "回执检查"]);
    expect(filed.stderr).toMatch(/wrote .*#\d+ new/);
    expect(filed.stdout.trim()).toMatch(/^\d+$/);
    const limits = await run(["limits", path, "--body-bytes", "40960"]);
    expect(limits.stderr).toMatch(/wrote .*limits body-bytes 20480 → 40960/);
  });
});

describe("write diagnostics", () => {
  test("close --criteria says the pipe was escaped", async () => {
    const path = ledgerFrom(fixture, "");
    const result = await run(["close", path, "2", "--status", "已修", "--criteria", "a | b"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("W205");
  });

  test("a criteria without a pipe stays silent on W205", async () => {
    const path = ledgerFrom(fixture, "");
    const result = await run(["close", path, "2", "--status", "已修", "--criteria", "plain"]);
    expect(result.stderr).not.toContain("W205");
  });

  test("a real read-only file still reports read-only with the chmod hint", async () => {
    const path = ledgerFrom(fixture, "");
    chmodSync(path, 0o444);
    try {
      const result = await run(["priority", path, "2", "P3"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("read-only");
      expect(result.stderr).toContain("chmod");
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("a missing file is not described as read-only", async () => {
    const gone = join(dir, "vanished.md");
    const result = await run(["priority", gone, "2", "P3"]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("read-only");
  });
});


test("duplicate appendix headings warn and block archive writes", async () => {
  const path = ledgerFrom(fixture, "", "\n## 附录\n\nSecond appendix.\n");
  const before = text(path);
  const checked = await run(["check", path, "--strict", "--json"]);
  expect(checked.code).toBe(3);
  expect(JSON.parse(checked.stdout).warnings.filter((w: { code: string }) => w.code === "W266")).toHaveLength(2);
  for (const flags of [[], ["--dry-run"]]) {
    const closed = await run(["close", path, "2", "--keep-body", ...flags]);
    expect(closed.code).toBe(2);
    expect(closed.stderr).toMatch(/W266.*L\d+.*L\d+/);
    expect(text(path)).toBe(before);
  }
});

for (const variant of ["lf", "crlf-bom", "no-final-newline"]) {
  test(`reopen reclaims an empty generated appendix (${variant})`, async () => {
    const path = ledgerFrom(fixture);
    let before = text(path).replace(/\n## 附录[\s\S]*$/, "\n");
    if (variant === "crlf-bom") before = "\uFEFF" + before.replaceAll("\n", "\r\n");
    if (variant === "no-final-newline") before = before.trimEnd();
    writeFileSync(path, before);
    for (const id of ["2", "4"]) {
      expect((await run(["close", path, id, "--keep-body"])).code).toBe(0);
      expect(text(path)).toContain("<!-- issuemd:appendix:auto -->");
      expect((await run(["reopen", path, id, "--status", id === "4" ? "观察" : "未决"])).code).toBe(0);
      expect(text(path)).toBe(before);
    }
  });
}

test("reopen keeps a generated appendix with a user's HTML comment", async () => {
  const path = ledgerFrom(fixture);
  writeFileSync(path, text(path).replace(/\n## 附录[\s\S]*$/, "\n"));
  expect((await run(["close", path, "2", "--keep-body"])).code).toBe(0);
  writeFileSync(path, text(path) + "\n<!-- retain this note -->\n");
  expect((await run(["reopen", path, "2"])).code).toBe(0);
  expect(text(path)).toContain("## 附录");
  expect(text(path)).toContain("<!-- retain this note -->");
});


test("check measures only the archive payload, leaving unrelated trailing notes outside W201", async () => {
  const path = ledgerFrom(fixture);
  expect((await run(["close", path, "2", "--keep-body"])).code).toBe(0);
  const before = JSON.parse((await run(["check", path, "--json"])).stdout);
  writeFileSync(path, text(path) + "\n" + "Appendix note.\n".repeat(400));
  const after = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(after.warnings.map((w: { code: string }) => w.code)).toEqual(["W250"]);
  expect(after.size.archivedLines).toBe(before.size.archivedLines);
});

test("duplicate limits keys warn and cannot override the default", async () => {
  const path = ledgerFrom(fixture, "<!-- issuemd:limits: body-lines=2 body-lines=600 -->\n");
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.limits).toEqual({ bodyBytes: 20480, bodyLines: 300, source: "default" });
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W267" }));
});

test("closing without criteria explains how each option handles the body", async () => {
  const path = ledgerFrom(fixture);
  writeFileSync(path, text(path).replace("**验收判据**：重启后保持上次宽度。", ""));
  const result = await run(["close", path, "2"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/--no-criteria.*deletes? the body/);
  expect(result.stderr).toMatch(/--keep-body.*retain/);
});


test("renaming keeps its change report and includes one new snapshot receipt", async () => {
  const path = ledgerFrom(fixture);
  const renamed = await run(["rename", path, "2", "new title"]);
  const shown = JSON.parse((await run(["show", path, "2", "--json"])).stdout);
  expect(renamed.stderr).toContain("updated #2 body title");
  expect(renamed.stderr.match(/^wrote .*$/gm)).toEqual([`wrote ${path} #2 renamed (snapshot ${shown.snapshot})`]);
});

test("replacing a missing body still reports introduced W201", async () => {
  const path = ledgerFrom(fixture);
  writeFileSync(path, text(path).replace(/^### Issue 2:[\s\S]*?(?=^### Issue 3:)/m, ""));
  const result = await run(["body", path, "2", "--body-file", bigBody(400)]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("W201");
});


test("a permission error creating the write lock names the directory and errno", async () => {
  const folder = join(dir, "readable-directory");
  mkdirSync(folder);
  const path = join(folder, "ledger.md");
  writeFileSync(path, readFileSync(fixture));
  chmodSync(folder, 0o555);
  try {
    const result = await run(["priority", path, "2", "P3"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("EACCES");
    expect(result.stderr).toContain("directory");
    expect(result.stderr).not.toContain("chmod u+w");
  } finally {
    chmodSync(folder, 0o755);
  }
});


test("limits refuses to overwrite prose after a malformed marker", async () => {
  const path = ledgerFrom(fixture, "<!-- issuemd:limits: body-lines=600 --> Keep this note.\n");
  const before = text(path);
  for (const flags of [["--clear"], ["--body-lines", "601"]]) {
    const result = await run(["limits", path, ...flags]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/L\d+/);
    expect(text(path)).toBe(before);
  }
});

test("archive W201 includes the last LF of the payload", async () => {
  const path = ledgerFrom(fixture, "<!-- issuemd:limits: body-bytes=3 -->\n", ["", "### #1 登录页闪烁（已关闭，正文保留）", "<!-- issuemd:kept-body:v2 -->", "<!-- issuemd:kept-body:start -->", "abc", "<!-- issuemd:kept-body:end -->", ""].join("\n"));
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W201", id: "1", message: expect.stringContaining("4 UTF-8 bytes") }));
});


test("limits ignores marker-shaped text in raw HTML and multiline comments", async () => {
  for (const [open, close] of [["<textarea>", "</textarea>"], ["<!-- example", "-->"]]) {
    const path = ledgerFrom(fixture, `${open}\n<!-- issuemd:limits: body-lines=600 -->\n${close}\n`);
    const before = text(path);
    const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(checked.limits.bodyLines).toBe(300);
    expect((await run(["limits", path, "--clear"])).code).toBe(0);
    expect(text(path)).toBe(before);
    expect((await run(["limits", path, "--body-lines", "450"])).code).toBe(0);
    expect(text(path)).toContain(`${open}\n<!-- issuemd:limits: body-lines=600 -->\n${close}`);
    expect(JSON.parse((await run(["check", path, "--json"])).stdout).limits.bodyLines).toBe(450);
  }
});

test("adopt keeps an active limits marker originally above the H1", async () => {
  const path = ledgerFrom(fixture);
  writeFileSync(path, "<!-- issuemd:limits: body-lines=600 -->\n\n" + text(path).replace("## 索引", "## 待处理"));
  expect((await run(["adopt", path])).code).toBe(0);
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.limits).toEqual({ bodyBytes: 20480, bodyLines: 600, source: "ledger" });
});

test("adopt still identifies the committed snapshot if writing its report fails", async () => {
  const path = ledgerFrom(fixture);
  writeFileSync(path, text(path).replace("## 索引", "## 待处理"));
  const result = await run(["adopt", path, "--report", join(dir, "missing-dir", "report.txt")]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("cannot write --report");
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.errors).toEqual([]);
  expect(result.stderr).toContain(`wrote ${path} adopted ledger (snapshot ${checked.snapshot})`);
});
