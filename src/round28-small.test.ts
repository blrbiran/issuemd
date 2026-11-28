import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-round28-small-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let sequence = 0;
function fixture(text: string, name = `${++sequence}.md`): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}
async function ledger(): Promise<string> {
  return fixture(canonical);
}

test("--version prints the package version and the running build directory", async () => {
  const result = await run(["--version"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/^\d+\.\d+\.\d+ \(build: \/.*\)\n$/);
});

test("counts --markdown emits one pasteable bullet with the same numbers", async () => {
  const path = await ledger();
  const plain = await run(["counts", path]);
  const markdown = await run(["counts", path, "--markdown"]);
  expect(markdown.code).toBe(0);
  expect(markdown.stdout).toMatch(/^- open \d+ \(.+\) · closed \d+\n$/);
  const numbers = (text: string) => text.match(/\d+/g);
  expect(numbers(markdown.stdout)).toEqual(numbers(plain.stdout));
  expect((await run(["counts", path, "--markdown", "--json"])).code).toBe(2);
});

test("close truncates a long old criteria override in stderr", async () => {
  const path = await ledger();
  const long = "长".repeat(941);
  expect((await run(["criteria", path, "2", "--criteria", long])).code).toBe(0);
  const result = await run(["close", path, "2", "--status", "已修", "--criteria", "短。", "--dry-run"]);
  expect(result.code).toBe(0);
  const first = result.stderr.split("\n")[0]!;
  expect(Buffer.byteLength(first)).toBeLessThan(200);
  expect(first).toContain("941 chars");
  expect(first).toContain("短。");
});

test("close leaves the override line out when the criteria did not change", async () => {
  const path = await ledger();
  const view = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
  const result = await run(["close", path, "1", "--criteria", view.criteria]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("(no changes)");
  expect(result.stderr).not.toContain("criteria override");
});

test("close explains the size consequence of each missing-criteria exit", async () => {
  const path = fixture(canonical);
  const body = fixture("**现象**：没有判据。\n");
  expect((await run(["body", path, "2", "--body-file", body])).code).toBe(0);
  const result = await run(["close", path, "2"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("file shrinks");
  expect(result.stderr).toContain("file grows");
});

test("the write-time alias hint names --force for a single-line block", async () => {
  const path = fixture(canonical);
  const body = fixture("**现象**：甲。\n\n**判据**：只是散文一句。\n");
  const written = await run(["body", path, "2", "--body-file", body]);
  expect(written.code).toBe(0);
  expect(written.stderr).toContain("--criteria-labels --force");
  expect((await run(["check", path, "--json"])).stdout).toContain('"W261"');
});

test("sync --criteria-labels skips prose that does not look like criteria", async () => {
  const path = fixture(canonical);
  const body = fixture("**现象**：甲。\n\n**判据**\n\n讨论中，尚未定稿。\n");
  expect((await run(["body", path, "2", "--body-file", body])).code).toBe(0);
  const before = readFileSync(path, "utf8");
  const synced = await run(["sync", path, "--criteria-labels"]);
  expect(synced.code).toBe(0);
  expect(synced.stdout).toContain("(no changes)");
  expect(synced.stderr).toContain("no list items");
  expect(synced.stderr).toContain("--force");
  expect(readFileSync(path, "utf8")).toBe(before);
  expect((await run(["check", path, "--json"])).stdout).toContain('"W261"');

  const forced = await run(["sync", path, "--criteria-labels", "--force"]);
  expect(forced.code).toBe(0);
  expect(forced.stderr).toContain('"判据" → "验收判据"');
  expect((await run(["check", path, "--json"])).stdout).not.toContain('"W261"');
});

test("sync --criteria-labels still renames a nearby label with a list", async () => {
  const path = fixture(canonical);
  const body = fixture("**现象**：甲。\n\n**修复判据**\n\n1. 必须通过。\n");
  expect((await run(["body", path, "2", "--body-file", body])).code).toBe(0);
  const synced = await run(["sync", path, "--criteria-labels"]);
  expect(synced.code).toBe(0);
  expect(synced.stderr).toContain('"修复判据" → "验收判据"');
});
