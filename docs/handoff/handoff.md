# issuemd 交接文档

更新于 2026-11-24（第二轮）。写给下一位接手者。

> 版本定位方式：本文档自身的提交就是最新一次改动，所以**不要**在此写死 commit hash。
> 需要基线时现查：
>
> ```bash
> git log --oneline -8
> git log -1 --format=%h   # 本文档所在的提交
> ```

## 一句话现状

`issuemd` 已完成 **P0–P4**：只做单文件台账，命令表面为 `check` / `list` / `show` / `counts` / `read` + 六个写命令 `new` / `close` / `reopen` / `status` / `rename` / `sync` + 一次性迁移 `adopt`。通用 Markdown 命令已全部删除，两个历史交叉核对脚本也已删除。全部测试通过（数量现查：`npm test` 末行）。剩余只有 P5 的打包决定与发布前授权确认。

## 分支状态

- 工作在分支 `feat/ledger-only`，基座是当时的 `main`（`eee6ebf`，含已批准的设计文档与上一版交接）。
- **尚未合入 `main`，尚未 push。** 按用户约定，合入 `main`、`npm link`、发布 npm、push 都必须等用户显式指令，且只做 fast-forward 合并。
- 提交（按主题）：
  - `feat: expose ledger body blocks and max issue id`
  - `feat: read ledger views; drop generic markdown commands`
  - `feat: ledger write verbs with a validation gate`
  - `feat: add adopt for one-shot conversion of older layouts`
  - 若干 `docs:` 提交（设计文档偏差、执行记录、README/SKILL/本文档）

## 必须先读的三份材料

| 文件 | 作用 |
|---|---|
| `docs/spec.md` | 唯一的规格来源。格式、不变量、错误码、命令表面、分阶段验收 |
| `docs/adr/0001`–`0006` | 六个会显得"莫名其妙"的决定；0006 是"只做台账、一个入口" |
| `docs/superpowers/specs/2026-11-24-issuemd-ledger-only-design.md` | 已批准的设计。末尾「实施后的偏差」记录了三处实现时对设计的修正，**读它，否则会照着旧设计改回去** |

辅助：`GLOSSARY.md`（术语）、`README.md`（对外）、`skills/issuemd/SKILL.md`（给 agent 用；仍未打进 npm 包，`tests/bin.test.ts` 断言了这点）。
计划：`docs/superpowers/plans/2026-11-24-ledger-only.md`（本轮执行的 14 个 task）。

## 命令表面（现状）

```text
issuemd check   FILE [--json] [--strict] [--verify-commits]
issuemd list    FILE [--status S] [--priority P] [--closed] [--json]
issuemd show    FILE ID [--json] [--label NAME]
issuemd counts  FILE [--json]
issuemd read    FILE <H2 标题>          # 精确匹配顶层标题，无正则/链式/子串

issuemd new     FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-]
issuemd close   FILE ID [--criteria TEXT | --criteria-from-body] [--keep-body]
issuemd reopen  FILE ID
issuemd status  FILE ID NEW_STATUS      # 只允许同分类内改
issuemd rename  FILE ID "NEW TITLE"     # 表格摘要 + 正文 H3，一次事务
issuemd sync    FILE [--guide | --fix-tables | --titles [--prefer body|table]
                      [--move-progress | --drop-progress]]
```

退出码：0 成功 / 1 没有这条 issue / 2 用法错误 / 3 校验失败。

## 架构要点（改之前必须知道）

- **`src/ledger.ts`**：`parseLedger(src)` 返回 `{ lines, visible, sections, rows, blocks, errors, warnings }`。`rows` 是表行，`blocks` 是管道块（含 header/separator 标志），`bodyBlocks(ledger)` 返回正文块，`maxIssueId(rows)` 算最大编号（区间端点参与）。`parseLedger` 只做解析期诊断，**不是**完整校验。
- **`src/ledger-check.ts`**：`checkLedger(src, file, opts)` 是唯一权威。E120 表示"根本不是台账"。
- **`src/ledger-read.ts`**：纯只读视图。`findRow` 返回 `{ row, table, span, id, inRange }`；`inRange` 表示"这个号只在区间行里"（如 `7–20` 中的 8），per-id 写命令必须拒绝它。
- **`src/ledger-edit.ts`**：纯行级原语（`replaceCell` / `insertLines` / `removeLines` / `bodySkeleton` / `extractCriteria` / `rewriteBlock` / 受控块内容）。不碰磁盘。
- **`src/cli.ts`**：所有命令。写命令共享 `commit()`：
  1. `joinDocument` 拼出候选内容（保留 BOM/行尾/尾换行）；
  2. 对候选内容跑 `checkLedger`；
  3. **只拒绝"新出现"的 error**（以 `code|id|message` 为键，基线来自 `openLedger()` 的 `checkLedger(...).errors`）；
  4. `--dry-run` 输出 diff 并 exit 0；否则 `writeAtomically`（E130 时 exit 2）。
- **`src/io.ts`**：不要改。原子写、快照复核、BOM/EOL/尾换行/权限位。

## 本轮的关键实现决定（照旧设计改会出错）

1. **`--keep-body` 不把 `### Issue N` 原样搬进附录**。I12/E123 禁止附录出现 Issue 标题。归档写成普通 `### #N <摘要>（已关闭，正文保留）` 小节，正文其余行原样保留。台账没有 `## 附录` 时会在 EOF 新建一节。输出 `W250` 到 stderr。
2. **多编号行 + per-id 命令 = exit 2**。`| 20, 24, 29 |` 合法，但 `close`/`rename`/`status`/`reopen` 无法只改一个号而不猜另外两个的去向。提示「先拆行」。`list`/`show` 仍能读整行（`show 24` 会显示该行的正文）。
3. **写入门禁的基线是 `checkLedger` 的完整诊断集**，不是 `parseLedger` 的解析期诊断——否则输入里本就存在的 `E112` 会被当成新错误拒绝。
4. **`new --id` 接受 `\d+[a-z]?`**（真实台账有 `393b`），不再只接受整数。
5. **正文块按编号升序插入**（`bodyInsertAt`），显式给小号时不会触发 E105。
6. **`fixTables` 对无表头块的处理**：台账的 `索引`/`已关闭` 里若有"首行即数据"的块，会把标准表头 + 分隔行一起插在该行**之前**；普通文档的块只在首行后插分隔行。

## 本轮末的独立审查与修复

写完 P4 后跑了一次独立 review（另一 agent 只读 + 复现），报了 10 个 bug 与 5 个 adopt bug，**全部已修并有回归测试**（`src/cli-write.test.ts` / `src/adopt.test.ts` 末尾的 `regressions found in review` 两个 describe）。值得记住的几条，因为它们改变了对代码的预期：

- **`replaceCell` 必须按原文拼接，不能解码后重组。** 后者会把没被改的单元格里的 `\|` 转义吃掉，5 格变 6 格。
- **所有"按标签找段落 / 按标记重写块"的逻辑都要跳过 fence。** 正文或附录里引用一段示例，曾会被当成真的 `**验收判据**` 或真的受控块标记。
- **追加内容到 EOF 时，`joinDocument` 会把末尾空行变成尾换行。** `commit()` 现在用 `terminate()` 修正。
- **id 是 `\d+[a-z]?`，`2` 与 `2a` 是两条不同的 issue。** 查正文块必须比完整 id，不能只比数字。
- **`--body-file` 里未闭合的 fence 会吞掉后续所有标题且 `check` 仍通过**，现在直接拒绝。
- **adopt 的决策清单行号指向转换后的文档**，不是输入；并且不再为区间行编造正文标题。

仍未处理的一条（review 标为 risky，非 bug）：原子替换最后一步 `lstat` 与 `rename` 之间仍有极小竞态窗口，见「已知的坑」第 3 条。

## 还没做（按优先级）

- ~~**P4 `adopt`**~~ **已完成**（`src/adopt.ts` + `src/adopt.test.ts`）：cafe 形状 → open 3 / closed 13，orca 形状 → open 2 / closed 11，两者 `check` 均 0 error。只做机械改动，语义判断全部进待决清单；输出若仍不过 `check` 则 exit 3 不落盘。已知限制：已关闭表的摘要在索引与已关闭表冲突时一律取「已关闭表」那份（与 `--prefer=body` 的口径不同，因为已关闭项没有正文标题可比）。
- **P5 剩余**：
  - 决定 `skills/issuemd/SKILL.md` 是否打进 npm 包（当前 `package.json#files` 只有 `dist`，`tests/bin.test.ts` 断言它**不在**包里）。
  - `README` 的「License」段仍写着「确认 lilmd 上游授权后再公开」——发布前要处理。
- 规格 §6.2 里仍有未实现的项：`W211`（编号疑似复用，`check` 不报）；`W250` 只在 `close --keep-body` 时打到 stderr，`check` 不报。其余 warn（含 `W203`、`W260`）已在 `src/ledger-check.ts` 里实现。补之前先看 `docs/spec.md` §6.2。

## 验收与命令

```bash
npm run typecheck && npm test     # 必须全绿
node dist/bin/issuemd.js check fixtures/canonical-clean.md
# open 3 (未决 1, 部分解决 1, 观察 1)   closed 17 / 0 errors, 1 warning (W202, 夹具里的 a1b2c3d)
node dist/bin/issuemd.js list fixtures/canonical-clean.md     # 3 行
node dist/bin/issuemd.js show fixtures/canonical-clean.md 2   # 表行 + 正文
node dist/bin/issuemd.js counts fixtures/canonical-clean.md   # 与 expected.json 一致
node dist/bin/issuemd.js read fixtures/canonical-clean.md 附录
node dist/bin/issuemd.js fixtures/canonical-clean.md          # exit 2，「missing command」
```

夹具是合成的，**不要**把真实台账（cafe / orca 的 `issue-*.md`）放进测试。`fixtures/*.expected.json` 是人工核对过的黄金答案。`fixtures/cafe-shaped.md` 有 13 条"已关闭但仍有正文"的 issue（断言 `E111`）；`fixtures/orca-shaped.md` 有 11 个缺分隔行的管道块和 12 个计数标题。

## 工作流约定（用户明确要求，别自作主张）

- 改动开 `feat/...` 分支提交；**合入 `main`、`npm link`、发布 npm、push 都要等用户显式指令**，且只做 fast-forward 合并。
- 提交前跑类型检查 + 完整测试。
- 一轮结束时用中文给条目化小结，未决项用编号 Q 加推荐答案。
- 用户可能要求「这一轮不要考虑 context 大小，尽量做完」；卡住必须等人的部分留到最后汇报并写进本文件。

## 已知的坑

1. **bun 的 `spawnSync({ input })` 用的是 socket，不是 FIFO。** `readFileSync(0)` 在 socket 上会永久阻塞。隐式 stdin 只认 FIFO 与普通文件；测试里要用真实 shell 管道（`sh -c 'printf ... | issuemd ...'`）。
2. **`text.split("\n")` 带出 EOF 哨兵。** 读写的行数组必须去掉尾部空串再拼回。`loadWritable()` 已按 `doc.finalNewline` 处理。
3. **原子替换仍有极小竞态窗口**：最后一次 stat 与 `rename` 之间。已压到最小并用「fsync 期间被改」的用例覆盖，属于已知接受项。
4. **混合行尾文件**（同时 LF 和 CRLF）会被整体归一成文件中首个出现的行尾，继承自 lilmd，未修。
5. **行号坐标在插入/删除后会变。** 写命令里凡是先改一处再算下一处，都必须重新 `parseLedger` 取新坐标（`cmdNew`、`cmdReopen`、`cmdClose` 都是这么做的）。新增写命令时照做。
6. **`--dry-run` 也会跑校验**：不合法的操作即使 dry-run 也是 exit 3。这是故意的。

## 建议调用这些 skill

- `superpowers:test-driven-development` —— P4 的每个机械转换都先写失败用例。
- `superpowers:systematic-debugging` —— 若行级拼接或 `io.ts` 出现意外行为。
- `superpowers:requesting-code-review` —— 合入 `main` 前。
- `mattpocock-skills:domain-modeling` —— 新增术语时更新 `GLOSSARY.md`；“难逆转 + 无背景会困惑 + 有真实权衡”三条同时成立才加 ADR。