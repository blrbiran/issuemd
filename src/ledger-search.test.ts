import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const directory = mkdtempSync(join(tmpdir(), "issuemd-find-"));
const created: string[] = [];
afterAll(() => {
  for (const file of created) unlinkSync(file);
  rmdirSync(directory);
});
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let sequence = 0;
function temporary(text: string): string {
  const file = join(directory, `${++sequence}.md`);
  writeFileSync(file, text);
  created.push(file);
  return file;
}
async function bodyFile(body: string): Promise<string> {
  const file = temporary(canonical.replace(/^\| (?:5|6|7–20) \|.*\n/gm, ""));
  expect((await run(["body", file, "2", "--body-file", temporary(body)])).code).toBe(0);
  return file;
}

test("prose references reserve exact missing issue IDs during new", async () => {
  // `#5a` is within the bare-reference ceiling (max 4 → 5); `#7a` would be
  // above it and is treated as a historical/foreign reference (dogfood #150).
  const file = await bodyFile("**验收判据**：可用。\n\n参见#5，另见 #5a。\n");
  const before = readFileSync(file, "utf8");
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.filter(({ code }: { code: string }) => code === "W271").map(({ id }: { id: string }) => id)).toEqual(["5", "5a"]);
  const refused = await run(["new", file, "--title", "新问题", "--id", "5a"]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toMatch(/L\d+/);
  expect(readFileSync(file, "utf8")).toBe(before);
  const inserted = await run(["new", file, "--title", "新问题"]);
  expect(inserted.code).toBe(0);
  expect(inserted.stdout.trim()).toBe("6");
});

test("a new body cannot claim a number it cites in the candidate", async () => {
  const file = await bodyFile("**验收判据**：可用。\n");
  const before = readFileSync(file, "utf8");
  const body = temporary("**现象**：历史条目 #5。\n\n**验收判据**：可用。\n");
  for (const flags of [[], ["--dry-run"]]) {
    expect((await run(["new", file, "--title", "新问题", "--id", "5", "--body-file", body, ...flags])).code).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("a comment beside a citation and a code example above it do not hide the citation", async () => {
  const file = await bodyFile("**验收判据**：可用。\n\n`literal ](`\n\nSee #5 <!-- note -->\n");
  const inserted = await run(["new", file, "--title", "新问题"]);
  expect(inserted.code).toBe(0);
  expect(inserted.stdout.trim()).toBe("6");
});

test("find skips an archive covered by two overlapping spans of the same row", async () => {
  const file = temporary(`${canonical.trimEnd().replace("| 7–20 |", "| 7–20, 9 |")}\n\n### #9 无记录（已关闭，正文保留）\n\nambiguous archived evidence\n`);
  const found = JSON.parse((await run(["find", file, "ambiguous archived evidence", "--json"])).stdout);
  expect(found.diagnostics.errors).toContainEqual(expect.objectContaining({ code: "E103" }));
  expect(found.matches).toEqual([]);
});

test("a malformed archive cannot reserve IDs from an uncertain payload boundary", async () => {
  const file = await bodyFile("**验收判据**：可用。\n");
  const source = readFileSync(file, "utf8");
  const malformed = temporary(`${source.trimEnd()}\n\n### #1 登录页闪烁（已关闭，正文保留）\n<!-- issuemd:kept-body:v3 -->\n<!-- issuemd:kept-body:start -->\n<!-- issuemd:kept-body:lines:3 -->\n### Nested heading\nSee #5.\nThird record.\n\n<!-- issuemd:kept-body:end -->\n`);
  const report = JSON.parse((await run(["check", malformed, "--json"])).stdout);
  expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W269" }));
  expect(report.warnings).not.toContainEqual(expect.objectContaining({ code: "W271", id: "5" }));
});

test("literal # tokens do not reserve numbers", async () => {
  const file = await bodyFile([
    "**验收判据**：可用。", "", "`#5` and \\#5 and https://example.test/#5 and [link](#5)", "", "<!-- #5 -->", "",
    "```md", "#5", "```", "", "<pre>", "#5", "</pre>", "",
  ].join("\n"));
  const result = await run(["new", file, "--title", "新问题"]);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("5");
});

test("find classifies a line as a reference even when an earlier match is ordinary text", async () => {
  const file = await bodyFile("**验收判据**：可用。\n\nLiteral # before reference #5.\n");
  const found = JSON.parse((await run(["find", file, "#", "--json"])).stdout);
  expect(found.matches).toContainEqual(expect.objectContaining({ where: "reference", id: "2" }));
});

test("closed batch read finds an archive owned by a non-first ID", async () => {
  const file = temporary(`${canonical.trimEnd().replace("| 7–20 |", "| 7–20, 21 |")}\n\n### #21 无记录（已关闭，正文保留）\n\nHistorical evidence\n`);
  const listed = JSON.parse((await run(["list", file, "--closed", "--json", "--with-body"])).stdout);
  const row = listed.issues.find(({ id }: { id: string }) => id === "7–20, 21");
  expect(row.body.id).toBe("21");
  expect(row.body.text).toBe((await run(["show", file, "21", "--body-only"])).stdout);
});

test("find returns source owners and source order across summaries, bodies and archives", async () => {
  const file = await bodyFile("**现象**：侧栏宽度不可调，在重启时。\n\n**验收判据**：可用。\n\n关联 #1。\n");
  const original = readFileSync(file, "utf8");
  const appended = `${original.trimEnd()}\n\n### #1 登录页闪烁（已关闭，正文保留）\n\n侧栏宽度不可调，历史复测。\n`;
  const search = temporary(appended);
  const found = await run(["find", search, "侧栏宽度不可调", "--json"]);
  expect(found.code).toBe(0);
  const payload = JSON.parse(found.stdout);
  expect(payload.matches.map(({ id, where }: { id: string; where: string }) => [id, where])).toEqual([["2", "summary"], ["2", "body"], ["1", "archive"]]);
  expect(payload.matches.map(({ line }: { line: number }) => line)).toEqual(payload.matches.map(({ line }: { line: number }) => line).sort((a: number, b: number) => a - b));
  const ref = JSON.parse((await run(["find", search, "#1", "--json"])).stdout);
  expect(ref.matches).toContainEqual(expect.objectContaining({ id: "2", table: "open", where: "reference" }));
  const empty = await run(["find", search, "never found", "--json"]);
  expect(empty.code).toBe(0);
  expect(JSON.parse(empty.stdout)).toEqual(expect.objectContaining({ file: search, snapshot: expect.any(String), diagnostics: expect.any(Object), matches: [] }));
  expect(readFileSync(search, "utf8")).toBe(appended);
});
