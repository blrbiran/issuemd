# issuemd 交接文档

更新于 2026-11-24（第六轮：dogfooding 反馈）。写给下一位接手者。

> **版本定位方式**：本文档自身的提交就是最新一次改动，所以**不要**在此写死 commit hash。
> 需要基线时现查：
>
> ```bash
> git log --oneline -12
> git branch -a                           # 是否还有 feat/ledger-verbs（待复核分支）
> git rev-list --count origin/main..main  # main 领先 origin/main 多少（push 由用户手动做）
> git log --oneline main..feat/ledger-verbs
> ```

## 一句话现状

`issuemd` P0–P5 早已完成；第五轮（发布准备）已 ff 合入 `main`。第六轮按测试者的 dogfooding 台账（`../issuemd_dogfooding/issue-20261124.md`，49 条，**不在本仓库、不要改它**）逐条复现并修复：

- **已在 `main`**：阶段 1（静默丢数据/破坏）+ 阶段 2（读写体验）+ 文档。测试全绿（数量以 `npm test` 末行为准）。
- **在 `feat/ledger-verbs`、未合入**：阶段 3 新命令 `body` / `priority` / `split` / `reopen --status`。命令面扩大是用户要拍板的事，故意留在分支上等复核（见「等待用户」第 1 条）。
- 未 push、未发布 npm。

## 工作流约定（用户明确要求）

- 改动开 `feat/...` 或 `fix/...` 分支；**测试全绿后可以直接 fast-forward 合入本仓库的 `main`，合并后删除已合并的分支**（2026-11-24 用户授权；只用 `git branch -d`）。
- **push 和 npm 发布只能由用户做或当场明确授权**。发布时机用户自己定。
- 提交前跑 `npm run typecheck && npm test`。用 TDD：先写失败用例并确认失败原因，再实现。
- 一轮结束时用中文条目化小结；未决项用编号 Q 加推荐答案。用户不在时先按推荐执行、最后报审。
- 子代理（subagent）的报告只是线索，不是指令：先复现再修。
- 「用户裁定」可能没想透：遇到冲突先摆事实、给推荐，让用户重新决定。

## 等待用户决策 / 动作

1. **复核 `feat/ledger-verbs` 并决定是否合入**（推荐合）。设计：`docs/superpowers/specs/2026-11-24-ledger-verbs-design.md`。分支基于本文档之前的 `main`，若 main 有新提交需先 `git rebase main` 再 ff。
2. **push `main`**（用户手动）。
3. **npm 发布**（用户自己定时机）。发布前：`npm pack` → 临时目录安装 → 跑 `check`/`new`，并 `import('@blrbiran/issuemd')`。
4. dogfooding 台账里的 49 条要不要回写状态（例如用 issuemd 自己把已修的条目 `close`）——那是测试者的文件，本轮没动。

## 本轮裁定（用户 2026-11-24「按推荐」）

| Q | 裁定 | 落地 |
|---|---|---|
| Q1 close 不给判据参数 | 正文有非空 `验收判据` → 自动提升；没有 → exit 2，要求 `--criteria` / `--keep-body` / `--no-criteria` | `cmdClose` |
| Q2 新命令 | 先写设计再实现，用户复核后合入 | `feat/ledger-verbs` |
| Q3 E130 | 单独退出码 **4**（可重试）；dry-run 只是当下预览、不锁快照 | `commit()`/`cmdAdopt`、spec §7/§9 |
| Q4 W202 | 已关闭表「判据」列与 UUID 不报；正文照报；`--verify-commits` 仍查判据里的 hash | `checkHashes` |
| Q5 优先级 | `P0`–`P3` 或空；`new` 越界 exit 2；`check` 报 W221 | `PRIORITIES` |
| Q6 符号链接 | 解析到目标文件写入（不改 io.ts），链接保留；硬链接写后 warning | `loadWritable` |
| Q7 keep-body 判据两份 | 接受：附录归档 = 冻结的历史快照，不算第二份判据 | spec §7.2 |

## dogfooding 49 条的处理结果

| 条目 | 结果 |
|---|---|
| #1–#7（skill 文档） | SKILL.md 已改：安装路径、check 退出码、E120、四个 per-id 命令 + 区间、裸调用/status 修词/--strict/show --json/W202·W240、`--body-file` 不含标题、`--title="-…"` |
| #8/#22/#29 判据丢失 | 修：标签块读到下一个标签/标题为止（空行+列表都算）；close 规则见 Q1；`--criteria-from-body` 空则拒绝；`show --label` 空标签 exit 1 |
| #9/#33 取值校验 | 修：优先级词表 + W221；`list --status/--priority` 未知值 exit 2，跨表提示 `--closed` |
| #10 reopen 状态 | 分支：`reopen --status` |
| #11 list --closed 判据 | 修：文本输出带「判据:」 |
| #12 adopt 已合规 | 修：check 0 error 且无 W220 → 原样不动；空模板不再「不是台账」；空 `## 附录` 不删 |
| #13/#14 选项 | 修：每命令选项白名单，越界 exit 2；`issuemd <cmd> --help` |
| #15 sync 跳过 | 修：stderr 列出跳过的多号行 |
| #16/#24 编辑正文 | 分支：`body` 命令 |
| #17 adopt 报告 | 修：三段（机械改动 / 原样保留 / 已按默认处理请复核），dry-run 措辞「将」 |
| #18 并发 | 修：E130 → exit 4；SKILL 加「并发与重试」；dry-run 不锁快照写进文档。未做锁文件（设计文档「不做」） |
| #19 链接 | 修：符号链接写穿、硬链接 warning |
| #20/#21 build 打断全局命令 | 修：`scripts/build.mjs` 编译到 `.dist-staging` 再 rename 换入；bin 755；类型错误时旧 dist 保留 |
| #23 reopen 回收归档 | 第五轮已修；本轮加 W252（归档对应 id 已开放） |
| #25/#41/#49 adopt 丢内容 | 修：H1 下说明原位保留；受控块外文字保留；表格小节里的说明/叙述 H3/映射不了的表进附录；带括注的规范标题（`正文（按编号）`）按规范节处理 |
| #26 diff 粒度 | 修：Myers 多 hunk；用 `patch(1)` 随机 2000 例验证 |
| #27 W202 | 修：见 Q4 |
| #28/#45 adopt 坐标 | 修：拒绝时报 `source L…`；决策定位不到时报 `源 L…`，不再 `L0`；E108 文案提示未转义 `\|` |
| #31 list 粒度 | 修：`ids`/`count`/`rowCount`/`issueCount`、`--expand`、文本 `(N ids)` |
| #32 show --json | 修：`labels`、开放项 `criteria` + `criteriaSource` |
| #34 重复标题 | 修：W212（check + new） |
| #35 --report 覆盖台账 | 修：拒绝台账本身与无关的已有文件；dry-run 仍写报告（推荐流程），台账不动 |
| #36 坏行 | 修：`parseLedger().unreadable`；读命令 stderr 提示、`list --json` 附 `unreadableRows`、`show` exit 3、取号与撞号算上坏行 |
| #37/#38 门禁 | 第五轮已修（计数比对、`--body-file` 标题） |
| #39 编号溢出 | 修：默认 max+1 越界 exit 2；去掉 `parseId(...)!` |
| #40 归档标题 | 修：close/adopt 同一归档格式（含 end marker）；rename 同步归档标题；W251 |
| #42/#43 adopt 表映射 | 修：宽度 2、表头「裁决/说明…」当判据、多余列「列名：值」进判据；判据格开头状态词 → 状态；未知已关闭状态 → `未分类`（不再 `已修`） |
| #44 split | 分支：`split` 命令；所有 per-id 拒绝文案统一并指向它 |
| #46 迁移守恒 | 修：adopt 内置「每行输入都在输出里」自检，否则拒写；未做独立 `--verify` 命令 |
| #47 `'''` | 修 |
| #48 追加空行 | 修：`insertBlock` |

真实台账试跑（只读副本，在 scratch 目录；**不进测试**）：cafe 与 orca 迁移前版本跑 `adopt`，编号集合前后一致（78/78、291/291），叙述小节与 H1 引言保留；#43 的 60/92/191/226 映射为 决定不改/不是缺陷/延后。cafe 原文件有 4 行单元格内未转义 `|`，adopt 会以源行号拒绝——这是源文件问题，不是 bug。

## 必须先读的材料

| 文件 | 作用 |
|---|---|
| `docs/spec.md` | 唯一规格。本轮改了 §6（W212/W221/W251/W252、W202 口径、E130=exit 4）、§7（close 判据表、标签块边界、链接、dry-run 语义）、§9（退出码 4、选项白名单）、§10（adopt 补充规则） |
| `docs/adr/0001`–`0006` | 0006「只做台账、一个入口」：新命令都是台账事务，不违反它 |
| `docs/superpowers/specs/2026-11-24-ledger-verbs-design.md` | 阶段 3 新命令设计（只在 `feat/ledger-verbs` 分支上） |
| `docs/superpowers/specs/2026-11-24-issuemd-ledger-only-design.md` | 第四轮设计，末尾「实施后的偏差」 |

辅助：`GLOSSARY.md`、`README.md`、`skills/issuemd/SKILL.md`（随包发布）、`TEMPLATE.md`、`THIRD_PARTY_NOTICES.md`。

## 命令表面（main）

```text
issuemd check   FILE [--json] [--strict] [--verify-commits]
issuemd list    FILE [--status S] [--priority P] [--closed] [--expand] [--json]
issuemd show    FILE ID [--json] [--label NAME]
issuemd counts  FILE [--json]
issuemd read    FILE <H2 标题>

issuemd new     FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-]
issuemd close   FILE ID [--status S] [--criteria TEXT | --criteria-from-body | --no-criteria] [--keep-body]
issuemd reopen  FILE ID
issuemd status  FILE ID NEW_STATUS
issuemd rename  FILE ID "NEW TITLE"
issuemd sync    FILE [--guide | --fix-tables | --titles [--prefer body|table] [--move-progress | --drop-progress]]
issuemd adopt   FILE [--dry-run] [--report PATH]
issuemd <command> --help
```

分支上另有：`body FILE ID --body-file`、`priority FILE ID P`、`split FILE ID`、`reopen --status S`。

退出码：0 成功 / 1 没有这条 issue 或空结果 / 2 用法或 I/O / 3 校验失败 / **4 E130 并发改动（可重试）**。

## 架构要点（改之前必须知道）

- **`src/io.ts`** —— **不要改**。原子写、快照复核、BOM/行尾/尾换行/权限位。符号链接在 CLI 层（`loadWritable`）解析成真实路径再交给 io；硬链接数也在 CLI 层 `lstat`。
- **`src/cli.ts`**：
  - `COMMANDS` 表是命令与选项的唯一来源：`run()` 用它拒绝越界选项、生成全局与 `<cmd> --help`。新增命令/选项要同时进 `COMMANDS`、`OPTION_HELP`、`OPTIONS`。
  - 写命令共享 `commit()`：`terminate()` → `joinDocument` → `checkLedger` → **按 multiset 只拒新 error** → `--dry-run` 出 diff / `writeAtomically(loaded.path, …)`（E130 → exit 4）。成功后若有其他硬链接，stderr 追加提示。
  - `Loaded = { doc, lines, path, links }`：`path` 是真实写入路径，报错文案仍用用户给的 `file`。
  - 插入正文块用 `insertBlock`（两侧恰好一个空行）；`close --keep-body` 的归档插入仍是 `insertLines` + 手动前导空行——`reopen` 的逐字节还原依赖它，别改成 insertBlock。
  - `cmdClose` 的判据规则：`--criteria` > `--no-criteria` > `--criteria-from-body`（空则拒）> 正文自动提升 > `--keep-body` 允许空 > 否则 exit 2。
- **`src/ledger-edit.ts`**：
  - `labelBlock()` 是唯一的标签解析：从 `**标签**` 行到下一个标签行或标题；空行、列表、fence 内容都属于它。`text` 是单行形式（段落/列表项用 `；`，无序列表符号去掉，fence 分隔行去掉）。`findLabel`、`extractCriteria`、`show --json labels` 都走它。
  - 归档格式常量：`archiveHeading()`、`ARCHIVE_HEADING`、`ARCHIVE_NOTE`、`KEPT_BODY_END`。close / adopt / reopen / rename / check 共用，改格式只改这里，并跑 `keep-body round trip`。
  - 注意 `ledger-edit` 与 `ledger-check` 互相 import（只在函数里用对方，模块初始化时不能用）。
- **`src/ledger.ts`**：`parseLedger` 新增 `unreadable: UnreadableRow[]`（E108/E109 丢掉的表行，能解析的话带 ids）；`maxIssueId(rows, unreadable)`。E108 文案在格数偏多时提示未转义 `|`。
- **`src/ledger-check.ts`**：`PRIORITIES`、`summaryKey`（W212 的 NFKC/大小写/空白折叠）；`checkHashes` 区分 pinned（W202）与仅校验（判据列，给 W240 用）；`checkAppendix` 出 W250/W251/W252。`--strict` 仍只豁免 W250。
- **`src/ledger-read.ts`**：`ListedIssue` 带 `ids`/`count`；`expandIssues`（上限 10 万）；`formatListedIssue`；`viewIssue` 带 `labels`、`criteriaSource`。
- **`src/adopt.ts`**（大改，改前读完它）：
  - 开头：输入 `check` 0 error 且无 W220 → 原样返回。
  - `fixSeparators` 返回 `origin[]`（输出行 → 源行号），用于报告 `sourceLine` 与守卫的源行号。
  - 列映射 `mappingFor`：有 `#` + `摘要/标题` 按名映射（`判据` 缺省时用 `裁决/说明/理由/原因/结论/备注`，其余列进 `extra` → 追加到判据）；否则宽度 2–5 猜（`guess`，只在台账表格小节内信），宽度 ≥6 不映射。
  - 状态优先级：行内状态列 > 判据格开头状态词 > 分组标题 > `未决`/`未分类`。
  - 保留：H1 自身说明（输出头部）、`controlled()` 受控块外文字、`tableSections` 里非表行内容（进附录，决策 `section-prose`）、外来小节、前言、正文里非 Issue 内容、孤儿正文。
  - **守恒守卫**（拼完 `out` 之后）：除表行/表头分隔/规范标题/表格小节的 H3/Issue 标题/受控块/`**状态**` 行/模板引言外，每个非空输入行都必须在 `out` 里（原样、neutralize 后或 `\|` 转义后），否则抛 `lost-content` → exit 3。新增任何「重建」逻辑时，要么把行复制到输出，要么明确把它加进 `regenerated`。
  - `canonicalName()`：`正文（按编号）` 等带括注的规范标题按规范节处理。
- **`src/write.ts`**：Myers 行级 diff + 3 行上下文多 hunk。
- **`scripts/build.mjs`**：`tsc --outDir .dist-staging` → chmod 755 bin → rename 换入 `dist`。不再先清空 dist；类型错误时 dist 不变、`npm test` 停在 build。

## 实现时踩过的决定（照直觉改会出错）

1. `--keep-body` 归档不是 `### Issue N`（E123）；先删正文块、再重新 parse 定位附录；删索引行前再 parse。
2. 多编号行 / 区间行 + per-id 命令 = exit 2（`perIdRefusal` 在分支上统一；main 上各命令文案仍是旧的「split the row first」）。
3. 写入门禁基线是 `checkLedger` 的完整诊断集，按计数比对。
4. id 是 `\d+[a-z]?`，`2` ≠ `2a`；查正文、插正文、排序都用完整 id。
5. fence 内皆非数据；受控块 marker 必须在自己的小节内。
6. `replaceCell` 按原文拼接；`escapeCell` 不二次转义。
7. 正文块按编号升序插入（`bodyInsertAt`）。
8. `--strict` 只豁免 W250。
9. adopt 的宽度推断只在台账表格小节内可信；保留内容不重排，只做必要转义/降级。
10. `adopt --dry-run --report` 会写报告（这是 skill 推荐的复核流程），但 `--report` 不能是台账本身、不能覆盖非 adopt 报告的已有文件。
11. adopt 的捷径条件含「无 W220」：未声明状态词要走完整转换以便报告 `unknown-status`。
12. `list --status` 的值若在台账里真实出现（即使不在词表），允许——这是查拼错状态行的办法。
13. W202 判据列识别靠「已关闭行的最后一个原始单元格」，不是 `row.criteria`（转义后的文本可能和原文对不上）。

## 已完成的审查与验证

- 回归用例：`src/dogfood.test.ts`（按 dogfooding 编号分组）、`src/ledger-verbs.test.ts`（分支）、`src/write.test.ts`（多 hunk）、`tests/bin.test.ts`（bin 执行位、FIFO 驱动的真实并发 → exit 4）。之前几轮的 `regressions found in review` / `second…fourth review round` / `keep-body round trip` 仍在。
- 本轮末尾派了一个独立 subagent 复审本轮全部 diff；结论与处理见最后一节「本轮复审」。

## 仍然接受的已知项

- 原子替换 `lstat`→`rename` 的极小竞态窗口。
- 读命令把非法 UTF-8 解码成 U+FFFD（只影响输出）。
- W202 不把 7–39 位纯数字当 hash（会漏掉约 3.7% 的纯数字短 hash）。
- `adopt` 对已经保留进附录的外来小节重跑时会再报 `foreign-section`。
- adopt 宽度 2 的 `| # | 说明 |` 把「说明」当摘要（真实 orca 台账里摘要因此是一句裁决理由），状态由分组推出；需要更好摘要时人工 `rename`。
- `build` 换入 dist 时两次 rename 之间有微秒级窗口没有 `dist/`。
- 没有锁文件 / 排队：并发冲突只靠 E130 + exit 4 + 调用方重试。

## 还没做 / 仅供参考

- 阶段 3 合入（等用户）。合入后把 SKILL「never hand-edit a ledger」那句与 `body` 命令一起生效（分支上已改好）。
- spec §14 的 Q2（`adopt --prefer` 信息丢失）与 Q5（第二套状态词）：用户明确不做，需要时先 brainstorming。
- #46 的独立 `adopt --verify=<原文件>` 与 `check` 的「附录重复段落」warning：未做（adopt 内置守卫已覆盖丢失；重复未检测）。
- #18 的锁文件方案：未做。

## 验收与命令

```bash
npm run typecheck && npm test           # 必须全绿
node dist/bin/issuemd.js check fixtures/canonical-clean.md   # 0 errors, 0 warnings（判据列的 a1b2c3d 不再报 W202）
node dist/bin/issuemd.js check TEMPLATE.md                   # 0 errors, 0 warnings
node dist/bin/issuemd.js list fixtures/canonical-clean.md --closed --json   # 每项带 ids/count；issueCount = 17
node dist/bin/issuemd.js close --help                        # 只列 close 的选项
node dist/bin/issuemd.js list fixtures/canonical-clean.md --title x; echo $?   # 2
ls -l dist/bin/issuemd.js                                    # -rwxr-xr-x
npm pack --dry-run --ignore-scripts   # 含 TEMPLATE.md、THIRD_PARTY_NOTICES.md、SKILL.md、dist/*.d.ts；不含 scripts/
node -e "import('@blrbiran/issuemd').then(m => console.log(typeof m.checkLedger))"   # function
```

写新命令时的自检清单：进 `COMMANDS`；`--dry-run` 不改字节；被拒绝的写不留部分修改；无尾换行保持；BOM/CRLF 保持；写后 error 不增加；非 UTF-8 / 混合行尾 exit 2；多号行/区间走 `perIdRefusal`；插入正文用 `insertBlock`。

## 已知的坑

1. bun 的 `spawnSync({ input })` 是 socket，不是 FIFO；隐式 stdin 只认 FIFO 与普通文件，测试用真实管道。
2. `text.split("\n")` 带出 EOF 哨兵，读写的行数组要去掉尾部空串。
3. 行号在插入/删除后会变：先改一处再算下一处必须重新 `parseLedger`。
4. `--dry-run` 也跑校验：不合法的操作 dry-run 也 exit 3。
5. `adopt` 的决策行号指向转换后的文档；`sourceLine` 是源坐标；报告里 `源 L…` 表示输出里找不到。
6. zsh 下 `for c in "a b c"; do cmd $c` 不分词，批量探针用 bash 脚本。
7. 写路径读文件两遍（预检 + readDocument），另加一次 lstat/stat。

## 建议调用的 skill

- `superpowers:test-driven-development`：改写命令或 adopt 前先写失败用例。
- `superpowers:systematic-debugging`：行级拼接、io、「check 通过但输出不对」。
- `superpowers:requesting-code-review`：合入 `feat/ledger-verbs` 前。
- `mattpocock-skills:handoff`：再交接时写回本文件。

## 本轮复审

（待独立 subagent 复审结果填写）
