/**
 * Regressions from the 2026-11-24 dogfooding ledger (issue-20261124.md).
 * Each describe names the dogfood issue number it pins down.
 */

import { afterAll, describe, expect, test } from "bun:test";
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
