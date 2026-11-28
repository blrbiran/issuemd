import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-termination-"));
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
async function view(path: string) {
  return JSON.parse((await run(["show", path, "2", "--json"])).stdout);
}
async function hasW268(path: string): Promise<boolean> {
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  return report.warnings.some(({ code }: { code: string }) => code === "W268");
}

test("prose followed by a different list kind ends the block", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n当前状态：A 已达标。\n\n- B\n");
  expect((await view(path)).criteria).toBe("1. A");
  expect(await hasW268(path)).toBe(false);
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(0);
});

test("prose followed by an unordered list after bullets ends the block", async () => {
  const path = await ledger("**验收判据**\n\n- A\n\n当前状态：A 已达标。\n\n2. B\n");
  expect((await view(path)).criteria).toBe("A");
  expect(await hasW268(path)).toBe(false);
});

test("a continuing ordered list keeps the prose and warns", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n补充说明。\n\n2. B\n");
  expect((await view(path)).criteria).toContain("补充说明。");
  expect((await view(path)).criteria).toContain("2. B");
  expect(await hasW268(path)).toBe(true);
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(2);
});

test("a continuing bullet list keeps the prose and warns", async () => {
  const path = await ledger("**验收判据**\n\n- A\n\n补充说明。\n\n- B\n");
  expect((await view(path)).criteria).toContain("补充说明。");
  expect((await view(path)).criteria).toContain("B");
  expect(await hasW268(path)).toBe(true);
});

test("an ordered restart after prose ends the block", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n另一个小节。\n\n1. B\n");
  expect((await view(path)).criteria).toBe("1. A");
  expect(await hasW268(path)).toBe(false);
});

test("an indented continuation is part of the item, not prose", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n   续行说明。\n");
  expect((await view(path)).criteria).toContain("续行说明。");
  expect(await hasW268(path)).toBe(false);
});

test("the label + blank + list shape still reads completely", async () => {
  const path = await ledger("**验收判据**\n\n- 一\n- 二\n");
  expect((await view(path)).criteria).toBe("一；二");
});

test("a fenced example directly after a blank does not add a second ambiguity", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n```text\n9. example\n```\n\n**注意**\n\n2. B\n");
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(report.warnings.filter(({ code }: { code: string }) => code === "W268")).toHaveLength(1);
});
