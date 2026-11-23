import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bodyBlocks, maxIssueId, parseLedger } from "./ledger.js";

const src = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");

describe("bodyBlocks", () => {
  test("returns the three open issue bodies in order", () => {
    const blocks = bodyBlocks(parseLedger(src));
    expect(blocks.map((block) => `${block.id.start} ${block.title}`)).toEqual([
      "2 侧栏宽度不可调",
      "3 导出 CSV 丢空行",
      "4 长列表滚动掉帧",
    ]);
    expect(blocks[0].line).toBe(54);
    expect(blocks[0].end).toBe(60);
  });

  test("ignores a non-Issue H3 inside 正文", () => {
    const broken = src.replace("### Issue 4: 长列表滚动掉帧", "### 附录笔记");
    expect(bodyBlocks(parseLedger(broken)).map((block) => block.id.start)).toEqual([2, 3]);
  });

  test("returns nothing for a document that is not a ledger", () => {
    expect(bodyBlocks(parseLedger("# Plain\n\n## 正文\n\n### Issue 1: x\n"))).toEqual([]);
  });
});

describe("maxIssueId", () => {
  test("counts the end of the retired range", () => {
    expect(maxIssueId(parseLedger(src).rows)).toBe(20);
  });

  test("is zero for empty tables", () => {
    expect(maxIssueId({ open: [], closed: [] })).toBe(0);
  });
});