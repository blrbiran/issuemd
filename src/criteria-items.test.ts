import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-criteria-items-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let sequence = 0;
function fixture(text: string): string {
  const path = join(dir, `${++sequence}.md`);
  writeFileSync(path, text);
  return path;
}
async function ledger(body: string): Promise<string> {
  const path = fixture(canonical);
  expect((await run(["body", path, "2", "--body-file", fixture(body)])).code).toBe(0);
  return path;
}
async function show(path: string, id = "2") {
  return JSON.parse((await run(["show", path, id, "--json"])).stdout);
}

test("a semicolon inside an item does not split it", async () => {
  const path = await ledger("**验收判据**\n\n1. 第一条；它自己含分号\n2. 第二条\n");
  const view = await show(path);
  expect(view.criteriaItems).toEqual(["第一条；它自己含分号", "第二条"]);
  expect(view.criteria).toBe("1. 第一条；它自己含分号；2. 第二条");
});

test("two canonical blocks produce one item list without renumbering", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n**验收判据**\n\n1. C\n2. D\n");
  const view = await show(path);
  expect(view.criteriaItems).toEqual(["A", "C", "D"]);
});

test("inline label text becomes the first item", async () => {
  const path = await ledger("**验收判据**：必须离线通过。\n\n- 第二项\n");
  const view = await show(path);
  expect(view.criteriaItems).toEqual(["必须离线通过。", "第二项"]);
});

test("a fenced list is content, not a new item", async () => {
  const path = await ledger("**验收判据**\n\n1. 运行以下命令\n\n```text\n- not an item\n2. not an item\n```\n\n2. 第二项\n");
  const view = await show(path);
  expect(view.criteriaItems).toHaveLength(2);
  expect(view.criteriaItems![0]).toContain("- not an item");
});

test("a paragraph after a blank becomes its own item", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n说明段。\n\n2. B\n");
  const view = await show(path);
  expect(view.criteriaItems).toEqual(["A", "说明段。", "B"]);
});

test("an indented continuation after a blank stays with its item", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n   续行说明。\n");
  const view = await show(path);
  expect(view.criteriaItems).toEqual(["A 续行说明。"]);
});

test("list --json --with-body carries the same items", async () => {
  const path = await ledger("**验收判据**\n\n1. A；带分号\n2. B\n");
  const batch = JSON.parse((await run(["list", path, "--json", "--with-body"])).stdout);
  const issue = batch.issues.find(({ id }: { id: string }) => id === "2");
  expect(issue.criteriaItems).toEqual((await show(path)).criteriaItems);
});

test("a closed archive with the same criteria recovers real items", async () => {
  const path = await ledger("**验收判据**\n\n1. A；带分号\n2. B\n");
  expect((await run(["close", path, "2", "--criteria-from-body", "--keep-body"])).code).toBe(0);
  const view = await show(path);
  expect(view.criteriaSource).toBe("table");
  expect(view.criteriaItems).toEqual(["A；带分号", "B"]);
  expect(view.criteriaJoined).toBeUndefined();
});

test("a flat closed cell reports joined items", async () => {
  const path = fixture(canonical);
  expect((await run(["close", path, "2", "--status", "已修", "--criteria", "甲；乙"])).code).toBe(0);
  const view = await show(path);
  expect(view.criteriaItems).toEqual(["甲；乙"]);
  expect(view.criteriaJoined).toBe(true);
});

test("a closed cell without a semicolon is a single item without the joined flag", async () => {
  const path = fixture(canonical);
  const view = await show(path, "1");
  expect(view.criteriaItems).toEqual(["`a1b2c3d`：连续 3 轮 12/12"]);
  expect(view.criteriaJoined).toBeUndefined();
});

test("an issue without criteria exposes neither field", async () => {
  const path = await ledger("**现象**：no criteria.\n");
  const view = await show(path);
  expect(view.criteriaItems).toBeUndefined();
  expect(view.criteriaJoined).toBeUndefined();
});
