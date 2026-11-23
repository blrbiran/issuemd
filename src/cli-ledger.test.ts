import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { run } from "./cli.js";

const fixture = fileURLToPath(new URL("../fixtures/canonical-clean.md", import.meta.url));
const expected = JSON.parse(
  readFileSync(new URL("../fixtures/canonical-clean.expected.json", import.meta.url), "utf8"),
);
let dir: string;
function file(name: string, contents: string | Buffer): string {
  dir ??= mkdtempSync(join(tmpdir(), "issuemd-ledger-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}
const ledger = () => file(`ledger-${Math.random().toString(36).slice(2)}.md`, readFileSync(fixture));

describe("cli: list", () => {
  test("lists the three open issues", async () => {
    const result = await run(["list", fixture]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(3);
    expect(result.stdout).toContain("2  未决  P1  侧栏宽度不可调");
  });

  test("--status and --priority filter; an empty result exits 1", async () => {
    expect((await run(["list", fixture, "--status", "观察"])).stdout).toContain("4  观察");
    expect((await run(["list", fixture, "--priority", "P1"])).stdout).toContain("2  未决");
    const empty = await run(["list", fixture, "--status", "撤回"]);
    expect(empty.code).toBe(1);
    expect(empty.stdout).toBe("(no issues)\n");
  });

  test("--closed lists the closed table and includes criteria in JSON", async () => {
    const result = await run(["list", fixture, "--closed", "--json"]);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.table).toBe("closed");
    expect(doc.issues.map((issue: { id: string }) => issue.id)).toEqual(["1", "5", "7–20", "6"]);
    expect(doc.issues[0].criteria).toContain("12/12");
  });

  test("a non-ledger exits 3 and a missing file exits 2", async () => {
    const plain = file("plain.md", "# Plain\n\ntext\n");
    const bad = await run(["list", plain]);
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain("E120");
    expect((await run(["list", join(dir, "nope.md")])).code).toBe(2);
  });
});

describe("cli: counts", () => {
  test("matches the fixture's golden counts", async () => {
    const result = await run(["counts", fixture, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).counts).toEqual(expected.counts);
  });

  test("text output is the same summary line check prints", async () => {
    const result = await run(["counts", fixture]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("open 3 (未决 1, 部分解决 1, 观察 1)   closed 17\n");
  });

  test("counts never writes to the file", async () => {
    const path = ledger();
    const before = statSync(path).ino;
    await run(["counts", path]);
    expect(statSync(path).ino).toBe(before);
  });
});
describe("cli: show", () => {
  test("prints the row, the range and the body", async () => {
    const result = await run(["show", fixture, "2"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("#2  未决  P1  侧栏宽度不可调");
    expect(result.stdout).toContain("L54-60");
    expect(result.stdout).toContain("**验收判据**：重启后保持上次宽度。");
  });

  test("--label returns only that paragraph", async () => {
    const result = await run(["show", fixture, "3", "--label", "验收判据"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("**验收判据**：含 3 个连续空行的样本导出后仍为 3 行。");
  });

  test("a missing label exits 1 and names the labels that exist", async () => {
    const result = await run(["show", fixture, "3", "--label", "复盘"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("(no label: 复盘)");
    expect(result.stderr).toContain("现象");
  });

  test("a closed issue prints criteria and no body", async () => {
    const result = await run(["show", fixture, "1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("#1  已修  P3  登录页闪烁");
    expect(result.stdout).toContain("判据: `a1b2c3d`：连续 3 轮 12/12");
  });

  test("a bare number inside a range resolves to that row", async () => {
    const result = await run(["show", fixture, "8", "--json"]);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc).toMatchObject({ id: "8", table: "closed", status: "撤回", summary: "无记录" });
  });

  test("--json carries the body text", async () => {
    const result = await run(["show", fixture, "4", "--json"]);
    const doc = JSON.parse(result.stdout);
    expect(doc).toMatchObject({ id: "4", table: "open", summary: "长列表滚动掉帧" });
    expect(doc.body.text).toContain("**现象**：2000 行列表滚动时降至 20fps。");
  });

  test("an unknown id exits 1", async () => {
    const result = await run(["show", fixture, "999"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("(no such issue: 999)\n");
  });
});

describe("cli: read", () => {
  test("prints an H2 section verbatim and stops at the next H2", async () => {
    const result = await run(["read", fixture, "附录"]);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("## 附录\n")).toBe(true);
    expect(result.stdout).toContain("### 2026-11-20 复核记录");
    expect(result.stdout).toContain("| `npm test` | 128/128 |");
    expect(result.stdout).not.toContain("## 正文");
  });

  test("matches the title exactly, not by substring", async () => {
    expect((await run(["read", fixture, "附"])).code).toBe(2);
  });

  test("a duplicate H2 exits 2 and lists both candidates", async () => {
    const path = file("dup-h2.md", "# T\n\n## A\n\nx\n\n## A\n\ny\n");
    const result = await run(["read", path, "A"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("L3");
    expect(result.stderr).toContain("L7");
    expect(result.stdout).toBe("");
  });

  test("a missing heading exits 2 and lists the H2s", async () => {
    const result = await run(["read", fixture, "附录X"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("附录");
    expect(result.stderr).toContain("索引");
  });

  test("reads an ordinary Markdown file too", async () => {
    const path = file("plain-read.md", "# Guide\n\n## Install\n\nbrew install x\n\n## Other\n\ny\n");
    const result = await run(["read", path, "Install"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("## Install\n\nbrew install x\n");
  });
});
