import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-round19-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, text = canonical): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

const criterion = "**验收判据**：重启后保持上次宽度。";
const table = (id: string) => `| # | 摘要 |\n|---|---|\n| ${id} | 引用编号 |`;

for (const [id, cited, explicit] of [["21", "21", false], ["30", "30", true], ["21", "21–30", false]] as const) {
  test(`#98 rejects incoming reference ${cited} when new selects ${id}`, async () => {
    const ledger = fixture(`collision-${cited}.md`);
    const body = fixture(`incoming-${cited}.md`, `${table(cited)}\n\n${criterion}\n`);
    const args = ["new", ledger, "--title", "新问题", "--body-file", body, ...(explicit ? ["--id", id] : [])];
    for (const flags of [["--dry-run"], []]) {
      const result = await run([...args, ...flags]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(id);
      expect(result.stderr).toContain(cited);
      expect(result.stderr).toMatch(/reserved.*L\d+/);
      expect(readFileSync(ledger, "utf8")).toBe(canonical);
    }
  });
}

test("#98 permits citing an existing different issue in a new body", async () => {
  const ledger = fixture("legal-citation.md");
  const body = fixture("legal-body.md", `${table("3")}\n\n${criterion}\n`);
  expect((await run(["new", ledger, "--title", "新问题", "--body-file", body])).stdout).toBe("21\n");
  const result = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.citedRows).toEqual([expect.objectContaining({ ids: ["3"] })]);
});

for (const [name, open, close, warnings] of [
  ["inline", "提到 `<!--`。", "提到 `-->`。", []],
  ["table", "<!-- unfinished", "| 说明 | --> |", ["W262"]],
  ["fence", "<!-- unfinished", "```html\n-->\n```", ["W262"]],
  ["list-fence", "<!-- unfinished", "- 示例\n\n  ```html\n  -->\n  ```", ["W262"]],
  ["prose", "<!-- unfinished", "一段提到 --> 的普通说明。", ["W262"]],
] as const) {
  test(`#100 ${name} delimiters preserve citations`, async () => {
    const source = `${canonical.trimEnd()}\n\n${open}\n\n${table("21")}\n`;
    for (const [phase, suffix] of [["before", ""], ["after", `\n${close}\n`]]) {
      const ledger = fixture(`comment-${name}-${phase}.md`, source + suffix);
      const result = JSON.parse((await run(["check", ledger, "--json"])).stdout);
      expect(result.warnings.map((warning: { code: string }) => warning.code)).toEqual([...warnings]);
      expect(result.citedRows).toEqual([expect.objectContaining({ ids: ["21"] })]);
      expect((await run(["new", ledger, "--id", "21", "--title", "不可用", "--dry-run"])).code).toBe(2);
    }
  });
}

for (const [name, source] of [
  ["section", canonical.replace("## 附录\n", `<!-- unfinished\n\n## 附录\n\n${table("21")}\n\n-->\n`)],
  ["issue", canonical.replace(criterion, `${criterion}\n\n<!-- unfinished`).replace(/(### Issue 3:[^\n]+\n)/, `$1\n${table("21")}\n\n-->\n`)],
] as const) {
  test(`#100 a closer in a later ${name} cannot hide an unrelated table`, async () => {
    const ledger = fixture(`comment-boundary-${name}.md`, source);
    const result = JSON.parse((await run(["check", ledger, "--json"])).stdout);
    expect(result.warnings.map((warning: { code: string }) => warning.code)).toContain("W262");
    expect(result.citedRows).toEqual([expect.objectContaining({ ids: ["21"] })]);
  });
}

test("#100 an archive's end marker isolates an unfinished comment from later citations", async () => {
  const ledger = fixture("comment-archive-source.md", canonical.replace(criterion, `${criterion}\n\n<!-- unfinished`));
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
  const extended = fixture("comment-after-archive.md", `${readFileSync(ledger, "utf8").trimEnd()}\n\n${table("21")}\n\n-->\n`);
  const result = JSON.parse((await run(["check", extended, "--json"])).stdout);
  expect(result.warnings.map((warning: { code: string }) => warning.code)).toContain("W262");
  expect(result.citedRows).toEqual([expect.objectContaining({ ids: ["21"] })]);
});

test("#100 a raw delimiter in a legacy managed heading cannot open a comment", async () => {
  const heading = "旧标题提到 <!-- 分隔符";
  const source = canonical.replaceAll("侧栏宽度不可调", heading).replace(criterion, `${criterion}\n\n${table("21")}\n\n-->`);
  const ledger = fixture("comment-legacy-heading.md", source);
  const result = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.citedRows).toEqual([expect.objectContaining({ ids: ["21"] })]);
});

test("#100 an actual closed comment still hides an example table in its scope", async () => {
  const ledger = fixture("comment-closed.md", `${canonical.trimEnd()}\n\n**备注**：<!-- 示例\n${table("21")}\n--> 补充说明\n`);
  const result = JSON.parse((await run(["check", ledger, "--json"])).stdout);
  expect(result.warnings).toEqual([]);
  expect(result.citedRows).toBeUndefined();
});

for (const [label, bom, eol] of [["lf", "", "\n"], ["bom-crlf", "﻿", "\r\n"]] as const) {
  test(`#97 extracts a long owned body and round trips ${label} without rewriting bytes`, async () => {
    const long = "资料".repeat(1250);
    const heading = "### Issue 2: 侧栏宽度不可调";
    const source = canonical.slice(0, canonical.indexOf(heading)) + `${heading}\n\n  \n**现象**：${long}  \n\n${criterion}`;
    const original = bom + source.replaceAll("\n", eol);
    const ledger = fixture(`body-roundtrip-${label}.md`, original);
    const shown = await run(["show", ledger, "2", "--body-only"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toBe([`**现象**：${long}  `, "", criterion].join(eol));
    const child = spawnSync(process.execPath, [join(import.meta.dir, "../bin/issuemd.ts"), "body", ledger, "2", "--body-file", "-"], {
      encoding: "utf8", input: shown.stdout,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("(no changes)\n");
    expect(readFileSync(ledger, "utf8")).toBe(original);
  });
}

test("#97 appends only inside the selected body and preserves surrounding bytes", async () => {
  const source = canonical.replace(`${criterion}\n\n`, `${criterion}\n \n\n`).trimEnd();
  const original = "﻿" + source.replaceAll("\n", "\r\n");
  const ledger = fixture("append.md", original);
  const input = fixture("append-paragraph.md", "\n**复测记录**：已复测。  \n\n");
  const args = ["body", ledger, "2", "--append", "--body-file", input];
  const preview = await run([...args, "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(preview.stdout).toContain("+**复测记录**：已复测。  \r\n");
  expect(readFileSync(ledger, "utf8")).toBe(original);
  const snapshot = /snapshot: ([a-f0-9]+)/.exec(preview.stderr)?.[1];
  expect(snapshot).toBeDefined();
  expect((await run([...args, "--if-unchanged", snapshot!])).code).toBe(0);
  const expected = original.replace(`${criterion}\r\n \r\n\r\n`, `${criterion}\r\n\r\n**复测记录**：已复测。  \r\n \r\n\r\n`);
  expect(readFileSync(ledger, "utf8")).toBe(expected);
  expect((await run([...args, "--if-unchanged", snapshot!])).code).toBe(4);
  expect(readFileSync(ledger, "utf8")).toBe(expected);
  expect((await run(["check", ledger, "--strict"])).code).toBe(0);
});

test("#97 empty append is a byte-identical no-op", async () => {
  const ledger = fixture("append-empty.md");
  const input = fixture("empty-paragraph.md", "\n  \n\n");
  const result = await run(["body", ledger, "2", "--append", "--body-file", input]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("(no changes)\n");
  expect(readFileSync(ledger, "utf8")).toBe(canonical);
});

test("#97 append can restore a missing open body through the write gate", async () => {
  const ledger = fixture("append-missing.md", canonical.replace(/### Issue 2:[\s\S]+?(?=### Issue 3:)/, ""));
  const input = fixture("restore-body.md", `${criterion}\n`);
  const result = await run(["body", ledger, "2", "--append", "--body-file", input]);
  expect(result.code).toBe(0);
  expect((await run(["show", ledger, "2", "--body-only"])).stdout).toBe(`${criterion}\n`);
  expect((await run(["check", ledger, "--strict"])).code).toBe(0);
});

test("#97 body-only outputs no placeholder or borrowed body", async () => {
  const ledger = fixture("body-only-unavailable.md", canonical.replace("| 2 | 未决", "| 2, 21 | 未决"));
  for (const id of ["1", "21", "99"]) {
    const shown = await run(["show", ledger, id, "--body-only"]);
    expect(shown.code).toBe(1);
    expect(shown.stdout).toBe("");
    expect(shown.stderr).toBeTruthy();
  }
});

test("#97 body-only rejects competing stdout modes", async () => {
  const ledger = fixture("body-only-modes.md");
  for (const flags of [["--json"], ["--label", "根因"]]) {
    const result = await run(["show", ledger, "2", "--body-only", ...flags]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot combine");
    expect(result.stdout).toBe("");
  }
});

test("#99 rename reports both drifted title copies in dry-run and real writes", async () => {
  const original = canonical.replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: 正文旧标题");
  const ledger = fixture("rename-drift.md", original);
  const args = ["rename", ledger, "2", "统一新标题"];
  const preview = await run([...args, "--dry-run"]);
  expect(preview.code).toBe(0);
  expect(readFileSync(ledger, "utf8")).toBe(original);
  const result = await run(args);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('table summary: "侧栏宽度不可调" → "统一新标题"');
  expect(result.stderr).toContain('body title: "正文旧标题" → "统一新标题"');
  expect(preview.stderr.split("\n").filter((line) => line.startsWith("updated "))).toEqual(result.stderr.split("\n").filter((line) => line.startsWith("updated ")));
  expect((await run(["check", ledger, "--strict"])).code).toBe(0);
  expect(await run(args)).toEqual({ code: 0, stdout: "(no changes)\n", stderr: "" });
});

test("#99 rename reports the previous archive title and suppresses success on refusal", async () => {
  const ledger = fixture("rename-archive.md");
  expect((await run(["close", ledger, "2", "--keep-body"])).code).toBe(0);
  const args = ["rename", ledger, "2", "归档的新标题"];
  const refused = await run([...args, "--if-unchanged", "0123456789abcdef"]);
  expect(refused.code).toBe(4);
  expect(refused.stderr).not.toContain("updated");
  const result = await run(args);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('archive title: "侧栏宽度不可调" → "归档的新标题"');
});

for (const [name, bodies, expected] of [
  ["missing", "", ["E102:21a", "E102:21b"]],
  ["different", `### Issue 21a: 第一条\n\n${criterion}\n\n### Issue 21b: 第二条\n\n${criterion}\n\n`, ["E106:21b"]],
] as const) {
  test(`#90 split preserves pre-existing errors for ${name} bodies`, async () => {
    const source = canonical
      .replace("\n\n## 已关闭\n", "\n| 21a, 21b | 观察 | P3 | 第一条 |\n\n## 已关闭\n")
      .replace("## 附录\n", `${bodies}## 附录\n`);
    const ledger = fixture(`split-${name}.md`, source);
    const check = async () => {
      const result = await run(["check", ledger, "--strict", "--json"]);
      expect(result.code).toBe(3);
      const diagnostics = JSON.parse(result.stdout) as { errors: { code: string; id: string }[] };
      return diagnostics.errors.map(({ code, id }) => `${code}:${id}`).sort();
    };
    expect(await check()).toEqual([...expected]);
    const split = await run(["split", ledger, "21b"]);
    expect(split.code).toBe(0);
    expect(split.stderr).toContain("#21a");
    expect(split.stderr).toContain("#21b");
    expect(await check()).toEqual([...expected]);
  });
}
