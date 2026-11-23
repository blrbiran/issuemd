# issuemd Ledger-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `issuemd` into a single-purpose issue-ledger tool: add `list`/`show`/`counts`/narrow `read`, delete every generic Markdown command, then implement the P3 ledger write verbs.

**Architecture:** Read commands are thin views over `parseLedger()`. Write commands build the new line array with pure functions, re-run `checkLedger()` **in memory** and refuse if the change introduces any new error, then go through the existing `readDocument` → `joinDocument` → `writeAtomically` path so BOM, CRLF, trailing newline, mode bits and the E130 snapshot check keep working unchanged.

**Tech Stack:** TypeScript (Node ESM, `tsc`), Bun test runner, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-issuemd-ledger-only-design.md` (approved 2026-11-24), which implements `docs/spec.md` §7, §9.

## Global Constraints

- Zero runtime dependencies; `node >= 20`; tests run under `bun test src tests`.
- **Do not modify `src/io.ts`, `src/issue-id.ts`.** `src/ledger-check.ts` may only gain shared-constant imports; its checking logic stays as-is.
- Test only against `fixtures/*` synthetic ledgers. Never copy real cafe/orca ledgers into the repo or tests.
- Work on a `feat/*` branch. Commit after every task. **Never** push, merge into `main`, `npm link`, or publish without an explicit instruction from the user.
- Every write path must go through `readDocument` / `joinDocument` / `writeAtomically`. Never `split("\n")` the raw file text for a write, and never `writeFileSync` the target path.
- A write is refused (exit 3, file untouched) if the resulting content has any `checkLedger` error whose `code|id|message` key was not already present in the input ledger.
- All write verbs accept `--dry-run`, which prints a unified diff, exits 0, and leaves the bytes untouched. Validation still runs first: an invalid operation exits 3 even with `--dry-run`.
- Exit codes: `0` success, `1` no such issue / empty result, `2` usage error, `3` validation failure.

## Review Focus

Inputs and conditions the spec implies but no existing test covers. Each line names the behavior a reasonable user expects, and the task that pins it.

1. **CRLF + BOM ledger after a write** — `close`/`new` on `fixtures/crlf-bom.md`-shaped input keeps the BOM, keeps CRLF throughout (no stray LF), and keeps an unterminated last line. → Task 8.
2. **A title containing `|`** — `new --title 'a | b'` writes `a \| b` and `check` stays at 0 errors (otherwise it silently becomes `E108`). → Task 7.
3. **An id inside a retired range** — `close 8` when the closed table holds `7–20` refuses with exit 2 instead of splitting the range. → Task 8.
4. **A duplicate H2 title** — `issuemd read F 附录` when two `## 附录` exist exits 2 and lists both `L<n>` candidates instead of printing the first. → Task 3.
5. **A closed issue read back** — `show 1` prints the row plus the criteria column, no body, exit 0; `show 999` exits 1. → Task 3.
6. **Re-running a no-op verb** — `rename 2 <same summary>` and `sync --guide` on an already-canonical file leave the inode, bytes and mtime unchanged (exit 0, empty output). → Tasks 12, 11.

---

### Task 0: Branch

- [ ] **Step 1: Create the work branch from `main`**

```bash
git switch -c feat/ledger-only
git log --oneline -1
```

Expected: `eee6ebf docs: add handoff for the next agent` (or later).

- [ ] **Step 2: Confirm the green baseline**

Run: `npm run typecheck && npm test`
Expected: typecheck silent; `217 pass, 0 fail`.

---

### Task 1: Ledger body blocks and max id

`parseLedger` currently exposes table rows but not body blocks, so `show` and every write verb would re-implement the `### Issue N:` walk. Add it once.

**Files:**
- Modify: `src/ledger.ts`
- Test: `src/ledger.test.ts` (create)

**Interfaces:**
- Consumes: existing `parseLedger(src)`, `parseId`, `type IdSpan`.
- Produces:
  - `type BodyBlock = { id: IdSpan; title: string; line: number; end: number }`
  - `bodyBlocks(ledger: ReturnType<typeof parseLedger>): BodyBlock[]` — well-formed `### Issue N: title` sections strictly inside `## 正文`, in document order. Malformed headings are skipped (the checker already reports them).
  - `maxIssueId(rows: { open: LedgerRow[]; closed: LedgerRow[] }): number` — maximum `IdSpan.end` across every span in both tables (range ends included), `0` when both are empty.
  - `ISSUE_HEADING: RegExp` — `/^Issue\s+([^:\s]+)\s*:\s*(.*)$/`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bodyBlocks, maxIssueId, parseLedger } from "./ledger.js";

const src = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");

describe("bodyBlocks", () => {
  test("returns the three open issue bodies in order", () => {
    const blocks = bodyBlocks(parseLedger(src));
    expect(blocks.map((b) => `${b.id.start} ${b.title}`)).toEqual([
      "2 侧栏宽度不可调", "3 导出 CSV 丢空行", "4 长列表滚动掉帧",
    ]);
    expect(blocks[0].line).toBe(54);
    expect(blocks[0].end).toBe(59);
  });
  test("ignores a non-Issue H3 inside 正文", () => {
    const broken = src.replace("### Issue 4: 长列表滚动掉帧", "### 附录笔记");
    expect(bodyBlocks(parseLedger(broken)).map((b) => b.id.start)).toEqual([2, 3]);
  });
});

describe("maxIssueId", () => {
  test("counts the end of the retired range", () => {
    expect(maxIssueId(parseLedger(src).rows)).toBe(20);
  });
  test("is zero for empty tables", () => {
    expect(maxIssueId({ open: [], closed: [] })).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ledger.test.ts`
Expected: FAIL — `bodyBlocks` is not exported.

- [ ] **Step 3: Implement in `src/ledger.ts`**

Walk `sections` for `level === 3` whose `line_start` lies inside the `## 正文` section, apply `ISSUE_HEADING`, `parseId` group 1, and record `{id, title: group2, line, end: section.line_end}`. `maxIssueId` folds `Math.max` over `rows.open`/`rows.closed` spans' `end`. Export `ISSUE_HEADING` and use it inside `bodyBlocks`.

- [ ] **Step 4: Run tests**

Run: `bun test src/ledger.test.ts && npm test`
Expected: new file green, full suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts src/ledger.test.ts
git commit -m "feat: expose ledger body blocks and max issue id"
```

---

### Task 2: `list` and `counts`

**Files:**
- Create: `src/ledger-read.ts`
- Modify: `src/cli.ts`
- Test: `src/ledger-read.test.ts` (create), `src/cli.test.ts` (add a `describe("cli: list")` and `describe("cli: counts")`)

**Interfaces:**
- Consumes: `parseLedger`, `LedgerRow`, `checkLedger`, `STATUS_CLASSES`.
- Produces:
  - `filterRows(rows: LedgerRow[], opts: { status?: string; priority?: string }): LedgerRow[]`
  - `formatIssueRow(row: LedgerRow, id: string): string` — `2  未决  P1  侧栏宽度不可调` (two spaces between columns; an empty priority renders as `-`).
  - CLI: `issuemd list FILE [--status S] [--priority P] [--closed] [--json]`, `issuemd counts FILE [--json]`.

Pinned behavior:
- `list` prints open rows; `--closed` prints closed rows instead. `--status`/`--priority` filter either set. Empty result → stdout `(no issues)`, exit 1.
- `list --json` → `{"file":"…","table":"open","issues":[{"id","status","priority","summary","criteria"?}]}`.
- `counts` prints `open 3 (未决 1, 部分解决 1, 观察 1)   closed 17` — the same first two lines `check` prints. `--json` → `{"file","counts":{open,closed,byStatus}}`.
- Both commands on a non-ledger file (E120) exit 3 with the E120 message on stderr; a missing file exits 2.

- [ ] **Step 1: Write the failing CLI test**

```ts
describe("cli: list", () => {
  const path = fileURLToPath(new URL("../fixtures/canonical-clean.md", import.meta.url));
  test("lists the three open issues", async () => {
    const r = await run(["list", path]);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(3);
    expect(r.stdout).toContain("2  未决  P1  侧栏宽度不可调");
  });
  test("--status filters, and an empty filter exits 1", async () => {
    expect((await run(["list", path, "--status", "观察"])).stdout).toContain("4  观察");
    const empty = await run(["list", path, "--status", "撤回"]);
    expect(empty.code).toBe(1);
    expect(empty.stdout).toBe("(no issues)\n");
  });
  test("--closed lists the closed table and includes criteria in JSON", async () => {
    const r = await run(["list", path, "--closed", "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.table).toBe("closed");
    expect(doc.issues.map((i: { id: string }) => i.id)).toEqual(["1", "5", "7–20", "6"]);
    expect(doc.issues[0].criteria).toContain("12/12");
  });
});

describe("cli: counts", () => {
  test("matches the fixture's golden counts", async () => {
    const path = fileURLToPath(new URL("../fixtures/canonical-clean.md", import.meta.url));
    const r = await run(["counts", path, "--json"]);
    const expected = JSON.parse(readFileSync(
      new URL("../fixtures/canonical-clean.expected.json", import.meta.url), "utf8"));
    expect(JSON.parse(r.stdout).counts).toEqual(expected.counts);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/cli.test.ts -t "cli: list"` → FAIL, unknown command `list`.

- [ ] **Step 3: Implement**

Add `list`/`counts` to `CMDS` and the dispatcher. Both load via the existing read-only `loadFile`, then `parseLedger`. `counts` may call `checkLedger(src, file)` and reuse `.counts`; when the report holds an `E120`, print that diagnostic to stderr and exit 3.

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/ledger-read.ts src/ledger-read.test.ts src/cli.ts src/cli.test.ts
git commit -m "feat: add ledger list and counts commands"
```

---

### Task 3: `show` and narrow `read`

**Files:**
- Modify: `src/ledger-read.ts`, `src/cli.ts`
- Test: `src/ledger-read.test.ts`, `src/cli.test.ts`

**Interfaces:**
- Consumes: `bodyBlocks`, `parseLedger`, `parseId`, `IdSet`.
- Produces:
  - `type IssueView = { id: string; table: "open" | "closed"; status: string; priority: string; summary: string; criteria?: string; body?: { line: number; end: number; text: string } }`
  - `findIssue(ledger: ReturnType<typeof parseLedger>, src: string, id: string): IssueView | undefined` — resolves an exact id, and resolves a bare number that falls inside a single table's span (e.g. `show 8` on `7–20` returns that row with `id: "8"`).
  - CLI: `issuemd show FILE ID [--json] [--label NAME]`, `issuemd read FILE <H2 标题>`.

Pinned behavior:
- `show` text: first line `#2  未决  P1  侧栏宽度可调`, second line `L54-59`, blank line, then the body verbatim. A closed issue prints its criteria instead of a body (`判据: …`), exit 0. An unknown id exits 1 with `(no such issue: 999)`. An id matching two tables exits 3 (that is E104 territory).
- `show --label 验收判据` prints only the paragraph that starts with `**验收判据**` (label match is exact, `：`/`:` both accepted). A missing label exits 1 with `(no label: X)`; list the labels that do exist on a second stderr line.
- `show --json` → the `IssueView` with `body.text` populated.
- `read` matches a **level-2 title exactly** (no substring, no regex, no chain). It prints the section's raw lines from the heading through the line before the next H2 (or EOF), no decorations. Zero matches → exit 2 and list every H2 as `L<n>  <title>` on stderr. More than one match → exit 2 and list both. `read` works on any Markdown file, ledger or not.

- [ ] **Step 1: Write the failing tests**

```ts
test("show prints the row, the range and the body", async () => {
  const r = await run(["show", path, "2"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("#2  未决  P1  侧栏宽度不可调");
  expect(r.stdout).toContain("L54-");
  expect(r.stdout).toContain("**验收判据**：重启后保持上次宽度。");
});
test("show --label returns only that paragraph", async () => {
  const r = await run(["show", path, "3", "--label", "验收判据"]);
  expect(r.stdout.trim()).toBe("**验收判据**：含 3 个连续空行的样本导出后仍为 3 行。");
});
test("show of a closed issue prints criteria and no body", async () => {
  const r = await run(["show", path, "1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("判据: `a1b2c3d`：连续 3 轮 12/12");
});
test("show of an unknown id exits 1", async () => {
  expect((await run(["show", path, "999"])).code).toBe(1);
});

test("read prints an appendix section verbatim", async () => {
  const r = await run(["read", path, "附录"]);
  expect(r.code).toBe(0);
  expect(r.stdout.startsWith("## 附录")).toBe(true);
  expect(r.stdout).toContain("### 2026-11-20 复核记录");
  expect(r.stdout).not.toContain("## 正文");
});
test("read with a duplicate H2 exits 2 and lists candidates", async () => {
  const dup = file("dup-h2.md", "# T\n\n## A\n\nx\n\n## A\n\ny\n");
  const r = await run(["read", dup, "A"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("L3");
  expect(r.stderr).toContain("L7");
});
test("read with no such heading exits 2 and lists the H2s", async () => {
  const r = await run(["read", path, "附录X"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("索引");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test src/cli.test.ts -t "show"` → FAIL.

- [ ] **Step 3: Implement**

`findIssue`: iterate both tables' rows; match a row when any span's `idText` equals the argument, or the argument is a bare number covered by a span with an empty suffix. Body text comes from `bodyBlocks` by exact `id.start` and slicing `ledger.lines`. `read` uses `ledger.sections.filter(s => s.level === 2 && s.title === title)` — note `parseLedger` already strips the BOM and normalises nothing else, so `ledger.lines` is the right line array.

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/ledger-read.ts src/ledger-read.test.ts src/cli.ts src/cli.test.ts
git commit -m "feat: add ledger show and narrow read commands"
```

---

### Task 4: Delete the generic read commands

Delete `toc`, `ls`, `grep`, `links`, `code`, the selector-driven `read`, the positional fallback, `src/select.ts`, `src/render.ts`, and their tests. `sections.ts` and `scan.ts` stay — `ledger.ts` needs both.

**Files:**
- Modify: `src/cli.ts` (it loses roughly 600 lines), `src/index.ts`, `src/cli.test.ts`, `tests/bin.test.ts`
- Delete: `src/select.ts`, `src/select.test.ts`, `src/render.ts`, `src/render.test.ts`

**Interfaces:**
- Produces: `run([file])` with no subcommand → exit 2, stderr `issuemd: missing command. Try 'issuemd list FILE' or 'issuemd --help'`, file untouched.

- [ ] **Step 1: Write the failing tests**

In `src/cli.test.ts`, replace every `describe` block for a removed command with:

```ts
test("a bare file argument is a usage error pointing at list", async () => {
  const r = await run([path]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("issuemd list FILE");
});
test("removed commands are unknown", async () => {
  for (const cmd of ["toc", "ls", "grep", "links", "code", "set", "append", "insert", "rm", "promote", "demote", "mv"]) {
    const r = await run([cmd, path, "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
  }
});
```

In `tests/bin.test.ts`, replace the toc/stdin-TOC/dry-run-rename/EPIPE cases with:

```ts
test("help advertises only ledger commands", () => {
  const r = run("--help");
  expect(r.stdout).toContain("issuemd list");
  expect(r.stdout).toContain("issuemd show");
  expect(r.stdout).not.toContain("issuemd toc");
  expect(r.stdout).not.toContain("selector");
});
test("a bare file path exits 2 from the compiled bin", () => {
  expect(run(fixture).status).toBe(2);
});
test("list works from another cwd with a relative path", () => {
  const r = run("list", fixture);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("侧栏宽度不可调");
});
test("check still accepts a document on stdin", () => {
  const r = spawnSync("node", [bin, "check", "-", "--json"], { cwd, input: readFileSync(fixture, "utf8"), encoding: "utf8" });
  expect(r.status).toBe(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test` → the new assertions fail (bare file still prints a TOC; `toc` still works).

- [ ] **Step 3: Delete**

Remove the command functions and their switch cases; remove `parseSelector`/`match`/`renderSection`/`renderToc`/`truncateBody` imports; drop the `--depth`, `--flat`, `--max-results`, `--body-only`, `--no-body`, `--raw`, `--max-lines`, `--lang` options from `OPTIONS` (`--max-lines` returns in `show` only if a test needs it — it does not). Rewrite `HELP` to list exactly: `check`, `list`, `show`, `counts`, `read`, plus the P3 verbs `new`, `close`, `reopen`, `status`, `rename`, `sync`. Remove the select/render exports from `src/index.ts`. Delete the four files with `git rm`.

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npm test`
Expected: green; test count drops by roughly the deleted command tests.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "refactor: drop generic markdown read commands"
```

---

### Task 5: Delete the generic write commands and re-anchor the write-safety tests

`tests/write-safety.test.ts` currently proves P1's byte guarantees through `set`/`rename`. Those commands are going away, so the same guarantees must be asserted directly against `io.ts` **in this same task** — otherwise the guarantees become untested code.

**Files:**
- Modify: `src/cli.ts`, `src/cli.test.ts`, `tests/write-safety.test.ts`
- Keep: `src/write.ts` (pure line primitives — `unifiedDiff` and the section mutations are the building blocks for Tasks 7–13), `src/write.test.ts`

**Interfaces:**
- Produces: no new API. `loadWritableFile`, `applyWrite`, `oneMatch` are removed from `cli.ts` and re-created in Task 6 as ledger helpers with different signatures.

- [ ] **Step 1: Rewrite `tests/write-safety.test.ts` against `io.ts`**

Replace each `describe` with a direct assertion. Keep the existing spawn-based fsync-race test unchanged.

```ts
describe("D1 — BOM survives a round trip", () => {
  test("text is returned without the BOM and joined back with one", () => {
    const path = file("bom.md", "﻿# Title\n\n## Section\ntext\n");
    const doc = readDocument(path);
    expect(doc.bom).toBe(true);
    expect(doc.text.startsWith("# Title")).toBe(true);
    expect(joinDocument(doc.text.split("\n").slice(0, -1), doc).startsWith("﻿# Title")).toBe(true);
  });
});
describe("D2 — fenced heading-lookalikes are not headings", () => {
  test("scan ignores ## inside a fence", () => {
    const src = "# T\n\n## A\n\n```md\n## not a heading\n```\n\n## B\n";
    expect(scan(src).map((h) => h.title)).toEqual(["T", "A", "B"]);
  });
});
describe("D4 — line endings and the trailing-newline flag", () => {
  test("CRLF round-trips with no stray LF", () => {
    const path = file("crlf.md", "# T\r\n\r\n## A\r\n\r\nold\r\n");
    const doc = readDocument(path);
    expect(doc.eol).toBe("\r\n");
    const out = joinDocument(doc.text.slice(0, -1).split("\n"), doc);
    expect(out).toBe("# T\r\n\r\n## A\r\n\r\nold\r\n");
  });
  test("an unterminated file stays unterminated", () => {
    const path = file("no-final.md", "# T\n\n## A\n\nold");
    const doc = readDocument(path);
    expect(doc.finalNewline).toBe(false);
    expect(joinDocument(["# T", "", "## A", "", "new"], doc)).toBe("# T\n\n## A\n\nnew");
  });
});
describe("write safety", () => {
  test("a successful atomic write replaces content and keeps the mode", () => {
    const path = file("mode.md", "# T\n");
    chmodSync(path, 0o600);
    expect(writeAtomically(path, "# U\n", readDocument(path).stat)).toEqual({ ok: true });
    expect(read(path).toString()).toBe("# U\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  // keep: snapshot mismatch, same-size-same-mtime replacement, fsync race
});
```

Remove the D3 selector-ambiguity block (that behavior now lives in `read`, covered in Task 3) and the D5 stdin block (returns with `--body-file` in Task 7 — add it there). Remove the D6 promote block and the D7 ledger-`rm` block; their premises no longer exist.

- [ ] **Step 2: Run to verify the new file fails only where it should**

Run: `bun test tests/write-safety.test.ts`
Expected: FAIL on the imports this rewrite adds (`readDocument`, `joinDocument`, `writeAtomically`, `scan`) — they are not imported yet.

- [ ] **Step 3: Delete the CLI commands and their tests**

Remove `cmdSet`, `cmdAppend`, `cmdInsert`, `cmdRm`, the generic `cmdRename`, `cmdPromote`, `cmdDemote`, `cmdMv`, `requireBody`, `stdinIsRedirected`, `bodyLinesAt`, `oneMatch`, `loadWritableFile`. Keep `applyWrite` (rename its `Loaded` argument type to what Task 6 needs) and the `write.ts` imports `unifiedDiff`. Delete the corresponding `describe` blocks in `src/cli.test.ts` (`cli: set`, `append`, `insert`, `rm`, `rename`, `promote`, `demote`, `mv`, `write edge cases`).

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "refactor: drop generic markdown write commands; test io directly"
```

---

### Task 6: Ledger editing primitives

**Files:**
- Create: `src/ledger-edit.ts`
- Test: `src/ledger-edit.test.ts` (create)

**Interfaces:**
- Consumes: `type TableRange`, `type PipeBlock` (exported from `ledger.ts` in this task), `STATUS_CLASSES`, `type Diagnostic`.
- Produces (all pure; 1-indexed line numbers, `string[]` in / `string[]` out):
  - `escapeCell(text: string): string` — `|` → `\|`, CR/LF → space.
  - `formatRow(cells: string[]): string` — `| a | b |`.
  - `replaceCell(line: string, index: number, value: string): string` — rewrites cell `index` only, re-escaping `value`; other cells keep their exact text.
  - `cellAt(line: string, index: number): string` — the *unescaped* value `splitCells` would produce.
  - `tableRange(ledger, kind: TableKind): { start: number; end: number } | undefined` — `start` = block's first line, `end` = its last line.
  - `insertLines(lines, at, added): string[]`, `removeLines(lines, at, count): string[]` — `at` is 1-indexed; `at = lines.length + 1` appends.
  - `bodySkeleton(title: string, criteria?: string): string[]` — `["### Issue N: title", "", "**现象**：", "", "**根因**：", "", "**期望**：", "", "**验收判据**：<criteria or empty>"]`; the caller supplies the `Issue N:` prefix via `title`.
  - `extractCriteria(bodyLines: string[]): string | undefined` — the paragraph after `**验收判据**` (`：`/`:`), up to the next blank line or `**label**` line, whitespace-folded.
  - `statusBlockLines(): string[]` — `["| 状态 | 分类 |", "|---|---|", ...STATUS_CLASSES]`.
  - `guideBlockLines(): string[]` — the fixed markdown table pinned below.

`guideBlockLines()` must be exactly:

```text
| 你想做什么 | 命令 |
|---|---|
| 查看开放项 | `issuemd list FILE` |
| 读一条 | `issuemd show FILE ID` |
| 新增 | `issuemd new FILE --title "…"` |
| 关闭 | `issuemd close FILE ID --criteria-from-body` |
| 改状态 | `issuemd status FILE ID 状态` |
| 重命名 | `issuemd rename FILE ID "新标题"` |
| 校验 | `issuemd check FILE` |
```

Add to `src/ledger.ts`: `export type { PipeBlock }` and return `blocks` from `parseLedger` (additive; existing callers ignore it). `tableRange` locates the block strictly inside the `## 索引` / `## 已关闭` section.

- [ ] **Step 1: Write the failing tests**

```ts
test("replaceCell touches one cell and escapes the pipe", () => {
  const line = "| 2 | 未决 | P1 | 侧栏宽度不可调 |";
  expect(replaceCell(line, 3, "a | b")).toBe("| 2 | 未决 | P1 | a \\| b |");
  expect(replaceCell(line, 1, "观察")).toBe("| 2 | 观察 | P1 | 侧栏宽度不可调 |");
});
test("cellAt decodes an escaped pipe", () => {
  expect(cellAt("| 2 | a \\| b |", 1)).toBe("a | b");
});
test("extractCriteria returns the criteria paragraph only", () => {
  const body = ["**现象**：x。", "**验收判据**：重启后", "保持上次宽度。", "", "末尾"];
  expect(extractCriteria(body)).toBe("重启后 保持上次宽度。");
  expect(extractCriteria(["**现象**：x。"])).toBeUndefined();
});
test("tableRange covers the index table including its header", () => {
  const { rows } = parseLedger(src);
  expect(tableRange(parseLedger(src), "open")).toEqual({ start: 37, end: 41 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/ledger-edit.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

`replaceCell`/`cellAt` re-derive cell boundaries the same way `splitCells` does (only unescaped `|` splits) but keep the original separators so padding and spacing outside the cell are untouched.

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npm test`

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts src/ledger-edit.ts src/ledger-edit.test.ts
git commit -m "feat: add pure ledger editing primitives"
```

---

### Task 7: `new`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli-write.test.ts` (create)

**Interfaces:**
- Consumes: Task 6 primitives, `bodyBlocks`, `maxIssueId`, `parseLedger`, `checkLedger`, `readDocument`, `writeAtomically`.
- Produces CLI: `issuemd new FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-] [--dry-run]`.
- Produces internal `commit(file, doc, before: Diagnostic[], newLines: string[], dryRun: boolean): CliResult` — shared by Tasks 7–13. It joins with `joinDocument`, runs `checkLedger` on the result, computes `newErrors = keyed(result.errors) − keyed(before)`, and returns exit 3 listing those errors when any exist; otherwise prints the diff (`--dry-run`) or writes atomically and prints nothing.

Pinned behavior:
- Default id = `maxIssueId + 1`; `--id N` collides with any existing span → exit 2 `id N already exists`.
- Default status `未决`, priority `P2`. A status outside `STATUS_CLASSES` → exit 2. A `closed`-class status is refused (`use close`).
- Index row is inserted after the last row whose id is smaller, keeping ascending order.
- Body block is appended at the end of `## 正文` (after its last line, before `## 附录`).
- `--body-file -` reads stdin; `--body-file PATH` reads a file; with neither, the four-label skeleton is used.
- `--title` is required; missing → exit 2.

- [ ] **Step 1: Write the failing tests**

```ts
const ledger = () => file("new.md", readFileSync(fixture, "utf8"));

test("new inserts an index row and a body block and keeps check at 0 errors", async () => {
  const path = ledger();
  const r = await run(["new", path, "--title", "缓存未失效", "--status", "未决", "--priority", "P1"]);
  expect(r.code).toBe(0);
  const after = readFileSync(path, "utf8");
  expect(after).toContain("| 21 | 未决 | P1 | 缓存未失效 |");
  expect(after).toContain("### Issue 21: 缓存未失效");
  expect((await run(["check", path])).code).toBe(0);
});
test("--dry-run prints a diff and leaves the file byte-identical", async () => {
  const path = ledger();
  const before = readFileSync(path);
  const r = await run(["new", path, "--title", "x", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("+### Issue 21: x");
  expect(readFileSync(path)).toEqual(before);
});
test("a title with a pipe stays one cell", async () => {
  const path = ledger();
  expect((await run(["new", path, "--title", "a | b"])).code).toBe(0);
  const report = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(report.errors).toEqual([]);
  expect(readFileSync(path, "utf8")).toContain("| 21 | 未决 | P2 | a \\| b |");
});
test("a taken --id exits 2 and writes nothing", async () => {
  const path = ledger();
  const before = readFileSync(path);
  const r = await run(["new", path, "--title", "x", "--id", "2"]);
  expect(r.code).toBe(2);
  expect(readFileSync(path)).toEqual(before);
});
test("--body-file - reads stdin", () => {
  const path = ledger();
  const child = spawnSync("sh", ["-c",
    `printf '**现象**：from-stdin\\n' | node "${bin}" new "${path}" --title x --body-file -`],
    { encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(readFileSync(path, "utf8")).toContain("**现象**：from-stdin");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/cli-write.test.ts -t "new"` → FAIL, unknown command.

- [ ] **Step 3: Implement**

`applyWrite` from Task 5 is replaced by `commit`, which owns the validation gate. Build lines with `insertLines`; update the index via `tableRange(ledger, "open").end + 1`.

- [ ] **Step 4: Run tests + commit**

```bash
npm run typecheck && npm test
git add src/cli.ts src/cli-write.test.ts
git commit -m "feat: add ledger new command"
```

---

### Task 8: `close`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli-write.test.ts`

**Interfaces:**
- Produces CLI: `issuemd close FILE ID [--criteria "…" | --criteria-from-body] [--keep-body] [--dry-run]`.

Pinned behavior:
- Only open issues can be closed. Unknown id → exit 1; already-closed id → exit 2 `#N is already closed`.
- An id that only exists inside a retired range (`7–20`) → exit 2 `#N is inside retired range 7–20`; the range is never split.
- Criteria: `--criteria` verbatim, else `--criteria-from-body` extracts `extractCriteria` from the body, else empty. Both flags at once → exit 2.
- Removes the index row, removes the body block (heading through `line_end`), and appends the closed row to the end of `## 已关闭` (the closed table is **not** re-sorted — the canonical fixture is not ascending).
- `--keep-body` moves the body block's lines into `## 附录` after its last line instead of deleting them, and prints a `W250`-shaped warning on stderr.
- The commit gate runs `checkLedger`; a successful close must leave 0 errors on the canonical fixture.

- [ ] **Step 1: Write the failing tests**

```ts
test("close moves the row, deletes the body and keeps check clean", async () => {
  const path = ledger();
  const r = await run(["close", path, "3", "--criteria-from-body"]);
  expect(r.code).toBe(0);
  const after = readFileSync(path, "utf8");
  expect(after).not.toContain("| 3 | 部分解决 |");
  expect(after).not.toContain("### Issue 3:");
  expect(after).toContain("| 3 | 已修 | P2 | 导出 CSV 丢空行 |");
  expect((await run(["check", path])).code).toBe(0);
});
test("--criteria-from-body lifts the 验收判据 paragraph", async () => {
  const path = ledger();
  await run(["close", path, "2", "--criteria-from-body"]);
  expect(readFileSync(path, "utf8")).toContain("重启后保持上次宽度。");
  expect(readFileSync(path, "utf8")).not.toContain("### Issue 2:");
});
test("--keep-body moves the body into 附录 and warns", async () => {
  const path = ledger();
  const r = await run(["close", path, "2", "--keep-body"]);
  expect(r.stderr).toContain("W250");
  const after = readFileSync(path, "utf8");
  expect(after.indexOf("### Issue 2:")).toBeGreaterThan(after.indexOf("## 附录"));
});
test("closing an id inside a retired range exits 2", async () => {
  expect((await run(["close", ledger(), "8"])).code).toBe(2);
});
test("closing twice exits 2; an unknown id exits 1", async () => {
  const path = ledger();
  await run(["close", path, "2"]);
  expect((await run(["close", path, "2"])).code).toBe(2);
  expect((await run(["close", path, "999"])).code).toBe(1);
});
test("a CRLF+BOM ledger stays CRLF+BOM after close", async () => {
  const path = file("crlf-close.md", readFileSync(new URL("../fixtures/crlf-bom.md", import.meta.url)));
  const before = readFileSync(path);
  await run(["close", path, "2"]);
  const after = readFileSync(path);
  expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(after.toString("utf8").replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  expect(after.toString("utf8").endsWith("\n")).toBe(before.toString("utf8").endsWith("\n"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/cli-write.test.ts -t "close"` → FAIL.

- [ ] **Step 3: Implement**

Deletion order matters: remove the body block first, then the index row, so earlier line numbers stay valid. Recompute `tableRange` from a fresh `parseLedger` of the intermediate lines if needed — or delete the higher line number first.

- [ ] **Step 4: Run tests + commit**

```bash
npm run typecheck && npm test
git add src/cli.ts src/cli-write.test.ts
git commit -m "feat: add ledger close command"
```

---

### Task 9: `status` and `rename`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli-write.test.ts`

**Interfaces:**
- Produces CLI:
  - `issuemd status FILE ID NEW_STATUS [--dry-run]`
  - `issuemd rename FILE ID "T" [--dry-run]`

Pinned behavior:
- `status`: same-category only. `issuemd status F 2 已修` (open → closed) → exit 2, stderr `#2 is 未决 (open); 已修 is closed — use 'issuemd close'`. Closed → closed works; open → open works. Only the status cell changes (`replaceCell(line, 1, …)`).
- `rename`: rewrites the summary cell **and** the body H3 title in one commit; a closed issue has no body so only the cell changes. The new title must fold-whitespace-equal the body title it writes. Identical rename → exit 0, empty stdout, file inode unchanged.
- Renaming to a title containing `|` escapes it and stays `check`-clean.

- [ ] **Step 1: Write the failing tests**

```ts
test("status changes the cell for a same-category move", async () => {
  const path = ledger();
  expect((await run(["status", path, "3", "未决"])).code).toBe(0);
  expect(readFileSync(path, "utf8")).toContain("| 3 | 未决 | P2 | 导出 CSV 丢空行 |");
  expect((await run(["check", path])).code).toBe(0);
});
test("status refuses a cross-category move and points at close", async () => {
  const path = ledger();
  const before = readFileSync(path);
  const r = await run(["status", path, "2", "已修"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("issuemd close");
  expect(readFileSync(path)).toEqual(before);
});
test("rename rewrites the row and the body heading together", async () => {
  const path = ledger();
  expect((await run(["rename", path, "2", "侧栏宽度可拖拽"])).code).toBe(0);
  const after = readFileSync(path, "utf8");
  expect(after).toContain("| 2 | 未决 | P1 | 侧栏宽度可拖拽 |");
  expect(after).toContain("### Issue 2: 侧栏宽度可拖拽");
  expect((await run(["check", path])).code).toBe(0);
});
test("a no-op rename leaves the inode untouched", async () => {
  const path = ledger();
  const before = statSync(path).ino;
  const r = await run(["rename", path, "2", "侧栏宽度不可调"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(statSync(path).ino).toBe(before);
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

`rename` must handle the closed table too: no body block → cell only. Use `bodyBlocks` to find the block for open ids.

- [ ] **Step 4: Run tests + commit**

```bash
npm run typecheck && npm test
git add src/cli.ts src/cli-write.test.ts
git commit -m "feat: add ledger status and rename commands"
```

---

### Task 10: `reopen`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli-write.test.ts`

**Interfaces:**
- Produces CLI: `issuemd reopen FILE ID [--dry-run]`.

Pinned behavior:
- Only closed issues can be reopened. Unknown → exit 1; still open → exit 2.
- Removes the closed row, inserts an index row **in ascending order** with status `未决` and the row's existing priority (empty priority → `P2`), and inserts a body skeleton at the end of `## 正文` whose `**验收判据**` is backfilled from the closed row's criteria column when non-empty (the text keeps its backticks verbatim).
- A range row is not reopened (`#7–20 is a range; reopen is not supported`) → exit 2.

- [ ] **Step 1: Write the failing tests**

```ts
test("reopen restores an open row with the criteria backfilled", async () => {
  const path = ledger();
  expect((await run(["reopen", path, "1"])).code).toBe(0);
  const after = readFileSync(path, "utf8");
  expect(after).toContain("| 1 | 未决 | P3 | 登录页闪烁 |");
  expect(after).toContain("### Issue 1: 登录页闪烁");
  expect(after).toContain("**验收判据**：`a1b2c3d`：连续 3 轮 12/12");
  expect((await run(["check", path])).code).toBe(0);
});
test("reopen of a range, an open id, and an unknown id all fail", async () => {
  expect((await run(["reopen", ledger(), "8"])).code).toBe(2);
  expect((await run(["reopen", ledger(), "2"])).code).toBe(2);
  expect((await run(["reopen", ledger(), "999"])).code).toBe(1);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: run `npm run typecheck && npm test`.**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli-write.test.ts
git commit -m "feat: add ledger reopen command"
```

---

### Task 11: `sync --guide`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli-write.test.ts`

**Interfaces:**
- Produces CLI: `issuemd sync FILE [--guide] [--dry-run]` (other `sync` flags arrive in Tasks 12–13; with no flags, `sync` exits 2 with usage).

Pinned behavior:
- Rewrites only the lines strictly between `<!-- issuemd:guide:begin -->` and `<!-- issuemd:guide:end -->` with `guideBlockLines()`, and between `<!-- issuemd:statuses:begin -->` / `end` with `statusBlockLines()`. Lines outside the markers, including the markers themselves, are byte-identical.
- Missing or duplicated markers → exit 3 with the E112 message from `checkLedger`.
- Already canonical → exit 0, empty stdout, inode unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
test("sync --guide regenerates both controlled blocks, touching nothing else", async () => {
  const path = ledger();
  let text = readFileSync(path, "utf8");
  text = text.replace("| 看开放项 | `issuemd list FILE` |", "| 看 | old |");
  text = text.replace("| 观察 | open |", "| 观察 | Open |");
  writeFileSync(path, text);
  const before = readFileSync(path, "utf8").split("\n");
  const r = await run(["sync", path, "--guide"]);
  expect(r.code).toBe(0);
  const after = readFileSync(path, "utf8").split("\n");
  const changed = after.filter((line, i) => line !== before[i]);
  expect(changed).toContain("| 查看开放项 | `issuemd list FILE` |");
  expect(after).toContain("| 观察 | open |");
  expect(after.length).toBe(before.length);
  expect((await run(["check", path])).code).toBe(0);
});
test("a second sync --guide is a no-op", async () => {
  const path = ledger();
  const inode = statSync(path).ino;
  await run(["sync", path, "--guide"]);
  const r = await run(["sync", path, "--guide"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(statSync(path).ino).toBe(inode);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: run `npm run typecheck && npm test`.**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli-write.test.ts
git commit -m "feat: add sync --guide"
```

---

### Task 12: `sync --fix-tables`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli-write.test.ts`

Pinned behavior:
- Every pipe block without a separator row gets one inserted directly after its first line, with one `---` per cell of that first line.
- Exception: the block inside `## 索引` / `## 已关闭` whose first line is not the canonical header gets the canonical header **and** separator inserted before it (otherwise the first data row would silently become a header).
- Blocks already carrying a separator are untouched. Result must be `E122`-free.
- Running it on the canonical fixture is a no-op (exit 0, empty stdout).

- [ ] **Step 1: Write the failing tests**

```ts
test("sync --fix-tables inserts the missing separators reported by E122", async () => {
  const path = file("no-sep.md", "# Demo Issue 台账\n\n## 怎么用\n\n<!-- issuemd:guide:begin -->\n<!-- issuemd:guide:end -->\n\n## 状态口径\n\n<!-- issuemd:statuses:begin -->\n<!-- issuemd:statuses:end -->\n\n## 索引\n\n| 2 | 未决 | P1 | 侧栏宽度不可调 |\n\n## 已关闭\n\n## 正文\n\n### Issue 2: 侧栏宽度不可调\n\n**现象**：x\n\n## 附录\n");
  const r = await run(["sync", path, "--fix-tables"]);
  expect(r.code).toBe(0);
  const after = readFileSync(path, "utf8");
  expect(after).toContain("| # | 状态 | P | 摘要 |\n|---|---|---|---|\n| 2 | 未决 | P1 | 侧栏宽度不可调 |");
  expect((await run(["check", path, "--json"])).stdout).not.toContain("E122");
 });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: run `npm run typecheck && npm test`.**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli-write.test.ts
git commit -m "feat: add sync --fix-tables"
```

---

### Task 13: `sync --titles`

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli-write.test.ts`

**Interfaces:**
- Produces CLI: `issuemd sync FILE [--titles] [--prefer body|table] [--move-progress | --drop-progress] [--dry-run]`.

Pinned behavior:
- Default direction `--prefer=body`: the index summary is replaced with the body H3 title. `--prefer=table`: the body H3 title is replaced with the summary.
- Before writing, `--prefer=body` scans every summary it would overwrite for the progress words `已落地|仍缺|仍无|仍逐|仍走`. If any hit and neither `--move-progress` nor `--drop-progress` is given → exit 3, listing each `#id` and the summary; nothing written.
- `--move-progress`: inserts `> **进展（来自旧表）**：<old summary>` as the first body line, then sets the summary from the title.
- `--drop-progress`: discards the old summary silently.
- Both progress flags together, or either one without `--titles` → exit 2.
- `--prefer=table` never needs the guard.

- [ ] **Step 1: Write the failing tests**

```ts
test("sync --titles aligns the summary with the body title", async () => {
  const path = ledger();
  writeFileSync(path, readFileSync(path, "utf8").replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 宽度问题 |"));
  expect((await run(["sync", path, "--titles"])).code).toBe(0);
  expect(readFileSync(path, "utf8")).toContain("| 2 | 未决 | P1 | 侧栏宽度不可调 |");
  expect((await run(["check", path])).code).toBe(0);
});
test("--prefer=table rewrites the heading instead", async () => {
  const path = ledger();
  writeFileSync(path, readFileSync(path, "utf8").replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 宽度问题 |"));
  await run(["sync", path, "--titles", "--prefer=table"]);
  expect(readFileSync(path, "utf8")).toContain("### Issue 2: 宽度问题");
});
test("progress text blocks the default direction unless resolved", async () => {
  const path = ledger();
  writeFileSync(path, readFileSync(path, "utf8").replace("| 2 | 未决 | P1 | 侧栏宽度不可调 |", "| 2 | 未决 | P1 | 宽度问题，仍缺记忆 |"));
  const before = readFileSync(path);
  const blocked = await run(["sync", path, "--titles"]);
  expect(blocked.code).toBe(3);
  expect(blocked.stderr).toContain("#2");
  expect(readFileSync(path)).toEqual(before);
  expect((await run(["sync", path, "--titles", "--move-progress"])).code).toBe(0);
  expect(readFileSync(path, "utf8")).toContain("> **进展（来自旧表）**：宽度问题，仍缺记忆");
});
test("progress flags without --titles are a usage error", async () => {
  expect((await run(["sync", ledger(), "--drop-progress"])).code).toBe(2);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: run `npm run typecheck && npm test`.**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli-write.test.ts
git commit -m "feat: add sync --titles"
```

---

### Task 14: Docs, help text and the stale delete-list

**Files:**
- Modify: `README.md`, `skills/issuemd/SKILL.md`, `docs/superpowers/specs/2026-11-24-issuemd-ledger-only-design.md`, `docs/handoff/handoff.md`

- [ ] **Step 1: Update the design doc's delete list**

Its "连带删除" line says `src/write.ts` 中的变更函数. Those primitives are now used by Tasks 7–13. Replace that clause with: `删除通用命令的 CLI 处理层；src/write.ts 的行级原语（removeSection / insertAfter / renameSection / unifiedDiff）保留给台账写命令复用`. Same for `src/render.ts`, which was deleted whole.

- [ ] **Step 2: Update `README.md` and `skills/issuemd/SKILL.md`**

The command surface must match `issuemd --help` exactly. SKILL.md already describes `list`/`show`/`counts`; verify every command it mentions exists, and that nothing mentions `toc`, `ls`, `grep`, `set`, `rm`, `promote`, selectors, or `issuemd FILE`.

- [ ] **Step 3: Rewrite the handoff**

Replace the "立刻要做的决定" and "还没做" sections: the ledger-only design is approved and implemented through P3; remaining work is P4 `adopt` and P5 cleanup (delete `check-issues.mjs` / `verify-facts.mjs`, ship SKILL.md in the npm package).

- [ ] **Step 4: Verify and commit**

```bash
grep -n "issuemd toc\|issuemd set\|issuemd rm\|selector" README.md skills/issuemd/SKILL.md
npm run typecheck && npm test
git add README.md skills/issuemd/SKILL.md docs/
git commit -m "docs: align docs with the ledger-only surface"
```

---

## Verification

```bash
npm run typecheck && npm test
node dist/bin/issuemd.js check fixtures/canonical-clean.md
# open 3 (未决 1, 部分解决 1, 观察 1)   closed 17 / 0 errors
node dist/bin/issuemd.js list fixtures/canonical-clean.md       # 3 rows
node dist/bin/issuemd.js show fixtures/canonical-clean.md 2     # row + body
node dist/bin/issuemd.js counts fixtures/canonical-clean.md     # matches expected.json
node dist/bin/issuemd.js read fixtures/canonical-clean.md 附录  # appendix only
node dist/bin/issuemd.js fixtures/canonical-clean.md            # exit 2, "missing command"
```
---

## 执行记录（2026-11-24）

14 个 task 全部执行完毕，测试从 217 增至 175 —— 注意是**减少**：删除通用命令时一并删掉了约 60 个只覆盖已删命令的用例，新增的台账读/写用例净增约 20 个。

与计划的偏差（均有测试覆盖）：

| 计划 | 实际 | 原因 |
|---|---|---|
| 读命令用例加进 `src/cli.test.ts` | 新建 `src/cli-ledger.test.ts`、`src/cli-write.test.ts` | `cli.test.ts` 整体随通用命令删除，新用例单独成文件不会丢 |
| Task 5 的 D5 stdin 用例移到 Task 7 | 由 `new --body-file -` 的真实 shell 管道用例覆盖 | `set` 已删，`--body-file` 是唯一 stdin 入口 |
| `--keep-body` 把正文块原样搬进附录 | 归档为 `### #N <摘要>（已关闭，正文保留）` | I12/E123 禁止附录出现 Issue 标题，原设计自相矛盾 |
| 未提及 | per-id 命令拒绝多编号行（exit 2） | `close`/`rename`/`status`/`reopen` 无法只改一个号 |
| 未提及 | `new --id` 接受 `\d+[a-z]?` | 真实台账有 `393b` |
| 未提及 | `fixTables` 给台账内无表头块补标准表头 | 否则首行数据会被当成表头（规格 §2.6 的坑） |

`src/write.ts` 的行级原语与 `src/sections.ts` 保留（台账写命令与 `read` 复用），其余按计划删除。
