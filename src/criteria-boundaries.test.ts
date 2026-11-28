import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-criteria-boundaries-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const criteria = "**验收判据**\n\n1. 判据一。\n2. 判据二。";
let sequence = 0;
function fixture(text: string): string {
  const path = join(dir, `${++sequence}.md`);
  writeFileSync(path, text);
  return path;
}
async function ledger(body = criteria): Promise<string> {
  const path = fixture(canonical);
  expect((await run(["body", path, "2", "--body-file", fixture(body)])).code).toBe(0);
  return path;
}
async function warning(path: string, code: string) {
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  return report.warnings.find((entry: { code: string; id: string }) => entry.code === code && entry.id === "2");
}

test.each([
  "**第二十六轮复核（2026-11-27）：仍未修。**\n\n说明\n\n```md\nSample\n```",
  "**第二十六轮复核**（2026-11-27）：仍未修。\n\n说明\n\n```md\nSample\n```",
  "普通段落。\n\n**复核（第 N 轮）：仍未修。**\n\n说明",
])("review headings leave canonical criteria intact (%j)", async (tail) => {
  const path = await ledger(`${criteria}\n\n${tail}\n`);
  expect(JSON.parse((await run(["show", path, "2", "--json"])).stdout).criteria).toBe("1. 判据一。；2. 判据二。");
  expect(await warning(path, "W268")).toBeUndefined();
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(0);
});

test("the exact 非目标 section ends the criteria list without W268", async () => {
  const path = await ledger(`${criteria}\n\n**非目标**\n\n- Do not add a new command.`);
  expect(await warning(path, "W268")).toBeUndefined();
  expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(0);
  expect(JSON.parse((await run(["show", path, "2", "--json"])).stdout).criteria).toBe("1. 判据一。；2. 判据二。");
});

test.each([
  "**本轮追加现场（2026-11-27，同一 session 内被绊两次）**\n\n1. 甲\n2. 乙",
  "**第三十三轮复测（`754b3cf`）**\n\n1. 甲",
  "**第三十四轮重新定性（owner 裁定 + 实测，HEAD `613938a`）**\n\n1. 甲",
  "**已记录的相邻项（不要重复开）**\n\n1. 甲",
  "**诚实边界**\n\n- 不做 X。",
  "**补充实测（2026-11-26 第十八轮，teamlab 现场）**\n\n- 甲",
  "**另一半：headless 路线的 concurrency 是 N 个进程**\n\n- 甲",
])("review section headings after criteria do not raise W268 (%j)", async (tail) => {
  const path = await ledger(`${criteria}\n\n${tail}\n`);
  expect(await warning(path, "W268")).toBeUndefined();
  expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(0);
  expect(JSON.parse((await run(["show", path, "2", "--json"])).stdout).criteria).toBe("1. 判据一。；2. 判据二。");
});

test("a non-review heading followed by a different list kind stays quiet", async () => {
  const path = await ledger(`${criteria}\n\n**风险点**\n\n- 甲\n- 乙`);
  expect(await warning(path, "W268")).toBeUndefined();
  expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(0);
});

test.each(["   **非目标**\n\n3. 仍属判据。", "**注意**\n\n3. 仍属判据。", "复核状态。\n\n```md\nSample\n```"])(
  "ambiguous list boundary refuses destructive automatic close (%j)", async (tail) => {
    const path = await ledger(`${criteria}\n\n${tail}\n`);
    const before = readFileSync(path, "utf8");
    expect(await warning(path, "W268")).toEqual(expect.objectContaining({ line: before.split("\n").indexOf(tail.split("\n")[0]!) + 1 }));
    expect((await run(["close", path, "2", "--dry-run"])).code).toBe(2);
    expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(before);
  },
);

test("an ordered list restart after prose starts a new section", async () => {
  const path = await ledger(`${criteria}\n\n复核状态。\n\n1. 另一个新列表。`);
  expect(await warning(path, "W268")).toBeUndefined();
  expect(JSON.parse((await run(["show", path, "2", "--json"])).stdout).criteria).toBe("1. 判据一。；2. 判据二。");
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(0);
});

test.each(["**验收判据**：New", "**复核**\n\n**补充判据**：New", "散文\n\n**判定标准**\n\nNew"])(
  "append refuses visible criteria anywhere in the fragment (%j)", async (incoming) => {
    const path = await ledger();
    const before = readFileSync(path, "utf8");
    for (const extra of [[], ["--dry-run"]]) {
      const result = await run(["body", path, "2", "--append", "--body-file", fixture(incoming), ...extra]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("criteria");
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  },
);

test("append accepts literal criteria examples and chooses an unused review label", async () => {
  const path = await ledger(`**复测记录**：Earlier notes.\n\n${criteria}`);
  const incoming = "```md\n**复测记录 2**\n**验收判据**：A quote\n```\n\n<!--\n**新增判据**\n-->";
  expect((await run(["body", path, "2", "--append", "--body-file", fixture(incoming)])).code).toBe(0);
  const shown = JSON.parse((await run(["show", path, "2", "--json"])).stdout);
  expect(shown.criteria).toBe("1. 判据一。；2. 判据二。");
  expect(shown.labels["复测记录 2"]).toContain("A quote");
  expect(await warning(path, "W206")).toBeUndefined();
});

test("a bold criterion with explanatory prose can still cut off a later criterion", async () => {
  const path = await ledger(`${criteria}\n\n**必须离线通过。**\n\nExplanation.\n\n3. Second case.`);
  const before = readFileSync(path, "utf8");
  expect(await warning(path, "W268")).toBeDefined();
  expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(2);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("a generic colon heading cannot suppress a continuing criteria list", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n2. B\n\n**补充：**\n\n3. C");
  expect(await warning(path, "W268")).toBeDefined();
  expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(2);
});

test("a fenced example marker cannot masquerade as the criteria list tail", async () => {
  const path = await ledger([
    "**验收判据**",
    "",
    "1. A",
    "2. B",
    "",
    "```text",
    "9. example",
    "```",
    "",
    "**补充**",
    "",
    "3. C",
  ].join("\n"));
  expect(await warning(path, "W268")).toBeDefined();
  expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(2);
});

test("large ordered list markers remain exactly comparable", async () => {
  const path = await ledger("**验收判据**\n\n9007199254740992. A\n\n**注意**\n\n9007199254740993. B");
  expect(await warning(path, "W268")).toBeDefined();
  expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(2);
});

test("source equality cannot hide a supplement with a different projection", async () => {
  const block = "```md\n**验收判据**：Must work offline.\n```\n\nOnline passes.";
  const path = await ledger(`**验收判据**\n\n${block}\n\n**补充判据**\n\n${block}`);
  expect(await warning(path, "W264")).toBeDefined();
  expect((await run(["close", path, "2", "--dry-run"])).code).toBe(2);
});

test("bold emphasis with an internal colon and sentence punctuation stays in its parent block", async () => {
  const body = [
    "**现象**",
    "",
    "第一段。",
    "",
    "**注意：这是同一节里的强调句。**",
    "",
    "第二段仍在现象节。",
    "",
    "**验收判据**",
    "",
    "1. 保留该强调句。",
  ].join("\n");
  const path = await ledger(body);
  const view = JSON.parse((await run(["show", path, "2", "--json"])).stdout);
  expect(Object.keys(view.labels)).toEqual(["现象", "验收判据"]);
  expect(view.labels["现象"]).toContain("第二段仍在现象节。");
  expect(view.criteria).toBe("1. 保留该强调句。");
});

test("canonical label syntax and ordinary standalone labels remain labels", async () => {
  const body = [
    "**现象**：第一段。",
    "",
    "**关联**",
    "关联正文。",
    "",
    "**验收判据：**",
    "1. 保留。",
  ].join("\n");
  const path = await ledger(body);
  const view = JSON.parse((await run(["show", path, "2", "--json"])).stdout);
  expect(Object.keys(view.labels)).toEqual(["现象", "关联", "验收判据"]);
  expect(view.criteria).toBe("1. 保留。");
});

test("qualified review labels can have balanced nested parentheses", async () => {
  const path = await ledger(`${criteria}\n\n**复核**（第二轮（离线））：通过\n\n\`\`\`md\nSample\n\`\`\``);
  expect(await warning(path, "W268")).toBeUndefined();
  expect((await run(["close", path, "2", "--dry-run"])).code).toBe(0);
});

test("sync cannot claim to rename a qualified alias it cannot canonicalize", async () => {
  const path = await ledger("**判据**（离线）：Work offline.");
  const before = readFileSync(path, "utf8");
  const synced = await run(["sync", path, "--criteria-labels"]);
  expect(synced.code).toBe(0);
  expect(synced.stdout).toContain("(no changes)");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("only complete source-identical criteria repeats skip W264", async () => {
  const repeated = await ledger(`${criteria}\n\n**补充判据**\n\n1. 判据一。\n2. 判据二。`);
  expect(await warning(repeated, "W264")).toBeUndefined();
  const view = JSON.parse((await run(["show", repeated, "2", "--json"])).stdout);
  expect(view.criteriaBlocks).toHaveLength(2);
  expect((await run(["close", repeated, "2", "--dry-run"])).code).toBe(0);
  for (const tail of ["1. 判据一。", "1. 判据一。；2. 判据二。", "同上，但还需离线通过。"] ) {
    const path = await ledger(`${criteria}\n\n**判据（不变）**\n\n${tail}`);
    expect(await warning(path, "W264")).toBeDefined();
    expect((await run(["close", path, "2", "--dry-run"])).code).toBe(2);
  }
});
