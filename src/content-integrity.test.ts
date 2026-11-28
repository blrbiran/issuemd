import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const directory = mkdtempSync(join(tmpdir(), "issuemd-content-integrity-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let fixtureId = 0;

function fixture(content: string): string {
  const path = join(directory, `${++fixtureId}.md`);
  writeFileSync(path, content);
  return path;
}

function lineOf(source: string, text: string): number {
  return source.split("\n").findIndex((line) => line === text) + 1;
}

async function ledgerWithBody(body: string): Promise<string> {
  const ledger = fixture(canonical.replace(/^## 附录[\s\S]*$/m, "## 附录\n"));
  expect((await run(["body", ledger, "2", "--body-file", fixture(body)])).code).toBe(0);
  return ledger;
}

test.each(["补充判据", "新增判据", "收窄判据", "判定标准", "完成标准", "验收标准", "必须满足"])(
  "automatic close preserves an overlooked criteria block under %s",
  async (label) => {
    const heading = `**${label}**`;
    const ledger = await ledgerWithBody(`**验收判据**：Works online.\n\n${heading}\n\n1. Works offline.\n`);
    const before = readFileSync(ledger, "utf8");

    for (const flags of [[], ["--criteria-from-body"]]) {
      const result = await run(["close", ledger, "2", "--dry-run", ...flags]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`L${lineOf(before, heading)}`);
      expect(result.stderr).toContain(heading);
      expect(result.stderr).toContain("--keep-body");
      expect(result.stdout).toBe("");
    }
    const refused = await run(["close", ledger, "2", "--criteria-from-body"]);
    expect(refused.code).toBe(2);
    expect(readFileSync(ledger, "utf8")).toBe(before);

    const report = await run(["check", ledger, "--json"]);
    expect(report.code).toBe(0);
    expect(JSON.parse(report.stdout).warnings).toContainEqual(expect.objectContaining({
      code: "W264", id: "2", line: lineOf(before, heading),
    }));
    expect((await run(["check", ledger, "--strict"])).code).toBe(3);
  },
);

test("a reviewed override or preserved body can close with an overlooked criteria block", async () => {
  const body = "**验收判据**：Works online.\n\n**补充判据**：Works offline.\n";
  for (const flags of [["--status", "已修", "--criteria", "Works online and offline."], ["--no-criteria"]]) {
    const ledger = await ledgerWithBody(body);
    expect((await run(["close", ledger, "2", ...flags])).code).toBe(0);
    expect(readFileSync(ledger, "utf8")).not.toContain("**补充判据**");
  }
  const ledger = await ledgerWithBody(body);
  expect((await run(["close", ledger, "2", "--criteria-from-body", "--keep-body"])).code).toBe(0);
  expect((await run(["show", ledger, "2", "--body-only"])).stdout).toContain("**补充判据**：Works offline.");
});

test("historical, earlier, and comment-only labels do not block automatic close", async () => {
  const ledger = await ledgerWithBody([
    "**判据**：Earlier descriptive label.", "", "**验收判据**：Works online.", "",
    "**关闭时判据**：Prior closed row.", "", "**补充判据**", "", "<!-- no additional conditions -->", "",
  ].join("\n"));
  const report = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(report.warnings).not.toContainEqual(expect.objectContaining({ code: "W264", id: "2" }));
  expect((await run(["close", ledger, "2", "--criteria-from-body"])).code).toBe(0);
});

const archiveHeading = "### #2 侧栏宽度不可调（已关闭，正文保留）";
const archivePrefix = [archiveHeading, "<!-- issuemd:kept-body:v3 -->", "<!-- issuemd:kept-body:start -->"];
const archive = [...archivePrefix, "<!-- issuemd:kept-body:lines:1 -->", "Archived evidence.", "", "<!-- issuemd:kept-body:end -->"].join("\n");

async function closedLedgerWithAppendix(content: string): Promise<string> {
  const ledger = await ledgerWithBody("**验收判据**：Works online.\n");
  expect((await run(["close", ledger, "2"])).code).toBe(0);
  return fixture(`${readFileSync(ledger, "utf8").trimEnd()}\n\n${content}\n`);
}

test.each([
  ["code fence", "```md", "```"],
  ["HTML comment", "<!--", "-->"],
  ["raw HTML", "<pre>", "</pre>"],
])("a kept body hidden under %s cannot be mistaken for an absent archive", async (mask, start, end) => {
  const ledger = await closedLedgerWithAppendix(`${start}\n${archive}\n${end}`);
  const before = readFileSync(ledger, "utf8");
  const headingLine = lineOf(before, archiveHeading);

  const report = await run(["check", ledger, "--json"]);
  expect(report.code).toBe(0);
  expect(JSON.parse(report.stdout).warnings).toContainEqual(expect.objectContaining({
    code: "W269", id: "2", line: headingLine, message: expect.stringContaining(mask),
  }));
  expect((await run(["check", ledger, "--strict"])).code).toBe(3);

  for (const [verb, flags, expectedCode] of [
    ["show", ["--body-only"], 1],
    ["prune", ["--dry-run"], 2],
    ["reopen", [], 3],
  ] as const) {
    const refused = await run([verb, ledger, "2", ...flags]);
    expect(refused.code).toBe(expectedCode);
    expect(refused.stderr).toContain("#2");
    expect(refused.stderr).toContain(`L${headingLine}`);
    expect(refused.stderr).toContain(mask);
    expect(refused.stdout).toBe("");
    expect(readFileSync(ledger, "utf8")).toBe(before);
  }
});

test("close --keep-body refuses to write a second archive for a hidden-only ID", async () => {
  const ledger = await ledgerWithBody("**验收判据**：Works online.\n");
  const before = `${readFileSync(ledger, "utf8").trimEnd()}\n\n\`\`\`md\n${archive}\n\`\`\`\n`;
  const withHidden = fixture(before);

  const closed = await run(["close", withHidden, "2", "--keep-body"]);
  expect(closed.code).toBe(3);
  expect(closed.stderr).toContain(`L${lineOf(before, archiveHeading)}`);
  expect(readFileSync(withHidden, "utf8")).toBe(before);
});

test("lookalikes without a corroborating prefix do not hide missing archives", async () => {
  const ledger = await closedLedgerWithAppendix([
    "```md", archiveHeading, "An isolated example.", ...archivePrefix.slice(1), "```",
  ].join("\n"));
  expect((await run(["check", ledger, "--strict"])).code).toBe(0);
  expect((await run(["reopen", ledger, "2"])).code).toBe(0);
});

test("automatic close protects supplemental criteria after an inline comment", async () => {
  const ledger = await ledgerWithBody("**验收判据**：Works online.\n\n<!-- context --> **补充判据**：Works offline.\n");
  const before = readFileSync(ledger, "utf8");
  const closed = await run(["close", ledger, "2", "--criteria-from-body"]);
  expect(closed.code).toBe(2);
  expect(closed.stderr).toContain("**补充判据**");
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("markerless legacy fallback cannot hide a later masked archive", async () => {
  const ledger = await closedLedgerWithAppendix([
    "### #1 登录页闪烁（已关闭，正文保留）", "Legacy evidence.", "", "```md", archive, "```",
  ].join("\n"));
  const before = readFileSync(ledger, "utf8");
  for (const id of ["2", "1"]) {
    const reopened = await run(["reopen", ledger, id]);
    expect(reopened.code).toBe(3);
    expect(reopened.stderr).toContain(`L${lineOf(before, archiveHeading)}`);
    expect(readFileSync(ledger, "utf8")).toBe(before);
  }
});

test("body-only does not substitute a sibling archive for a masked archive", async () => {
  const sibling = archive.replace("### #2 ", "### #6 ").replace("Archived evidence.", "Sibling evidence.");
  const source = await closedLedgerWithAppendix(`\`\`\`md\n${archive}\n\`\`\`\n\n${sibling}`);
  const before = readFileSync(source, "utf8").replace("| 2 | 已修", "| 2, 6 | 已修");
  const ledger = fixture(before);

  const masked = await run(["show", ledger, "2", "--body-only"]);
  expect(masked.code).toBe(1);
  expect(masked.stdout).toBe("");
  expect(masked.stderr).toContain(`L${lineOf(before, archiveHeading)}`);
  expect((await run(["show", ledger, "6", "--body-only"])).stdout).toBe("Sibling evidence.\n");
  const shown = await run(["show", ledger, "2", "--json"]);
  expect(JSON.parse(shown.stdout).body.id).toBe("6");
});

test("an archive example inside a verified v3 payload remains ordinary payload", async () => {
  const payload = ["```md", ...archive.split("\n"), "```"];
  const ledger = await closedLedgerWithAppendix([
    ...archivePrefix, `<!-- issuemd:kept-body:lines:${payload.length} -->`, ...payload, "", "<!-- issuemd:kept-body:end -->",
  ].join("\n"));
  expect((await run(["check", ledger, "--strict"])).code).toBe(0);
  expect((await run(["show", ledger, "2", "--body-only"])).stdout).toBe(`${payload.join("\n")}\n`);
  expect((await run(["reopen", ledger, "2"])).code).toBe(0);
});
