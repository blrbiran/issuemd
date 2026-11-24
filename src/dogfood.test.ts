/**
 * Regressions from the 2026-11-24 dogfooding ledger (issue-20261124.md).
 * Each describe names the dogfood issue number it pins down.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.js";

const TEMPLATE = readFileSync(new URL("../TEMPLATE.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-dogfood-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function file(content = TEMPLATE, ext = "md"): string {
  const path = join(dir, `f-${counter++}.${ext}`);
  writeFileSync(path, content);
  return path;
}
const text = (path: string) => readFileSync(path, "utf8");
const body = (content: string) => file(content, "txt");

async function withIssue(content: string) {
  const path = file();
  expect((await run(["new", path, "--title", "甲", "--body-file", body(content)])).code).toBe(0);
  return path;
}
async function closedCriteria(path: string, id = "1") {
  const listed = await run(["list", path, "--closed", "--json"]);
  return (JSON.parse(listed.stdout).issues as { id: string; criteria: string }[]).find((i) => i.id === id)?.criteria;
}

describe("#35 adopt --report never clobbers files", () => {
  test("--report pointing at the ledger itself is refused, bytes unchanged", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const before = text(path);
    for (const extra of [[], ["--dry-run"]]) {
      const result = await run(["adopt", path, "--report", path, ...extra]);
      expect(result.code).toBe(2);
      expect(text(path)).toBe(before);
    }
  });

  test("--dry-run --report writes the report (the documented review flow) but not the ledger", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const before = text(path);
    const report = join(dir, `report-${counter++}.md`);
    expect((await run(["adopt", path, "--report", report, "--dry-run"])).code).toBe(0);
    expect(text(report)).toStartWith("adopt: ");
    expect(text(path)).toBe(before);
    // Re-running over its own previous report is allowed.
    expect((await run(["adopt", path, "--report", report, "--dry-run"])).code).toBe(0);
  });

  test("an existing unrelated file is not overwritten", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：x\n");
    const notes = file("PRECIOUS NOTES\n", "txt");
    const result = await run(["adopt", path, "--report", notes]);
    expect(result.code).toBe(2);
    expect(text(notes)).toBe("PRECIOUS NOTES\n");
  });
});

describe("#47 new --status <closed> message", () => {
  test("no shell-escape debris", async () => {
    const result = await run(["new", file(), "--status", "已修", "--title", "p"]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("'''");
    expect(result.stderr).toContain("issuemd close");
  });
});

describe("#39 id overflow", () => {
  test("default max+1 past the safe range is a diagnostic, not a stack", async () => {
    const path = file();
    const max = String(Number.MAX_SAFE_INTEGER);
    expect((await run(["new", path, "--id", max, "--title", "题"])).code).toBe(0);
    const before = text(path);
    const result = await run(["new", path, "--title", "下一条"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("issuemd new:");
    expect(text(path)).toBe(before);
  });
});

describe("#29 labels span blank lines and lists", () => {
  const listBody = "**现象**：a\n\n**根因**：\n\n1. 第一项\n2. 第二项\n\n**验收判据**：\n\n- 条一\n- 条二\n";

  test("show --label reads a label followed by a blank line and a list", async () => {
    const path = await withIssue(listBody);
    const root = await run(["show", path, "1", "--label", "根因"]);
    expect(root.code).toBe(0);
    expect(root.stdout).toContain("1. 第一项");
    expect(root.stdout).toContain("2. 第二项");
    const criteria = await run(["show", path, "1", "--label", "验收判据"]);
    expect(criteria.stdout).toContain("条一");
    expect(criteria.stdout).toContain("条二");
    expect(criteria.stdout).not.toContain("**根因**");
  });

  test("close --criteria-from-body lifts every list item into the cell", async () => {
    const path = await withIssue(listBody);
    expect((await run(["close", path, "1", "--criteria-from-body"])).code).toBe(0);
    const criteria = await closedCriteria(path);
    expect(criteria).toContain("条一");
    expect(criteria).toContain("条二");
    expect((await run(["check", path])).code).toBe(0);
  });

  test("a label with nothing under it is reported as empty, not as success text", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：\n\n**期望**：b\n");
    const result = await run(["show", path, "1", "--label", "验收判据"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("empty");
  });
});

describe("#8/#22 close never silently drops criteria", () => {
  test("no criteria flag: criteria in the body are promoted", async () => {
    const path = await withIssue("**现象**：a\n\n**验收判据**：重启后保持宽度\n");
    expect((await run(["close", path, "1"])).code).toBe(0);
    expect(await closedCriteria(path)).toBe("重启后保持宽度");
  });

  test("no criteria anywhere and no flag: refused, bytes unchanged", async () => {
    const path = await withIssue("**现象**：a\n");
    const before = text(path);
    const result = await run(["close", path, "1"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--no-criteria");
    expect(text(path)).toBe(before);
  });

  test("--no-criteria closes with an empty cell on purpose", async () => {
    const path = await withIssue("**现象**：a\n");
    expect((await run(["close", path, "1", "--no-criteria"])).code).toBe(0);
    expect(await closedCriteria(path)).toBe("");
  });

  test("--criteria-from-body with no criteria in the body is refused", async () => {
    const path = await withIssue("**现象**：a\n\n```\n**验收判据**：示例\n```\n");
    const before = text(path);
    expect((await run(["close", path, "1", "--criteria-from-body"])).code).toBe(2);
    expect(text(path)).toBe(before);
  });

  test("--keep-body without criteria still closes: nothing is lost", async () => {
    const path = await withIssue("**现象**：a\n");
    expect((await run(["close", path, "1", "--keep-body"])).code).toBe(0);
  });

  test("--no-criteria conflicts with the other criteria flags", async () => {
    const path = await withIssue("**现象**：a\n");
    expect((await run(["close", path, "1", "--no-criteria", "--criteria", "x"])).code).toBe(2);
    expect((await run(["close", path, "1", "--no-criteria", "--criteria-from-body"])).code).toBe(2);
  });
});
