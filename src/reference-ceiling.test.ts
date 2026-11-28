import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-reference-ceiling-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let sequence = 0;

function fixture(text: string, name = `${++sequence}.md`): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/** canonical 的最大号是 20（`7–20` 退休段）；high-water 能把上限抬高。 */
function ledgerWith(highWater?: number): string {
  if (highWater == null) return canonical;
  return canonical.replace(
    "# Demo Issue 台账\n",
    `# Demo Issue 台账\n\n<!-- issuemd:high-water: ${highWater} -->\n`,
  );
}

async function ledgerWithReference(reference: string, highWater?: number): Promise<string> {
  const path = fixture(ledgerWith(highWater));
  const body = fixture(`**现象**：探针。\n\n${reference}\n\n**验收判据**：ok\n`);
  expect((await run(["body", path, "2", "--body-file", body])).code).toBe(0);
  return path;
}

async function warnings(path: string, code: string): Promise<{ id?: string; line: number }[]> {
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  return report.warnings.filter((entry: { code: string }) => entry.code === code);
}

test("an explicit self-ledger reference keeps W271 and blocks the next id", async () => {
  const path = await ledgerWithReference("见本台账 #21 的复测。");
  expect(await warnings(path, "W271")).toEqual([expect.objectContaining({ id: "21" })]);
  const created = await run(["new", path, "--title", "下一个"]);
  expect(created.code).toBe(0);
  expect(created.stdout.trim()).toBe("22");
});

test("an explicit self-ledger reference is local even above the ceiling", async () => {
  const path = await ledgerWithReference("见本台账 #999 的历史结论。");
  expect(await warnings(path, "W271")).toEqual([expect.objectContaining({ id: "999" })]);
  expect((await run(["new", path, "--title", "下一个"])).stdout.trim()).toBe("21");
});

test.each([
  "见本台账 #999",
  "参见本台账 #999",
  "详见本台账 #999",
  "另见本台账 #999",
  "据本台账 #999",
  "按本台账 #999",
  "见本台账#999",
  "本台账 #999",
  "见该台账 #999",
  "参见此台账 #999",
  "见当前台账 #999",
  "见本文档台账 #999",
  "见当前这份台账 #999",
  "记在本台账 #999",
  "登记在本台账 #999",
  "记录在本台账 #999",
  "根据本台账 #999",
  "参考本台账 #999",
  "依照本台账 #999",
  "基于本台账 #999",
  "按照本台账 #999",
  "载于本台账 #999",
  "附在本台账 #999",
  "列入本台账 #999",
  "this ledger #999",
  "the current ledger #999",
])("self-ledger mention %j is local above the ceiling", async (reference) => {
  const path = await ledgerWithReference(reference);
  expect(await warnings(path, "W271")).toEqual([expect.objectContaining({ id: "999" })]);
});

test.each([
  "见 Orca 台账 #21",
  "见 cafe 台账 #21",
  "见 ledger #21",
  "见 docs/issue-20261023.md #21",
  "见日本台账 #21",
])("external mention %j is exempt even below the ceiling", async (reference) => {
  const path = await ledgerWithReference(reference);
  expect(await warnings(path, "W271")).toEqual([]);
});

test("a bare reference is local only up to the high-water ceiling", async () => {
  const low = await ledgerWithReference("见 #21 的结论。");
  expect(await warnings(low, "W271")).toEqual([expect.objectContaining({ id: "21" })]);

  const high = await ledgerWithReference("见 #999 的历史结论。");
  expect(await warnings(high, "W271")).toEqual([]);
  expect((await run(["new", high, "--title", "下一个"])).stdout.trim()).toBe("21");
});

test("a self-ledger mention in an earlier sentence does not leak local scope", async () => {
  const path = await ledgerWithReference("本台账已关闭。见 #999 的历史结论。");
  expect(await warnings(path, "W271")).toEqual([]);
});

test("a high-water mark raises the bare-reference ceiling", async () => {
  const local = await ledgerWithReference("见 #21 的复测。", 557);
  expect(await warnings(local, "W271")).toEqual([expect.objectContaining({ id: "21" })]);
  expect((await run(["new", local, "--title", "下一个"])).stdout.trim()).toBe("558");

  const far = await ledgerWithReference("见 #559 的复测。", 557);
  expect(await warnings(far, "W271")).toEqual([]);
});

test("an external reference at max+1 does not block allocation", async () => {
  const path = await ledgerWithReference("见 Orca 台账 #558 的复盘段。", 557);
  expect(await warnings(path, "W271")).toEqual([]);
  expect((await run(["new", path, "--title", "显式", "--id", "558"])).code).toBe(0);
  expect((await run(["new", path, "--title", "下一个"])).stdout.trim()).toBe("559");
});

test("find still classifies an external reference hit as a reference", async () => {
  const path = await ledgerWithReference("见 Orca 台账 #558 的复盘段。", 557);
  const found = JSON.parse((await run(["find", path, "#558", "--json"])).stdout);
  expect(found.matches.some((hit: { where: string }) => hit.where === "reference")).toBe(true);
});
