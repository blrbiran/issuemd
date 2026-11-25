/**
 * Round fourteen: black-box self-test findings (2026-11-26).
 *
 * Input was three black-box passes over the built CLI (write verbs, read
 * verbs, check/adopt). Each describe names the finding it pins down; the
 * code changes are in cli.ts, ledger.ts, ledger-check.ts, ledger-edit.ts,
 * ledger-read.ts, adopt.ts and write.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../src/cli.js";

const TEMPLATE = readFileSync(new URL("../TEMPLATE.md", import.meta.url), "utf8");
const CANONICAL = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
const ORCA_SHAPED = readFileSync(new URL("../fixtures/orca-shaped.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "issuemd-round14-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function file(content = TEMPLATE, ext = "md"): string {
  const path = join(dir, `f-${counter++}.${ext}`);
  writeFileSync(path, content);
  return path;
}
const text = (path: string) => readFileSync(path, "utf8");
const body = (content: string) => file(content, "txt");

async function withIssue(content: string) {
  const path = file();
  expect((await run(["new", path, "--title", "甲", "--body-file", body(content)])).code).toBe(0);
  return path;
}

describe("close: a criteria a table cell cannot store is refused, not changed", () => {
  // In a body fence `\|` is a backslash then a pipe (a shell escape); in a
  // table cell `\|` is just a literal pipe. Promoting would silently drop
  // the backslash, so close must refuse and name the alternatives.
  const fenced = "**现象**：x\n\n**验收判据**\n\n```sh\necho a \\| b\n```\n";

  test("default promotion refuses instead of dropping the backslash", async () => {
    const path = await withIssue(fenced);
    const before = text(path);
    const result = await run(["close", path, "1"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("\\|");
    expect(result.stderr).toContain("--keep-body");
    expect(text(path)).toBe(before);
  });

  test("--criteria-from-body refuses the same way", async () => {
    const path = await withIssue(fenced);
    expect((await run(["close", path, "1", "--criteria-from-body"])).code).toBe(2);
    expect((await run(["close", path, "1", "--criteria-from-body", "--dry-run"])).code).toBe(2);
  });

  test("--keep-body --no-criteria archives the body verbatim and closes", async () => {
    const path = await withIssue(fenced);
    const result = await run(["close", path, "1", "--keep-body", "--no-criteria"]);
    expect(result.code).toBe(0);
    expect(text(path)).toContain("echo a \\| b");
    expect((await run(["reopen", path, "1"])).code).toBe(0);
    expect(text(path)).toContain("echo a \\| b");
  });

  test("--criteria input keeps the title convention: \\| means a literal pipe", async () => {
    const path = await withIssue("**验收判据**：x\n");
    expect((await run(["close", path, "1", "--criteria", "echo a \\| b"])).code).toBe(0);
    // The cell stores the escaped form; reading it back yields the logical text.
    expect(text(path)).toContain("| 1 | 已修 | P2 | 甲 | echo a \\| b |");
    const view = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(view.criteria).toBe("echo a | b");
  });
});

describe("reopen: a no-op says so instead of failing", () => {
  test("reopening an issue that is already open (default status) is a no-op", async () => {
    const path = await withIssue("**验收判据**：x\n");
    const result = await run(["reopen", path, "1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("(no changes)\n");
    const dry = await run(["reopen", path, "1", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toBe("(no changes)\n");
    expect(dry.stderr).toContain("snapshot:");
  });

  test("an explicit different open status is applied", async () => {
    const path = await withIssue("**验收判据**：x\n");
    const result = await run(["reopen", path, "1", "--status", "观察"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(text(path)).toContain("| 1 | 观察 |");
    expect((await run(["check", path])).code).toBe(0);
  });

  test("a closed issue still reopens", async () => {
    const path = await withIssue("**验收判据**：x\n");
    expect((await run(["close", path, "1"])).code).toBe(0);
    expect((await run(["reopen", path, "1"])).code).toBe(0);
    expect(text(path)).toContain("| 1 | 未决 |");
  });
});

describe("rename: renaming a duplicate to its own summary is a no-op", () => {
  test("the duplicate guard does not turn a no-op into an error", async () => {
    const path = file();
    expect((await run(["new", path, "--title", "Fix CSV", "--body-file", body("**验收判据**：x\n")])).code).toBe(0);
    expect((await run(["new", path, "--title", "FixCSV", "--allow-duplicate-title", "--body-file", body("**验收判据**：y\n")])).code).toBe(0);
    const noop = await run(["rename", path, "2", "FixCSV"]);
    expect(noop.code).toBe(0);
    expect(noop.stdout).toBe("(no changes)\n");
    // A *different* duplicate is still refused.
    expect((await run(["rename", path, "2", "Fix CSV"])).code).toBe(2);
  });
});

describe("show: check errors are reported even when every error is a bad row", () => {
  const unreadable = () => file(CANONICAL.replace(
    "| 4 | 观察 | P3 | 长列表滚动掉帧 |\n",
    "| 4 | 观察 | P3 | 长列表滚动掉帧 |\n| 8 | 未决 | P2 | 多余 | extra |\n"));

  test("a ledger whose only error is E108 still gets a note", async () => {
    const path = unreadable();
    expect((await run(["check", path])).code).toBe(3);
    const shown = await run(["show", path, "2"]);
    expect(shown.code).toBe(0);
    expect(shown.stderr).toContain("note: 'issuemd check' reports 1 error(s)");
    const miss = await run(["show", path, "99"]);
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain("note: 'issuemd check' reports 1 error(s)");
  });

  test("the note's N is every check error, not only the readable ones", async () => {
    const path = file(text(unreadable()).replace("### Issue 2: 侧栏宽度不可调", "### Issue 2: 侧栏宽度可以调"));
    const checked = await run(["check", path]);
    expect(checked.code).toBe(3);
    const miss = await run(["show", path, "99"]);
    expect(miss.stderr).toContain("reports 2 error(s)");
  });
});

describe("show: a range row's body may sit under an interior id", () => {
  const ranged = () => file(TEMPLATE
    .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
      "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 5–7 | 未决 | P2 | 区间合并问题 |\n")
    .replace("## 正文", "## 正文\n\n### Issue 6: 区间合并问题\n\n**现象**：六号现象。\n\n**验收判据**：六号判据。\n"));

  test("every id of the range borrows the body, and says whose it is", async () => {
    const path = ranged();
    for (const id of ["5", "6", "7"]) {
      const shown = await run(["show", path, id, "--json"]);
      expect(shown.code).toBe(0);
      const view = JSON.parse(shown.stdout);
      expect(view.body.id).toBe("6");
      expect(view.criteria).toBe("六号判据。");
      if (id !== "6") {
        expect(view.body.inherited).toBe(true);
        expect(view.criteriaFrom).toBe("6");
      }
    }
    const whole = await run(["show", path, "5–7", "--json"]);
    expect(JSON.parse(whole.stdout).body.id).toBe("6");
  });

  test("list --with-body and show agree on the owner", async () => {
    const path = ranged();
    const listed = JSON.parse((await run(["list", path, "--json", "--with-body"])).stdout);
    const issue = listed.issues.find((entry: { id: string }) => entry.id === "5–7");
    expect(issue.bodyFrom).toBe("6");
    expect(issue.criteria).toBe("六号判据。");
  });
});

describe("list --json --with-body: closed rows name their criteria source", () => {
  test("closed items carry criteriaSource 'table', matching show", async () => {
    const path = file(CANONICAL);
    const listed = JSON.parse((await run(["list", path, "--closed", "--json", "--with-body"])).stdout);
    const withCriteria = (listed.issues as { criteria?: string; criteriaSource?: string }[])
      .filter((issue) => issue.criteria != null);
    expect(withCriteria.length).toBeGreaterThan(0);
    for (const issue of withCriteria) expect(issue.criteriaSource).toBe("table");
  });
});

describe("show --json: label errors keep stdout machine-readable", () => {
  test("a missing label writes nothing to stdout", async () => {
    const path = file(CANONICAL);
    const result = await run(["show", path, "2", "--json", "--label", "不存在"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no label");
  });

  test("an empty label writes nothing to stdout", async () => {
    const path = await withIssue("**现象**：\n\n**验收判据**：x\n");
    const result = await run(["show", path, "1", "--json", "--label", "现象"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("empty");
  });
});

describe("adopt: diffs apply to BOM ledgers, and a no-op repeats itself", () => {
  const applies = async (content: string) => {
    const path = file(content);
    const dry = await run(["adopt", path, "--dry-run"]);
    expect(dry.code).toBe(0);
    const out = `${path}.patched`;
    const patched = spawnSync("patch", ["-s", "-o", out, path], { input: dry.stdout });
    expect(patched.stderr.toString() + patched.stdout.toString()).toBe("");
    expect(patched.status).toBe(0);
    const copy = file(content);
    expect((await run(["adopt", copy])).code).toBe(0);
    expect(readFileSync(out)).toEqual(readFileSync(copy));
  };

  test("a BOM ledger's dry-run diff applies with patch(1)", async () => {
    await applies("﻿" + ORCA_SHAPED);
  });

  test("BOM + CRLF + no final newline also applies", async () => {
    await applies("﻿" + ORCA_SHAPED.replace(/\n+$/, "").replaceAll("\n", "\r\n"));
  });

  test("an adopt that changes nothing says (no changes) on stdout too", async () => {
    const path = file(CANONICAL);
    const result = await run(["adopt", path]);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("(no changes)\n")).toBe(true);
    expect(result.stdout).toContain("已是规范台账");
  });
});

describe("check: heading counts are judged even when a section is missing", () => {
  const codes = async (content: string) => {
    const path = file(content);
    const report = JSON.parse((await run(["check", path, "--json"])).stdout);
    return report.errors.map((error: { code: string }) => error.code);
  };

  test("a count in a missing canonical section still reports E121", async () => {
    expect(await codes(CANONICAL.replace("## 已关闭", "## 已关闭（1894）"))).toContain("E121");
    expect(await codes(CANONICAL.replace("## 已关闭", "## 已关闭（3）"))).toContain("E121");
    expect(await codes(CANONICAL.replace("## 已关闭", "## 已关闭（３）"))).toContain("E121");
    expect(await codes(CANONICAL.replace("## 已关闭", "## 已关闭（2025）"))).not.toContain("E121");
  });
});

describe("check --json: E124 names the row's id", () => {
  test("an issue row outside the ledger tables carries id", async () => {
    const path = file(TEMPLATE.replace(
      "## 正文",
      "## 待处理\n\n| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 500 | 未决 | P2 | 甲 |\n\n## 正文",
    ));
    const report = JSON.parse((await run(["check", path, "--json"])).stdout);
    const e124 = report.errors.find((error: { code: string }) => error.code === "E124");
    expect(e124.id).toBe("500");
  });
});

describe("adopt report: a count only on the body heading names the issue", () => {
  test("the mechanical-change line carries the id and old → new", async () => {
    const path = file(ORCA_SHAPED.replace("### Issue 21: 草稿不会自动保存", "### Issue 21: 草稿不会自动保存（3）"));
    const adopted = await run(["adopt", path]);
    expect(adopted.code).toBe(0);
    expect(adopted.stdout).toContain("#21");
    expect(adopted.stdout).toContain("（3）");
    expect(text(path)).toContain("### Issue 21: 草稿不会自动保存\n");
  });
});

describe("W261: a criteria block holding only an HTML comment is not criteria", () => {
  test("a comment-only block warns and close refuses it", async () => {
    const path = await withIssue("**验收判据**：\n\n<!-- 只是一条注释 -->\n");
    const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(checked.warnings.some((warning: { code: string }) => warning.code === "W261")).toBe(true);
    expect((await run(["check", path, "--strict"])).code).toBe(3);
    expect((await run(["close", path, "1", "--criteria-from-body"])).code).toBe(2);
  });

  test("a comment next to real content does not warn", async () => {
    const path = await withIssue("**验收判据**：\n\n<!-- 说明 -->\n实际命令\n");
    const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(checked.warnings.some((warning: { code: string }) => warning.code === "W261")).toBe(false);
    expect((await run(["close", path, "1", "--criteria-from-body"])).code).toBe(0);
  });
});
describe("review 14: follow-ups found by the independent review", () => {
  test("a BOM followed by a blank first line: the diff still applies when H1 becomes first", async () => {
    const legacy = readFileSync(new URL("../fixtures/orca-shaped.md", import.meta.url), "utf8");
    const path = file("﻿\n" + legacy);
    const dry = await run(["adopt", path, "--dry-run"]);
    expect(dry.code).toBe(0);
    const out = `${path}.patched`;
    const patched = spawnSync("patch", ["-s", "-o", out, path], { input: dry.stdout });
    expect(patched.stderr.toString() + patched.stdout.toString()).toBe("");
    expect(patched.status).toBe(0);
    const copy = file("﻿\n" + legacy);
    expect((await run(["adopt", copy])).code).toBe(0);
    expect(readFileSync(out)).toEqual(readFileSync(copy));
  });

  test("visible text around comments is criteria; a fenced comment is content", async () => {
    const inline = await withIssue("**验收判据**：<!-- x --> 正文 <!-- y -->\n");
    expect((await run(["check", inline, "--json"])).stdout).not.toContain("W261");
    const fenced = await withIssue("**验收判据**\n\n```html\n<!-- x -->\n```\n");
    expect((await run(["check", fenced, "--json"])).stdout).not.toContain("W261");
    expect((await run(["close", fenced, "1", "--criteria-from-body"])).code).toBe(0);
  });

  test("renaming to the summary already shown keeps the escaped heading bytes", async () => {
    const path = file(TEMPLATE
      .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
        "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 1 | 未决 | P2 | a \\| b |\n| 2 | 未决 | P2 | a | b |\n")
      .replace("## 正文", "## 正文\n\n### Issue 1: a \\| b\n\n**验收判据**：x\n\n### Issue 2: a | b\n\n**验收判据**：y\n"));
    const before = text(path);
    const result = await run(["rename", path, "1", "a | b"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("(no changes)\n");
    expect(text(path)).toBe(before);
  });

  test("a range does not borrow a body whose id has a row of its own", async () => {
    const path = file(TEMPLATE
      .replace("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n",
        "| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 6 | 未决 | P2 | separate |\n| 5–7 | 未决 | P2 | range |\n")
      .replace("## 正文", "## 正文\n\n### Issue 6: separate\n\n**验收判据**：separate\n"));
    expect((await run(["check", path])).code).toBe(3); // E103 + E102: a broken ledger
    const shown = JSON.parse((await run(["show", path, "5", "--json"])).stdout);
    expect(shown.body).toBeUndefined();
    expect(shown.criteria).toBeUndefined();
    const listed = JSON.parse((await run(["list", path, "--json", "--with-body"])).stdout);
    const range = (listed.issues as { id: string; bodyFrom?: string }[]).find((issue) => issue.id === "5–7");
    expect(range?.bodyFrom).toBeUndefined();
  });

  test("a multi-line --criteria is folded instead of misdiagnosed", async () => {
    const path = await withIssue("**验收判据**：x\n");
    const result = await run(["close", path, "1", "--criteria", "甲\n乙"]);
    expect(result.code).toBe(0);
    const view = JSON.parse((await run(["show", path, "1", "--json"])).stdout);
    expect(view.criteria).toBe("甲 乙");
  });

  test("reopen without --status leaves an already-open status alone", async () => {
    const path = await withIssue("**验收判据**：x\n");
    expect((await run(["status", path, "1", "观察"])).code).toBe(0);
    const result = await run(["reopen", path, "1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("(no changes)\n");
    expect(text(path)).toContain("| 1 | 观察 |");
    // An explicit --status still applies a different open status.
    const changed = await run(["reopen", path, "1", "--status", "部分解决"]);
    expect(changed.code).toBe(0);
    expect(text(path)).toContain("| 1 | 部分解决 |");
  });
});
