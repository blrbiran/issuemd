import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLedger } from "./ledger.js";
import { indexWithBody } from "./ledger-read.js";
import { run } from "./cli.js";

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-round17-"));

function ledgerFile(name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

test("rename with the table summary repairs a drifted body heading", async () => {
  const file = ledgerFile("rename-body.md", canonical.replace(
    "### Issue 2: 侧栏宽度不可调",
    "### Issue 2: 侧栏宽度不可调（旧标题）",
  ));
  const preview = await run(["rename", file, "2", "侧栏宽度不可调", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stdout).not.toContain("(no changes)");
  expect(preview.stdout).toContain("-### Issue 2: 侧栏宽度不可调（旧标题）");

  const renamed = await run(["rename", file, "2", "侧栏宽度不可调"]);
  expect(renamed.code).toBe(0);
  expect(readFileSync(file, "utf8")).toContain("### Issue 2: 侧栏宽度不可调\n");
  expect((await run(["check", file])).code).toBe(0);
});

test("rename with the closed summary repairs a drifted kept-body archive", async () => {
  const file = ledgerFile("rename-archive.md", canonical);
  expect((await run(["close", file, "3", "--keep-body"])).code).toBe(0);
  const archived = readFileSync(file, "utf8").replace(
    "### #3 导出 CSV 丢空行（已关闭，正文保留）",
    "### #3 旧摘要（已关闭，正文保留）",
  );
  writeFileSync(file, archived);
  expect((await run(["check", file, "--json"])).stdout).toContain("W251");

  const renamed = await run(["rename", file, "3", "导出 CSV 丢空行"]);
  expect(renamed.code).toBe(0);
  expect(readFileSync(file, "utf8")).toContain("### #3 导出 CSV 丢空行（已关闭，正文保留）");
  expect((await run(["check", file])).code).toBe(0);
});

test("same-summary rename does not rewrite archive-shaped headings outside 附录", async () => {
  const source = canonical.replace(
    "## 附录",
    "## 历史说明\n\n### #2 Historical example（已关闭，正文保留）\n\n## 附录",
  );
  const file = ledgerFile("rename-outside-appendix.md", source);
  const before = readFileSync(file, "utf8");
  const renamed = await run(["rename", file, "2", "侧栏宽度不可调"]);
  expect(renamed.code).toBe(0);
  expect(renamed.stdout).toBe("(no changes)\n");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("check treats escaped archive pipes as the same summary", async () => {
  const file = ledgerFile("rename-escaped-archive.md", canonical);
  expect((await run(["rename", file, "3", "导出 CSV | 丢空行"])).code).toBe(0);
  expect((await run(["close", file, "3", "--keep-body"])).code).toBe(0);
  const escaped = readFileSync(file, "utf8").replace(
    "### #3 导出 CSV | 丢空行（已关闭，正文保留）",
    "### #3 导出 CSV \\| 丢空行（已关闭，正文保留）",
  );
  writeFileSync(file, escaped);
  const check = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(check.warnings.some(({ code, id }: { code: string; id?: string }) => code === "W251" && id === "3")).toBe(false);
});

test("same-summary rename remains byte-identical for a consistent escaped pipe title", async () => {
  const source = canonical
    .replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 甲 \\| 乙 |")
    .replace("| 4 | 观察 | P3 | 长列表滚动掉帧 |", "| 4 | 观察 | P3 | 甲 \\| 乙 |")
    .replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: 甲 | 乙");
  const file = ledgerFile("rename-noop.md", source);
  const before = readFileSync(file, "utf8");

  const renamed = await run(["rename", file, "2", "甲 | 乙"]);
  expect(renamed.code).toBe(0);
  expect(renamed.stdout).toBe("(no changes)\n");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("a visible issue table in 正文 reserves its IDs without becoming an issue row", async () => {
  const source = canonical.replace(
    "**验收判据**：重启后保持上次宽度。",
    "**相关项**：\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 21 | 未决 | P2 | 正文引用的条目 |\n\n**验收判据**：重启后保持上次宽度。",
  );
  const file = ledgerFile("body-table.md", source);
  const check = await run(["check", file, "--json"]);
  expect(check.code).toBe(0);
  const checked = JSON.parse(check.stdout);
  expect(checked.warnings.some(({ code }: { code: string }) => code === "W225")).toBe(false);
  const view = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(view.citedRows).toEqual([expect.objectContaining({
    reason: expect.stringContaining("## 正文"),
    ids: ["21"],
  })]);
  const missing = await run(["show", file, "21"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("cited at L");
  expect(missing.stderr).toContain("## 正文");
  const explicit = await run(["new", file, "--id", "21", "--title", "撞号"]);
  expect(explicit.code).toBe(2);
  expect(explicit.stderr).toContain("reserved");
  const next = await run(["new", ledgerFile("body-next.md", source), "--title", "默认取号"]);
  expect(next.stdout.trim()).toBe("22");
});

test("close --keep-body does not release IDs from a body table into the appendix", async () => {
  const file = ledgerFile("archive-table.md", canonical);
  const bodyFile = join(dir, "body-table.txt");
  writeFileSync(bodyFile, [
    "**现象**：引用列表如下。", "", "| # | 状态 | P | 摘要 |", "|---|---|---|---|",
    "| 21 | 未决 | P2 | 正文归档引用 |", "", "**验收判据**：编号 21 不会被重新分配。", "",
  ].join("\n"));
  expect((await run(["body", file, "2", "--body-file", bodyFile])).code).toBe(0);
  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows).toEqual([expect.objectContaining({ ids: ["21"] })]);
  expect((await run(["new", file, "--id", "21", "--title", "撞号"])).code).toBe(2);
  const next = await run(["new", ledgerFile("archive-next.md", readFileSync(file, "utf8")), "--title", "默认取号"]);
  expect(next.stdout.trim()).toBe("22");
});

test("commented and controlled-section tables do not reserve IDs", async () => {
  const source = canonical.replace(
    "<!-- issuemd:statuses:end -->",
    "<!-- issuemd:statuses:end -->\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 21 | 未决 | P2 | 受控小节外观表 |",
  ).replace(
    "## 附录\n",
    "## 附录\n\n<!--\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 22 | 未决 | P2 | 注释表 |\n-->\n",
  );
  const file = ledgerFile("ignored-tables.md", source);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows).toBeUndefined();
  const next = await run(["new", file, "--title", "下一个号"]);
  expect(next.stdout.trim()).toBe("21");
});

test("an inline HTML comment in 正文 cannot reserve a hidden table ID", async () => {
  const source = canonical.replace(
    "**验收判据**：重启后保持上次宽度。",
    "**备注**：<!--\n| # | 摘要 |\n|---|---|\n| 21 | 隐藏示例 |\n-->\n\n**验收判据**：重启后保持上次宽度。",
  );
  const file = ledgerFile("inline-comment-table.md", source);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows).toBeUndefined();
  expect((await run(["new", file, "--id", "21", "--title", "可用编号", "--dry-run"])).code).toBe(0);
});

test("a free-form pipe block with a width-mismatched separator is not a table", async () => {
  const source = canonical.replace(
    "## 附录\n",
    "## 附录\n\n| # | 说明 |\n|---|---|---|\n| 21 | 普通段落内容 |\n",
  );
  const file = ledgerFile("mismatched-separator.md", source);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows).toBeUndefined();
  expect((await run(["new", file, "--id", "21", "--title", "可用编号", "--dry-run"])).code).toBe(0);
});

test("with-body keeps exact, sibling, range, and overlap ownership", async () => {
  const prefix = canonical.slice(0, canonical.indexOf("## 索引"));
  const source = prefix + [
    "## 索引", "", "| # | 状态 | P | 摘要 |", "|---|---|---|---|",
    "| 2, 4 | 未决 | P2 | comma row |", "| 5–7 | 未决 | P2 | range row |",
    "| 8, 9 | 未决 | P2 | overlapping row |", "| 9 | 未决 | P2 | independent row |", "",
    "## 已关闭", "", "| # | 状态 | P | 摘要 | 判据 |", "|---|---|---|---|---|", "",
    "## 正文", "", "### Issue 4: comma row", "", "**验收判据**：comma criteria", "",
    "### Issue 6: range row", "", "**验收判据**：range criteria", "",
    "### Issue 9: independent row", "", "**验收判据**：independent criteria", "",
    "## 附录", "",
  ].join("\n");
  const file = ledgerFile("body-ownership.md", source);
  const listed = JSON.parse((await run(["list", file, "--json", "--with-body"])).stdout);
  expect(listed.issues[0]).toMatchObject({ id: "2, 4", bodyFrom: "4", criteria: "comma criteria" });
  expect(listed.issues[1]).toMatchObject({ id: "5–7", bodyFrom: "6", criteria: "range criteria" });
  expect(listed.issues[2]).toMatchObject({ id: "8, 9" });
  expect(listed.issues[2].labels).toBeUndefined();
  expect(listed.issues[2].bodyFrom).toBeUndefined();
  expect(listed.issues[3]).toMatchObject({ id: "9", criteria: "independent criteria" });
});

test("with-body keeps original range ownership when a later row overlaps", async () => {
  const prefix = canonical.slice(0, canonical.indexOf("## 索引"));
  const source = prefix + [
    "## 索引", "", "| # | 状态 | P | 摘要 |", "|---|---|---|---|",
    "| 2–100002 | 未决 | P2 | large range |", "| 3 | 观察 | P2 | overlapping singleton |", "",
    "## 已关闭", "", "| # | 状态 | P | 摘要 | 判据 |", "|---|---|---|---|---|", "",
    "## 正文", "", "### Issue 2: large range", "", "**验收判据**：range criteria", "",
    "## 附录", "",
  ].join("\n");
  const file = ledgerFile("overlapping-large-range.md", source);
  const listed = JSON.parse((await run(["list", file, "--json", "--with-body"])).stdout);
  expect(listed.issues[1]).toMatchObject({ id: "3", bodyFrom: "2", criteria: "range criteria" });
});

test("with-body reuses a sparse range fallback across expanded IDs", async () => {
  const count = 12_800;
  const prefix = canonical.slice(0, canonical.indexOf("## 索引"));
  const bodies = Array.from({ length: count / 2 }, (_, index) => {
    const id = index * 2 + 1;
    return `### Issue ${id}: sparse range\n\n**验收判据**：body ${id} exists.`;
  });
  const source = prefix + [
    "## 索引", "", "| # | 状态 | P | 摘要 |", "|---|---|---|---|",
    `| 1–${count} | 未决 | P2 | sparse range |`, "",
    "## 已关闭", "", "| # | 状态 | P | 摘要 | 判据 |", "|---|---|---|---|---|", "",
    "## 正文", "", ...bodies, "", "## 附录", "",
  ].join("\n");
  const file = ledgerFile("sparse-expanded-range.md", source);
  const started = performance.now();
  const result = await run(["list", file, "--expand", "--json", "--with-body"]);
  const elapsed = performance.now() - started;
  expect(result.code).toBe(0);
  console.log(`benchmark with-body expanded sparse range ${count}: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThan(1_000);
  const listed = JSON.parse(result.stdout);
  expect(listed.issueCount).toBe(count);
  expect(listed.issues[1]).toMatchObject({ id: "2", bodyFrom: "1", criteria: "body 1 exists." });
});

test("with-body indexes compact ranges without expanding every ID", () => {
  const prefix = canonical.slice(0, canonical.indexOf("## 索引"));
  const source = prefix + [
    "## 索引", "", "| # | 状态 | P | 摘要 |", "|---|---|---|---|", "",
    "## 已关闭", "", "| # | 状态 | P | 摘要 | 判据 |", "|---|---|---|---|---|",
    "| 1–90000 | 撤回 | | first compact range | retired |",
    "| 100001–190000 | 撤回 | | second compact range | retired |",
    "| 200001–290000 | 撤回 | | third compact range | retired |", "",
    "## 正文", "", "## 附录", "",
  ].join("\n");
  const ledger = parseLedger(source);
  expect(indexWithBody(ledger).rowsById.size).toBe(3);
});

test("with-body batch lookup stays below one second for 12,800 rows", async () => {
  const count = 12_800;
  const prefix = canonical.slice(0, canonical.indexOf("## 索引"));
  const openRows = Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return `| ${id} | 未决 | P2 | Item ${id} |`;
  });
  const bodies = Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return `### Issue ${id}: Item ${id}\n\n**验收判据**：item ${id} is retained.`;
  });
  const source = prefix + [
    "## 索引", "", "| # | 状态 | P | 摘要 |", "|---|---|---|---|", ...openRows, "",
    "## 已关闭", "", "| # | 状态 | P | 摘要 | 判据 |", "|---|---|---|---|---|", "",
    "## 正文", "", ...bodies, "", "## 附录", "",
  ].join("\n");
  const file = ledgerFile("large-batch.md", source);
  const started = performance.now();
  const result = await run(["list", file, "--json", "--with-body"]);
  const elapsed = performance.now() - started;
  expect(result.code).toBe(0);
  console.log(`benchmark with-body 12,800 single-id rows: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThan(1_000);
  const listed = JSON.parse(result.stdout);
  expect(listed.issueCount).toBe(count);
  expect(listed.issues[0]).toMatchObject({ id: "1", criteria: "item 1 is retained." });
});

test("with-body batch benchmark covers larger single and paired rows", async () => {
  const prefix = canonical.slice(0, canonical.indexOf("## 索引"));
  const cases = [
    { name: "single/6400", issueCount: 6_400, paired: false, bodyAt: "first" },
    { name: "paired-first/6400", issueCount: 6_400, paired: true, bodyAt: "first" },
    { name: "paired-second/6400", issueCount: 6_400, paired: true, bodyAt: "second" },
    { name: "paired-first/12800", issueCount: 12_800, paired: true, bodyAt: "first" },
    { name: "paired-second/12800", issueCount: 12_800, paired: true, bodyAt: "second" },
  ];
  for (const { name, issueCount, paired, bodyAt } of cases) {
    const rowCount = paired ? issueCount / 2 : issueCount;
    const openRows = Array.from({ length: rowCount }, (_, index) => {
      const first = paired ? index * 2 + 1 : index + 1;
      const idCell = paired ? `${first}, ${first + 1}` : String(first);
      return `| ${idCell} | 未决 | P2 | Item ${first} |`;
    });
    const bodies = Array.from({ length: issueCount }, (_, index) => {
      const id = paired ? index + 1 + (bodyAt === "second" && index % 2 === 0 ? 1 : 0) : index + 1;
      const rowFirst = paired ? Math.floor(index / 2) * 2 + 1 : id;
      return `### Issue ${id}: Item ${rowFirst}\n\n**验收判据**：item ${id} is retained.`;
    }).filter((_, index) => !paired || (bodyAt === "first" ? index % 2 === 0 : index % 2 === 1));
    const source = prefix + [
      "## 索引", "", "| # | 状态 | P | 摘要 |", "|---|---|---|---|", ...openRows, "",
      "## 已关闭", "", "| # | 状态 | P | 摘要 | 判据 |", "|---|---|---|---|---|", "",
      "## 正文", "", ...bodies, "", "## 附录", "",
    ].join("\n");
    const file = ledgerFile(`${name.replaceAll("/", "-")}.md`, source);
    const started = performance.now();
    const result = await run(["list", file, "--json", "--with-body"]);
    const elapsed = performance.now() - started;
    expect(result.code).toBe(0);
    const listed = JSON.parse(result.stdout);
    expect(listed.issueCount).toBe(issueCount);
    expect(listed.issues[0]).toMatchObject({
      id: paired ? "1, 2" : "1",
      criteria: `item ${paired && bodyAt === "second" ? 2 : 1} is retained.`,
      ...(paired && bodyAt === "second" ? { bodyFrom: "2" } : {}),
    });
    console.log(`benchmark with-body ${name}: ${elapsed.toFixed(1)} ms`);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
