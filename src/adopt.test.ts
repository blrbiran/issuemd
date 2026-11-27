/**
 * `adopt` converts the two real-world layouts into the canonical one.
 * The fixtures' `*.expected.json` files were hand-checked against the real
 * ledgers, so they are the acceptance oracle here too.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-adopt-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const expected = (name: string) =>
  JSON.parse(read(`${name}.expected.json`)) as Record<string, number | number[]>;

let counter = 0;
function copy(name: string): string {
  const path = join(dir, `adopt-${counter++}.md`);
  writeFileSync(path, read(name));
  return path;
}

async function adoptAndCheck(name: string) {
  const path = copy(name);
  const result = await run(["adopt", path]);
  expect(result.code).toBe(0);
  const check = await run(["check", path, "--json"]);
  expect(check.code).toBe(0);
  const listed = await run(["list", path, "--json"]);
  const closed = await run(["list", path, "--closed", "--json"]);
  return {
    result,
    counts: JSON.parse(check.stdout).counts,
    open: JSON.parse(listed.stdout).issues as { id: string }[],
    closed: JSON.parse(closed.stdout).issues as { id: string }[],
  };
}

describe("adopt: cafe layout", () => {
  test("produces a ledger whose check is clean and whose ids match the fixture", async () => {
    const want = expected("cafe-shaped");
    const { counts, open, closed } = await adoptAndCheck("cafe-shaped.md");
    expect(counts.open).toBe((want.openIds as number[]).length);
    expect(counts.closed).toBe((want.closedIds as number[]).length);
    expect(open.map((issue) => issue.id)).toEqual((want.openIds as number[]).map(String));
  });

  test("reports the title conflicts and the progress text", async () => {
    const want = expected("cafe-shaped");
    const path = copy("cafe-shaped.md");
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.stdout).toContain(`open-title-conflict x${(want.openTitleConflictIds as number[]).length}`);
    expect(result.stdout).toContain(`progress-text x${(want.progressIds as number[]).length}`);
    expect(result.stdout).toContain(`closed-with-body x${(want.closedIdsWithBody as number[]).length}`);
    expect(result.stdout).toContain(`closed-title-conflict x${(want.closedTitleConflictIds as number[]).length}`);
  });

  test("merges the second closed table instead of duplicating rows", async () => {
    const { closed } = await adoptAndCheck("cafe-shaped.md");
    expect(new Set(closed.map((issue) => issue.id)).size).toBe(closed.length);
  });

  test("--dry-run writes nothing", async () => {
    const path = copy("cafe-shaped.md");
    const before = readFileSync(path);
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(readFileSync(path)).toEqual(before);
  });

  test("--report writes the decision list to a file", async () => {
    const path = copy("cafe-shaped.md");
    const report = join(dir, "decisions.md");
    expect((await run(["adopt", path, "--dry-run", "--report", report])).code).toBe(0);
    const text = readFileSync(report, "utf8");
    expect(text).toContain("open-title-conflict");
    expect(text).toContain("将按默认处理、请复核的决定");
    expect(text).toContain("原样保留的内容");
  });
});

describe("adopt: orca layout", () => {
  test("strips counts, adds separators, and lands every id", async () => {
    const want = expected("orca-shaped");
    const { counts, result } = await adoptAndCheck("orca-shaped.md");
    expect(counts.open).toBe((want.openIds as number[]).length);
    expect(counts.closed).toBe((want.closedIds as number[]).length);
    expect(result.stdout).toContain(`去掉标题里的（N）计数：${want.countHeadings} 处`);
    expect(result.stdout).toContain(`补表格分隔行：${want.missingSeparatorBlocks} 处`);
  });

  test("keeps a multi-id row intact and flags it", async () => {
    const { result, closed } = await adoptAndCheck("orca-shaped.md");
    expect(result.stdout).toContain("一格多号");
    // The row's two ids are spelled `1, 20` by every read view.
    expect(closed.some((issue) => issue.id === "1, 20")).toBe(true);
  });
});

describe("adopt: guards", () => {
  test("an already-canonical ledger needs no semantic decisions", async () => {
    const path = copy("canonical-clean.md");
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(0);
    // A check-clean ledger is left alone entirely (dogfood #12).
    expect(result.stdout).toContain("已是规范台账");
    expect(result.stdout).toContain("(no changes)");
    expect(result.stdout).not.toContain("open-title-conflict");
    expect(result.stdout).not.toContain("closed-with-body");
    expect(result.stdout).not.toContain("progress-text");
  });

  test("a ledger with no recognizable table is refused with exit 3", async () => {
    const path = join(dir, "nothing.md");
    writeFileSync(path, "# Nothing\n\njust prose\n");
    const before = readFileSync(path);
    const result = await run(["adopt", path]);
    expect(result.code).toBe(3);
    expect(readFileSync(path)).toEqual(before);
  });

  test("a missing file is a usage error", async () => {
    expect((await run(["adopt", join(dir, "nope.md")])).code).toBe(2);
  });
});
describe("adopt: regressions found in review", () => {
  test("a table quoted inside a fence never becomes a row", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("## 附录", "## 附录\n\n```md\n| 99 | Fake | yes |\n```"));
    expect((await run(["adopt", path])).code).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after).not.toContain("Issue 99");
    expect(after).toContain("| 99 | Fake | yes |");
  });

  test("an unknown status is named in the report", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("| 3 | 部分解决 | P2 | 导出 CSV 丢空行 |", "| 3 | 拼错的状态 | P2 | 导出 CSV 丢空行 |"));
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.stdout).toContain("unknown-status x1");
    expect(result.stdout).toContain("拼错的状态");
  });

  test("`2` and `2a` keep their own bodies", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace("| 3 | 部分解决 | P2 | 导出 CSV 丢空行 |", "| 3 | 部分解决 | P2 | 导出 CSV 丢空行 |\n| 3a | 观察 | P2 | 后缀测试 |")
      .replace("### Issue 3: 导出 CSV 丢空行", "### Issue 3: 导出 CSV 丢空行\n\n**现象**：原三号。\n\n### Issue 3a: 后缀测试\n\n**现象**：三号后缀。"));
    expect((await run(["adopt", path])).code).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("### Issue 3: 导出 CSV 丢空行\n\n**现象**：原三号。");
    expect(after).toContain("### Issue 3a: 后缀测试\n\n**现象**：三号后缀。");
  });

  test("contradictory duplicate statuses are reported, not silently merged", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace("| 1 | 已修 | P3 | 登录页闪烁 | `a1b2c3d`：连续 3 轮 12/12 |",
               "| 1 | 已修 | P3 | 登录页闪烁 | `a1b2c3d`：连续 3 轮 12/12 |\n| 1 | 未决 | P3 | 登录页闪烁 | |"));
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.stdout).toContain("两处状态矛盾");
  });

  test("an id covered by a retired range is flagged before check refuses", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace("| 7–20 | 撤回 | | 无记录 | 早期关闭，编号已退休 |",
               "| 7–20 | 撤回 | | 无记录 | 早期关闭，编号已退休 |\n| 8 | 已修 | P3 | 八号 | 旧记录 |"));
    // The conversion is refused (E103), so the report arrives on stderr — it
    // must still name the cause rather than a bare check dump.
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("已被区间 7–20 覆盖");
  });

  test("report line numbers point into the converted output", async () => {
    const path = copy("cafe-shaped.md");
    const result = await run(["adopt", path, "--dry-run"]);
    const match = /L(\d+) #1 表格摘要与正文标题不一致/.exec(result.stdout);
    expect(match).not.toBeNull();
    // The converted document is what `--report` describes; convert and look.
    await run(["adopt", path]);
    const line = Number(match![1]!);
    expect(readFileSync(path, "utf8").split("\n")[line - 1]).toContain("### Issue 1:");
  });
});

describe("adopt: third review round", () => {
  function custom(body: string): string {
    const path = join(dir, `custom-${counter++}.md`);
    writeFileSync(path, body);
    return path;
  }
  const after = (path: string) => readFileSync(path, "utf8");

  test("a pipe table inside an issue body is content, not issue rows", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(
      "### Issue 2: 侧栏宽度不可调\n\n**现象**",
      "### Issue 2: 侧栏宽度不可调\n\n| 步骤 | 输入 | 结果 |\n|---|---|---|\n| 5 | 空行 | 丢失 |\n\n**现象**",
    ));
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(after(path)).not.toContain("Issue 5");
    expect(after(path)).toContain("| 5 | 空行 | 丢失 |");
  });

  test("an unrecognized top-level section survives the conversion", async () => {
    const path = copy("cafe-shaped.md");
    expect((await run(["adopt", path])).code).toBe(0);
    expect(after(path)).toContain("复核记录");
    expect(after(path)).toContain("此节包含独立于条目的复核记录");
  });

  test("a multi-id row keeps its existing body instead of dropping it", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace("| 4 | 观察 | P3 | 长列表滚动掉帧 |", "| 4, 24 | 已修 | P3 | 合并行 | 判据 |")
      .replace("### Issue 4: 长列表滚动掉帧", "### Issue 4: 合并行"));
    // Move the row from 索引 to 已关闭 so the ledger is valid (an open
    // multi-id row would need a body per id).
    const source = readFileSync(path, "utf8");
    const moved = source.replace("| 4, 24 | 已修 | P3 | 合并行 | 判据 |\n", "")
      .replace("| 7–20 | 撤回 | | 无记录 | 早期关闭，编号已退休 |",
        "| 4, 24 | 已修 | P3 | 合并行 | 判据 |\n| 7–20 | 撤回 | | 无记录 | 早期关闭，编号已退休 |");
    writeFileSync(path, moved);
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("orphan-body");
    const out = after(path);
    expect(out).toContain("| 4, 24 |");
    // The body that used to hang on #4 is preserved, not dropped.
    expect(out).toContain("### #4 合并行（adopt 保留的孤立正文）");
    expect(out).toContain("**现象**：2000 行列表滚动时降至 20fps。");
  });

  test("a row with no status word is assumed, and the assumption is reported", async () => {
    const path = custom([
      "# T",
      "",
      "## 状态口径",
      "",
      "| 状态 | 分类 |",
      "|---|---|",
      "| 未决 | open |",
      "| 已修 | closed |",
      "",
      "## 已关闭",
      "",
      "| # | 摘要 | 判据 |",
      "|---|---|---|",
      "| 30 | 没有状态词 | 判据 |",
    ].join("\n"));
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("unknown-status x1");
    expect(result.stdout).toContain("#30");
    expect(result.stdout).toContain("已修");
  });

  test("refuses to archive a closed body that ends inside a code fence", async () => {
    const path = copy("cafe-shaped.md");
    const source = readFileSync(path, "utf8").replace(
      "### Issue 4: 工作项 4\n\n#### 验收判据",
      "### Issue 4: 工作项 4\n\n```html" + String.fromCharCode(0x2028) + "info\nunclosed fence\n\n#### 验收判据",
    );
    writeFileSync(path, source);
    const before = readFileSync(path, "utf8");

    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("unclosed code fence");
    expect(result.stdout).toBe("");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refuses to append archives inside an unclosed appendix fence", async () => {
    const path = copy("cafe-shaped.md");
    const source = `${readFileSync(path, "utf8").trimEnd()}\n\n## 附录\n\n~~~html\nunclosed appendix fence\n`;
    writeFileSync(path, source);
    const before = readFileSync(path, "utf8");

    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("unclosed code fence");
    expect(result.stdout).toBe("");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("an archived closed body keeps its blank lines and fences", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace("### Issue 2: 侧栏宽度不可调", "### Issue 1: 登录页闪烁\n\n```\nline1\n\nline3\n```\n\n**验收判据**：见上\n\n### Issue 2: 侧栏宽度不可调"));
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    const out = after(path);
    expect(out).toContain("```\nline1\n\nline3\n```");
    expect(out).toContain("<!-- issuemd:kept-body:start -->");
    expect((await run(["check", path])).code).toBe(0);
  });

  test("adopt keeps an archive marker inside a list-nested fence as body text", async () => {
    const path = copy("cafe-shaped.md");
    const marker = "<!-- issuemd:kept-body:start -->";
    const source = readFileSync(path, "utf8").replace(
      "#### 验收判据\n\n示例用例 4 给出预期结果。",
      `#### 验收判据\n\n示例用例 4 给出预期结果。\n\n100. Marker example\n\n     ~~~html\n     ${marker}\n     ~~~`,
    );
    writeFileSync(path, source);

    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(readFileSync(path, "utf8")).toContain(marker);
    expect((await run(["check", path])).code).toBe(0);
  });

  test("adopt handles U+2028 inside an issue heading title", async () => {
    const path = copy("canonical-clean.md");
    const summary = `侧栏${String.fromCharCode(0x2028)}宽度不可调`;
    const source = readFileSync(path, "utf8")
      .replace("## 索引", "## 待处理")
      .replaceAll("侧栏宽度不可调", summary)
      .replace("**验收判据**：重启后保持上次宽度。", "#### 验收判据\n\n重启后保持上次宽度。");
    writeFileSync(path, source);

    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect((await run(["check", path])).code).toBe(0);
    const shown = JSON.parse((await run(["show", path, "2", "--json"])).stdout);
    expect(shown.summary).toBe(summary);
    expect(shown.body.text).toContain("**根因**：宽度写死在 CSS 变量。");
  });

  test("no-op adopt refuses a reserved marker in an open issue body", async () => {
    const path = copy("canonical-clean.md");
    const marker = "<!-- issuemd:kept-body:start -->";
    const source = readFileSync(path, "utf8")
      .replace("**现象**：侧栏固定 240px，无法拖拽。", `**现象**：侧栏固定 240px，无法拖拽。\n\n${marker}`);
    writeFileSync(path, source);
    const before = readFileSync(path, "utf8");

    const result = await run(["adopt", path]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(marker);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refuses to adopt an open body containing a reserved archive marker", async () => {
    const path = copy("canonical-clean.md");
    const marker = "<!-- issuemd:kept-body:start -->";
    const source = readFileSync(path, "utf8")
      .replace("## 索引", "## 待处理")
      .replace("**现象**：侧栏固定 240px，无法拖拽。", `**现象**：侧栏固定 240px，无法拖拽。\n\n${marker}`);
    writeFileSync(path, source);
    const before = readFileSync(path, "utf8");

    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(marker);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("2 and 2a are ordered by suffix, not only by number", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2a | 未决 | P2 | 后缀在先 |\n| 2 | 未决 | P1 | 侧栏宽度不可调 |")
      .replace("### Issue 2: 侧栏宽度不可调", "### Issue 2a: 后缀在先\n\n**现象**：后缀。\n\n### Issue 2: 侧栏宽度不可调"));
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    const out = after(path);
    expect(out.indexOf("### Issue 2:")).toBeLessThan(out.indexOf("### Issue 2a:"));
  });

  test("a **状态** label in a body is removed and reported", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace("**现象**：侧栏固定 240px，无法拖拽。", "**状态**：未决\n**现象**：侧栏固定 240px，无法拖拽。"));
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("status-in-body");
    await run(["adopt", path]);
    expect(after(path)).not.toContain("**状态**：");
  });

  test("a suffixed id is not reported as covered by a numeric range", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace("| 4 | 观察 | P3 | 长列表滚动掉帧 |", "| 8a | 观察 | P3 | 后缀八 |\n| 4 | 观察 | P3 | 长列表滚动掉帧 |")
      .replace("### Issue 4: 长列表滚动掉帧", "### Issue 8a: 后缀八\n\n**现象**：八甲。\n\n### Issue 4: 长列表滚动掉帧"));
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.stdout).not.toContain("8a 已被区间");
  });

  test("demoting #### keeps a trailing C# intact", async () => {
    const path = copy("cafe-shaped.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("#### 现象", "#### Use C#"));
    expect((await run(["adopt", path])).code).toBe(0);
    expect(after(path)).toContain("**Use C#**");
  });
});

describe("adopt: third review round, part two", () => {
  function custom(body: string): string {
    const path = join(dir, `custom2-${counter++}.md`);
    writeFileSync(path, body);
    return path;
  }
  const after = (path: string) => readFileSync(path, "utf8");

  test("prose in a section whose title only looks like a table section survives", async () => {
    const path = custom([
      "# Legacy",
      "",
      "## Issues",
      "",
      "| # | 状态 | 摘要 |",
      "|---|---|---|",
      "| 1 | 未决 | Alpha |",
      "",
      "## Open questions",
      "",
      "Should the build cache be shared?",
      "",
      "## 正文",
      "",
      "### Issue 1: Alpha",
      "",
      "**现象**：x。",
    ].join("\n"));
    expect((await run(["adopt", path])).code).toBe(0);
    expect(after(path)).toContain("Should the build cache be shared?");
    expect(after(path)).toContain("| 1 | 未决 |  | Alpha |");
  });

  test("front matter before the H1 and an extra H1 section survive", async () => {
    const path = custom([
      "---",
      "owner: team",
      "---",
      "# Legacy",
      "",
      "## 索引",
      "",
      "| # | 状态 | 摘要 |",
      "|---|---|---|",
      "| 1 | 未决 | Alpha |",
      "",
      "# Archive",
      "",
      "Old notes live here.",
      "",
      "## 正文",
      "",
      "### Issue 1: Alpha",
      "",
      "**现象**：x。",
    ].join("\n"));
    expect((await run(["adopt", path])).code).toBe(0);
    const out = after(path);
    expect(out).toContain("owner: team");
    expect(out).toContain("Old notes live here.");
    expect((await run(["check", path])).code).toBe(0);
  });

  test("prose and non-Issue headings inside 正文 survive", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace("## 正文\n\n", "## 正文\n\n介绍段落。\n\n### 背景\n\n背景说明。\n\n"));
    expect((await run(["adopt", path])).code).toBe(0);
    const out = after(path);
    expect(out).toContain("介绍段落。");
    expect(out).toContain("背景说明。");
    expect((await run(["check", path])).code).toBe(0);
  });

  test("an Issue heading inside a preserved section is neutralised, not refused", async () => {
    const path = copy("canonical-clean.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(
      "## 附录",
      "## Design notes\n\n### Issue 9: example in notes\n\nSome example.\n\n## 附录",
    ));
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    const out = after(path);
    expect(out).toContain("\\### Issue 9: example in notes");
    // The example body is copied exactly once.
    expect(out.match(/Some example\./g)?.length).toBe(1);
    expect((await run(["check", path])).code).toBe(0);
  });

  test("preserved sections come after the archived bodies, so they cannot swallow them", async () => {
    const path = copy("cafe-shaped.md");
    expect((await run(["adopt", path])).code).toBe(0);
    const out = after(path);
    expect(out.indexOf("### #4 ")).toBeLessThan(out.indexOf("## 复核记录"));
  });

  test("orphan-body and preamble decisions point at real output lines", async () => {
    const path = custom([
      "Intro paragraph.",
      "# Legacy",
      "",
      "## 索引",
      "",
      "| # | 状态 | 摘要 |",
      "|---|---|---|",
      "| 1 | 未决 | Alpha |",
      "",
      "## 正文",
      "",
      "### Issue 1: Alpha",
      "",
      "**现象**：x。",
      "",
      "### Issue 40: orphan",
      "",
      "Orphan text.",
    ].join("\n"));
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/L0 #40/);
    expect(result.stdout).not.toMatch(/L0 标题/);
    expect(result.stdout).toMatch(/L\d+ #40/);
  });
});
