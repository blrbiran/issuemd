import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";
import * as ledger from "./ledger.js";
import { checkParsedLedger } from "./ledger-check.js";

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-round15-"));

test("validation reports cannot mutate parse diagnostics on a shared snapshot", () => {
  const parsed = ledger.parseLedger("# Missing ledger sections\n");
  const report = checkParsedLedger(parsed, "broken.md");
  expect(report.errors[0]?.code).toBe("E120");
  report.errors[0]!.code = "E106";
  expect(parsed.errors[0]?.code).toBe("E120");
  expect(checkParsedLedger(parsed, "broken.md").errors[0]?.code).toBe("E120");
});

test.each(["list", "counts", "show"])("%s derives its diagnostics from one parse", async (command) => {
  const file = join(dir, `${command}.md`);
  writeFileSync(file, canonical.replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: 摘要不一致"));
  const parse = spyOn(ledger, "parseLedger");
  try {
    const result = await run([command, file, ...(command === "show" ? ["2"] : []), "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).diagnostics.errors).toEqual([expect.objectContaining({ code: "E106", id: "2" })]);
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("an indented code example does not hide subsequent body labels", async () => {
  const file = join(dir, "indent.md");
  writeFileSync(file, canonical.replace("**根因**", "\t```\n\tnpm test\n\n**根因**"));
  const show = await run(["show", file, "2", "--json"]);
  const issue = JSON.parse(show.stdout);
  expect(Object.keys(issue.labels)).toEqual(["现象", "根因", "期望", "验收判据"]);
  expect(issue.criteria).toBe("重启后保持上次宽度。");
  expect((await run(["check", file, "--strict"])).code).toBe(0);
  expect((await run(["close", file, "2", "--criteria-from-body", "--dry-run"])).code).toBe(0);
});

test.each(["验收判据（复测用）", "追加判据", "判据 / 建议"])("reports a near-match criteria label %s at its line", async (label) => {
  const file = join(dir, `${label.replaceAll("/", "-")}.md`);
  const source = canonical.replace("**验收判据**", `**${label}**`);
  writeFileSync(file, source);
  const line = source.split("\n").findIndex((text) => text.startsWith(`**${label}**`)) + 1;
  const checked = await run(["check", file, "--json"]);
  const warning = JSON.parse(checked.stdout).warnings.find(({ code }: { code: string }) => code === "W261");
  expect(warning.line).toBe(line);
  expect(warning.message).toContain(`**${label}**`);
  for (const extra of [[], ["--criteria-from-body"]]) {
    const close = await run(["close", file, "2", "--dry-run", ...extra]);
    expect(close.code).toBe(2);
    expect(close.stderr).toContain(`**${label}**`);
    expect(close.stderr).toContain(`L${line}`);
  }
});

test.each(["\t", "    ", "   ", "  ", " "])("new and body labels agree about an unclosed fence after indent %j", async (indent) => {
  const file = join(dir, `fence-${indent.length}.md`);
  const input = join(dir, `body-${indent.length}.txt`);
  writeFileSync(file, canonical);
  writeFileSync(input, `**现象**：例子\n\n${indent}\`\`\`\n${indent}npm test\n\n**验收判据**：可复现\n`);
  const result = await run(["new", file, "--title", "新条目", "--body-file", input]);
  if (indent === "\t" || indent.length > 3) {
    expect(result.code).toBe(0);
    const data = JSON.parse((await run(["show", file, result.stdout.trim(), "--json"])).stdout);
    expect(data.labels["验收判据"]).toBe("可复现");
    expect(data.criteria).toBe("可复现");
    expect((await run(["check", file, "--strict"])).code).toBe(0);
  } else {
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unclosed");
    expect(readFileSync(file, "utf8")).toBe(canonical);
  }
});

test("a list-nested fence hides label examples at the list content margin", async () => {
  const file = join(dir, "list-fence.md");
  const source = canonical.replace("**验收判据**：重启后保持上次宽度。", [
    "- 示例：", "    ```markdown", "  **追加判据**：示例", "  **验收判据**：示例", "    ```",
  ].join("\n"));
  writeFileSync(file, source);
  const show = JSON.parse((await run(["show", file, "2", "--json"])).stdout);
  expect(Object.keys(show.labels)).toEqual(["现象", "根因", "期望"]);
  expect(show.criteria).toBeUndefined();
  expect((await run(["show", file, "2", "--json", "--label", "追加判据"])).code).toBe(1);
  const check = await run(["check", file, "--json"]);
  const warnings = JSON.parse(check.stdout).warnings;
  expect(warnings).toEqual([expect.objectContaining({ code: "W261", id: "2" })]);
  expect(warnings[0].message).not.toContain("追加判据");
  writeFileSync(file, source.replace("    ```\n", "    ```\n\n**验收判据**：真的判据\n"));
  expect((await run(["check", file, "--strict"])).code).toBe(0);
});

test("an exact criteria label takes precedence over a descriptive label", async () => {
  const file = join(dir, "exact.md");
  writeFileSync(file, canonical.replace("**验收判据**", "**追加判据**：留作建议\n**验收判据**"));
  expect((await run(["check", file, "--strict"])).code).toBe(0);
  const close = await run(["close", file, "2"]);
  expect(close.code).toBe(0);
  const issue = JSON.parse((await run(["show", file, "2", "--json"])).stdout);
  expect(issue.criteria).toBe("重启后保持上次宽度。");
});

test.each([["路线图", "ID"], ["变更记录", "#"]])("%s reserves only rows with ledger statuses", async (section, idHeader) => {
  const file = join(dir, `cited-${section}.md`);
  const source = `${canonical.trimEnd()}\n\n## ${section}\n\n| ${idHeader} | 状态 | 说明 |\n|---|---|---|\n` +
    "| 21 | 未决 | 预留 |\n| 22 | 进行中 | 路线图自己的编号 |\n| 2 | 已修 | 引用已有条目 |\n";
  writeFileSync(file, source);
  expect((await run(["check", file, "--strict"])).code).toBe(0);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows?.map(({ ids }: { ids: string[] }) => ids)).toEqual([["21"], ["2"]]);
  const explicit = await run(["new", file, "--id", "21", "--title", "撞号"]);
  expect(explicit.code).toBe(2);
  expect(explicit.stderr).toContain("reserved");
  expect(explicit.stderr).toContain(section);
  expect(readFileSync(file, "utf8")).toBe(source);
  const next = await run(["new", file, "--title", "下一个号"]);
  expect(next.code).toBe(0);
  expect(next.stdout.trim()).toBe("22");
  expect((await run(["show", file, "2", "--json"])).code).toBe(0);
});

test("a commented-out foreign table leaves the next ID available", async () => {
  const file = join(dir, "commented-table.md");
  writeFileSync(file, `${canonical.trimEnd()}\n\n## 路线图\n\n<!--\n| ID | 状态 | 说明 |\n|---|---|---|\n| 21 | 未决 | 注释中的条目 |\n-->\n`);
  const listed = JSON.parse((await run(["list", file, "--json"])).stdout);
  expect(listed.citedRows).toBeUndefined();
  const next = await run(["new", file, "--title", "下一个号"]);
  expect(next.code).toBe(0);
  expect(next.stdout.trim()).toBe("21");
});

test("split summarizes a large set of missing bodies and preserves the full E102 list", async () => {
  const file = join(dir, "split.md");
  writeFileSync(file, canonical.replace("| 4 | 观察", "| 1000–1999 | 观察").replace("### Issue 4:", "### Issue 1000:"));
  const result = await run(["split", file, "1000"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("999 ids");
  expect(result.stderr).toContain("#1001");
  expect(result.stderr).toContain("#1999");
  expect(result.stderr).toContain("997 more");
  expect(result.stderr).toContain("issuemd body");
  const lines = result.stderr.trimEnd().split("\n");
  expect(lines.length).toBeLessThanOrEqual(4);
  expect(lines.every((line) => Buffer.byteLength(line) <= 200)).toBe(true);
  const check = await run(["check", file, "--json"]);
  expect(check.code).toBe(3);
  const errors: { code: string; id: string }[] = JSON.parse(check.stdout).errors;
  expect(errors.filter(({ code }) => code === "E102").map(({ id }) => id)).toEqual(
    Array.from({ length: 999 }, (_, index) => String(1001 + index)),
  );
});
