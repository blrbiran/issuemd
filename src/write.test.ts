/**
 * Unit tests for src/write.ts — the `--dry-run` diff renderer.
 */

import { describe, test, expect } from "bun:test";
import { unifiedDiff } from "./write.js";

describe("unifiedDiff", () => {
  test("returns empty string for identical arrays", () => {
    expect(unifiedDiff(["a", "b"], ["a", "b"], "f.md")).toBe("");
  });

  test("shows replaced lines with - and +", () => {
    const diff = unifiedDiff(["a", "b", "c"], ["a", "x", "c"], "f.md");
    expect(diff).toContain("-b");
    expect(diff).toContain("+x");
    expect(diff).toContain("--- a/f.md");
    expect(diff).toContain("+++ b/f.md");
    expect(diff).toContain("@@");
  });

  test("includes context lines around changes", () => {
    const old = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const next = ["1", "2", "3", "X", "5", "6", "7", "8"];
    const diff = unifiedDiff(old, next, "f.md");
    // Context before and after the change
    expect(diff).toContain(" 3");
    expect(diff).toContain(" 5");
    expect(diff).toContain("-4");
    expect(diff).toContain("+X");
  });

  test("handles insertions (new lines added)", () => {
    const diff = unifiedDiff(["a", "c"], ["a", "b", "c"], "f.md");
    expect(diff).toContain("+b");
    expect(diff).not.toContain("-b");
  });

  test("handles deletions", () => {
    const diff = unifiedDiff(["a", "b", "c"], ["a", "c"], "f.md");
    expect(diff).toContain("-b");
    expect(diff).not.toContain("+b");
  });

  test("change at the very first line — no context before", () => {
    const diff = unifiedDiff(["X", "b", "c"], ["Y", "b", "c"], "f.md");
    expect(diff).toContain("-X");
    expect(diff).toContain("+Y");
    expect(diff).toContain("@@ -1,");
  });

  test("change at the very last line — no context after", () => {
    const diff = unifiedDiff(["a", "b", "X"], ["a", "b", "Y"], "f.md");
    expect(diff).toContain("-X");
    expect(diff).toContain("+Y");
  });

  test("full-file replacement", () => {
    const diff = unifiedDiff(["old"], ["new"], "f.md");
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
  });

  test("output ends with a newline", () => {
    const diff = unifiedDiff(["a"], ["b"], "f.md");
    expect(diff.endsWith("\n")).toBe(true);
  });
});

describe("unifiedDiff: separate hunks for distant edits (dogfood #26)", () => {
  const big = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);

  test("two distant one-line edits are two small hunks", () => {
    const next = [...big];
    next[9] = "changed 10";
    next.splice(150, 1); // delete line 151
    const diff = unifiedDiff(big, next, "f.md");
    expect(diff.match(/^@@ /gm)?.length).toBe(2);
    const changed = diff.split("\n").filter((line) => /^[-+](?![-+]{2} )/.test(line));
    expect(changed).toEqual(["-line 10", "+changed 10", "-line 151"]);
    expect(diff.split("\n").length).toBeLessThan(30);
  });

  test("a moved row (close: index → closed table) prints only the moved line", () => {
    const next = [...big];
    const [row] = next.splice(20, 1);
    next.splice(120, 0, row!);
    const diff = unifiedDiff(big, next, "f.md");
    const changed = diff.split("\n").filter((line) => /^[-+](?![-+]{2} )/.test(line));
    expect(changed).toEqual(["-line 21", "+line 21"]);
  });

  test("hunk headers are valid line ranges", () => {
    const next = [...big];
    next.splice(0, 0, "new first");
    next.push("new last");
    const diff = unifiedDiff(big, next, "f.md");
    expect(diff).toContain("@@ -1,3 +1,4 @@");
    expect(diff).toContain("@@ -198,3 +199,4 @@");
  });
});
