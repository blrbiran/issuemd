import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkLedger } from "../src/ledger-check.js";
import { run } from "../src/cli.js";

function fixture(name: string) {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
}
function expected(name: string) {
  return JSON.parse(fixture(`${name}.expected.json`).toString("utf8"));
}
const rows = (text: string) => [...text.matchAll(/^\| (\d+) \| (\S+) \| [^|]+ \| ([^|]+) \|/gm)];

test("Cafe-shaped input has the recorded title conflicts and retained bodies", () => {
  const text = fixture("cafe-shaped.md").toString("utf8");
  const [overview, remainder] = text.split(/^## 已关闭.*$/m);
  const [closed] = remainder.split(/^## 正文.*$/m);
  const want = expected("cafe-shaped");
  const bodies = new Map(
    [...text.matchAll(/^### Issue (\d+): (.+)$/gm)].map(([, id, title]) => [Number(id), title.trim()]),
  );
  const index = rows(overview);
  const openRows = index.filter((row) => row[2] !== "已修");
  const closedRows = index.filter((row) => row[2] === "已修");
  expect(openRows.map((row) => Number(row[1]))).toEqual(want.openIds);
  expect(closedRows.map((row) => Number(row[1]))).toEqual(want.closedIds);
  expect([...bodies.keys()].filter((id) => want.closedIds.includes(id))).toEqual(want.closedIdsWithBody);
  expect(openRows.filter((row) => bodies.get(Number(row[1])) !== row[3].trim()).map((row) => Number(row[1])))
    .toEqual(want.openTitleConflictIds);
  expect(openRows.filter((row) => row[3].includes("仍缺")).map((row) => Number(row[1])))
    .toEqual(want.progressIds);
  const closedTitles = new Map(
    [...closed.matchAll(/^\| (\d+) \| P\d+ \| ([^|]+) \|/gm)].map(([, id, title]) => [Number(id), title.trim()]),
  );
  expect([...closedTitles.keys()]).toEqual(want.closedIds);
  expect(closedRows.filter((row) => closedTitles.get(Number(row[1])) !== row[3].trim()).map((row) => Number(row[1])))
    .toEqual(want.closedTitleConflictIds);
});

test("Orca-shaped input has the recorded separators and counts", () => {
  const text = fixture("orca-shaped.md").toString("utf8").replaceAll("\r\n", "\n");
  const want = expected("orca-shaped");
  const blocks = text.match(/(?:^\|[^\n]*\n)+/gm) ?? [];
  expect(blocks.filter((block) => !/^\|(?:[-: ]+\|)+$/m.test(block))).toHaveLength(want.missingSeparatorBlocks);
  expect(text.match(/^#{2,3} .*（\d+）$/gm)).toHaveLength(want.countHeadings);
  const groups = [...text.matchAll(/^### (.+)（(\d+)）\n\n((?:\|[^\n]*\n)+)/gm)];
  const mismatches = groups.flatMap(([, heading, declared, block]) => {
    const ids = [...block.matchAll(/^\| ([\d /]+) \|/gm)].flatMap((row) => row[1].match(/\d+/g) ?? []);
    return ids.length === Number(declared) ? [] : [{ heading, declared: Number(declared), actual: ids.length }];
  });
  expect(mismatches).toEqual(want.countMismatches);
});

test("encoding fixture has a UTF-8 BOM, only CRLF line endings, and no final newline", () => {
  const bytes = fixture("crlf-bom.md");
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString("utf8");
  expect(text).toContain("\r\n");
  expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  expect(text.endsWith("\n")).toBe(false);
});

test("TEMPLATE.md is an empty ledger that already passes check", async () => {
  const template = readFileSync(new URL("../TEMPLATE.md", import.meta.url), "utf8");
  // A fresh ledger must have the skeleton but no issues and no errors.
  const report = checkLedger(template, "TEMPLATE.md");
  expect(report.errors).toEqual([]);
  expect(report.counts).toMatchObject({ open: 0, closed: 0 });
  // It must be usable as a base: `new` should work against it untouched.
  expect(template).toContain("## 索引");
  expect(template).toContain("## 正文");
  expect(template).toContain("<!-- issuemd:statuses:begin -->");

  const dir = mkdtempSync(join(tmpdir(), "issuemd-template-"));
  try {
    const path = join(dir, "ledger.md");
    writeFileSync(path, template);
    const added = await run(["new", path, "--title", "first", "--status", "未决", "--priority", "P1"]);
    expect(added.code).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("| 1 | 未决 | P1 | first |");
    expect(checkLedger(after, path).errors).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
