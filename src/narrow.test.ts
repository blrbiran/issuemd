import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-narrow-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let sequence = 0;
function fixture(text: string, name = `${++sequence}.md`): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}
async function ledger(body: string): Promise<string> {
  const path = fixture(canonical);
  expect((await run(["body", path, "2", "--body-file", fixture(body)])).code).toBe(0);
  return path;
}
async function show(path: string) {
  return JSON.parse((await run(["show", path, "2", "--json"])).stdout);
}

test("narrow updates criteria, status, and a dated review note atomically", async () => {
  const path = await ledger("**现象**：甲。\n\n**验收判据**：旧判据。\n");
  const result = await run(["narrow", path, "2", "--criteria", "新判据。", "--status", "部分解决", "--note", "复测通过。"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("#2 narrowed");
  expect(result.stderr).toContain("status 未决 → 部分解决");
  const view = await show(path);
  expect(view.status).toBe("部分解决");
  expect(view.criteria).toBe("新判据。");
  expect(view.body.content).toMatch(/\*\*复核记录\*\*：\d{4}-\d{2}-\d{2} 复测通过。/);
  expect(view.body.content.indexOf("复核记录")).toBeLessThan(view.body.content.indexOf("**验收判据**"));
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.errors).toHaveLength(0);
  expect(checked.warnings.filter(({ code }: { code: string }) => ["W264", "W268", "W206", "W261"].includes(code))).toHaveLength(0);
});

test("narrow without --status leaves the status alone", async () => {
  const path = await ledger("**验收判据**：旧。\n");
  expect((await run(["narrow", path, "2", "--criteria", "新。"])).code).toBe(0);
  expect((await show(path)).status).toBe("未决");
});

test("narrow is a no-op when nothing changes", async () => {
  const path = await ledger("**验收判据**：旧。\n");
  const result = await run(["narrow", path, "2", "--criteria", "旧。"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("(no changes)");
});

test("narrow refuses a closed issue", async () => {
  const path = fixture(canonical);
  const before = readFileSync(path, "utf8");
  const result = await run(["narrow", path, "1", "--criteria", "x"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("closed");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("narrow refuses a closed status", async () => {
  const path = await ledger("**验收判据**：旧。\n");
  const result = await run(["narrow", path, "2", "--criteria", "新。", "--status", "已修"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("open status");
});

test("narrow refuses competing criteria blocks", async () => {
  const path = await ledger("**验收判据**：甲。\n\n**追加判据**：乙。\n");
  const before = readFileSync(path, "utf8");
  const result = await run(["narrow", path, "2", "--criteria", "新。"]);
  expect(result.code).toBe(2);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("narrow rejects a note that contains a label", async () => {
  const path = await ledger("**验收判据**：旧。\n");
  const result = await run(["narrow", path, "2", "--criteria", "新。", "--note", "**追加判据**：乙。"]);
  expect(result.code).toBe(2);
});

test("narrow picks an unused review label", async () => {
  const path = await ledger("**复核记录**：早先。\n\n**验收判据**：旧。\n");
  expect((await run(["narrow", path, "2", "--criteria", "新。", "--note", "再次。"])).code).toBe(0);
  const view = await show(path);
  expect(view.labels["复核记录 2"]).toBeDefined();
});

test("narrow --dry-run previews without writing", async () => {
  const path = await ledger("**验收判据**：旧。\n");
  const before = readFileSync(path, "utf8");
  const result = await run(["narrow", path, "2", "--criteria", "新。", "--note", "复测。", "--dry-run"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("新。");
  expect(readFileSync(path, "utf8")).toBe(before);
});
