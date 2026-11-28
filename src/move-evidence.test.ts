import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(body = "**现象**：症状\n\n**证据**：\n\n原始证据保留\n\n**验收判据**：通过\n", suffix = "") {
  const dir = mkdtempSync(join(tmpdir(), "issuemd-move-evidence-"));
  dirs.push(dir);
  const path = join(dir, "ledger.md");
  const template = readFileSync(new URL("../TEMPLATE.md", import.meta.url), "utf8");
  writeFileSync(path, template);
  const bodyFile = join(dir, "body.txt");
  writeFileSync(bodyFile, body);
  return { path, bodyFile, suffix };
}

async function createIssue(path: string, bodyFile: string) {
  const created = await run(["new", path, "--title", "证据搬移", "--body-file", bodyFile]);
  expect(created.code).toBe(0);
  return readFileSync(path, "utf8");
}

test("moves one labeled block verbatim and clears active-body W201", async () => {
  const evidence = "可保留的证据。".repeat(1800);
  const { path, bodyFile } = fixture(`**现象**：症状\n\n**证据**：\n\n${evidence}\n\n**验收判据**：通过\n`);
  await createIssue(path, bodyFile);
  expect((await run(["check", path, "--json"])).stdout).toContain("W201");
  const before = readFileSync(path, "utf8");
  const moved = await run(["body", path, "1", "--move-evidence", "证据"]);
  expect(moved.code, moved.stderr).toBe(0);
  const after = readFileSync(path, "utf8");
  expect(after).toContain("### Evidence from Issue #1");
  expect(after).toContain(evidence);
  expect(after).toContain("**证据**： [移动证据]");
  expect(after).toContain("**验收判据**：通过");
  expect(before).toContain(evidence);
  expect(moved.stderr).toContain("W201 cleared for #1");
});

test("dry-run previews the move and its snapshot applies with if-unchanged", async () => {
  const { path, bodyFile } = fixture();
  await createIssue(path, bodyFile);
  const before = readFileSync(path, "utf8");
  const args = ["body", path, "1", "--move-evidence", "证据"];
  const preview = await run([...args, "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stdout).toContain("Evidence from Issue #1");
  expect(readFileSync(path, "utf8")).toBe(before);
  const snapshot = /snapshot: ([0-9a-f]{16})/.exec(preview.stderr)?.[1];
  expect(snapshot).toBeDefined();
  writeFileSync(path, `${before}\n<!-- concurrent edit -->\n`);
  expect((await run([...args, "--if-unchanged", snapshot!])).code).toBe(4);
  const fresh = await run([...args, "--dry-run"]);
  const freshSnapshot = /snapshot: ([0-9a-f]{16})/.exec(fresh.stderr)?.[1];
  expect(freshSnapshot).toBeDefined();
  const applied = await run([...args, "--if-unchanged", freshSnapshot!]);
  expect(applied.code).toBe(0);
});

test("allocates distinct anchors for repeated evidence moves on the same issue", async () => {
  const { path, bodyFile } = fixture("**现象**：症状\n\n**证据**：第一条\n\n**根因**：第二条\n\n**验收判据**：通过\n");
  await createIssue(path, bodyFile);
  expect((await run(["body", path, "1", "--move-evidence", "证据"])).code).toBe(0);
  const second = await run(["body", path, "1", "--move-evidence", "根因"]);
  expect(second.code, second.stderr).toBe(0);
  const after = readFileSync(path, "utf8");
  expect(after.match(/### Evidence from Issue #1/g)).toHaveLength(2);
  expect(after).toContain("<a id=\"issuemd-evidence-1\"></a>");
  expect(after).toContain("<a id=\"issuemd-evidence-1-2\"></a>");
  expect(after).toContain("<a id=\"issuemd-evidence-1\"></a>\n\n### Evidence from Issue #1");
  expect(after).toContain("<a id=\"issuemd-evidence-1-2\"></a>\n\n### Evidence from Issue #1");
});

test("refuses missing, duplicate, and criteria labels without changing the ledger", async () => {
  for (const [body, label] of [
    ["**现象**：症状\n\n**证据**：只有一处\n", "缺失"],
    ["**现象**：症状\n\n**证据**：一\n\n**证据**：二\n", "证据"],
    ["**现象**：症状\n\n**验收判据**：不能移动\n", "验收判据"],
  ]) {
    const { path, bodyFile } = fixture(body);
    await createIssue(path, bodyFile);
    const before = readFileSync(path, "utf8");
    const result = await run(["body", path, "1", "--move-evidence", label]);
    expect(result.code).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(before);
  }
});

test("refuses a label line that crosses an HTML comment boundary", async () => {
  const { path, bodyFile } = fixture("**现象**：症状\n\n<!-- hidden text\n-->**证据**： visible value\n\n**验收判据**：通过\n");
  await createIssue(path, bodyFile);
  const before = readFileSync(path, "utf8");
  const result = await run(["body", path, "1", "--move-evidence", "证据"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("masked source text");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("reserves anchors on arbitrary HTML elements and in any attribute order", async () => {
  const { path, bodyFile } = fixture();
  await createIssue(path, bodyFile);
  writeFileSync(path, `${readFileSync(path, "utf8")}\n<span title="reserve" id="issuemd-evidence-1"></span>\n`);
  const result = await run(["body", path, "1", "--move-evidence", "证据"]);
  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(path, "utf8")).toContain("<a id=\"issuemd-evidence-1-2\"></a>");
});

test("refuses rows that already claim the target ID while closed or unreadable", async () => {
  const table = "## 已关闭\n\n| # | 状态 | P | 摘要 | 判据 |\n|---|---|---|---|---|\n";
  for (const extra of ["| 1 | 已修 | P2 | 重复关闭行 | 通过 |\n", "| 1 | malformed |\n"]) {
    const { path, bodyFile } = fixture();
    await createIssue(path, bodyFile);
    const before = readFileSync(path, "utf8");
    writeFileSync(path, before.replace(table, `${table}${extra}`));
    const conflicted = readFileSync(path, "utf8");
    const result = await run(["body", path, "1", "--move-evidence", "证据"]);
    expect(result.code).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(conflicted);
  }
});

test("refuses moving the only visible prose reservation inside a literal fence", async () => {
  const { path, bodyFile } = fixture("**现象**：症状\n\n**证据**：\n\n引用 #900\n\n**验收判据**：通过\n");
  await createIssue(path, bodyFile);
  const before = readFileSync(path, "utf8");
  const result = await run(["body", path, "1", "--move-evidence", "证据"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toContain("#900");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("preserves existing archive bytes and refuses duplicate or masked appendices", async () => {
  const { path, bodyFile } = fixture();
  await createIssue(path, bodyFile);
  const source = readFileSync(path, "utf8");
  const appendix = "\n### #77 旧档（已关闭，正文保留）\nold archive bytes\n";
  writeFileSync(path, `${source}${appendix}`);
  const before = readFileSync(path, "utf8");
  expect(before).toContain("old archive bytes");
  const moved = await run(["body", path, "1", "--move-evidence", "证据"]);
  expect(moved.code, moved.stderr).toBe(0);
  expect(readFileSync(path, "utf8")).toContain("old archive bytes");

  const duplicate = fixture();
  await createIssue(duplicate.path, duplicate.bodyFile);
  const duplicateSource = readFileSync(duplicate.path, "utf8");
  writeFileSync(duplicate.path, duplicateSource + "\n## 附录\n\n## 附录\n");
  const duplicateBefore = readFileSync(duplicate.path, "utf8");
  expect((await run(["body", duplicate.path, "1", "--move-evidence", "证据"])).code).toBe(2);
  expect(readFileSync(duplicate.path, "utf8")).toBe(duplicateBefore);

  const masked = fixture();
  await createIssue(masked.path, masked.bodyFile);
  const maskedSource = readFileSync(masked.path, "utf8");
  writeFileSync(masked.path, maskedSource.replace("\n## 附录", "\n```md\n## 附录\n```\n"));
  const maskedBefore = readFileSync(masked.path, "utf8");
  expect((await run(["body", masked.path, "1", "--move-evidence", "证据"])).code).toBe(2);
  expect(readFileSync(masked.path, "utf8")).toBe(maskedBefore);
});
