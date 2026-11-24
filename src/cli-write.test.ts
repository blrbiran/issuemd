/**
 * End-to-end tests for the ledger write verbs. Each one starts from a fresh
 * copy of the canonical fixture, runs the command through `run()`, and then
 * asserts both the bytes on disk and that `check` still reports 0 errors —
 * the two invariants every write verb has to keep together.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { run } from "../src/cli.js";

const fixture = new URL("../fixtures/canonical-clean.md", import.meta.url);
const TEMPLATE = readFileSync(new URL("../TEMPLATE.md", import.meta.url), "utf8");
const bin = fileURLToPath(new URL("../dist/bin/issuemd.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "issuemd-write-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function ledger(): string {
  const path = join(dir, `ledger-${counter++}.md`);
  writeFileSync(path, readFileSync(fixture));
  return path;
}
const text = (path: string) => readFileSync(path, "utf8");
async function clean(path: string) {
  const result = await run(["check", path, "--json"]);
  return { code: result.code, report: JSON.parse(result.stdout) };
}

describe("new", () => {
  test("inserts an index row and a body block and keeps check at 0 errors", async () => {
    const path = ledger();
    const result = await run(["new", path, "--title", "缓存未失效", "--status", "未决", "--priority", "P1"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(text(path)).toContain("| 21 | 未决 | P1 | 缓存未失效 |");
    expect(text(path)).toContain("### Issue 21: 缓存未失效");
    expect((await clean(path)).code).toBe(0);
  });

  test("the index row lands in ascending order", async () => {
    const path = ledger();
    await run(["new", path, "--title", "早期补充", "--id", "1a"]);
    const body = text(path);
    expect(body.indexOf("| 1a |")).toBeLessThan(body.indexOf("| 2 | 未决"));
    expect((await clean(path)).code).toBe(0);
  });

  test("--dry-run prints a diff and leaves the file byte-identical", async () => {
    const path = ledger();
    const before = readFileSync(path);
    const result = await run(["new", path, "--title", "x", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("+### Issue 21: x");
    expect(readFileSync(path)).toEqual(before);
  });

  test("a title with a pipe writes one escaped cell", async () => {
    const path = ledger();
    expect((await run(["new", path, "--title", "a | b"])).code).toBe(0);
    expect(text(path)).toContain("| 21 | 未决 | P2 | a \\| b |");
    expect((await clean(path)).code).toBe(0);
  });

  test("a piped title warns W205 on new as well", async () => {
    const path = ledger();
    const result = await run(["new", path, "--title", "a | b"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("W205");
  });

  test("a taken --id exits 2 and writes nothing", async () => {
    const path = ledger();
    const before = readFileSync(path);
    expect((await run(["new", path, "--title", "x", "--id", "2"])).code).toBe(2);
    expect(readFileSync(path)).toEqual(before);
  });

  test("closed status, unknown status and a missing title are usage errors", async () => {
    const path = ledger();
    expect((await run(["new", path, "--title", "x", "--status", "已修"])).code).toBe(2);
    expect((await run(["new", path, "--title", "x", "--status", "不存在"])).code).toBe(2);
    expect((await run(["new", path])).code).toBe(2);
  });

  test("--body-file - reads the body from stdin", () => {
    const path = ledger();
    const child = spawnSync("sh", ["-c",
      `printf '**现象**：from-stdin\\n' | "${process.execPath}" "${bin}" new "${path}" --title x --body-file -`],
      { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(text(path)).toContain("**现象**：from-stdin");
  });

  test("--id accepts the 393b form the real ledgers use", async () => {
    const path = ledger();
    expect((await run(["new", path, "--title", "后缀编号", "--id", "21a"])).code).toBe(0);
    const after = text(path);
    expect(after).toContain("| 21a | 未决 | P2 | 后缀编号 |");
    expect(after).toContain("### Issue 21a: 后缀编号");
    expect((await clean(path)).code).toBe(0);
  });

  test("--id rejects a malformed value", async () => {
    const path = ledger();
    for (const bad of ["0", "abc", "1.5", "-3"]) {
      expect((await run(["new", path, "--title", "x", "--id", bad])).code).toBe(2);
    }
  });

  test("--id below the historical max warns W211 about a reused number", async () => {
    const path = join(dir, "gap.md");
    // Remove the closed row for #5 so the number below max 20 is free.
    writeFileSync(path, readFileSync(fixture, "utf8").replace("| 5 | 决定不改 | | 支持 IE11 | 产品裁决：只支持常青浏览器 |\n", ""));
    const result = await run(["new", path, "--title", "旧号复用", "--id", "5"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("W211");
    expect(text(path)).toContain("| 5 | 未决 | P2 | 旧号复用 |");
    expect((await clean(path)).code).toBe(0);
  });

  test("--id above the historical max does not warn", async () => {
    const path = ledger();
    const result = await run(["new", path, "--title", "新号", "--id", "21"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("a suffixed --id is a distinct issue, not a reused number", async () => {
    const path = join(dir, "suffix.md");
    writeFileSync(path, TEMPLATE);
    await run(["new", path, "--title", "base", "--id", "1"]);
    // `1a` shares a base with `1` but is its own issue; it must not trip W211.
    expect((await run(["new", path, "--title", "child", "--id", "1a"])).stderr).toBe("");
  });

  test("a non-ledger is refused with exit 3 and no write", async () => {
    const path = join(dir, "plain.md");
    writeFileSync(path, "# Plain\n\ntext\n");
    expect((await run(["new", path, "--title", "x"])).code).toBe(3);
    expect(text(path)).toBe("# Plain\n\ntext\n");
  });
});

describe("close", () => {
  test("moves the row, deletes the body and keeps check clean", async () => {
    const path = ledger();
    const result = await run(["close", path, "3", "--criteria-from-body"]);
    expect(result.code).toBe(0);
    const after = text(path);
    expect(after).not.toContain("| 3 | 部分解决 |");
    expect(after).not.toContain("### Issue 3:");
    expect(after).toContain("| 3 | 已修 | P2 | 导出 CSV 丢空行 |");
    expect((await clean(path)).code).toBe(0);
  });

  test("--criteria-from-body lifts the 验收判据 paragraph into the column", async () => {
    const path = ledger();
    await run(["close", path, "2", "--criteria-from-body"]);
    expect(text(path)).toContain("重启后保持上次宽度。");
  });

  test("--criteria writes the column verbatim", async () => {
    const path = ledger();
    await run(["close", path, "4", "--criteria", "手工验收通过"]);
    expect(text(path)).toContain("| 4 | 已修 | P3 | 长列表滚动掉帧 | 手工验收通过 |");
    expect((await clean(path)).code).toBe(0);
  });

  test("--keep-body moves the body into 附录 and warns", async () => {
    const path = ledger();
    const result = await run(["close", path, "2", "--keep-body"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("W250");
    const after = text(path);
    // 附录 forbids issue headings (E123), so the archive is a plain `###` note.
    expect(after).not.toContain("### Issue 2:");
    expect(after).toContain("### #2 侧栏宽度不可调（已关闭，正文保留）");
    expect(after.indexOf("### #2 侧栏宽度不可调（已关闭，正文保留）"))
      .toBeGreaterThan(after.indexOf("## 附录"));
    expect(after).toContain("**验收判据**：重启后保持上次宽度。");
    expect((await clean(path)).code).toBe(0);
  });

  test("--keep-body creates 附录 when the ledger has none", async () => {
    const path = join(dir, "no-appendix.md");
    const source = readFileSync(fixture, "utf8").replace(/\n## 附录[\s\S]*$/, "\n");
    writeFileSync(path, source);
    const result = await run(["close", path, "2", "--keep-body"]);
    expect(result.code).toBe(0);
    const after = text(path);
    expect(after).toContain("## 附录");
    expect(after.indexOf("### #2 ")).toBeGreaterThan(after.indexOf("## 附录"));
    expect((await clean(path)).code).toBe(0);
  });

  test("closing an id inside a retired range exits 2", async () => {
    const path = ledger();
    const before = readFileSync(path);
    expect((await run(["close", path, "8"])).code).toBe(2);
    expect(readFileSync(path)).toEqual(before);
  });

  test("closing twice exits 2; an unknown id exits 1", async () => {
    const path = ledger();
    await run(["close", path, "2"]);
    expect((await run(["close", path, "2"])).code).toBe(2);
    expect((await run(["close", path, "999"])).code).toBe(1);
  });

  test("--criteria and --criteria-from-body together are a usage error", async () => {
    const path = ledger();
    expect((await run(["close", path, "2", "--criteria", "x", "--criteria-from-body"])).code).toBe(2);
  });

  test("a CRLF+BOM ledger survives new as well", async () => {
    const path = join(dir, "crlf-new.md");
    writeFileSync(path, readFileSync(new URL("../fixtures/crlf-bom.md", import.meta.url)));
    const before = readFileSync(path);
    expect((await run(["new", path, "--title", "新增一条"])).code).toBe(0);
    const after = readFileSync(path);
    expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(after.toString("utf8").replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(after.toString("utf8").endsWith("\n")).toBe(before.toString("utf8").endsWith("\n"));
    expect(after.toString("utf8")).toContain("### Issue 21: 新增一条");
    expect((await clean(path)).code).toBe(0);
  });

  test("a CRLF+BOM ledger stays CRLF+BOM after close", async () => {
    const path = join(dir, "crlf-close.md");
    writeFileSync(path, readFileSync(new URL("../fixtures/crlf-bom.md", import.meta.url)));
    const before = readFileSync(path);
    const result = await run(["close", path, "2"]);
    expect(result.code).toBe(0);
    const after = readFileSync(path);
    expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(after.toString("utf8").replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(after.toString("utf8").endsWith("\n")).toBe(before.toString("utf8").endsWith("\n"));
  });
});

describe("status", () => {
  test("changes the cell for a same-category move", async () => {
    const path = ledger();
    expect((await run(["status", path, "3", "未决"])).code).toBe(0);
    expect(text(path)).toContain("| 3 | 未决 | P2 | 导出 CSV 丢空行 |");
    expect((await clean(path)).code).toBe(0);
  });

  test("closed-to-closed works too", async () => {
    const path = ledger();
    expect((await run(["status", path, "1", "延后"])).code).toBe(0);
    expect(text(path)).toContain("| 1 | 延后 | P3 | 登录页闪烁 |");
  });

  test("a cross-category move is refused and points at close", async () => {
    const path = ledger();
    const before = readFileSync(path);
    const result = await run(["status", path, "2", "已修"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("issuemd close");
    expect(readFileSync(path)).toEqual(before);
  });

  test("an open-to-closed move points at reopen in the other direction", async () => {
    const path = ledger();
    expect((await run(["status", path, "1", "观察"])).stderr).toContain("issuemd reopen");
  });

  test("an unknown status and a range are usage errors", async () => {
    const path = ledger();
    expect((await run(["status", path, "2", "乱写"])).code).toBe(2);
    expect((await run(["status", path, "8", "撤回"])).code).toBe(2);
  });
});

describe("rename", () => {
  test("rewrites the row and the body heading together", async () => {
    const path = ledger();
    expect((await run(["rename", path, "2", "侧栏宽度可拖拽"])).code).toBe(0);
    const after = text(path);
    expect(after).toContain("| 2 | 未决 | P1 | 侧栏宽度可拖拽 |");
    expect(after).toContain("### Issue 2: 侧栏宽度可拖拽");
    expect((await clean(path)).code).toBe(0);
  });

  test("a closed issue has no body to rewrite", async () => {
    const path = ledger();
    expect((await run(["rename", path, "1", "登录页稳定"])).code).toBe(0);
    expect(text(path)).toContain("| 1 | 已修 | P3 | 登录页稳定 |");
    expect((await clean(path)).code).toBe(0);
  });

  test("a no-op rename leaves the inode untouched", async () => {
    const path = ledger();
    const before = statSync(path).ino;
    const result = await run(["rename", path, "2", "侧栏宽度不可调"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(statSync(path).ino).toBe(before);
  });

  test("a title with a pipe stays one escaped cell", async () => {
    const path = ledger();
    expect((await run(["rename", path, "2", "a | b"])).code).toBe(0);
    expect(text(path)).toContain("| 2 | 未决 | P1 | a \\| b |");
    expect((await clean(path)).code).toBe(0);
  });

  test("a piped title warns W205 on stderr but still writes", async () => {
    const path = ledger();
    const result = await run(["rename", path, "2", "a | b"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("W205");
    expect(text(path)).toContain("| 2 | 未决 | P1 | a \\| b |");
  });

  test("a plain title does not warn", async () => {
    const path = ledger();
    expect((await run(["rename", path, "2", "普通标题"])).stderr).toBe("");
  });

  test("an already-escaped pipe is not escaped twice", async () => {
    const path = ledger();
    // The title arrives pre-escaped; escaping it again would produce `\\|`
    // and split the cell (E108). Accept it as a single literal pipe.
    const result = await run(["rename", path, "2", "a \\| b"]);
    expect(result.code).toBe(0);
    expect(text(path)).toContain("| 2 | 未决 | P1 | a \\| b |");
    expect((await clean(path)).code).toBe(0);
  });
});

describe("multi-id rows", () => {
  // The canonical format allows `| 20, 24, 29 |`, but per-id verbs cannot
  // rewrite one id without guessing what to do with its neighbours.
  async function shared(): Promise<string> {
    const path = ledger();
    writeFileSync(path, text(path).replace("| 4 | 观察 | P3 | 长列表滚动掉帧 |", "| 4, 24 | 观察 | P3 | 长列表滚动掉帧 |"));
    return path;
  }

  test("close refuses instead of splitting the row", async () => {
    const path = await shared();
    const before = readFileSync(path);
    const result = await run(["close", path, "4"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("24");
    expect(readFileSync(path)).toEqual(before);
  });

  test("rename and status refuse too", async () => {
    const path = await shared();
    expect((await run(["rename", path, "4", "x"])).code).toBe(2);
    expect((await run(["status", path, "4", "未决"])).code).toBe(2);
  });

  test("list and show still read the row", async () => {
    const path = await shared();
    expect((await run(["list", path])).stdout).toContain("4, 24  观察");
    const shown = await run(["show", path, "24"]);
    expect(shown.code).toBe(0);
    // The body belongs to the row, so it is shown for either id in it.
    expect(shown.stdout).toContain("**现象**：2000 行列表滚动时降至 20fps。");
  });
});

describe("reopen", () => {
  test("restores an open row with the criteria backfilled", async () => {
    const path = ledger();
    expect((await run(["reopen", path, "1"])).code).toBe(0);
    const after = text(path);
    expect(after).toContain("| 1 | 未决 | P3 | 登录页闪烁 |");
    expect(after).toContain("### Issue 1: 登录页闪烁");
    expect(after).toContain("**验收判据**：`a1b2c3d`：连续 3 轮 12/12");
    expect((await clean(path)).code).toBe(0);
  });

  test("a range, an open id, and an unknown id all fail", async () => {
    const path = ledger();
    expect((await run(["reopen", path, "8"])).code).toBe(2);
    expect((await run(["reopen", path, "2"])).code).toBe(2);
    expect((await run(["reopen", path, "999"])).code).toBe(1);
  });
});

describe("sync --guide", () => {
  test("regenerates both controlled blocks and touches nothing else", async () => {
    const path = ledger();
    const edited = text(path)
      .replace("| 查看开放项 | `issuemd list FILE` |", "| 看 | old |")
      .replace("| 观察 | open |", "| 观察 | Open |");
    writeFileSync(path, edited);
    const before = text(path).split("\n");
    const result = await run(["sync", path, "--guide"]);
    expect(result.code).toBe(0);
    const after = text(path).split("\n");
    expect(after).toContain("| 查看开放项 | `issuemd list FILE` |");
    expect(after).toContain("| 观察 | open |");
    // Everything outside the two controlled blocks is byte-identical.
    const outside = (lines: string[]) => {
      const kept: string[] = [];
      let inBlock = false;
      for (const line of lines) {
        if (/^<!-- issuemd:(guide|statuses):begin -->$/.test(line)) inBlock = true;
        if (!inBlock) kept.push(line);
        if (/^<!-- issuemd:(guide|statuses):end -->$/.test(line)) inBlock = false;
      }
      return kept;
    };
    expect(outside(after)).toEqual(outside(before));
    expect((await clean(path)).code).toBe(0);
  });

  test("a marker lookalike outside the section does not disable the rewrite", async () => {
    const path = ledger();
    writeFileSync(path, text(path)
      .replace("| 关闭 | `issuemd close FILE ID --criteria-from-body` |\n", "")
      .replace("## 附录", "## 附录\n\n- 标记示例\n\n  <!-- issuemd:guide:begin -->\n  <!-- issuemd:guide:end -->"));
    const result = await run(["sync", path, "--guide"]);
    expect(result.code).toBe(0);
    expect(text(path)).toContain("| 关闭 | `issuemd close FILE ID --criteria-from-body` |");
    // The lookalike stays where it was.
    expect(text(path)).toContain("  <!-- issuemd:guide:begin -->");
  });

  test("a broken marker pair is an error, not a silent no-op", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("<!-- issuemd:guide:end -->\n", ""));
    const before = readFileSync(path);
    const result = await run(["sync", path, "--guide"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("exactly one ordered");
    expect(readFileSync(path)).toEqual(before);
  });

  test("a second sync --guide is a no-op", async () => {
    const path = ledger();
    await run(["sync", path, "--guide"]);
    const inode = statSync(path).ino;
    const result = await run(["sync", path, "--guide"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(statSync(path).ino).toBe(inode);
  });
});

describe("sync --fix-tables", () => {
  test("inserts the missing separator reported by E122", async () => {
    const path = join(dir, "no-sep.md");
    writeFileSync(path, [
      "# Demo Issue 台账", "",
      "## 怎么用", "", "<!-- issuemd:guide:begin -->", "<!-- issuemd:guide:end -->", "",
      "## 状态口径", "", "<!-- issuemd:statuses:begin -->", "<!-- issuemd:statuses:end -->", "",
      "## 索引", "", "| 2 | 未决 | P1 | 侧栏宽度不可调 |", "",
      "## 已关闭", "",
      "## 正文", "", "### Issue 2: 侧栏宽度不可调", "", "**现象**：x", "",
      "## 附录", "",
    ].join("\n"));
    const result = await run(["sync", path, "--fix-tables"]);
    expect(result.code).toBe(0);
    const after = text(path);
    expect(after).toContain("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 2 | 未决 | P1 | 侧栏宽度不可调 |");
    expect((await clean(path)).report.errors.some((error: { code: string }) => error.code === "E122")).toBe(false);
  });

  test("a headerless data block keeps its first row as data", async () => {
    // The real orca ledger has this shape: a data block with no header at all.
    const path = join(dir, "no-header.md");
    writeFileSync(path, readFileSync(fixture, "utf8").replace(
      "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 2 | 未决 | P1 | 侧栏宽度不可调 |",
      "| 2 | 未决 | P1 | 侧栏宽度不可调 |",
    ));
    expect((await run(["sync", path, "--fix-tables"])).code).toBe(0);
    const after = text(path);
    expect(after).toContain("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 2 | 未决 | P1 | 侧栏宽度不可调 |");
    expect((await clean(path)).code).toBe(0);
    expect((await run(["list", path])).stdout).toContain("侧栏宽度不可调");
  });

  test("the canonical fixture is already fixed, so sync is a no-op", async () => {
    const path = ledger();
    const inode = statSync(path).ino;
    expect((await run(["sync", path, "--fix-tables"])).code).toBe(0);
    expect(statSync(path).ino).toBe(inode);
  });
});

describe("sync --titles", () => {
  test("aligns the summary with the body title", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 宽度问题 |"));
    expect((await run(["sync", path, "--titles"])).code).toBe(0);
    expect(text(path)).toContain("| 2 | 未决 | P1 | 侧栏宽度不可调 |");
    expect((await clean(path)).code).toBe(0);
  });

  test("--prefer=table rewrites the heading instead", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 宽度问题 |"));
    await run(["sync", path, "--titles", "--prefer=table"]);
    expect(text(path)).toContain("### Issue 2: 宽度问题");
    expect((await clean(path)).code).toBe(0);
  });

  test("progress text blocks the default direction unless resolved", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 宽度问题，仍缺记忆 |"));
    const before = readFileSync(path);
    const blocked = await run(["sync", path, "--titles"]);
    expect(blocked.code).toBe(3);
    expect(blocked.stderr).toContain("#2");
    expect(readFileSync(path)).toEqual(before);
  });

  test("--move-progress keeps the old summary in the body", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 宽度问题，仍缺记忆 |"));
    expect((await run(["sync", path, "--titles", "--move-progress"])).code).toBe(0);
    const after = text(path);
    expect(after).toContain("> **进展（来自旧表）**：宽度问题，仍缺记忆");
    expect(after).toContain("| 2 | 未决 | P1 | 侧栏宽度不可调 |");
    expect((await clean(path)).code).toBe(0);
  });

  test("--drop-progress discards it", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 宽度问题，仍缺记忆 |"));
    expect((await run(["sync", path, "--titles", "--drop-progress"])).code).toBe(0);
    expect(text(path)).not.toContain("仍缺记忆");
    expect((await clean(path)).code).toBe(0);
  });

  test("progress flags without --titles, and both flags at once, are usage errors", async () => {
    const path = ledger();
    expect((await run(["sync", path, "--drop-progress"])).code).toBe(2);
    expect((await run(["sync", path, "--guide", "--titles"])).code).toBe(2);
    expect((await run(["sync", path, "--titles", "--move-progress", "--drop-progress"])).code).toBe(2);
    expect((await run(["sync", path])).code).toBe(2);
  });
});
describe("regressions found in review", () => {
  test("replaceCell keeps escapes in cells it does not touch", async () => {
    const path = ledger();
    writeFileSync(path, text(path)
      .replace("| 1 | 已修 | P3 | 登录页闪烁 | `a1b2c3d`：连续 3 轮 12/12 |",
               "| 1 | 已修 | P3 | 登录页闪烁 | passed \\| verified |"));
    expect((await run(["status", path, "1", "延后"])).code).toBe(0);
    expect(text(path)).toContain("| 1 | 延后 | P3 | 登录页闪烁 | passed \\| verified |");
    expect((await clean(path)).code).toBe(0);
  });

  test("close --keep-body keeps the first body line when the heading is tight", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("### Issue 2: 侧栏宽度不可调\n\n**现象**", "### Issue 2: 侧栏宽度不可调\n**现象**"));
    expect((await run(["close", path, "2", "--keep-body"])).code).toBe(0);
    const after = text(path);
    expect(after).toContain("**现象**：侧栏固定 240px，无法拖拽。");
    expect(after).toContain("**验收判据**：重启后保持上次宽度。");
  });

  test("close --criteria-from-body ignores a fenced example label", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace(
      "### Issue 2: 侧栏宽度不可调\n\n**现象**",
      "### Issue 2: 侧栏宽度不可调\n\n```\n**验收判据**：示例\n```\n\n**现象**",
    ));
    expect((await run(["close", path, "2", "--criteria-from-body"])).code).toBe(0);
    expect(text(path)).toContain("| 2 | 已修 | P1 | 侧栏宽度不可调 | 重启后保持上次宽度。 |");
  });

  test("sync --guide ignores a marker pair quoted inside a fence", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace(
      "## 附录",
      "## 附录\n\n```\n<!-- issuemd:guide:begin -->\n<!-- issuemd:guide:end -->\n```",
    ));
    expect((await run(["sync", path, "--guide"])).code).toBe(0);
    expect(text(path)).toContain("| 查看开放项 | `issuemd list FILE` |");
    expect((await clean(path)).code).toBe(0);
  });

  test("sync --titles --move-progress stays inside the issue it belongs to", async () => {
    const path = ledger();
    writeFileSync(path, text(path)
      .replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 宽度，仍缺记忆 |")
      .replace("### Issue 2: 侧栏宽度不可调\n\n**现象**", "### Issue 2: 侧栏宽度不可调\n**现象**"));
    expect((await run(["sync", path, "--titles", "--move-progress"])).code).toBe(0);
    const between = text(path).split("### Issue 3:")[0]!;
    expect(between).toContain("> **进展（来自旧表）**：宽度，仍缺记忆");
  });

  test("`2` and `2a` keep separate bodies", async () => {
    const path = ledger();
    writeFileSync(path, text(path)
      .replace("| 3 | 部分解决 | P2 | 导出 CSV 丢空行 |", "| 3 | 部分解决 | P2 | 导出 CSV 丢空行 |\n| 3a | 观察 | P2 | 后缀测试 |")
      .replace("### Issue 3: 导出 CSV 丢空行", "### Issue 3: 导出 CSV 丢空行\n\n**现象**：原三号。\n\n### Issue 3a: 后缀测试\n\n**现象**：三号后缀。"));
    expect((await clean(path)).code).toBe(0);
    expect((await run(["show", path, "3"])).stdout).toContain("原三号");
    expect((await run(["show", path, "3a"])).stdout).toContain("三号后缀");
    expect((await run(["close", path, "3a", "--criteria-from-body"])).code).toBe(0);
    expect(text(path)).toContain("### Issue 3: 导出 CSV 丢空行");
    expect(text(path)).not.toContain("### Issue 3a:");
  });

  test("an unterminated ledger stays unterminated after new, reopen and close", async () => {
    const base = readFileSync(fixture, "utf8").split("## 附录")[0]!.replace(/\n+$/, "");
    for (const [id, args] of [["new", ["--title", "X"]], ["reopen", ["6"]], ["close", ["4"]]] as const) {
      const path = join(dir, `unterminated-${id}.md`);
      writeFileSync(path, base);
      expect((await run([id, path, ...args])).code).toBe(0);
      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(false);
    }
  });

  test("sync --fix-tables replaces a short separator instead of stacking one", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|", "| # | 状态 | P | 摘要 |\n|---|---|---|"));
    expect((await run(["sync", path, "--fix-tables"])).code).toBe(0);
    expect(text(path)).toContain("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 2 |");
    expect((await clean(path)).code).toBe(0);
  });

  test("new refuses a body file that ends inside a fence", async () => {
    const path = ledger();
    const body = join(dir, "unclosed.md");
    writeFileSync(body, "**现象**：\n\n```\nunclosed\n");
    const before = readFileSync(path);
    expect((await run(["new", path, "--title", "x", "--body-file", body])).code).toBe(2);
    expect(readFileSync(path)).toEqual(before);
  });
});

describe("second review round", () => {
  test("a body file that closes its fence is accepted", async () => {
    const path = ledger();
    const body = join(dir, "closed-fence.md");
    writeFileSync(body, "**现象**：x\n\n```\ncode\n```\n");
    expect((await run(["new", path, "--title", "x", "--body-file", body])).code).toBe(0);
    expect((await clean(path)).code).toBe(0);
  });

  test("sync --titles keeps 21 and 21a apart", async () => {
    const path = ledger();
    writeFileSync(path, text(path)
      .replace("| 4 | 观察 | P3 | 长列表滚动掉帧 |", "| 4 | 观察 | P3 | 长列表滚动掉帧 |\n| 21 | 未决 | P2 | 表里说二十一 |\n| 21a | 未决 | P2 | 表里说二十一甲 |")
      .replace("### Issue 4: 长列表滚动掉帧", "### Issue 4: 长列表滚动掉帧\n\n**现象**：四。\n\n### Issue 21: 正文说二十一\n\n**现象**：二一。\n\n### Issue 21a: 正文说二十一甲\n\n**现象**：二一甲。"));
    expect((await run(["sync", path, "--titles"])).code).toBe(0);
    const after = text(path);
    expect(after).toContain("| 21 | 未决 | P2 | 正文说二十一 |");
    expect(after).toContain("| 21a | 未决 | P2 | 正文说二十一甲 |");
  });

  test("close --keep-body works when 附录 precedes 正文", async () => {
    const path = ledger();
    const source = text(path);
    const bodyAt = source.indexOf("## 正文");
    const appendixAt = source.indexOf("## 附录");
    writeFileSync(path, source.slice(0, bodyAt) + source.slice(appendixAt).replace(/\n+$/, "") +
      "\n\n" + source.slice(bodyAt, appendixAt).replace(/\n+$/, "") + "\n");
    expect((await clean(path)).code).toBe(0);
    expect((await run(["close", path, "2", "--keep-body"])).code).toBe(0);
    const after = text(path);
    expect(after.indexOf("### #2 ")).toBeGreaterThan(after.indexOf("## 附录"));
    expect(after.indexOf("### #2 ")).toBeLessThan(after.indexOf("## 正文"));
    expect((await clean(path)).code).toBe(0);
  });

  test("show --label ignores a label quoted inside a fence", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace(
      "### Issue 2: 侧栏宽度不可调\n\n**现象**",
      "### Issue 2: 侧栏宽度不可调\n\n```\n**验收判据**：假\n```\n\n**现象**",
    ));
    const result = await run(["show", path, "2", "--label", "验收判据"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("重启后保持上次宽度");
    expect(result.stdout).not.toContain("假");
  });

  test("status repairs an undeclared status word without crossing tables", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("| 3 | 部分解决 | P2 | 导出 CSV 丢空行 |", "| 3 | 未觉 | P2 | 导出 CSV 丢空行 |"));
    expect((await run(["status", path, "3", "未决"])).code).toBe(0);
    expect(text(path)).toContain("| 3 | 未决 | P2 | 导出 CSV 丢空行 |");
    expect((await clean(path)).report.errors).toEqual([]);
  });

  test("status still refuses a cross-table move on an undeclared word", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("| 3 | 部分解决 | P2 | 导出 CSV 丢空行 |", "| 3 | 未觉 | P2 | 导出 CSV 丢空行 |"));
    expect((await run(["status", path, "3", "已修"])).code).toBe(2);
  });
});

describe("third review round", () => {
  test("a second copy of an id-less error is refused, not treated as known", async () => {
    const path = ledger();
    writeFileSync(path, text(path).replace("## 正文", "## 正文\n\n### Notes\n\nstray heading\n"));
    const baseline = (await clean(path)).report.errors.filter((e: { code: string }) => e.code === "E110");
    expect(baseline.length).toBe(1);
    const body = join(dir, "duplicate-error.md");
    writeFileSync(body, "### Sub heading\n\n**现象**：x。\n");
    const before = readFileSync(path);
    const result = await run(["new", path, "--title", "fresh", "--body-file", body]);
    expect(result.code).toBe(3);
    expect(readFileSync(path)).toEqual(before);
  });

  test("close --keep-body works when 附录 precedes 索引", async () => {
    const path = ledger();
    const source = text(path);
    const indexAt = source.indexOf("## 索引");
    const appendixAt = source.indexOf("## 附录");
    writeFileSync(path, source.slice(0, indexAt) + source.slice(appendixAt).replace(/\n+$/, "") +
      "\n\n" + source.slice(indexAt, appendixAt).replace(/\n+$/, "") + "\n");
    expect((await clean(path)).code).toBe(0);
    const result = await run(["close", path, "2", "--keep-body"]);
    expect(result.code).toBe(0);
    const after = text(path);
    expect(after).toContain("### #2 ");
    expect(after).not.toContain("| 2 | 未决");
    expect((await clean(path)).code).toBe(0);
  });

  test("an id too large for a safe integer is a usage error, not a crash", async () => {
    const path = ledger();
    const before = readFileSync(path);
    const result = await run(["new", path, "--title", "big", "--id", "99999999999999999999"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("99999999999999999999");
    expect(readFileSync(path)).toEqual(before);
  });

  test("a BOM at the start of --body-file does not leak into the ledger", async () => {
    const path = ledger();
    const body = join(dir, "bom-body.md");
    writeFileSync(body, "﻿**现象**：来自 Windows。\r\n");
    const result = await run(["new", path, "--title", "bom body", "--body-file", body]);
    expect(result.code).toBe(0);
    expect(text(path).slice(1)).not.toContain("﻿");
    const shown = await run(["show", path, "21", "--label", "现象"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("来自 Windows");
  });

  test("a top-level heading in --body-file is refused instead of splitting the issue", async () => {
    const path = ledger();
    const body = join(dir, "h2-body.md");
    writeFileSync(body, "**现象**：x。\n\n## Design notes\n\nlong text\n");
    const before = readFileSync(path);
    const result = await run(["new", path, "--title", "h2 body", "--body-file", body]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("## Design notes");
    expect(readFileSync(path)).toEqual(before);
  });

  test("a title ending in a hash is refused with an explanation, not E106", async () => {
    const path = ledger();
    const created = await run(["new", path, "--title", "Port to C #"]);
    expect(created.code).toBe(2);
    expect(created.stderr).toContain("ends with '#'");
    const renamed = await run(["rename", path, "2", "Escape #"]);
    expect(renamed.code).toBe(2);
    expect(renamed.stderr).toContain("ends with '#'");
  });

  test("reopen restores the body kept by close --keep-body", async () => {
    const path = ledger();
    expect((await run(["close", path, "2", "--keep-body"])).code).toBe(0);
    expect(text(path)).toContain("（已关闭，正文保留）");
    const result = await run(["reopen", path, "2"]);
    expect(result.code).toBe(0);
    const after = text(path);
    expect(after).not.toContain("（已关闭，正文保留）");
    expect(after).toContain("### Issue 2: 侧栏宽度不可调");
    expect(after).toContain("**现象**：侧栏固定 240px，无法拖拽。");
    expect(after).toContain("**验收判据**：重启后保持上次宽度。");
    const { report } = await clean(path);
    expect(report.errors).toEqual([]);
    expect(report.warnings.filter((warning: { code: string }) => warning.code === "W250")).toEqual([]);
  });

  test("a write refuses a file that is not valid UTF-8", async () => {
    const path = ledger();
    writeFileSync(path, Buffer.concat([
      readFileSync(path),
      Buffer.from("\nlatin1: caf", "utf8"), Buffer.from([0xe9]), Buffer.from("\n", "utf8"),
    ]));
    const before = readFileSync(path);
    const result = await run(["status", path, "2", "观察"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("UTF-8");
    expect(readFileSync(path)).toEqual(before);
    // Reads still work.
    expect((await run(["check", path])).code).not.toBe(2);
  });
});
