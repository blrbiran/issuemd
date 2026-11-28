import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const tempDir = mkdtempSync(join(tmpdir(), "issuemd-round24-"));
const repoTempDir = mkdtempSync(join(import.meta.dir, ".round24-git-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(repoTempDir, { recursive: true, force: true });
});

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
function fixture(name: string, content: string, dir = tempDir): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

async function ledgerWithBody(name: string, bodyText: string, dir = tempDir): Promise<string> {
  const ledger = fixture(`${name}.md`, canonical, dir);
  const body = fixture(`${name}.body`, bodyText, dir);
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  return ledger;
}

test("W202 reports each repeated occurrence with absolute line, column, and body id", async () => {
  const ledger = await ledgerWithBody("repeated-hash", [
    "**现象**：first deadbee, then deadbee",
    "",
    "**验收判据**：expected behavior",
    "",
  ].join("\n"));
  const report = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  const warnings = report.warnings.filter((warning: { code: string }) => warning.code === "W202");
  expect(warnings).toHaveLength(2);
  expect(warnings.map((warning: { id?: string }) => warning.id)).toEqual(["2", "2"]);
  expect(warnings[0].line).toBe(warnings[1].line);
  expect(warnings[0].column).toBeLessThan(warnings[1].column);
});

test("text check prints all W202 locations beyond the general warning cap", async () => {
  const ledger = await ledgerWithBody("many-hashes", [
    "**现象**：deadbee deadbee1 deadbee2 deadbee3",
    "",
    "**验收判据**：expected behavior",
  ].join("\n"));
  const result = await run(["check", ledger]);
  expect(result.stdout.match(/Possible pinned commit hash/g)).toHaveLength(4);
  expect(result.stdout).not.toContain("more, use --json for all");
});

test("closed criteria and list-relative fences retain W240 tokens without W202", async () => {
  const source = canonical.replace("`a1b2c3d`：连续 3 轮 12/12", "deadbee：连续 3 轮 12/12");
  const ledger = fixture("hash-verification.md", source, repoTempDir);
  const body = fixture("hash-verification.body", [
    "**现象**：literal `deadbee` reference",
    "",
    "**复现步骤**",
    "- 示例：",
    "    ```text",
    "    deadbee1",
    "    ```",
    "",
    "**验收判据**：expected behavior",
    "",
  ].join("\n"), repoTempDir);
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const checked = await run(["check", ledger, "--json", "--verify-commits"]);
  const report = JSON.parse(checked.stdout);
  expect(report.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);
  expect(report.warnings.filter((warning: { code: string }) => warning.code === "W240")).toHaveLength(2);
  const closedCriteriaLine = readFileSync(ledger, "utf8").split("\n").findIndex((line) => line.includes("deadbee：连续")) + 1;
  const listFenceLine = readFileSync(ledger, "utf8").split("\n").findIndex((line) => line.trim() === "deadbee1") + 1;
  expect(report.warnings.find((warning: { code: string; message: string }) => warning.code === "W240" && warning.message.endsWith("deadbee"))?.line).toBe(closedCriteriaLine);
  expect(report.warnings.find((warning: { code: string; message: string }) => warning.code === "W240" && warning.message.includes("deadbee1"))?.line).toBe(listFenceLine);
});

async function closeWithArchivedHash(name: string, hash: string, dir = tempDir): Promise<string> {
  const ledger = fixture(`${name}.md`, canonical, dir);
  const body = fixture(`${name}.body`, `**现象**：evidence ${hash}\n\n**验收判据**：expected behavior\n`, dir);
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
  return ledger;
}

test("valid v2 archive payload suppresses W202 but remains eligible for W240", async () => {
  const ledger = await closeWithArchivedHash("archive-hash", "deadbeea", repoTempDir);
  let report = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(report.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);

  report = JSON.parse((await run(["check", ledger, "--json", "--verify-commits"])).stdout);
  expect(report.warnings.filter((warning: { code: string; message: string }) => warning.code === "W240" && warning.message.includes("deadbeea"))).toHaveLength(1);
  expect(report.warnings.filter((warning: { code: string }) => warning.code === "W263")).toEqual([]);

  const afterMarker = fixture("archive-hash-after-marker.md", readFileSync(ledger, "utf8").replace(
    "<!-- issuemd:kept-body:end -->",
    "<!-- issuemd:kept-body:end -->\nordinary appendix reference deadbeef",
  ));
  report = JSON.parse((await run(["check", afterMarker, "--json"])).stdout);
  expect(report.warnings.filter((warning: { code: string }) => warning.code === "W202").map((warning: { message: string }) => warning.message)).toEqual([
    "Possible pinned commit hash: deadbeef",
  ]);
});

test("valid v2 and duplicate archive payloads are excluded from W202", async () => {
  const ledger = await closeWithArchivedHash("v2-archive-hash", "deadbeef");
  const source = readFileSync(ledger, "utf8");
  const lines = source.split("\n");
  const heading = lines.findIndex((line) => line.startsWith("### #2 "));
  const count = Number(/lines:(\d+)/.exec(lines[heading + 3] ?? "")?.[1]);
  const payload = lines.slice(heading + 4, heading + 4 + count);
  const v2Archive = [lines[heading]!, "<!-- issuemd:kept-body:v2 -->", "<!-- issuemd:kept-body:start -->", ...payload, "<!-- issuemd:kept-body:end -->"];
  const v2Text = [...lines.slice(0, heading), ...v2Archive, ...lines.slice(heading + 4 + count + 2)].join("\n");
  const legacyLedger = fixture("v2-archive-hash.md", v2Text);
  const report = JSON.parse((await run(["check", legacyLedger, "--json"])).stdout);
  expect(report.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);

  const duplicate = fixture("duplicate-v2-archive-hash.md", `${v2Text.trimEnd()}\n\n${v2Archive.join("\n")}\n`);
  const duplicateReport = JSON.parse((await run(["check", duplicate, "--json"])).stdout);
  expect(duplicateReport.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);
});

test("malformed v2 archive payloads stay visible to W202", async () => {
  const ledger = await closeWithArchivedHash("malformed-archive-hash", "deadbeef");
  const source = readFileSync(ledger, "utf8").replace("<!-- issuemd:kept-body:start -->", "<!-- broken start marker -->");
  const malformed = fixture("malformed-archive-hash.md", source);
  const report = JSON.parse((await run(["check", malformed, "--json"])).stdout);
  expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W202", message: expect.stringContaining("deadbeef") }));
  const before = readFileSync(malformed, "utf8");
  const repair = await run(["sync", malformed, "--fix-hashes"]);
  expect(repair.code).toBe(0);
  expect(repair.stdout).toBe("(no changes)\n");
  expect(repair.stderr).toContain("malformed archive subtree is read-only");
  expect(readFileSync(malformed, "utf8")).toBe(before);
});

test("post-end marker-shaped appendix text is outside the v3 payload and remains readable", async () => {
  const ledger = await closeWithArchivedHash("v3-post-end-note", "deadbeef");
  const marker = "<!-- issuemd:kept-body:end -->";
  const source = readFileSync(ledger, "utf8").replace(marker, `${marker}\n${marker}\npost-end note deadbeea`);
  const noted = fixture("v3-post-end-note.md", source);
  const report = JSON.parse((await run(["check", noted, "--json"])).stdout);
  expect(report.warnings.filter((warning: { code: string; message: string }) => warning.code === "W202" && warning.message.includes("deadbeef"))).toEqual([]);
  expect(report.warnings.filter((warning: { code: string; message: string }) => warning.code === "W202" && warning.message.includes("deadbeea"))).toHaveLength(1);

  const before = readFileSync(noted, "utf8");
  const repaired = await run(["sync", noted, "--fix-hashes"]);
  expect(repaired.code).toBe(0);
  expect(readFileSync(noted, "utf8")).toContain("post-end note `deadbeea`");
  expect(readFileSync(noted, "utf8")).toContain("deadbeef");
  expect(readFileSync(noted, "utf8")).not.toBe(before);
  expect((await run(["prune", noted, "2", "--dry-run"])).code).toBe(2);
});

test("sync --fix-hashes wraps eligible prose and reports protected occurrences", async () => {
  let ledger = fixture("fix-hashes.md", canonical.replace("| 1 | 已修 | P3 | 登录页闪烁 | `a1b2c3d`：连续 3 轮 12/12 |", "| 1 | 已修 | P3 | 登录页闪烁 | deadbeeb |"));
  const body = fixture("fix-hashes.body", [
    "**现象**：open deadbee1 and deadbee2; inline `deadbee3`",
    "",
    "**说明**：a code sample follows",
    "- 示例：",
    "    ```text",
    "    deadbee4",
    "    ```",
    "",
    "[link](https://example.test/deadbee5)",
    "<a href=\"https://example.test/deadbee6\">raw attribute</a>",
    "unmatched ` deadbee7",
    "",
    "**验收判据**：expected behavior",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  expect((await run(["rename", ledger, "2", "侧栏 deadbeea"])).code).toBe(0);
  const appendix = "\n\n| # | 说明 |\n|---|---|\n| 100000a | cited deadbee8 |\n\nAppendix prose deadbee9\n";
  writeFileSync(ledger, readFileSync(ledger, "utf8").replace(/\n$/, "") + appendix);

  const before = readFileSync(ledger, "utf8");
  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings.filter((warning: { code: string }) => warning.code === "W202")).toHaveLength(10);

  const preview = await run(["sync", ledger, "--fix-hashes", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stdout).toContain("`deadbee1`");
  expect(preview.stdout).toContain("`deadbee2`");
  expect(preview.stdout).toContain("`deadbee9`");
  expect(preview.stderr).toContain("skipped");
  expect(preview.stderr).toContain("parsed table cell");
  expect(preview.stderr).toContain("Markdown link destination");
  expect(preview.stderr).toContain("raw HTML tag or attribute");
  expect(preview.stderr).toContain("unmatched inline-code delimiter");
  expect(readFileSync(ledger, "utf8")).toBe(before);

  const applied = await run(["sync", ledger, "--fix-hashes"]);
  expect(applied.code).toBe(0);
  expect(applied.stderr).toContain("snapshot");
  const after = readFileSync(ledger, "utf8");
  expect(after).toContain("`deadbee1`");
  expect(after).toContain("`deadbee2`");
  expect(after).toContain("`deadbee9`");
  expect(after).toContain("inline `deadbee3`");
  expect(after).toContain("    deadbee4");
  expect(after).toContain("unmatched ` deadbee7");
  expect(after).toContain("https://example.test/deadbee5");
  expect(after).toContain("href=\"https://example.test/deadbee6\"");
  expect(after).toContain("| 100000a | cited deadbee8 |");
  const cited = JSON.parse((await run(["list", ledger, "--json"])).stdout);
  expect(cited.citedRows).toContainEqual(expect.objectContaining({ ids: ["100000a"] }));
  const remaining = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(remaining.warnings.filter((warning: { code: string }) => warning.code === "W202")).toHaveLength(7);

  const noOp = await run(["sync", ledger, "--fix-hashes"]);
  expect(noOp.code).toBe(0);
  expect(noOp.stdout).toBe("(no changes)\n");
});

test("sync --fix-hashes diff applies byte-for-byte to BOM CRLF without final newline", async () => {
  const lf = canonical.replace("**现象**：侧栏固定 240px，无法拖拽。", "**现象**：pinned deadbee1");
  const source = `﻿${lf.replaceAll("\n", "\r\n").replace(/\r\n$/, "")}`;
  const ledger = fixture("fix-hashes-bom-crlf.md", source, repoTempDir);
  const preview = await run(["sync", ledger, "--fix-hashes", "--dry-run"]);
  expect(preview.code).toBe(0);
  const patchedPath = join(repoTempDir, "patched.md");
  const patched = spawnSync("patch", ["-s", "-o", patchedPath, ledger], { input: preview.stdout });
  expect(patched.status).toBe(0);
  expect(patched.stderr.toString() + patched.stdout.toString()).toBe("");
  const applied = await run(["sync", ledger, "--fix-hashes"]);
  expect(applied.code).toBe(0);
  expect(readFileSync(patchedPath)).toEqual(readFileSync(ledger));
});
