# 第二十二轮实现计划：W201 出口、写路径诊断、归档卫生

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `check` 能报出并约束体积、让 W201 可配置且有出口、让写命令有回执与准确的失败诊断，并修好重复/空 `## 附录` 的结构问题。

**Architecture:** 台账前言新增 `<!-- issuemd:limits: … -->` 标记（与 high-water 同构）；`check` 增加体积度量与 W266/W267；`commit()` 增加统一回执参数；`close`/`reopen` 在附录不唯一时拒绝，并用 `appendix:auto` 标记做空附录回收。

**Tech Stack:** TypeScript（ESM）、bun test、无运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-27-w201-exit-and-write-diagnostics-design.md`

> 实施以最终规格与回归测试为准。附录守卫只拒绝重复标题，缺失仍可创建。归档度量与只读视图共用 payload 边界。提示使用候选 `check` 结果。遇到不独占一行的 limits 标记时拒写。提交按实际验证批次合并。

## Global Constraints

- 语言与构建：TS ESM，`npm run typecheck && npm test`；测试命令为 `bun test src tests`（`npm test` 会先编译到 `.dist-test/`）。
- 字节保真：写路径必须保持 CRLF/BOM/无尾换行的原样；`--dry-run` diff 必须可被 `patch(1)` 应用。
- 诊断码不复用：本轮新增 `W266`（重复附录）、`W267`（limits 标记异常）。已用码：E101–E130、W201–W265，不得改号。
- 一切写命令走 `commit()`；不得绕过门禁、原子写与写锁。
- 既有 724 项测试必须全绿；契约变更处同步改旧用例并在 `docs/handoff/handoff.md` 记录。
- 外部台账（`../issuemd_dogfooding`、`../cafe_dogfooding`、`../orca_archived_files`）只读。
- 注释用英文，与现有代码一致；用户可见输出沿用现有中英混用风格（诊断消息英文，示例里的中文原样保留）。

## Review Focus

这些是 spec 没写、但使用者一定会遇到的输入；每个都在对应 task 里有测试：

1. **limits 标记写在第一个 H2 之后**（例如误放在 `## 附录` 里）→ 必须被忽略并按默认值处理，不得让 `check` 崩或静默改口径。
2. **`--body-file -` 从 stdin 读入时 `check --json` 的 `size`**：stdin 没有文件路径，仍须给出 `bytes/lines`，`file` 字段保持 `-`。
3. **`close --keep-body` 到已有空 `## 附录`（无 auto 标记）再 `reopen`**：不得删除那个人写的空节。
4. **`appendix:auto` 标记在 `reopen` 时与用户后续追加的正文共存**：只删归档与标记，其余逐字保留。
5. **回执里的 snapshot 是写入后内容**：连续 `status --if-unchanged S1` → 用回执里的 S2 再写必须成功（不能在写入前算 snapshot）。

---

### Task 1: limits 标记解析、W267、`check --json` 回显

**Files:**
- Modify: `src/ledger.ts`（新增 `LIMITS_MARKER`、`limitsRecords()`、`DEFAULT_LIMITS`）
- Modify: `src/ledger-check.ts`（W267）
- Modify: `src/cli.ts:400-446`（`cmdCheck` 的 JSON 与文本）
- Test: `src/round22.test.ts`（新建）

**Interfaces:**
- Produces: `export const DEFAULT_LIMITS = { bodyBytes: 20 * 1024, bodyLines: 300 }`
- Produces: `export const LIMITS_MARKER = "<!-- issuemd:limits:"`
- Produces: `export type LimitsRecord = { line: number; bodyBytes?: number; bodyLines?: number; problem?: string }`
- Produces: `export function limitsRecords(ledger: { lines: string[]; sections: Section[] }): LimitsRecord[]`
- Produces: `export function effectiveLimits(ledger): { bodyBytes: number; bodyLines: number; source: "ledger" | "default" }`

规则：只扫**第一个 H2 之前**、非 fence 的行；形如 `<!-- issuemd:limits: body-bytes=N body-lines=M -->`；两个键都可省略；值为正安全整数；未知键或坏值 → 返回带 `problem` 的记录（由 check 报 W267，并退回默认）。多条记录 → 全部返回（W267 报「duplicated」）。

- [ ] **Step 1: 写失败用例**

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

// 与 src/round21.test.ts 相同：模块级临时目录 + 每个用例一个 fixtures 副本。
const dir = mkdtempSync(join(tmpdir(), "issuemd-round22-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fixture = new URL("../fixtures/canonical-clean.md", import.meta.url).pathname;
let counter = 0;
function ledgerFrom(base: string, preamble = "", tail = ""): string {
  const src = readFileSync(base, "utf8");
  const at = src.search(/^## /m);
  const text = preamble ? `${src.slice(0, at)}${preamble}\n${src.slice(at)}` : src;
  const path = join(dir, `round22-${counter++}.md`);
  writeFileSync(path, text + tail);
  return path;
}

describe("W267: ledger limits marker", () => {
  test("a preamble marker changes the effective limits", async () => {
    const path = ledgerFrom(fixture, "<!-- issuemd:limits: body-bytes=40960 body-lines=600 -->\n");
    const result = await run(["check", path, "--json"]);
    const doc = JSON.parse(result.stdout);
    expect(doc.limits).toEqual({ bodyBytes: 40960, bodyLines: 600, source: "ledger" });
  });
  test("no marker means defaults and source default", async () => {
    const doc = JSON.parse((await run(["check", fixture, "--json"])).stdout);
    expect(doc.limits).toEqual({ bodyBytes: 20480, bodyLines: 300, source: "default" });
  });
  test("a marker after the first H2 is ignored", async () => {
    const path = ledgerFrom(fixture, "", "## 附录\n\n<!-- issuemd:limits: body-bytes=1 -->\n");
    const doc = JSON.parse((await run(["check", path, "--json"])).stdout);
    expect(doc.limits.source).toBe("default");
  });
  test("a bad value warns W267 and falls back to defaults", async () => {
    const path = ledgerFrom(fixture, "<!-- issuemd:limits: body-bytes=0 -->\n");
    const result = await run(["check", path, "--json"]);
    const doc = JSON.parse(result.stdout);
    expect(doc.limits.source).toBe("default");
    expect(doc.warnings.some((w: { code: string }) => w.code === "W267")).toBe(true);
  });
});
```

`ledgerFrom(base, preamble, tail)` 是本测试文件内的 helper：读 `base`，把 `preamble` 插到第一个 `## ` 之前，把 `tail` 追加到末尾，写入临时文件并返回路径。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t W267`
Expected: FAIL — `doc.limits` 是 `undefined`。

- [ ] **Step 3: 在 `src/ledger.ts` 实现**

```ts
export const LIMITS_MARKER = "<!-- issuemd:limits:";
export const DEFAULT_LIMITS = { bodyBytes: 20 * 1024, bodyLines: 300 } as const;
export type LimitsRecord = { line: number; bodyBytes?: number; bodyLines?: number; problem?: string };
export function limitsRecords(ledger: { lines: string[]; sections: Section[] }): LimitsRecord[] { … }
export function effectiveLimits(ledger): { bodyBytes: number; bodyLines: number; source: "ledger" | "default" }
```

`limitsRecords` 与 `highWaterRecords` 同样按「第一个 H2 之前 + 非 fence」扫描；解析 `^ {0,3}<!-- issuemd:limits:\s*(.*?)\s*-->[ \t]*$`，按空白切 `key=value`，只接受 `body-bytes` / `body-lines`，值为 `/^[1-9]\d*$/` 且 `Number.isSafeInteger`。`effectiveLimits`：恰好一条且无 `problem` → 用其值（缺省键补默认值，`source: "ledger"`）；否则默认值 + `source: "default"`。

- [ ] **Step 4: 在 `src/ledger-check.ts` 加 W267**

在 `checkParsedLedger` 中 `highWaterRecords` 附近：

```ts
const limits = limitsRecords(ledger);
if (limits.some((record) => record.problem) || limits.length > 1) {
  warnings.push({
    code: "W267", line: limits[0]?.line ?? 1,
    message: "The ledger limits marker is malformed or duplicated; default limits (20 KiB / 300 lines) are in effect",
  });
}
```

- [ ] **Step 5: `cmdCheck` 暴露 `limits`**

`--json` 分支的顶层对象加 `limits: effectiveLimits(ledger)`。

- [ ] **Step 6: 跑测试**

Run: `bun test src/round22.test.ts -t W267 && npm run typecheck`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/round22.test.ts src/ledger.ts src/ledger-check.ts src/cli.ts
git commit -m "feat: read per-ledger W201 limits from a preamble marker"
```

---

### Task 2: `limits` 动词

**Files:**
- Modify: `src/cli.ts`（`COMMANDS`、`OPTIONS`、新增 `cmdLimits`、dispatch）
- Test: `src/round22.test.ts`

**Interfaces:**
- Consumes: `limitsRecords`、`effectiveLimits`、`DEFAULT_LIMITS`（Task 1）
- Produces: `issuemd limits FILE [--body-bytes N] [--body-lines N] [--clear] [--dry-run]`，写前言的标记行

语义：`--body-bytes` / `--body-lines` 覆盖对应键；`--clear` 删除标记（回到默认）；两者同时给 exit 2；无参数 exit 2（必须至少给一个动作）。写入时保留标记中未提及的键的现值；标记插在首个 H2 前、与 high-water 标记共存（若已有则替换那一行）。值必须是正安全整数，否则 exit 2。

- [ ] **Step 1: 写失败用例**

```ts
describe("limits verb", () => {
  test("sets, updates, and clears the marker", async () => {
    const path = ledgerFrom(fixture, "");
    expect((await run(["limits", path, "--body-bytes", "40960"])).code).toBe(0);
    expect(JSON.parse((await run(["check", path, "--json"])).stdout).limits.bodyBytes).toBe(40960);
    expect((await run(["limits", path, "--body-lines", "600"])).code).toBe(0);
    const both = JSON.parse((await run(["check", path, "--json"])).stdout).limits;
    expect([both.bodyBytes, both.bodyLines]).toEqual([40960, 600]);
    expect((await run(["limits", path, "--clear"])).code).toBe(0);
    expect(JSON.parse((await run(["check", path, "--json"])).stdout).limits.source).toBe("default");
  });
  test("--dry-run changes nothing; bad values exit 2", async () => {
    const path = ledgerFrom(fixture, "");
    const before = readFileSync(path, "utf8");
    const dry = await run(["limits", path, "--body-bytes", "40960", "--dry-run"]);
    expect(dry.stdout).toContain("+");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect((await run(["limits", path, "--body-bytes", "0"])).code).toBe(2);
    expect((await run(["limits", path])).code).toBe(2);
    expect((await run(["limits", path, "--clear", "--body-bytes", "1"])).code).toBe(2);
  });
  test("does not disturb the high-water marker", async () => {
    const path = ledgerFrom(fixture, "<!-- issuemd:high-water: 20 -->\n");
    await run(["limits", path, "--body-bytes", "40960"]);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("<!-- issuemd:high-water: 20 -->");
    expect(text).toContain("body-bytes=40960");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t "limits verb"`
Expected: FAIL — unknown command 'limits'。

- [ ] **Step 3: 实现 `cmdLimits`**

插入/替换标记的辅助函数 `writeLimitsMarker(lines, ledger, values | null): string[]`，与 `writeHighWaterMark` 同构：有记录则替换首条并删除其余；无则插在首个 H2 前（沿用 high-water 的 `at` 计算）。`--clear` 删除记录行。

注册：

```ts
limits: {
  usage: "issuemd limits  FILE [--body-bytes N] [--body-lines N] [--clear] [--dry-run] [--if-unchanged S]",
  options: ["body-bytes", "body-lines", "clear", "dry-run", "if-unchanged"],
},
```

`body-bytes` / `body-lines` 在 `OPTIONS` 中为 `{ type: "string" }`。

- [ ] **Step 4: 跑测试**

Run: `bun test src/round22.test.ts -t "limits verb" && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/round22.test.ts
git commit -m "feat: add the limits verb for per-ledger W201 thresholds"
```

---

### Task 3: W201 消息带实测值、附录归档也度量

**Files:**
- Modify: `src/ledger-check.ts`（`checkBodies` 的 W201、`checkAppendix` 的归档块度量）
- Test: `src/round22.test.ts`

**Interfaces:**
- Consumes: `effectiveLimits`（Task 1）
- Produces: W201 消息格式 `Issue body 24.3 KiB (limit 20 KiB), 471 lines (limit 300)` 只列超出维度；附录归档用同一 code、`id` 为原编号。

注意：`checkBodies` 与 `checkAppendix` 都需要 limits，故 `checkParsedLedger` 先算一次 `const limits = effectiveLimits(ledger)` 并作为参数传入。

- [ ] **Step 1: 写失败用例**

```ts
describe("W201 scope", () => {
  test("message names the measured value and the exceeded dimension", async () => {
    const path = ledgerFrom(fixture, "", "");
    await run(["body", path, "2", "--body-file", bigBody(400)]); // 400 行中文，超行数
    const warnings = JSON.parse((await run(["check", path, "--json"])).stdout).warnings;
    const w201 = warnings.find((w: { code: string }) => w.code === "W201");
    expect(w201.message).toMatch(/\d+ lines \(limit 300\)/);
  });
  test("a kept-body archive over the limit still reports W201 with its id", async () => {
    const path = ledgerFrom(fixture, "", "");
    await run(["body", path, "2", "--body-file", bigBody(400)]);
    await run(["close", path, "2", "--status", "已修", "--criteria", "x", "--keep-body"]);
    const codes = JSON.parse((await run(["check", path, "--json"])).stdout)
      .warnings.filter((w: { code: string }) => w.code === "W201");
    expect(codes.some((w: { id: string }) => w.id === "2")).toBe(true);
  });
  test("a hand-written appendix is not measured", async () => {
    const path = ledgerFrom(fixture, "", `\n## 附录\n\n${bigBody(400).join("\n")}\n`);
    const codes = JSON.parse((await run(["check", path, "--json"])).stdout)
      .warnings.filter((w: { code: string }) => w.code === "W201");
    expect(codes).toHaveLength(0);
  });
});
```

`bigBody(n)` 生成 n 行中文正文（每行 ≥ 40 字节），写入临时文件并把路径交给 `--body-file`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t "W201 scope"`
Expected: 第一条 FAIL（消息不含 `lines (limit 300)`）；第二三条也可能 FAIL。

- [ ] **Step 3: 实现**

`checkBodies` 的 W201：

```ts
const lineCount = end - line;
const byteCount = Buffer.byteLength(lines.slice(line, end).join("\n"));
if (lineCount > limits.bodyLines || byteCount > limits.bodyBytes) {
  const over: string[] = [];
  if (byteCount > limits.bodyBytes) over.push(`${(byteCount / 1024).toFixed(1)} KiB (limit ${(limits.bodyBytes / 1024).toFixed(0)} KiB)`);
  if (lineCount > limits.bodyLines) over.push(`${lineCount} lines (limit ${limits.bodyLines})`);
  warnings.push({ code: "W201", line, id, message: `Issue body exceeds limits: ${over.join(", ")}` });
}
```

`checkAppendix`：对每个归档块（`ARCHIVE_HEADING` 到 `KEPT_BODY_END` 或 H3 结束）用同一度量与消息（`id` 为归档编号）。归档块行数/字节的切片按版本标记与 end marker 的最宽范围计算即可（比正文略宽是可接受的保守口径，需在代码注释里写明）。

- [ ] **Step 4: 跑测试**

Run: `bun test src/round22.test.ts -t "W201 scope" && bun test src && npm run typecheck`
Expected: PASS（若既有用例断言旧消息 `Issue body exceeds 300 lines or 20 KiB`，同步改为新格式）。

- [ ] **Step 5: Commit**

```bash
git add src/ledger-check.ts src/round22.test.ts
git commit -m "feat: report W201 measurements and measure kept-body archives"
```

---

### Task 4: `check` 体积指标（`size` 与文本摘要）

**Files:**
- Modify: `src/ledger-check.ts`（产出 `size`）或 `src/ledger-read.ts`（新增 `ledgerSize()`）
- Modify: `src/cli.ts`（`cmdCheck` 文本摘要与 JSON）
- Test: `src/round22.test.ts`

**Interfaces:**
- Produces: `export type LedgerSize = { bytes: number; lines: number; bodyLines: number; archivedLines: number; archivedBlocks: number }`
- Produces: `export function ledgerSize(ledger, src: string): LedgerSize`
- 文本摘要追加：` · 1.1 MiB / 10,969 lines · body 8,812 · archived 1,622 in 12 block(s)`（`archivedBlocks` 为 0 时省略 archived 段）

- [ ] **Step 1: 写失败用例**

```ts
test("check reports size metrics in text and JSON", async () => {
  const json = JSON.parse((await run(["check", fixture, "--json"])).stdout);
  expect(Object.keys(json.size).sort()).toEqual(["archivedBlocks", "archivedLines", "bodyLines", "bytes", "lines"]);
  expect(json.size.bytes).toBeGreaterThan(0);
  const text = (await run(["check", fixture])).stdout;
  expect(text).toMatch(/\d+ lines · body \d+/);
});
test("json stays valid for stdin", async () => {
  const src = readFileSync(fixture, "utf8");
  const json = JSON.parse((await run(["check", "-", "--json"], { stdin: src })).stdout);
  expect(json.size.lines).toBeGreaterThan(0);
});
```

（`run` 的 stdin 支持以现有 `tests/bin.test.ts` 的写法为准；若 helper 不支持，则用 `spawnSync` 传 `input`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t "size metrics"`
Expected: FAIL — `json.size` undefined。

- [ ] **Step 3: 实现 `ledgerSize` 并接进 `cmdCheck`**

`bytes` = `Buffer.byteLength(src)`；`lines` = `ledger.lines.length`；`bodyLines` = 所有 `bodyBlocks` 的 `end - line` 之和；`archivedLines`/`archivedBlocks` 按附录归档块统计。文本摘要用 `summaryLine(...)` 之后追加。

- [ ] **Step 4: 跑测试**

Run: `bun test src/round22.test.ts -t "size metrics" && bun test src`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ledger-read.ts src/ledger-check.ts src/cli.ts src/round22.test.ts
git commit -m "feat: report ledger size metrics in check"
```

---

### Task 5: 写入期 W201 提示

**Files:**
- Modify: `src/cli.ts`（`cmdBody`、`cmdClose` 的 keep-body 分支）
- Test: `src/round22.test.ts`

**Interfaces:**
- Consumes: `effectiveLimits`、`ledgerSize`/按块度量
- Produces: 成功写后若本 issue 由未超限变超限，stderr 追加 `W201: this body is now 24.3 KiB / 471 lines (limit 20 KiB / 300); move history to a separate evidence file`

- [ ] **Step 1: 写失败用例**

```ts
test("body --append warns when it pushes an issue over W201", async () => {
  const path = ledgerFrom(fixture, "");
  const result = await run(["body", path, "2", "--append", "--body-file", bigBody(400)]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("W201");
});
test("body --body-file warns on a first crossing", async () => {
  const path = ledgerFrom(fixture, "");
  const result = await run(["body", path, "2", "--body-file", bigBody(400)]);
  expect(result.stderr).toContain("W201");
});
test("dry-run also warns and writes nothing", async () => {
  const path = ledgerFrom(fixture, "");
  const before = readFileSync(path, "utf8");
  const result = await run(["body", path, "2", "--body-file", bigBody(400), "--dry-run"]);
  expect(result.stderr).toContain("W201");
  expect(readFileSync(path, "utf8")).toBe(before);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t "pushes an issue over W201"`
Expected: FAIL。

- [ ] **Step 3: 实现**

新增 `function w201CrossingNote(before: string[], after: string[], limits): string`：计算该正文块（按 heading 定位）在改动前后的行数/字节，仅当「前不超、后超」返回提示文案。`cmdBody` 在两处 `commit(...)` 返回成功后拼接；`cmdClose` 在 keep-body 分支（归档超限）同样拼接。`--dry-run` 走 commit 的 dry-run 返回，同样拼接。

- [ ] **Step 4: 跑测试**

Run: `bun test src/round22.test.ts -t "W201" && bun test src`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/round22.test.ts
git commit -m "feat: warn at write time when a body crosses the W201 limits"
```

---

### Task 6: 写成功回执（snapshot + 动作）

**Files:**
- Modify: `src/cli.ts`（`commit()` 增加 `receipt` 选项；各写命令传 receipt）
- Test: `src/round22.test.ts`；更新 `src/cli-write.test.ts:55,146,154`、`src/dogfood.test.ts:1100` 的 `stderr === ""`

**Interfaces:**
- Produces: `commit(..., { receipt?: string })`，成功且非 dry-run、非 no-op 时追加 `wrote ${file} ${receipt} (snapshot ${snapshotOf(content)})\n` 到 stderr（在 hardLinkNote 之前）
- 各命令 receipt 文案：`#N status A → B`、`#N priority A → B`、`#N closed as S`、`#N reopened as S`、`#N body replaced, N bytes`、`#N body appended, N bytes`、`#N new`、`split into N rows`、`limits body-bytes N`（`rename` 保留逐条明细并追加快照行）

- [ ] **Step 1: 写失败用例**

```ts
test("every write verb reports what it did and the new snapshot", async () => {
  const path = ledgerFrom(fixture, "");
  const status = await run(["status", path, "2", "观察"]);
  expect(status.code).toBe(0);
  expect(status.stdout).toBe("");
  expect(status.stderr).toMatch(/^wrote .* #2 status 未决 → 观察 \(snapshot [0-9a-f]{16}\)/m);
});
test("the receipt snapshot chains into --if-unchanged", async () => {
  const path = ledgerFrom(fixture, "");
  const first = await run(["status", path, "2", "观察"]);
  const snapshot = /snapshot ([0-9a-f]{16})/.exec(first.stderr)![1];
  const second = await run(["priority", path, "2", "P3", "--if-unchanged", snapshot]);
  expect(second.code).toBe(0);
  expect(second.stderr).toContain("#2 priority P1 → P3");
});
test("--dry-run and no-op writes keep their old output", async () => {
  const path = ledgerFrom(fixture, "");
  expect((await run(["status", path, "2", "未决"])).stdout).toBe("(no changes)\n");
  expect((await run(["status", path, "2", "观察", "--dry-run"])).stderr).not.toContain("wrote ");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t "every write verb reports"`
Expected: FAIL — stderr 为空。

- [ ] **Step 3: 实现**

`commit()` 签名增加 `receipt?: string`；成功分支：

```ts
const receiptLine = receipt ? `wrote ${file} ${receipt} (snapshot ${snapshotOf(content)})\n` : "";
return { code: 0, stdout: "", stderr: receiptLine + hardLinkNote(file, loaded) };
```

逐个写命令补 receipt 参数（`new` 的 stdout 仍只打编号）。

- [ ] **Step 4: 更新受影响旧用例**

把 `src/cli-write.test.ts:55,146,154`、`src/dogfood.test.ts:1100` 的 `expect(result.stderr).toBe("")` 改为断言具体回执或用 `toContain`；只读命令（`src/cli-ledger.test.ts:26,81`、`src/round13.test.ts:74`、`src/round18.test.ts:328`）不动。

- [ ] **Step 5: 跑测试**

Run: `npm run typecheck && bun test src tests`
Expected: PASS，724 + 新用例全绿。

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/round22.test.ts src/cli-write.test.ts src/dogfood.test.ts
git commit -m "feat: report what each write did, with the post-write snapshot"
```

---

### Task 7: errno 分档 + close --criteria 竖线提示

**Files:**
- Modify: `src/cli.ts`（`readOnlyRefusal`、`cmdClose` 的 `--criteria` 分支）
- Test: `src/round22.test.ts`

**Interfaces:**
- 保留错误对象：`catch (error) { const code = (error as NodeJS.ErrnoException).code; … }`
- 分档文案见 spec §5；`--criteria` 输入若 `unescapeCell(escapeCell(criteria)) !== unescapeCell(v.criteria)` 或含裸 `|`，追加 `W205: the criteria contain a pipe; it was stored escaped in the table cell\n`

- [ ] **Step 1: 写失败用例**

```ts
test("EPERM is not reported as read-only", async () => {
  // 用一个 chflags uchg（macOS）或在临时目录 chmod 0555 的父目录模拟；
  // 若当前平台无法产生 EPERM，跳过（test.skipIf）。
});
test("close --criteria says the pipe was escaped", async () => {
  const path = ledgerFrom(fixture, "");
  const result = await run(["close", path, "2", "--criteria", "a | b"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("W205");
});
test("a criteria without a pipe stays silent on W205", async () => {
  const path = ledgerFrom(fixture, "");
  const result = await run(["close", path, "2", "--criteria", "plain"]);
  expect(result.stderr).not.toContain("W205");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t "pipe was escaped"`
Expected: FAIL。

- [ ] **Step 3: 实现**

`readOnlyRefusal` 按 `error.code` 分档；`cmdClose` 在计算出 `criteria` 后（`v.criteria != null` 分支）计算是否发生转义改写，成功后把 W205 行拼进 stderr。

- [ ] **Step 4: 跑测试**

Run: `bun test src/round22.test.ts -t "W205" && bun test src tests`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/round22.test.ts
git commit -m "fix: distinguish errno causes and report escaped criteria pipes"
```

---

### Task 8: W266 重复附录 + close/reopen 唯一性拒绝

**Files:**
- Modify: `src/ledger-check.ts`（W266）
- Modify: `src/cli.ts`（`cmdClose` keep-body 分支、`cmdReopen`）
- Test: `src/round22.test.ts`；更新 `src/round20.test.ts` 中「多附录」写入用例

**Interfaces:**
- W266：`## 附录` 多于一个时逐条给行号，strict 失败
- `cmdClose`（仅当要写归档时）与 `cmdReopen`（仅当要选归档时）在附录数 ≠ 1 → exit 2，stderr 列出全部候选行号
- 扫描路径（W250–W253、rename 同步归档标题）不变

- [ ] **Step 1: 写失败用例**

```ts
test("duplicate ## 附录 reports W266 and fails --strict", async () => {
  const path = ledgerFrom(fixture, "", "\n## 附录\n\nsecond\n");
  const json = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(json.warnings.filter((w: { code: string }) => w.code === "W266")).toHaveLength(2);
  expect((await run(["check", path, "--strict"])).code).toBe(3);
});
test("close --keep-body refuses with candidate lines and leaves bytes alone", async () => {
  const path = ledgerFrom(fixture, "", "\n## 附录\n\nsecond\n");
  const before = readFileSync(path, "utf8");
  const result = await run(["close", path, "2", "--keep-body"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/L\d+/);
  expect(readFileSync(path, "utf8")).toBe(before);
});
test("reopen refuses in the same shape", async () => {
  // 先在有归档的台账里制造第二个附录
});
test("a single appendix keeps working", async () => {
  // close --keep-body + reopen 正常（#23/#116 不回退）
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t "duplicate ## 附录"`
Expected: FAIL。

- [ ] **Step 3: 实现**

`checkAppendix` 里：

```ts
if (appendices.length > 1) {
  for (const appendix of appendices) warnings.push({
    code: "W266", line: appendix.line_start,
    message: `Duplicate '## 附录' section (${appendices.length} found; read and archive writes need exactly one)`,
  });
}
```

`cmdClose` 的 keepBody 分支在选 target 之前、`cmdReopen` 在选 archivedCandidates 之前，统一：

```ts
if (appendices.length !== 1) {
  return err(`issuemd ${verb}: 附录 is not unique (${appendices.map(a => `L${a.line_start}`).join(", ")}); merge them first\n`, 2);
}
```

- [ ] **Step 4: 更新 round20 用例**

把「多附录 = 一个归档区」的 close/reopen 断言改为：check 报 W266、写命令 exit 2；rename 仍同步全部附录的归档标题（这条不改）。

- [ ] **Step 5: 跑测试**

Run: `bun test src && npm run typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/ledger-check.ts src/cli.ts src/round22.test.ts src/round20.test.ts
git commit -m "fix: require a unique appendix for archive reads and writes (W266)"
```

---

### Task 9: `appendix:auto` 标记与空附录回收

**Files:**
- Modify: `src/ledger.ts`（`APPENDIX_AUTO` 常量）
- Modify: `src/cli.ts`（`cmdClose` 新建附录时写标记、`cmdReopen` 删空回收）
- Test: `src/round22.test.ts`

**Interfaces:**
- Produces: `export const APPENDIX_AUTO = "<!-- issuemd:appendix:auto -->"`
- `close --keep-body` 因原本无附录而新建时：`["## 附录", APPENDIX_AUTO, "", ...archive]`
- `reopen` 删归档后：若所在附录带该标记、且节内除标记与空行外无可见内容 → 整节删除（含标记与紧邻空行）

- [ ] **Step 1: 写失败用例**

```ts
test("close then reopen on a ledger without 附录 is byte-reversible", async () => {
  const path = ledgerWithoutAppendix(fixture);
  const before = readFileSync(path, "utf8");
  await run(["close", path, "2", "--keep-body"]);
  expect(readFileSync(path, "utf8")).toContain("issuemd:appendix:auto");
  await run(["reopen", path, "2"]);
  expect(grep(path, "^## 附录")).toBe(0);
});
test("a hand-written empty 附录 is never removed", async () => {
  const path = ledgerFrom(fixture, "", "\n## 附录\n");
  await run(["close", path, "2", "--keep-body"]);
  await run(["reopen", path, "2"]);
  expect(grep(path, "^## 附录")).toBe(1);
});
test("user content beside the archive survives reopen", async () => {
  const path = ledgerWithoutAppendix(fixture);
  await run(["close", path, "2", "--keep-body"]);
  // 在附录里追加用户内容后再 reopen
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t "byte-reversible"`
Expected: FAIL（附录仍为 1）。

- [ ] **Step 3: 实现**

`cmdClose` 的新建分支写标记；`cmdReopen` 在删除 `archiveSpan` 之后，重新解析，找到归档原所在附录；若其下一非空行为 `APPENDIX_AUTO` 且节内无其他可见内容，删除整个附录节（从 `## 附录` 行到 `line_end`，含紧邻的一个空行）。

- [ ] **Step 4: 跑测试**

Run: `bun test src/round22.test.ts -t "appendix" && bun test src tests`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts src/cli.ts src/round22.test.ts
git commit -m "fix: remove an auto-created appendix when reopen empties it"
```

---

### Task 10: close 文案与 SKILL/spec 同步

**Files:**
- Modify: `src/cli.ts`（`cmdClose` 的缺判据报错、`COMMANDS.close` usage/help）
- Modify: `skills/issuemd/SKILL.md`（W201/W266/W267、limits、回执、close 三条出口、`--no-criteria` 常规示例）
- Modify: `docs/spec.md`（W201 与 limits 标记、W266/W267、size 指标、回执、附录唯一性）
- Test: `src/round22.test.ts`（帮助文案断言）

**Interfaces:**
- 缺判据报错文案改为点明体积后果：
  `Pass --criteria TEXT (one line, no extra copy), --no-criteria (delete the body: the file gets smaller), or --keep-body (keep the body in 附录: the file gets larger; for evidence you must retain)`

- [ ] **Step 1: 写失败用例**

```ts
test("close names the size consequence of each exit", async () => {
  const path = ledgerWithoutCriteria(fixture);
  const result = await run(["close", path, "2"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("--no-criteria");
  expect(result.stderr).toMatch(/smaller/);
  expect(result.stderr).toMatch(/larger/);
});
test("SKILL documents W201, W266, W267 and limits", () => {
  const skill = readFileSync(join(import.meta.dir, "..", "skills", "issuemd", "SKILL.md"), "utf8");
  for (const code of ["W201", "W266", "W267", "issuemd limits"]) expect(skill).toContain(code);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/round22.test.ts -t "size consequence"`
Expected: FAIL。

- [ ] **Step 3: 改文案与文档**

按 spec §9 与 Global Constraints；spec 里 W201 一行从「超 `limits`（默认 20KB / 300 行）」改为明确写出标记语法、字节口径与「附录归档也度量、手写附录不度量」。

- [ ] **Step 4: 跑测试**

Run: `bun test src/round22.test.ts && npm run typecheck && bun test src tests`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts skills/issuemd/SKILL.md docs/spec.md src/round22.test.ts
git commit -m "docs: document W201 exits, limits marker, receipts and appendix uniqueness"
```

---

### Task 11: 真实台账只读复测与 handoff

**Files:**
- Modify: `docs/handoff/handoff.md`
- Test: 手动命令（不写外部文件）

- [ ] **Step 1: 复测**

```bash
I=node\ dist/bin/issuemd.js
npm run build
for f in ../issuemd_dogfooding/issue-20261124.md ../cafe_dogfooding/issue-20261119.md ../orca_archived_files/issue-20261023.md; do
  node dist/bin/issuemd.js check "$f" | tail -1
  node dist/bin/issuemd.js check "$f" --json | jq -c '.limits, .size'
done
```

记录：三份台账的 warning 计数变化（W201 因附录度量可能增加、W266 若出现双附录）、`limits`/`size` 输出、`--strict` 退出码。

- [ ] **Step 2: 写 handoff**

追加「第二十二轮」小节：做了什么、契约变更（多附录写入侧反转、回执、limits 标记）、复测数字、未做项（prune/find/criteriaItems/W202 全位置/W117 取舍）。不写死 commit hash。

- [ ] **Step 3: Commit**

```bash
git add docs/handoff/handoff.md
git commit -m "docs: record round twenty-two handoff"
```

---

## Self-review notes

- Spec 覆盖：#106（Task 5 提示 + Task 2 出口的一部分）、#118（Task 1–3）、#119（Task 3）、#115（Task 4）、#122（Task 6）、#105/#111（Task 7）、#126（Task 8）、#116（Task 9）、#114 判据 1/2（Task 10）。#114 判据 3（prune）与 #113/#117/#120/#127-find 为明确非目标。
- 依赖顺序：Task 1 → 2/3/5；Task 6 独立；Task 8 → 9（唯一性在前，回收在后）。
- 类型一致：`effectiveLimits` 返回 `source`；`LedgerSize` 五个字段在 Task 4 与 Task 11 复用。