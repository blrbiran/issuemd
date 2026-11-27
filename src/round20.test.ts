import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-round20-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, text = canonical): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

async function closeWithArchive(name: string): Promise<{ file: string; source: string; archive: string }> {
  const file = fixture(name);
  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  const source = readFileSync(file, "utf8");
  const archive = source.match(/^### #2 .*（已关闭，正文保留）[\s\S]*?^<!-- issuemd:kept-body:end -->$/m)?.[0];
  expect(archive).toBeDefined();
  return { file, source, archive: archive! };
}

function appendDuplicateArchive(source: string, archive: string): string {
  return `${source.trimEnd()}\n\n## 附录\n\n${archive}\n`;
}

test("close/reopen preserves existing EOF blanks after an appendix", async () => {
  const source = `${canonical.trimEnd()}\n\n\n\n`;
  const file = fixture("appendix-eof-blank-roundtrip.md", source);
  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "2"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(source);
});

test("check reports kept-body archives in every appendix section", async () => {
  const { file, source, archive } = await closeWithArchive("duplicate-appendix-check.md");
  writeFileSync(file, appendDuplicateArchive(source, archive));

  const checkedResult = await run(["check", file, "--json"]);
  expect(checkedResult.code).toBe(0);
  const checked = JSON.parse(checkedResult.stdout);
  expect(checked.errors).toEqual([]);
  expect(checked.warnings.filter(({ code }: { code: string }) => code === "W250")).toHaveLength(2);
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W253", id: "2" }));
  expect((await run(["check", file, "--strict"])).code).toBe(3);
});

test("reopen and check agree on tab-separated archive IDs", async () => {
  const { file, source, archive } = await closeWithArchive("tabbed-appendix-archive.md");
  const tabbed = archive.replace("### #2 ", "### #2\t");
  writeFileSync(file, `${source.trimEnd()}\n\n${tabbed}\n`);

  const checked = await run(["check", file, "--json"]);
  expect(checked.code).toBe(0);
  expect(JSON.parse(checked.stdout).warnings.filter(({ code }: { code: string }) => code === "W250")).toHaveLength(2);
  const reopened = await run(["reopen", file, "2"]);
  expect(reopened.code).toBe(3);
  expect(reopened.stderr).toContain("multiple archives for #2");
});

test("check and rename agree on archive headings with closing ATX hashes", async () => {
  const { file, source, archive } = await closeWithArchive("closing-hash-appendix-archive.md");
  const withClosingHash = archive.replace("（已关闭，正文保留）", "（已关闭，正文保留） #");
  writeFileSync(file, appendDuplicateArchive(source, withClosingHash));

  const checked = await run(["check", file, "--json"]);
  expect(checked.code).toBe(0);
  expect(JSON.parse(checked.stdout).warnings.filter(({ code }: { code: string }) => code === "W250")).toHaveLength(2);
  const reopened = await run(["reopen", file, "2"]);
  expect(reopened.code).toBe(2);
  expect(reopened.stderr).toContain("W266");
  const renamed = await run(["rename", file, "2", "新标题"]);
  expect(renamed.code).toBe(0);
  expect(renamed.stderr.match(/updated #2 archive title:/g)).toHaveLength(2);
  expect(readFileSync(file, "utf8").match(/^### #2 新标题（已关闭，正文保留）$/gm)).toHaveLength(2);
});

for (const [label, malformed] of [
  ["NBSP after heading marker", "heading"],
  ["NBSP before closing hashes", "closing"],
] as const) {
  test(`archive commands ignore non-ATX Unicode spacing: ${label}`, async () => {
    const { file, source, archive } = await closeWithArchive(`unicode-space-${label}.md`);
    const literal = malformed === "heading"
      ? archive.replace("### #2 ", "### #2 ")
      : archive.replace("（已关闭，正文保留）", "（已关闭，正文保留） ##");
    writeFileSync(file, `${source.trimEnd()}\n\n${literal}\n`);

    const checked = await run(["check", file, "--json"]);
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.stdout).warnings.filter(({ code }: { code: string }) => code === "W250")).toHaveLength(1);
    const renamed = await run(["rename", file, "2", "新标题"]);
    expect(renamed.code).toBe(0);
    expect(renamed.stderr.match(/updated #2 archive title:/g)).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toContain(literal);

    const reopened = await run(["reopen", file, "2"]);
    expect(reopened.code).toBe(0);
    const restored = readFileSync(file, "utf8");
    expect(restored).toContain("**根因**：宽度写死在 CSS 变量。");
    expect(restored).toContain(literal);
  });
}

test("check and rename recognize archive summaries containing U+2028", async () => {
  const { file, source, archive } = await closeWithArchive("archive-title-u2028-rename.md");
  const separator = String.fromCharCode(0x2028);
  const unusual = archive.replace("侧栏宽度不可调", `侧栏${separator}宽度不可调`);
  writeFileSync(file, source.replace(archive, unusual));

  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W250", id: "2" }));
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W251", id: "2" }));
  const renamed = await run(["rename", file, "2", "新标题"]);
  expect(renamed.code).toBe(0);
  expect(renamed.stderr).toContain("archive title:");
  expect(readFileSync(file, "utf8")).toContain("### #2 新标题（已关闭，正文保留）");
});

test("reopen restores an archive summary containing U+2028", async () => {
  const { file, source, archive } = await closeWithArchive("archive-title-u2028-reopen.md");
  const unusual = archive.replace("侧栏宽度不可调", `侧栏${String.fromCharCode(0x2028)}宽度不可调`);
  writeFileSync(file, source.replace(archive, unusual));

  const reopened = await run(["reopen", file, "2"]);
  expect(reopened.code).toBe(0);
  const body = await run(["show", file, "2", "--body-only"]);
  expect(body.stdout).toContain("**根因**：宽度写死在 CSS 变量。");
  expect(readFileSync(file, "utf8")).not.toContain("### #2 侧栏");
});

test("reopen accepts U+2028 in both closed summary copies", async () => {
  const { file, source } = await closeWithArchive("reopen-summary-u2028.md");
  const separator = String.fromCharCode(0x2028);
  const summary = `侧栏${separator}宽度不可调`;
  writeFileSync(file, source.replaceAll("侧栏宽度不可调", summary));

  const reopened = await run(["reopen", file, "2"]);
  expect(reopened.code).toBe(0);
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.errors).toEqual([]);
  const shown = JSON.parse((await run(["show", file, "2", "--json"])).stdout);
  expect(shown.summary).toBe(summary);
  expect(shown.body.text).toContain("**根因**：宽度写死在 CSS 变量。");
});

test("rename recognizes archives after a fence info string containing U+2028", async () => {
  const { file, source, archive } = await closeWithArchive("unicode-fence-before-archive.md");
  const secondAppendix = ["```html" + String.fromCharCode(0x2028) + "notes", "```", "", archive].join("\n");
  writeFileSync(file, `${source.trimEnd()}\n\n## 附录\n\n${secondAppendix}\n`);

  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  expect(checked.warnings.filter(({ code }: { code: string }) => code === "W250")).toHaveLength(2);
  const renamed = await run(["rename", file, "2", "新标题"]);
  expect(renamed.code).toBe(0);
  expect(renamed.stderr.match(/updated #2 archive title:/g)).toHaveLength(2);
  expect(readFileSync(file, "utf8").match(/^### #2 新标题（已关闭，正文保留）$/gm)).toHaveLength(2);
});

test("close ignores archive-shaped headings outside appendix sections", async () => {
  const source = `${canonical.trimEnd()}\n\n## 历史说明\n\n### #2 示例（已关闭，正文保留）\n`;
  const file = fixture("archive-example-outside-appendix.md", source);

  const checked = await run(["check", file, "--json"]);
  expect(checked.code).toBe(0);
  expect(JSON.parse(checked.stdout).warnings.some(({ code }: { code: string }) => code === "W250")).toBe(false);
  const closed = await run(["close", file, "2", "--keep-body"]);
  expect(closed.code).toBe(0);
  expect(readFileSync(file, "utf8")).toContain("### #2 示例（已关闭，正文保留）");
});

test("close refuses unescaped archive boundary markers in a body", async () => {
  for (const [name, marker] of [
    ["start", "<!-- issuemd:kept-body:start -->"],
    ["end", "<!-- issuemd:kept-body:end -->"],
  ] as const) {
    const source = canonical.replace("**根因**：宽度写死在 CSS 变量。", `**根因**：宽度写死在 CSS 变量。\n\n${marker}`);
    const file = fixture(`body-archive-${name}-marker.md`, source);
    const before = readFileSync(file, "utf8");
    const closed = await run(["close", file, "2", "--keep-body"]);
    expect(closed.code).toBe(3);
    expect(closed.stderr).toContain(marker);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("close permits a boundary marker inside a list-nested fence", async () => {
  const marker = "<!-- issuemd:kept-body:start -->";
  const body = [
    "100. Marker example",
    "",
    "     ~~~html",
    `     ${marker}`,
    "     ~~~",
  ].join("\n");
  const source = canonical.replace("**根因**：宽度写死在 CSS 变量。", `**根因**：宽度写死在 CSS 变量。\n\n${body}`);
  const file = fixture("fenced-archive-marker-in-list.md", source);

  expect((await run(["close", file, "2", "--keep-body", "--criteria", "recorded"])).code).toBe(0);
  expect((await run(["reopen", file, "2"])).code).toBe(0);
  const shown = await run(["show", file, "2", "--body-only"]);
  expect(shown.stdout).toContain(marker);
});

test("close refuses to archive an issue body ending inside a fence", async () => {
  const source = [
    "# Minimal ledger",
    "",
    "## 怎么用",
    "",
    "## 状态口径",
    "",
    "| 状态 | 分类 |",
    "|---|---|",
    "| 未决 | open |",
    "| 已修 | closed |",
    "",
    "## 索引",
    "",
    "| # | 状态 | P | 摘要 |",
    "|---|---|---|---|",
    "| 1 | 未决 | P1 | probe |",
    "",
    "## 已关闭",
    "",
    "| # | 状态 | P | 摘要 | 判据 |",
    "|---|---|---|---|---|",
    "",
    "## 正文",
    "",
    "### Issue 1: probe",
    "",
    "**验收判据**：content stays readable.",
    "",
    "```html" + String.fromCharCode(0x2028) + "info",
    "unclosed fence",
  ].join("\n");
  const file = fixture("close-body-unclosed-fence.md", source);
  const before = readFileSync(file, "utf8");

  const closed = await run(["close", file, "1", "--keep-body", "--dry-run"]);
  expect(closed.code).toBe(3);
  expect(closed.stderr).toContain("unclosed code fence");
  expect(closed.stdout).toBe("");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("close refuses an appendix fence with U+2028 in its info string", async () => {
  const opener = "```html" + String.fromCharCode(0x2028) + "info";
  const source = canonical.replace("## 附录\n", `## 附录\n\n${opener}\n`);
  const file = fixture("unclosed-unicode-fence.md", source);
  const before = readFileSync(file, "utf8");

  const closed = await run(["close", file, "2", "--keep-body", "--dry-run"]);
  expect(closed.code).toBe(3);
  expect(closed.stderr).toContain("unclosed code fence");
  expect(closed.stdout).toBe("");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("close refuses an archive in a later appendix and reports the ambiguous headings", async () => {
  const archive = [
    "### #2 侧栏宽度不可调（已关闭，正文保留）",
    "",
    "> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。",
    "",
    "**现象**：stale copy",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const file = fixture("close-existing-archive-later-appendix.md", `${canonical.trimEnd()}\n\n## 附录\n\n${archive}\n`);
  const before = readFileSync(file, "utf8");
  const checked = JSON.parse((await run(["check", file, "--json"])).stdout);
  const warning = checked.warnings.find(({ code, id }: { code: string; id: string }) => code === "W250" && id === "2");
  expect(warning).toBeDefined();

  const closed = await run(["close", file, "2", "--keep-body"]);
  expect(closed.code).toBe(2);
  expect(closed.stderr).toMatch(/W266.*L\d+.*L\d+/);
  expect(closed.stderr.endsWith("\n")).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("rename updates archive headings in every appendix section", async () => {
  const { file, source, archive } = await closeWithArchive("duplicate-appendix-rename.md");
  writeFileSync(file, appendDuplicateArchive(source, archive));

  const renamed = await run(["rename", file, "2", "新标题"]);
  expect(renamed.code).toBe(0);
  expect(renamed.stderr.match(/updated #2 archive title:/g)).toHaveLength(2);
  expect(readFileSync(file, "utf8").match(/^### #2 新标题（已关闭，正文保留）$/gm)).toHaveLength(2);
});

test("reopen refuses multiple archives across appendix sections without changing the ledger", async () => {
  const { file, source, archive } = await closeWithArchive("duplicate-appendix-reopen.md");
  const duplicated = appendDuplicateArchive(source, archive);
  writeFileSync(file, duplicated);

  const reopened = await run(["reopen", file, "2"]);
  expect(reopened.code).toBe(2);
  expect(reopened.stderr).toMatch(/W266.*L\d+.*L\d+/);
  expect(readFileSync(file, "utf8")).toBe(duplicated);
});

test("close --keep-body and reopen preserve whitespace-only body edge lines", async () => {
  const heading = "### Issue 2: 侧栏宽度不可调";
  const criterion = "**验收判据**：重启后保持上次宽度。";
  const source = canonical
    .replace(`${heading}\n\n**现象**`, `${heading}\n\n  \n**现象**`)
    .replace(`${criterion}\n\n### Issue 3:`, `${criterion}\n \n  \n### Issue 3:`);
  const file = fixture("archive-edge-whitespace.md", source);
  const before = readFileSync(file, "utf8");

  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "2"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("close/reopen preserves marked archive body edge whitespace", async () => {
  const heading = "### Issue 2: 侧栏宽度不可调";
  const criterion = "**验收判据**：重启后保持上次宽度。";
  const source = canonical
    .replace(`${heading}\n\n**现象**`, `${heading}\n\n  \n**现象**`)
    .replace(`${criterion}\n\n### Issue 3:`, `${criterion}\n \t\n### Issue 3:`);
  const file = fixture("archive-edge-whitespace.md", source);

  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "2"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(source);
});

test("close/reopen preserves provenance-shaped blockquotes in the body", async () => {
  const heading = "### Issue 2: 侧栏宽度不可调";
  const noteLike = "> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。用户正文仍在这里。";
  const source = canonical.replace(`${heading}\n\n**现象**`, `${heading}\n\n${noteLike}\n**现象**`);
  const file = fixture("archive-note-prefix-is-body.md", source);
  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "2"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(source);
});

test("close/reopen preserves a body block shaped like the old archive envelope", async () => {
  const heading = "### Issue 2: 侧栏宽度不可调";
  const note = "> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。";
  const source = canonical.replace(`${heading}\n\n**现象**`, `${heading}\n\n${note}\n\n**现象**`);
  const file = fixture("body-matches-removed-archive-envelope.md", source);
  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "2"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(source);
});

for (const [label, noteLike] of [
  ["tab after quote marker", ">" + String.fromCharCode(9) + "关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。"],
  ["exact generated note", "> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。"],
] as const) {
  test(`close/reopen preserves a body quote matching the old note shape: ${label}`, async () => {
    const heading = "### Issue 2: 侧栏宽度不可调";
    const source = canonical.replace(`${heading}\n\n**现象**`, `${heading}\n\n${noteLike}\n**现象**`);
    const file = fixture(`archive-note-body-${label}.md`, source);
    expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
    expect((await run(["reopen", file, "2"])).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(source);
  });
}

test("new archives use explicit payload boundaries without a provenance line", async () => {
  const { file, archive } = await closeWithArchive("explicit-archive-payload-boundaries.md");
  const lines = archive.split("\n");
  expect(lines[1]).toBe("<!-- issuemd:kept-body:v2 -->");
  expect(lines[2]).toBe("<!-- issuemd:kept-body:start -->");
  expect(lines).toContain("<!-- issuemd:kept-body:end -->");
  expect(archive).not.toContain("> 关闭时以 --keep-body");

  expect((await run(["reopen", file, "2"])).code).toBe(0);
  expect((await run(["show", file, "2", "--body-only"])).stdout)
    .toContain("**现象**：侧栏固定 240px，无法拖拽。");
});

test("reopen refuses a new-format archive missing its end marker", async () => {
  const { file, source } = await closeWithArchive("missing-archive-end-marker.md");
  const malformed = source.replace("<!-- issuemd:kept-body:end -->", "**附录后记**：这不是正文。");
  writeFileSync(file, malformed);
  const before = readFileSync(file, "utf8");

  const reopened = await run(["reopen", file, "2"]);
  expect(reopened.code).toBe(3);
  expect(reopened.stderr).toContain("missing");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("reopen handles a legacy archive heading at EOF", async () => {
  const { file, source, archive } = await closeWithArchive("legacy-archive-heading-at-eof.md");
  const heading = archive.split("\n", 1)[0]!;
  writeFileSync(file, `${source.slice(0, source.indexOf(archive))}${heading}`);

  const reopened = await run(["reopen", file, "2", "--dry-run"]);
  expect(reopened.code).toBe(0);
  expect(reopened.stdout).toContain("### Issue 2: 侧栏宽度不可调");
});

test("reopen preserves a start-marker literal inside a legacy payload", async () => {
  const { file, source, archive } = await closeWithArchive("legacy-payload-marker-collision.md");
  const note = "> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。";
  const markerAsPayload = archive.replace(
    "<!-- issuemd:kept-body:v2 -->\n<!-- issuemd:kept-body:start -->\n",
    `\n\n${note}\n\n<!-- issuemd:kept-body:start -->\n`,
  );
  writeFileSync(file, source.replace(archive, markerAsPayload));

  expect((await run(["reopen", file, "2"])).code).toBe(0);
  expect((await run(["show", file, "2", "--body-only"])).stdout)
    .toContain("<!-- issuemd:kept-body:start -->");
});

test("reopen does not truncate a legacy payload at a literal end marker", async () => {
  const { file, source, archive } = await closeWithArchive("legacy-literal-end-marker.md");
  const start = source.indexOf(archive);
  const end = source.indexOf("<!-- issuemd:kept-body:end -->", start) + "<!-- issuemd:kept-body:end -->".length;
  const literal = archive.replace(
    "<!-- issuemd:kept-body:v2 -->\n<!-- issuemd:kept-body:start -->\n",
    "**现象**：旧归档正文前段。\n<!-- issuemd:kept-body:end -->\n**备注**：这是正文里的字面标记。\n",
  );
  writeFileSync(file, `${source.slice(0, start)}${literal}${source.slice(end)}`);

  expect((await run(["reopen", file, "2"])).code).toBe(0);
  const body = (await run(["show", file, "2", "--body-only"])).stdout;
  expect(body).toContain("旧归档正文前段");
  expect(body).toContain("<!-- issuemd:kept-body:end -->");
  expect(body).toContain("这是正文里的字面标记");
});

test("reopen preserves edge whitespace from a legacy markerless archive", async () => {
  const heading = "### Issue 2: 侧栏宽度不可调";
  const criterion = "**验收判据**：重启后保持上次宽度。";
  const source = canonical
    .replace(`${heading}\n\n**现象**`, `${heading}\n\n  \n**现象**`)
    .replace(`${criterion}\n\n### Issue 3:`, `${criterion}\n \t\n### Issue 3:`);
  const file = fixture("legacy-markerless-body-edge-whitespace.md", source);
  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  let closed = readFileSync(file, "utf8");
  closed = closed.replace("<!-- issuemd:kept-body:v2 -->\n<!-- issuemd:kept-body:start -->\n", "");
  closed = closed.replace("\n<!-- issuemd:kept-body:end -->", "\n### 2026-11-21 legacy boundary\n\nkept appendix prose");
  writeFileSync(file, closed);

  expect((await run(["reopen", file, "2"])).code).toBe(0);
  const reopened = readFileSync(file, "utf8");
  const actualStart = reopened.indexOf("### Issue 2: 侧栏宽度不可调");
  const actualEnd = reopened.indexOf("### Issue 3:", actualStart);
  const expectedStart = source.indexOf("### Issue 2: 侧栏宽度不可调");
  const expectedEnd = source.indexOf("### Issue 3:", expectedStart);
  expect(reopened.slice(actualStart, actualEnd)).toBe(source.slice(expectedStart, expectedEnd));
});

test("reopen keeps a whitespace-only separator before a legacy markerless archive", async () => {
  const file = fixture("markerless-archive-whitespace-separator.md");
  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  const archiveHeading = "### #2 侧栏宽度不可调（已关闭，正文保留）";
  let closed = readFileSync(file, "utf8").replace(`\n\n${archiveHeading}`, `\n \t\n${archiveHeading}`);
  closed = closed.replace("\n<!-- issuemd:kept-body:v2 -->\n<!-- issuemd:kept-body:start -->", "\n\n> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。\n");
  closed = closed.replace("\n<!-- issuemd:kept-body:end -->", "\n");
  writeFileSync(file, closed);

  expect((await run(["reopen", file, "2"])).code).toBe(0);
  const reopened = readFileSync(file, "utf8");
  expect(reopened).toContain("\n \t\n");
  expect((await run(["show", file, "2", "--body-only"])).stdout)
    .toContain("> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。");
});

test("reopen does not preserve appendix blanks as new terminal lines", async () => {
  const file = fixture("appendix-blanks-do-not-follow-reopen.md", `${canonical}\n`);
  expect((await run(["close", file, "2", "--keep-body"])).code).toBe(0);
  const heading = "### #2 侧栏宽度不可调（已关闭，正文保留）";
  const closed = readFileSync(file, "utf8").replace(`\n\n${heading}`, `\n\n\n\n${heading}`);
  writeFileSync(file, closed);

  expect((await run(["reopen", file, "2"])).code).toBe(0);
  const reopened = readFileSync(file, "utf8");
  expect(reopened.endsWith("\n")).toBe(true);
  expect(reopened.endsWith("\n\n")).toBe(false);
});

test("reopen restores four blank separator lines before the final issue", async () => {
  const bodyAt = canonical.indexOf("## 正文\n");
  const appendixAt = canonical.indexOf("## 附录\n");
  const appendix = canonical.slice(appendixAt).trimEnd();
  const body = canonical.slice(bodyAt, appendixAt).trimEnd();
  const previousCriteria = "**验收判据**：含 3 个连续空行的样本导出后仍为 3 行。";
  const spacedBody = body.replace(
    `${previousCriteria}\n\n### Issue 4:`,
    `${previousCriteria}\n\n\n\n\n### Issue 4:`,
  );
  const source = `${canonical.slice(0, bodyAt)}${appendix}\n\n${spacedBody}\n`;
  const file = fixture("final-issue-many-leading-blanks.md", source);
  const before = readFileSync(file, "utf8");
  expect((await run(["close", file, "4", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "4", "--status", "观察"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("reopen inserts the final body before a later H1", async () => {
  const bodyAt = canonical.indexOf("## 正文\n");
  const appendixAt = canonical.indexOf("## 附录\n");
  const appendix = canonical.slice(appendixAt).trimEnd();
  const body = canonical.slice(bodyAt, appendixAt).trimEnd();
  const source = `${canonical.slice(0, bodyAt)}${appendix}\n\n${body}\n\n# External notes\n\nOwner note.\n`;
  const file = fixture("final-body-before-later-h1.md", source);
  const checked = await run(["check", file]);
  expect(checked.code).toBe(3);
  expect(checked.stdout).toContain("E112");
  expect((await run(["close", file, "4", "--keep-body"])).code).toBe(0);

  const reopened = await run(["reopen", file, "4", "--status", "观察"]);
  expect(reopened.code).toBe(0);
  const result = readFileSync(file, "utf8");
  expect(result.indexOf("### Issue 4:")).toBeLessThan(result.indexOf("# External notes"));
  const after = await run(["check", file]);
  expect(after.code).toBe(3);
  expect(after.stdout).toContain("E112");
  expect(after.stdout).not.toContain("E102");
  expect(after.stdout).not.toContain("E123");
});

test("reopen keeps one separator for a final issue in a no-final-newline file", async () => {
  const bodyAt = canonical.indexOf("## 正文\n");
  const appendixAt = canonical.indexOf("## 附录\n");
  const appendix = canonical.slice(appendixAt).trimEnd();
  const body = canonical.slice(bodyAt, appendixAt).trimEnd();
  const previousCriteria = "**验收判据**：含 3 个连续空行的样本导出后仍为 3 行。";
  const spacedBody = body.replace(
    `${previousCriteria}\n\n### Issue 4:`,
    `${previousCriteria}\n\n\n\n\n### Issue 4:`,
  );
  const source = `${canonical.slice(0, bodyAt)}${appendix}\n\n${spacedBody}`;
  const file = fixture("final-issue-no-final-newline.md", source);
  expect((await run(["close", file, "4", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "4", "--status", "观察"])).code).toBe(0);
  const reopened = readFileSync(file, "utf8");
  expect(reopened.endsWith("\n")).toBe(false);
  expect(reopened).toContain(`${previousCriteria}\n\n### Issue 4:`);
  expect(reopened).not.toContain(`${previousCriteria}\n\n\n### Issue 4:`);
});

test("reopen restores terminal blank lines from the final archived issue body", async () => {
  const bodyAt = canonical.indexOf("## 正文\n");
  const appendixAt = canonical.indexOf("## 附录\n");
  const appendix = canonical.slice(appendixAt).trimEnd();
  const body = canonical.slice(bodyAt, appendixAt).trimEnd();
  const source = `${canonical.slice(0, bodyAt)}${appendix}\n\n${body}\n`;
  const file = fixture("final-body-trailing-blanks.md", source);
  const before = readFileSync(file, "utf8");
  expect((await run(["check", file])).code).toBe(0);
  expect((await run(["close", file, "4", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "4", "--status", "观察"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("reopen preserves archived final-body trailing blank lines", async () => {
  const bodyAt = canonical.indexOf("## 正文\n");
  const appendixAt = canonical.indexOf("## 附录\n");
  const appendix = canonical.slice(appendixAt).trimEnd();
  const body = canonical.slice(bodyAt, appendixAt).trimEnd();
  const source = `${canonical.slice(0, bodyAt)}${appendix}\n\n${body}\n\n\n\n`;
  const file = fixture("final-body-extra-terminal-blanks.md", source);
  const before = readFileSync(file, "utf8");
  expect((await run(["close", file, "4", "--keep-body"])).code).toBe(0);
  expect((await run(["reopen", file, "4", "--status", "观察"])).code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("a unique archive is readable across duplicate appendices but reopen refuses", async () => {
  const { file, source, archive } = await closeWithArchive("later-appendix-reopen.md");
  const withoutFirst = source.replace(archive, "");
  const moved = `${withoutFirst.trimEnd()}\n\n## 附录\n\n${archive}\n`;
  writeFileSync(file, moved);
  expect((await run(["check", file, "--strict"])).code).toBe(3);

  const reopened = await run(["reopen", file, "2"]);
  expect(reopened.code).toBe(2);
  expect(reopened.stderr).toMatch(/W266.*L\d+.*L\d+/);
  expect(readFileSync(file, "utf8")).toBe(moved);
  const body = await run(["show", file, "2", "--body-only"]);
  expect(body.code).toBe(0);
  expect(body.stdout.trim()).toBe([
    "**现象**：侧栏固定 240px，无法拖拽。",
    "**根因**：宽度写死在 CSS 变量。",
    "**期望**：可拖拽并记忆。",
    "**验收判据**：重启后保持上次宽度。",
  ].join("\n"));
});
