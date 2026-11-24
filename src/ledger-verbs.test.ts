/**
 * body / priority / split / reopen --status — the verbs that close the
 * hand-edit gaps found in dogfooding (#10, #16/#24, #30, #44).
 * Design: docs/superpowers/specs/2026-11-24-ledger-verbs-design.md
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.js";

const TEMPLATE = readFileSync(new URL("../TEMPLATE.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-verbs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const file = (content = TEMPLATE, ext = "md") => {
  const path = join(dir, `f-${counter++}.${ext}`);
  writeFileSync(path, content);
  return path;
};
const text = (path: string) => readFileSync(path, "utf8");
const clean = async (path: string) => (await run(["check", path])).code === 0;

async function ledgerWith(...titles: string[]) {
  const path = file();
  for (const title of titles) {
    const body = file(`**现象**：${title} 的现象\n\n**验收判据**：${title} 通过\n`, "txt");
    expect((await run(["new", path, "--title", title, "--body-file", body])).code).toBe(0);
  }
  return path;
}

describe("body", () => {
  test("replaces the text under the heading, keeps the heading", async () => {
    const path = await ledgerWith("甲", "乙");
    const next = file("**现象**：新的现象\n\n**根因**：\n\n1. 第一\n2. 第二\n\n**验收判据**：新判据\n", "txt");
    const result = await run(["body", path, "1", "--body-file", next]);
    expect(result.code).toBe(0);
    expect((await run(["show", path, "1", "--label", "根因"])).stdout).toContain("2. 第二");
    expect(text(path)).toContain("### Issue 1: 甲");
    expect(text(path)).not.toContain("甲 的现象");
    expect(text(path)).toContain("乙 的现象");
    expect(await clean(path)).toBe(true);
  });

  test("--dry-run prints a diff of the body only and writes nothing", async () => {
    const path = await ledgerWith("甲");
    const before = text(path);
    const result = await run(["body", path, "1", "--body-file", file("**现象**：x\n", "txt"), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("+**现象**：x");
    expect(result.stdout).not.toMatch(/^[-+]\| 1 \|/m);
    expect(text(path)).toBe(before);
  });

  test("refuses closed ids, headings in the input, and a missing --body-file", async () => {
    const path = await ledgerWith("甲", "乙");
    await run(["close", path, "2"]);
    const before = text(path);
    expect((await run(["body", path, "2", "--body-file", file("x\n", "txt")])).code).toBe(2);
    expect((await run(["body", path, "1", "--body-file", file("## 复盘\n", "txt")])).code).toBe(2);
    expect((await run(["body", path, "1"])).code).toBe(2);
    expect((await run(["body", path, "9", "--body-file", file("x\n", "txt")])).code).toBe(1);
    expect(text(path)).toBe(before);
  });
});

describe("priority", () => {
  test("changes only the P cell, open or closed", async () => {
    const path = await ledgerWith("甲", "乙");
    expect((await run(["priority", path, "1", "P0"])).code).toBe(0);
    expect(text(path)).toContain("| 1 | 未决 | P0 | 甲 |");
    await run(["close", path, "2"]);
    expect((await run(["priority", path, "2", ""])).code).toBe(0);
    expect(text(path)).toContain("| 2 | 已修 |  | 乙 |");
    expect(await clean(path)).toBe(true);
  });

  test("refuses words outside P0–P3", async () => {
    const path = await ledgerWith("甲");
    const before = text(path);
    expect((await run(["priority", path, "1", "Q9"])).code).toBe(2);
    expect(text(path)).toBe(before);
  });
});

describe("split", () => {
  const multi = async () => {
    const path = await ledgerWith("甲");
    await run(["close", path, "1"]);
    writeFileSync(path, text(path).replace("| 1 | 已修 | P2 | 甲 | 甲 通过 |", "| 20, 24, 29 | 决定不改 |  | 产品取舍 | 不是 bug |"));
    expect(await clean(path)).toBe(true);
    return path;
  };

  test("a multi-id row becomes one row per id, and per-id verbs then work", async () => {
    const path = await multi();
    const result = await run(["split", path, "24"]);
    expect(result.code).toBe(0);
    for (const id of ["20", "24", "29"]) expect(text(path)).toContain(`| ${id} | 决定不改 |  | 产品取舍 | 不是 bug |`);
    expect(await clean(path)).toBe(true);
    expect((await run(["status", path, "24", "延后"])).code).toBe(0);
    expect((await run(["rename", path, "29", "另一个"])).code).toBe(0);
    expect(await clean(path)).toBe(true);
  });

  test("a range row splits into each id", async () => {
    const path = await multi();
    writeFileSync(path, text(path).replace("| 20, 24, 29 |", "| 7–9 |"));
    expect((await run(["split", path, "8"])).code).toBe(0);
    for (const id of ["7", "8", "9"]) expect(text(path)).toContain(`| ${id} | 决定不改 |`);
    expect(await clean(path)).toBe(true);
  });

  test("open multi-id rows get a body for every id that lacks one", async () => {
    const path = await ledgerWith("甲");
    writeFileSync(path, text(path).replace("| 1 | 未决 | P2 | 甲 |", "| 1, 2 | 未决 | P2 | 甲 |"));
    expect((await run(["split", path, "1"])).code).toBe(0);
    expect(text(path)).toContain("### Issue 2: 甲");
    expect(text(path)).toContain("甲 的现象");
  });

  test("a single-id row is a usage error; --dry-run writes nothing", async () => {
    const path = await multi();
    const before = text(path);
    expect((await run(["split", path, "24", "--dry-run"])).code).toBe(0);
    expect(text(path)).toBe(before);
    const single = await ledgerWith("甲");
    expect((await run(["split", single, "1"])).code).toBe(2);
  });

  test("per-id refusals point at the split command", async () => {
    const path = await multi();
    for (const args of [["close", path, "20"], ["reopen", path, "20"], ["status", path, "20", "延后"], ["rename", path, "20", "x"]]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("issuemd split");
    }
  });
});

describe("reopen --status", () => {
  test("lands in the given open status", async () => {
    const path = await ledgerWith("甲");
    await run(["close", path, "1"]);
    expect((await run(["reopen", path, "1", "--status", "观察"])).code).toBe(0);
    expect(text(path)).toContain("| 1 | 观察 | P2 | 甲 |");
    expect(await clean(path)).toBe(true);
  });

  test("a closed status is refused", async () => {
    const path = await ledgerWith("甲");
    await run(["close", path, "1"]);
    const before = text(path);
    expect((await run(["reopen", path, "1", "--status", "已修"])).code).toBe(2);
    expect(text(path)).toBe(before);
  });
});
