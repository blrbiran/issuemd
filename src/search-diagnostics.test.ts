import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const tempDir = mkdtempSync(join(tmpdir(), "issuemd-search-diagnostics-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let counter = 0;
function ledger(content = canonical): string {
  const path = join(tempDir, `ledger-${counter++}.md`);
  writeFileSync(path, content);
  return path;
}
const text = (path: string) => readFileSync(path, "utf8");

test("sync --fix-hashes reports stable counts for empty and fully repaired candidates", async () => {
  const empty = ledger();
  const emptyResult = await run(["sync", empty, "--fix-hashes", "--require-complete"]);
  expect(emptyResult.code).toBe(0);
  expect(emptyResult.stderr).toContain("W202: wrapped 0, skipped 0, remaining 0");

  const source = canonical.replace("**现象**：侧栏固定 240px，无法拖拽。", "**现象**：pinned deadbee1");
  const repair = ledger(source);
  const preview = await run(["sync", repair, "--fix-hashes", "--require-complete", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stderr).toContain("W202: wrapped 1, skipped 0, remaining 0");
  expect(text(repair)).toBe(source);
  const applied = await run(["sync", repair, "--fix-hashes", "--require-complete"]);
  expect(applied.code).toBe(0);
  expect(applied.stderr).toContain("W202: wrapped 1, skipped 0, remaining 0");
  expect(text(repair)).toContain("pinned `deadbee1`");
});

test("--require-complete refuses an incomplete preview and write before changing bytes", async () => {
  const source = canonical
    .replace("**现象**：侧栏固定 240px，无法拖拽。", "**现象**：pinned deadbee1")
    .replace("**根因**：宽度写死在 CSS 变量。", "**根因**：宽度写死在 CSS 变量。\n\n**说明**：unmatched ` deadbee2");
  const path = ledger(source);
  const before = readFileSync(path);
  const preview = await run(["sync", path, "--fix-hashes", "--require-complete", "--dry-run"]);
  expect(preview.code).toBe(3);
  expect(preview.stdout).toBe("");
  expect(preview.stderr).toContain("W202: wrapped 1, skipped 1, remaining 1");
  expect(readFileSync(path)).toEqual(before);

  const applied = await run(["sync", path, "--fix-hashes", "--require-complete"]);
  expect(applied.code).toBe(3);
  expect(applied.stderr).toContain("W202: wrapped 1, skipped 1, remaining 1");
  expect(applied.stderr).toContain("would wrap W202");
  expect(applied.stderr).toContain("unmatched inline-code delimiter");
  expect(readFileSync(path)).toEqual(before);

  const bestEffort = await run(["sync", path, "--fix-hashes"]);
  expect(bestEffort.code).toBe(0);
  expect(bestEffort.stderr).toContain("W202: wrapped 1, skipped 1, remaining 1");
  expect(text(path)).toContain("pinned `deadbee1`");
});

test("--require-complete is only valid with --fix-hashes", async () => {
  const path = ledger();
  expect((await run(["sync", path, "--titles", "--require-complete"])).code).toBe(2);
});

test("W260 ignores quoted progress phrases and reports a real cue and decoded column", async () => {
  const quoted = ledger(canonical.replace(
    "| 2 | 未决 | P1 | 侧栏宽度不可调 |",
    "| 2 | 未决 | P1 | 示例“仍缺现场验证”说明宽度问题 |",
  ));
  const quotedCheck = JSON.parse((await run(["check", quoted, "--json"])).stdout);
  expect(quotedCheck.warnings.filter((warning: { code: string }) => warning.code === "W260")).toHaveLength(0);

  const source = canonical.replace(
    "| 2 | 未决 | P1 | 侧栏宽度不可调 |",
    "| 2 | 未决 | P1 | 宽度问题\\|仍缺现场验证 |",
  );
  const path = ledger(source);
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  const warning = report.warnings.find((item: { code: string }) => item.code === "W260");
  expect(warning).toMatchObject({ id: "2", cue: "仍缺现场验证", column: 6 });
});

test("sync --titles --prefer table shares the W260 exclusion for literal examples", async () => {
  const path = ledger(canonical.replace(
    "| 2 | 未决 | P1 | 侧栏宽度不可调 |",
    "| 2 | 未决 | P1 | 示例 `仍缺现场验证` 的渲染 |",
  ));
  const result = await run(["sync", path, "--titles", "--prefer", "table"]);
  expect(result.code).toBe(0);
  expect(text(path)).toContain("### Issue 2: 示例 `仍缺现场验证` 的渲染");
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(report.warnings.filter((warning: { code: string }) => warning.code === "W260")).toHaveLength(0);
});

test("W260 keeps detecting progress after an ordinary apostrophe", async () => {
  const path = ledger(canonical.replace(
    "| 2 | 未决 | P1 | 侧栏宽度不可调 |",
    "| 2 | 未决 | P1 | User's sidebar，仍缺现场验证 |",
  ));
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W260", cue: "仍缺现场验证" }));
});

test("W260 preserves explicit progress title migration cues and rejects bare incidental substrings", async () => {
  for (const summary of ["已修，待现场复核", "本轮已落地", "仍缺现场验证"]) {
    const path = ledger(canonical.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", `| 2 | 未决 | P1 | ${summary} |`));
    const report = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W260", id: "2" }));
  }
  for (const summary of ["仍无障碍", "仍走原流程", "仍逐项记录"]) {
    const path = ledger(canonical.replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", `| 2 | 未决 | P1 | ${summary} |`));
    const report = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(report.warnings.filter((warning: { code: string }) => warning.code === "W260")).toHaveLength(0);
  }
});

test("sync --titles --move-progress points unchanged W260 summaries to reviewed rename and body update", async () => {
  const path = ledger(canonical
    .replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 本轮已落地 |")
    .replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: 本轮已落地"));
  const before = readFileSync(path);
  const result = await run(["sync", path, "--titles", "--move-progress"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("(no changes)\n");
  expect(result.stderr).toContain("#2");
  expect(result.stderr).toContain("rename");
  expect(result.stderr).toContain("body");
  expect(readFileSync(path)).toEqual(before);
});

test("title sync reports progress it cannot move alongside a successful migration", async () => {
  const path = ledger(canonical
    .replaceAll("侧栏宽度不可调", "本轮已落地")
    .replace("| 3 | 部分解决 | P2 | 导出 CSV 丢空行 |", "| 3 | 部分解决 | P2 | 导出 CSV 丢空行，仍缺现场验证 |"));
  const result = await run(["sync", path, "--titles", "--prefer", "body", "--move-progress"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("#2 still has W260");
  expect(text(path)).toContain("> **进展（来自旧表）**：导出 CSV 丢空行，仍缺现场验证");
});
