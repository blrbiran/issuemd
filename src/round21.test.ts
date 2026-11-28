import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-round21-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

test("bold prose inside criteria remains content instead of ending the block", async () => {
  const ledger = fixture("bold-prose-ledger.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("bold-prose-body.md", [
    "**现象**：probe",
    "",
    "**验收判据**",
    "",
    "1. 第一条。",
    "",
    "**必须**先跑完 A 再跑 B，否则整条不算。",
    "",
    "2. 第二条。",
    "3. 第三条。",
    "",
  ].join("\n"));

  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const shown = await run(["show", ledger, "2", "--json"]);
  const issue = JSON.parse(shown.stdout);
  expect(issue.labels).not.toHaveProperty("必须");
  expect(issue.labels["验收判据"]).toContain("2. 第二条。");
  expect(issue.labels["验收判据"]).toContain("3. 第三条。");
  expect(issue.criteria).toContain("必须**先跑完 A 再跑 B");
  expect(issue.criteria).toContain("2. 第二条。");
  expect(issue.criteria).toContain("3. 第三条。");

  const closed = await run(["close", ledger, "2", "--criteria-from-body", "--dry-run"]);
  expect(closed.code).toBe(2);
  expect(closed.stderr).toContain("W268");
  expect(closed.stdout).toBe("");
  expect(readFileSync(ledger, "utf8")).toContain("3. 第三条。");
});

test("empty body replacement is an explicit no-op", async () => {
  const ledger = fixture("empty-replacement-ledger.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const empty = fixture("empty-body.md", "");
  const before = readFileSync(ledger, "utf8");

  const result = await run(["body", ledger, "2", "--body-file", empty]);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("(no changes)\n");
  expect(result.stderr).toBe("");
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("nearby criteria blocks are reported and block lossy close", async () => {
  const ledger = fixture("nearby-criteria-ledger.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("nearby-criteria-body.md", [
    "**现象**：probe",
    "",
    "**验收判据**：",
    "1. 第一条。",
    "",
    "**验收判据（追加）**：",
    "2. 第二条。",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const checked = await run(["check", ledger, "--json"]);
  const diagnostics = JSON.parse(checked.stdout);
  expect(diagnostics.warnings).toContainEqual(expect.objectContaining({
    code: "W264",
    id: "2",
    message: expect.stringContaining("验收判据（追加）"),
  }));

  const close = await run(["close", ledger, "2", "--criteria-from-body"]);
  expect(close.code).toBe(2);
  expect(close.stderr).toContain("验收判据（追加）");
  expect(readFileSync(ledger, "utf8")).toContain("2. 第二条。");
});

test("supplemental 判据 labels after canonical criteria block lossy close", async () => {
  const ledger = fixture("additional-criteria-ledger.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("additional-criteria-body.md", [
    "**现象**：probe",
    "",
    "**验收判据**：first",
    "",
    "**追加判据**：second",
    "",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const report = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W264", id: "2" }));
  const close = await run(["close", ledger, "2", "--criteria-from-body"]);
  expect(close.code).toBe(2);
  expect(close.stderr).toContain("追加判据");
  expect(readFileSync(ledger, "utf8")).toContain("second");
});

test("W264 ignores review notes that merely mention criteria", async () => {
  const ledger = fixture("criteria-review-note.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("criteria-review-note-body.md", [
    "**验收判据**：first",
    "",
    "**复核更正：判据 3 已成立**：不要重复实现。",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const report = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(report.warnings).not.toContainEqual(expect.objectContaining({ code: "W264", id: "2" }));
});

test("closed keep-body archives are readable by show and list", async () => {
  const ledger = fixture("archive-read-ledger.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("archive-read-body.md", "**现象**：historical evidence\n\n**验收判据**：criterion\n");
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  const expectedPayload = "\n**现象**：historical evidence\n\n**验收判据**：criterion\n\n";
  expect(shown.body).toMatchObject({ archived: true, id: "2", text: expectedPayload, content: expectedPayload });

  const bodyOnly = await run(["show", ledger, "2", "--body-only"]);
  expect(bodyOnly.code).toBe(0);
  expect(bodyOnly.stdout).toBe(expectedPayload);

  const listed = JSON.parse((await run(["list", ledger, "--closed", "--json", "--with-body"])).stdout);
  expect(listed.issues.find(({ id }: { id: string }) => id === "2")?.body).toEqual(shown.body);
});

test("archive reads refuse duplicate copies across appendix sections", async () => {
  const ledger = fixture("archive-read-duplicates.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
  const source = readFileSync(ledger, "utf8");
  const archiveStart = source.indexOf("### #2 ");
  const endMarker = "<!-- issuemd:kept-body:end -->";
  const archiveEnd = source.indexOf(endMarker, archiveStart) + endMarker.length;
  const archive = archiveStart >= 0 && archiveEnd >= endMarker.length ? source.slice(archiveStart, archiveEnd) : undefined;
  expect(archive).toBeDefined();
  writeFileSync(ledger, `${source.trimEnd()}\n\n## 附录\n\n${archive}\n`);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.body).toBeUndefined();
  const bodyOnly = await run(["show", ledger, "2", "--body-only"]);
  expect(bodyOnly.code).toBe(1);
  expect(bodyOnly.stdout).toBe("");
  const listed = JSON.parse((await run(["list", ledger, "--closed", "--json", "--with-body"])).stdout);
  expect(listed.issues.find(({ id }: { id: string }) => id === "2")?.body).toBeUndefined();
});

test("archive reads withhold malformed v2 payload boundaries", async () => {
  const ledger = fixture("archive-read-malformed-v2.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
  writeFileSync(ledger, readFileSync(ledger, "utf8").replace("<!-- issuemd:kept-body:start -->", "<!-- issuemd:kept-body:start-broken -->"));
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.body).toBeUndefined();
  const listed = JSON.parse((await run(["list", ledger, "--closed", "--json", "--with-body"])).stdout);
  expect(listed.issues.find(({ id }: { id: string }) => id === "2")?.body).toBeUndefined();
});


test("legacy archive reads preserve literal end markers and following content", async () => {
  const original = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
  const legacy = [
    "### #1 登录页闪烁（已关闭，正文保留）",
    "> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。",
    "legacy before",
    "<!-- issuemd:kept-body:end -->",
    "literal legacy marker and following text",
    "<!-- issuemd:kept-body:end -->",
  ].join("\n");
  const ledger = fixture("legacy-archive-read.md", original.replace("## 附录\n", `## 附录\n\n${legacy}\n`));

  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
  const expectedPayload = "> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。\nlegacy before\n<!-- issuemd:kept-body:end -->\nliteral legacy marker and following text\n";
  expect(shown.body).toMatchObject({ archived: true, id: "1", text: expectedPayload, content: expectedPayload });
  expect((await run(["show", ledger, "1", "--body-only"])).stdout).toBe(expectedPayload);
  const listed = JSON.parse((await run(["list", ledger, "--closed", "--json", "--with-body"])).stdout);
  expect(listed.issues.find(({ id }: { id: string }) => id === "1")?.body.text).toBe(expectedPayload);
});

test.each([true, false])("markerless legacy archive at EOF preserves final-newline=%j", async (finalNewline) => {
  const original = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
  const beforeAppendix = original.slice(0, original.indexOf("## 附录\n")).trimEnd();
  const content = `${beforeAppendix}\n\n## 附录\n\n### #1 登录页闪烁（已关闭，正文保留）\n\nlegacy payload${finalNewline ? "\n" : ""}`;
  const ledger = fixture(`legacy-eof-${finalNewline}.md`, content);
  const expected = `\nlegacy payload${finalNewline ? "\n" : ""}`;
  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
  expect(shown.body.text).toBe(expected);
  expect((await run(["show", ledger, "1", "--body-only"])).stdout).toBe(expected);
  const listed = JSON.parse((await run(["list", ledger, "--closed", "--json", "--with-body"])).stdout);
  expect(listed.issues.find(({ id }: { id: string }) => id === "1")?.body.text).toBe(expected);
});

test.each(["\n", "\r\n"])("the CLI preserves an unterminated markerless body-only result with %j input", async (eol) => {
  const original = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
  const beforeAppendix = original.slice(0, original.indexOf("## 附录\n")).trimEnd();
  const sourceLf = `${beforeAppendix}\n\n## 附录\n\n### #1 登录页闪烁（已关闭，正文保留）\nlegacy payload`;
  const source = eol === "\n" ? sourceLf : sourceLf.replaceAll("\n", eol);
  const ledger = fixture(`legacy-executable-${eol === "\n" ? "lf" : "crlf"}.md`, source);
  const child = spawnSync(process.execPath, [join(import.meta.dir, "../bin/issuemd.ts"), "show", ledger, "1", "--body-only"], { encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("legacy payload");
  expect(child.stderr).toBe("");
});

test("the CLI preserves unterminated open body-only output", async () => {
  const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
  const ledger = fixture("open-body-only-eof.md", canonical.slice(0, canonical.indexOf("\n## 附录\n")).replace(/\n+$/, ""));
  const expected = await run(["show", ledger, "4", "--body-only"]);
  expect(expected.code).toBe(0);
  expect(expected.stdout.endsWith("\n")).toBe(false);
  const child = spawnSync(process.execPath, [join(import.meta.dir, "../bin/issuemd.ts"), "show", ledger, "4", "--body-only"], { encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(child.stdout).toBe(expected.stdout);
  expect(child.stderr).toBe("");
});


test("archive reads ignore an H1 named 附录 and require a real appendix H2", async () => {
  const original = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8")
    .replace("# Demo Issue 台账", "# 附录")
    .replace("\n## 怎么用\n", "\n### #1 登录页闪烁（已关闭，正文保留）\nThis is an example, not an archive.\n\n## 怎么用\n")
    .replace("\n## 附录\n", "\n## 附录\n\n### #1 登录页闪烁（已关闭，正文保留）\n<!-- issuemd:kept-body:v2 -->\n<!-- issuemd:kept-body:start -->\n\nactual archive payload\n<!-- issuemd:kept-body:end -->\n");
  const ledger = fixture("archive-scope.md", original);

  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings.filter(({ code }: { code: string }) => code === "W250")).toHaveLength(1);
  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
  expect(shown.body.text).toContain("actual archive payload");
  expect(shown.body.text).not.toContain("This is an example");
  const listed = JSON.parse((await run(["list", ledger, "--closed", "--json", "--with-body"])).stdout);
  expect(listed.issues.find(({ id }: { id: string }) => id === "1")?.body.text).toContain("actual archive payload");
});

test("close with criteria updates an existing closed row without reopening", async () => {
  const ledger = fixture("closed-criteria-update.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const before = readFileSync(ledger, "utf8");
  const preview = await run(["close", ledger, "1", "--criteria", "corrected criterion", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stdout).toContain("corrected criterion");
  expect(preview.stderr).toContain("updated #1 criteria:");
  expect(readFileSync(ledger, "utf8")).toBe(before);

  const updated = await run(["close", ledger, "1", "--criteria", "corrected criterion"]);
  expect(updated.code).toBe(0);
  expect(updated.stderr).toContain('"`a1b2c3d`：连续 3 轮 12/12" → "corrected criterion"');
  expect(readFileSync(ledger, "utf8")).toContain("| 1 | 已修 | P3 | 登录页闪烁 | corrected criterion |");
  expect((await run(["check", ledger])).code).toBe(0);
});

test("closed criteria update preserves trailing backslashes on compact table rows", async () => {
  const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
  const ledger = fixture("closed-criteria-compact.md", canonical.replace(
    "| 1 | 已修 | P3 | 登录页闪烁 | `a1b2c3d`：连续 3 轮 12/12 |",
    "|1|已修|P3|登录页闪烁|old|",
  ));
  const result = await run(["close", ledger, "1", "--criteria", "evidence\\"]);
  expect(result.code).toBe(0);
  const shown = JSON.parse((await run(["show", ledger, "1", "--json"])).stdout);
  expect(shown.criteria).toBe("evidence\\");
  expect(result.stderr).toContain('"old" → "evidence\\\\"');
});

test("closed criteria update preserves trailing backslashes on padded table rows", async () => {
  const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
  const ledger = fixture("closed-criteria-padded.md", canonical.replace(
    "| 1 | 已修 | P3 | 登录页闪烁 | `a1b2c3d`：连续 3 轮 12/12 |",
    "| 1 | 已修 | P3 | 登录页闪烁 | old |",
  ));
  const result = await run(["close", ledger, "1", "--criteria", "evidence\\"]);
  expect(result.code).toBe(0);
  expect(JSON.parse((await run(["show", ledger, "1", "--json"])).stdout).criteria).toBe("evidence\\");
});

test("new preserves its high-water id after a closed row is removed", async () => {
  const ledger = fixture("high-water-ledger.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const first = await run(["new", ledger, "--title", "temporary history"]);
  expect(first.code).toBe(0);
  const retired = first.stdout.trim();
  expect(readFileSync(ledger, "utf8")).toContain(`<!-- issuemd:high-water: ${retired} -->`);
  expect((await run(["close", ledger, retired, "--status", "已修", "--criteria", "recorded"])).code).toBe(0);

  const withoutRow = readFileSync(ledger, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith(`| ${retired} |`))
    .join("\n");
  writeFileSync(ledger, withoutRow);
  const checked = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(checked.warnings).toContainEqual(expect.objectContaining({
    code: "W265",
    message: expect.stringContaining(retired),
  }));

  const next = await run(["new", ledger, "--title", "after removed history"]);
  expect(Number(next.stdout.trim())).toBe(Number(retired) + 1);
});

test("high-water marker examples in preamble prose do not block new IDs", async () => {
  const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
  const ledger = fixture("high-water-example.md", canonical.replace(
    "> 唯一台账 + 唯一正文。状态只在下表；正文不写状态。编号不回收。",
    "> 唯一台账 + 唯一正文。状态只在下表；正文不写状态。编号不回收。\n> Marker syntax example: `<!-- issuemd:high-water: 500 -->`\n\n```html\n<!-- issuemd:high-water: 700 -->\n```",
  ));
  const created = await run(["new", ledger, "--title", "still allocates"]);
  expect(created.code).toBe(0);
  expect(created.stdout.trim()).toBe("21");
  expect(JSON.parse((await run(["check", ledger, "--json"])).stdout).warnings)
    .not.toContainEqual(expect.objectContaining({ code: "W265" }));
});

test("sync repairs one unambiguous nearby criteria label", async () => {
  const ledger = fixture("criteria-label-sync.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("criteria-label-sync-body.md", "**现象**：probe\n\n**判据**：\n1. 必须成功。\n");
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const preview = await run(["sync", ledger, "--criteria-labels", "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stdout).toContain("**验收判据**");
  expect(preview.stdout).not.toContain("+**判据**");
  expect(preview.stderr).toContain("updated #2 criteria label");
  expect(readFileSync(ledger, "utf8")).toContain("**判据**：");

  const applied = await run(["sync", ledger, "--criteria-labels"]);
  expect(applied.code).toBe(0);
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.criteria).toBe("1. 必须成功。");
  expect(shown.labels).toHaveProperty("验收判据");
  expect(shown.labels).not.toHaveProperty("判据");
  expect(JSON.parse((await run(["check", ledger, "--json"])).stdout).warnings)
    .not.toContainEqual(expect.objectContaining({ code: "W261", id: "2" }));
});

test("sync repairs an unambiguous descriptive 判据 alias", async () => {
  const ledger = fixture("criteria-descriptive-alias.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("criteria-descriptive-alias.txt", "**本案例可复现的判据**：\n1. 命令返回 0。\n");
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  expect((await run(["sync", ledger, "--criteria-labels"])).code).toBe(0);
  expect(JSON.parse((await run(["show", ledger, "2", "--json"])).stdout).criteria).toBe("1. 命令返回 0。");
});

test("criteria-label sync does not rename historical closing criteria", async () => {
  const ledger = fixture("historical-criteria-label.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("historical-criteria-label-body.md", "**现象**：reopened issue\n\n**关闭时判据**：the old closed decision\n");
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const before = readFileSync(ledger, "utf8");

  const sync = await run(["sync", ledger, "--criteria-labels"]);
  expect(sync.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(before);
  expect(JSON.parse((await run(["check", ledger, "--json"])).stdout).warnings)
    .toContainEqual(expect.objectContaining({ code: "W261", id: "2" }));
});

test("JSON exposes lossless label lines alongside flattened labels", async () => {
  const ledger = fixture("label-lines-ledger.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("label-lines-body.md", [
    "**现象**：first paragraph",
    "",
    "```sh",
    "echo a | b",
    "```",
    "",
    "second paragraph",
    "",
    "**验收判据**：criterion",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.labels["现象"]).toContain("first paragraph");
  expect(shown.labelBlocks["现象"]).toEqual([
    "**现象**：first paragraph",
    "",
    "```sh",
    "echo a | b",
    "```",
    "",
    "second paragraph",
  ]);
  const labeled = JSON.parse((await run(["show", ledger, "2", "--json", "--label", "现象"])).stdout);
  expect(labeled.paragraphLines).toEqual(shown.labelBlocks["现象"]);

  const listed = JSON.parse((await run(["list", ledger, "--json", "--with-body"])).stdout);
  expect(listed.issues.find(({ id }: { id: string }) => id === "2")?.labelBlocks["现象"])
    .toEqual(shown.labelBlocks["现象"]);
});

test("bold Q/A dialogue labels remain readable without duplicate-label warnings", async () => {
  const ledger = fixture("qa-labels-ledger.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("qa-labels-body.md", "**现象**：x\n\n**Q：** 为什么？\n**A：** 因为。\n**Q：** 还有？\n**A：** 没了。\n");
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.labels.Q).toContain("为什么？");
  expect(shown.labels.A).toContain("因为。");
  const question = await run(["show", ledger, "2", "--label", "Q"]);
  expect(question.code).toBe(0);
  expect(question.stdout).toContain("为什么？");
  expect(JSON.parse((await run(["check", ledger, "--json"])).stdout).warnings.map(({ code }: { code: string }) => code))
    .not.toContain("W206");
});

test("JSON body.content is the machine-readable body-only form", async () => {
  const ledger = fixture("body-content-ledger.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("body-content-input.md", "**现象**：first paragraph\n\nsecond paragraph\n");
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const expected = "**现象**：first paragraph\n\nsecond paragraph";

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.body.content).toBe(expected);
  expect(shown.body.text).toContain("### Issue 2:");
  const bodyOnly = await run(["show", ledger, "2", "--body-only"]);
  expect(bodyOnly.stdout).toBe(`${expected}\n`);
  const listed = JSON.parse((await run(["list", ledger, "--json", "--with-body"])).stdout);
  expect(listed.issues.find(({ id }: { id: string }) => id === "2")?.body.content).toBe(expected);

  const before = readFileSync(ledger, "utf8");
  const mistaken = fixture("body-content-mistaken.md", shown.body.text);
  const refused = await run(["body", ledger, "2", "--body-file", mistaken]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("body.content");
  const roundTrip = fixture("body-content-roundtrip.md", shown.body.content);
  expect((await run(["body", ledger, "2", "--body-file", roundTrip])).stdout).toContain("(no changes)");
  expect(readFileSync(ledger, "utf8")).toBe(before);
});

test("criteria ends after its final list before ordinary status prose", async () => {
  const ledger = fixture("criteria-status-boundary.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("criteria-status-body.md", [
    "**现象**：probe",
    "",
    "**验收判据**",
    "",
    "1. 重启后保持上次宽度。",
    "2. 拖拽到 1000px。",
    "",
    "   恢复后的宽度必须保持精确的 1000px。",
    "",
    "当前状态：判据 1 已达标，判据 2 未验证。",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  const expectedCriteria = "1. 重启后保持上次宽度。；2. 拖拽到 1000px。；恢复后的宽度必须保持精确的 1000px。";
  expect(shown.criteria).toBe(expectedCriteria);
  expect(shown.body.text).toContain("当前状态：判据 1 已达标");
  const close = await run(["close", ledger, "2", "--criteria-from-body", "--dry-run"]);
  expect(close.stdout).toContain("拖拽到 1000px");
  expect(close.stdout).toContain(`+| 2 | 已修 | P1 | 侧栏宽度不可调 | ${expectedCriteria} |`);
});

test.each([" \t", "\t "])("criteria keeps continuations indented by mixed whitespace (%j)", async (indent) => {
  const suffix = indent.startsWith(" ") ? "space-tab" : "tab-space";
  const ledger = fixture(`criteria-mixed-indent-${suffix}.md`, readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const continuation = `${indent}恢复后的宽度必须保持精确的 1000px。`;
  const body = fixture(`criteria-mixed-indent-${suffix}.txt`, [
    "**验收判据**",
    "1. Restart succeeds.",
    "",
    continuation,
    "",
    "当前状态：判据仍未验证。",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.criteria).toContain("恢复后的宽度必须保持精确的 1000px。");
  expect(shown.criteria).not.toContain("当前状态：");
});

test("criteria keeps bullet-list continuations at their marker content column", async () => {
  const ledger = fixture("criteria-bullet-continuation.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("criteria-bullet-continuation.txt", [
    "**验收判据**",
    "",
    "- Restart succeeds.",
    "",
    "  The restored width must be exactly 900px.",
    "",
    "Current status: still unverified.",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.criteria).toBe("Restart succeeds.；The restored width must be exactly 900px.");
  expect(shown.criteria).not.toContain("Current status:");
  const close = await run(["close", ledger, "2", "--criteria-from-body", "--dry-run"]);
  expect(close.stdout).toContain("The restored width must be exactly 900px.");
  expect(close.stdout).not.toContain("+| 2 | 已修 | P1 | 侧栏宽度不可调 | Restart succeeds.；The restored width must be exactly 900px.；Current status:");
});

test("criteria keeps parent-list continuations after nested list items", async () => {
  const ledger = fixture("criteria-parent-list.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("criteria-parent-list.txt", [
    "**验收判据**",
    "",
    "- Restart succeeds.",
    "  - Check the restored window.",
    "  ```md",
    "  100. example",
    "  ```",
    "",
    "  The restored width must be exactly 900px.",
    "",
    "Current status: still unverified.",
  ].join("\n"));
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.criteria).toBe("Restart succeeds.；Check the restored window.；100. example；The restored width must be exactly 900px.");
  const close = await run(["close", ledger, "2", "--criteria-from-body", "--dry-run"]);
  expect(close.stdout).toContain("+| 2 | 已修 | P1 | 侧栏宽度不可调 | Restart succeeds.；Check the restored window.；100. example；The restored width must be exactly 900px. |");
});

test("body append moves unlabelled retest notes outside the criteria block", async () => {
  const ledger = fixture("append-criteria-note.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  const body = fixture("append-criteria-body.md", "**现象**：probe\n\n**验收判据**\n\n1. 重新启动成功。\n");
  const retest = fixture("append-criteria-note.txt", "复测：重新启动仍然失败。\n");
  expect((await run(["body", ledger, "2", "--body-file", body])).code).toBe(0);

  const appended = await run(["body", ledger, "2", "--append", "--body-file", retest]);
  expect(appended.code).toBe(0);
  const shown = JSON.parse((await run(["show", ledger, "2", "--json"])).stdout);
  expect(shown.criteria).toBe("1. 重新启动成功。");
  expect(shown.labels["复测记录"]).toContain("复测：重新启动仍然失败。");

  const skeleton = fixture("append-empty-criteria.md", readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8"));
  expect((await run(["new", skeleton, "--title", "empty criteria append"])).code).toBe(0);
  const emptyRetest = fixture("append-empty-criteria.txt", "复测：仍然失败。\n");
  expect((await run(["body", skeleton, "21", "--append", "--body-file", emptyRetest])).code).toBe(0);
  const report = JSON.parse((await run(["check", skeleton, "--json"])).stdout);
  expect(report.warnings).toContainEqual(expect.objectContaining({ code: "W261", id: "21" }));
});

test("unknown commands keep failure status when help is requested", async () => {
  const result = await run(["misspelled", "--help"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("unknown command 'misspelled'");
});

test("version flag reports the package version and appears in help", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const version = await run(["--version"]);
  expect(version).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: "" });
  expect((await run(["--help"])).stdout).toContain("issuemd --version");
});
