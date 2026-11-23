# issuemd 收敛为纯台账工具（设计）

日期：2026-11-24
状态：已确认（2026-11-24）

## 目标

`issuemd` 只负责单文件 issue 台账。通用 Markdown 操作交回 `lilmd`，两者不共享命令表面。

## 为什么

P0 把 lilmd 的 Markdown 命令整批拷进来，于是同一个 bin 上并存两套语义：`rename` 既是「改一行标题」又是「索引摘要与正文标题同改」。实测 `issuemd rename fixtures/canonical-clean.md '/^Issue 2:/' 'New title'` 只改了正文标题、吃掉 `Issue 2:` 前缀，`check` 仍报 0 error。为防这类事故，P1 又让通用 `rm` 识别台账并拒绝执行——通用层被迫知道台账存在，这正是要拆掉的耦合。

## 非目标

- 不做两个 bin，不保留 `issuemd issue <verb>` 命名空间。只有一个入口。
- 不接管 lilmd 的职责，不保证与 lilmd 的参数兼容。
- 不保留任何通用 Markdown 写命令。

## 命令表面（本次改动后）

```text
issuemd check   FILE [--json] [--strict] [--verify-commits]
issuemd list    FILE [--status S] [--priority P] [--closed] [--json]
issuemd show    FILE ID [--json] [--label NAME]
issuemd counts  FILE [--json]
issuemd read    FILE <H2 标题>
```

P3 再补 `new` / `close` / `reopen` / `status` / `rename` / `sync`，P4 补 `adopt`。

### `read` 的边界

只按**顶层标题精确匹配**取一节，输出该 H2 到下一个 H2（或文件末尾）的原文。作用有二：读 `## 附录` 里的复核记录，以及读台账里任何非 issue 的顶层节。不支持正则、链式选择器、层级前缀、`--depth` / `--body-only` / `--max-lines`。标题匹配失败或命中多个：exit 2 并列出候选。

### 删除清单

读：`toc`、`ls`、`grep`、`links`、`code`，以及 `read` 的选择器语法。
写：`set`、`append`、`insert`、`rm`、`promote`、`demote`、`mv`，以及通用版 `rename`。
连带删除：`src/select.ts`（179 行）、`src/write.ts` 中的变更函数、`src/render.ts` 的 TOC/截断路径、`src/index.ts` 里不再公开的导出。

`issuemd FILE` 不再隐式等价于任何命令，直接报用法错误并提示 `issuemd list FILE`——一个动作只有一种写法。

### 保留清单

`src/io.ts`（原子写、BOM/CRLF/尾换行/权限位、E130 快照复核）、`src/scan.ts`（fence 感知）、`src/sections.ts`、`src/ledger.ts`、`src/ledger-check.ts`、`src/issue-id.ts` 全部保留。台账写命令将直接复用它们。

## 顺序

1. 先加 `list` / `show` / `counts` / 窄 `read`，用现有夹具验证：`list` 报 3 条开放，`show 2` 给出表格行加正文，`read 附录` 只输出附录一节。
2. 再删通用命令与死代码，同步修 `--help`。
3. 最后进 P3 写命令。

先加后删，保证任何时刻仓库里都存在一条可用的读取路径。

## 风险

**回归覆盖会暂时变薄。** P1 的字节保持（尾换行、CRLF、模式位、E130）目前是通过 `set` / `rename` 做端到端验证的。删掉这些命令后，`tests/write-safety.test.ts` 需要改为直接对 `readDocument` / `joinDocument` / `writeAtomically` 断言，等 P3 的 `rename` / `close` 落地后再补一层端到端。这一步不能省，否则 P1 的保证会变成「代码在但没人验证」。

## 已确认的决定

- `issuemd FILE` 不再隐式工作：报用法错误并提示 `issuemd list FILE`。
- 删除 `select.ts` 整份（含 `select.test.ts`）；台账命令只按 id 和固定 H2 标题定位。