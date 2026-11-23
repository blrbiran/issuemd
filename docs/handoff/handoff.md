# issuemd 交接文档

更新于 2026-11-24。写给下一位接手者。

> 版本定位方式：本文档自身的提交就是最新一次改动，所以**不要**在此写死 commit hash。
> 需要基线时现查：
>
> ```bash
> git log --oneline -5
> git log -1 --format=%h   # 本文档所在的提交
> ```

## 一句话现状

P0（Markdown CLI 基线）、P1（写入安全）、P2（台账校验）已合入本地 `main` 并通过 217 个测试；当前有一个**已写好、待用户确认**的架构决定——把 `issuemd` 收敛为纯台账工具，删掉从 lilmd 拷来的通用 Markdown 命令。

## 必须先读的三份材料

| 文件 | 作用 |
|---|---|
| `docs/spec.md` | 唯一的规格来源。格式、不变量、错误码、命令表面、分阶段验收都在这里，其余文档不重复 |
| `docs/adr/0001`–`0005` | 五个会显得"莫名其妙"的决定：自持 lilmd 源码、单一格式无兼容层、关闭即删正文、摘要等于正文标题、正文内禁标题 |
| `docs/superpowers/specs/2026-11-24-issuemd-ledger-only-design.md` | **当前待批准的设计**。决定 `issuemd` 只做台账，命令表面收敛为 `check/list/show/counts/read` |

辅助：`GLOSSARY.md`（术语，实现无关）、`README.md`（对外）、`skills/issuemd/SKILL.md`（给 agent 用，目前超前于实现，尚未打进 npm 包）。

## 立刻要做的决定

用户已经同意方向（"只做单纯的 issuemd"、"按推荐"，推荐是保留一条窄 `read`），但**还没有批准设计文档本身**。设计文档末尾留了两个问题：

1. `issuemd FILE` 不再隐式等价于 `toc` —— 是否接受？
2. 是否删除 `src/select.ts` 整份？

拿到批准后：先加 `list`/`show`/`counts`/窄 `read`，再删通用命令（顺序不能颠倒，否则中间状态没有可用的读取路径），然后才进 P3。

## 已完成部分（不要重做）

- **P0** `dc96861` 量级：拷贝 lilmd 的 Markdown 核心，npm 构建，产物可直接被 Node 运行，运行时依赖为零。`dist/bin/issuemd.js` 是入口。
- **P1**：`src/io.ts` 提供 `readDocument` / `joinDocument` / `writeAtomically`——原子替换（临时文件 + fsync + rename）、保留 BOM / 行尾风格 / 尾换行有无 / 权限位、替换前复核快照（`E130`）。`src/scan.ts` 是 fence 感知的标题扫描器。
- **P2**：`src/ledger.ts`（管道块、编号与区间、骨架识别）、`src/issue-id.ts`（`IdSet` 用 `bigint` 计数，避免大区间溢出）、`src/ledger-check.ts`（`checkLedger`）。CLI 已有 `issuemd check FILE [--json] [--strict] [--verify-commits]`，退出码 0/2/3。

## 还没做

- P3 台账写命令：`new` / `close` / `reopen` / `status` / `rename` / `sync` / `counts`（见 `docs/spec.md` §7、§12）。
- P4 `adopt` 一次性迁移（§10）。
- P5 skill / 文档 / 清理，包括删除仓库根目录的 `check-issues.mjs` 与 `verify-facts.mjs`（约定 P5 再删，它们现在只作交叉核对用）。

## 验收与命令

```bash
npm run typecheck && npm test     # 必须全绿，217 个测试
node dist/bin/issuemd.js check fixtures/canonical-clean.md
# 期望：open 3 (未决 1, 部分解决 1, 观察 1)   closed 17   /  0 errors
```

夹具是合成的，**不要**把真实台账（cafe / orca 的 issue-*.md）放进测试。`fixtures/*.expected.json` 是人工核对过的黄金答案。`fixtures/cafe-shaped.md` 里有 13 条"已关闭但仍有正文"的 issue，用来断言 `E111`；`fixtures/orca-shaped.md` 有 11 个缺分隔行的管道块和 12 个计数标题。

## 工作流约定（用户明确要求，别自作主张）

- 改动开 `feat/...` 分支提交；**合入 `main`、`npm link`、发布 npm 都要等用户显式指令**，且只做 fast-forward 合并。
- 提交前跑类型检查 + 完整测试。
- 不要 push。
- 一轮结束时用中文给条目化小结，未决项用编号 Q 加推荐答案。

## 已知的坑

1. **删除通用命令会让 P1 的回归变薄。** 现在字节保持是用 `set`/`rename` 端到端验证的；删掉后必须改成直接对 `io.ts` 三个函数断言，等 P3 的 `rename` 落地再补端到端。设计文档 §风险 已写明。
2. **bun 的 `spawnSync({ input })` 用的是 socket，不是 FIFO。** `readFileSync(0)` 在 socket 上会永久阻塞。隐式 stdin 只认 FIFO 与普通文件；测试里要用真实 shell 管道（`sh -c 'printf ... | issuemd ...'`）。
3. **`text.split("\n")` 带出 EOF 哨兵。** 行数组必须去掉尾部空串再拼回，否则每次写入都会在文件末尾多一行。`loaded.srcLines` 已这样处理。
4. **原子替换仍有极小竞态窗口**：最后一次 stat 与 `rename` 之间。当前已把窗口压到最小并在测试中覆盖"fsync 期间被改"的情形，属于已知接受项。
5. **混合行尾文件**（同时存在 LF 和 CRLF）会被整体归一成 CRLF，这是继承自 lilmd 的行为，尚未修。

## 建议调用这些 skill

- `superpowers:writing-plans` —— 设计文档获批后，把它转成分步计划（这是流程要求的下一步）。
- `superpowers:test-driven-development` —— P3 每个台账写命令都先写失败用例。
- `superpowers:systematic-debugging` —— 若 `io.ts` 或行级拼接出现意外行为。
- `mattpocock-skills:domain-modeling` —— 新增术语时更新 `GLOSSARY.md`；只有"难逆转 + 无背景会困惑 + 有真实权衡"三条同时成立才加 ADR。