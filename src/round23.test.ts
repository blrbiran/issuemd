import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-round23-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");

test("sentence-shaped bold boundaries inside criteria are visible as W268", async () => {
  const ledger = fixture("bold-boundary.md", canonical);
  const body = fixture("bold-boundary.body", [
    "**现象**：probe",
    "",
    "**验收判据**",
    "",
    "1. 第一条。",
    "",
    "```markdown",
    "**代码里的句子？**",
    "```",
    "",
    "**重启后必须保留窗口宽度。**",
    "",
    "2. 第二条。",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const result = await run(["check", ledger, "--json"]);
  const report = JSON.parse(result.stdout);
  expect(report.warnings.filter(({ code }: { code: string }) => code === "W268")).toHaveLength(1);
  expect(report.warnings).toContainEqual(expect.objectContaining({
    code: "W268",
    id: "2",
    message: expect.stringContaining("重启后必须保留窗口宽度。"),
  }));
});

test("label-like text inside a multiline comment does not split criteria", async () => {
  const ledger = fixture("commented-label.md", canonical);
  const body = fixture("commented-label.body", [
    "**现象**：probe",
    "",
    "**验收判据**：",
    "1. 第一条。",
    "<!--",
    "**说明**",
    "这是隐藏的注释内容。",
    "-->",
    "2. 第二条。",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.labels).not.toHaveProperty("说明");
  expect(shown.criteria).toContain("1. 第一条。");
  expect(shown.criteria).toContain("2. 第二条。");
  expect(shown.body.content).toContain("**说明**");
});

test("a standalone review heading remains a boundary without a following criterion item", async () => {
  const ledger = fixture("standalone-punctuation-label.md", canonical);
  const body = fixture("standalone-punctuation-label.body", [
    "**验收判据**",
    "1. 第一条。",
    "**待确认？**",
    "待产品确认。",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.labels).toHaveProperty("待确认？");
  expect(shown.criteria).toBe("1. 第一条。");
  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings).not.toContainEqual(expect.objectContaining({ code: "W268", id: "2" }));
});

test("compact punctuation labels keep their boundary and bold-leading prose stays content", async () => {
  const ledger = fixture("compact-label.md", canonical);
  const body = fixture("compact-label.body", [
    "**验收判据**：第一条。",
    "",
    "**待确认？**：待产品确认。",
    "",
    "**必须**先重启再验证。",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.labels).toHaveProperty("待确认？");
  expect(shown.labels).not.toHaveProperty("必须");
  expect(shown.labels["验收判据"]).toContain("第一条。");
});

test("close refuses to promote criteria cut by a sentence-shaped bold boundary", async () => {
  const ledger = fixture("close-bold-boundary.md", canonical);
  const body = fixture("close-bold-boundary.body", [
    "**现象**：probe",
    "",
    "**验收判据**",
    "1. 第一条。",
    "**重启后必须保留窗口宽度。**",
    "2. 第二条。",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const before = readFileSync(ledger, "utf8");

  const refused = await run(["close", ledger, "2", "--criteria-from-body"]);

  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("W268");
  expect(refused.stderr).toContain("重启后必须保留窗口宽度");
  expect(readFileSync(ledger, "utf8")).toBe(before);

  const explicit = await run(["close", ledger, "2", "--criteria", "reviewed complete criteria"]);
  expect(explicit.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toContain("reviewed complete criteria");
});

test("close requires review before flattening multiple criteria blocks and reports all source lines", async () => {
  const ledger = fixture("close-multiple-criteria.md", canonical);
  const body = fixture("close-multiple-criteria.body", [
    "**现象**：probe",
    "",
    "**验收判据**：",
    "1. 第一条。",
    "",
    "**验收判据**：",
    "2. 第二条。",
    "",
    "**追加判据**：",
    "3. 第三条。",
    "",
    "**修复判据**：",
    "4. 第四条。",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const before = readFileSync(ledger, "utf8");

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  const duplicate = checked.warnings.find((warning: { code: string; message: string }) => warning.code === "W206" && warning.message.includes("验收判据"));
  expect(duplicate?.message).toContain("L");
  expect(checked.warnings.filter((warning: { code: string; id?: string }) => warning.code === "W264" && warning.id === "2")).toHaveLength(2);

  const refused = await run(["close", ledger, "2"]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("验收判据");
  expect(refused.stderr).toContain("追加判据");
  expect(refused.stderr).toContain("修复判据");
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("comment-only supplemental criteria do not block close", async () => {
  const ledger = fixture("comment-only-supplement.md", canonical);
  const body = fixture("comment-only-supplement.body", [
    "**验收判据**：可通过。",
    "",
    "**追加判据**",
    "<!-- no criteria here -->",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const check = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(check.warnings).not.toContainEqual(expect.objectContaining({ code: "W264", id: "2" }));
  expect((await run(["close", ledger, "2"])).code).toBe(0);
});

test("criteriaOccurrences returns source-preserving canonical and supplement occurrences", async () => {
  const { criteriaOccurrences } = await import("./ledger-edit.js");
  const body = [
    "**验收判据**：",
    "1. 第一条；含字面分号。",
    "",
    "**验收判据**：",
    "2. 第二条。",
    "",
    "**追加判据**：",
    "3. 第三条。",
    "",
    "**关闭时判据**：历史值。",
  ];
  const occurrences = criteriaOccurrences(body, 100);
  expect(occurrences.map(({ line, label, kind }) => ({ line, label, kind }))).toEqual([
    { line: 101, label: "验收判据", kind: "canonical" },
    { line: 104, label: "验收判据", kind: "canonical" },
    { line: 107, label: "追加判据", kind: "supplement" },
  ]);
  expect(occurrences[0]?.lines).toContain("1. 第一条；含字面分号。");
});

test("show and batch list expose identical occurrence-based criteriaBlocks", async () => {
  const ledger = fixture("criteria-blocks-open.md", canonical);
  const body = fixture("criteria-blocks-open.body", [
    "**现象**：probe",
    "",
    "**验收判据**",
    "1. 第一条；保留字面分号。",
    "<!--",
    "**说明**",
    "-->",
    "2. 第二条。",
    "",
    "**验收判据**",
    "3. 第三条。",
    "",
    "**追加判据**",
    "4. 第四条。",
    "",
    "**修复判据**",
    "<!-- comment-only supplement -->",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  const listed = JSON.parse((await run(["list", ledger, "--json", "--with-body"])).stdout);
  const batch = listed.issues.find(({ id }: { id: string }) => id === "2");
  expect(shown.criteriaBlocks).toHaveLength(3);
  expect(shown.criteriaBlocks.map(({ kind }: { kind: string }) => kind)).toEqual(["canonical", "canonical", "supplement"]);
  expect(shown.criteriaBlocks.map(({ line }: { line: number }) => line)).toEqual([
    readFileSync(ledger, "utf8").split("\n").findIndex((line) => line === "**验收判据**") + 1,
    ...readFileSync(ledger, "utf8").split("\n").flatMap((line, index, all) => line === "**验收判据**" && index > all.indexOf("**验收判据**") ? [index + 1] : []),
    readFileSync(ledger, "utf8").split("\n").findIndex((line) => line === "**追加判据**") + 1,
  ]);
  expect(shown.criteriaBlocks[0].lines).toContain("1. 第一条；保留字面分号。");
  expect(shown.criteriaBlocks[0].lines).toContain("**说明**");
  expect(batch.criteriaBlocks).toEqual(shown.criteriaBlocks);
});

test("closed show and batch list expose criteria blocks from the same unique archive", async () => {
  const ledger = fixture("criteria-blocks-archive.md", canonical);
  const body = fixture("criteria-blocks-archive.body", [
    "**现象**：archived evidence",
    "",
    "**验收判据**",
    "1. 原始判据；保留源结构。",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
  expect((await run(["close", ledger, "2", "--criteria", "table-only value"])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  const listed = JSON.parse((await run(["list", ledger, "--closed", "--json", "--with-body"])).stdout);
  const batch = listed.issues.find(({ id }: { id: string }) => id === "2");
  expect(shown.criteria).toBe("table-only value");
  expect(shown.criteriaSource).toBe("table");
  expect(shown.body.archived).toBe(true);
  expect(shown.criteriaBlocks).toHaveLength(1);
  expect(shown.criteriaBlocks[0].lines).toContain("1. 原始判据；保留源结构。");
  expect(batch.criteriaBlocks).toEqual(shown.criteriaBlocks);
});

test("range rows resolve a unique archived criteria body consistently in show and batch list", async () => {
  const closedRow = "| 30–31 | 已修 | P2 | range archive | table range criteria |";
  const archive = [
    "### #30 range archive（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v2 -->",
    "<!-- issuemd:kept-body:start -->",
    "**验收判据**",
    "1. archived range criterion",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const source = canonical.replace("## 正文", `${closedRow}\n\n## 正文`).replace("## 附录\n", `## 附录\n\n${archive}\n\n`);
  const ledger = fixture("criteria-blocks-range-archive.md", source);

  const shown = JSON.parse((await run(["show", ledger, "30–31", "--json"])).stdout);
  const listed = JSON.parse((await run(["list", ledger, "--closed", "--json", "--with-body"])).stdout);
  const batch = listed.issues.find(({ id }: { id: string }) => id === "30–31");
  expect(shown.body.archived).toBe(true);
  expect(shown.criteriaBlocks).toHaveLength(1);
  expect(batch.body.archived).toBe(true);
  expect(batch.criteriaBlocks).toEqual(shown.criteriaBlocks);
});

test("new reports an eligible nearby criteria-label repair with its final source line", async () => {
  const ledger = fixture("new-nearby-criteria.md", canonical);
  const body = fixture("new-nearby-criteria.body", "**现象**：probe\n\n**判据**：可验证。\n");
  const created = await run(["new", ledger, "--title", "近邻判据", "--priority", "P2", "--body-file", body]);
  expect(created.code).toBe(0);
  expect(created.stdout.trim()).toBeTruthy();
  expect(created.stderr).toContain("issuemd sync");
  expect(created.stderr).toContain("--criteria-labels");
  expect(created.stderr).toContain("判据");
  expect(created.stderr).toContain("验收判据");
  expect(created.stderr).toContain("闭表判据列");
  const aliasLine = readFileSync(ledger, "utf8").split("\n").findIndex((line) => line === "**判据**：可验证。") + 1;
  expect(created.stderr).toContain(`L${aliasLine}`);
});

test("write guidance does not recommend sync when a canonical label blocks it", async () => {
  const ledger = fixture("new-canonical-and-alias.md", canonical);
  const body = fixture("new-canonical-and-alias.body", "**验收判据**：\n\n**判据**：可验证。\n");
  const created = await run(["new", ledger, "--title", "已有空标签", "--priority", "P2", "--body-file", body]);
  expect(created.code).toBe(0);
  expect(created.stderr).toContain("manual");
  expect(created.stderr).not.toContain("sync --criteria-labels");
});

test("body reports ambiguous nearby labels without recommending automatic sync", async () => {
  const ledger = fixture("body-multiple-nearby.md", canonical);
  const body = fixture("body-multiple-nearby.body", "**判据**：A\n\n**修复判据**：B\n");
  const changed = await run(["body", ledger, "2", "--body-file", body]);
  expect(changed.code).toBe(0);
  expect(changed.stderr).toContain("multiple");
  expect(changed.stderr).not.toContain("sync --criteria-labels");
});

test("criteria-label sync receipts include the absolute source line", async () => {
  const ledger = fixture("sync-criteria-line.md", canonical);
  const body = fixture("sync-criteria-line.body", "**判据**：可验证。\n");
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const aliasLine = readFileSync(ledger, "utf8").split("\n").findIndex((line) => line === "**判据**：可验证。") + 1;

  const preview = await run(["sync", ledger, "--criteria-labels", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stderr).toContain(`L${aliasLine}`);
  const applied = await run(["sync", ledger, "--criteria-labels"]);
  expect(applied.code).toBe(0);
  expect(applied.stderr).toContain(`L${aliasLine}`);
});

test("limits marker examples inside a raw HTML block stay user text", async () => {
  const source = canonical.replace("## 怎么用", "<div>\n<!-- issuemd:limits: body-bytes=1 -->\n</div>\n\n## 怎么用");
  const ledger = fixture("limits-html-block.md", source);
  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.limits).toEqual({ bodyBytes: 20480, bodyLines: 300, source: "default" });
  const clear = await run(["limits", ledger, "--clear", "--dry-run"]);
  expect(clear.code).toBe(0);
  expect(clear.stdout).toContain("(no changes)");
  expect(readFileSync(ledger, "utf8")).toBe(source);
});

test("read duplicate appendix reports the W266 code and every candidate line", async () => {
  const ledger = fixture("read-duplicate-appendix.md", `${canonical.trimEnd()}\n\n## 附录\n\n`);
  const result = await run(["read", ledger, "附录"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("W266");
  expect(result.stderr).toContain("L75");
  expect(result.stderr).toContain("L83");
});
