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
