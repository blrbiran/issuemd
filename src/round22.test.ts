/**
 * Round 22: W201 limits from the ledger preamble, W201 measurement and
 * appendix scope, write receipts, errno diagnostics, unique-appendix rules
 * and auto-created appendix cleanup.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const count = (path: string, pattern: RegExp) => (text(path).match(pattern) ?? []).length;

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
    const closed = await run(["close", path, "2", "--criteria", "ok"]);
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
