/**
 * Round 22: W201 limits from the ledger preamble, W201 measurement and
 * appendix scope, write receipts, errno diagnostics, unique-appendix rules
 * and auto-created appendix cleanup.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./cli.js";

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
