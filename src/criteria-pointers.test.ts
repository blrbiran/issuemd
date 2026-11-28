import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-criteria-pointers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let sequence = 0;
function fixture(text: string): string {
  const path = join(dir, `${++sequence}.md`);
  writeFileSync(path, text);
  return path;
}
async function ledger(text: string): Promise<string> {
  const path = fixture(canonical);
  expect((await run(["body", path, "2", "--body-file", fixture(text)])).code).toBe(0);
  return path;
}
async function warning(path: string, code: string) {
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  return report.warnings.find((entry: { code: string; id: string }) => entry.code === code && entry.id === "2");
}

test.each([
  ["判据（不变）", "第三轮重测，判据未变。"],
  ["判据（不变）", "同上。"],
  ["验收判据（同上）", "与上文一致。"],
  ["判据（同 #2）", "就是上面那条。"],
])("a pure pointer %s / %s is already covered", async (label, text) => {
  const path = await ledger(`**验收判据**\n\n1. A\n\n**${label}**\n\n${text}\n`);
  expect(await warning(path, "W264")).toBeUndefined();
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(0);
  const synced = await run(["sync", path, "--criteria-labels"]);
  expect(synced.code).toBe(0);
  expect(synced.stdout).toContain("(no changes)");
});

test.each([
  ["判据（不变）", "同上，但还需离线通过。"],
  ["判据（不变）", "判据未变，旧条件仍需保留。"],
])("a pointer that adds a condition %s / %s still warns", async (label, text) => {
  const path = await ledger(`**验收判据**\n\n1. A\n\n**${label}**\n\n${text}\n`);
  expect(await warning(path, "W264")).toBeDefined();
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(2);
});

test("a pointer with a list is not treated as a pure pointer", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n**判据（不变）**\n\n1. B\n");
  expect(await warning(path, "W264")).toBeDefined();
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(2);
});

test("a lone pointer block is never a rename candidate", async () => {
  const path = await ledger("**现象**：甲。\n\n**判据（不变）**\n\n同上。\n");
  const synced = await run(["sync", path, "--criteria-labels", "--force"]);
  expect(synced.code).toBe(0);
  expect(synced.stdout).toContain("(no changes)");
  expect(readFileSync(path, "utf8")).toContain("**判据（不变）**");
});

test("a real supplement still blocks close", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n**追加判据**\n\n1. B\n");
  expect(await warning(path, "W264")).toBeDefined();
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(2);
});

test("a source-identical supplement remains covered", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n2. B\n\n**追加判据**\n\n1. A\n2. B\n");
  expect(await warning(path, "W264")).toBeUndefined();
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(0);
});

test("W264 names the rename trap and the supported exits", async () => {
  const path = await ledger("**验收判据**\n\n1. A\n\n**追加判据**\n\n1. B\n");
  const result = await run(["check", path]);
  expect(result.stdout).toContain("renaming it would create a duplicate label");
  expect(result.stdout).toContain("--keep-body");
  expect(result.stdout).toContain("--criteria TEXT");
});
