import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseLedger } from "./ledger.js";
import {
  bodySkeleton,
  cellAt,
  escapeCell,
  extractCriteria,
  guideBlockLines,
  insertLines,
  removeLines,
  replaceCell,
  rewriteBlock,
  statusBlockLines,
  tableRange,
} from "./ledger-edit.js";

const src = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");

describe("cells", () => {
  test("replaceCell touches one cell and escapes the pipe", () => {
    const line = "| 2 | 未决 | P1 | 侧栏宽度不可调 |";
    expect(replaceCell(line, 3, "a | b")).toBe("| 2 | 未决 | P1 | a \\| b |");
    expect(replaceCell(line, 1, "观察")).toBe("| 2 | 观察 | P1 | 侧栏宽度不可调 |");
  });

  test("replaceCell keeps the padding of an unpadded row", () => {
    expect(replaceCell("|2|未决|P1|x|", 3, "y")).toBe("|2|未决|P1|y|");
  });

  test("cellAt decodes an escaped pipe", () => {
    expect(cellAt("| 2 | a \\| b |", 1)).toBe("a | b");
    expect(cellAt("| 2 | 未决 |", 1)).toBe("未决");
  });

  test("escapeCell flattens newlines", () => {
    expect(escapeCell("a\nb")).toBe("a b");
  });
});

describe("lines", () => {
  test("insertLines and removeLines are inverse operations", () => {
    const lines = ["a", "b", "c"];
    expect(insertLines(lines, 2, ["x", "y"])).toEqual(["a", "x", "y", "b", "c"]);
    expect(removeLines(["a", "x", "y", "b"], 2, 2)).toEqual(["a", "b"]);
    expect(insertLines(lines, 4, ["z"])).toEqual(["a", "b", "c", "z"]);
  });
});

describe("tables", () => {
  test("tableRange covers the table including its header", () => {
    expect(tableRange(parseLedger(src), "open")).toEqual({ start: 37, end: 41 });
    expect(tableRange(parseLedger(src), "closed")).toEqual({ start: 45, end: 50 });
  });
});

describe("bodies", () => {
  test("bodySkeleton carries every label", () => {
    const lines = bodySkeleton("21", "x", "c");
    expect(lines[0]).toBe("### Issue 21: x");
    expect(lines).toContain("**现象**：");
    expect(lines).toContain("**验收判据**：c");
  });

  test("extractCriteria returns the criteria block only, across blank lines (#29)", () => {
    const body = ["**现象**：x。", "**验收判据**：重启后", "保持上次宽度。", "", "末尾"];
    expect(extractCriteria(body)).toBe("重启后 保持上次宽度。；末尾");
    expect(extractCriteria(["**验收判据**：", "", "1. a", "2. b", "", "- c"])).toBe("1. a；2. b；c");
    expect(extractCriteria(["**验收判据**：", "", "```", "npm test", "```"])).toBe("npm test");
    expect(extractCriteria(["**现象**：x。"])).toBeUndefined();
    expect(extractCriteria(["**验收判据**：", ""])).toBeUndefined();
  });

  test("extractCriteria stops at the next label", () => {
    expect(extractCriteria(["**验收判据**：a", "**复盘**：b"])).toBe("a");
  });
});

describe("controlled blocks", () => {
  test("rewriteBlock replaces only the lines between the markers", () => {
    const lines = ["head", "<!-- b -->", "old", "<!-- e -->", "tail"];
    expect(rewriteBlock(lines, "<!-- b -->", "<!-- e -->", ["new"])).toEqual([
      "head", "<!-- b -->", "new", "<!-- e -->", "tail",
    ]);
  });

  test("rewriteBlock refuses when a marker is missing or duplicated", () => {
    const lines = ["<!-- b -->", "old"];
    expect(rewriteBlock(lines, "<!-- b -->", "<!-- e -->", ["new"])).toEqual(lines);
    const twice = ["<!-- b -->", "x", "<!-- b -->", "y", "<!-- e -->"];
    expect(rewriteBlock(twice, "<!-- b -->", "<!-- e -->", ["new"])).toEqual(twice);
  });

  test("the status block matches the checker's pinned table", () => {
    expect(statusBlockLines()[0]).toBe("| 状态 | 分类 |");
    expect(statusBlockLines()).toContain("| 未决 | open |");
    expect(guideBlockLines()).toContain("| 关闭 | `issuemd close FILE ID --criteria-from-body` |");
  });
});