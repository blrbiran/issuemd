# issuemd 交接文档

更新于 2026-11-25（第十二轮收尾：Q3 标题年份不算计数、Q4 `list --json citedRows`，以及一次黑盒探测、两次复审的修复，见「第十二轮」）。写给下一位接手者。

> **版本定位方式**：本文档自身的提交就是最新一次改动，所以**不要**在此写死 commit hash。
> 需要基线时现查：
>
> ```bash
> git log --oneline -12
> git branch -a                           # 正常只有 main（合并后的分支都已删）
> git rev-list --count origin/main..main  # main 领先 origin/main 多少（push 由用户手动做）
> git tag                                 # 已发布版本的 tag（v0.1.0 起）
> npm view @blrbiran/issuemd version      # registry 上的最新版本（第九轮时仍是 0.1.0）
> ```

## 一句话现状

`issuemd` P0–P5 早已完成；`0.1.0` 已发布到 npm。dogfooding 台账（`../issuemd_dogfooding/issue-20261124.md`，现 58 条，**不在本仓库、不要改它，状态由测试者自己更新**）的 #1–#58 均已处理：修好，或经用户裁定不做（#55/#58 是复测记录，其建议见「第十轮」「第十一轮」）。

- 第十一轮已由用户 push（第十二轮开始时 `origin/main` = 第十一轮 handoff 提交）。
- 第十二轮的提交都已 ff 合入本地 `main`，**尚未 push、尚未发版**（用户 2026-11-25：暂不发版，时机由用户定）。第八–十二轮合起来有新错误码（W225）、新选项、新的输出约定（`citedRows`）、写锁文件、W225 编号占用、E121 口径变化，下次发版建议 `npm version minor`（0.2.0）。
- 测试全绿（数量以 `npm test` 末行为准）。`dist/` 已用 `main` 重新 build。
- 当前没有进行中的开发任务；下一轮输入通常是测试者的新条目或复测。没有新条目时，可照第九轮的做法派黑盒 subagent 自测。

## 工作流约定（用户明确要求）

- 改动开 `feat/...` 或 `fix/...` 分支；**测试全绿后可以直接 fast-forward 合入本仓库的 `main`，合并后删除已合并的分支**（2026-11-24 用户授权；只用 `git branch -d`）。
- **合入 `main` 后跑一次 `npm run build`**：`npm test` 现在只编译到 `.dist-test/`，不再更新 `dist/`；全局 `issuemd`（npm link 到本 checkout 的 `dist/`）只有 build 后才会用上新代码。
- **push 和 npm 发布只能由用户做或当场明确授权**。发布时机用户自己定。
- 提交前跑 `npm run typecheck && npm test`。用 TDD：先写失败用例并确认失败原因，再实现。
- 一轮结束时用中文条目化小结；未决项用编号 Q 加推荐答案。用户不在时先按推荐执行、最后报审。
- 子代理（subagent）的报告只是线索，不是指令：先复现再修。
- 「用户裁定」可能没想透：遇到冲突先摆事实、给推荐，让用户重新决定（第八轮就据此重开了 #18、#34、#21）。

## 等待用户决策 / 动作

1. **push**：第十二轮的提交在本地 `main` 上，需用户 `git push`。
2. **发版（用户决定时机，2026-11-25 明确「暂不发版」）**：`npm version minor` → `npm publish`（`prepack` 会自动 build `dist/`）→ `git push --follow-tags`。发布前冒烟：`npm pack --pack-destination <scratch>` → 临时目录 `npm install <tgz>` → `npx issuemd new/check` + `import('@blrbiran/issuemd')`；包内不能出现 `.cafe`、`scripts/`、`.dist-test`。
3. dogfooding 台账状态由测试者更新，**我们不写**（用户 2026-11-24 裁定）。#53 建议把已达标条目与「owner 裁定不做」的判据在台账里标注出来，这同样留给测试者。
4. `.cafe` 已移出版本库并加入 `.gitignore`（本地文件保留）。其他 clone 拉到那次提交时，git 会删掉它们工作区里的 `.cafe`，需从上一提交恢复（`git show <移出前的提交>:.cafe > .cafe`）。

5. 第十轮报审 Q1–Q3 用户已同意（写锁保留；`sync --titles` 拒绝保留）。其中 Q2「W225 编号不占用」在第十一轮被用户改判为**占用**（见下）。

7. **第十二轮报审（已按推荐执行，请复核）**：
   - Q1（已执行）年份只按数值范围区分：4 位 19xx/20xx 不算计数。代价：恰好落在 1900–2099 的真实计数（`## 已关闭（2013）`）漏报 E121；`（1894）` 这类年份仍报。推荐维持（真实台账没有这么大的标题计数）。
   - Q2（已执行）E121 口径放宽到与 adopt 一致：括号内带空白 `（ 3 ）`、全角数字 `（２）`、ATX 结尾 `##` 都算计数——以前能过 check 的这类标题现在报 E121（三份真实台账不受影响）。只有 `（3）` 一个括号的标题算标题本身。推荐维持。
   - Q3（未做，推荐暂不做）`new`/`rename` 会把标题里的空白（含 U+3000）折叠成一个半角空格，不是逐字节保存用户输入；摘要查重、E106 都按折叠后比较，改了反而不一致。
   - Q4（未做，推荐暂不做）`check` 不报空摘要/空正文标题（`| 1 | 未决 |  |  |` + `### Issue 1: `）。本轮已让 adopt 不再制造空标题、`reopen` 拒绝空摘要；要不要加 warning 等实例再定。
   - Q5（沿用第十一轮 Q2，推荐暂不做）更多「台账表小节」词。
   - Q6 台账 #56–#58 仍由测试者复测（我们不写台账）。

6. **第十一轮报审（已按推荐执行；第十二轮用户回复「按你的建议走」：Q1 维持、Q2 不做、Q3/Q4 已做）**：
   - Q1（已执行，用户事先同意推荐）W225 表的编号**占用**：默认取号到达时逐个跳过，`new --id N` exit 2 点名那一行，`show N` exit 1 + stderr 提示。复审后收窄为「逐个跳过」而不是「跳到最大被引用编号之后」（错误码表里的 500 不会把下一个 issue 推到 501）。代价：`| # | 步骤 |` 这类叙述表也报 W225（`--strict` 失败），消除法是把 `#` 列改名。
   - Q2（未做，推荐暂不做）更多「台账表小节」词：`关闭/开放/已解决/已完成/已修复/进行中/TODO/Backlog` 目前只报 W225 而不是 E124。改成 E124 意味着 adopt 会从这些小节迁移表行，而无状态列的行默认「未决」——`## 已完成` 下的行会被当成开放项。真实台账没出现过，等实例再定。
   - Q3（未做，推荐做）标题里的年份 `（2025）` 被当成计数：`check` 报 E121、`new --title "版本（2026）"` 被拒、adopt 会剥掉它。建议把 4 位 19xx/20xx 排除在计数之外；要同时改 E121（ledger-check）、`titleProblem`（cli）、`stripCounts`（adopt）三处，口径必须一致。
   - Q4（未做，可选）`list --json` 不暴露被 W225 占用的编号；agent 只能靠 `check --json` 的 W225 或 `new` 的报错得知。可加 `citedIds`。
   - Q5 台账 #56–#58 由测试者复测、更新状态（我们不写台账）。#58 第二、三节的「建议关闭/标注」也留给测试者。

## 第十二轮（2026-11-25）

输入：台账无新条目（仍到 #58）；用户对第十一轮报审回复「按你的建议走」。做了 Q3、Q4，之后派黑盒 subagent（probe12）与两次独立复审（复审(14) 看 Q3/Q4，复审(15) 看黑盒修复）。用例在 `src/dogfood.test.ts` 末尾的 `round 12 …` 组。

| 来源 | 问题 | 处理 |
|---|---|---|
| Q3 | 标题里的年份 `（2025）` 被当成计数：E121、`new --title "版本（2026）"` 被拒、adopt 剥掉 | `ledger.ts` 的 `countSuffix` 是唯一规则（4 位 19xx/20xx 不算），E121（ledger-check）、`titleProblem`（cli）、`stripCounts`（adopt）共用 |
| Q4 | `list --json` 不暴露 W225 占用的编号 | 顶层 `citedRows: [{line, reason, ids}]`（没有时省略；开放与 `--closed` 都带） |
| 复审(14) 1 | `## 旧记录（3） ##`：check 去掉 ATX 结尾 `#` 后判 E121，adopt 对整行判、不剥 → adopt 自拒（旧问题） | `stripCounts` 先分出结尾 `#` |
| 复审(14) 4 | 全角数字 `（２）` 不算计数，而摘要查重用 NFKC（旧问题） | `[0-9０-９]`，年份判定前 NFKC |
| 黑盒 D1 | `甲（2）（3）` adopt 只剥一层 → 自拒 | `stripCountSuffixes` 反复剥到没有 |
| 黑盒 D2 | 标题只有 `（3）` 时 adopt 剥成空标题（`new`/`rename` 禁止空标题） | 只有括号数字的标题不算计数；`Issue N:` 标题只看冒号后；`reopen` 遇空摘要 exit 2 提示 rename |
| 黑盒 M1 | 表与标题都带 `（3）`：adopt 只剥标题，报假的 `open-title-conflict` | 开放行摘要同规则去计数（`changes` 里计数） |
| 黑盒 D3 | 正文标题 `c \| d` 对单元格 `c \| d`（都渲染成 `c | d`）报 E106；adopt 报冲突后自拒 | E106 与 adopt 的冲突比较先 `unescapeCell(title)`；复审(15) 2：`sync --titles` 同口径 |
| 黑盒 D4 | 外来小节里的 `####` 被降级成粗体，报告却写「原样移入附录」 | 只在正文块里降级：从 `Issue` 标题（H1–H3）到下一个同级或更高级标题。旧 cafe 形状（`## Issue N:` + `### 期望` + `####`）仍降级——先错修成「下一个 H1–H3 即结束」，用 cafe 历史版本对比发现后改正 |
| 黑盒 M2 | 守恒拒绝时 `source L36:` 后引的是转换后的 `**小节**` | 引原文 |
| 黑盒 Q3 | `--if-unchanged` 拒绝大写十六进制 | 先转小写 |
| 复审(15) 1 | D4 的修法只认行首无缩进的 `### Issue`：缩进 1–3 空格的正文里的 H4 不再降级 → adopt 自拒（回归）；缩进或 `##\t` 的计数标题本来就不剥（旧问题） | 降级、剥计数都按 CommonMark 认 0–3 空格缩进与制表符；缩进的 `####` 也降级 |
| 黑盒其余 | sync 拒绝写计数 exit 3（rename/new 是 2）；W225 表里超安全整数的编号不进 `citedRows`、不报 E109；附录里 kept-row 的行首 `|` 被转义；`⑵` 不算计数 | 未改，记入已知项 |

验证：`npm run typecheck && npm test` 全绿（本轮末 469）；4 个 fixture、TEMPLATE、三份真实台账（只读副本：cafe 0/60→98、dogfood 0/3→59、orca 0/139→480）、4 个 cafe 历史版本（`../cafe_dogfooding` 的 git 旧版）在本轮前后 build 下 adopt 输出与退出码逐字节相同；黑盒确认本轮写命令与 adopt 的 dry-run diff 在 CRLF / 无尾换行变体下仍能被 `patch` 应用。

## 第十一轮（2026-11-25）

输入：台账新条目 #56（P1）、#57（P1）、#58（复测记录，第九轮 main 上测的）。先用当前 main 重跑 #56 的矩阵（`待处理`/`变更记录` × 7 种表形状）：第十轮已修好台账表小节下的宽度 2 表（#57 的主要现象），剩下「数据行写在分隔行之上」「非台账小节只认 `摘要/标题` 表头」「adopt 早退不说明保留了哪些表」三处。用户裁定 D1 按推荐（W225 编号占用、宽度 2 表也报 W225、三列以上无摘要列的表不报），D2 按推荐（#27 字母开头 8 位短 id 仍报 W202，不改）。之后派一个独立复审（复审(12)）与一个黑盒 subagent，再对后两个提交派了复审(13)。用例在 `src/dogfood.test.ts` 末尾的 `#56/#57`、`review12:`、`probe11:` 组。

| 来源 | 问题 | 处理 |
|---|---|---|
| #56/#57 | 「什么是表头」check 与 adopt 各一套；`\| 7 \| 未决 \| 甲 \|` + 分隔行在 `待处理` 下 check 不报、adopt 早退 | `ledger.ts` 的 `tableHeader` 是唯一表头规则（check 的 `strayRows` 与 adopt 的 `pipeBlocks` 都用）；规则见架构要点 |
| #56 D1 | 非台账小节只有 `摘要/标题` 表头报 W225，`# \| 说明`、`编号 \| 说明`、`# \| 判据` 不报；W225 编号不占用 | W225 覆盖「id 列 + 摘要/标题」或「只有两列」或表头位置是 issue 行（须有真实分隔行）；编号进 `parseLedger().cited`：取号逐个跳过、`new --id` exit 2、`show` 提示 |
| #57 | adopt 早退只说「已是规范台账」 | `cmdAdopt` 对输出跑 check，每个 W225 写一条 `cited-table`（早退与真正转换都有） |
| #56 | 无表头三列 `\| 7 \| 未决 \| 甲 \|` 被读成 `# \| 摘要 \| 判据`（摘要 = 未决） | adopt 逐行：第二格恰好是状态词的行按 `# \| 状态 \| 摘要`（复审(12) 后要求精确状态词，黑盒后改为逐行） |
| #58 §5 | SKILL「a fenced example does not count」与实现不一致 | 改为：标签下的 fence 内容算判据；fence 里的 `**验收判据**` 行不开启新块 |
| 自查 | `tests/bin.test.ts`「parallel writers」单跑约 1/4 失败：读入时恰被别的写者替换，io 抛「E130 changed while being read」，CLI 报 exit 2 | `openFailure`：这类 E130 → exit 4（可重试）。加压 4×240 次只出现 0/4。io.ts 未改 |
| 复审(12) 1 | `\| 2026 \| 开放 \| 关闭 \|` 统计表在 `总览` 下报 E124、取号跳到 2027（adopt 原本就误读） | 真实分隔行上的首行默认是表头，只有明显的 issue 行才是数据；adopt 自己补的分隔行（`fixSeparators`）走旧规则（`synthetic`） |
| 复审(12) 2 | 错误码表 `\| 编号 \| 说明 \|`（404/500）把默认取号推到 501 | 取号从 max+1 起逐个跳过被引用编号 |
| 复审(12) 3 | 没有分隔行的管道行也报 W225 | W225 要求真实分隔行 |
| 复审(12) 4 | 单行 `\| 7 \| 观察（等上游） \| … \|` 被状态猜测改写 | 精确状态词（`isStatusWord`，只去 `**`） |
| 黑盒 3 | 复审(12) 的修法让 `待处理` 下 `\| 7 \| 甲 \| 乙 \|`+分隔行+`\| 8 \| 丙 \| 丁 \|` 全静默（回归） | issue 行判定加「下面每行都是 id + 文字」；纯数字行（统计表）仍是表头 |
| 黑盒 4 | `\| 7 \| 已修 \| 甲 \|` + `\| 8 \| 乙 \| 丙 \|`：整表按 orca 形状读，已修项变开放、摘要「已修」 | 逐行状态猜测（`Block.rowStatus`） |
| 黑盒 1/2 | `## 索引（旧）`、`## 已关闭（2025）`、第二个 `## 索引` 下的表完全不可见，`new --id 7` 造出同号；adopt 合并时旧摘要只进报告 | `strayRows` 只跳过台账真正读的那一节（第一个、标题精确相等）；其余照常 E124、编号占用 |
| 黑盒 6 | `list --expand` 遇 `3–900000000` 内存耗尽崩溃（exit 134） | `expandIssues` 先算区间大小再展开，超 10 万 exit 2 |
| 黑盒 7 | 无尾换行文件的 dry-run diff 不能喂给 `patch`（TEMPLATE 本身无尾换行） | `unifiedDiff(…, finalNewline)` 输出 `\ No newline at end of file`；只在一侧是末行的上下文行拆成 -/+ |
| 黑盒 | H3 分组报告说「记为未分类」，实际记为未决 | 文案改为「开放表里记为未决、已关闭表里记为未分类」 |
| 黑盒 5 | `7a` 占用时 `new --id 7` 可写、默认取号到 8 | **不是缺陷**：`7` ≠ `7a`（踩过的决定 4），默认取号按数字最大值，与规范行一致 |
| 复审(13) 1 | 黑盒 3 的修法要求「下面每行都是 id 行」，多一行占位 `\| 9 \|  \|  \|` 或 `\| 说明 \| 无 \| 无 \|` 就让整张表静默（回归） | 改为「下面至少有一行是 id 行」 |
| 复审(13) 2 | W225 表引用 `1–900000000` 时 `new` 逐个跳号卡死（回归） | 命中被引用区间时一次跳到区间末尾 + 1 |
| 复审(13) 3/4 | 关闭位于文件末尾、无尾换行的正文时 diff 里新增行与标记在删除行之前，`patch` 报 malformed；CRLF 台账的 diff 全部不能应用（旧问题） | 同一处改动先删后增；CRLF 内容行保留 `\r`。16 种文件变体（LF/BOM/CRLF × 有无尾换行 × 有无附录）× 8 个写命令全部 `patch` 后与真实写入逐字节相同 |
| 复审(13) 5 | 无分隔行的 `\| 负责人2 \| … \|` 上接 `\| 7 \| … \|`：check 报 E124，adopt 却把首行当表头、7 进附录（旧问题，编号丢失） | 无分隔行的块按 adopt 补分隔行后的读法判表头，两边一致（都当表头、不是 issue 表） |
| 复审(13) 6 | 被迁移的表里没有编号的行（`\| 备注 \| a \| b \|`）被当成表头静默丢掉（旧问题，守恒守卫没拦住） | `Block.header` 只让真正的表头行算 layout；这类行按原文进附录并写 `kept-row`（引用原行） |
| 复审(13) 7 | `## 总览` 下的错误码表、`## 状态总览` 下的 `\| 1 \| 开放 \| 3 \|` 统计表报 E124（旧问题：`isTableSection` 正则宽） | 未改，记入已知项与 Q2 |
| #58 其余 | #54 闭环（第十轮已修）、#18/#22/#46/#48 裁定不做、#27 残留 | 无代码改动；台账标注留给测试者 |

验证：`npm run typecheck && npm test` 全绿（本轮末 450）；三份真实台账（只读副本）check 计数、下一个编号均不变（orca 0/139→480、cafe 0/58→96、dogfood 0/3→59），无 W225、无 cited-table；4 个 fixture 与 5 个历史版本台账（orca/cafe 的 git 旧版，复审(12) 取出）在新旧 build 下 adopt 输出逐字节相同、二次 adopt 不变；dry-run diff 的 `patch` 矩阵见复审(13) 行；并发加压见上表。仍会拒绝的 adopt（无尾换行矩阵外的 4 例：无表头又无分隔行的 `负责人2` 块、开放大区间无正文、带括注的 `## 正文（旧）`）都是旧行为。

## 第十轮（2026-11-25）

输入：台账新条目 #54（P1）、#55（复测记录）；第九轮复审列出的 4 个 adopt 缺口；之后派了黑盒 subagent（多步骤 agent 工作流）与两次独立复审（复审(10) 看前两个提交，复审(11) 看写锁与黑盒修复）。所有发现都先复现、先写失败用例（`src/dogfood.test.ts` 末尾的 `review9:`/`review10`/`probe10`/`review11` 组，`tests/bin.test.ts` 的并发与锁用例）。

用户裁定：**#54 选 B**——非台账表小节（`复核记录`/`变更记录`…）里形如 issue 表的表报 **W225** warning、原样保留，不再报 E124；这改动了第八轮「规范表以外一律 E124」的裁定。

| 来源 | 问题 | 处理 |
|---|---|---|
| #54 | `## 变更记录` 下 `\| # \| 摘要 \|` 表：check 报 E124 让跑 adopt，adopt 搬进附录后自己的输出又被 E124 拒，死循环 | E124 只在 adopt 迁移表行的小节（`isTableSection`）报；其余小节同形表报 W225（每表一次、`--strict` 失败、文案给人工修法与「把 `#` 列改名」消除法）；编号不占用 |
| 复审(9) 1/4 | 无 H1 时首个 H2 前的正文、已关闭多号行在 H1 下的正文：E123 自拒或两份 | `topBodyLines`：adopt 采用的那份搬走，说明/前言副本跳过；前言进附录时也 `neutralizePreserved` |
| 复审(9) 2 | 输入 `## 附录` 里已有 `### Issue N:`：E123 自拒；且同号时附录那份会覆盖正文那份（Map 后者胜） | 附录里的正文块不参与挂载，原地改标题为 `### #N 摘要（附录里原有的正文）` + `orphan-body` 决定 |
| 复审(9) 3 | `### Issue 3–5:` 区间正文：守恒自拒 | 正文里非单号的 Issue 标题按外来 H3 转义进附录（`foreign-section`） |
| 自查 | `reopen` 不查重复摘要（第九轮已知项） | 与 new/rename 一致：exit 2 点名，`reopen --allow-duplicate-title` 放行 |
| 黑盒 1 | **并发写 exit 0 却丢失**（6 路并行 `priority`：29 次成功写丢 7 次；并行 `new` 打出的编号不在文件里）。根因：`io.ts` 的最终复核与 rename 之间，两个写者都能通过复核 | CLI 层 `lockedWrite`：`.<文件名>.issuemd-lock`（O_EXCL，内容 pid）包住 `writeAtomically`，等最多 2 s，否则 exit 4；持有者已死或锁 >30 s 视为残留接管。**io.ts 未改** |
| 复审(10) 1/4 | adopt 真正转换时仍把任意小节的 `\| # \| 摘要 \|` 表迁进索引（与 W225 矛盾）；`## 待处理` 下 `\| # \| P \| 说明 \|` adopt 会迁、E124 不报 | `mappingFor` 移到 `ledger.ts` 成为唯一定义：E124 = 台账表小节 + `mappingFor` 接受；adopt 只从台账表小节读表行 |
| 复审(10) 2/3 | 首个 H2 前与正文同号的第二份正文、区间标题：第一次修法后 adopt 拒写（回归） | 只搬 `bodyById` 选中的那份，其余留原处转义 |
| 黑盒 2 | `sync --titles` 对「表格摘要 = 正文标题 + 进展」（任意措辞）静默丢掉多出的文字；`--move-progress` 也没搬 | 摘要包含正文标题且更长 → 按进展处理：不给 `--move/--drop-progress` exit 3 |
| 黑盒 4 | `**验收判据：**`（冒号在粗体内）不认，close 时才报「没有判据」 | `labelName` 归一（labelBlock / labelsIn / W206） |
| 黑盒 5 | 列表项以 `；` 结尾时判据变 `；；` | `joinClauses`：前段已以 `；`/`;` 结尾不再加（`。` 照旧加，已有用例） |
| 黑盒 6 | `--body-file` 以 `### Issue N:` 开头（把 `show --json` body.text 原样回写）只报 E105/E106 | exit 2，点名那一行、提示删掉 |
| 黑盒 7 | `show --json` 查无此号在 stdout 打文本 | `--json` 时 stdout 为空，提示走 stderr |
| 黑盒 3 | 「判据取自标签下的 fence」 | **不是缺陷**（#29 设计：标签下 fence 内容属于判据）；只把 close 文案改清楚「fence 里的**标签行**不算」 |
| 复审(11) 1 | 锁路径是目录/悬空链接/权限 000 时 `lockedWrite` 死循环（100% CPU） | 读不了的锁不接管、按 deadline exit 4；悬空链接用 `lstat` 区分「已释放」；释放时只删 pid 仍是自己的锁；写 pid 失败时删掉自己的空锁 |
| 复审(11) 2 | `carriesExtra` 让 `sync --titles --prefer table` 拒绝正常的「表格措辞更长」（回归） | 只在 `--prefer body`（会丢表格文字）时按进展处理；拒绝文案提示 `--prefer table` |
| 复审(11) 3 | 表头含数字（`负责人2`、`Q3`）时 check 认表头、adopt 不认 → E124 后 adopt 自拒（旧行为） | adopt：后接分隔行且没有以数字开头的单元格 → 也算表头（`fixSeparators` 会在无表头表的首个数据行后补分隔行，所以要排除 id 行） |
| 复审(11) 4/5 | 新增的第二条 W206 正则把 `**Q：** 为什么` 当标签（`--strict` 回归）；`show --label "验收判据："` 不认 | 删掉那条正则（`**X：**` 只在独占一行时算标签）；`--label` 参数也过 `labelName` |
| #55 | W212 只报第二条（判据 2）；「验证用 npm test、部署用 npm run build」 | 前者维持（message 已点名第一条）；后者 README 第 66 行已写，不进 SKILL（SKILL 面向使用者） |

验证：`npm run typecheck && npm test` 全绿（数量以 `npm test` 末行为准，本轮末 415）；并发用例（`tests/bin.test.ts`「parallel writers」，12 轮 × 6 路）修前单跑 3/3 失败、修后 3/3 通过；三份真实台账（只读副本）check 计数不变（orca 0/139、cafe 0/47、dogfood 0/3），`adopt --dry-run` 均「已是规范台账」，无 W225；复审(10) 的 10 个 repro 全部 adopt exit 0、check 0 error、二次 adopt 字节不变；锁路径为目录 / 悬空链接 / 000 时 2 秒后 exit 4；发版冒烟（`npm pack` → 临时目录安装 → `new`/`check`/`import()`）正常，包内无 `.cafe`/`scripts/`/`.dist-test`。

## 第九轮（2026-11-25）

用户裁定（均按推荐）：Q1 `rename` 也拒绝重复摘要 → 已做；Q2 收紧 E124 的无表头判定 → 暂不做（真实台账没出现误报）；Q3 新功能先写设计再做、缺陷直接 TDD → 本轮只有两项小的输出约定变更（`new` 打编号、`rename --allow-duplicate-title`），没写独立设计文档。

台账无新条目，改为自测：两个黑盒 subagent（A：写命令与 CLI 表层；B：adopt/check/读命令），所有发现先复现再修，每条先写失败用例（`src/dogfood.test.ts` 末尾的 `probe:` 用例）。

| 来源 | 问题 | 处理 |
|---|---|---|
| 自查 | `new` 成功不输出编号，agent 只能 `list` 猜（并发下会猜错） | `new` 成功时 stdout 只有编号一行；dry-run 仍只有 diff |
| Q1 | `rename` 能把开放项改成另一开放项的摘要 | 拒绝（exit 2，点名），`--allow-duplicate-title` 放行；已关闭项不拦 |
| 自查 | README/SKILL 仍写「未发布」、动词列表缺 body/priority/split | 改为 `npm install -g @blrbiran/issuemd` 等 |
| B1 | adopt 合并同号多行：仍开放的 issue 取了已关闭表的摘要；同表两行时第二个摘要无声丢失，报告还写「多张表」 | 摘要跟随最终所在表；未采用的摘要逐字写进 `duplicate-row`；同表写「同一张表里有 N 行」 |
| B4 | 开放行无正文时附加列（负责人）进了骨架 `**验收判据**`，之后 `close` 会把它当判据提升 | `Row.extras` 与 `criteria` 分开；开放项进 `**原表格判据**` + `extra-columns`；已关闭行判据格「判据；附加列」。顺带修了骨架后多一个空行 |
| B2 | 开放多号行 `2, 3` 无法 adopt（正文被当孤儿、E102 自拒） | 逐号挂已有正文或补骨架，全体按编号排序；不同标题写成 `**原正文标题**`；>1000 号的开放区间不展开 |
| B3 | `✅ 已修`、`已修（v2）`、`**未决**` 不认，关闭项被重开；未知状态词只留在可选报告里 | `plainStatus` 去格式后认词表；未知词/带括注的原格以 `原状态：X` 写进输出 |
| B5 | 首格解析不出编号的行、比表头宽的行被静默处理 | 各出一条 `id-range` / `extra-columns` 决定 |
| B6 | H1 下或外来小节里的 `### Issue N:` 被搬进正文的同时原处还留一份 | `movedBodyLines`：搬走的正文从逐字副本里去掉 |
| B7 | `show` 查到的编号同时在 E124 游离行里，无任何提示 | stderr 点名那一行（exit 0 不变） |
| A1 | `reopen` 把空优先级写成 P2（orca 25/26 开放项无 P），keep-body 往返不再逐字节 | 空就是空 |
| A3 | `close --criteria ""`（变量没设）等于静默 `--no-criteria` | exit 2，提示 `--no-criteria` |
| A4 | 正文重复 `**验收判据**` 时只提升第一块 | `extractCriteria` 合并所有非空块（`；`），`show --json criteria` 同口径 |
| A7/A9 | `--keep-body`：附录末尾未闭合 fence 会吞掉归档；附录已有同号归档时 reopen 恢复错的那份；无正文时报错让你「传 --keep-body」 | 前两者 exit 3 拒绝；报错改为点名「没有正文」 |
| A2 | 正文 fence 里的 `<!-- issuemd:kept-body:end -->` / 归档说明行在 reopen 时被删；fence 外的标记会截断归档 | reopen 只剥归档自己的标记与说明行；`new`/`body`/`close --keep-body` 拒绝 fence 外的标记 |
| A6 | SKILL 推荐的「`show --json` body.text 去标题再 `body` 回写」每次多一个空行 | `--body-file` 开头空行剥掉；三份真实台账全部开放项回写验证为 no-op（dogfood 两处手写空行被规范化，非内容） |
| A5 | 0444 只读台账照写（原子替换只需目录可写） | 真写 exit 2，dry-run 照常（`readOnlyRefusal`，在 CLI 层，没改 io.ts） |
| A-CLI | 写命令「no such issue」进 stdout 混入 diff；多处 usage 过时；`sync --guide --prefer` 静默接受；`--prefer table` 把进展词抄进正文标题；无改动的 `sync --titles --dry-run` 什么都不打 | stderr + exit 1；usage 一律取 `COMMANDS`；选项组合校验；`--prefer table` 命中 W260 exit 3；`(no changes)` + snapshot |
| A9 | `a \\| b`（字面反斜杠后跟竖线）被当已转义，写入被门禁拒 | `escapeCell`/`unescapeCell` 按反斜杠奇偶，与 `splitCells` 一致 |
| A9 | 旧已关闭摘要以 ` #` 或 `（2）` 结尾时 reopen 只报 E106/E121 | `titleProblem` 提前拒绝并给 `issuemd rename …`；`new`/`rename` 也拒带计数的标题 |
| B-minor | `show FILE 4-x` exit 1 | 格式非法的 id 一律 exit 2（`badIdText`） |
| 复审 | `plainStatus` 剥掉所有非字母字符，`❌ 已修`、`已修？` 被当成已修并关闭，原格丢失 | 只剥强调符、开头勾号、结尾括注；剥掉的不止强调符时写 `原状态：…`；否定/存疑写法按未知词 |

验证：`npm run typecheck && npm test` 全绿；`npm run build` 后对三份真实台账（只读副本）跑 check（0 error）、`adopt --dry-run`（均「已是规范台账」）、每个单号开放项 `close --keep-body` → `reopen` → `body` 配方 → `check`，0 失败；不逐字节的只有「台账没有 `## 附录`」（已知项）与「原文正文前缺空行、reopen 规范化」两类。发版冒烟：`npm pack` → 临时目录安装 → `new/check/show --json` + `import()` 正常，包内无 `.cafe`/`scripts/`/`.dist-test`。

## 第八轮裁定（用户 2026-11-24，均按推荐）

| 条目 | 之前 | 第八轮 | 落地 |
|---|---|---|---|
| #52 | — | 规范表以外的 issue 表报 **E124**（error），编号按不可读行处理 | `src/ledger.ts` `strayRows` |
| #18 | 第六/七轮：dry-run 不锁快照，不做 | 加 **`--if-unchanged S`**：dry-run 在 stderr 打 `snapshot: S`，`--json` 读视图带 `snapshot`，写命令读入时不是 S 就 exit 4、不动文件 | `src/cli.ts` `snapshotOf` / `loadWritable(file, expected)` |
| #34 | 只打 W212 warning（重复项已经写进去了） | `new` 默认**拒绝**与开放项同名的摘要（exit 2，点名已有编号）；`--allow-duplicate-title` 放行，之后由 `check` 的 W212 持续报出 | `cmdNew` |
| #21 | 原子换入 `dist/`，判据已达标 | `npm test` 编译到 **`.dist-test/`**，完全不碰 `dist/`；只有 `npm run build` / `prepack` 写 `dist/` | `scripts/build.mjs --out`、`tests/built.ts` |

保持不做（重新审视后仍同意，理由见下表「第七轮裁定」）：#22 判据 3、#46 判据 2/3、#48 判据 4、写命令 `--json` 输出（#18 的 json 部分）。

## 第七轮裁定（用户 2026-11-24：Q1–Q4 按推荐，均不做；Q2 的 dry-run 部分第八轮已用 `--if-unchanged` 另行解决）

| Q | 问题 | 推荐与理由 |
|---|---|---|
| Q1 | #22 判据 3：check 对「已关闭行判据为空」报 warning | 不做。close 已拒绝产生空判据；迁移来的旧已关闭行大量合法为空，warning 会让 `--strict` 不可用。可选替代：只读的 `list --closed` 空判据过滤 |
| Q2 | #18：写命令 `--json` 冲突输出；dry-run 校验快照 | `--json` 仍不做（exit 4 已可机器识别）。dry-run 快照：第八轮改为 `--if-unchanged`（不是 dry-run 加锁，而是真正写入时比对） |
| Q3 | #46 判据 2/3：`adopt --verify=原文件`；check 报「200 字以上段落重复」 | 不做。改为 W253（按 id 精确）+ 报告守恒行；泛段落去重在真实台账里误报多 |
| Q4 | #48 判据 4：check 报「`### Issue` 前无空行」 | 不做。CommonMark 不要求空行，解析正确；写命令已不再产生 |

## 第六轮裁定（用户 2026-11-24「按推荐」）

| Q | 裁定 | 落地 |
|---|---|---|
| Q1 close 不给判据参数 | 正文有非空 `验收判据` → 自动提升；没有 → exit 2，要求 `--criteria` / `--keep-body` / `--no-criteria` | `cmdClose` |
| Q2 新命令 | 先写设计再实现，用户复核后合入 | 已合入（`body`/`priority`/`split`/`reopen --status`） |
| Q3 E130 | 单独退出码 **4**（可重试）；dry-run 只是当下预览、不锁快照（第八轮补了 `--if-unchanged`） | `commit()`/`cmdAdopt`、spec §7/§9 |
| Q4 W202 | 已关闭表「判据」列与 UUID 不报；正文照报；`--verify-commits` 仍查判据里的 hash | `checkHashes` |
| Q5 优先级 | `P0`–`P3` 或空；`new` 越界 exit 2；`check` 报 W221 | `PRIORITIES` |
| Q6 符号链接 | 解析到目标文件写入（不改 io.ts），链接保留；硬链接写后 warning | `loadWritable` |
| Q7 keep-body 判据两份 | 接受：附录归档 = 冻结的历史快照，不算第二份判据 | spec §7.2 |

## dogfooding 53 条的处理结果

| 条目 | 结果 |
|---|---|
| #1–#7（skill 文档） | SKILL.md 已改：安装路径、check 退出码、E120、四个 per-id 命令 + 区间、裸调用/status 修词/--strict/show --json/W202·W240、`--body-file` 不含标题、`--title="-…"` |
| #8/#22/#29 判据丢失 | 修：标签块读到下一个标签/标题为止（空行+列表都算）；close 规则见第六轮 Q1；`--criteria-from-body` 空则拒绝；`show --label` 空标签 exit 1 |
| #9/#33 取值校验 | 修：优先级词表 + W221；`list --status/--priority` 未知值 exit 2，跨表提示 `--closed` |
| #10 reopen 状态 | `reopen --status` |
| #11 list --closed 判据 | 修：文本输出带「判据:」 |
| #12 adopt 已合规 | 修：check 0 error 且无 W220 → 原样不动；空模板不再「不是台账」；空 `## 附录` 不删 |
| #13/#14 选项 | 修：每命令选项白名单，越界 exit 2；`issuemd <cmd> --help` |
| #15 sync 跳过 | 修：stderr 列出跳过的多号行 |
| #16/#24 编辑正文 | `body` 命令 |
| #17 adopt 报告 | 修：三段（机械改动 / 原样保留 / 已按默认处理请复核），dry-run 措辞「将」 |
| #18 并发 | E130 → exit 4；SKILL「Several agents, one ledger」；第八轮加 `--if-unchanged` + `snapshot`。未做锁文件、未做写命令 `--json` |
| #19 链接 | 修：符号链接写穿、硬链接 warning |
| #20/#21 build 打断全局命令 | 修：build 走 staging + rename、bin 755、类型错误时旧 dist 保留；第八轮起 `npm test` 只编译到 `.dist-test/` |
| #23 reopen 回收归档 | 修；W252（归档对应 id 已开放） |
| #25/#41/#49 adopt 丢内容 | 修：H1 下说明原位保留；受控块外文字保留；表格小节里的说明/叙述 H3/映射不了的表进附录；带括注的规范标题按规范节处理 |
| #26 diff 粒度 | 修：Myers 多 hunk；用 `patch(1)` 随机 2000 例验证 |
| #27 W202 | 修：见第六轮 Q4 |
| #28/#45 adopt 坐标 | 修：拒绝时报 `source L…`；决策定位不到时报 `源 L…`；E108 文案提示未转义 `\|` |
| #31 list 粒度 | 修：`ids`/`count`/`rowCount`/`issueCount`、`--expand`、文本 `(N ids)` |
| #32 show --json | 修：`labels`、开放项 `criteria` + `criteriaSource` |
| #34 重复标题 | W212（check）；第八轮起 `new` 默认拒绝同名开放项，`--allow-duplicate-title` 放行 |
| #35 --report 覆盖台账 | 修：拒绝台账本身与无关的已有文件；dry-run 仍写报告，台账不动 |
| #36 坏行 | 修：`parseLedger().unreadable`；读命令 stderr 提示、`list --json` 附 `unreadableRows`、`show` exit 3、取号与撞号算上坏行 |
| #37/#38 门禁 | 修（计数比对、`--body-file` 标题） |
| #39 编号溢出 | 修：默认 max+1 越界 exit 2 |
| #40 归档标题 | 修：close/adopt 同一归档格式；rename 同步归档标题；W251 |
| #42/#43 adopt 表映射 | 修：宽度 2、表头「裁决/说明…」当判据、多余列进判据；判据格开头状态词 → 状态；未知已关闭状态 → `未分类` |
| #44 split | `split` 命令；所有 per-id 拒绝文案统一（`perIdRefusal`）并指向它 |
| #46 迁移守恒 | 修：adopt 内置守恒自检（逐行文本 + 编号集合），否则拒写；报告写守恒行 |
| #47 `'''` | 修 |
| #48 追加空行 | 修：`insertBlock` |
| #50 adopt 正文双份 | 修：表格小节内的 `### Issue N:` 只走一条路；W253 |
| #51 复测（第六轮） | 已处理，见第七轮 |
| #52 规范表以外的 issue 表 | 第八轮修：E124 + 编号保留（见下「架构要点」）；adopt 对混合文件照常转换，且不再把规范表的空表头当说明文字复制进附录 |
| #53 复测（第七轮） | 只是记录，无新缺陷；其中「#34 缺 `--allow-duplicate-title`」与「#21 `npm test` 仍写 `dist/`」已在第八轮处理 |

真实台账试跑（只读副本，在 scratch 目录；**不进测试**）：第八轮对 dogfooding / cafe / orca 三份已迁移台账跑 `check`，都没有 E124；`show --json` 的 `snapshot` 与 dry-run 打印的一致，`--if-unchanged` 写入 exit 0，旧 token 再写 exit 4。

## 必须先读的材料

| 文件 | 作用 |
|---|---|
| `docs/spec.md` | 唯一规格。第十一轮改了 §6（E124 的表头判定与「只跳过台账真正读的那一节」、W225 的范围与编号占用、E130 读入竞态 exit 4）、§7（dry-run diff 的无尾换行标记、取号跳过 W225 编号）、§10（`cited-table`、无表头三列逐行状态）。第九轮改了 §7（`new` 打编号、只读、`close` 判据与 keep-body 拒绝情形、`rename` 查重、`sync` 选项、写命令 miss 走 stderr）、§9（`show` 的游离行提示）、§10（同号多行摘要、附加列、开放多号行、状态格、坏编号行、搬走的正文）。第八轮改了 §6（E124、W212 口径）、§7（`--if-unchanged` / `snapshot`、`new` 重复摘要拒绝、取号算上 E124 行）、§9（读命令 `--json` 带 `snapshot`）、§10（adopt 对混合文件） |
| `docs/adr/0001`–`0006` | 0006「只做台账、一个入口」 |
| `docs/superpowers/specs/2026-11-24-ledger-verbs-design.md` | `body` / `priority` / `split` / `reopen --status` 的设计 |
| `docs/superpowers/specs/2026-11-24-issuemd-ledger-only-design.md` | 第四轮设计，末尾「实施后的偏差」 |

辅助：`GLOSSARY.md`、`README.md`、`skills/issuemd/SKILL.md`（随包发布）、`TEMPLATE.md`、`THIRD_PARTY_NOTICES.md`。

## 命令表面（main）

```text
issuemd check    FILE [--json] [--strict] [--verify-commits]
issuemd list     FILE [--status S] [--priority P] [--closed] [--expand] [--json]
issuemd show     FILE ID [--json] [--label NAME]
issuemd counts   FILE [--json]
issuemd read     FILE <H2 标题>

issuemd new      FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-] [--allow-duplicate-title]
issuemd close    FILE ID [--status S] [--criteria TEXT | --criteria-from-body | --no-criteria] [--keep-body]
issuemd reopen   FILE ID [--status S] [--allow-duplicate-title]
issuemd status   FILE ID NEW_STATUS
issuemd rename   FILE ID "NEW TITLE" [--allow-duplicate-title]
issuemd body     FILE ID --body-file PATH|-
issuemd priority FILE ID P0|P1|P2|P3|""
issuemd split    FILE ID
issuemd sync     FILE [--guide | --fix-tables | --titles [--prefer body|table] [--move-progress | --drop-progress]]
issuemd adopt    FILE [--dry-run] [--report PATH]
issuemd <command> --help
```

所有写命令另接受 `--dry-run`（stderr 打 `snapshot: S`）与 `--if-unchanged S`。读命令的 `--json` 顶层带 `snapshot`。`new` 成功时 stdout 只有分配到的编号。写命令找不到编号 → stderr + exit 1；编号格式非法 → exit 2。台账文件只读 → 真写 exit 2。

退出码：0 成功 / 1 没有这条 issue 或空结果 / 2 用法或 I/O / 3 校验失败 / **4 E130 并发改动或 `--if-unchanged` 不符（可重试）**。

## 架构要点（改之前必须知道）

- **`src/io.ts`** —— **不要改**。原子写、快照复核、BOM/行尾/尾换行/权限位。符号链接在 CLI 层（`loadWritable`）解析成真实路径再交给 io；硬链接数也在 CLI 层 `lstat`。**写锁也在 CLI 层**：`commit()` 与 adopt 都经 `lockedWrite(loaded.path, …)` 调 `writeAtomically`，新写路径不要直接调 `writeAtomically`。
- **`src/cli.ts`**：
  - `COMMANDS` 表是命令与选项的唯一来源：`run()` 用它拒绝越界选项、生成全局与 `<cmd> --help`。新增命令/选项要同时进 `COMMANDS`、`OPTION_HELP`、`OPTIONS`。`OPTION_HELP` 文案里别写别的命令专属的选项名（`close --help` 有用例断言不出现 `--json`）。
  - 写命令共享 `commit()`：`terminate()` → `joinDocument` → `checkLedger` → **按 multiset 只拒新 error** → `--dry-run` 出 diff（stderr 带 snapshot）/ `writeAtomically(loaded.path, …)`（E130 → exit 4）。成功后若有其他硬链接，stderr 追加提示。
  - `Loaded = { doc, lines, path, links, snapshot }`。**`--if-unchanged` 在 `loadWritable(file, expected)` 里、刚读完文件时比对**，所以任何命令逻辑（「已关闭」之类）之前就 exit 4。所有写命令经 `openLedger(file, v["if-unchanged"])` 或（adopt）直接 `loadWritable(file, v["if-unchanged"])` 读文件；新写命令必须照做。
  - `snapshotOf(text)` = sha256 前 16 位十六进制。写路径对 `joinDocument(lines, doc)`、读路径对 `readFileSync(file, "utf8")` 求值；两者对合法 UTF-8 文件逐字节相同（BOM、CRLF、无尾换行都保留）。`run()` 校验格式（16 位小写十六进制），不对就 exit 2。
  - 插入正文块用 `insertBlock`（两侧恰好一个空行）；`close --keep-body` 的归档插入仍是 `insertLines` + 手动前导空行——`reopen` 的逐字节还原依赖它，别改成 insertBlock。
  - `cmdClose` 的判据规则：`--criteria` > `--no-criteria` > `--criteria-from-body`（空则拒）> 正文自动提升 > `--keep-body` 允许空 > 否则 exit 2。
  - `cmdNew`：先查重复摘要（只比开放行，`summaryKey` 归一），再取号；成功后 stdout 是编号（只在非 dry-run 时替换 `commit()` 的空 stdout）。`cmdRename` 同样查重复摘要（排除自己那一行；目标是已关闭项时不查）。
  - `titleProblem()` = 空标题（第十二轮）+ 计数后缀（`countSuffix`，E121）+ 结尾 `#`；`new`/`rename` 用于输入，`reopen` 用于已关闭行的旧摘要。
  - `readOnlyRefusal()` 在 `commit()` 与 adopt 的写入前各调一次（`accessSync W_OK`）。
  - `missingIssue(verb, id)` / `badIdText()`：写命令的「没有这条」走 stderr；`show` 仍用 stdout 的 `(no such issue: N)`。
  - `readBodyFile` 剥 BOM 与开头空行，拒绝 fence 外的 `KEPT_BODY_END`。reopen 的归档恢复只剥「结束标记所在那一行」与「第一条非空行若是 ARCHIVE_NOTE」。
- **`src/ledger-edit.ts`**：
  - `escapeCell` / `unescapeCell`：竖线前反斜杠为奇数才算已转义，与 `ledger.ts` 的 `splitCells` 读法一致。标题输入用 `unescapeCell` 归一，别再写 `.replace(/\\\|/g, "|")`。
  - `extractCriteria()` 合并所有非空 `**验收判据**` 块（去重，`joinClauses` 连接：前段以 `；`/`;` 结尾时不再加 `；`）；close 提升与 `show --json criteria` 都走它。`labelName()` 把 `**验收判据：**` 归一成 `验收判据`，labelBlock / labelsIn / W206 都用它。
  - `labelBlock()` 是唯一的标签解析：从 `**标签**` 行到下一个标签行或标题；空行、列表、fence 内容都属于它。`findLabel`、`extractCriteria`、`show --json labels` 都走它。
  - 归档格式常量：`archiveHeading()`、`ARCHIVE_HEADING`、`ARCHIVE_NOTE`、`KEPT_BODY_END`。close / adopt / reopen / rename / check 共用，改格式只改这里，并跑 `keep-body round trip`。
  - `ledger-edit` 与 `ledger-check` 互相 import（只在函数里用对方，模块初始化时不能用）。
- **`src/ledger.ts`**：
  - `parseLedger` 的 `unreadable: UnreadableRow[]`：E108/E109 丢掉的表行，**以及 E124 的「游离行」**（`table: "stray"`）。下游（`maxIssueId`、`new --id` 撞号、`show` exit 3、`unreadableNote`、`list --json unreadableRows`）都靠它，所以 E124 行自动被保留编号。
  - `strayRows()`（#52）：所在 H2 不是 `怎么用/状态口径/索引/已关闭/正文/附录`（括注去掉后比较），且 (a) 有表头、表头含 `#/编号/ID` 列与 `摘要/标题` 列；或 (b) 表头含 id 列与 `状态` 但无摘要列，且 H2 名匹配 `isTableSection`；或 (c) 无表头、宽 2–5、H2 名匹配 `isTableSection`。**口径必须与 adopt 迁移哪些表保持一致**：adopt 不迁移、原样保留的表若被报 E124，adopt 的输出就过不了自身校验（第八轮复审 #1）。每个能解析出编号的行报一条 E124。H1 与第一个 H2 之间的表不算。
  - `isTableSection`（台账表小节名正则）、**`mappingFor`（issue 表的列映射）**、**`tableHeader`（首行是不是表头）**、`isStatusWord` 都定义在这里，adopt 从这里 import。改其中任何一个都要同时看 check 与 adopt 两边。
  - `tableHeader(rows, synthetic)`（第十一轮）：首行不含数字 → 表头；首行下不是分隔行 → 无表头；`synthetic`（adopt 的 `fixSeparators` 自己补的分隔行）→ 有以数字开头的格就是数据（旧规则）；真实分隔行 → 表头，除非首行是 issue 行：首格是编号且其余格有非数字文字（`issueLike`），并且第二格是状态词 / 分隔行下没有行 / 下面每行都 `issueLike`。统计表（`| 2026 | 开放 | 关闭 |` 下接纯数字行）因此仍是表头。
  - `strayRows` 口径（第十一轮）：只跳过台账真正读的那一节（`OWN_TABLES` 里标题精确相等的**第一个** H2）；`## 索引（旧）`、`## 已关闭（2025）`、第二个 `## 索引` 都照常判。台账表小节下 `tableHeader` + `mappingFor` 接受的表 → 每行 E124 + `unreadable`；其他小节下有真实分隔行、且（表头含 id 列与 `摘要`/`标题`，或表头只有两列含 id 列，或表头位置是 issue 行）→ 每表一次 W225，每行编号进 **`cited`**。`## 路线图` 的 `| ID | 状态 | 说明 |` 不报。
  - `parseLedger().cited`：W225 表里的编号，**不进 `unreadable`**（否则读命令会说「结果不完整」、`show` exit 3）。`cmdNew`（取号逐个跳过、`--id` 撞号 exit 2）、`cmdShow`（miss 时 stderr 提示）和 `list --json` 的 `citedRows`（第十二轮）用它。库导出的 `maxIssueId` 不看它。
  - **`countSuffix` / `stripCountSuffixes`**（第十二轮）：「标题末尾的计数」唯一定义。4 位 19xx/20xx 年份不算；全角数字算；整个标题只是 `（3）` 不算。调用方负责先去掉 `#` 标记、ATX 结尾 `#`、`Issue N:` 前缀：E121（ledger-check 对 Issue 标题取冒号后）、`titleProblem`（cli）、`stripCounts`（adopt，反复剥）、adopt 对开放行摘要也剥。
- **`src/ledger-check.ts`**：`PRIORITIES`、`summaryKey`（W212 的 NFKC/大小写/空白折叠）；`checkHashes` 区分 pinned（W202）与仅校验（判据列，给 W240 用）；`checkAppendix` 出 W250/W251/W252/W253。`--strict` 仍只豁免 W250。
- **`src/ledger-read.ts`**：`ListedIssue` 带 `ids`/`count`；`expandIssues`（上限 10 万）；`viewIssue` 带 `labels`、`criteriaSource`。
- **`src/statuses.ts`**：默认状态词表 `STATUS_CLASSES`（第十一轮从 ledger-check 移出，ledger.ts 要用且不能与 ledger-check 循环引用）；`ledger-check` 仍 re-export。
- **`src/adopt.ts`**（改前读完它）：
  - `pipeBlocks(lines, sections, synthetic)`：表头走 `tableHeader`，`synthetic` 是 `fixSeparators` 补分隔行的行号集合。无表头宽 3 的块带 `rowStatus`：`rowsOf` 逐行判断，第二格是精确状态词的行按 `# | 状态 | 摘要`，其余按 `# | 摘要 | 判据`。
  - W225 的 `cited-table` 决定不在 adopt() 里产生，而在 `cmdAdopt` 对输出跑 check 后补上（早退路径也有）；报告因此在 check 之后渲染。
  - 开头：输入 `check` 0 error 且无 W220 → 原样返回。E124 是 error，所以「规范骨架 + 旧表」的混合文件会走完整转换。
  - `demoteHeadings`（第十二轮）：只在正文块里把 H4–H6 降级——从 `Issue` 标题（H1–H3，行首 0–3 空格）到下一个同级或更高级标题。旧 cafe 是 `## Issue N:` + `### 期望` + `####`，所以不能写成「下一个 H1–H3 结束」。
  - 正文标题与摘要的比较一律先 `unescapeCell(title)`：E106、adopt 的 `open-title-conflict`、`sync --titles`（第十二轮）。
  - `layoutLines`：被消费的表块的表头/分隔行，**加上表格小节里只有表头+分隔行的空表**（#52：混合文件里规范表是空的，以前会被当成说明文字复制进附录）。
  - `Row` 有 `criteria`（真判据）与 `extras`（附加列、溢出格、`原状态：X`）两个字段，**不要再把 extras 拼进 criteria**：开放项 extras 进 `**原表格判据**`，已关闭行在输出表时才拼成「判据；附加列」。`Row.overflow` 记溢出格数，`rawStatus` 记去格式前的状态格。
  - 开放正文组装：每个开放行按 `parseIds` 逐号生成 `bodyEntries`（已有正文或骨架），最后全体 `compareIds` 排序再展开；索引表行仍用 `sortedOpen`。
  - `movedBodyLines`：被搬进正文/归档的 `### Issue N:` 块，在 H1 说明与外来小节的逐字副本里跳过。`topBodyLines`：首个 H2 之前、且是 `bodyById` 选中的那份正文，在 H1 说明与前言里跳过（没选中的同号副本留原处转义）。`appendixBodies`：输入附录里的正文块，不参与挂载，原地改标题。
  - 列映射 `mappingFor`、状态优先级、保留规则、**守恒守卫**（逐行文本 + 编号集合）同前：新增任何「重建」逻辑时，要么把行复制到输出，要么把它加进 `regenerated`（= `rowLines` ∪ `layoutLines`）。
- **`src/write.ts`**：Myers 行级 diff + 3 行上下文多 hunk。`unifiedDiff(old, next, path, finalNewline)`：无尾换行时末行后加 `\ No newline at end of file`，只在一侧是末行的上下文行拆成 -/+，这样 `patch` 能应用。
- **`src/cli.ts` `openFailure`**：`loadWritable` 的读入异常；io 的「E130 file changed while being read」→ exit 4，其余 exit 2。
- **`scripts/build.mjs [--out DIR]`**：`tsc --outDir .<DIR>-staging` → chmod 755 bin → rename 换入。默认 `dist`；`npm test` 用 `--out .dist-test`。类型错误时目标目录不变、`npm test` 停在 build。
- **`tests/built.ts`**：测试里执行 CLI / 导入编译产物一律用 `built("bin/issuemd.js")` 之类（默认 `.dist-test`，可用 `ISSUEMD_BUILD_DIR` 覆盖）。**测试里不要再写 `../dist/`**。打包测试只校验 manifest（`files` 含 `dist`、`bin`/`exports` 指向 `dist/…`）加测试产物本身。

## 实现时踩过的决定（照直觉改会出错）

1. `--keep-body` 归档不是 `### Issue N`（E123）；先删正文块、再重新 parse 定位附录；删索引行前再 parse。
2. 多编号行 / 区间行 + per-id 命令 = exit 2，统一走 `perIdRefusal`（指向 `split`）。
3. 写入门禁基线是 `checkLedger` 的完整诊断集，按计数比对。
4. id 是 `\d+[a-z]?`，`2` ≠ `2a`；查正文、插正文、排序都用完整 id。
5. fence 内皆非数据；受控块 marker 必须在自己的小节内。
6. `replaceCell` 按原文拼接；`escapeCell` 不二次转义。
7. 正文块按编号升序插入（`bodyInsertAt`）。
8. `--strict` 只豁免 W250。
9. adopt 的宽度推断只在台账表格小节内可信；保留内容不重排，只做必要转义/降级。
10. `adopt --dry-run --report` 会写报告，但 `--report` 不能是台账本身、不能覆盖非 adopt 报告的已有文件。
11. adopt 的捷径条件含「无 W220」：未声明状态词要走完整转换以便报告 `unknown-status`。
12. `list --status` 的值若在台账里真实出现（即使不在词表），允许——这是查拼错状态行的办法。
13. W202 判据列识别靠「已关闭行的最后一个原始单元格」，不是 `row.criteria`。
14. adopt 里表格小节下的 `### Issue N:` 是**正文块**：section-prose 循环用 `bodyStarts` 跳过它（#50）。
15. adopt 守恒有两层：逐行文本守卫 + 编号集合守卫；通过时 `changes` 里写 `守恒自检：issue N → N…`。
16. W253 只报「第二份」；开放项的第一份归档仍归 W252，不双报。
17. E124 是 **error** 而不是 warning：只有这样 adopt 才不走「已合规」捷径、`--strict` 之外的普通 `check` 也会失败。它的编号走 `unreadable`，不进 `rows`——进 `rows` 会让 `list`/`close` 把游离行当正常行改写，而它不在规范表里。
18. `--if-unchanged` 的比对点在读入处，不在 `commit()`：放在 `commit()` 时，文件被改后命令可能先因「已关闭」等原因 exit 2，调用方就分不清是并发还是自己错了。
19. `new` 的重复摘要拒绝发生在任何改动之前，`--dry-run` 也同样拒绝；只比开放行（以 `并入` 关闭的重复项不挡新建）。
20. 「首行是不是表头」不能简单地按「有没有以数字开头的格」判断：adopt 自己补分隔行后，无表头表的首个数据行就在分隔行上面（要当数据）；而真实的统计表、年份表头（`| 2024 | 2025 |`）要当表头。所以 `tableHeader` 区分 `synthetic`，真实分隔行上只认明显的 issue 行（第十一轮复审(12)、黑盒 3 来回修过两次）。
21. W225 的编号放在 `cited` 而不是 `unreadable`：`unreadable` 会让读命令说结果不完整、`show` exit 3，叙述表不该有这种后果。
22. 默认取号对 `cited` 逐个跳过，不是取最大值：错误码表里的 500 不能把下一个 issue 推到 501。
23. 标题计数判定只有 `countSuffix` 一处；新加任何「看标题末尾数字」的逻辑都调它，并且先剥掉 `#`、ATX 结尾 `#`、`Issue N:` 前缀——否则 check 与 adopt 又会互相指认（第十二轮复审(14) 1、黑盒 D2）。
24. 改 adopt 的机械改写（降级、剥计数、补分隔行）后，除了 fixture，还要拿 `../cafe_dogfooding` 的 git 历史版本对比新旧 build 的 adopt 输出：第十二轮 D4 的第一版修法只有在 cafe 历史版本上才暴露。
25. 标题正则要认 CommonMark 的 0–3 空格缩进与制表符（`scan` 就是这么读的），否则 check 看得见的标题 adopt 看不见（复审(15) 1）。

## 已完成的审查与验证

- 回归用例：`src/dogfood.test.ts`（按 dogfooding 编号分组；第九轮自测的用例以 `probe:` 开头，在文件末尾）、`src/ledger-verbs.test.ts`、`src/write.test.ts`、`tests/bin.test.ts`（bin 执行位、FIFO 驱动的真实并发 → exit 4、打包 manifest）。
- 第八轮手工验证：`npm test` 前后 `dist/` 与 `dist/bin/issuemd.js` 的 inode + mtime 不变；故意制造类型错误时 `npm test` exit 1 且 `.dist-test` 不含残留；`npm pack --dry-run` 不含 `.dist-test`。
- 第八轮末尾派了独立 subagent 复审本轮 diff，结论见最后一节「第八轮复审」。

## 仍然接受的已知项

- 原子替换的竞态：issuemd 写者之间已由写锁串行化（第十轮）；**非 issuemd 的写者**（编辑器）在复核与 rename 之间改文件仍会被覆盖（窗口极小）。
- 读命令把非法 UTF-8 解码成 U+FFFD（只影响输出；这类文件写命令本来就拒绝，所以 snapshot 不一致无影响）。
- W202 不把 7–39 位纯数字当 hash（会漏掉约 3.7% 的纯数字短 hash）。
- `adopt` 对已经保留进附录的外来小节重跑时会再报 `foreign-section`。
- adopt 宽度 2 的 `| # | 说明 |` 把「说明」当摘要；需要更好摘要时人工 `rename`。
- `build` 换入时两次 rename 之间有微秒级窗口没有目标目录。
- 写锁只串行化「复核 + rename」，不排队：并发冲突仍是 exit 4 + 调用方重试。锁残留（进程被 SIGKILL 于毫秒级窗口内）由下一个写者按 pid/30 s 接管；两个写者同时判定残留时理论上可能互删对方新锁（极罕见）。
- 附录以空行结尾时，`close --keep-body` 的归档前会多一个空行（改它会破坏 close+reopen 逐字节还原）。
- adopt 守恒守卫的局限：同号的两个正文块会被拒；以「文本集合」比对，测不出「丢了一行、但同样文字别处还有」。
- diff 超过 2000 步编辑时退化为一整块 -/+（正确但粗）。
- E124 的小节判定沿用 `isTableSection` 正则（含 `总览`/`open`/`issues?`），像 `## Open questions` 下的「首格是数字、宽 2–5、无表头」的管道块、`## 总览` 下的错误码表、`## 状态总览` 下首格是数字且有文字的统计表会被报——真实台账里没有出现过；需要时把正则收紧（adopt 用同一个函数，自动同步）。
- adopt 不展开 >1000 号的开放区间，于是这类区间行没有正文 → 转换后 E102，adopt 拒写（旧行为）。
- 无分隔行、首行像表头（`| 负责人2 | 甲 | 乙 |`）的块：check 与 adopt 都当成非 issue 表；在台账表小节下仍报 E122，adopt 说「没有可迁移的行」，需人工补分隔行或改表头。
- W225 表里的编号**占用**（第十一轮改判）：叙述性的 `| # | 步骤 |`、`| 编号 | 说明 |`（错误码）也会报 W225、占用编号；默认取号只是逐个跳过它们。`变更记录` 下的 `| # | 状态 | 说明 |`（三列、无摘要列）有意不报。
- 只有管道行、没有分隔行的块不算表：非台账小节里不报 W225；台账表小节里仍按无表头表报 E124（adopt 会补分隔行迁移）。
- 被 `7a` 占用时 `new --id 7` 照写（`7` ≠ `7a`），默认取号按数字最大值跳到 8——与规范行一致，不是缺陷。
- `close --keep-body` 在没有 `## 附录` 的台账上会新建附录；`reopen` 不删它（不知道附录是不是 close 建的），往返后多出 `## 附录`。
- reopen / body 会把原文里「正文块前缺空行」「正文末尾多个空行」规范成恰好一个空行（只改空白）。
- adopt 转换失败时，对重建的表行 error 只能给 `source line unknown (converted L…)`。
- W253 只扫 `## 附录` 内；旧版 adopt 留在附录之后外来 H2 里的转义正文副本不报（第九轮起 adopt 不再产生）。
- 英文表头（`| ID | Status | Title |`）adopt 不认，整表进附录（`foreign-section`，有报告）。
- 结构已坏的台账（E103/E112）上 `check` 头部的分状态计数可能对不上总数；开放表里有未声明状态（W220）或关闭类状态（E112）时，`counts` 的括号里只列默认开放状态词，同样加不出总数。
- 年份与计数只按数值区分（第十二轮 Q1）：`## 已关闭（2013）` 不报 E121；`（1894）` 报。`⑵` 这类带圈/括号数字字符不算计数。
- `check` 不报空摘要 / 空正文标题（第十二轮 Q4）；adopt 不会再制造它们，`reopen` 拒绝。
- `new`/`rename` 把标题空白（含 U+3000）折叠成一个半角空格（第十二轮 Q3）。
- `sync --titles` 因「会引入 E121」拒绝时 exit 3（写入门禁），`new`/`rename` 对同一规则是 exit 2。
- W225 表里超出安全整数的编号（`99999999999999999999`）既不进 `citedRows`，也不报 E109；kept-row 进附录时行首 `|` 被转义（`\| 备注 | x |`，防止它在附录里又成表）。
- 正文里的 setext 标题（`文字` + `===`）让 adopt 以 E110 自拒（旧行为）；同一编号两份正文块被守恒守卫拒绝（旧行为）。
- 游离行（E124）首格解析不出编号时整行不报（无法判断它是 issue）；`new` 的重复摘要检查只看规范开放表，不看游离行——有 E124 的台账本来就该先 `adopt`。

## 还没做 / 仅供参考

- spec §14 的 Q2（`adopt --prefer` 信息丢失）与 Q5（第二套状态词）：用户明确不做，需要时先 brainstorming。
- #46 的独立 `adopt --verify=<原文件>` 与 `check` 的「附录重复段落」warning：未做。
- #18 的写命令 `--json`：未做（写锁第十轮已做，见上）。

## 验收与命令

```bash
npm run typecheck && npm test           # 必须全绿；npm test 只写 .dist-test/
npm run build                           # 合入 main 后更新 dist/（全局 issuemd 用它）
node dist/bin/issuemd.js check fixtures/canonical-clean.md   # 0 errors, 0 warnings
node dist/bin/issuemd.js check TEMPLATE.md                   # 0 errors, 0 warnings
node dist/bin/issuemd.js list fixtures/canonical-clean.md --closed --json   # 带 snapshot；每项带 ids/count；issueCount = 17
node dist/bin/issuemd.js close --help                        # 只列 close 的选项（含 --if-unchanged）
node dist/bin/issuemd.js list fixtures/canonical-clean.md --title x; echo $?   # 2
ls -l dist/bin/issuemd.js                                    # -rwxr-xr-x
npm pack --dry-run --ignore-scripts   # 含 TEMPLATE.md、THIRD_PARTY_NOTICES.md、SKILL.md、dist/*.d.ts；不含 scripts/、.dist-test
```

写新命令时的自检清单：进 `COMMANDS`（写命令带上 `dry-run` 与 `if-unchanged`）；经 `openLedger(file, v["if-unchanged"])` 读文件；`--dry-run` 不改字节；被拒绝的写不留部分修改；无尾换行保持；BOM/CRLF 保持；写后 error 不增加；非 UTF-8 / 混合行尾 exit 2；多号行/区间走 `perIdRefusal`；插入正文用 `insertBlock`。

## 已知的坑

1. bun 的 `spawnSync({ input })` 是 socket，不是 FIFO；隐式 stdin 只认 FIFO 与普通文件，测试用真实管道。
2. `text.split("\n")` 带出 EOF 哨兵，读写的行数组要去掉尾部空串。
3. 行号在插入/删除后会变：先改一处再算下一处必须重新 `parseLedger`。
4. `--dry-run` 也跑校验：不合法的操作 dry-run 也 exit 3。
5. `adopt` 的决策行号指向转换后的文档；`sourceLine` 是源坐标；报告里 `源 L…` 表示输出里找不到。
6. zsh 下变量里的命令不分词（`I="node x.js"; $I …` 会报 no such file），批量探针用 bash 脚本。
7. 写路径读文件两遍（预检 + readDocument），另加一次 lstat/stat。
8. 把一个已跟踪文件改成「忽略 + git rm --cached」后，若在分支上提交再 checkout main 并 ff 合入，git 会**删掉工作区里的该文件**。处理这类文件时先备份到 scratch。
9. 用 python 做多处文档替换时，每处都先 `assert old in s`，否则静默不改。
10. 本机 `cp` 是交互式别名（`cp -i`），覆盖时会卡住等输入；脚本里用 `/bin/cp -f`。
11. 写测试时注意「两边都是 undefined」的假通过（`expect(a).toBe(b)` 两边都没取到值）：先断言值存在。

## 建议调用的 skill

- `superpowers:test-driven-development`：改写命令或 adopt 前先写失败用例。
- `superpowers:systematic-debugging`：行级拼接、io、「check 通过但输出不对」。
- `superpowers:requesting-code-review`：一轮结束前派独立复审。

## 第八轮复审

本轮末尾派了一个独立 subagent 复审第八轮全部 diff（只读，在临时副本上复现）。处理如下，修复都先写失败用例：

| # | 发现 | 处理 |
|---|---|---|
| 1 | E124 把外来小节里的 `\| ID \| 状态 \| 说明 \|`（路线图）当 issue 表；adopt 原样保留这类表，于是自己的输出过不了校验，带路线图的旧台账变得无法 adopt（回归） | 修：无摘要列的表头只在台账表小节名下才算，与 adopt 迁移规则一致（`src/dogfood.test.ts` 的 `review: a foreign table…` / `review: a legacy file…`） |
| 2 | `scripts/build.mjs --out src` 会把源码目录 rename 走再删掉 | 修：`--out` 只接受 `dist` 与 `.dist-…`（`tests/bin.test.ts` 在临时副本里跑脚本验证） |
| 3 | 游离行首格解析不出编号（`\| x \| …`）时不报 E124；`new` 的重复摘要检查不看游离行 | 接受（见「仍然接受的已知项」） |
| 4 | E124 无 id、文案含小节名：门禁按计数比对，已有 E124 的台账上 `new` 仍可写 | 无问题，符合「只拒新 error」 |

复审确认无问题的：读写两条路径的 snapshot 在 LF / CRLF / BOM / 无尾换行下与 `shasum -a 256` 前 16 位一致；`--if-unchanged` 覆盖全部写命令（含三种 `sync` 与 `adopt`），且在任何改动前比对；重复摘要对 `\|` 转义、大小写、尾空白都能识别。

## 第九轮复审

本轮末尾派独立 subagent 复审 `origin/main..main`（把 origin/main 另行 build 做基线对比）。唯一回归是 `plainStatus` 过宽（见第九轮表最后一行），已先写失败用例再修。复审确认成立的：多号/区间展开与全局排序、`extras` 不进骨架判据、`movedBodyLines` 只输出一份且守恒守卫通过、坏编号行、adopt 自身输出再 adopt 逐字节不变、只读拒绝、转义奇偶与 `splitCells` 一致、keep-body 往返（含 fence 里的标记与说明行）、`--criteria ""`、exit 1/2 划分、`sync` 选项、`rename` 查重。

复审顺带指出、与 origin/main 行为相同（不是回归）、第九轮未修的缺口（**第十轮已全部修复**，见「第十轮」）：

1. 没有 H1 时，第一个 H2 之前的 `### Issue N:` 被 preamble 路径原样拷进附录 → adopt 以 E123 自拒。
2. 输入的 `## 附录` 里已有 `### Issue N:` → 原样拷贝 → E123 自拒（应转义或当正文处理）。
3. `### Issue 3–5:` 这种区间正文标题 → adopt 守恒自拒（lost-content）。
4. 已关闭多号行的正文在 H1 下时，会同时留在 H1 说明（已转义）与附录孤儿里。
5. `rename` 已关闭项到以 `（2）` 结尾的标题现在被拒（与 reopen 的 `titleProblem` 一致，属有意）。

