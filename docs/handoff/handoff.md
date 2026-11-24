# issuemd 交接文档

更新于 2026-11-25（第九轮收尾：台账没有新条目，改为自测——两个黑盒 subagent 探测 + 真实台账回归，修了 18 个提交的缺陷/易用性问题，见「第九轮」）。写给下一位接手者。

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

`issuemd` P0–P5 早已完成；`0.1.0` 已发布到 npm。dogfooding 台账（`../issuemd_dogfooding/issue-20261124.md`，现 53 条，**不在本仓库、不要改它，状态由测试者自己更新**）的 #1–#53 均已处理：修好，或经用户裁定不做。

- 第八轮已由用户 push（第九轮开始时 `origin/main` = 第八轮 handoff 提交）。
- 第九轮的提交都已 ff 合入本地 `main`，**尚未 push、尚未发版**。第八、九轮合起来有新错误码、新选项、新的输出约定（`new` 打印编号），下次发版建议 `npm version minor`（0.2.0）。第九轮已用 `main` 做过发版冒烟（见「第九轮」）。
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

1. **push**：第九轮的提交在本地 `main` 上，需用户 `git push`。
2. **发版（用户决定时机）**：`npm version minor` → `npm publish`（`prepack` 会自动 build `dist/`）→ `git push --follow-tags`。发布前冒烟：`npm pack --pack-destination <scratch>` → 临时目录 `npm install <tgz>` → `npx issuemd new/check` + `import('@blrbiran/issuemd')`；包内不能出现 `.cafe`、`scripts/`、`.dist-test`。
3. dogfooding 台账状态由测试者更新，**我们不写**（用户 2026-11-24 裁定）。#53 建议把已达标条目与「owner 裁定不做」的判据在台账里标注出来，这同样留给测试者。
4. `.cafe` 已移出版本库并加入 `.gitignore`（本地文件保留）。其他 clone 拉到那次提交时，git 会删掉它们工作区里的 `.cafe`，需从上一提交恢复（`git show <移出前的提交>:.cafe > .cafe`）。

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
| `docs/spec.md` | 唯一规格。第八轮改了 §6（E124、W212 口径）、§7（`--if-unchanged` / `snapshot`、`new` 重复摘要拒绝、取号算上 E124 行）、§9（读命令 `--json` 带 `snapshot`）、§10（adopt 对混合文件） |
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
issuemd reopen   FILE ID [--status S]
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

- **`src/io.ts`** —— **不要改**。原子写、快照复核、BOM/行尾/尾换行/权限位。符号链接在 CLI 层（`loadWritable`）解析成真实路径再交给 io；硬链接数也在 CLI 层 `lstat`。
- **`src/cli.ts`**：
  - `COMMANDS` 表是命令与选项的唯一来源：`run()` 用它拒绝越界选项、生成全局与 `<cmd> --help`。新增命令/选项要同时进 `COMMANDS`、`OPTION_HELP`、`OPTIONS`。`OPTION_HELP` 文案里别写别的命令专属的选项名（`close --help` 有用例断言不出现 `--json`）。
  - 写命令共享 `commit()`：`terminate()` → `joinDocument` → `checkLedger` → **按 multiset 只拒新 error** → `--dry-run` 出 diff（stderr 带 snapshot）/ `writeAtomically(loaded.path, …)`（E130 → exit 4）。成功后若有其他硬链接，stderr 追加提示。
  - `Loaded = { doc, lines, path, links, snapshot }`。**`--if-unchanged` 在 `loadWritable(file, expected)` 里、刚读完文件时比对**，所以任何命令逻辑（「已关闭」之类）之前就 exit 4。所有写命令经 `openLedger(file, v["if-unchanged"])` 或（adopt）直接 `loadWritable(file, v["if-unchanged"])` 读文件；新写命令必须照做。
  - `snapshotOf(text)` = sha256 前 16 位十六进制。写路径对 `joinDocument(lines, doc)`、读路径对 `readFileSync(file, "utf8")` 求值；两者对合法 UTF-8 文件逐字节相同（BOM、CRLF、无尾换行都保留）。`run()` 校验格式（16 位小写十六进制），不对就 exit 2。
  - 插入正文块用 `insertBlock`（两侧恰好一个空行）；`close --keep-body` 的归档插入仍是 `insertLines` + 手动前导空行——`reopen` 的逐字节还原依赖它，别改成 insertBlock。
  - `cmdClose` 的判据规则：`--criteria` > `--no-criteria` > `--criteria-from-body`（空则拒）> 正文自动提升 > `--keep-body` 允许空 > 否则 exit 2。
  - `cmdNew`：先查重复摘要（只比开放行，`summaryKey` 归一），再取号；成功后 stdout 是编号（只在非 dry-run 时替换 `commit()` 的空 stdout）。`cmdRename` 同样查重复摘要（排除自己那一行；目标是已关闭项时不查）。
  - `titleProblem()` = 计数后缀（E121）+ 结尾 `#`；`new`/`rename` 用于输入，`reopen` 用于已关闭行的旧摘要。
  - `readOnlyRefusal()` 在 `commit()` 与 adopt 的写入前各调一次（`accessSync W_OK`）。
  - `missingIssue(verb, id)` / `badIdText()`：写命令的「没有这条」走 stderr；`show` 仍用 stdout 的 `(no such issue: N)`。
  - `readBodyFile` 剥 BOM 与开头空行，拒绝 fence 外的 `KEPT_BODY_END`。reopen 的归档恢复只剥「结束标记所在那一行」与「第一条非空行若是 ARCHIVE_NOTE」。
- **`src/ledger-edit.ts`**：
  - `escapeCell` / `unescapeCell`：竖线前反斜杠为奇数才算已转义，与 `ledger.ts` 的 `splitCells` 读法一致。标题输入用 `unescapeCell` 归一，别再写 `.replace(/\\\|/g, "|")`。
  - `extractCriteria()` 合并所有非空 `**验收判据**` 块（去重，`；` 连接）；close 提升与 `show --json criteria` 都走它。
  - `labelBlock()` 是唯一的标签解析：从 `**标签**` 行到下一个标签行或标题；空行、列表、fence 内容都属于它。`findLabel`、`extractCriteria`、`show --json labels` 都走它。
  - 归档格式常量：`archiveHeading()`、`ARCHIVE_HEADING`、`ARCHIVE_NOTE`、`KEPT_BODY_END`。close / adopt / reopen / rename / check 共用，改格式只改这里，并跑 `keep-body round trip`。
  - `ledger-edit` 与 `ledger-check` 互相 import（只在函数里用对方，模块初始化时不能用）。
- **`src/ledger.ts`**：
  - `parseLedger` 的 `unreadable: UnreadableRow[]`：E108/E109 丢掉的表行，**以及 E124 的「游离行」**（`table: "stray"`）。下游（`maxIssueId`、`new --id` 撞号、`show` exit 3、`unreadableNote`、`list --json unreadableRows`）都靠它，所以 E124 行自动被保留编号。
  - `strayRows()`（#52）：所在 H2 不是 `怎么用/状态口径/索引/已关闭/正文/附录`（括注去掉后比较），且 (a) 有表头、表头含 `#/编号/ID` 列与 `摘要/标题` 列；或 (b) 表头含 id 列与 `状态` 但无摘要列，且 H2 名匹配 `isTableSection`；或 (c) 无表头、宽 2–5、H2 名匹配 `isTableSection`。**口径必须与 adopt 迁移哪些表保持一致**：adopt 不迁移、原样保留的表若被报 E124，adopt 的输出就过不了自身校验（第八轮复审 #1）。每个能解析出编号的行报一条 E124。H1 与第一个 H2 之间的表不算。
  - `isTableSection`（台账表小节名正则）现在定义在这里，adopt 从这里 import。
- **`src/ledger-check.ts`**：`PRIORITIES`、`summaryKey`（W212 的 NFKC/大小写/空白折叠）；`checkHashes` 区分 pinned（W202）与仅校验（判据列，给 W240 用）；`checkAppendix` 出 W250/W251/W252/W253。`--strict` 仍只豁免 W250。
- **`src/ledger-read.ts`**：`ListedIssue` 带 `ids`/`count`；`expandIssues`（上限 10 万）；`viewIssue` 带 `labels`、`criteriaSource`。
- **`src/adopt.ts`**（改前读完它）：
  - 开头：输入 `check` 0 error 且无 W220 → 原样返回。E124 是 error，所以「规范骨架 + 旧表」的混合文件会走完整转换。
  - `layoutLines`：被消费的表块的表头/分隔行，**加上表格小节里只有表头+分隔行的空表**（#52：混合文件里规范表是空的，以前会被当成说明文字复制进附录）。
  - `Row` 有 `criteria`（真判据）与 `extras`（附加列、溢出格、`原状态：X`）两个字段，**不要再把 extras 拼进 criteria**：开放项 extras 进 `**原表格判据**`，已关闭行在输出表时才拼成「判据；附加列」。`Row.overflow` 记溢出格数，`rawStatus` 记去格式前的状态格。
  - 开放正文组装：每个开放行按 `parseIds` 逐号生成 `bodyEntries`（已有正文或骨架），最后全体 `compareIds` 排序再展开；索引表行仍用 `sortedOpen`。
  - `movedBodyLines`：被搬进正文/归档的 `### Issue N:` 块，在 H1 说明与外来小节的逐字副本里跳过。
  - 列映射 `mappingFor`、状态优先级、保留规则、**守恒守卫**（逐行文本 + 编号集合）同前：新增任何「重建」逻辑时，要么把行复制到输出，要么把它加进 `regenerated`（= `rowLines` ∪ `layoutLines`）。
- **`src/write.ts`**：Myers 行级 diff + 3 行上下文多 hunk。
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

## 已完成的审查与验证

- 回归用例：`src/dogfood.test.ts`（按 dogfooding 编号分组；第九轮自测的用例以 `probe:` 开头，在文件末尾）、`src/ledger-verbs.test.ts`、`src/write.test.ts`、`tests/bin.test.ts`（bin 执行位、FIFO 驱动的真实并发 → exit 4、打包 manifest）。
- 第八轮手工验证：`npm test` 前后 `dist/` 与 `dist/bin/issuemd.js` 的 inode + mtime 不变；故意制造类型错误时 `npm test` exit 1 且 `.dist-test` 不含残留；`npm pack --dry-run` 不含 `.dist-test`。
- 第八轮末尾派了独立 subagent 复审本轮 diff，结论见最后一节「第八轮复审」。

## 仍然接受的已知项

- 原子替换 `lstat`→`rename` 的极小竞态窗口。
- 读命令把非法 UTF-8 解码成 U+FFFD（只影响输出；这类文件写命令本来就拒绝，所以 snapshot 不一致无影响）。
- W202 不把 7–39 位纯数字当 hash（会漏掉约 3.7% 的纯数字短 hash）。
- `adopt` 对已经保留进附录的外来小节重跑时会再报 `foreign-section`。
- adopt 宽度 2 的 `| # | 说明 |` 把「说明」当摘要；需要更好摘要时人工 `rename`。
- `build` 换入时两次 rename 之间有微秒级窗口没有目标目录。
- 没有锁文件 / 排队：并发冲突只靠 E130 / `--if-unchanged` + exit 4 + 调用方重试。
- 附录以空行结尾时，`close --keep-body` 的归档前会多一个空行（改它会破坏 close+reopen 逐字节还原）。
- adopt 守恒守卫的局限：同号的两个正文块会被拒；以「文本集合」比对，测不出「丢了一行、但同样文字别处还有」。
- diff 超过 2000 步编辑时退化为一整块 -/+（正确但粗）。
- E124 的无表头判定沿用 adopt 的 `isTableSection` 正则（含 `open`/`issues?`），像 `## Open questions` 下的「首格是数字、宽 2–5、无表头」的管道块会被报——真实台账里没有出现过；需要时把正则收紧，并同步看 adopt。
- `reopen` 不查重复摘要（重开的摘要与某开放项同名时只有 `check` 的 W212 兜底）。
- `close --keep-body` 在没有 `## 附录` 的台账上会新建附录；`reopen` 不删它（不知道附录是不是 close 建的），往返后多出 `## 附录`。
- reopen / body 会把原文里「正文块前缺空行」「正文末尾多个空行」规范成恰好一个空行（只改空白）。
- CRLF 台账的 dry-run diff 不带 `\r`，不能直接喂给 `patch`（只是预览）。
- adopt 转换失败时，对重建的表行 error 只能给 `source line unknown (converted L…)`。
- W253 只扫 `## 附录` 内；旧版 adopt 留在附录之后外来 H2 里的转义正文副本不报（第九轮起 adopt 不再产生）。
- 英文表头（`| ID | Status | Title |`）adopt 不认，整表进附录（`foreign-section`，有报告）。
- 结构已坏的台账（E103/E112）上 `check` 头部的分状态计数可能对不上总数。
- 游离行（E124）首格解析不出编号时整行不报（无法判断它是 issue）；`new` 的重复摘要检查只看规范开放表，不看游离行——有 E124 的台账本来就该先 `adopt`。

## 还没做 / 仅供参考

- spec §14 的 Q2（`adopt --prefer` 信息丢失）与 Q5（第二套状态词）：用户明确不做，需要时先 brainstorming。
- #46 的独立 `adopt --verify=<原文件>` 与 `check` 的「附录重复段落」warning：未做。
- #18 的锁文件与写命令 `--json`：未做。

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
