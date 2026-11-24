import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";

const fixture = new URL("../fixtures/canonical-clean.md", import.meta.url);
const canonical = readFileSync(fixture, "utf8");
const bin = fileURLToPath(new URL("../dist/bin/issuemd.js", import.meta.url));

type Diagnostic = { code: string; line: number; id?: string };
function check(source: string, ...args: string[]) {
  const result = spawnSync("node", [bin, "check", "-", "--json", ...args], {
    input: source, encoding: "utf8", timeout: 5000,
  });
  expect(result.stderr).toBe("");
  return { code: result.status, report: JSON.parse(result.stdout) as {
    ok: boolean;
    counts: { open: number; closed: number; byStatus: Record<string, number> };
    errors: Diagnostic[];
    warnings: Diagnostic[];
  } };
}

const lineOf = (source: string, start: string) => source.split("\n").findIndex((line) => line.startsWith(start)) + 1;

describe("issuemd check", () => {
  test("reports the canonical fixture's counts via the normal file entry point", async () => {
    const result = await run(["check", fileURLToPath(fixture), "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const expected = JSON.parse(readFileSync(new URL("../fixtures/canonical-clean.expected.json", import.meta.url), "utf8"));
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, counts: expected.counts, errors: [] });
  });

  test("ordinary Markdown and old layouts report an unrecognized ledger", () => {
    for (const name of ["cafe-shaped.md", "orca-shaped.md"]) {
      const { code, report } = check(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
      expect(code).toBe(3);
      expect(report.ok).toBe(false);
      expect(report.errors).toContainEqual(expect.objectContaining({ code: "E120", line: 1 }));
    }
  });

  test("names each of 13 closed IDs that still has a body", () => {
    const ids = Array.from({ length: 13 }, (_, index) => index + 21);
    const bodies = ids.map((id) => `### Issue ${id}: Retained body\n\nExample detail.\n\n`).join("");
    const source = canonical.replace("\n\n## 正文", "\n| 21–33 | 已修 | | Historical work | Closed |\n\n## 正文")
      .replace("## 附录", bodies + "## 附录");
    const { code, report } = check(source);
    expect(code).toBe(3);
    expect(report.errors.map(({ code, line, id }) => ({ code, line, id }))).toEqual(ids.map((id) => ({
      code: "E111", line: lineOf(source, `### Issue ${id}:`), id: String(id),
    })));
  });

  test("handles escaped pipes and fence content without changing 1-based line numbers", () => {
    const source = canonical.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | Sample \\| title |")
      .replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: Sample | title")
      .replace("**现象**：侧栏固定 240px，无法拖拽。", "```md\n```still-code\n## 索引\n| not a table |\n**状态**：example\n```")
      .replace("### Issue 3: 导出 CSV 丢空行", "### Issue 3: Wrong title");
    const { code, report } = check("﻿" + source.replaceAll("\n", "\r\n"));
    expect(code).toBe(3);
    expect(report.errors).toEqual([expect.objectContaining({
      code: "E106", id: "3", line: lineOf(source, "### Issue 3:"),
    })]);
  });

  test("does not drop the first data row from a headerless block", () => {
    const source = canonical.replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n", "")
      .replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: Wrong title");
    const { report } = check(source);
    expect(report.counts.open).toBe(3);
    expect(report.errors.map((item) => item.code).sort()).toEqual(["E106", "E122"]);
  });

  test("rejects partially parsed IDs and reports duplicate and overlapping intervals", () => {
    const source = canonical.replace("| 3 | 部分解决", "| 3, junk4 | 部分解决")
      .replace("| 7–20 |", "| 4, 7–20, 8, 900b |")
      .replace("| 6 | 并入", "| 6, 900b | 并入");
    const { report } = check(source);
    expect(report.errors.map((item) => item.code)).toEqual(expect.arrayContaining(["E109", "E103", "E104"]));
    expect(report.errors.filter((item) => item.code === "E103").map((item) => item.id).sort()).toEqual(["8", "900b"]);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: "E104", id: "4" }));
  });

  test("counts a large retired interval without enumerating its IDs", () => {
    const { code, report } = check(canonical.replace("7–20", "7–1000000000"));
    expect(code).toBe(0);
    expect(report.counts.closed).toBe(999999997);
  });

  test("recognizes body structure, status declaration changes and stray issue headings", () => {
    const source = canonical.replace("| 观察 | open |", "| 观察 | closed |")
      .replace("**现象**：侧栏固定 240px，无法拖拽。", "**状态**：未决\n\n#### Unexpected")
      .replace("### 2026-11-20 复核记录", "### Issue 99: Unexpected");
    const { report } = check(source);
    expect(report.errors.map(({ code }) => code).sort()).toEqual(["E107", "E110", "E112", "E123"]);
  });

  test("flags Setext headings but permits a horizontal rule separated by a blank line", () => {
    const withHeading = canonical.replace("**根因**：宽度写死在 CSS 变量。", "原因\n----");
    const withRule = withHeading.replace("原因\n----", "原因\n\n----");
    expect(check(withHeading).report.errors).toContainEqual(expect.objectContaining({
      code: "E110", line: lineOf(withHeading, "原因"),
    }));
    expect(check(withRule).report.errors).toEqual([]);
  });

  test("warns W250 when 附录 holds a body archived by close --keep-body", () => {
    const source = canonical.replace(
      "### 2026-11-20 复核记录",
      "### #1 登录页闪烁（已关闭，正文保留）\n\n> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。\n\n**现象**：保留的正文。\n\n### 2026-11-20 复核记录",
    );
    const { code, report } = check(source);
    expect(code).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "W250", id: "1", line: lineOf(source, "### #1 登录页闪烁"),
    }));
  });

  test("a fenced lookalike of the archive heading is not W250", () => {
    const source = canonical.replace(
      "### 2026-11-20 复核记录",
      "```md\n### #1 登录页闪烁（已关闭，正文保留）\n```\n\n### 2026-11-20 复核记录",
    );
    const { report } = check(source);
    expect(report.warnings).not.toContainEqual(expect.objectContaining({ code: "W250" }));
  });

  test("W250 is informational and does not fail --strict", () => {
    // `--keep-body` is the escape hatch spec §7.5 recommends; a ledger that
    // used it must not stay permanently red under `check --strict`.
    // Strip the fixture's pinned hash so W250 is the only warning left.
    const source = canonical
      .replace("`a1b2c3d`：连续 3 轮 12/12", "连续 3 轮 12/12")
      .replace(
        "### 2026-11-20 复核记录",
        "### #1 登录页闪烁（已关闭，正文保留）\n\n> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。\n\n### 2026-11-20 复核记录",
      );
    const strict = check(source, "--strict");
    expect(strict.code).toBe(0);
    expect(strict.report.warnings).toContainEqual(expect.objectContaining({ code: "W250" }));
  });

  test("requires the ledger H1 and both guide markers", () => {
    for (const source of [canonical.replace(/^# .*\n/, ""), canonical.replace(/^<!-- issuemd:guide:begin -->\n/m, "")]) {
      expect(check(source).report.errors).toContainEqual(expect.objectContaining({ code: "E112" }));
    }
  });

  test("rejects a count that cannot be represented exactly as a JSON number", () => {
    const { code, report } = check(canonical.replace("7–20", "7–9007199254740991, 7a, 8a, 9a, 10a, 11a"));
    expect(code).toBe(3);
    expect(report.counts.closed).toBeNull();
    expect(report.errors).toContainEqual(expect.objectContaining({ code: "E109" }));
  });

  test("groups human-readable diagnostics and keeps individual details in JSON", async () => {
    const source = canonical.replace(/^(### Issue \d+: ).+$/gm, "$1Wrong");
    const result = spawnSync("node", [bin, "check", "-"], { input: source, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("open 3 (未决 1, 部分解决 1, 观察 1)   closed 17");
    expect(result.stdout).toContain("error E106 x3");
    expect(check(source).report.errors).toHaveLength(3);
  });

  test("strict mode makes warnings affect status without changing their category", () => {
    const source = canonical.replace("并入 #3", "并入 #999");
    const normal = check(source);
    const strict = check(source, "--strict");
    expect(normal.code).toBe(0);
    expect(strict.code).toBe(3);
    expect(strict.report.ok).toBe(false);
    expect(strict.report.errors).toEqual([]);
    expect(strict.report.warnings).toContainEqual(expect.objectContaining({ code: "W210", id: "6" }));
  });

  test("W220 fires for a status word outside the vocabulary", () => {
    const source = canonical.replace("| 4 | 观察 | P3 |", "| 4 | 未觉 | P3 |");
    const { report } = check(source);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W220", id: "4" }));
    expect(report.errors).toEqual([]);
  });

  test("W260 fires for progress text in an open summary", () => {
    const source = canonical.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 侧栏宽度仍缺记忆 |");
    const { report } = check(source);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W260", id: "2" }));
  });

  test("W206 fires for a duplicated body label", () => {
    const source = canonical.replace(
      "**现象**：侧栏固定 240px，无法拖拽。",
      "**现象**：侧栏固定 240px，无法拖拽。\n**现象**：重复的标签。",
    );
    const { report } = check(source);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W206", id: "2" }));
  });

  test("W203 fires when the guide names a heading that is missing", () => {
    const source = canonical.replace("`issuemd list FILE`", "`## 不存在的标题`");
    const { report } = check(source);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W203" }));
  });

  test("W202 fires for a short pinned hash and W240 for a missing commit with --verify-commits", () => {
    const verified = check(canonical, "--verify-commits");
    expect(verified.report.warnings).toContainEqual(expect.objectContaining({ code: "W202" }));
    // a1b2c3d is a synthetic hash that does not exist in this repo.
    expect(verified.report.warnings).toContainEqual(expect.objectContaining({ code: "W240" }));
  });

  test("W201 fires for a body over 300 lines", () => {
    const filler = Array.from({ length: 320 }, () => "补充说明。").join("\n");
    const source = canonical.replace("**验收判据**：重启后保持上次宽度。", `**验收判据**：重启后保持上次宽度。\n${filler}`);
    const { report } = check(source);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W201", id: "2" }));
    expect(report.errors).toEqual([]);
  });
});

describe("third review round", () => {
  test("a thematic break after a list continuation is not a Setext heading", () => {
    const source = canonical.replace("**根因**：宽度写死在 CSS 变量。", "- 项一\n  续行\n---");
    expect(check(source).report.errors).toEqual([]);
  });

  test("W202 ignores a plain number, such as a date", () => {
    const source = canonical.replace("### 2026-11-20 复核记录", "### 20261124 复核记录");
    const warnings = check(source).report.warnings.filter((warning) =>
      (warning as { message?: string }).message?.includes("20261124"));
    expect(warnings).toEqual([]);
  });

  test("a lone prose line that starts with a pipe is not a table", () => {
    const source = canonical.replace("**根因**：宽度写死在 CSS 变量。", "| 符号表示绝对值，这是一句普通段落。");
    expect(check(source).report.errors).toEqual([]);
  });
});

describe("fourth review round", () => {
  test("an indented Setext heading that starts a paragraph is still flagged", () => {
    const source = canonical.replace("**根因**：宽度写死在 CSS 变量。", "说明：\n\n  Indented setext\n  ---");
    expect(check(source).report.errors).toContainEqual(expect.objectContaining({ code: "E110" }));
  });

  test("W202 ignores a millisecond timestamp", () => {
    const source = canonical.replace("### 2026-11-20 复核记录", "### 1732406400000 复核记录");
    const warnings = check(source).report.warnings.filter((warning) =>
      (warning as { message?: string }).message?.includes("1732406400000"));
    expect(warnings).toEqual([]);
  });
});
