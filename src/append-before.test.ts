import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-append-before-"));
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

test("--append --before puts a labelled note before the criteria", async () => {
  const path = await ledger("**现象**：甲。\n\n**验收判据**：旧。\n");
  const incoming = fixture("**复核记录**：2026-11-28 复测通过。\n");
  const result = await run(["body", path, "2", "--body-file", incoming, "--append", "--before", "验收判据"]);
  expect(result.code).toBe(0);
  const view = await show(path);
  expect(view.criteria).toBe("旧。");
  expect(view.body.content).toContain("复核记录");
  expect(view.body.content.indexOf("复核记录")).toBeLessThan(view.body.content.indexOf("**验收判据**"));
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.warnings.filter(({ code }: { code: string }) => code === "W268" || code === "W264")).toHaveLength(0);
});

test("--before accepts the bold spelling of a label", async () => {
  const path = await ledger("**现象**：甲。\n\n**验收判据**：旧。\n");
  const incoming = fixture("**复核记录**：note。\n");
  expect((await run(["body", path, "2", "--body-file", incoming, "--append", "--before", "**验收判据**"])).code).toBe(0);
  expect((await show(path)).criteria).toBe("旧。");
});

test("--before lists available labels when the target is missing", async () => {
  const path = await ledger("**现象**：甲。\n\n**验收判据**：旧。\n");
  const incoming = fixture("**复核记录**：note。\n");
  const result = await run(["body", path, "2", "--body-file", incoming, "--append", "--before", "根因"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("available");
  expect(result.stderr).toContain("现象");
});

test("--before refuses an ambiguous label", async () => {
  const path = await ledger("**验收判据**：甲。\n\n**复核**：一。\n\n**复核**：二。\n");
  const incoming = fixture("**复核记录**：note。\n");
  const result = await run(["body", path, "2", "--body-file", incoming, "--append", "--before", "复核"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("occurs 2 times");
});

test("--before without --append is a usage error", async () => {
  const path = await ledger("**验收判据**：旧。\n");
  const incoming = fixture("text\n");
  expect((await run(["body", path, "2", "--body-file", incoming, "--before", "验收判据"])).code).toBe(2);
});

test("--before still refuses incoming criteria labels", async () => {
  const path = await ledger("**验收判据**：旧。\n");
  const incoming = fixture("**追加判据**：新。\n");
  expect((await run(["body", path, "2", "--body-file", incoming, "--append", "--before", "验收判据"])).code).toBe(2);
});
