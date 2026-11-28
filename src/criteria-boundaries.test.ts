import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-criteria-boundaries-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const criteria = "**验收判据**\n\n1. 判据一。\n2. 判据二。";
let sequence = 0;
function fixture(text: string): string {
  const path = join(dir, `${++sequence}.md`);
  writeFileSync(path, text);
  return path;
}
async function ledger(body = criteria): Promise<string> {
  const path = fixture(canonical);
  expect((await run(["body", path, "2", "--body-file", fixture(body)])).code).toBe(0);
  return path;
}
async function warning(path: string, code: string) {
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  return report.warnings.find((entry: { code: string; id: string }) => entry.code === code && entry.id === "2");
}

test.each([
  "**第二十六轮复核（2026-11-27）：仍未修。**\n\n说明\n\n```md\nSample\n```",
  "**第二十六轮复核**（2026-11-27）：仍未修。\n\n说明\n\n```md\nSample\n```",
  "普通段落。\n\n**复核（第 N 轮）：仍未修。**\n\n说明",
])("review headings leave canonical criteria intact (%j)", async (tail) => {
  const path = await ledger(`${criteria}\n\n${tail}\n`);
  expect(JSON.parse((await run(["show", path, "2", "--json"])).stdout).criteria).toBe("1. 判据一。；2. 判据二。");
  expect(await warning(path, "W268")).toBeUndefined();
  expect((await run(["close", path, "2", "--criteria-from-body", "--dry-run"])).code).toBe(0);
});

test.each(["**注意**\n\n3. 仍属判据。", "复核状态。\n\n1. 仍属判据？", "复核状态。\n\n```md\nSample\n```"])(
  "ambiguous list boundary refuses destructive automatic close (%j)", async (tail) => {
    const path = await ledger(`${criteria}\n\n${tail}\n`);
    const before = readFileSync(path, "utf8");
    expect(await warning(path, "W268")).toEqual(expect.objectContaining({ line: before.split("\n").indexOf(tail.split("\n")[0]!) + 1 }));
    expect((await run(["close", path, "2", "--dry-run"])).code).toBe(2);
    expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(before);
  },
);

test.each(["**验收判据**：New", "**复核**\n\n**补充判据**：New", "散文\n\n**判定标准**\n\nNew"])(
  "append refuses visible criteria anywhere in the fragment (%j)", async (incoming) => {
    const path = await ledger();
    const before = readFileSync(path, "utf8");
    for (const extra of [[], ["--dry-run"]]) {
      const result = await run(["body", path, "2", "--append", "--body-file", fixture(incoming), ...extra]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("criteria");
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  },
);

test("append accepts literal criteria examples and chooses an unused review label", async () => {
  const path = await ledger(`**复测记录**：Earlier notes.\n\n${criteria}`);
  const incoming = "```md\n**复测记录 2**\n**验收判据**：A quote\n```\n\n<!--\n**新增判据**\n-->";
  expect((await run(["body", path, "2", "--append", "--body-file", fixture(incoming)])).code).toBe(0);
  const shown = JSON.parse((await run(["show", path, "2", "--json"])).stdout);
  expect(shown.criteria).toBe("1. 判据一。；2. 判据二。");
  expect(shown.labels["复测记录 2"]).toContain("A quote");
  expect(await warning(path, "W206")).toBeUndefined();
});

test("a bold criterion with explanatory prose can still cut off a later criterion", async () => {
  const path = await ledger(`${criteria}\n\n**必须离线通过。**\n\nExplanation.\n\n3. Second case.`);
  const before = readFileSync(path, "utf8");
  expect(await warning(path, "W268")).toBeDefined();
  expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(2);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("source equality cannot hide a supplement with a different projection", async () => {
  const block = "```md\n**验收判据**：Must work offline.\n```\n\nOnline passes.";
  const path = await ledger(`**验收判据**\n\n${block}\n\n**补充判据**\n\n${block}`);
  expect(await warning(path, "W264")).toBeDefined();
  expect((await run(["close", path, "2", "--dry-run"])).code).toBe(2);
});

test("qualified review labels can have balanced nested parentheses", async () => {
  const path = await ledger(`${criteria}\n\n**复核**（第二轮（离线））：通过\n\n\`\`\`md\nSample\n\`\`\``);
  expect(await warning(path, "W268")).toBeUndefined();
  expect((await run(["close", path, "2", "--dry-run"])).code).toBe(0);
});

test("sync cannot claim to rename a qualified alias it cannot canonicalize", async () => {
  const path = await ledger("**判据**（离线）：Work offline.");
  const before = readFileSync(path, "utf8");
  const synced = await run(["sync", path, "--criteria-labels"]);
  expect(synced.code).toBe(0);
  expect(synced.stdout).toContain("(no changes)");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("only complete source-identical criteria repeats skip W264", async () => {
  const repeated = await ledger(`${criteria}\n\n**补充判据**\n\n1. 判据一。\n2. 判据二。`);
  expect(await warning(repeated, "W264")).toBeUndefined();
  const view = JSON.parse((await run(["show", repeated, "2", "--json"])).stdout);
  expect(view.criteriaBlocks).toHaveLength(2);
  expect((await run(["close", repeated, "2", "--dry-run"])).code).toBe(0);
  for (const tail of ["1. 判据一。", "1. 判据一。；2. 判据二。", "同上，但还需离线通过。"] ) {
    const path = await ledger(`${criteria}\n\n**判据（不变）**\n\n${tail}`);
    expect(await warning(path, "W264")).toBeDefined();
    expect((await run(["close", path, "2", "--dry-run"])).code).toBe(2);
  }
});
