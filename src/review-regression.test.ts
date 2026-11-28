import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-review-regression-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
function fixture(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

async function bodyLedger(name: string, text: string): Promise<string> {
  const ledger = fixture(`${name}.md`, canonical);
  const body = fixture(`${name}.body`, text);
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  return ledger;
}

test("sync --fix-hashes skips a hash in a bare URL", async () => {
  const ledger = await bodyLedger("bare-url", "**现象**：see https://example.test/deadbee\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("URL");
});

test("sync --fix-hashes skips hashes in balanced-parenthesis link destinations", async () => {
  const ledger = await bodyLedger("balanced-link", "**现象**：see [link](https://example.test/a_(b)deadbee)\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("Markdown link destination");
});

test("sync --fix-hashes skips prose inside a raw HTML block", async () => {
  const ledger = await bodyLedger("raw-html", "**现象**：before\n\n<div>\ndeadbee\n</div>\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("raw HTML block");
});

test("an inline-code HTML comment opener does not hide a valid archive end marker", async () => {
  const ledger = await bodyLedger("inline-comment-token", "**现象**：literal `<!--` token\n\ndeadbee\n\n**验收判据**：works\n");
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);

  const report = JSON.parse((await run(["check", ledger, "--json"])).stdout);

  expect(report.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.body.text).toContain("deadbee");
});

test("limits markers after void tags and blank-terminated HTML blocks remain visible", async () => {
  for (const [name, html] of [["void", "<hr>\n\n"], ["blank-end", "<div>\n\n"]] as const) {
    const source = canonical.replace(
      "# Demo Issue 台账\n",
      `# Demo Issue 台账\n\n${html}<!-- issuemd:limits: body-bytes=123 -->\n`,
    );
    const ledger = fixture(`${name}-limits.md`, source);
    const report = JSON.parse((await run(["check", ledger, "--json"])).stdout);
    expect(report.limits.bodyBytes).toBe(123);
  }
});

test("prune refuses archive-shaped text still inside a void-tag HTML block", async () => {
  const appendix = [
    "## 附录",
    "",
    "<hr>",
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v2 -->",
    "<!-- issuemd:kept-body:start -->",
    "example payload",
    "<!-- issuemd:kept-body:end -->",
    "",
  ].join("\n");
  const ledger = fixture("html-archive-example.md", canonical.replace(/## 附录[\s\S]*$/, appendix));
  const before = readFileSync(ledger, "utf8");

  const result = await run(["prune", ledger, "1", "--dry-run"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("no kept-body archive");
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("a comment ending mid-line does not hide later archive payload boundaries", async () => {
  const ledger = await bodyLedger("comment-inline-close", "**现象**：before\n\n<!--\ncomment content -->\n\ndeadbee\n\n**验收判据**：works\n");
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  const report = JSON.parse((await run(["check", ledger, "--json"])).stdout);

  expect(shown.body?.text).toContain("deadbee");
  expect(report.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);
});

test("HTML tags inside a closed comment do not hide a following limits marker", async () => {
  const preamble = "<!--\n<pre>\n-->\n\n<!-- issuemd:limits: body-bytes=123 -->\n";
  const source = canonical.replace("# Demo Issue 台账\n", `# Demo Issue 台账\n\n${preamble}`);
  const ledger = fixture("limits-comment-html.md", source);

  const report = JSON.parse((await run(["check", ledger, "--json"])).stdout);

  expect(report.limits.bodyBytes).toBe(123);
});

test("sync --fix-hashes skips angle-bracket link destinations with titles", async () => {
  const ledger = await bodyLedger("angle-link-title", "**现象**：see [link](<../deadbee> \"title\")\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("Markdown link destination");
});

test("sync --fix-hashes skips GFM www autolinks", async () => {
  const ledger = await bodyLedger("www-autolink", "**现象**：see www.example.test/deadbee\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("URL");
});

test("sync --fix-hashes skips hashes inside quoted HTML attributes", async () => {
  const ledger = await bodyLedger("quoted-html-attribute", "**现象**：see <span title=\"a > deadbee\">done</span>\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("raw HTML tag or attribute");
});

test("sync --fix-hashes preserves multiline inline-code spans", async () => {
  const ledger = await bodyLedger("multiline-code-span", "**现象**：Example `before\ndeadbee\nafter` remains code\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);
});

test("W202 ownership and repair include the final nonblank line of an open body", async () => {
  const ledger = await bodyLedger("last-body-line-hash", "**现象**：evidence\n\n**验收判据**：works\n\ndeadbee\n");
  writeFileSync(ledger, readFileSync(ledger, "utf8").replace("deadbee\n\n### Issue 3:", "deadbee\n### Issue 3:"));

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  const warning = checked.warnings.find((item: { code: string; message: string }) => item.code === "W202" && item.message.includes("deadbee"));
  expect(warning?.id).toBe("2");

  const repaired = await run(["sync", ledger, "--fix-hashes"]);

  expect(repaired.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toContain("`deadbee`\n### Issue 3:");
  expect(repaired.stderr).toContain("wrapped W202 #2");
});

test("close --keep-body leaves an end marker visible after raw HTML", async () => {
  const ledger = await bodyLedger("archive-html-ending", "**现象**：evidence\n\n**验收判据**：works\n\n<div>\ninside\n</div>");
  const before = readFileSync(ledger, "utf8");
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);

  expect(shown.body?.archived).toBe(true);
  expect(shown.body.text).toContain("</div>");
  expect((await run(["reopen", ledger, "2"])).code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("a literal end marker inside raw HTML cannot terminate a v2 archive", async () => {
  const archive = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v2 -->",
    "<!-- issuemd:kept-body:start -->",
    "<pre>",
    "example payload",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const ledger = fixture("html-literal-end-marker.md", canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${archive}\n`));

  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
  const pruned = await run(["prune", ledger, "1", "--dry-run"]);

  expect(shown.body?.archived).not.toBe(true);
  expect(pruned.code).toBe(2);
});

test("sync --fix-hashes skips escaped angle brackets inside link destinations", async () => {
  const ledger = await bodyLedger("escaped-angle-link", "**现象**：see [link](<a\\>b/deadbee> \"title\")\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("Markdown link destination");
});

test("sync --fix-hashes skips link destinations that continue on later lines", async () => {
  const ledger = await bodyLedger("multiline-link", "**现象**：see [link](\n../deadbee\n\"title\")\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("Markdown link destination");
});

test("sync --fix-hashes skips multiline quoted HTML attributes", async () => {
  const ledger = await bodyLedger("multiline-html-attribute", "**现象**：See <span title=\"first\ndeadbee\">done</span>\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("sync --fix-hashes skips a valid single-backtick span after an unmatched double run", async () => {
  const ledger = await bodyLedger("unmatched-double-before-single", "**现象**：Example ``literal `before\ndeadbee\nafter`\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);
});

test("inline comment syntax inside a multiline code span does not hide criteria or archive boundaries", async () => {
  const ledger = await bodyLedger("comment-inside-multiline-code", "**现象**：Example `before\n<!--\ndeadbee\nafter`\n\n**验收判据**：works\n");
  const open = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(open.criteria).toBe("works");
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);

  expect(shown.body?.archived).toBe(true);
  expect(shown.body.text).toContain("deadbee");
});

test("a prose close marker after a multiline HTML comment reveals later labels", async () => {
  const ledger = await bodyLedger("comment-close-trailing-text", "**现象**：before\n\n<!--\nhidden text\ncomment ends --> visible again\n\n**验收判据**：可通过。\n");

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);

  expect(shown.criteria).toBe("可通过。");
});

test("prune refuses archive examples inside standalone raw HTML block tags", async () => {
  for (const [name, tag] of [["custom-open", "<custom-tag>"], ["custom-self-close", "<custom-tag />"], ["closing-div", "</div>"], ["span", "<span>"]] as const) {
    const appendix = [
      "## 附录",
      "",
      tag,
      "### #1 登录页闪烁（已关闭，正文保留）",
      "<!-- issuemd:kept-body:v2 -->",
      "<!-- issuemd:kept-body:start -->",
      "example payload",
      "<!-- issuemd:kept-body:end -->",
      "",
    ].join("\n");
    const ledger = fixture(`${name}-archive-example.md`, canonical.replace(/## 附录[\s\S]*$/, appendix));

    const result = await run(["prune", ledger, "1", "--dry-run"]);

    expect(result.code).toBe(1);
  }
});

test("an unmatched backtick before a heading does not hide a later W202 hash", async () => {
  const ledger = await bodyLedger("backtick-heading-boundary", "**现象**：unmatched ` delimiter\n\n---\n\ndeadbee\n\n**验收判据**：works\n");

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);

  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W202", message: "Possible pinned commit hash: deadbee" }));
});

test("an escaped backtick does not open a multiline code span", async () => {
  const ledger = await bodyLedger("escaped-backtick", "**现象**：escaped \\` then hash deadbee\n\n**验收判据**：works\n");

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);

  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W202", message: "Possible pinned commit hash: deadbee" }));
});

test("escaped HTML comment openers remain visible prose", async () => {
  const ledger = await bodyLedger("escaped-comment-opener", "**现象**：literal \\<!-- marker\n\n**验收判据**：works\n");
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.criteria).toBe("works");

  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
  const archived = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(archived.body?.archived).toBe(true);
  expect(archived.body.text).toContain("\\<!-- marker");
});

test("criteria alias repair ignores empty alias blocks when selecting one nonempty alias", async () => {
  const ledger = fixture("empty-and-nonempty-alias.md", canonical);
  const body = fixture("empty-and-nonempty-alias.body", "**现象**：probe\n\n**判据**\n<!-- empty -->\n\n**追加判据**：可验证。\n");

  const written = await run(["body", ledger, "2", "--body-file", body]);
  expect(written.code).toBe(0);
  expect(written.stderr).toContain("--criteria-labels");

  const preview = await run(["sync", ledger, "--criteria-labels", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stdout).toContain("**验收判据**：可验证。");
});

test("sync --fix-hashes leaves Markdown link titles intact", async () => {
  const ledger = await bodyLedger("link-title-hash", "**现象**：see [link](<../file> \"deadbee\") and [other](../file\n\"deadbee1\")\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("sync --fix-hashes skips GFM email autolinks", async () => {
  const ledger = await bodyLedger("email-autolink", "**现象**：contact deadbee@example.test\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("email autolink");
});

test("a closing backtick preceded by a backslash remains a valid code-span delimiter", async () => {
  const ledger = await bodyLedger("backslash-before-code-close", "**现象**：Example `before\ndeadbee\nafter\\`\n\n**验收判据**：works\n");

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);
  const before = readFileSync(ledger, "utf8");

  const repaired = await run(["sync", ledger, "--fix-hashes"]);

  expect(repaired.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("multiline code spans do not cross into a new list block", async () => {
  const ledger = await bodyLedger("backtick-list-boundary", "**现象**：Intro ` unmatched\n- deadbee` item\n\n**验收判据**：works\n");

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);

  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W202", message: "Possible pinned commit hash: deadbee" }));
});

test("hidden fake archive headings do not split a genuine archive", async () => {
  const appendix = [
    "## 附录",
    "",
    "<pre>",
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v2 -->",
    "<!-- issuemd:kept-body:start -->",
    "fake payload",
    "<!-- issuemd:kept-body:end -->",
    "</pre>",
    "",
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v2 -->",
    "<!-- issuemd:kept-body:start -->",
    "actual payload",
    "<!-- issuemd:kept-body:end -->",
    "",
  ].join("\n");
  const ledger = fixture("hidden-fake-before-real-archive.md", canonical.replace(/## 附录[\s\S]*$/, appendix));

  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
  const prune = await run(["prune", ledger, "1", "--dry-run"]);

  expect(shown.body?.archived).toBe(true);
  expect(shown.body.text).toContain("actual payload");
  expect(shown.body.text).not.toContain("fake payload");
  expect(prune.code).toBe(0);
});

test("close refuses to append an archive into a hidden appendix heading", async () => {
  const source = canonical.replace("## 附录", "<pre>\n## 附录");
  const ledger = fixture("hidden-appendix-target.md", source);
  const before = readFileSync(ledger, "utf8");

  const closed = await run(["close", ledger, "2", "--keep-body"]);

  expect(closed.code).toBe(3);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("v3 archive record counts preserve empty and trailing payload lines in every read view", async () => {
  for (const [name, payload, wantText] of [
    ["zero", [], ""],
    ["one-empty", [""], "\n"],
    ["edges", ["", "middle", "", "  "], "\nmiddle\n\n  \n"],
  ] as const) {
    const count = payload.length;
    const archive = [
      "### #1 登录页闪烁（已关闭，正文保留）",
      "<!-- issuemd:kept-body:v3 -->",
      "<!-- issuemd:kept-body:start -->",
      `<!-- issuemd:kept-body:lines:${count} -->`,
      ...payload,
      "",
      "<!-- issuemd:kept-body:end -->",
    ].join("\n");
    const ledger = fixture(`v3-records-${name}.md`, canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${archive}\n`));

    const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
    const listed = JSON.parse((await run(["list", ledger, "--closed", "--json", "--with-body"])).stdout);
    const batch = listed.issues.find(({ id }: { id: string }) => id === "1");
    const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);

    expect(shown.body?.lineCount).toBe(count);
    expect(shown.body?.content).toBe(wantText);
    expect(batch.body?.lineCount).toBe(count);
    expect(batch.body?.content).toBe(wantText);
    expect(checked.warnings.filter((warning: { code: string }) => warning.code === "W269")).toEqual([]);
  }
});

test("v3 close/reopen preserves leading and trailing blank payload records", async () => {
  const issueHeading = "### Issue 2: 侧栏宽度不可调";
  const source = canonical
    .replace("**现象**：侧栏固定 240px，无法拖拽。", "\n\n**现象**：侧栏固定 240px，无法拖拽。")
    .replace("**验收判据**：重启后保持上次宽度。\n\n### Issue 3:", "**验收判据**：重启后保持上次宽度。\n  \n\n### Issue 3:");
  const ledger = fixture("v3-edge-roundtrip.md", source);
  const lines = source.split("\n");
  const heading = lines.indexOf(issueHeading);
  const next = lines.findIndex((line, index) => index > heading && line.startsWith("### Issue 3:"));
  const expectedPayload = lines.slice(heading + 1, next);
  const closed = await run(["close", ledger, "2", "--keep-body"]);
  expect(closed.code).toBe(0);
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.body.lineCount).toBe(expectedPayload.length);

  const reopened = await run(["reopen", ledger, "2"]);

  expect(reopened.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(source);
});

test("v3 payload marker text remains payload and count selects the calculated end", async () => {
  const payload = [
    "<!-- issuemd:kept-body:v3 -->",
    "<!-- issuemd:kept-body:start -->",
    "<!-- issuemd:kept-body:lines:0 -->",
    "<!-- issuemd:kept-body:end -->",
  ];
  const archive = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v3 -->",
    "<!-- issuemd:kept-body:start -->",
    `<!-- issuemd:kept-body:lines:${payload.length} -->`,
    ...payload,
    "",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const ledger = fixture("v3-literal-markers.md", canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${archive}\n`));
  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);

  expect(shown.body?.lineCount).toBe(payload.length);
  for (const marker of payload) expect(shown.body.content).toContain(marker);
});

test("v3 W201 counts only LF-joined payload bytes, excluding the frame", async () => {
  for (const [payload, expectedWarnings] of [["abc", 0], ["abcd", 1]] as const) {
    const source = canonical.replace("# Demo Issue 台账\n", "# Demo Issue 台账\n\n<!-- issuemd:limits: body-bytes=3 -->\n");
    const archive = [
      "### #1 登录页闪烁（已关闭，正文保留）",
      "<!-- issuemd:kept-body:v3 -->",
      "<!-- issuemd:kept-body:start -->",
      "<!-- issuemd:kept-body:lines:1 -->",
      payload,
      "",
      "<!-- issuemd:kept-body:end -->",
    ].join("\n");
    const ledger = fixture(`v3-size-${payload.length}.md`, source.replace(/## 附录[\s\S]*$/, `## 附录\n\n${archive}\n`));
    const report = JSON.parse((await run(["check", ledger, "--json"])).stdout);
    const warnings = report.warnings.filter((warning: { code: string; id?: string; message: string }) =>
      warning.code === "W201" && warning.id === "1" && warning.message.startsWith("Archived body"));
    expect(warnings).toHaveLength(expectedWarnings);
    if (expectedWarnings) expect(warnings[0].message).toContain("4 UTF-8 bytes");
  }
});

test("close/reopen keeps W201 bytes equal at and above the v3 payload limit", async () => {
  const basePayload = ["", "**现象**：", "**验收判据**：works", ""];
  const targetSizes = [20_480, 20_481] as const;
  for (const targetBytes of targetSizes) {
    const fixedBytes = Buffer.byteLength(basePayload.join("\n"));
    const filler = "x".repeat(targetBytes - fixedBytes);
    const payload = ["", `**现象**：${filler}`, "**验收判据**：works", ""];
    expect(Buffer.byteLength(payload.join("\n"))).toBe(targetBytes);

    const lines = canonical.replace("# Demo Issue 台账\n", "# Demo Issue 台账\n\n<!-- issuemd:limits: body-bytes=20480 body-lines=300 -->\n").split("\n");
    const heading = lines.findIndex((line) => line.startsWith("### Issue 2:"));
    const next = lines.findIndex((line, index) => index > heading && line.startsWith("### Issue 3:"));
    const source = [...lines.slice(0, heading), lines[heading]!, ...payload, ...lines.slice(next)].join("\n");
    const ledger = fixture(`v3-threshold-${targetBytes}.md`, source);

    const before = JSON.parse((await run(["check", ledger, "--json"])).stdout);
    const beforeW201 = before.warnings.filter((warning: { code: string; id?: string }) => warning.code === "W201" && warning.id === "2");
    expect(beforeW201).toHaveLength(targetBytes > 20_480 ? 1 : 0);

    expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
    const after = JSON.parse((await run(["check", ledger, "--json"])).stdout);
    const afterW201 = after.warnings.filter((warning: { code: string; id?: string }) => warning.code === "W201" && warning.id === "2");
    expect(afterW201).toHaveLength(beforeW201.length);
    if (afterW201.length) expect(afterW201[0].message).toContain(`${targetBytes} UTF-8 bytes`);
    expect((await run(["check", ledger, "--strict"])).code).toBe(targetBytes > 20_480 ? 3 : 0);

    expect((await run(["reopen", ledger, "2"])).code).toBe(0);
    expect(readFileSync(ledger, "utf8")).toBe(source);
  }
});

test("v2 keeps accepting whitespace-padded version, start, and end markers", async () => {
  const v2 = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "  <!-- issuemd:kept-body:v2 -->  ",
    "\t<!-- issuemd:kept-body:start -->\t",
    "payload",
    "  <!-- issuemd:kept-body:end -->  ",
  ].join("\n");
  const ledger = fixture("v2-padded-markers.md", canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${v2}\n`));

  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  const before = readFileSync(ledger, "utf8");

  expect(shown.body?.content).toBe("payload\n");
  expect(checked.warnings.filter((warning: { code: string }) => warning.code === "W269")).toEqual([]);
  expect((await run(["reopen", ledger, "1"])).code).toBe(0);
  expect(readFileSync(ledger, "utf8")).not.toBe(before);
});

test("reopen preserves the H3 following a markerless legacy archive", async () => {
  const payload = "**现象**：legacy evidence\n\n**验收判据**：works";
  const nextHeading = "### #3 导出 CSV 丢空行（已关闭，正文保留）\nnext archive evidence";
  const source = canonical.replace(
    /## 附录[\s\S]*$/,
    `## 附录\n\n### #2 侧栏宽度不可调（已关闭，正文保留）\n${payload}\n\n${nextHeading}\n`,
  );
  const ledger = fixture("legacy-next-heading.md", source);

  expect((await run(["reopen", ledger, "2"])).code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toContain("### #3 导出 CSV 丢空行（已关闭，正文保留）");
});

test("prune refuses an archive example inside a CDATA raw HTML block", async () => {
  const example = [
    "## 附录",
    "",
    "<![CDATA[",
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v3 -->",
    "<!-- issuemd:kept-body:start -->",
    "<!-- issuemd:kept-body:lines:1 -->",
    "example payload",
    "",
    "<!-- issuemd:kept-body:end -->",
    "### End example",
    "]]>",
    "",
  ].join("\n");
  const ledger = fixture("cdata-archive-example.md", canonical.replace(/## 附录[\s\S]*$/, example));

  const result = await run(["prune", ledger, "1", "--dry-run"]);

  expect(result.code).toBe(1);
});

test("a closed raw-text HTML block does not hide a following archive", async () => {
  const archive = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v3 -->",
    "<!-- issuemd:kept-body:start -->",
    "<!-- issuemd:kept-body:lines:1 -->",
    "archive payload",
    "",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const appendix = ["## 附录", "", "<pre>", "<!--", "</pre>", "", archive, ""].join("\n");
  const ledger = fixture("raw-text-comment-boundary.md", canonical.replace(/## 附录[\s\S]*$/, appendix));

  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);

  expect(shown.body?.archived).toBe(true);
  expect(shown.body.content).toContain("archive payload");
  expect(checked.warnings.filter((warning: { code: string }) => warning.code === "W269")).toEqual([]);
});

test("a v3 archive missing its version line is refused instead of downgraded to legacy", async () => {
  const archive = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v3 -->",
    "<!-- issuemd:kept-body:start -->",
    "<!-- issuemd:kept-body:lines:1 -->",
    "archive payload",
    "",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const ledger = fixture("v3-missing-version.md", canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${archive}\n`).replace("<!-- issuemd:kept-body:v3 -->\n", ""));
  const before = readFileSync(ledger, "utf8");

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  const reopened = await run(["reopen", ledger, "1"]);

  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W269" }));
  expect(reopened.code).toBe(3);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("reopen refuses when it would hide another archive with an unfinished comment", async () => {
  const first = [
    "### #5 支持 IE11（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v3 -->",
    "<!-- issuemd:kept-body:start -->",
    "<!-- issuemd:kept-body:lines:1 -->",
    "other archive payload",
    "",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const second = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v3 -->",
    "<!-- issuemd:kept-body:start -->",
    "<!-- issuemd:kept-body:lines:1 -->",
    "<!--",
    "",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const ledger = fixture("reopen-comment-hides-archive.md", canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${first}\n\n${second}\n`));
  const before = readFileSync(ledger, "utf8");

  const reopened = await run(["reopen", ledger, "1"]);

  expect(reopened.code).toBe(3);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  const shown = JSON.parse((await run(["show", ledger, "5", "--json"])).stdout);
  expect(shown.body?.archived).toBe(true);
});

test("malformed v3 and v2 boundaries produce W269 and refuse reopen/prune", async () => {
  const malformedV3 = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v3 -->",
    "<!-- issuemd:kept-body:start -->",
    "<!-- issuemd:kept-body:lines:1 -->",
    "<pre>",
    "",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const ledger = fixture("v3-hidden-end.md", canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${malformedV3}\n`));
  const before = readFileSync(ledger, "utf8");

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W269" }));
  expect((await run(["reopen", ledger, "1"])).code).toBe(3);
  expect((await run(["prune", ledger, "1", "--dry-run"])).code).toBe(2);
  expect(readFileSync(ledger, "utf8")).toBe(before);

  const malformedV2 = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v2 -->",
    "<!-- issuemd:kept-body:end -->",
    "<!-- issuemd:kept-body:start -->",
    "payload after end",
  ].join("\n");
  const old = fixture("v2-end-before-payload.md", canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${malformedV2}\n`));
  expect(JSON.parse((await run(["check", old, "--json"])).stdout).warnings)
    .toContainEqual(expect.objectContaining({ code: "W269" }));
  const oldBefore = readFileSync(old, "utf8");
  expect((await run(["reopen", old, "1"])).code).toBe(3);
  expect(readFileSync(old, "utf8")).toBe(oldBefore);
});

test("v2 keeps literal lines metadata and the positional separator compatibility shape", async () => {
  const plain = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v2 -->",
    "<!-- issuemd:kept-body:start -->",
    "<!-- issuemd:kept-body:lines:1 -->",
    "<!-- issuemd:kept-body:separator -->",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const ledger = fixture("v2-literal-v3-metadata.md", canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${plain}\n`));
  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
  expect(shown.body.content).toContain("kept-body:lines:1");
  expect(shown.body.content).toContain("kept-body:separator");

  const compatible = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "<!-- issuemd:kept-body:v2 -->",
    "<!-- issuemd:kept-body:start -->",
    "payload",
    "",
    "<!-- issuemd:kept-body:separator -->",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const legacyV2 = fixture("v2-inflight-separator.md", canonical.replace(/## 附录[\s\S]*$/, `## 附录\n\n${compatible}\n`));
  const compatibleView = JSON.parse((await run(["show", legacyV2, "1", "--json"])).stdout);
  expect(compatibleView.body.content).toBe("payload\n");
});

test("close stores literal archive marker text in a counted v3 payload", async () => {
  const ledger = fixture("v3-marker-payload.md", canonical);
  const body = fixture("v3-marker-payload.body", [
    "**现象**：marker literal",
    "<!-- issuemd:kept-body:end -->",
    "<!-- issuemd:kept-body:lines:0 -->",
    "",
    "**验收判据**：works",
  ].join("\n"));

  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const openLines = readFileSync(ledger, "utf8").split("\n");
  const issueStart = openLines.findIndex((line) => line.startsWith("### Issue 2:"));
  const nextIssue = openLines.findIndex((line, index) => index > issueStart && line.startsWith("### Issue 3:"));
  const payloadCount = nextIssue - issueStart - 1;
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.body?.lineCount).toBe(payloadCount);
  expect(shown.body.content).toContain("<!-- issuemd:kept-body:end -->");
  expect(readFileSync(ledger, "utf8")).toContain(`<!-- issuemd:kept-body:lines:${payloadCount} -->`);
});

test("close refuses unclosed raw-text HTML without changing the ledger", async () => {
  const ledger = await bodyLedger("unclosed-pre-close", "**现象**：evidence\n\n**验收判据**：works\n\n<pre>\nraw evidence\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["close", ledger, "2", "--keep-body"]);

  expect(result.code).toBe(3);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("sync --fix-hashes skips a reference definition title on the following line", async () => {
  const ledger = await bodyLedger("reference-title", "**现象**：reference\n\n[ref]: /file\n  \"deadbee\"\n\nSee [ref]\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("sync --fix-hashes skips digit-leading email autolinks with one-letter TLDs", async () => {
  const ledger = await bodyLedger("digit-email-autolink", "**现象**：Contact <123+deadbee@x.y>\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("sync --fix-hashes skips reference link labels at the use site", async () => {
  const ledger = await bodyLedger("reference-use-site", "**现象**：See [details][deadbee]\n\n[deadbee]: /builds/latest\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("sync --fix-hashes skips shortcut and collapsed reference labels", async () => {
  const ledger = await bodyLedger("reference-shortcut", "**现象**：See [deadbee] and [deadbee][]\n\n[deadbee]: /builds/latest\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("sync --fix-hashes skips an unindented reference title on the next line", async () => {
  const ledger = await bodyLedger("reference-unindented-title", "**现象**：reference\n\n[ref]: /file\n\"deadbee\"\n\nSee [ref]\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("sync --fix-hashes skips a hash escaped by a preceding backslash", async () => {
  const ledger = await bodyLedger("escaped-hash", "**现象**：C:\\build\\deadbee\\out\n\n**验收判据**：works\n");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(result.stderr).toContain("escaped");
});

test("multiline code spans continue across an ordered list marker 2", async () => {
  const ledger = await bodyLedger("ordered-list-continuation", "**现象**：Example `before\n2. deadbee\nafter` remains code\n\n**验收判据**：works\n");

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings.filter((warning: { code: string }) => warning.code === "W202")).toEqual([]);
});

test("sync --fix-hashes handles thousands of safe link ranges without quadratic growth", async () => {
  const links = Array.from({ length: 6000 }, (_, index) => `[x${index}](target-${index})`).join(" ");
  const ledger = await bodyLedger("many-safe-links", `**现象**：${links}\n\n**验收判据**：works\n`);
  const start = performance.now();

  const result = await run(["sync", ledger, "--fix-hashes"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("(no changes)\n");
  expect(performance.now() - start).toBeLessThan(1500);
});
