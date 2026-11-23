/**
 * `adopt` converts the two real-world layouts into the canonical one.
 * The fixtures' `*.expected.json` files were hand-checked against the real
 * ledgers, so they are the acceptance oracle here too.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-adopt-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const expected = (name: string) =>
  JSON.parse(read(`${name}.expected.json`)) as Record<string, number | number[]>;

let counter = 0;
function copy(name: string): string {
  const path = join(dir, `adopt-${counter++}.md`);
  writeFileSync(path, read(name));
  return path;
}

async function adoptAndCheck(name: string) {
  const path = copy(name);
  const result = await run(["adopt", path]);
  expect(result.code).toBe(0);
  const check = await run(["check", path, "--json"]);
  expect(check.code).toBe(0);
  const listed = await run(["list", path, "--json"]);
  const closed = await run(["list", path, "--closed", "--json"]);
  return {
    result,
    counts: JSON.parse(check.stdout).counts,
    open: JSON.parse(listed.stdout).issues as { id: string }[],
    closed: JSON.parse(closed.stdout).issues as { id: string }[],
  };
}

describe("adopt: cafe layout", () => {
  test("produces a ledger whose check is clean and whose ids match the fixture", async () => {
    const want = expected("cafe-shaped");
    const { counts, open, closed } = await adoptAndCheck("cafe-shaped.md");
    expect(counts.open).toBe((want.openIds as number[]).length);
    expect(counts.closed).toBe((want.closedIds as number[]).length);
    expect(open.map((issue) => issue.id)).toEqual((want.openIds as number[]).map(String));
  });

  test("reports the title conflicts and the progress text", async () => {
    const want = expected("cafe-shaped");
    const path = copy("cafe-shaped.md");
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.stdout).toContain(`open-title-conflict x${(want.openTitleConflictIds as number[]).length}`);
    expect(result.stdout).toContain(`progress-text x${(want.progressIds as number[]).length}`);
    expect(result.stdout).toContain(`closed-with-body x${(want.closedIdsWithBody as number[]).length}`);
    expect(result.stdout).toContain(`closed-title-conflict x${(want.closedTitleConflictIds as number[]).length}`);
  });

  test("merges the second closed table instead of duplicating rows", async () => {
    const { closed } = await adoptAndCheck("cafe-shaped.md");
    expect(new Set(closed.map((issue) => issue.id)).size).toBe(closed.length);
  });

  test("--dry-run writes nothing", async () => {
    const path = copy("cafe-shaped.md");
    const before = readFileSync(path);
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(readFileSync(path)).toEqual(before);
  });

  test("--report writes the decision list to a file", async () => {
    const path = copy("cafe-shaped.md");
    const report = join(dir, "decisions.md");
    expect((await run(["adopt", path, "--dry-run", "--report", report])).code).toBe(0);
    const text = readFileSync(report, "utf8");
    expect(text).toContain("open-title-conflict");
    expect(text).toContain("待决事项");
  });
});

describe("adopt: orca layout", () => {
  test("strips counts, adds separators, and lands every id", async () => {
    const want = expected("orca-shaped");
    const { counts, result } = await adoptAndCheck("orca-shaped.md");
    expect(counts.open).toBe((want.openIds as number[]).length);
    expect(counts.closed).toBe((want.closedIds as number[]).length);
    expect(result.stdout).toContain(`去掉标题里的（N）计数：${want.countHeadings} 处`);
    expect(result.stdout).toContain(`补表格分隔行：${want.missingSeparatorBlocks} 处`);
  });

  test("keeps a multi-id row intact and flags it", async () => {
    const { result, closed } = await adoptAndCheck("orca-shaped.md");
    expect(result.stdout).toContain("一格多号");
    // The row's two ids are spelled `1, 20` by every read view.
    expect(closed.some((issue) => issue.id === "1, 20")).toBe(true);
  });
});

describe("adopt: guards", () => {
  test("an already-canonical ledger needs no semantic decisions", async () => {
    const path = copy("canonical-clean.md");
    const result = await run(["adopt", path, "--dry-run"]);
    expect(result.code).toBe(0);
    // The only decision left is the retired range, which adopt keeps as-is.
    expect(result.stdout).toContain("id-range x1");
    expect(result.stdout).not.toContain("open-title-conflict");
    expect(result.stdout).not.toContain("closed-with-body");
    expect(result.stdout).not.toContain("progress-text");
  });

  test("a ledger with no recognizable table is refused with exit 3", async () => {
    const path = join(dir, "nothing.md");
    writeFileSync(path, "# Nothing\n\njust prose\n");
    const before = readFileSync(path);
    const result = await run(["adopt", path]);
    expect(result.code).toBe(3);
    expect(readFileSync(path)).toEqual(before);
  });

  test("a missing file is a usage error", async () => {
    expect((await run(["adopt", join(dir, "nope.md")])).code).toBe(2);
  });
});