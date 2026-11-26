/**
 * Round thirteen: the dogfooding entries #61–#73 (2026-11-25).
 *
 * Each describe names the ledger issue it pins down.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.js";

const TEMPLATE = readFileSync(new URL("../TEMPLATE.md", import.meta.url), "utf8");
const CANONICAL = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-round13-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function file(content = TEMPLATE, ext = "md"): string {
  const path = join(dir, `f-${counter++}.${ext}`);
  writeFileSync(path, content);
  return path;
}
const text = (path: string) => readFileSync(path, "utf8");

/** TEMPLATE + one open row and body for that row. */
function one(title = "甲", bodyText = "**现象**：x\n\n**验收判据**：甲\n"): string {
  return TEMPLATE
    .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      `| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 未决 | P2 | ${title} |\n`)
    .replace("## 正文\n", `## 正文\n\n### Issue 1: ${title}\n\n${bodyText}`);
}

describe("#63 read views say when check fails", () => {
  const broken = () => {
    // E106: index summary and body heading disagree.
    const path = file(CANONICAL.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 侧栏宽度不可调（改） |"));
    return path;
  };

  test("check is exit 3 while list/counts/show keep their exit codes but warn on stderr", async () => {
    const path = broken();
    expect((await run(["check", path])).code).toBe(3);
    for (const args of [["list", path], ["counts", path], ["show", path, "2"]]) {
      const result = await run(args);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("E106");
      expect(result.stderr).toContain("check");
    }
  });

  test("JSON views carry the check errors, expected/actual included", async () => {
    const path = broken();
    const listed = JSON.parse((await run(["list", path, "--json"])).stdout);
    expect(listed.diagnostics.errors[0]).toMatchObject({ code: "E106", id: "2" });
    expect(listed.diagnostics.errors[0].expected).toBe("侧栏宽度不可调（改）");
    expect(listed.diagnostics.errors[0].actual).toBe("侧栏宽度不可调");
    expect(JSON.parse((await run(["counts", path, "--json"])).stdout).diagnostics.errors[0].code).toBe("E106");
    expect(JSON.parse((await run(["show", path, "2", "--json"])).stdout).diagnostics.errors[0].code).toBe("E106");
  });

  test("E102: show says the body is missing instead of only printing (无正文块)", async () => {
    const path = file(TEMPLATE.replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 4 | 未决 | P2 | 无正文 |\n"));
    expect((await run(["check", path])).code).toBe(3);
    const shown = await run(["show", path, "4", "--json"]);
    const doc = JSON.parse(shown.stdout);
    expect(doc.diagnostics.errors.some((error: { code: string; id?: string }) => error.code === "E102" && error.id === "4")).toBe(true);
  });

  test("a clean ledger adds no stderr note and stable empty diagnostics", async () => {
    const result = await run(["list", file(CANONICAL), "--json"]);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).diagnostics).toEqual({ errors: [], warnings: [] });
  });
});

describe("#69 show marks a body that belongs to a sibling id", () => {
  const merged = () => file(TEMPLATE
    .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 3, 4 | 未决 | P2 | 合并行 |\n")
    .replace("## 正文\n", "## 正文\n\n### Issue 3: 合并行\n\n**现象**：三号的现象\n\n**验收判据**：三号的判据\n"));

  test("show 4 names #3 as the owner instead of silently borrowing", async () => {
    const path = merged();
    const shown = await run(["show", path, "4"]);
    expect(shown.code).toBe(0);
    expect(shown.stderr).toContain("#3");
    expect(shown.stdout).toContain("三号的现象");
    const json = JSON.parse((await run(["show", path, "4", "--json"])).stdout);
    expect(json.body.id).toBe("3");
    expect(json.body.inherited).toBe(true);
    expect(json.criteriaFrom).toBe("3");
  });

  test("show 3 (the owner) carries no inherited marker", async () => {
    const path = merged();
    const json = JSON.parse((await run(["show", path, "3", "--json"])).stdout);
    expect(json.body.id).toBe("3");
    expect(json.body.inherited).toBeUndefined();
    expect(json.criteriaFrom).toBeUndefined();
  });

  test("--label on an inherited body also says whose it is", async () => {
    const path = merged();
    const shown = await run(["show", path, "4", "--label", "现象"]);
    expect(shown.code).toBe(0);
    expect(shown.stderr).toContain("#3");
  });
});

describe("#61 a label line inside a fence is an example, not criteria", () => {
  test("an empty criteria label followed by a fenced label line stays empty", async () => {
    const path = file(one("甲", "**现象**：x\n\n**验收判据**：\n\n```text\n**验收判据**：示例\n```\n"));
    const json = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(json.criteria).toBeUndefined();
    const closed = await run(["close", path, "1", "--criteria-from-body"]);
    expect(closed.code).toBe(2);
    expect(closed.stderr).toContain("验收判据");
  });

  test("a real criteria line is not polluted by a fenced example label", async () => {
    const path = file(one("甲", "**现象**：x\n\n**验收判据**：真判据。\n\n```text\n**验收判据**：示例\n```\n"));
    const json = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(json.criteria).toBe("真判据。");
  });

  test("ordinary fenced content still counts as criteria", async () => {
    const path = file(one("甲", "**现象**：x\n\n**验收判据**：\n\n```text\nnpm test\n```\n"));
    const json = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(json.criteria).toBe("npm test");
  });
});

describe("#65 duplicate detection ignores whitespace inside the summary", () => {
  test("a middle space no longer bypasses the refusal, and W212 sees it too", async () => {
    const path = file(CANONICAL);
    const first = await run(["new", path, "--title", "侧栏宽度 不可调"]);
    expect(first.code).toBe(2);
    expect(first.stderr).toContain("#2");
    const allowed = await run(["new", path, "--title", "侧栏宽度 不可调", "--allow-duplicate-title"]);
    expect(allowed.code).toBe(0);
    expect((await run(["check", path])).stdout).toContain("W212");
  });

  test("full-width and half-width spaces both count as whitespace", async () => {
    const path = file(one("甲乙"));
    for (const variant of ["甲 乙", "甲　乙", "甲乙"]) {
      const result = await run(["new", path, "--title", variant]);
      expect(result.code).toBe(2);
    }
  });

  test("an English title with and without a space is also one summary", async () => {
    const path = file(one("Fix CSV export"));
    expect((await run(["new", path, "--title", "FixCSV export"])).code).toBe(2);
  });
});

describe("#66 a write that changes nothing says so on stdout", () => {
  test("status / priority / rename report (no changes) with exit 0", async () => {
    const path = file(CANONICAL);
    for (const args of [["status", path, "2", "未决"], ["priority", path, "2", "P1"], ["rename", path, "2", "侧栏宽度不可调"]]) {
      const result = await run(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("(no changes)\n");
    }
  });

  test("--dry-run and the real run agree on (no changes)", async () => {
    const path = file(CANONICAL);
    const before = text(path);
    const dry = await run(["rename", path, "2", "侧栏宽度不可调", "--dry-run"]);
    expect(dry.stdout).toBe("(no changes)\n");
    expect(text(path)).toBe(before);
  });

  test("a real change keeps stdout empty", async () => {
    const path = file(CANONICAL);
    const result = await run(["status", path, "2", "观察"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("#57 adopt does not claim there is nothing left to look at", () => {
  test("a width-2 cited table is named as retained, not as 'nothing to convert'", async () => {
    const path = file(TEMPLATE
      .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n", "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 未决 | P2 | 甲 |\n")
      .replace("## 正文\n", "## 正文\n\n### Issue 1: 甲\n\n**现象**：x\n\n**验收判据**：甲\n")
      + "\n## 变更记录\n\n| # | 说明 |\n|---|---|\n| 7 | 某次改动 |\n");
    const dry = await run(["adopt", path, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("W225");
    expect(dry.stdout).toContain("不迁移");
  });

  test("a clean ledger still says it is canonical", async () => {
    const dry = await run(["adopt", file(CANONICAL), "--dry-run"]);
    expect(dry.stdout).toContain("已是规范台账");
  });
});

describe("#72 adopt reports a renamed foreign heading and keeps 附录 structure", () => {
  const input = (section: string) => file(one() + section);

  test("a count stripped inside a foreign section is named in the report", async () => {
    const path = input("\n## 复核记录\n\n### 第三轮复核（3）\n\n本轮结论：通过。\n");
    const dry = await run(["adopt", path, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("第三轮复核（3）");
    expect(dry.stdout).toContain("第三轮复核");
    expect(dry.stdout).toContain("以原级别 H2");
    expect((await run(["adopt", path])).code).toBe(0);
    expect(text(path)).toContain("### 第三轮复核");
    expect(text(path)).not.toContain("（3）");
  });

  test("an untouched foreign section still says 原样移入附录", async () => {
    // Old layout, so adopt really converts the file.
    const path = file("# T\n\n## 待处理\n\n| # | 状态 | 摘要 |\n|---|---|---|\n| 1 | 未决 | 甲 |\n\n## 正文\n\n### Issue 1: 甲\n\nx\n\n## 复核记录\n\n本轮结论：通过。\n");
    const dry = await run(["adopt", path, "--dry-run"]);
    expect(dry.stdout).toContain("原样移入附录");
    expect(dry.stdout).not.toContain("去掉（N）计数后移入附录");
  });
});

describe("#73 adopt does not hide a real drift behind a stripped count", () => {
  const withSummary = (table: string, heading: string) => file(TEMPLATE
    .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      `| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 未决 | P2 | ${table} |\n`)
    .replace("## 正文\n", `## 正文\n\n### Issue 1: ${heading}\n\n**现象**：x\n\n**验收判据**：甲\n`));

  test("table 甲（3） vs body 甲 is a visible decision with the id", async () => {
    const dry = await run(["adopt", withSummary("甲（3）", "甲"), "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("summary-count-stripped");
    expect(dry.stdout).toContain("#1");
    expect(dry.stdout).toContain("甲（3）");
  });

  test("both sides carrying the same count is still silent", async () => {
    const path = withSummary("甲（3）", "甲（3）");
    const dry = await run(["adopt", path, "--dry-run"]);
    expect(dry.stdout).not.toContain("open-title-conflict");
    expect(dry.stdout).not.toContain("summary-count-stripped");
    expect((await run(["adopt", path])).code).toBe(0);
    expect((await run(["check", path])).code).toBe(0);
  });

  test("different counts on the two sides are a conflict", async () => {
    const dry = await run(["adopt", withSummary("甲（3）", "甲（4）"), "--dry-run"]);
    expect(dry.stdout).toContain("open-title-conflict");
  });

  test("a drift without counts still conflicts", async () => {
    const dry = await run(["adopt", withSummary("甲2025", "甲2026"), "--dry-run"]);
    expect(dry.stdout).toContain("open-title-conflict");
  });
});

describe("#62 open issues without a non-empty 验收判据 warn", () => {
  test("new without --body-file leaves a skeleton that check and --strict report", async () => {
    const path = file(TEMPLATE);
    expect((await run(["new", path, "--title", "空条目"])).code).toBe(0);
    const check = await run(["check", path]);
    expect(check.stdout).toContain("W261");
    expect((await run(["check", path, "--strict"])).code).toBe(3);
  });

  test("deleting the criteria from an open body warns; restoring it clears the warning", async () => {
    const path = file(one("甲", "**现象**：x\n\n**验收判据**：甲\n"));
    expect((await run(["check", path])).stdout).not.toContain("W261");
    const without = file(text(path).replace("\n**验收判据**：甲\n", "\n"));
    expect((await run(["check", without])).stdout).toContain("W261");
  });

  test("closed issues' criteria column is not judged; canonical stays 0 warnings", async () => {
    const result = await run(["check", file(CANONICAL), "--json"]);
    expect(JSON.parse(result.stdout).warnings).toEqual([]);
  });
});

describe("#64/#70 split does not invent bodies, and parses once", () => {
  test("splitting a row whose ids have no bodies leaves E102, and names them", async () => {
    const path = file(TEMPLATE.replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 5, 6 | 未决 | P2 | 两号共一行 |\n"));
    expect((await run(["check", path])).code).toBe(3);
    const split = await run(["split", path, "5"]);
    expect(split.code).toBe(0);
    expect(split.stderr).toContain("#5");
    expect(split.stderr).toContain("#6");
    expect(text(path)).toContain("| 5 | 未决 | P2 | 两号共一行 |");
    expect(text(path)).toContain("| 6 | 未决 | P2 | 两号共一行 |");
    expect(text(path)).not.toContain("### Issue 5:");
    expect(text(path)).not.toContain("### Issue 6:");
    const after = await run(["check", path]);
    expect(after.code).toBe(3);
    expect(after.stdout).toContain("E102");
  });

  test("a sibling with a body is not copied onto the id that lacks one", async () => {
    const path = file(TEMPLATE
      .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
        "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 30, 31 | 未决 | P2 | 合并行 |\n")
      .replace("## 正文\n", "## 正文\n\n### Issue 30: 合并行\n\n**现象**：三十的现象\n\n**验收判据**：三十的判据\n"));
    expect((await run(["split", path, "30"])).code).toBe(0);
    expect(text(path)).toContain("### Issue 30: 合并行");
    expect(text(path)).not.toContain("### Issue 31:");
    const shown = await run(["show", path, "31"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("(无正文块)");
  });

  test("an open range with no bodies still splits, exposing E102 per id", async () => {
    const path = file(TEMPLATE.replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1–4 | 未决 | P2 | 大区间 |\n"));
    const split = await run(["split", path, "1"]);
    expect(split.code).toBe(0);
    expect((await run(["check", path])).stdout).toContain("E102 x4");
  });

  test("closed ranges still split cleanly and stay 0 errors", async () => {
    const path = file(CANONICAL);
    expect((await run(["split", path, "8"])).code).toBe(0);
    for (const id of ["7", "8", "9", "20"]) expect(text(path)).toContain(`| ${id} | 撤回 |`);
    expect((await run(["check", path])).code).toBe(0);
  });

  test("splitting 500 open ids on a 12k-line ledger stays near check time", async () => {
    const filler = Array.from({ length: 12000 }, (_, index) => `填充 ${index}`).join("\n");
    const path = file(TEMPLATE.replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1–500 | 未决 | P2 | 大区间 |\n") + "\n" + filler + "\n");
    const checkStart = performance.now();
    expect((await run(["check", path])).code).toBe(3);
    const checkMs = performance.now() - checkStart;
    const splitStart = performance.now();
    expect((await run(["split", path, "1"])).code).toBe(0);
    const splitMs = performance.now() - splitStart;
    // Generous: the old per-id re-parse took ~30x check on this shape.
    expect(splitMs).toBeLessThan(Math.max(1500, checkMs * 8));
  });
});

describe("#67 list --json --with-body", () => {
  test("one call carries labels and criteria for every issue", async () => {
    const path = file(CANONICAL);
    const result = await run(["list", path, "--json", "--with-body"]);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout);
    const two = doc.issues.find((issue: { id: string }) => issue.id === "2");
    expect(two.labels["现象"]).toContain("侧栏固定");
    expect(two.criteria).toBe("重启后保持上次宽度。");
    expect(two.criteriaSource).toBe("body");
    // Same labels as `show --json`, and one snapshot for the batch.
    const shown = JSON.parse((await run(["show", path, "2", "--json"])).stdout);
    expect(two.labels).toEqual(shown.labels);
    expect(doc.snapshot).toBe(shown.snapshot);
  });

  test("without the flag the field set is unchanged", async () => {
    const doc = JSON.parse((await run(["list", file(CANONICAL), "--json"])).stdout);
    expect(Object.keys(doc.issues[0]).sort()).toEqual(["count", "id", "ids", "priority", "status", "summary"]);
  });

  test("--with-body needs --json", async () => {
    const result = await run(["list", file(CANONICAL), "--with-body"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--json");
  });
});

describe("#71 a multi-id id cell points at the row, not just 'not an id'", () => {
  const merged = () => file(TEMPLATE
    .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 30, 31 | 未决 | P2 | 合并行 |\n")
    .replace("## 正文\n", "## 正文\n\n### Issue 30: 合并行\n\n**现象**：x\n\n**验收判据**：甲\n"));

  test("show explains the cell holds two ids and how to proceed", async () => {
    const path = merged();
    const result = await run(["show", path, "30, 31"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("30");
    expect(result.stderr).toContain("31");
    expect(result.stderr).toContain("--expand");
  });

  test("each ids[] element of list --json is accepted by show", async () => {
    const path = merged();
    const listed = JSON.parse((await run(["list", path, "--json"])).stdout);
    expect(listed.issues[0].id).toBe("30, 31");
    for (const id of listed.issues[0].ids) expect((await run(["show", path, id])).code).toBe(0);
  });

  test("--expand ids are all individually addressable", async () => {
    const path = merged();
    const expanded = JSON.parse((await run(["list", path, "--json", "--expand"])).stdout);
    for (const issue of expanded.issues) expect((await run(["show", path, issue.id])).code).toBe(0);
  });
});

describe("review 13", () => {
  const withTitles = (table: string, heading: string, section = "") => file(TEMPLATE
    .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      `| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 未决 | P2 | ${table} |\n`)
    .replace("## 正文\n", `## 正文\n\n### Issue 1: ${heading}\n\n**现象**：x\n\n**验收判据**：甲\n`) + section);

  test("a count only on the body heading is not reported as a summary change", async () => {
    const dry = await run(["adopt", withTitles("甲", "甲（3）"), "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).not.toContain("summary-count-stripped");
    expect(dry.stdout).not.toContain("去掉开放项摘要里的");
    expect(dry.stdout).toContain("去掉标题里的");
  });

  test("the same count written differently is silent, not a conflict", async () => {
    for (const [table, heading] of [["甲（3）", "甲(3)"], ["甲（3）", "甲（３）"], ["甲 （3）", "甲（3）"]]) {
      const path = withTitles(table, heading);
      const dry = await run(["adopt", path, "--dry-run"]);
      expect(dry.stdout).not.toContain("open-title-conflict");
      expect(dry.stdout).not.toContain("summary-count-stripped");
      expect((await run(["adopt", path])).code).toBe(0);
      expect((await run(["check", path])).code).toBe(0);
      expect(text(path)).not.toContain("（3）");
      expect(text(path)).not.toContain("(3)");
    }
  });

  test("rename coordinates in the report are labelled as source lines", async () => {
    const source = one() + "\n## 复核记录\n\n### 第三轮复核（3）\n\n本轮结论：通过。\n";
    const path = file(source);
    const sourceLine = source.split("\n").findIndex((line) => line.includes("第三轮复核（3）")) + 1;
    const dry = await run(["adopt", path, "--dry-run"]);
    expect(dry.stdout).toContain(`源 L${sourceLine}「第三轮复核（3）」`);
  });

  test("a fenced Gherkin step is ordinary criteria content", async () => {
    const path = file(one("甲", "**现象**：x\n\n**验收判据**：\n\n```gherkin\n**Given** a ledger\n**When** I run check\n**Then** exit 0\n```\n"));
    const json = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(json.criteria).toContain("**Given** a ledger");
    expect((await run(["close", path, "1", "--criteria-from-body"])).code).toBe(0);
  });

  test("a label example in a fence indented under a list item stays out of criteria", async () => {
    const path = file(one("甲", "**现象**：x\n\n**验收判据**：\n- 运行下面的例子：\n    ```markdown\n    **验收判据**：清单里的示例\n    ```\n"));
    const json = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(json.criteria).not.toContain("清单里的示例");
    expect(json.criteria).toContain("运行下面的例子");
  });

  test("list --with-body stays linear on a few hundred issues", async () => {
    const rows: string[] = [];
    const bodies: string[] = [];
    for (let id = 1; id <= 300; id++) {
      rows.push(`| ${id} | 未决 | P2 | 条目 ${id} |`);
      bodies.push(`### Issue ${id}: 条目 ${id}\n\n**现象**：现象 ${id}\n\n**验收判据**：判据 ${id}\n`);
    }
    const path = file(TEMPLATE
      .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n", `| # | 状态 | P | 摘要 |\n|---|---|---|---|\n${rows.join("\n")}\n`)
      .replace("## 正文\n", `## 正文\n\n${bodies.join("\n")}`));
    const started = performance.now();
    const result = await run(["list", path, "--json", "--with-body"]);
    const elapsed = performance.now() - started;
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.issues).toHaveLength(300);
    expect(doc.issues[299].criteria).toBe("判据 300");
    expect(elapsed).toBeLessThan(2000);
  });

  test("with-body attaches a body kept under an interior id of a range", async () => {
    const path = file(TEMPLATE
      .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
        "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 5–7 | 未决 | P2 | 大区间 |\n")
      .replace("## 正文\n", "## 正文\n\n### Issue 6: 大区间\n\n**现象**：x\n\n**验收判据**：六号判据\n"));
    const doc = JSON.parse((await run(["list", path, "--json", "--with-body"])).stdout);
    expect(doc.issues[0]).toMatchObject({ id: "5–7", bodyFrom: "6", criteria: "六号判据" });
  });

  test("an unreadable row is detailed once, and check's error count is still named", async () => {
    const path = file(one() + "\n## 待处理\n\n| 7 | 未决 | 甲 |\n|---|---|---|\n");
    const listed = await run(["list", path]);
    // The row itself is described once (unreadableNote), not repeated per
    // error; the check summary line is never suppressed (round 14).
    expect(listed.stderr.split("could not be read").length - 1).toBe(1);
    expect(listed.stderr).toContain("note: 'issuemd check' reports 1 error(s)");
  });

  test("show for a missing id on a broken ledger still notes the check errors", async () => {
    const path = file(CANONICAL.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 侧栏宽度不可调（改） |"));
    const shown = await run(["show", path, "99"]);
    expect(shown.code).toBe(1);
    expect(shown.stderr).toContain("reports");
    expect(shown.stderr).toContain("E106");
  });
});
