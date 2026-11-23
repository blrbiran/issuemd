import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
