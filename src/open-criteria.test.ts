import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const directory = mkdtempSync(join(tmpdir(), "issuemd-open-criteria-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const original = "**验收判据**\n\n1. Old criterion\n2. Another criterion";
let next = 0;
async function fixture(body: string) {
  const file = join(directory, `${++next}.md`);
  const input = `${file}.body`;
  writeFileSync(file, canonical);
  writeFileSync(input, body);
  expect((await run(["body", file, "2", "--body-file", input])).code).toBe(0);
  return file;
}

test("close with supplied criteria requires explicit status on open issues", async () => {
  const file = await fixture(original);
  const before = readFileSync(file, "utf8");
  for (const flags of [[], ["--keep-body"], ["--dry-run"]]) {
    const result = await run(["close", file, "2", "--criteria", "Replacement", ...flags]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("issuemd criteria");
    expect(readFileSync(file, "utf8")).toBe(before);
  }
  expect((await run(["close", file, "2", "--status", "已修", "--criteria", "Reviewed"])).code).toBe(0);
  expect((await run(["close", file, "2", "--criteria", "Correction"])).code).toBe(0);
});

test("an explicit close with different criteria reports both values in the preview and receipt", async () => {
  const file = await fixture("**验收判据**：Original criterion");
  const args = ["close", file, "2", "--status", "已修", "--criteria", "Reviewed criterion"];
  for (const call of [[...args, "--dry-run"], args]) {
    const result = await run(call);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('"Original criterion" → "Reviewed criterion"');
  }
});

test("criteria replaces the owned list and preserves all surrounding ledger bytes", async () => {
  const file = await fixture(`**现象**：Evidence\n\n${original}\n\n**复核记录**：Keep me`);
  const before = readFileSync(file, "utf8");
  const value = String.raw`Literal \| pipe and  spacing`;
  const args = ["criteria", file, "2", "--criteria", value];
  const preview = await run([...args, "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
  const snapshot = /snapshot: ([\da-f]{16})/.exec(preview.stderr)?.[1];
  expect(snapshot).toBeDefined();
  expect((await run([...args, "--if-unchanged", snapshot!])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before.replace(original, `**验收判据**：${value}`));
  expect((await run([...args, "--if-unchanged", snapshot!])).code).toBe(4);
  expect((await run(args)).stdout).toContain("(no changes)");
});

test("criteria inserts a missing block before the original separators", async () => {
  const file = await fixture("**现象**：Keep this line");
  const before = readFileSync(file, "utf8");
  expect((await run(["criteria", file, "2", "--criteria", "New criterion"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before.replace("**现象**：Keep this line", "**现象**：Keep this line\n\n**验收判据**：New criterion"));
});

test.each([
  `**补充判据**：Retain\n\n${original}`,
  `**验收判据（复测用）**：Alias only`,
  `${original}\n\n**验收判据**：`,
  `**验收判据**：Old <!-- Keep the comment -->`,
  `${original}\n\nReview prose\n\n3. Maybe a criterion`,
  "**验收判据**：Old\n\nUnlabelled evidence",
  "**验收判据**：Old\n\n```text\nKeep this\n```",
  "**验收判据**：Old\n\n    - Indented code\n\n**证据**：Keep",
  "**验收判据**：Old\n\n- - -\n\n**证据**：Keep",
  "**验收判据**：Old\n\n1234567890. Standalone evidence\n\n**证据**：Keep",
])("criteria refuses an unsafe source span (%j)", async (body) => {
  const file = await fixture(body);
  const before = readFileSync(file, "utf8");
  const result = await run(["criteria", file, "2", "--criteria", "Replacement"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/L\d+/);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test.each(["2", "1–4"])("criteria refuses an ID also covered by closed row %s", async (closedId) => {
  const file = await fixture(original);
  const before = readFileSync(file, "utf8").replace("| 1 | 已修", `| ${closedId} | 已修`);
  writeFileSync(file, before);
  const id = closedId === "2" ? "2" : "3";
  const result = await run(["criteria", file, id, "--criteria", "Replacement"]);
  expect(result.code).toBe(2);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test.each(["", "  ", "A\nB", "<!-- hidden -->", "A <!-- unclosed"])("criteria refuses unsafe input (%j)", async (value) => {
  const file = await fixture(original);
  const before = readFileSync(file, "utf8");
  const result = await run(["criteria", file, "2", "--criteria", value]);
  expect(result.code).toBe(2);
  expect(readFileSync(file, "utf8")).toBe(before);
});
