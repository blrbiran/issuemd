/**
 * Regressions from the 2026-11-24 dogfooding ledger (issue-20261124.md).
 * Each describe names the dogfood issue number it pins down.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.js";

const TEMPLATE = readFileSync(new URL("../TEMPLATE.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-dogfood-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function file(content = TEMPLATE, ext = "md"): string {
  const path = join(dir, `f-${counter++}.${ext}`);
  writeFileSync(path, content);
  return path;
}
const text = (path: string) => readFileSync(path, "utf8");
const body = (content: string) => file(content, "txt");

async function withIssue(content: string) {
  const path = file();
  expect((await run(["new", path, "--title", "甲", "--body-file", body(content)])).code).toBe(0);
  return path;
}
async function closedCriteria(path: string, id = "1") {
  const listed = await run(["list", path, "--closed", "--json"]);
  return (JSON.parse(listed.stdout).issues as { id: string; criteria: string }[]).find((i) => i.id === id)?.criteria;
}

describe("#35 adopt --report never clobbers files", () => {
  test("--report pointing at the ledger itself is refused, bytes unchanged", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const before = text(path);
    for (const extra of [[], ["--dry-run"]]) {
      const result = await run(["adopt", path, "--report", path, ...extra]);
      expect(result.code).toBe(2);
      expect(text(path)).toBe(before);
    }
  });

  test("--dry-run --report writes the report (the documented review flow) but not the ledger", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const before = text(path);
    const report = join(dir, `report-${counter++}.md`);
    expect((await run(["adopt", path, "--report", report, "--dry-run"])).code).toBe(0);
    expect(text(report)).toStartWith("adopt: ");
    expect(text(path)).toBe(before);
    // Re-running over its own previous report is allowed.
    expect((await run(["adopt", path, "--report", report, "--dry-run"])).code).toBe(0);
  });

  test("an existing unrelated file is not overwritten", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const notes = file("PRECIOUS NOTES\n", "txt");
    const result = await run(["adopt", path, "--report", notes]);
    expect(result.code).toBe(2);
    expect(text(notes)).toBe("PRECIOUS NOTES\n");
  });
});

describe("#47 new --status <closed> message", () => {
  test("no shell-escape debris", async () => {
    const result = await run(["new", file(), "--status", "已修", "--title", "p"]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("'''");
    expect(result.stderr).toContain("issuemd close");
  });
});

describe("#39 id overflow", () => {
  test("default max+1 past the safe range is a diagnostic, not a stack", async () => {
    const path = file();
    const max = String(Number.MAX_SAFE_INTEGER);
    expect((await run(["new", path, "--id", max, "--title", "题"])).code).toBe(0);
    const before = text(path);
    const result = await run(["new", path, "--title", "下一条"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("issuemd new:");
    expect(text(path)).toBe(before);
  });
});

describe("#29 labels span blank lines and lists", () => {
  const listBody = "**现象**：a\n\n**根因**：\n\n1. 第一项\n2. 第二项\n\n**验收判据**：\n\n- 条一\n- 条二\n";

  test("show --label reads a label followed by a blank line and a list", async () => {
    const path = await withIssue(listBody);
    const root = await run(["show", path, "1", "--label", "根因"]);
    expect(root.code).toBe(0);
    expect(root.stdout).toContain("1. 第一项");
    expect(root.stdout).toContain("2. 第二项");
    const criteria = await run(["show", path, "1", "--label", "验收判据"]);
    expect(criteria.stdout).toContain("条一");
    expect(criteria.stdout).toContain("条二");
    expect(criteria.stdout).not.toContain("**根因**");
  });

  test("close --criteria-from-body lifts every list item into the cell", async () => {
    const path = await withIssue(listBody);
    expect((await run(["close", path, "1", "--criteria-from-body"])).code).toBe(0);
    const criteria = await closedCriteria(path);
    expect(criteria).toContain("条一");
    expect(criteria).toContain("条二");
    expect((await run(["check", path])).code).toBe(0);
  });

  test("a label with nothing under it is reported as empty, not as success text", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：\n\n**期望**：b\n");
    const result = await run(["show", path, "1", "--label", "验收判据"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("empty");
  });
});

describe("#8/#22 close never silently drops criteria", () => {
  test("no criteria flag: criteria in the body are promoted", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：重启后保持宽度\n");
    expect((await run(["close", path, "1"])).code).toBe(0);
    expect(await closedCriteria(path)).toBe("重启后保持宽度");
  });

  test("no criteria anywhere and no flag: refused, bytes unchanged", async () => {
    const path = await withIssue("**现象**：a\n");
    const before = text(path);
    const result = await run(["close", path, "1"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--no-criteria");
    expect(text(path)).toBe(before);
  });

  test("--no-criteria closes with an empty cell on purpose", async () => {
    const path = await withIssue("**现象**：a\n");
    expect((await run(["close", path, "1", "--no-criteria"])).code).toBe(0);
    expect(await closedCriteria(path)).toBe("");
  });

  test("--criteria-from-body with no criteria in the body is refused", async () => {
    const path = await withIssue("**现象**：a\n\n```\n**验收判据**：示例\n```\n");
    const before = text(path);
    expect((await run(["close", path, "1", "--criteria-from-body"])).code).toBe(2);
    expect(text(path)).toBe(before);
  });

  test("--keep-body without criteria still closes: nothing is lost", async () => {
    const path = await withIssue("**现象**：a\n");
    expect((await run(["close", path, "1", "--keep-body"])).code).toBe(0);
  });

  test("--no-criteria conflicts with the other criteria flags", async () => {
    const path = await withIssue("**现象**：a\n");
    expect((await run(["close", path, "1", "--no-criteria", "--criteria", "x"])).code).toBe(2);
    expect((await run(["close", path, "1", "--no-criteria", "--criteria-from-body"])).code).toBe(2);
  });
});

// ---- adopt: preserve everything, decide nothing silently -----------------

async function adopted(source: string, ...extra: string[]) {
  const path = file(source);
  const result = await run(["adopt", path, ...extra]);
  return { path, result, out: text(path) };
}

const CLOSED_GROUPS = `# 台账

## 待处理

| # | 状态 | P | 摘要 |
|---|---|---|---|
| 7 | 未决 | P1 | 还开着 |

## 正文

### Issue 7: 还开着

**验收判据**：y

## 已关闭

### 决定不改

| # | 说明 |
|---|---|
| 20, 24, 29 | 产品/设计取舍，不是待修 bug |

### 延后

| # | 说明 |
|---|---|
| 108 | split 流程重构转设计 |

### owner 裁决不跟踪

> owner 2026-11-19 裁决：以下编号不按 bug 继续跟踪。

| # | 摘要 | 裁决 |
|---|---|---|
| 60 | 部分功能未完全实现 | 决定不改：没有逐条可执行清单 |
| 191 | 需求管线背隐藏前缀 | 不是缺陷：provider 侧计量 |
| 230 | 杂项 | 以后再说 |
`;

describe("#12 adopt leaves a canonical ledger alone", () => {
  test("the empty template is not 'not a ledger'", async () => {
    const { result, out } = await adopted(TEMPLATE);
    expect(result.code).toBe(0);
    expect(out).toBe(TEMPLATE);
  });

  test("a check-clean ledger is byte-identical after adopt", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const before = text(path);
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("已是规范台账");
    expect(text(path)).toBe(before);
  });
});

describe("#42/#43 adopt maps every closed group and never invents 已修", () => {
  test("width-2 groups keep their ids and take the group status", async () => {
    const { result, path } = await adopted(CLOSED_GROUPS);
    expect(result.code).toBe(0);
    const closed = JSON.parse((await run(["list", path, "--closed", "--json"])).stdout).issues as
      { id: string; status: string; summary: string; criteria: string }[];
    const byId = new Map(closed.map((issue) => [issue.id, issue]));
    expect(byId.get("20, 24, 29")?.status).toBe("决定不改");
    expect(byId.get("108")?.status).toBe("延后");
    expect((await run(["counts", path])).stdout).toContain("closed 7");
  });

  test("a verdict column starting with a status word sets the status and keeps the reason", async () => {
    const { path, out } = await adopted(CLOSED_GROUPS);
    const closed = JSON.parse((await run(["list", path, "--closed", "--json"])).stdout).issues as
      { id: string; status: string; criteria: string }[];
    const byId = new Map(closed.map((issue) => [issue.id, issue]));
    expect(byId.get("60")?.status).toBe("决定不改");
    expect(byId.get("60")?.criteria).toContain("没有逐条可执行清单");
    expect(byId.get("191")?.status).toBe("不是缺陷");
    // No status anywhere: 未分类 ("unknown"), never the success word 已修.
    expect(byId.get("230")?.status).toBe("未分类");
    expect(byId.get("230")?.criteria).toContain("以后再说");
    expect(out).not.toMatch(/\| (60|191|230) \| 已修 \|/);
  });

  test("group prose (the ruling quote) survives, and unknown-group has a real line", async () => {
    const { result, out } = await adopted(CLOSED_GROUPS);
    expect(out).toContain("> owner 2026-11-19 裁决：以下编号不按 bug 继续跟踪。");
    expect(result.stdout).toContain("unknown-group");
    expect(result.stdout).not.toMatch(/^\s+L0 /m);
  });
});

describe("#41/#49 adopt keeps prose around tables and in the header", () => {
  const NARRATIVE = `# 台账

> 口径：老组不走新预算不算未解决。

## 怎么用

写作约定：每条要自包含。

## 待处理

### 未决

| # | 状态 | P | 摘要 |
|---|---|---|---|
| 7 | 未决 | P1 | 还开着 |

### 第二十轮 diff 复核

复核了 a..b，结论如下。

- 第一条结论

## 正文

### Issue 7: 还开着

**验收判据**：y
`;

  test("the header quote stays under the H1, the guide prose stays in 怎么用", async () => {
    const { result, out } = await adopted(NARRATIVE);
    expect(result.code).toBe(0);
    const header = out.slice(0, out.indexOf("## 怎么用"));
    expect(header).toContain("> 口径：老组不走新预算不算未解决。");
    const guide = out.slice(out.indexOf("## 怎么用"), out.indexOf("## 状态口径"));
    expect(guide).toContain("写作约定：每条要自包含。");
    expect(guide).toContain("<!-- issuemd:guide:begin -->");
  });

  test("a narrative H3 inside 待处理 moves to 附录 verbatim, with a decision", async () => {
    const { result, out } = await adopted(NARRATIVE);
    const appendix = out.slice(out.indexOf("## 附录"));
    expect(appendix).toContain("### 第二十轮 diff 复核");
    expect(appendix).toContain("复核了 a..b，结论如下。");
    expect(appendix).toContain("- 第一条结论");
    expect(result.stdout).toContain("第二十轮 diff 复核");
    expect((await run(["check", file(out)])).code).toBe(0);
  });

  test("an unmapped table inside a ledger section is kept, not dropped", async () => {
    const source = NARRATIVE.replace("### 第二十轮 diff 复核", "### 奇怪的表\n\n| # | a | b | c | d | e |\n|---|---|---|---|---|---|\n| 31 | 1 | 2 | 3 | 4 | 5 |\n\n### 第二十轮 diff 复核");
    const { result, out } = await adopted(source);
    expect(result.code).toBe(0);
    expect(out).toContain("| 31 | 1 | 2 | 3 | 4 | 5 |");
  });
});

describe("#28 a refused adopt points at the source file", () => {
  test("diagnostics carry the source line and an unescaped-pipe hint", async () => {
    const source = `# 台账

## 待处理

| # | 状态 | P | 摘要 |
|---|---|---|---|
| 7 | 未决 | P1 | 还开着 |

## 正文

### Issue 7: 还开着

| 协议 | 位置 |
|---|---|
| \`order/ack|heartbeat\` | src/index.ts |

**验收判据**：y
`;
    const path = file(source);
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("source L15");
    expect(result.stderr).toContain("unescaped '|'");
  });
});

describe("adopt recognises annotated canonical titles (real-ledger run)", () => {
  test("`## 正文（按编号）` is 正文: each open body appears exactly once", async () => {
    const { result, out } = await adopted(`# 台账

## 待处理

| # | 状态 | P | 摘要 |
|---|---|---|---|
| 7 | 未决 | P1 | 还开着 |

## 已关闭（只留判据，不再跟踪）

| # | 摘要 | 判据 |
|---|---|---|
| 3 | 旧的 | 测试通过 |

## 正文（按编号）

### Issue 7: 还开着

**现象**：独一无二的现象描述

**验收判据**：y
`);
    expect(result.code).toBe(0);
    expect(out.split("独一无二的现象描述").length - 1).toBe(1);
    expect(out).not.toContain("## 正文（按编号）");
    expect(result.stdout).toContain("正文（按编号） → 正文");
  });
});

describe("#48 new keeps a blank line before an appended body", () => {
  const noAppendix = TEMPLATE.replace(/\n## 附录[\s\S]*$/, "\n");
  test("after a hand-written last body that ends without a blank line", async () => {
    const path = file(noAppendix.replace(/\n*$/, "\n\n### Issue 1: first\n\n**现象**\n\nx\n").replace(
      "|---|---|---|---|\n", "|---|---|---|---|\n| 1 | 未决 | P2 | first |\n"));
    for (const title of ["second", "third"]) {
      expect((await run(["new", path, "--title", title, "--body-file", body("**现象**\n\ny\n")])).code).toBe(0);
    }
    const out = text(path);
    expect(out).toContain("x\n\n### Issue 2: second");
    expect(out).toContain("y\n\n### Issue 3: third");
    expect(out).not.toContain("\n\n\n### Issue");
  });
});

describe("#13/#14 options are checked per command", () => {
  test("an option the command does not take is a usage error", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    for (const args of [["list", path, "--title", "x"], ["check", path, "--closed"], ["new", path, "--title", "j", "--json"],
      ["close", path, "1", "--json"], ["show", path, "1", "--dry-run"]]) {
      const before = text(path);
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/not supported by '\w+'/);
      expect(text(path)).toBe(before);
    }
  });

  test("issuemd <command> --help prints that command's usage and options only", async () => {
    const result = await run(["close", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/issuemd close +FILE ID/);
    expect(result.stdout).toContain("--keep-body");
    expect(result.stdout).toContain("--status");
    expect(result.stdout).not.toContain("--fix-tables");
    expect(result.stdout).not.toContain("--json");
  });

  test("global --help documents --status for list, new and close", async () => {
    const result = await run(["--help"]);
    const line = result.stdout.split("\n").find((l) => l.trimStart().startsWith("--status"))!;
    expect(line).toContain("list");
    expect(line).toContain("new");
    expect(line).toContain("close");
  });
});

describe("#33 list --status is validated", () => {
  test("an unknown status is a usage error that lists the vocabulary", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const result = await run(["list", path, "--status", "未決"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown status");
    expect(result.stderr).toContain("部分解决");
  });

  test("a closed status on the open table says to add --closed", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const result = await run(["list", path, "--status", "已修"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--closed");
  });

  test("an undeclared status that is actually in the ledger can still be listed", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    writeFileSync(path, text(path).replace("| 1 | 未决 |", "| 1 | 未觉 |"));
    expect((await run(["list", path, "--status", "未觉"])).code).toBe(0);
  });
});

describe("#9 priority vocabulary", () => {
  test("new refuses a priority outside P0–P3", async () => {
    const path = file();
    const before = text(path);
    const result = await run(["new", path, "--title", "x", "--priority", "Q9"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("P0");
    expect(text(path)).toBe(before);
    expect((await run(["new", path, "--title", "x", "--priority", "P0"])).code).toBe(0);
  });

  test("check warns about an undeclared priority already in the ledger", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    writeFileSync(path, text(path).replace("| 1 | 未决 | P2 |", "| 1 | 未决 | Q9 |"));
    const report = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(report.warnings.map((w: { code: string }) => w.code)).toContain("W221");
  });
});

async function threeIssues() {
  const path = file();
  for (const id of ["1", "2", "3"]) {
    expect((await run(["new", path, "--id", id, "--title", `题${id}`, "--body-file", body("**现象**：a\n\n**验收判据**：x\n")])).code).toBe(0);
  }
  return path;
}

describe("#36 unreadable rows are never silently dropped", () => {
  test("list/counts warn, show names the bad row, new does not reuse its id", async () => {
    const path = await threeIssues();
    writeFileSync(path, text(path).replace("| 3 | 未决 | P2 | 题3 |", "| 3 | 未决 | P2 | 题3 | 多一列 |"));
    const listed = await run(["list", path]);
    expect(listed.stderr).toContain("could not be read");
    expect((await run(["counts", path])).stderr).toContain("could not be read");
    const json = JSON.parse((await run(["list", path, "--json"])).stdout);
    expect(json.unreadableRows[0].line).toBeGreaterThan(0);
    const shown = await run(["show", path, "3"]);
    expect(shown.code).toBe(3);
    expect(shown.stderr).toContain("unreadable");
    writeFileSync(path, text(path).replace("| 2 | 未决 | P2 | 题2 |", "| 2 | 未决 | P2 | 题2 | 坏 |"));
    const before = text(path);
    const created = await run(["new", path, "--title", "新", "--id", "2"]);
    expect(created.code).toBe(2);
    expect(text(path)).toBe(before);
  });
});

describe("#31 list reports how many ids a row holds", () => {
  test("rows carry ids and count; --expand gives one entry per id", async () => {
    const fixture = new URL("../fixtures/canonical-clean.md", import.meta.url);
    const path = file(readFileSync(fixture, "utf8"));
    const json = JSON.parse((await run(["list", path, "--closed", "--json"])).stdout);
    const range = json.issues.find((issue: { id: string }) => issue.id === "7–20");
    expect(range.count).toBe(14);
    expect(range.ids).toEqual(["7–20"]);
    const total = json.issues.reduce((sum: number, issue: { count: number }) => sum + issue.count, 0);
    expect(total).toBe(json.issueCount);
    const counts = JSON.parse((await run(["counts", path, "--json"])).stdout).counts;
    expect(json.issueCount).toBe(counts.closed);
    const expanded = JSON.parse((await run(["list", path, "--closed", "--json", "--expand"])).stdout);
    expect(expanded.issues.length).toBe(counts.closed);
    expect(expanded.issues.filter((issue: { id: string }) => issue.id === "8").length).toBe(1);
    const textOut = (await run(["list", path, "--closed"])).stdout;
    expect(textOut).toMatch(/7–20.*14 ids/);
  });
});

describe("#11 list --closed text shows criteria", () => {
  test("the criteria column is printed", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：唯一判据\n");
    await run(["close", path, "1"]);
    expect((await run(["list", path, "--closed"])).stdout).toContain("唯一判据");
  });
});

describe("#32 show --json exposes labels and open criteria", () => {
  test("labels map and criteria with its source", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：\n\n- x\n- y\n");
    const view = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(view.labels["现象"]).toBe("a");
    expect(view.criteria).toBe("x；y");
    expect(view.criteriaSource).toBe("body");
    await run(["close", path, "1"]);
    const closed = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(closed.criteria).toBe("x；y");
    expect(closed.criteriaSource).toBe("table");
  });
});

describe("#15 sync --titles reports rows it cannot fix", () => {
  test("a drifted multi-id row is listed, not silently skipped", async () => {
    const path = await threeIssues();
    writeFileSync(path, text(path).replace("| 3 | 未决 | P2 | 题3 |", "| 3, 30 | 未决 | P2 | 题3（改过） |"));
    const result = await run(["sync", path, "--titles", "--dry-run"]);
    expect(result.stderr).toContain("3, 30");
    expect(result.stderr).toContain("split");
  });
});

describe("#40 one archive format, kept in step with rename", () => {
  test("rename updates the kept-body archive heading", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    await run(["close", path, "1", "--keep-body"]);
    expect((await run(["rename", path, "1", "新标题"])).code).toBe(0);
    expect(text(path)).toContain("### #1 新标题（已关闭，正文保留）");
    expect(text(path)).not.toContain("### #1 甲（");
  });

  test("check flags an archive heading whose summary drifted (W251)", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    await run(["close", path, "1", "--keep-body"]);
    writeFileSync(path, text(path).replace("### #1 甲（已关闭", "### #1 旧名（已关闭"));
    const report = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(report.warnings.map((w: { code: string }) => w.code)).toContain("W251");
  });

  test("adopt archives a closed body in the close --keep-body format, so reopen can restore it", async () => {
    const { path, out } = await adopted(`# 台账

## 待处理

| # | 状态 | P | 摘要 |
|---|---|---|---|
| 7 | 未决 | P1 | 还开着 |

## 已关闭

| # | 状态 | P | 摘要 | 判据 |
|---|---|---|---|---|
| 1 | 已修 | P2 | 甲 | 测试通过 |

## 正文

### Issue 1: 甲

**现象**：原来的现象

### Issue 7: 还开着

**验收判据**：y
`);
    expect(out).toContain("### #1 甲（已关闭，正文保留）");
    expect(out).toContain("<!-- issuemd:kept-body:end -->");
    const report = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(report.warnings.map((w: { code: string }) => w.code)).toContain("W250");
    expect((await run(["reopen", path, "1"])).code).toBe(0);
    expect((await run(["show", path, "1"])).stdout).toContain("**现象**：原来的现象");
  });
});

describe("#34 duplicate titles", () => {
  test("new refuses a title an open issue already has (normalised), naming it", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const before = text(path);
    for (const title of ["甲", " 甲 ", "甲\t"]) {
      for (const extra of [[], ["--dry-run"]]) {
        const again = await run(["new", path, "--title", title, ...extra]);
        expect(again.code).toBe(2);
        expect(again.stderr).toContain("#1");
        expect(again.stderr).toContain("--allow-duplicate-title");
      }
    }
    expect(text(path)).toBe(before);
  });

  test("full-width / case variants count as the same title", async () => {
    const path = file();
    expect((await run(["new", path, "--title", "Login Ａbc"])).code).toBe(0);
    expect((await run(["new", path, "--title", "login abc"])).code).toBe(2);
  });

  test("--allow-duplicate-title files it without W212; check still reports the pair", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const second = await run(["new", path, "--title", "甲", "--allow-duplicate-title"]);
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain("W212");
    const report = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(report.warnings.filter((w: { code: string }) => w.code === "W212").length).toBeGreaterThan(0);
  });

  test("rename refuses another open issue's summary unless --allow-duplicate-title", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    expect((await run(["new", path, "--title", "乙"])).code).toBe(0);
    const before = text(path);
    for (const extra of [[], ["--dry-run"]]) {
      const refused = await run(["rename", path, "2", " 甲 ", ...extra]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("#1");
      expect(refused.stderr).toContain("--allow-duplicate-title");
    }
    expect(text(path)).toBe(before);
    // Renaming an issue to (a re-spacing of) its own summary is not a duplicate.
    expect((await run(["rename", path, "1", "甲"])).code).toBe(0);
    const forced = await run(["rename", path, "2", "甲", "--allow-duplicate-title"]);
    expect(forced.code).toBe(0);
    expect(text(path)).toContain("| 2 | 未决 | P2 | 甲 |");
  });

  test("rename of a closed issue, or onto a closed summary, is not blocked", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    expect((await run(["close", path, "1"])).code).toBe(0);
    expect((await run(["new", path, "--title", "乙"])).code).toBe(0);
    expect((await run(["rename", path, "2", "甲"])).code).toBe(0);
    expect((await run(["rename", path, "1", "甲"])).code).toBe(0);
  });

  test("a closed issue with the same title does not block", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    expect((await run(["close", path, "1"])).code).toBe(0);
    expect((await run(["new", path, "--title", "甲"])).code).toBe(0);
  });
});

describe("#27 W202 only for hashes that would rot", () => {
  test("criteria-column commits and UUIDs are not W202; body hashes still are", async () => {
    const path = await withIssue("**现象**：thread 550e8400-e29b-41d4-a716-446655440000 和 deadbee\n\n**验收判据**：x\n");
    expect((await run(["new", path, "--title", "乙", "--body-file", body("**现象**：a\n\n**验收判据**：y\n")])).code).toBe(0);
    await run(["close", path, "2", "--criteria", "commit 1a131d6 修复"]);
    const report = JSON.parse((await run(["check", path, "--json"])).stdout);
    const flagged = report.warnings.filter((w: { code: string }) => w.code === "W202").map((w: { message: string }) => w.message);
    expect(flagged.some((m: string) => m.includes("deadbee"))).toBe(true);
    expect(flagged.some((m: string) => m.includes("1a131d6"))).toBe(false);
    expect(flagged.some((m: string) => /550e8400|e29b|446655440000/.test(m))).toBe(false);
  });
});

describe("#19 links", () => {
  test("a symlinked ledger is written through to its target; the link survives", async () => {
    const { symlinkSync, lstatSync } = await import("node:fs");
    const target = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const link = join(dir, `link-${counter++}.md`);
    symlinkSync(target, link);
    const result = await run(["new", link, "--title", "经由链接"]);
    expect(result.code).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(text(target)).toContain("经由链接");
  });

  test("a hard-linked ledger warns that other names keep the old content", async () => {
    const { linkSync } = await import("node:fs");
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    linkSync(path, join(dir, `hard-${counter++}.md`));
    const result = await run(["new", path, "--title", "硬链接"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("hard link");
  });
});

// ---- independent review of round six -------------------------------------

const ledgerSkeleton = (index: string, closed = "| # | 状态 | P | 摘要 | 判据 |\n|---|---|---|---|---|\n", body = "") =>
  `# 台账\n\n## 索引\n\n${index}\n## 已关闭\n\n${closed}\n## 正文\n\n${body}`;

describe("review: adopt keeps every cell and reads named columns", () => {
  test("a header without 摘要 still uses its named 状态 column", async () => {
    const { result, path } = await adopted(ledgerSkeleton("| # | 状态 | 说明 |\n|---|---|---|\n| 1 | 未决 | do the thing |\n| 2 | 已修 | done thing |\n"));
    expect(result.code).toBe(0);
    const open = JSON.parse((await run(["list", path, "--json"])).stdout).issues;
    expect(open.map((i: { id: string; summary: string }) => [i.id, i.summary])).toEqual([["1", "do the thing"]]);
    const closed = JSON.parse((await run(["list", path, "--closed", "--json"])).stdout).issues;
    expect(closed[0].id).toBe("2");
    expect(closed[0].status).toBe("已修");
  });

  test("an unknown wide header is kept verbatim, not read by position", async () => {
    const source = ledgerSkeleton("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 未决 | P1 | 已知 |\n\n### 杂表\n\n| # | 描述 | 负责人 | 日期 |\n|---|---|---|---|\n| 9 | 某事 | bob | 11-20 |\n", undefined, "### Issue 1: 已知\n\n**验收判据**：y\n");
    const { result, out } = await adopted(source);
    expect(result.code).toBe(0);
    expect(out).toContain("| 9 | 某事 | bob | 11-20 |");
  });

  test("cells beyond the header width are not dropped", async () => {
    const { result, out } = await adopted(ledgerSkeleton("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 已修 | P1 | foo | extra cell |\n"));
    expect(result.code).toBe(0);
    expect(out).toContain("extra cell");
  });

  test("merging duplicate rows keeps both criteria and reports differing priorities", async () => {
    const source = ledgerSkeleton(
      "| # | 状态 | P | 摘要 | 判据 |\n|---|---|---|---|---|\n| 1 | 已修 | P1 | foo | index criteria long text here |\n",
      "| # | 状态 | P | 摘要 | 判据 |\n|---|---|---|---|---|\n| 1 | 已修 | P0 | foo | closed crit |\n");
    const { result, out } = await adopted(source);
    expect(result.code).toBe(0);
    expect(out).toContain("index criteria long text here");
    expect(out).toContain("closed crit");
    expect(result.stdout).toMatch(/P1.*P0|P0.*P1/);
  });

  test("an H3 directly under the H1 is kept, not refused", async () => {
    const source = "# 台账\n\n### Background\n\n背景说明。\n\n" + ledgerSkeleton("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 已修 | P1 | foo |\n").replace("# 台账\n\n", "");
    const { result, out } = await adopted(source);
    expect(result.code).toBe(0);
    expect(out).toContain("背景说明。");
  });
});

describe("review: write verbs", () => {
  test("reopen of a kept body keeps the criteria the close recorded", async () => {
    const path = await withIssue("**现象**：a\n");
    await run(["close", path, "1", "--keep-body", "--criteria", "manual X"]);
    expect((await run(["reopen", path, "1"])).code).toBe(0);
    expect(text(path)).toContain("manual X");
  });

  test("close does not leave extra blank lines at EOF when 正文 is last", async () => {
    // The source ends with exactly one newline; no write may add blank lines at EOF.
    const path = file(TEMPLATE.replace(/\n## 附录[\s\S]*$/, "\n").replace(/\n+$/, "\n"));
    expect((await run(["new", path, "--title", "甲", "--body-file", body("**现象**：a\n\n**验收判据**：x\n")])).code).toBe(0);
    expect(text(path).endsWith("\n\n")).toBe(false);
    expect((await run(["close", path, "1"])).code).toBe(0);
    expect(text(path).endsWith("\n\n")).toBe(false);
  });

  test("reopen keeps 2 before 2a in the index", async () => {
    const path = file();
    for (const id of ["2", "2a"]) await run(["new", path, "--id", id, "--title", `t${id}`, "--body-file", body("**验收判据**：x\n")]);
    await run(["close", path, "2"]);
    await run(["reopen", path, "2"]);
    const ids = JSON.parse((await run(["list", path, "--json"])).stdout).issues.map((i: { id: string }) => i.id);
    expect(ids).toEqual(["2", "2a"]);
  });

  test("W212 ignores a duplicate that was already closed as 并入", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    await run(["new", path, "--title", "甲", "--allow-duplicate-title", "--body-file", body("**验收判据**：y\n")]);
    await run(["close", path, "2", "--status", "并入", "--criteria", "dup of #1"]);
    expect((await run(["check", path, "--strict"])).code).toBe(0);
  });
});

describe("review: dry-run diff stays bounded on huge rewrites", () => {
  test("10k fully changed lines diff quickly", async () => {
    const { unifiedDiff } = await import("./write.js");
    const old = Array.from({ length: 10000 }, (_, i) => `old ${i}`);
    const next = Array.from({ length: 10000 }, (_, i) => `new ${i}`);
    const started = performance.now();
    const diff = unifiedDiff(old, next, "f.md");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(diff.split("\n").filter((l) => l.startsWith("-old")).length).toBe(10000);
  });
});

describe("#50 adopt keeps a body found inside a table section exactly once", () => {
  const dup = (status: string) =>
    "# 台账\n\n## 待处理\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n" +
    `| 1 | ${status} | P2 | 甲 |\n\n### Issue 1: 甲\n\n**现象**：UNIQUE-50-TOKEN\n\n**验收判据**：x\n`;
  const count = (path: string) => text(path).split("UNIQUE-50-TOKEN").length - 1;

  for (const status of ["未决", "已修", "决定不改"]) {
    test(`status ${status}: one copy, no escaped heading`, async () => {
      const path = file(dup(status));
      expect((await run(["adopt", path])).code).toBe(0);
      expect(count(path)).toBe(1);
      expect(text(path)).not.toContain("\\### Issue 1:");
      const checked = await run(["check", path, "--json"]);
      expect(JSON.parse(checked.stdout).errors).toEqual([]);
    });
  }

  test("closed body inside a table section stays an archive reopen can restore", async () => {
    const path = file(dup("已修"));
    expect((await run(["adopt", path])).code).toBe(0);
    expect(text(path)).toContain("（已关闭，正文保留）");
    expect((await run(["reopen", path, "1"])).code).toBe(0);
    expect(count(path)).toBe(1);
    expect(text(path)).not.toContain("\\### Issue 1:");
  });

  test("control: a body under 正文 is archived once, as before", async () => {
    const path = file(
      "# 台账\n\n## 待处理\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 已修 | P2 | 甲 |\n\n" +
        "## 正文\n\n### Issue 1: 甲\n\n**现象**：UNIQUE-50-TOKEN\n",
    );
    expect((await run(["adopt", path])).code).toBe(0);
    expect(count(path)).toBe(1);
  });

  test("check reports an escaped body copy left in 附录 by an earlier adopt (W253)", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    writeFileSync(path, text(path).replace(/\n*$/, "") + "\n\n\\### Issue 1: 甲\n\n**现象**：a\n");
    const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(checked.warnings.map((w: { code: string }) => w.code)).toContain("W253");
  });
});

describe("#41 a prose-only file is refused with an accurate message", () => {
  test("narrative H3s without rows: exit 3, unchanged, says no rows rather than 'not a ledger'", async () => {
    const source = "# 台账\n\n## 待处理\n\n### 已在代码与现场同时验证\n\n一些叙述。\n\n### 决定不改\n\n更多叙述。\n";
    const path = file(source);
    const result = await run(["adopt", path]);
    expect(result.code).toBe(3);
    expect(text(path)).toBe(source);
    expect(result.stderr).toContain("file left unchanged");
    expect(result.stderr).not.toContain("does not look like a ledger");
  });
});

describe("#46 adopt reports its conservation check", () => {
  test("the report states issue counts before and after and the kept prose lines", async () => {
    const path = file(
      "# 台账\n\n## 待处理\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 未决 | P2 | 甲 |\n| 2–4 | 已修 | P2 | 乙 |\n\n" +
        "> 组说明\n\n## 正文\n\n### Issue 1: 甲\n\n**现象**：a\n",
    );
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/守恒自检：issue 4 → 4/);
  });
});

describe("#54 issue-shaped tables under a non-ledger heading are text, said once", () => {
  const SHAPES = {
    narrow: "| # | 摘要 |\n|---|---|\n| 90 | 第一轮复核 |\n",
    closed: "| # | 状态 | P | 摘要 | 判据 |\n|---|---|---|---|---|\n| 90 | 已修 | P2 | 某事 | abc |\n",
    open: "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 90 | 未决 | P2 | 某事 |\n",
  };
  const withSection = (title: string, table: string) =>
    file(TEMPLATE.replace("## 索引", `## ${title}\n\n${table}\n## 索引`));
  type Diag = { code: string; line: number; message: string };

  for (const title of ["变更记录", "复核记录"]) {
    for (const [shape, table] of Object.entries(SHAPES)) {
      test(`${title} / ${shape}: W225 instead of E124, and adopt leaves a clean ledger`, async () => {
        const path = withSection(title, table);
        const checked = JSON.parse((await run(["check", path, "--json"])).stdout) as { errors: Diag[]; warnings: Diag[] };
        expect(checked.errors.map((e) => e.code)).not.toContain("E124");
        const w225 = checked.warnings.filter((w) => w.code === "W225");
        expect(w225.length).toBe(1);
        expect(text(path).split("\n")[w225[0].line - 1]).toStartWith("| 90 |");
        expect(w225[0].message).toContain(title);
        expect(w225[0].message).not.toContain("run 'issuemd adopt");
        expect((await run(["check", path])).code).toBe(0);
        expect((await run(["check", path, "--strict"])).code).toBe(3);

        const adopted = await run(["adopt", path]);
        expect(adopted.code).toBe(0);
        expect((await run(["check", path])).code).toBe(0);
        expect(text(path)).toContain("| 90 |");
      });
    }
  }

  test("the id is not tracked but reserved: show says no such issue, new skips it", async () => {
    const path = withSection("变更记录", SHAPES.narrow);
    expect((await run(["show", path, "90"])).code).toBe(1);
    expect((await run(["new", path, "--title", "新"])).stdout.trim()).toBe("1");
    expect((await run(["new", path, "--title", "八九", "--id", "89"])).code).toBe(0);
    expect((await run(["new", path, "--title", "下一个"])).stdout.trim()).toBe("91");
  });
});

describe("#52 issue tables outside 索引/已关闭 are not invisible", () => {
  const LEGACY = "## 待处理\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 7 | 未决 | P2 | 遗留表里的一条 |\n\n";
  const mixed = () => file(TEMPLATE.replace("## 索引", `${LEGACY}## 索引`));
  const HEADERLESS = "## 待处理\n\n| 7 | 遗留 |\n| 8 | 另一条 |\n\n";

  test("check reports E124 at the stray row and fails (also --strict)", async () => {
    const path = mixed();
    const result = await run(["check", path, "--json"]);
    expect(result.code).toBe(3);
    const errors = JSON.parse(result.stdout).errors as { code: string; line: number; message: string }[];
    const e124 = errors.filter((e) => e.code === "E124");
    expect(e124.length).toBe(1);
    expect(text(path).split("\n")[e124[0].line - 1]).toStartWith("| 7 |");
    expect(e124[0].message).toContain("待处理");
    expect((await run(["check", path, "--strict"])).code).toBe(3);
  });

  test("a header-less id table under a ledger-table heading counts too", async () => {
    const path = file(TEMPLATE.replace("## 索引", `${HEADERLESS}## 索引`));
    const errors = JSON.parse((await run(["check", path, "--json"])).stdout).errors as { code: string }[];
    expect(errors.filter((e) => e.code === "E124").length).toBe(2);
  });

  test("tables in 正文/附录 and non-issue tables elsewhere stay quiet", async () => {
    const notes = "## 复核记录\n\n| 日期 | 结论 |\n|---|---|\n| 2026-11-24 | 通过 |\n\n";
    const path = file(TEMPLATE.replace("## 索引", `${notes}## 索引`));
    expect((await run(["new", path, "--title", "甲", "--body-file",
      body("**现象**：见表\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 3 | 未决 | 引用 |\n")])).code).toBe(0);
    const errors = JSON.parse((await run(["check", path, "--json"])).stdout).errors as { code: string }[];
    expect(errors.map((e) => e.code)).not.toContain("E124");
  });

  test("review: a foreign table with an ID and 状态 but no 摘要 is not an issue table", async () => {
    const plan = "## 版本计划\n\n| ID | 状态 | 说明 |\n|---|---|---|\n| 1 | 进行中 | plan |\n\n";
    const path = file(TEMPLATE.replace("## 索引", `${plan}## 索引`));
    const errors = JSON.parse((await run(["check", path, "--json"])).stdout).errors as { code: string }[];
    expect(errors.map((e) => e.code)).not.toContain("E124");
    expect((await run(["new", path, "--title", "甲", "--id", "1"])).code).toBe(0);
  });

  test("review: a legacy file with such a foreign table can still be adopted", async () => {
    const legacy = "# Proj\n## 待处理\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 未决 | P1 | first |\n" +
      "## 路线图\n| ID | 状态 | 说明 |\n|---|---|---|\n| 7 | 进行中 | plan |\n" +
      "## 已关闭\n| # | 状态 | P | 摘要 | 判据 |\n|---|---|---|---|---|\n| 2 | 已修 | P2 | old | ok |\n";
    const path = file(legacy);
    const result = await run(["adopt", path]);
    expect(result.stderr).not.toContain("E124");
    expect(result.code).toBe(0);
    expect(text(path)).toContain("| 7 | 进行中 | plan |");
  });

  test("default numbering skips stray ids", async () => {
    const path = mixed();
    expect((await run(["new", path, "--title", "新"])).code).toBe(0);
    expect(text(path)).toContain("| 8 | 未决 | P2 | 新 |");
  });

  test("new --id with a stray id is refused, bytes unchanged", async () => {
    const path = mixed();
    const before = text(path);
    const result = await run(["new", path, "--title", "撞号", "--id", "7"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("待处理");
    expect(text(path)).toBe(before);
  });

  test("read commands say the result is incomplete; show points at the row", async () => {
    const path = mixed();
    const listed = await run(["list", path]);
    expect(listed.stderr).toContain("待处理");
    const counts = await run(["counts", path]);
    expect(counts.stderr).toContain("待处理");
    const shown = await run(["show", path, "7"]);
    expect(shown.code).toBe(3);
    expect(shown.stderr).toContain("adopt");
  });

  test("adopt migrates the stray row instead of calling the file canonical", async () => {
    const path = mixed();
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    const shown = await run(["show", path, "7", "--json"]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout).status).toBe("未决");
    expect((await run(["check", path])).code).toBe(0);
  });

  test("adopt does not copy the empty canonical table headers into 附录", async () => {
    const path = mixed();
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("section-prose");
    const appendix = text(path).split("## 附录")[1]!;
    expect(appendix).not.toContain("| # |");
  });
});

describe("#18 --if-unchanged applies exactly what was reviewed", () => {
  const snapshotOf = (stderr: string) => /snapshot: ([0-9a-f]{16})/.exec(stderr)?.[1];

  test("dry-run prints a snapshot; the real run with it succeeds", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const preview = await run(["status", path, "1", "观察", "--dry-run"]);
    expect(preview.code).toBe(0);
    const token = snapshotOf(preview.stderr);
    expect(token).toBeDefined();
    expect((await run(["status", path, "1", "观察", "--if-unchanged", token!])).code).toBe(0);
    expect(text(path)).toContain("| 1 | 观察 |");
  });

  test("a write in between makes the reviewed run exit 4, bytes untouched", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const token = snapshotOf((await run(["close", path, "1", "--dry-run"])).stderr)!;
    expect((await run(["status", path, "1", "部分解决"])).code).toBe(0);
    const before = text(path);
    for (const args of [["close", path, "1"], ["close", path, "1", "--dry-run"]]) {
      const result = await run([...args, "--if-unchanged", token]);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain("changed since");
    }
    expect(text(path)).toBe(before);
  });

  test("read --json views carry the same snapshot", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const token = snapshotOf((await run(["rename", path, "1", "乙", "--dry-run"])).stderr);
    expect(token).toMatch(/^[0-9a-f]{16}$/);
    for (const args of [["show", path, "1"], ["list", path], ["counts", path], ["check", path]]) {
      expect(JSON.parse((await run([...args, "--json"])).stdout).snapshot).toBe(token);
    }
  });

  test("adopt honours it too", async () => {
    const path = file(TEMPLATE.replace("## 索引", "## 待处理\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 7 | 未决 | P2 | 旧 |\n\n## 索引"));
    const before = text(path);
    expect((await run(["adopt", path, "--if-unchanged", "0000000000000000"])).code).toBe(4);
    expect(text(path)).toBe(before);
  });

  test("a malformed token is a usage error; read commands reject the flag", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    expect((await run(["status", path, "1", "观察", "--if-unchanged", "abc"])).code).toBe(2);
    expect((await run(["list", path, "--if-unchanged", "0000000000000000"])).code).toBe(2);
  });
});

/** Round nine: findings from an internal black-box probe (no dogfood number). */
describe("probe: adopt keeps every row's summary visible", () => {
  const legacy = (rows: string, closed = "") =>
    `# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n${rows}\n## 已关闭\n\n| # | 状态 | 摘要 | 判据 |\n|---|---|---|---|\n${closed}`;

  test("an issue that stays open keeps the index summary; the closed copy's is reported", async () => {
    const path = file(legacy("| 11 | 未决 | 开放表的摘要 |\n", "| 11 | 已修 | 关闭表的摘要 | 已在 v2 修复 |\n"));
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(text(path)).toContain("| 11 | 未决 |  | 开放表的摘要 |");
    expect(text(path)).toContain("### Issue 11: 开放表的摘要");
    expect(result.stdout).toContain("关闭表的摘要");
  });

  test("two rows in one table: the dropped summary is named, not called 多张表", async () => {
    const path = file(legacy("| 12 | 未决 | 甲 |\n| 12 | 未决 | 乙 |\n"));
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(text(path)).toContain("| 12 | 未决 |  | 甲 |");
    const line = result.stdout.split("\n").find((l) => l.includes("#12") && l.includes("合并"));
    expect(line).toBeDefined();
    expect(line).not.toContain("多张表");
    expect(result.stdout).toContain("乙");
  });
});

describe("probe: adopt never turns extra columns into criteria", () => {
  test("an open row without a body: extras go to 原表格判据 with a decision, not 验收判据", async () => {
    const path = file("# T\n\n## 待处理\n\n| # | 状态 | 优先级 | 摘要 | 负责人 |\n|---|---|---|---|---|\n| 1 | 未决 | P1 | 一 | alice |\n");
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(text(path)).not.toMatch(/\*\*验收判据\*\*：负责人/);
    expect(text(path)).toContain("**原表格判据**：负责人：alice");
    expect(result.stdout).toContain("extra-columns");
    // A plain close must not promote the owner column as criteria.
    expect((await run(["close", path, "1"])).code).toBe(2);
  });

  test("a real criteria column still fills the skeleton's 验收判据", async () => {
    const path = file("# T\n\n## 待处理\n\n| # | 状态 | 摘要 | 判据 | 负责人 |\n|---|---|---|---|---|\n| 1 | 未决 | 一 | 能登录 | bob |\n");
    expect((await run(["adopt", path])).code).toBe(0);
    expect(text(path)).toContain("**验收判据**：能登录");
    expect(text(path)).toContain("**原表格判据**：负责人：bob");
  });

  test("closed rows keep criteria then extras in the 判据 cell", async () => {
    const path = file("# T\n\n## 已关闭\n\n| # | 状态 | 摘要 | 判据 | 负责人 |\n|---|---|---|---|---|\n| 1 | 已修 | 一 | 修好了 | bob |\n");
    expect((await run(["adopt", path])).code).toBe(0);
    expect(text(path)).toContain("| 1 | 已修 |  | 一 | 修好了；负责人：bob |");
  });
});

describe("probe: adopt gives each id of an open multi-id row its body", () => {
  test("existing bodies attach to the row; check passes; split works afterwards", async () => {
    const path = file("# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 2, 30 | 未决 | 合并两条 |\n| 10 | 未决 | 十 |\n\n## 正文\n\n### Issue 2: 合并两条\n\na\n\n### Issue 30: 合并两条\n\nb\n");
    const result = await run(["adopt", path]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const out = text(path);
    expect(out).toContain("| 2, 30 | 未决 |  | 合并两条 |");
    expect(out).not.toContain("orphan-body");
    const order = [...out.matchAll(/^### Issue (\d+):/gm)].map((m) => m[1]);
    expect(order).toEqual(["2", "10", "30"]);
    expect(out).toMatch(/### Issue 2: 合并两条\n\na\n/);
    expect(out).toMatch(/### Issue 30: 合并两条\n\nb\n/);
    expect((await run(["check", path])).code).toBe(0);
    expect((await run(["split", path, "2"])).code).toBe(0);
  });

  test("ids without a body get skeletons, and the decision says which", async () => {
    const path = file("# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 2, 3 | 未决 | 合并两条 |\n");
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(text(path)).toContain("### Issue 2: 合并两条");
    expect(text(path)).toContain("### Issue 3: 合并两条");
    expect(result.stdout).not.toContain("无法生成正文标题");
    expect((await run(["check", path])).code).toBe(0);
  });
});

test("probe: a multi-id body with its own title keeps that title as text", async () => {
  const path = file("# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 2, 3 | 未决 | 合并 |\n\n## 正文\n\n### Issue 3: 另一个标题\n\nb\n");
  const result = await run(["adopt", path]);
  expect(result.code).toBe(0);
  expect(text(path)).toMatch(/### Issue 3: 合并\n\n\*\*原正文标题\*\*：另一个标题\n\nb\n/);
  expect((await run(["check", path])).code).toBe(0);
});

describe("probe: adopt status words", () => {
  const legacy = "# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 进行中 | 一 |\n| 2 | ✅ 已修 | 二 |\n| 3 | **未决** | 三 |\n| 4 | 已修（v2） | 四 |\n\n## 已关闭\n\n| # | 状态 | 摘要 | 判据 |\n|---|---|---|---|\n| 5 | done | 五 | ok |\n";

  test("decorated vocabulary words are recognised, with the decoration reported", async () => {
    const path = file(legacy);
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    const out = text(path);
    expect(out).toContain("| 2 | 已修 |  | 二 |");
    expect(out).toContain("| 3 | 未决 |  | 三 |");
    expect(out).toMatch(/\| 4 \| 已修 \| {2}\| 四 \| 原状态：已修（v2） \|/);
    expect(result.stdout).toContain("✅ 已修");
    expect((await run(["check", path])).code).toBe(0);
  });

  test("unknown words survive in the file, not only in the report", async () => {
    const path = file(legacy);
    expect((await run(["adopt", path])).code).toBe(0);
    const out = text(path);
    expect(out).toContain("**原表格判据**：原状态：进行中");
    expect(out).toMatch(/\| 5 \| 未分类 \| {2}\| 五 \| ok；原状态：done \|/);
  });
});

describe("probe: adopt names rows it cannot read as issues", () => {
  const legacy = "# T\n\n## 已关闭\n\n### 已修\n\n| 9–7 | 反向区间 | x |\n| 1–9007199254740993 | 巨大 | big |\n| 20 | a | b | c | d | e |\n\n## 待处理\n\n| 30 | 开放 |\n";

  test("an id cell that does not parse gets its own decision with the cell text", async () => {
    const result = await run(["adopt", file(legacy)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("9–7");
    expect(result.stdout).toContain("1–9007199254740993");
    expect(result.stdout).toMatch(/不是合法的编号/);
  });

  test("cells beyond the header are reported, not silently joined into 判据", async () => {
    const result = await run(["adopt", file(legacy)]);
    expect(result.stdout).toMatch(/#20 .*多 \d 格/);
  });
});

test("probe: adopt moves a body found under the H1 or in a foreign section, it does not copy it", async () => {
  const path = file("# T\n\n### Issue 50: 五十\n\nstray\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 50 | 未决 | 五十 |\n| 51 | 未决 | 五十一 |\n\n## 笔记\n\n别的笔记\n\n### Issue 51: 五十一\n\nnotes body\n\n## 正文\n");
  expect((await run(["adopt", path])).code).toBe(0);
  const out = text(path);
  expect(out.match(/stray/g)?.length).toBe(1);
  expect(out.match(/notes body/g)?.length).toBe(1);
  expect(out).not.toContain("\\### Issue");
  expect(out).toContain("别的笔记");
  expect((await run(["check", path, "--strict"])).code).toBe(0);
});

test("probe: show warns when the id also sits in an unreadable (E124) row", async () => {
  const base = file();
  expect((await run(["new", base, "--title", "第一条"])).code).toBe(0);
  const path = file(text(base).replace("## 索引", "## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 部分解决 | 第一条（旧） |\n\n## 索引"));
  for (const extra of [[], ["--json"]]) {
    const shown = await run(["show", path, "1", ...extra]);
    expect(shown.code).toBe(0);
    expect(shown.stderr).toContain("unreadable");
    expect(shown.stderr).toMatch(/L\d+/);
  }
});

describe("probe: write verbs (round nine)", () => {
  test("reopen keeps an empty priority empty; keep-body round trip stays byte-exact", async () => {
    const path = file();
    expect((await run(["new", path, "--title", "no prio", "--priority", ""])).code).toBe(0);
    const before = text(path);
    expect((await run(["close", path, "1", "--keep-body"])).code).toBe(0);
    expect((await run(["reopen", path, "1"])).code).toBe(0);
    expect(text(path)).toBe(before);
  });

  test("close --criteria with an empty or blank value is refused, not a silent --no-criteria", async () => {
    const path = await withIssue("**验收判据**：重启后保持宽度\n");
    const before = text(path);
    for (const value of ["", "   "]) {
      const result = await run(["close", path, "1", "--criteria", value]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--no-criteria");
    }
    expect(text(path)).toBe(before);
  });

  test("every non-empty 验收判据 block is promoted, not only the first", async () => {
    const path = await withIssue("**验收判据**：A\n\n**验收判据**：B\n");
    expect((await run(["close", path, "1"])).code).toBe(0);
    expect(await closedCriteria(path)).toBe("A；B");
  });

  test("close --keep-body without a body names the real problem", async () => {
    const path = file(TEMPLATE.replace("|---|---|---|---|\n", "|---|---|---|---|\n| 1 | 未决 | P2 | 无正文 |\n"));
    const result = await run(["close", path, "1", "--keep-body"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no body");
  });

  test("close --keep-body refuses when 附录 ends inside an unclosed fence", async () => {
    const base = await withIssue("**现象**：keep me\n\n**验收判据**：x\n");
    const path = file(text(base) + "\n```\nlog\n");
    const before = text(path);
    const result = await run(["close", path, "1", "--keep-body"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("fence");
    expect(text(path)).toBe(before);
  });

  test("close --keep-body refuses when 附录 already holds an archive for that id", async () => {
    const base = await withIssue("**现象**：fresh\n\n**验收判据**：x\n");
    const path = file(text(base) + "\n### #1 甲（已关闭，正文保留）\n\nhand-written note\n");
    const before = text(path);
    const result = await run(["close", path, "1", "--keep-body"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("archive");
    expect(text(path)).toBe(before);
  });
});

describe("probe: kept-body marker and body round trips", () => {
  test("a marker line inside a fenced example survives close --keep-body + reopen", async () => {
    const path = await withIssue("**现象**：\n\n```md\n<!-- issuemd:kept-body:end -->\n> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。\n```\n\n**验收判据**：z\n");
    const before = text(path);
    expect((await run(["close", path, "1", "--keep-body"])).code).toBe(0);
    expect((await run(["reopen", path, "1"])).code).toBe(0);
    expect(text(path)).toBe(before);
  });

  test("new/body refuse an unfenced end marker in the body text", async () => {
    const path = file();
    const result = await run(["new", path, "--title", "t", "--body-file", body("a\n<!-- issuemd:kept-body:end -->\nb\n")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("kept-body:end");
  });

  test("the documented body edit recipe (show --json body.text minus heading) is a no-op", async () => {
    const path = await withIssue("**x**：y\n");
    const before = text(path);
    const view = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    const recipe = view.body.text.split("\n").slice(1).join("\n") + "\n";
    expect((await run(["body", path, "1", "--body-file", body(recipe)])).code).toBe(0);
    expect(text(path)).toBe(before);
  });
});

test("probe: close --keep-body refuses a hand-written unfenced marker in the body", async () => {
  const base = await withIssue("a\n\n**验收判据**：x\n");
  const path = file(text(base).replace("\na\n", "\na\n<!-- issuemd:kept-body:end -->\n"));
  const before = text(path);
  expect((await run(["close", path, "1", "--keep-body"])).code).toBe(3);
  expect(text(path)).toBe(before);
});

test("probe: writes refuse a read-only ledger; dry-run still previews", async () => {
  const { chmodSync } = await import("node:fs");
  const path = file();
  chmodSync(path, 0o444);
  const before = text(path);
  const dry = await run(["new", path, "--title", "t", "--dry-run"]);
  expect(dry.code).toBe(0);
  const real = await run(["new", path, "--title", "t"]);
  expect(real.code).toBe(2);
  expect(real.stderr).toContain("read-only");
  expect(text(path)).toBe(before);
  chmodSync(path, 0o644);
});

describe("probe: CLI surface (round nine)", () => {
  test("a write verb's 'no such issue' goes to stderr, even under --dry-run", async () => {
    const path = file();
    for (const args of [["close", path, "9", "--no-criteria"], ["rename", path, "9", "x", "--dry-run"], ["status", path, "9", "观察"]]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("no such issue: 9");
    }
  });

  test("usage lines come from the command table (close lists --no-criteria)", async () => {
    const result = await run(["close", file()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--no-criteria");
  });

  test("sync: --prefer only with --titles; progress flags only with --prefer body", async () => {
    const path = file();
    expect((await run(["sync", path, "--guide", "--prefer", "table"])).code).toBe(2);
    expect((await run(["sync", path, "--titles", "--prefer", "table", "--move-progress"])).code).toBe(2);
  });

  test("sync --titles --prefer table refuses to copy progress text into body titles", async () => {
    const path = await withIssue("**验收判据**：x\n");
    const drifted = file(text(path).replace("| 1 | 未决 | P2 | 甲 |", "| 1 | 未决 | P2 | 甲 已落地一半 |"));
    const before = text(drifted);
    const result = await run(["sync", drifted, "--titles", "--prefer", "table"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("--move-progress");
    expect(text(drifted)).toBe(before);
  });

  test("sync --titles --dry-run with nothing to do says so and gives the snapshot", async () => {
    const path = await withIssue("**验收判据**：x\n");
    const result = await run(["sync", path, "--titles", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("(no changes)\n");
    expect(result.stderr).toContain("snapshot: ");
  });
});

test("probe: a pipe after an escaped backslash is still escaped in cells", async () => {
  const path = await withIssue("**验收判据**：x\\\\|y\n");
  expect((await run(["rename", path, "1", "a \\\\| b"])).code).toBe(0);
  expect((await run(["check", path])).code).toBe(0);
  expect((await run(["close", path, "1"])).code).toBe(0);
  expect((await run(["check", path])).code).toBe(0);
});

test("probe: reopen of a closed summary that cannot be a heading says to rename first", async () => {
  const base = await withIssue("**验收判据**：x\n");
  expect((await run(["close", base, "1"])).code).toBe(0);
  for (const summary of ["甲（2）", "甲 #"]) {
    const path = file(text(base).replace("| 1 | 已修 | P2 | 甲 |", `| 1 | 已修 | P2 | ${summary} |`));
    const result = await run(["reopen", path, "1"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("issuemd rename");
  }
  expect((await run(["new", file(), "--title", "缓存（3）"])).code).toBe(2);
});

test("probe: a malformed id is a usage error (2), an absent one is 1", async () => {
  const path = await withIssue("**验收判据**：x\n");
  expect((await run(["show", path, "4-x"])).code).toBe(2);
  expect((await run(["show", path, "9"])).code).toBe(1);
  expect((await run(["close", path, "abc", "--no-criteria"])).code).toBe(2);
  expect((await run(["close", path, "9", "--no-criteria"])).code).toBe(1);
});

test("review: negated or doubtful status cells are not read as closed", async () => {
  const path = file("# T\n\n## 索引\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | ❌ 已修 | P2 | reverted fix |\n| 3 | 已修？ | P2 | unsure |\n| 4 | ~~已修~~ | P2 | struck |\n| 5 | ✅ 已修 | P2 | done |\n\n## 正文\n\n### Issue 1: reverted fix\n\n**现象**：x\n\n### Issue 3: unsure\n\nz\n\n### Issue 4: struck\n\nq\n");
  expect((await run(["adopt", path])).code).toBe(0);
  const out = text(path);
  for (const [id, raw] of [["1", "❌ 已修"], ["3", "已修？"], ["4", "~~已修~~"]] as const) {
    expect(out).toContain(`| ${id} | 未决 | P2 |`);
    expect(out).toContain(`原状态：${raw}`);
  }
  expect(out).toMatch(/\| 5 \| 已修 \| P2 \| done \| 原状态：✅ 已修 \|/);
});

describe("review9: adopt gaps that made it refuse its own output", () => {
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  const adoptClean = async (path: string) => {
    const result = await run(["adopt", path]);
    expect(result.stderr).not.toContain("nothing written");
    expect(result.code).toBe(0);
    const checked = await run(["check", path]);
    expect(checked.stdout).toContain("0 errors");
    return text(path);
  };

  test("a body before the first H2 with no H1 moves into 正文, once", async () => {
    const path = file("### Issue 1: 甲\n\n正文一\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n");
    const out = await adoptClean(path);
    expect(out).toMatch(/## 正文\n\n### Issue 1: 甲\n\n正文一\n/);
    expect(count(out, "正文一")).toBe(1);
  });

  test("an orphan body before the first H2 is kept once in 附录", async () => {
    const path = file("### Issue 9: 孤\n\n孤儿正文\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n");
    const out = await adoptClean(path);
    expect(count(out, "孤儿正文")).toBe(1);
    expect(out.slice(out.indexOf("## 附录"))).toContain("孤儿正文");
  });

  test("an `### Issue N:` already in 附录 is kept there, not re-parsed as a body", async () => {
    const path = file("# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n\n## 附录\n\n### Issue 1: 甲\n\n旧正文\n");
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(0);
    const out = await adoptClean(path);
    expect(count(out, "旧正文")).toBe(1);
    expect(out.slice(out.indexOf("## 附录"))).toContain("旧正文");
    // 正文 gets a skeleton; the old text is pointed at, not silently promoted.
    expect(out).toMatch(/## 正文\n\n### Issue 1: 甲\n\n\*\*现象\*\*/);
    expect(result.stdout + result.stderr).toContain("#1");
  });

  test("a 正文 body wins over a same-id copy in 附录", async () => {
    const path = file("# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n\n## 正文\n\n### Issue 1: 甲\n\n新正文\n\n## 附录\n\n### Issue 1: 甲\n\n旧正文\n");
    const out = await adoptClean(path);
    expect(out).toMatch(/### Issue 1: 甲\n\n新正文\n/);
    expect(count(out, "旧正文")).toBe(1);
  });

  test("a range body heading `### Issue 3–5:` is kept in 附录 instead of refusing", async () => {
    const path = file("# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 3–5 | 未决 | 甲组 |\n\n## 正文\n\n### Issue 3–5: 甲组\n\n区间正文\n");
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.stderr).not.toContain("would not survive");
    const out = await adoptClean(path);
    expect(count(out, "区间正文")).toBe(1);
    expect(out.slice(out.indexOf("## 附录"))).toContain("区间正文");
  });

  test("a closed multi-id row's body under the H1 is kept once (附录), not also in the header", async () => {
    const path = file("# T\n\n### Issue 3: 乙\n\n乙的正文\n\n## 已关闭\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 3, 4 | 已修 | 乙 |\n");
    const out = await adoptClean(path);
    expect(count(out, "乙的正文")).toBe(1);
    expect(out.slice(out.indexOf("## 附录"))).toContain("乙的正文");
  });
});

test("reopen refuses a summary another open issue already has, like new/rename", async () => {
  const path = file();
  expect((await run(["new", path, "--title", "缓存失效", "--body-file", body("**验收判据**：x\n")])).code).toBe(0);
  expect((await run(["close", path, "1", "--status", "并入", "--no-criteria"])).code).toBe(0);
  expect((await run(["new", path, "--title", "缓存失效"])).code).toBe(0);
  const before = text(path);
  const refused = await run(["reopen", path, "1"]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("#2");
  expect(refused.stderr).toContain("--allow-duplicate-title");
  expect(text(path)).toBe(before);
  expect((await run(["reopen", path, "1", "--allow-duplicate-title"])).code).toBe(0);
  expect(JSON.parse((await run(["check", path, "--json"])).stdout).warnings.map((w: { code: string }) => w.code)).toContain("W212");
});

describe("review10: E124/W225 and adopt agree; top bodies that cannot move stay as text", () => {
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  const adoptClean = async (path: string) => {
    const result = await run(["adopt", path]);
    expect(result.stderr).not.toContain("nothing written");
    expect(result.stderr).not.toContain("refusing");
    expect(result.code).toBe(0);
    expect((await run(["check", path])).stdout).toContain("0 errors");
    return text(path);
  };

  test("a converting adopt does not migrate rows of a W225 table", async () => {
    const path = file("# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n\n## 复核记录\n\n| # | 摘要 |\n|---|---|\n| 1 | 复核甲 |\n| 90 | 别的 |\n");
    const out = await adoptClean(path);
    expect(out).toContain("| 1 | 未决 |  | 甲 |");
    expect(out).not.toContain("| 90 | 未决");
    expect(out).not.toContain("### Issue 90");
    expect(out).toContain("| 90 | 别的 |");
    expect(out).toContain("| 1 | 复核甲 |");
  });

  test("a table adopt migrates under a ledger heading is E124 even without 状态/摘要 columns", async () => {
    const path = file(TEMPLATE.replace("## 索引", "## 待处理\n\n| # | P | 说明 |\n|---|---|---|\n| 90 | P1 | x |\n\n## 索引"));
    const errors = JSON.parse((await run(["check", path, "--json"])).stdout).errors as { code: string }[];
    expect(errors.map((e) => e.code)).toContain("E124");
    const out = await adoptClean(path);
    expect(out).toMatch(/\| 90 \| 未决 \| P1 \| x \|/);
  });

  test("a top body that loses to a 正文 body of the same id stays as text, once", async () => {
    const path = file("# T\n\n说明一句\n\n### Issue 1: 甲\n\n顶部正文\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n\n## 正文\n\n### Issue 1: 甲\n\n正文里的\n");
    const out = await adoptClean(path);
    expect(count(out, "顶部正文")).toBe(1);
    expect(out).toMatch(/### Issue 1: 甲\n\n正文里的/);
  });

  test("two top bodies of one id with no H1: one moves, the other stays as text", async () => {
    const path = file("### Issue 1: 甲\n\n顶部正文\n\n### Issue 1: 甲\n\n第二份\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n");
    const out = await adoptClean(path);
    expect(count(out, "顶部正文")).toBe(1);
    expect(count(out, "第二份")).toBe(1);
  });

  test("range headings above the first H2 are escaped text", async () => {
    for (const source of [
      "### Issue 3–5: 组\n\n顶部区间\n\n# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 3–5 | 未决 | 组 |\n\n## 正文\n\n### Issue 3–5: 组\n\n区间正文\n",
      "### Issue 2: 乙\n\n乙正文\n\n### Issue 3–5: 组\n\n顶部区间\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n",
    ]) {
      const out = await adoptClean(file(source));
      expect(count(out, "顶部区间")).toBe(1);
    }
  });
});

describe("probe10: sync --titles never drops table-summary text silently", () => {
  const drifted = async (suffix: string) => {
    const path = file();
    expect((await run(["new", path, "--title", "标题甲", "--body-file", body("**验收判据**：x\n")])).code).toBe(0);
    return file(text(path).replace("| 1 | 未决 | P2 | 标题甲 |", `| 1 | 未决 | P2 | 标题甲${suffix} |`));
  };

  for (const suffix of ["（进展：已修一半）", " [WIP]", " → 修复中"]) {
    test(`'${suffix}' is refused without --move/--drop-progress`, async () => {
      const path = await drifted(suffix);
      const before = text(path);
      const result = await run(["sync", path, "--titles"]);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("--move-progress");
      expect(text(path)).toBe(before);
    });
  }

  test("--move-progress keeps the text in the body; --drop-progress discards it", async () => {
    const moved = await drifted("（进展：已修一半）");
    expect((await run(["sync", moved, "--titles", "--move-progress"])).code).toBe(0);
    expect(text(moved)).toContain("已修一半");
    expect(text(moved)).toContain("| 1 | 未决 | P2 | 标题甲 |");
    const dropped = await drifted("（进展：已修一半）");
    expect((await run(["sync", dropped, "--titles", "--drop-progress"])).code).toBe(0);
    expect(text(dropped)).not.toContain("已修一半");
  });

  test("a plain rename drift still syncs without extra flags", async () => {
    const path = file();
    expect((await run(["new", path, "--title", "标题甲", "--body-file", body("**验收判据**：x\n")])).code).toBe(0);
    const renamed = file(text(path).replace("| 1 | 未决 | P2 | 标题甲 |", "| 1 | 未决 | P2 | 完全不同的说法 |"));
    expect((await run(["sync", renamed, "--titles"])).code).toBe(0);
    expect(text(renamed)).toContain("| 1 | 未决 | P2 | 标题甲 |");
  });
});

test("probe10: list items ending in ；/; are joined without a doubled separator", async () => {
  const path = file();
  expect((await run(["new", path, "--title", "乙", "--body-file", body("**验收判据**：\n\n- 不再白屏；\n- 日志无报错;\n- 第三条\n")])).code).toBe(0);
  const shown = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
  expect(shown.criteria).toBe("不再白屏；日志无报错;第三条");
  expect((await run(["close", path, "1"])).code).toBe(0);
  expect(text(path)).toContain("| 不再白屏；日志无报错;第三条 |");
});

test("probe10: a colon inside the bold label (**验收判据：**) is the same label", async () => {
  for (const form of ["**验收判据：** 甲", "**验收判据:** 甲"]) {
    const path = file();
    expect((await run(["new", path, "--title", "乙", "--body-file", body(`**现象**：x\n\n${form}\n`)])).code).toBe(0);
    const shown = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(shown.criteria).toBe("甲");
    expect(Object.keys(shown.labels)).toEqual(["现象", "验收判据"]);
    expect((await run(["close", path, "1"])).code).toBe(0);
    expect(text(path)).toContain("| 乙 | 甲 |");
  }
});

test("probe10: a body file that starts with its issue heading says to drop that line", async () => {
  const path = file();
  expect((await run(["new", path, "--title", "甲", "--body-file", body("**验收判据**：x\n")])).code).toBe(0);
  const before = text(path);
  const full = JSON.parse((await run(["show", path, "1", "--json"])).stdout).body.text as string;
  const result = await run(["body", path, "1", "--body-file", body(full)]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("### Issue 1: 甲");
  expect(result.stderr).toMatch(/heading/);
  expect(text(path)).toBe(before);
  expect((await run(["new", path, "--title", "乙", "--body-file", body("### Issue 2: 乙\n\nx\n")])).code).toBe(2);
});

test("probe10: show --json for a missing id keeps stdout empty (message on stderr)", async () => {
  const result = await run(["show", file(), "99", "--json"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("no such issue: 99");
});

describe("review11", () => {
  const withSummary = async (summary: string) => {
    const path = file();
    expect((await run(["new", path, "--title", "login crash", "--body-file", body("**验收判据**：x\n")])).code).toBe(0);
    return file(text(path).replace("| 1 | 未决 | P2 | login crash |", `| 1 | 未决 | P2 | ${summary} |`));
  };

  test("sync --titles --prefer table copies a longer table summary into the heading (nothing is lost)", async () => {
    const path = await withSummary("login crash on Safari");
    expect((await run(["sync", path, "--titles", "--prefer", "table"])).code).toBe(0);
    expect(text(path)).toContain("### Issue 1: login crash on Safari");
  });

  test("sync --titles --prefer body names --prefer table as the way to keep the table wording", async () => {
    const path = await withSummary("login crash on Safari");
    const result = await run(["sync", path, "--titles"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("--prefer table");
  });

  test("a header with a digit is still a header for adopt (E124 ⇔ adopt migrates)", async () => {
    const path = file(TEMPLATE.replace("## 索引", "## 待处理\n\n| # | 状态 | P | 摘要 | 判据 | 负责人2 |\n|---|---|---|---|---|---|\n| 50 | 未决 | P1 | alpha | c | bob |\n\n## 索引"));
    expect(JSON.parse((await run(["check", path, "--json"])).stdout).errors.map((e: { code: string }) => e.code)).toContain("E124");
    const adopted = await run(["adopt", path]);
    expect(adopted.code).toBe(0);
    expect(text(path)).toMatch(/\| 50 \| 未决 \| P1 \| alpha \|/);
    expect((await run(["check", path])).stdout).toContain("0 errors");
  });

  test("bold Q/A lines with a colon inside the bold are not duplicate labels (W206)", async () => {
    const path = file();
    expect((await run(["new", path, "--title", "甲", "--body-file", body("**现象**：x\n\n**Q：** 为什么？\n**A：** 因为。\n**Q：** 还有？\n**A：** 没了。\n")])).code).toBe(0);
    const warnings = JSON.parse((await run(["check", path, "--json"])).stdout).warnings as { code: string }[];
    expect(warnings.map((w) => w.code)).not.toContain("W206");
  });

  test("show --label accepts the colon form of the name", async () => {
    const path = file();
    expect((await run(["new", path, "--title", "甲", "--body-file", body("**验收判据：** 甲\n")])).code).toBe(0);
    const result = await run(["show", path, "1", "--label", "验收判据："]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("甲");
  });
});

describe("#56/#57 every issue-table shape: check, adopt and new agree", () => {
  const SHAPES: Record<string, string> = {
    "# | 摘要": "| # | 摘要 |\n|---|---|\n| 7 | 旧的甲 |\n",
    "# | 说明": "| # | 说明 |\n|---|---|\n| 7 | 旧的甲 |\n",
    "# | 判据": "| # | 判据 |\n|---|---|\n| 7 | 旧的甲 |\n",
    "编号 | 说明": "| 编号 | 说明 |\n|---|---|\n| 7 | 旧的甲 |\n",
    "data row above the separator": "| 7 | 未决 | 旧的甲 |\n|---|---|---|\n",
  };
  const LEDGER_ONLY: Record<string, string> = { "# | 状态 | 说明": "| # | 状态 | 说明 |\n|---|---|---|\n| 7 | 未决 | 旧的甲 |\n" };
  const withSection = (title: string, table: string) =>
    file(TEMPLATE.replace("## 索引", `## ${title}\n\n${table}\n## 索引`));
  type Diag = { code: string; line: number; message: string };
  const diags = async (path: string) =>
    JSON.parse((await run(["check", path, "--json"])).stdout) as { errors: Diag[]; warnings: Diag[] };
  const lineOf7 = (path: string) => text(path).split("\n").findIndex((l) => l.startsWith("| 7 |")) + 1;

  for (const [shape, table] of Object.entries({ ...SHAPES, ...LEDGER_ONLY })) {
    test(`待处理 / ${shape}: E124, id reserved, adopt migrates it`, async () => {
      const path = withSection("待处理", table);
      const { errors } = await diags(path);
      expect(errors.filter((e) => e.code === "E124").map((e) => e.line)).toEqual([lineOf7(path)]);
      const copy = file(text(path));
      expect((await run(["new", copy, "--title", "撞号", "--id", "7"])).code).toBe(2);
      expect((await run(["new", copy, "--title", "新"])).stdout.trim()).toBe("8");
      const adopted = await run(["adopt", path]);
      expect(adopted.code).toBe(0);
      expect(text(path)).toMatch(/\| 7 \| 未决 \|  \| 旧的甲 \|/);
      expect((await run(["check", path])).stdout).toContain("0 errors");
    });
  }

  for (const [shape, table] of Object.entries(SHAPES)) {
    test(`变更记录 / ${shape}: W225 once, id reserved, adopt says it keeps the table`, async () => {
      const path = withSection("变更记录", table);
      const { errors, warnings } = await diags(path);
      expect(errors).toEqual([]);
      const w225 = warnings.filter((w) => w.code === "W225");
      expect(w225.map((w) => w.line)).toEqual([lineOf7(path)]);
      const copy = file(text(path));
      const clash = await run(["new", copy, "--title", "撞号", "--id", "7"]);
      expect(clash.code).toBe(2);
      expect(clash.stderr).toContain(`L${lineOf7(path)}`);
      // Numbering skips 7 when it gets there (6 → 8), not before.
      expect((await run(["new", copy, "--title", "六", "--id", "6"])).code).toBe(0);
      expect((await run(["new", copy, "--title", "新"])).stdout.trim()).toBe("8");
      const dry = await run(["adopt", path, "--dry-run"]);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain("cited-table");
      expect(dry.stdout).toContain(`L${lineOf7(path)}`);
      const before = text(path);
      expect((await run(["adopt", path])).code).toBe(0);
      expect(text(path)).toBe(before);
    });
  }

  test("a converting adopt also reports the W225 table it keeps", async () => {
    const path = file(TEMPLATE.replace("## 索引", "## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n\n## 变更记录\n\n| # | 说明 |\n|---|---|\n| 7 | 旧的 |\n\n## 索引"));
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("cited-table");
    expect(text(path)).toContain("| 7 | 旧的 |");
  });

  test("tables kept silent on purpose: 路线图 ID|状态|说明 and 变更记录 #|状态|说明", async () => {
    for (const [title, table] of [
      ["路线图", "| ID | 状态 | 说明 |\n|---|---|---|\n| 7 | 进行中 | 某事 |\n"],
      ["变更记录", LEDGER_ONLY["# | 状态 | 说明"]!],
    ] as const) {
      const path = withSection(title, table);
      const { errors, warnings } = await diags(path);
      expect([...errors, ...warnings].map((d) => d.code)).toEqual([]);
      expect((await run(["new", path, "--title", "撞号", "--id", "7"])).code).toBe(0);
    }
  });

  test("show of a cited id says where it is cited (exit 1)", async () => {
    const path = withSection("变更记录", SHAPES["# | 说明"]!);
    const shown = await run(["show", path, "7"]);
    expect(shown.code).toBe(1);
    expect(shown.stderr).toContain(`L${lineOf7(path)}`);
  });
});

describe("review12: numeric headers, narrative tables and the status guess", () => {
  const withSection = (title: string, table: string) =>
    file(TEMPLATE.replace("## 索引", `## ${title}\n\n${table}\n## 索引`));
  type Diag = { code: string };
  const codes = async (path: string) => {
    const r = JSON.parse((await run(["check", path, "--json"])).stdout) as { errors: Diag[]; warnings: Diag[] };
    return [...r.errors, ...r.warnings].map((d) => d.code);
  };

  test("a numeric header row above a real separator is a header (stats table under 总览)", async () => {
    const path = withSection("状态总览", "| 2026 | 开放 | 关闭 |\n|---|---|---|\n| 12 | 3 | 4 |\n");
    expect(await codes(path)).toEqual([]);
    expect((await run(["new", file(text(path)), "--title", "新"])).stdout.trim()).toBe("1");
    const before = text(path);
    expect((await run(["adopt", path])).code).toBe(0);
    expect(text(path)).toBe(before);
  });

  test("numeric headers under other headings are not W225 and reserve nothing", async () => {
    for (const table of ["| 2024 | 2025 |\n|---|---|\n| 120 | 300 |\n", "| 3 | 4 | 5 |\n|---|---|---|\n| 甲 | 乙 | 丙 |\n"]) {
      const path = withSection("统计", table);
      expect(await codes(path)).toEqual([]);
      expect((await run(["new", path, "--title", "新"])).stdout.trim()).toBe("1");
    }
  });

  test("an id row above the separator with rows below is data when its 2nd cell is a status", async () => {
    const path = withSection("待处理", "| 7 | 未决 | 甲 |\n|---|---|---|\n| 8 | 未决 | 乙 |\n");
    expect((await codes(path)).filter((c) => c === "E124").length).toBe(2);
    expect((await run(["adopt", path])).code).toBe(0);
    expect(text(path)).toMatch(/\| 7 \| 未决 \|  \| 甲 \|\n\| 8 \| 未决 \|  \| 乙 \|/);
  });

  test("cited ids are skipped by default numbering without jumping past them", async () => {
    const path = withSection("错误码", "| 编号 | 说明 |\n|---|---|\n| 404 | 未找到 |\n| 500 | 服务器错 |\n");
    expect((await run(["new", path, "--title", "一"])).stdout.trim()).toBe("1");
    expect((await run(["new", path, "--title", "三", "--id", "403"])).code).toBe(0);
    expect((await run(["new", path, "--title", "下一个"])).stdout.trim()).toBe("405");
    expect((await run(["new", path, "--title", "撞", "--id", "404"])).code).toBe(2);
  });

  test("pipe lines without a separator are not a table: no W225, nothing reserved", async () => {
    const path = withSection("笔记", "| # | 说明 |\n| 3 | 甲 |\n");
    expect(await codes(path)).not.toContain("W225");
    expect((await run(["new", file(text(path)), "--title", "撞", "--id", "3"])).code).toBe(0);
  });

  test("the width-3 status guess needs an exact status word", async () => {
    const path = withSection("待处理", "| 7 | 观察（等上游） | 上游修复后重测 |\n");
    expect((await run(["adopt", path])).code).toBe(0);
    expect(text(path)).toContain("| 7 | 未决 |  | 观察（等上游） |");
  });
});

describe("probe11: black-box findings after round eleven", () => {
  const before = (section: string) => file(TEMPLATE.replace("## 正文", `${section}\n## 正文`));
  type Diag = { code: string; line: number };
  const check = async (path: string) =>
    JSON.parse((await run(["check", path, "--json"])).stdout) as { errors: Diag[]; warnings: Diag[] };

  test("header-less issue rows above a real separator under 待处理 are E124 and migrate", async () => {
    const path = before("## 待处理\n\n| 7 | 甲 | 乙 |\n|---|---|---|\n| 8 | 丙 | 丁 |\n");
    expect((await check(path)).errors.filter((e) => e.code === "E124").length).toBe(2);
    expect((await run(["adopt", path])).code).toBe(0);
    expect(text(path)).toMatch(/\| 7 \| 未决 \|  \| 甲 \|/);
    expect(text(path)).toMatch(/\| 8 \| 未决 \|  \| 丙 \|/);
  });

  test("the status guess is per row: a status word in one row does not reshape the others", async () => {
    const path = before("## 待处理\n\n| 7 | 已修 | 甲 |\n|---|---|---|\n| 8 | 乙 | 丙 |\n");
    expect((await run(["adopt", path])).code).toBe(0);
    const out = text(path);
    expect(out).toMatch(/\| 7 \| 已修 \|  \| 甲 \|/);
    expect(out).toMatch(/\| 8 \| 未决 \|  \| 乙 \|/);
  });

  for (const heading of ["## 索引（旧）", "## 已关闭（2025）", "## 索引"]) {
    test(`a table under '${heading}' (not the one the ledger reads) is E124 and its ids are reserved`, async () => {
      const path = before(`${heading}\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 7 | 未决 | 七 |\n`);
      expect((await check(path)).errors.map((e) => e.code)).toContain("E124");
      expect((await run(["new", file(text(path)), "--title", "新七", "--id", "7"])).code).toBe(2);
      const adopted = await run(["adopt", path]);
      expect(adopted.code).toBe(0);
      expect(text(path)).toContain("七");
      expect((await check(path)).errors).toEqual([]);
    });
  }

  test("list --expand refuses a huge range without building it", async () => {
    const path = file(TEMPLATE.replace("|---|---|---|---|\n", "|---|---|---|---|\n| 3–900000000 | 未决 | P2 | 区间 |\n"));
    const result = await run(["list", path, "--expand"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("100000");
  });

  test("the H3 group report says the open-table default (未决), not 未分类", async () => {
    const path = before("## 待处理\n\n### 第一轮\n\n| # | 摘要 |\n|---|---|\n| 7 | 甲 |\n");
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.stdout).toContain("| 7 | 未决 |");
    expect(result.stdout).toMatch(/第一轮[^\n]*开放表里记为「未决」/);
  });

  test("a dry-run diff of a file without a final newline applies with patch(1)", async () => {
    const path = file();
    expect((await run(["new", path, "--title", "甲"])).code).toBe(0);
    expect(text(path).endsWith("\n")).toBe(false);
    const dry = await run(["close", path, "1", "--criteria", "x", "--keep-body", "--dry-run"]);
    expect(dry.stdout).toContain("\\ No newline at end of file");
    const out = `${path}.patched`;
    const patched = spawnSync("patch", ["-s", "-o", out, path], { input: dry.stdout });
    expect(patched.status).toBe(0);
    await run(["close", path, "1", "--criteria", "x", "--keep-body"]);
    expect(readFileSync(out, "utf8")).toBe(text(path));
  });
});

describe("review13: header rule, cited ranges, diffs, kept rows", () => {
  const before = (section: string) => file(TEMPLATE.replace("## 正文", `${section}\n## 正文`));
  type Diag = { code: string; line: number };
  const errorsOf = async (path: string) =>
    (JSON.parse((await run(["check", path, "--json"])).stdout) as { errors: Diag[] }).errors;

  test("one odd row below the separator does not turn issue rows into a header", async () => {
    for (const odd of ["| 9 |  |  |", "| 说明 | 无 | 无 |"]) {
      const path = before(`## 待处理\n\n| 7 | 甲 | 乙 |\n|---|---|---|\n| 8 | 丙 | 丁 |\n${odd}\n`);
      const e124 = (await errorsOf(path)).filter((e) => e.code === "E124").length;
      expect(e124).toBeGreaterThanOrEqual(2);
      expect((await run(["new", file(text(path)), "--title", "撞", "--id", "7"])).code).toBe(2);
      expect((await run(["adopt", path])).code).toBe(0);
      expect(text(path)).toMatch(/\| 7 \| 未决 \|  \| 甲 \|/);
    }
  });

  test("new steps over a cited range in one go", async () => {
    const path = before("## 变更记录\n\n| # | 说明 |\n|---|---|\n| 1–900000000 | 区间 |\n");
    const started = Date.now();
    expect((await run(["new", path, "--title", "z"])).stdout.trim()).toBe("900000001");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  const applies = async (content: string, args: string[]) => {
    const path = file(content);
    const dry = await run([args[0]!, path, ...args.slice(1), "--dry-run"]);
    expect(dry.code).toBe(0);
    const out = `${path}.patched`;
    const patched = spawnSync("patch", ["-s", "-o", out, path], { input: dry.stdout });
    expect(patched.stderr.toString() + patched.stdout.toString()).toBe("");
    expect(patched.status).toBe(0);
    expect((await run([args[0]!, path, ...args.slice(1)])).code).toBe(0);
    expect(readFileSync(out)).toEqual(readFileSync(path));
  };

  test("a dry-run diff that removes the last lines of a file without a final newline applies", async () => {
    const noAppendix = TEMPLATE.replace(/\n+## 附录\s*$/, "");
    const path = file(noAppendix);
    expect((await run(["new", path, "--title", "甲", "--body-file", body("**现象**：x\n\n**验收判据**：y\n")])).code).toBe(0);
    expect(text(path).endsWith("\n")).toBe(false);
    await applies(text(path), ["close", "1"]);
  });

  test("a dry-run diff of a CRLF ledger applies with patch(1)", async () => {
    const path = file();
    expect((await run(["new", path, "--title", "甲", "--body-file", body("**验收判据**：y\n")])).code).toBe(0);
    await applies(text(path).replaceAll("\n", "\r\n") + "\r\n", ["close", "1"]);
  });

  test("a header-less block under a header-shaped first row: check and adopt agree", async () => {
    const path = before("## 待处理\n\n| 负责人2 | 甲 | 乙 |\n| 7 | 未决 | 七 |\n\n| 30 | 未决 | 三十 |\n|---|---|---|\n");
    const hasE124At7 = (await errorsOf(path)).some((e) => e.code === "E124" && text(path).split("\n")[e.line - 1]!.startsWith("| 7 "));
    const adopted = await run(["adopt", path]);
    expect(adopted.code).toBe(0);
    const migrated7 = text(path).includes("| 7 | 未决 |  | 七 |");
    expect(migrated7).toBe(hasE124At7);
    expect(text(path)).toContain("七");
  });

  test("a non-id row inside a migrated table is kept and reported, not dropped", async () => {
    const path = before("## 待处理\n\n| 7 | 未决 | 甲 |\n|---|---|---|\n| 8 | 未决 | x |\n| 备注 | a | b |\n");
    const adopted = await run(["adopt", path]);
    expect(adopted.code).toBe(0);
    expect(text(path)).toMatch(/备注 \| a \| b/);
    expect(adopted.stdout).toContain("备注");
  });
});

describe("round 12 Q3: a year in a title is not a count", () => {
  const codes = async (path: string) => {
    const report = JSON.parse((await run(["check", path, "--json"])).stdout) as { errors: { code: string }[] };
    return report.errors.map((e) => e.code);
  };

  test("check does not report E121 for （2025） but still does for （2）", async () => {
    const year = file(TEMPLATE.replace("## 正文", "## 发布（2025）\n\n说明\n\n## 正文"));
    expect(await codes(year)).not.toContain("E121");
    for (const count of ["（2）", "(12)", "（ 3 ）", "（12345）", "（3025）"]) {
      const path = file(TEMPLATE.replace("## 正文", `## 发布${count}\n\n说明\n\n## 正文`));
      expect(await codes(path)).toContain("E121");
    }
  });

  test("new, rename and reopen accept a year-suffixed title", async () => {
    const path = file();
    const created = await run(["new", path, "--title", "版本（2026）", "--body-file", body("**验收判据**：y\n")]);
    expect(created.code).toBe(0);
    expect(text(path)).toContain("### Issue 1: 版本（2026）");
    expect((await run(["rename", path, "1", "发布 (1999)"])).code).toBe(0);
    expect((await run(["close", path, "1"])).code).toBe(0);
    expect((await run(["reopen", path, "1"])).code).toBe(0);
    expect((await run(["check", path])).code).toBe(0);
    expect((await run(["new", file(), "--title", "缓存（3）"])).code).toBe(2);
  });

  test("adopt keeps a year in a heading and strips a count", async () => {
    const path = file("# T\n\n## 发布（2025）\n\n说明\n\n## 旧记录（3）\n\n文字\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n");
    const adopted = await run(["adopt", path]);
    expect(adopted.code).toBe(0);
    expect(text(path)).toContain("发布（2025）");
    expect(text(path)).not.toContain("旧记录（3）");
    expect((await run(["check", path])).code).toBe(0);
  });
});

describe("round 12 Q4: list --json names the ids W225 tables reserve", () => {
  test("citedRows carries line, reason and ids; absent when nothing is cited", async () => {
    const path = file(TEMPLATE.replace("## 正文", "## 变更记录\n\n| # | 说明 |\n|---|---|\n| 7 | 甲 |\n| 9–11 | 乙 |\n\n## 正文"));
    for (const extra of [[], ["--closed"]]) {
      const listed = await run(["list", path, "--json", ...extra]);
      const json = JSON.parse(listed.stdout) as { citedRows?: { line: number; reason: string; ids: string[] }[]; unreadableRows?: unknown };
      expect(json.citedRows?.map((r) => r.ids)).toEqual([["7"], ["9–11"]]);
      expect(json.citedRows?.[0]?.reason).toContain("W225");
      expect(text(path).split("\n")[json.citedRows![0]!.line - 1]).toBe("| 7 | 甲 |");
      expect(json.unreadableRows).toBeUndefined();
    }
    const plain = JSON.parse((await run(["list", file(), "--json"])).stdout) as Record<string, unknown>;
    expect("citedRows" in plain).toBe(false);
  });
});

describe("round 12 review: count suffix edges", () => {
  test("adopt strips a count before ATX closing hashes, so its output passes check", async () => {
    const path = file("# T\n\n## 旧记录（3） ##\n\n文字\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n");
    expect((await run(["adopt", path])).code).toBe(0);
    expect(text(path)).not.toContain("（3）");
    expect((await run(["check", path])).code).toBe(0);
  });

  test("full-width digits count as a count, and a full-width year as a year", async () => {
    const codes = async (heading: string) =>
      (JSON.parse((await run(["check", file(TEMPLATE.replace("## 正文", `${heading}\n\nx\n\n## 正文`)), "--json"])).stdout) as { errors: { code: string }[] }).errors.map((e) => e.code);
    expect(await codes("## 发布（２）")).toContain("E121");
    expect(await codes("## 发布（２０２５）")).not.toContain("E121");
    expect((await run(["new", file(), "--title", "缓存（３）"])).code).toBe(2);
  });
});
