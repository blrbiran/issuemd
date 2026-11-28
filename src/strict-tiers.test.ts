import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-strict-tiers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let sequence = 0;
function fixture(text: string): string {
  const path = join(dir, `${++sequence}.md`);
  writeFileSync(path, text);
  return path;
}
async function body(ledger: string, text: string): Promise<void> {
  expect((await run(["body", ledger, "2", "--body-file", fixture(text)])).code).toBe(0);
}
async function codes(path: string): Promise<string[]> {
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  return report.warnings.map(({ code }: { code: string }) => code);
}

test("W201 alone no longer fails --strict", async () => {
  const path = fixture(canonical);
  await body(path, `**现象**：${"x".repeat(21_000)}\n\n**验收判据**：works\n`);
  expect(await codes(path)).toContain("W201");
  expect((await run(["check", path, "--strict"])).code).toBe(0);
});

test("W202 alone no longer fails --strict", async () => {
  const path = fixture(canonical);
  await body(path, "**现象**：复现于 def5678。\n\n**验收判据**：works\n");
  expect(await codes(path)).toContain("W202");
  expect((await run(["check", path, "--strict"])).code).toBe(0);
});

test("W264 alone no longer fails --strict", async () => {
  const path = fixture(canonical);
  await body(path, "**验收判据**\n\n1. A\n\n**追加判据**\n\n1. B\n");
  expect(await codes(path)).toContain("W264");
  expect((await run(["check", path, "--strict"])).code).toBe(0);
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(2);
});

test("W261 still fails --strict", async () => {
  const path = fixture(canonical);
  await body(path, "**现象**：no criteria here.\n");
  expect(await codes(path)).toContain("W261");
  expect((await run(["check", path, "--strict"])).code).toBe(3);
});

test("W271 still fails --strict", async () => {
  const path = fixture(canonical);
  await body(path, "**现象**：见 #21 的结论。\n\n**验收判据**：works\n");
  expect(await codes(path)).toContain("W271");
  expect((await run(["check", path, "--strict"])).code).toBe(3);
});
