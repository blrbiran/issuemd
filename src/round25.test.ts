import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const tempDir = mkdtempSync(join(tmpdir(), "issuemd-round25-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");

function fixture(name: string, content: string): string {
  const file = join(tempDir, name);
  writeFileSync(file, content);
  return file;
}

async function archiveBody(ledger: string, id: string, text: string): Promise<void> {
  const body = fixture(`${id}-${Date.now()}-${Math.random().toString(36).slice(2)}.body`, text);
  expect((await run(["body", ledger, id, "--body-file", body])).code).toBe(0);
  expect((await run(["close", ledger, id, "--keep-body"])).code).toBe(0);
}

async function oneArchiveLedger(name = "prune-one"): Promise<string> {
  const ledger = fixture(`${name}.md`, canonical);
  await archiveBody(ledger, "2", "**现象**：keep this evidence\n\n**验收判据**：works\n");
  return ledger;
}

function lineOf(text: string, needle: string): number {
  return text.split("\n").findIndex((line) => line.includes(needle)) + 1;
}

test("prune previews then deletes exactly the confirmed v3 archive", async () => {
  const ledger = await oneArchiveLedger();
  const before = readFileSync(ledger, "utf8");

  const preview = await run(["prune", ledger, "2", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stdout).toContain("-### #2 侧栏宽度不可调（已关闭，正文保留）");
  expect(preview.stdout).toContain("<!-- issuemd:kept-body:end -->");
  expect(preview.stderr).toContain("snapshot:");
  expect(readFileSync(ledger, "utf8")).toBe(before);
  const snapshot = /snapshot: ([0-9a-f]{16})/.exec(preview.stderr)?.[1];
  expect(snapshot).toBeTruthy();

  const applied = await run(["prune", ledger, "2", "--confirm", "--if-unchanged", snapshot!]);
  expect(applied.code).toBe(0);
  expect(applied.stderr).toContain("#2 archive pruned");
  const after = readFileSync(ledger, "utf8");
  expect(after).not.toContain("### #2 侧栏宽度不可调（已关闭，正文保留）");
  expect(after).not.toContain("keep this evidence");
  expect(after).toContain("## 附录");
  expect(after).toContain("| 2 | 已修 | P1 | 侧栏宽度不可调 | works |");
  expect(lineOf(before, "## 附录")).toBe(lineOf(after, "## 附录"));
  expect(before.replace(/\n+$/, "") === after.replace(/\n+$/, "")).toBe(false);
  expect((await run(["check", ledger])).code).toBe(0);
});

test("prune requires preview, confirmation, and the matching snapshot", async () => {
  const ledger = await oneArchiveLedger("prune-flags");
  const before = readFileSync(ledger, "utf8");
  expect((await run(["prune", ledger, "2"])).code).toBe(2);
  expect((await run(["prune", ledger, "2", "--confirm"])).code).toBe(2);
  expect((await run(["prune", ledger, "2", "--dry-run", "--confirm"])).code).toBe(2);
  expect((await run(["prune", ledger, "2", "--if-unchanged", "0123456789abcdef"])).code).toBe(2);
  expect((await run(["prune", ledger, "2", "--confirm", "--if-unchanged", "0123456789abcdef"])).code).toBe(4);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("prune keeps rows, criteria, neighboring prose, and other archives unchanged", async () => {
  const ledger = fixture("prune-neighbors.md", canonical);
  await archiveBody(ledger, "2", "**现象**：first archive\n\n**验收判据**：two\n");
  await archiveBody(ledger, "3", "**现象**：second archive\n\n**验收判据**：three\n");
  const source = readFileSync(ledger, "utf8");
  const appendixLine = source.indexOf("## 附录\n") + "## 附录\n".length;
  const withNotes = `${source.slice(0, appendixLine)}\nPinned review note.\n${source.slice(appendixLine)}`;
  writeFileSync(ledger, withNotes);
  const before = readFileSync(ledger, "utf8");

  const preview = await run(["prune", ledger, "2", "--dry-run"]);
  expect(preview.code).toBe(0);
  const snapshot = /snapshot: ([0-9a-f]{16})/.exec(preview.stderr)?.[1]!;
  expect((await run(["prune", ledger, "2", "--confirm", "--if-unchanged", snapshot])).code).toBe(0);
  const after = readFileSync(ledger, "utf8");
  expect(after).not.toContain("### #2 侧栏宽度不可调（已关闭，正文保留）");
  expect(after).not.toContain("first archive");
  expect(after).toContain("### #3 导出 CSV 丢空行（已关闭，正文保留）");
  expect(after).toContain("second archive");
  expect(after).toContain("Pinned review note.");
  expect(after).toContain("| 2 | 已修 | P1 | 侧栏宽度不可调 | two |");
  expect(after).toContain("| 3 | 已修 | P2 | 导出 CSV 丢空行 | three |");

  const remaining = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(remaining.warnings.filter((warning: { code: string }) => warning.code === "W250")).toHaveLength(1);
  expect(readFileSync(ledger, "utf8")).toBe(after);
  expect(before).not.toBe(after);
});

test("prune refuses ambiguous ownership, duplicate appendices, and legacy archives", async () => {
  const openRange = fixture("prune-open-range.md", canonical.replace(
    "## 正文",
    "| 1–3 | 观察 | P2 | overlapping |\n\n## 正文",
  ));
  await archiveBody(openRange, "2", "**验收判据**：x\n");
  let result = await run(["prune", openRange, "2", "--dry-run"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("conflicting owners");

  const unreadable = fixture("prune-unreadable.md", canonical.replace(
    "## 正文",
    "| 2 | 未决 | P1 | broken |\n| 2 | duplicate |\n\n## 正文",
  ));
  await archiveBody(unreadable, "2", "**验收判据**：x\n");
  result = await run(["prune", unreadable, "2", "--dry-run"]);
  expect(result.code).toBe(2);

  const duplicateAppendix = await oneArchiveLedger("prune-dup-appendix");
  writeFileSync(duplicateAppendix, `${readFileSync(duplicateAppendix, "utf8")}\n## 附录\n`);
  result = await run(["prune", duplicateAppendix, "2", "--dry-run"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("multiple ## 附录");

  const legacy = await oneArchiveLedger("prune-legacy");
  writeFileSync(legacy, readFileSync(legacy, "utf8").replace("<!-- issuemd:kept-body:v3 -->\n", ""));
  result = await run(["prune", legacy, "2", "--dry-run"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("missing its version marker");

  const exampleSource = readFileSync(await oneArchiveLedger("prune-html-example-src"), "utf8");
  const headingStart = exampleSource.indexOf("### #2 ");
  const endMarker = "<!-- issuemd:kept-body:end -->";
  const headingEnd = exampleSource.indexOf(endMarker, headingStart) + endMarker.length;
  const example = fixture("prune-html-example.md", `${exampleSource.slice(0, headingStart)}<pre>\n${exampleSource.slice(headingStart, headingEnd)}\n</pre>\n${exampleSource.slice(headingEnd)}`);
  result = await run(["prune", example, "2", "--dry-run"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("archive heading is hidden by raw HTML");
});

test("prune refuses a second eligible end marker and trailing user text", async () => {
  const ledger = await oneArchiveLedger("prune-end-markers");
  const source = readFileSync(ledger, "utf8");
  const broken = source.replace(
    "<!-- issuemd:kept-body:end -->",
    "<!-- issuemd:kept-body:end -->\n<!-- issuemd:kept-body:end -->",
  );
  const duplicate = fixture("prune-end-markers-dup.md", broken);
  let result = await run(["prune", duplicate, "2", "--dry-run"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("user text after its end marker");

  const indented = fixture("prune-end-marker-indented.md", source.replace(
    "<!-- issuemd:kept-body:end -->",
    "    <!-- issuemd:kept-body:end -->",
  ));
  result = await run(["prune", indented, "2", "--dry-run"]);
  expect(result.code).toBe(2);

  const trailing = fixture("prune-end-markers-trailing.md", source.replace(
    "<!-- issuemd:kept-body:end -->",
    "<!-- issuemd:kept-body:end -->\nUser notes after the archive.",
  ));
  result = await run(["prune", trailing, "2", "--dry-run"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("user text after");
});

test("prune preview applies with patch on BOM CRLF without a final newline", async () => {
  const ledger = await oneArchiveLedger("prune-bom");
  const source = `﻿${readFileSync(ledger, "utf8").replaceAll("\n", "\r\n").replace(/\r\n$/, "")}`;
  writeFileSync(ledger, source);
  const preview = await run(["prune", ledger, "2", "--dry-run"]);
  expect(preview.code).toBe(0);
  const patched = join(tempDir, "prune-bom-patched.md");
  const patch = spawnSync("patch", ["-s", "-o", patched, ledger], { input: preview.stdout });
  expect(patch.status).toBe(0);
  expect(patch.stderr.toString() + patch.stdout.toString()).toBe("");
  const snapshot = /snapshot: ([0-9a-f]{16})/.exec(preview.stderr)?.[1]!;
  expect((await run(["prune", ledger, "2", "--confirm", "--if-unchanged", snapshot])).code).toBe(0);
  expect(readFileSync(patched)).toEqual(readFileSync(ledger));
  expect(readFileSync(ledger, "utf8").endsWith("\n")).toBe(false);
});

test.each([
  ["fence", "```text\n<!-- issuemd:kept-body:v3 -->\n```"],
  ["HTML comment", "<!--\n<!-- issuemd:kept-body:v3 -->\n-->"],
  ["raw HTML", "<pre>\n<!-- issuemd:kept-body:v3 -->\n</pre>"],
])("visible archive headings with a hidden v3 envelope fail closed (%s)", async (_name, wrapper) => {
  const ledger = await oneArchiveLedger(`hidden-envelope-${_name}`);
  const original = readFileSync(ledger, "utf8");
  const hidden = original.replace("<!-- issuemd:kept-body:v3 -->", wrapper as string);
  writeFileSync(ledger, hidden);

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W269", id: "2" }));
  expect((await run(["check", ledger, "--strict"])).code).toBe(3);
  const before = readFileSync(ledger, "utf8");
  const shown = await run(["show", ledger, "2", "--body-only"]);
  expect(shown.code).toBe(1);
  expect(shown.stderr).toContain("hidden");
  const pruned = await run(["prune", ledger, "2", "--dry-run"]);
  expect(pruned.code).toBe(2);
  expect(pruned.stderr).toContain("hidden");
  const reopened = await run(["reopen", ledger, "2"]);
  expect(reopened.code).toBe(3);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(hidden).not.toBe(original);
});

test("legacy payload keeps literal marker-like body text readable", async () => {
  const ledger = await oneArchiveLedger("legacy-literal-marker");
  const source = readFileSync(ledger, "utf8")
    .replace("<!-- issuemd:kept-body:v3 -->\n", "")
    .replace("<!-- issuemd:kept-body:start -->\n", "")
    .replace(/<!-- issuemd:kept-body:lines:\d+ -->\n/, "")
    .replace("<!-- issuemd:kept-body:end -->\n", "")
    .replace("keep this evidence", "keep this evidence\n<!-- issuemd:kept-body:lines:1 -->");
  writeFileSync(ledger, source);
  const shown = await run(["show", ledger, "2", "--body-only"]);
  expect(shown.code).toBe(0);
  expect(shown.stdout).toContain("<!-- issuemd:kept-body:lines:1 -->");
});

test("prune keeps newline-terminated trailing blanks but trims only new terminal blanks at EOF", async () => {
  const terminated = await oneArchiveLedger("prune-terminal-newline");
  const source = readFileSync(terminated, "utf8");
  const atEnd = `${source.replace(/\n+$/, "")}\n\n`;
  writeFileSync(terminated, atEnd);
  let preview = await run(["prune", terminated, "2", "--dry-run"]);
  expect(preview.code).toBe(0);
  let snapshot = /snapshot: ([0-9a-f]{16})/.exec(preview.stderr)?.[1]!;
  expect((await run(["prune", terminated, "2", "--confirm", "--if-unchanged", snapshot])).code).toBe(0);
  expect(readFileSync(terminated, "utf8").endsWith("\n")).toBe(true);

  const unterminated = await oneArchiveLedger("prune-terminal-none");
  const unterminatedSource = readFileSync(unterminated, "utf8").replace(/\n+$/, "");
  writeFileSync(unterminated, unterminatedSource);
  preview = await run(["prune", unterminated, "2", "--dry-run"]);
  expect(preview.code).toBe(0);
  snapshot = /snapshot: ([0-9a-f]{16})/.exec(preview.stderr)?.[1]!;
  expect((await run(["prune", unterminated, "2", "--confirm", "--if-unchanged", snapshot])).code).toBe(0);
  expect(readFileSync(unterminated, "utf8").endsWith("\n")).toBe(false);
});

test("prune removes a middle archive while preserving neighboring archive framing", async () => {
  const ledger = fixture("prune-three-middle.md", canonical);
  await archiveBody(ledger, "2", "**验收判据**：two\n");
  await archiveBody(ledger, "3", "**验收判据**：three\n");
  await archiveBody(ledger, "4", "**验收判据**：four\n");
  const before = readFileSync(ledger, "utf8");
  const block = (source: string, id: number) => {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`### #${id} `));
    const end = lines.findIndex((line, at) => at > start && line.startsWith("### #"));
    return lines.slice(start, end < 0 ? undefined : end).join("\n").replace(/\n+$/, "");
  };
  const prune = async (id: string) => {
    const preview = await run(["prune", ledger, id, "--dry-run"]);
    expect(preview.code).toBe(0);
    const snapshot = /snapshot: ([0-9a-f]{16})/.exec(preview.stderr)?.[1]!;
    return run(["prune", ledger, id, "--confirm", "--if-unchanged", snapshot]);
  };

  expect((await prune("3")).code).toBe(0);
  let after = readFileSync(ledger, "utf8");
  expect(block(after, 2)).toBe(block(before, 2));
  expect(block(after, 4)).toBe(block(before, 4));
  expect(after).not.toContain("### #3 ");
  expect((await prune("4")).code).toBe(0);
  expect((await prune("2")).code).toBe(0);
  after = readFileSync(ledger, "utf8");
  expect(after).not.toContain("### #2 ");
  expect(after).not.toContain("### #3 ");
  expect(after).not.toContain("### #4 ");
  expect((await run(["check", ledger, "--strict"])).code).toBe(0);
});

test("prune refuses legacy archives because their trailing boundary is not verifiable", async () => {
  const ledger = await oneArchiveLedger("prune-legacy-boundary");
  const source = readFileSync(ledger, "utf8")
    .replace("<!-- issuemd:kept-body:v3 -->\n", "")
    .replace("<!-- issuemd:kept-body:start -->\n", "")
    .replace(/<!-- issuemd:kept-body:lines:\d+ -->\n/, "")
    .replace("\n<!-- issuemd:kept-body:end -->\n", "\n");
  writeFileSync(ledger, source);
  const preview = await run(["prune", ledger, "2", "--dry-run"]);
  expect(preview.code).toBe(2);
  expect(preview.stderr).toContain("legacy archive has no verified envelope boundary");
});

test("W250 points to prune without changing strict behavior", async () => {
  const ledger = await oneArchiveLedger("prune-w250-message");
  const checked = await run(["check", ledger, "--json"]);
  const warning = JSON.parse(checked.stdout).warnings.find((entry: { code: string }) => entry.code === "W250");
  expect(warning.message).toContain("issuemd prune FILE ID");
  expect((await run(["check", ledger, "--strict"])).code).toBe(0);
});

test("check text summary groups format and artifact warnings without changing JSON shape", async () => {
  const ledger = fixture("check-warning-groups.md", canonical);
  const first = fixture("check-warning-groups-2.body", "**现象**：evidence 1a2b3c4\n\n**验收判据**：works\n");
  expect((await run(["body", ledger, "2", "--body-file", first])).code).toBe(0);
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
  const second = fixture("check-warning-groups-4.body", "**现象**：Pinned hash def5678.\n\n**验收判据**：works\n");
  expect((await run(["body", ledger, "4", "--body-file", second])).code).toBe(0);
  const text = await run(["check", ledger]);
  expect(text.stdout).toMatch(/\d+ errors, \d+ warnings · format 1, artifacts 1 · .* KiB \/ .* lines · body /);
  const json = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(json).not.toHaveProperty("format");
  expect(json).not.toHaveProperty("artifacts");
  expect(json.size).toEqual(expect.objectContaining({ bytes: expect.any(Number), lines: expect.any(Number), bodyLines: expect.any(Number) }));
});

test("an empty duplicate criteria label does not block close", async () => {
  const ledger = fixture("prune-empty-duplicate-criteria.md", canonical);
  const body = fixture("prune-empty-duplicate-criteria.body", [
    "**验收判据**：criterion survives",
    "",
    "**验收判据**",
    "<!-- only a comment -->",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const check = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(check.warnings).toContainEqual(expect.objectContaining({ code: "W206", id: "2" }));
  expect((await run(["close", ledger, "2"])).code).toBe(0);
});

test("readRaw returns the exact bytes and stat from one stable read", async () => {
  const bytes = Buffer.from("﻿first\r\nsecond", "utf8");
  const file = join(tempDir, "read-raw-bytes.md");
  writeFileSync(file, bytes);
  const { readRaw } = await import("./io.js");
  const read = readRaw(file);
  expect(read.raw).toEqual(bytes);
  expect(read.stat.size).toBe(bytes.byteLength);
});