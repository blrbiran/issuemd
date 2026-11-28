import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const directory = mkdtempSync(join(tmpdir(), "issuemd-unclosed-fence-"));
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

async function report(source: string) {
  const path = fixture(source);
  const checked = await run(["check", path, "--json"]);
  return { path, checked, value: JSON.parse(checked.stdout) };
}

test("W270 points to an unclosed fence in the last managed issue body", async () => {
  const opener = "```ts";
  const source = canonical.replace(
    "**验收判据**：2000 行滚动 10 秒，平均帧率 ≥ 55。\n\n## 附录",
    `**验收判据**：2000 行滚动 10 秒，平均帧率 ≥ 55。\n\n${opener}\nconst example = true;`,
  );
  const { path, checked, value } = await report(source);
  expect(checked.code).toBe(0);
  expect(value.warnings).toContainEqual(expect.objectContaining({
    code: "W270", id: "4", line: lineOf(source, opener),
    message: expect.stringContaining("close the fence"),
  }));
  expect((await run(["check", path, "--strict"])).code).toBe(3);
});

test("W270 reports an unclosed visible appendix fence at its opener", async () => {
  const opener = "~~~md";
  const source = `${canonical.trimEnd()}\n\n${opener}\nVisible appendix note.\n`;
  const { path, checked, value } = await report(source);
  expect(checked.code).toBe(0);
  const warning = value.warnings.find((item: { code: string }) => item.code === "W270");
  expect(warning).toMatchObject({ code: "W270", line: lineOf(source, opener) });
  expect(warning).not.toHaveProperty("id");
  expect((await run(["check", path, "--strict"])).code).toBe(3);
});

test("closed fences and list-relative fences closed by outdent do not warn", async () => {
  const body = [
    "### Issue 4: 长列表滚动掉帧", "**现象**：example", "- item", "  ```ts", "  const example = true;", "- next item",
    "```js", "closed", "```", "**验收判据**：still works.",
  ].join("\n");
  const source = canonical.replace(
    /### Issue 4: 长列表滚动掉帧[\s\S]*?(?=\n## 附录)/,
    body,
  );
  const { checked, value } = await report(source);
  expect(checked.code).toBe(0);
  expect(value.warnings).not.toContainEqual(expect.objectContaining({ code: "W270" }));
});

test.each([
  ["HTML comment", "<!--\n```md\n-->"],
  ["raw HTML", "<pre>\n```md\n</pre>"],
])("a fence delimiter inside %s is not an unclosed fence", async (_name, example) => {
  const source = `${canonical.trimEnd()}\n\n## 附录\n\n${example}\nVisible text after the example.\n`;
  const { checked, value } = await report(source);
  expect(checked.code).toBe(0);
  expect(value.warnings).not.toContainEqual(expect.objectContaining({ code: "W270" }));
});

test("a verified archive's payload and framing are not appendix fence openers", async () => {
  const source = `${canonical.trimEnd()}\n\n## 附录\n\n### #1 登录页闪烁（已关闭，正文保留）\n<!-- issuemd:kept-body:v3 -->\n<!-- issuemd:kept-body:start -->\n<!-- issuemd:kept-body:lines:3 -->\n\`\`\`md\nArchived example.\n\`\`\`\n\n<!-- issuemd:kept-body:end -->\n`;
  const { checked, value } = await report(source);
  expect(checked.code).toBe(0);
  expect(value.warnings.filter((item: { code: string }) => item.code === "W270")).toEqual([]);
});
