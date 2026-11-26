import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-round18-"));

function ledgerFile(name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

test("an unclosed comment keeps later appendix table IDs reserved and reports its opener", async () => {
  const source = canonical.replace(
    "## 附录\n",
    "## 附录\n\n<!-- unfinished note\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 21 | 未决 | P2 | cited after the comment |\n",
  );
  const file = ledgerFile("unclosed-comment.md", source);
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings).toEqual([expect.objectContaining({ code: "W262", message: expect.stringContaining("Unclosed") })]);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows).toEqual([expect.objectContaining({ ids: ["21"], reason: expect.stringContaining("unclosed HTML comment") })]);
  const collision = await run(["new", file, "--id", "21", "--title", "duplicate"]);
  expect(collision.code).toBe(2);
  expect(collision.stderr).toContain("reserved");
  const next = await run(["new", file, "--title", "next"]);
  expect(next.stdout).toBe("22\n");
});

test("a comment opener in an issue table cell does not hide later cited rows", async () => {
  const source = canonical.replace(
    "## 附录\n",
    "## 附录\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 21 | 未决 | P2 | A <!-- B |\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 22 | 未决 | P2 | later row |\n",
  );
  const file = ledgerFile("table-opener.md", source);
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.some(({ code }: { code: string }) => code === "W262")).toBe(false);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows.map(({ ids }: { ids: string[] }) => ids)).toEqual([["21"], ["22"]]);
});

test("a fenced comment opener does not hide later cited rows", async () => {
  const source = canonical.replace(
    "## 附录\n",
    "## 附录\n\n```html\n<!-- example\n```\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 21 | 未决 | P2 | visible row |\n",
  );
  const file = ledgerFile("fenced-comment.md", source);
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.some(({ code }: { code: string }) => code === "W262")).toBe(false);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows.map(({ ids }: { ids: string[] }) => ids)).toEqual([["21"]]);
});

test("a properly closed prose comment continues to hide its example table", async () => {
  const source = canonical.replace(
    "## 附录\n",
    "## 附录\n\n<!-- example starts\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 21 | 未决 | P2 | commented example |\n-->\n",
  );
  const file = ledgerFile("closed-comment.md", source);
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.some(({ code }: { code: string }) => code === "W262")).toBe(false);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows).toBeUndefined();
});

test("a comment that crosses an H2 boundary still reserves appendix IDs", async () => {
  const source = canonical.replace(
    "## 附录\n",
    "<!-- open in the preceding section\n\n## 附录\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 21 | 未决 | P2 | appendix row |\n",
  );
  const file = ledgerFile("cross-section-comment.md", source);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows).toEqual([expect.objectContaining({ ids: ["21"] })]);
});

test.each(["<!--", "-->"])("new refuses raw HTML comment delimiter %s in a title", async (delimiter) => {
  const file = ledgerFile(`new-comment-${delimiter === "<!--" ? "open" : "close"}.md`, canonical);
  const before = readFileSync(file, "utf8");
  const result = await run(["new", file, "--title", `literal ${delimiter} example`]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("HTML comment");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("rename refuses a raw HTML comment delimiter without changing the ledger", async () => {
  const file = ledgerFile("rename-comment.md", canonical);
  const before = readFileSync(file, "utf8");
  const result = await run(["rename", file, "2", "literal <!-- example"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("HTML comment");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("close refuses to make a pre-existing E106 disappear", async () => {
  const source = canonical.replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: 侧栏宽度不可调（旧）");
  const file = ledgerFile("close-e106.md", source);
  const before = readFileSync(file, "utf8");
  const result = await run(["close", file, "2", "--criteria", "closed"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toContain("E106");
  expect(result.stderr).toContain("#2");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("close keep-body refuses to archive an E110 body that cannot be reopened", async () => {
  const source = canonical.replace("**根因**", "#### subsection\n\n**根因**");
  const file = ledgerFile("close-e110.md", source);
  const before = readFileSync(file, "utf8");
  const result = await run(["close", file, "2", "--keep-body"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toContain("E110");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("close refuses to erase a baseline heading-count error", async () => {
  const source = canonical.replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: 侧栏宽度不可调（2）");
  const file = ledgerFile("close-e121.md", source);
  expect(JSON.parse((await run(["check", file, "--json"])).stdout).errors.some(({ code }: { code: string }) => code === "E121")).toBe(true);
  const before = readFileSync(file, "utf8");
  const result = await run(["close", file, "2", "--criteria", "closed"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toContain("E121");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("close may resolve the selected issue's own missing-body E102", async () => {
  const source = canonical.replace("### Issue 2: 侧栏宽度不可调\n\n", "");
  const file = ledgerFile("close-own-e102.md", source);
  expect(JSON.parse((await run(["check", file, "--json"])).stdout).errors.some(({ code, id }: { code: string; id?: string }) => code === "E102" && id === "2")).toBe(true);
  const result = await run(["close", file, "2", "--criteria", "closed"]);
  expect(result.code).toBe(0);
  expect((await run(["check", file])).code).toBe(0);
});

test("sync --titles requires explicit consent for unrelated summary and body wording", async () => {
  for (const args of [["--titles"], ["--titles", "--prefer", "body"]]) {
    const source = canonical.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 完全不同（PR-1234） |");
    const file = ledgerFile(`sync-refused-${args.length}.md`, source);
    const before = readFileSync(file, "utf8");
    const result = await run(["sync", file, ...args]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("完全不同（PR-1234）");
    expect(result.stderr).toContain("侧栏宽度不可调");
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("sync --titles move-progress preserves unrelated table wording and reports the change", async () => {
  const source = canonical.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 完全不同（PR-1234） |");
  const previewFile = ledgerFile("sync-move-preview.md", source);
  const preview = await run(["sync", previewFile, "--titles", "--prefer", "body", "--move-progress", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stderr).toContain('updated #2 summary: "完全不同（PR-1234）" → "侧栏宽度不可调"');
  const file = ledgerFile("sync-move.md", source);
  const result = await run(["sync", file, "--titles", "--prefer", "body", "--move-progress"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('updated #2 summary: "完全不同（PR-1234）" → "侧栏宽度不可调"');
  const written = readFileSync(file, "utf8");
  expect(written).toContain("### Issue 2: 侧栏宽度不可调");
  expect(written).toContain("> **进展（来自旧表）**：完全不同（PR-1234）");
});

test("sync --titles drop-progress explicitly discards and reports the table summary", async () => {
  const source = canonical.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 完全不同（PR-1234） |");
  const file = ledgerFile("sync-drop.md", source);
  const result = await run(["sync", file, "--titles", "--prefer", "body", "--drop-progress"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('updated #2 summary: "完全不同（PR-1234）" → "侧栏宽度不可调"');
  expect(readFileSync(file, "utf8")).not.toContain("PR-1234");
});

test("sync --titles prefer-table reports the body title change", async () => {
  const source = canonical.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 完全不同（PR-1234） |");
  const previewFile = ledgerFile("sync-table-preview.md", source);
  const preview = await run(["sync", previewFile, "--titles", "--prefer", "table", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stderr).toContain('updated #2 body title: "侧栏宽度不可调" → "完全不同（PR-1234）"');
  const file = ledgerFile("sync-table.md", source);
  const result = await run(["sync", file, "--titles", "--prefer", "table"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('updated #2 body title: "侧栏宽度不可调" → "完全不同（PR-1234）"');
  expect(readFileSync(file, "utf8")).toContain("### Issue 2: 完全不同（PR-1234）");
});

test("split warns when it creates duplicate open summaries", async () => {
  const source = canonical
    .replace("| 4 | 观察 | P3 | 长列表滚动掉帧 |", "| 4, 22 | 观察 | P3 | 长列表滚动掉帧 |")
    .replace("## 附录\n", "### Issue 22: 长列表滚动掉帧\n\n**现象**：另一份复现。\n\n**验收判据**：重现滚动掉帧。\n\n## 附录\n");
  const file = ledgerFile("split-duplicate-title.md", source);
  expect((await run(["check", file, "--strict"])).code).toBe(0);
  const result = await run(["split", file, "4"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("W212");
  expect(result.stderr).toContain("#4");
  expect(result.stderr).toContain("#22");
  expect(result.stderr).toContain("issuemd rename");
  expect((await run(["check", file, "--strict"])).code).toBe(3);
});

test("reopen restores a fixed issue's criterion as the acceptance criterion", async () => {
  const file = ledgerFile("reopen-fixed.md", canonical);
  const result = await run(["reopen", file, "1"]);
  expect(result.code).toBe(0);
  const issue = JSON.parse((await run(["show", file, "1", "--json"])).stdout);
  expect(issue.criteria).toBe("`a1b2c3d`：连续 3 轮 12/12");
  expect(issue.labels["验收判据"]).toContain("a1b2c3d");
});

test.each(["延后", "决定不改", "不是缺陷", "范围外", "撤回", "并入", "未分类"])("reopen of %s preserves the cell as a closure rationale", async (status) => {
  const source = canonical.replace("| 5 | 决定不改 |", `| 5 | ${status} |`);
  const file = ledgerFile(`reopen-rationale-${status}.md`, source);
  const result = await run(["reopen", file, "5"]);
  expect(result.code).toBe(0);
  const issue = JSON.parse((await run(["show", file, "5", "--json"])).stdout);
  expect(issue.criteria).toBeUndefined();
  expect(issue.labels["关闭理由"]).toBe("产品裁决：只支持常青浏览器");
  expect(issue.labels["验收判据"]).toBeUndefined();
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.some(({ code, id }: { code: string; id?: string }) => code === "W261" && id === "5")).toBe(true);
});

test("reopen of a no-criteria row succeeds and points out the missing acceptance criteria", async () => {
  const file = ledgerFile("reopen-no-criteria.md", canonical);
  expect((await run(["close", file, "2", "--no-criteria"])).code).toBe(0);
  const result = await run(["reopen", file, "2"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("acceptance criteria");
  expect(result.stderr).toContain("W261");
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.some(({ code, id }: { code: string; id?: string }) => code === "W261" && id === "2")).toBe(true);
});

test("reopen keeps an archived body criterion current when the closed cell differs", async () => {
  const file = ledgerFile("reopen-archive-criteria.md", canonical);
  expect((await run(["close", file, "2", "--keep-body", "--criteria", "closed-cell B"])).code).toBe(0);
  expect((await run(["reopen", file, "2"])).code).toBe(0);
  const issue = JSON.parse((await run(["show", file, "2", "--json"])).stdout);
  expect(issue.criteria).toBe("重启后保持上次宽度。");
  expect(issue.labels["关闭时判据"]).toBe("closed-cell B");
});

test("reopen preserves closed-table commit evidence without creating W202", async () => {
  const file = ledgerFile("reopen-inline-commit.md", canonical);
  expect((await run(["reopen", file, "1"])).code).toBe(0);
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.some(({ code, message }: { code: string; message: string }) => code === "W202" && message.includes("a1b2c3d"))).toBe(false);
  expect((await run(["check", file, "--strict"])).code).toBe(0);
});

test("close keep-body then reopen remains byte-identical when criteria agree", async () => {
  const file = ledgerFile("reopen-archive-roundtrip.md", canonical);
  const before = readFileSync(file, "utf8");
  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "2"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("W202 ignores an inline-code hash after a UUID on the same line", async () => {
  const source = canonical.replace(
    "**现象**：侧栏固定 240px，无法拖拽。",
    "**现象**：ref 123e4567-e89b-12d3-a456-426614174000 then `a1b2c3d`.",
  );
  const file = ledgerFile("inline-hash-after-uuid.md", source);
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.some(({ code, message }: { code: string; message: string }) => code === "W202" && message.includes("a1b2c3d"))).toBe(false);
});

test("list, counts, and show JSON always expose errors and warnings for one snapshot", async () => {
  const warningSource = canonical.replace("| 3 | 部分解决 |", "| 3 | 半解决 |");
  const warningFile = ledgerFile("json-warning-only.md", warningSource);
  for (const [command, rest] of [["list", []], ["counts", []], ["show", ["3"]]] as const) {
    const result = JSON.parse((await run([command, warningFile, ...rest, "--json"])).stdout);
    expect(result.diagnostics).toEqual(expect.objectContaining({
      errors: [],
      warnings: [expect.objectContaining({ code: "W220", id: "3" })],
    }));
  }

  const mixedFile = ledgerFile("json-mixed.md", warningSource.replace(
    "### Issue 2: 侧栏宽度不可调",
    "### Issue 2: 侧栏宽度不可调（旧）",
  ));
  const checked = JSON.parse((await run(["check", mixedFile, "--json"])).stdout);
  for (const [command, rest] of [["list", []], ["counts", []], ["show", ["3"]]] as const) {
    const result = JSON.parse((await run([command, mixedFile, ...rest, "--json"])).stdout);
    expect(result.diagnostics.errors.map(({ code, line, id }: { code: string; line: number; id?: string }) => ({ code, line, id })))
      .toEqual(checked.errors.map(({ code, line, id }: { code: string; line: number; id?: string }) => ({ code, line, id })));
    expect(result.diagnostics.warnings.map(({ code, line, id }: { code: string; line: number; id?: string }) => ({ code, line, id })))
      .toEqual(checked.warnings.map(({ code, line, id }: { code: string; line: number; id?: string }) => ({ code, line, id })));
  }

  const cleanFile = ledgerFile("json-clean.md", canonical);
  for (const [command, rest] of [["list", []], ["counts", []], ["show", ["2"]]] as const) {
    const result = JSON.parse((await run([command, cleanFile, ...rest, "--json"])).stdout);
    expect(result.diagnostics).toEqual({ errors: [], warnings: [] });
  }
});

test("check and counts JSON expose the same cited rows as list JSON", async () => {
  const source = canonical.replace(
    "## 附录\n",
    "## 附录\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 21 | 未决 | P2 | cited row |\n",
  );
  const file = ledgerFile("cited-json.md", source);
  const list = JSON.parse((await run(["list", file, "--json"])).stdout);
  const check = JSON.parse((await run(["check", file, "--json"])).stdout);
  const counts = JSON.parse((await run(["counts", file, "--json"])).stdout);
  expect(check.citedRows).toEqual(list.citedRows);
  expect(counts.citedRows).toEqual(list.citedRows);
  const clean = ledgerFile("no-cited-json.md", canonical);
  expect(JSON.parse((await run(["check", clean, "--json"])).stdout).citedRows).toBeUndefined();
});

test("list priority reports when the value occurs only in the other table", async () => {
  const closedOnlySource = canonical.replace("| 1 | 已修 | P3 |", "| 1 | 已修 | P0 |");
  const closedOnly = ledgerFile("priority-closed-only.md", closedOnlySource);
  const absent = await run(["list", closedOnly, "--priority", "P0"]);
  expect(absent.code).toBe(1);
  expect(absent.stderr).toContain("closed");
  expect((await run(["list", closedOnly, "--closed", "--priority", "P0"])).code).toBe(0);
  const both = ledgerFile("priority-both.md", closedOnlySource.replace("| 2 | 未决 | P1 |", "| 2 | 未决 | P0 |"));
  const present = await run(["list", both, "--priority", "P0"]);
  expect(present.code).toBe(0);
  expect(present.stderr).toBe("");
  expect((await run(["list", both, "--priority", "Q9"])).code).toBe(2);
});

test("status summaries include every undeclared open status and filters identify W220", async () => {
  const oneUnknownSource = canonical.replace("| 3 | 部分解决 |", "| 3 | 半解决 |");
  const oneUnknown = ledgerFile("one-unknown-status.md", oneUnknownSource);
  for (const command of ["check", "counts"]) {
    const result = await run([command, oneUnknown]);
    expect(result.stdout).toContain("open 3 (未决 1, 观察 1, 半解决 1)");
  }
  const filtered = await run(["list", oneUnknown, "--status", "半解决"]);
  expect(filtered.code).toBe(0);
  expect(filtered.stderr).toContain("W220");
  expect((await run(["list", oneUnknown, "--status", "不存在"])).code).toBe(2);

  const twoUnknown = ledgerFile("two-unknown-statuses.md", oneUnknownSource.replace("| 4 | 观察 |", "| 4 | 处理中 |"));
  expect((await run(["counts", twoUnknown])).stdout).toContain("open 3 (未决 1, 半解决 1, 处理中 1)");
});

test("overlapping invalid open rows keep raw status buckets and structural errors visible", async () => {
  const source = canonical.replace(
    "| 2 | 未决 | P1 | 侧栏宽度不可调 |",
    "| 2 | 未决 | P1 | 侧栏宽度不可调 |\n| 2 | 观察 | P1 | duplicate row |",
  );
  const file = ledgerFile("overlapping-statuses.md", source);
  const checked = await run(["counts", file]);
  expect(checked.code).toBe(0);
  expect(checked.stdout).toContain("open 3 (未决 1, 部分解决 1, 观察 2)");
  expect(checked.stderr).toContain("E103");
});

test("verify-commits reports a skipped check outside Git and strict treats it as a warning", async () => {
  const file = ledgerFile("verify-non-git.md", canonical);
  const normal = await run(["check", file, "--verify-commits", "--json"]);
  expect(normal.code).toBe(0);
  expect(JSON.parse(normal.stdout).warnings).toContainEqual(expect.objectContaining({
    code: "W263",
    message: expect.stringContaining("not a Git repository"),
  }));
  const strict = await run(["check", file, "--verify-commits", "--strict", "--json"]);
  expect(strict.code).toBe(3);
  expect(JSON.parse(strict.stdout).warnings.some(({ code }: { code: string }) => code === "W263")).toBe(true);
});

test("verify-commits outside Git reports both skipped verification and ledger errors", async () => {
  const source = canonical.replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: different title");
  const file = ledgerFile("verify-non-git-error.md", source);
  const result = await run(["check", file, "--verify-commits", "--json"]);
  expect(result.code).toBe(3);
  const report = JSON.parse(result.stdout);
  expect(report.errors.some(({ code }: { code: string }) => code === "E106")).toBe(true);
  expect(report.warnings.some(({ code }: { code: string }) => code === "W263")).toBe(true);
});

test("verify-commits inside Git reports missing commits as W240, not W263", async () => {
  const repo = join(dir, "verify-git-repo");
  mkdirSync(repo);
  const initialized = spawnSync("git", ["init", repo], { encoding: "utf8" });
  expect(initialized.status).toBe(0);
  const file = join(repo, "ledger.md");
  writeFileSync(file, canonical);
  const result = await run(["check", file, "--verify-commits", "--json"]);
  expect(result.code).toBe(0);
  const warnings = JSON.parse(result.stdout).warnings;
  expect(warnings.some(({ code, message }: { code: string; message: string }) => code === "W240" && message.includes("a1b2c3d"))).toBe(true);
  expect(warnings.some(({ code }: { code: string }) => code === "W263")).toBe(false);
});

test("reopen protects a commit hash adjacent to an unmatched backtick", async () => {
  const source = canonical.replace("`a1b2c3d`：连续 3 轮 12/12", "此前 `a1b2c3d 后续验证");
  const file = ledgerFile("reopen-unmatched-tick.md", source);
  expect((await run(["reopen", file, "1"])).code).toBe(0);
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.some(({ code, message }: { code: string; message: string }) => code === "W202" && message.includes("a1b2c3d"))).toBe(false);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
