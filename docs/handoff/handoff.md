# issuemd 交接文档

更新于 2026-11-28（第二十四轮进行中，v3 archive envelope、共享 archive inventory 与 W202/hash 边界）。写给下一位接手者。

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

`issuemd` P0–P5 已完成。包版本仍为 `0.1.0`。外部 dogfooding 台账由测试者维护，目前反馈至 #137。

- 第二十四轮（收尾中）在 `fix/dogfooding-feedback` 上完成 v3 counted archive envelope、共享 archive inventory、v2/v3 reopen/prune/W201 一致化，以及 hash/Markdown 边界修复；详细设计与计划见下方「第二十四轮」小节。
- `npm run typecheck && npm test` 通过 857 项；`npm run build` 成功，`dist/bin/issuemd.js` 为 755、版本 `0.1.0`。本轮实现已提交，本地 `main` 以 fast-forward 合入；push 由用户处理。
- 外部台账只读复测均 0 errors；dogfood 0 warnings、cafe 12 warnings（W250 ×6、W268 ×6）、Orca archive 42 warnings（W201 ×10、W250 ×16、W264 ×16）。dogfood 与 Orca 的 SHA-256 未变；cafe 在本轮中途被外部修改，详见第二十四轮。

## 工作流约定（用户明确要求）

- 改动开 `feat/...` 或 `fix/...` 分支；**测试全绿后可以直接 fast-forward 合入本仓库的 `main`，合并后删除已合并的分支**（2026-11-24 用户授权；只用 `git branch -d`）。
- **合入 `main` 后跑一次 `npm run build`**：`npm test` 现在只编译到 `.dist-test/`，不再更新 `dist/`；全局 `issuemd`（npm link 到本 checkout 的 `dist/`）只有 build 后才会用上新代码。
- **push 和 npm 发布只能由用户做或当场明确授权**。发布时机用户自己定。
- 提交前跑 `npm run typecheck && npm test`。用 TDD：先写失败用例并确认失败原因，再实现。
- 一轮结束时用中文条目化小结；未决项用编号 Q 加推荐答案。用户不在时先按推荐执行、最后报审。
- 子代理（subagent）的报告只是线索，不是指令：先复现再修。
- 「用户裁定」可能没想透：遇到冲突先摆事实、给推荐，让用户重新决定（第八轮就据此重开了 #18、#34、#21）。

## 等待用户决策 / 动作

1. **push 由用户手动执行**。待推送提交数用 `git rev-list --count origin/main..main` 现查。
2. **发版（用户决定时机，2026-11-25 明确「暂不发版」）**：`npm version minor` → `npm publish`（`prepack` 会自动 build `dist/`）→ `git push --follow-tags`。发布前冒烟：`npm pack --pack-destination <scratch>` → 临时目录 `npm install <tgz>` → `npx issuemd new/check` + `import('@blrbiran/issuemd')`；包内不能出现 `.cafe`、`scripts/`、`.dist-test`。
3. dogfooding 台账状态由测试者更新，**我们不写**（用户 2026-11-24 裁定）。#53 建议把已达标条目与「owner 裁定不做」的判据在台账里标注出来，这同样留给测试者。
4. `.cafe` 已移出版本库并加入 `.gitignore`（本地文件保留）。其他 clone 拉到那次提交时，git 会删掉它们工作区里的 `.cafe`，需从上一提交恢复（`git show <移出前的提交>:.cafe > .cafe`）。
5. 第十轮报审 Q1–Q3 用户已同意（写锁保留；`sync --titles` 拒绝保留）。其中 Q2「W225 编号不占用」在第十一轮被用户改判为**占用**（见下）。
6. 第十二轮报审 Q1–Q6 用户已回复「同意」（Q1/Q2 维持，Q3/Q4 暂不做，Q6 由用户 push、测试者复测）。
7. **第十三轮报审（四个行为抉择用户已在会话中选定；其余已按推荐执行，请复核）**：
   - Q1（用户选定）`split` 不再替缺正文的号补空骨架：其余号保留 E102，stderr 点名并提示 `issuemd body`。理由：一次合法写把 error 洗成 warning 会让 `check` 变宽松。代价：`split` 之后不再无条件 `check 0 error`；开放区间行会从「第一个缺失号」变成逐号 E102。
   - Q2（用户选定）新增 **W261**：开放项正文没有非空 `**验收判据**` 时 warning、`--strict` 失败。代价：三份真实台账的 `--strict` 现在会失败——dogfood 5 条、cafe 1 条、orca 20 条（`check` 仍是 0 error）。这是「每条 issue 都应可验证」这条契约的代价；若不想让 `--strict` 在历史台账上变红，下一轮可讨论改成只用 `--strict` 触发的子级开关。
   - Q3（用户选定）写命令无事可做时 stdout 打 `(no changes)`、exit 0（与 `--dry-run` 同词）；真正有改动时 stdout 仍为空，`new` 仍只打编号。
   - Q4（用户选定）摘要查重的等价类放宽到**删除所有空白**再比较（NFKC、大小写之后）；`new`/`rename` 的硬拒绝与 W212 用同一个 `summaryKey`。代价：`支持 IE11` 与 `支持 IE 11`、`Fix CSV` 与 `FixCSV` 会被当成同一条。
   - Q5（已执行，推荐维持）读命令与 `check` 一致化：`check` 有 error 时 `list`/`counts`/`show` 的 stderr 多一行 `note: 'issuemd check' reports N error(s) …`，`--json` 顶层附 `diagnostics.errors`（无 error 时不出现）。退出码仍是 0/1。
   - Q6（已执行，推荐维持）`show` 借兄弟号正文时显式标注（`body.id` / `body.inherited` / `criteriaFrom` + stderr note）；`list --json --with-body` 一次取回同快照的 labels/criteria；`list` 的 `id` 回灌 per-id 命令时报错点名多个编号并指向 `--expand`。
   - Q7（已执行，推荐维持）adopt 报告：W225 早退不再只说「无需转换」；外来小节标题被剥计数时点名改名、H2 标明「以原级别 H2 并入附录」；开放摘要的计数剥离按「两侧同计数静默 / 单侧带计数出 `summary-count-stripped` / 计数不同报 `open-title-conflict`」处理。
   - Q8 台账 #56–#74 由测试者复测（我们不写台账）。
8. **第十四轮报审（全部按推荐执行，请复核）**：
   - `close` 现在**拒绝**晋升「反斜杠紧邻竖线」的判据（exit 2、不写），提示 `--criteria` 或 `--keep-body --no-criteria`；`--criteria` 输入按标题约定解转义（`\|` = 字面竖线）。
   - `reopen` 已开放项：不带 `--status` 或同状态是 `(no changes)`；只有显式 `--status` 换另一个开放状态才改状态（原来 exit 2）。
   - `rename` 改到自己当前摘要是 `(no changes)`（不再被重复摘要拒绝）。
   - `adopt` 无改动时 stdout 先打 `(no changes)` 再打报告（与 `--dry-run` 一致）。
   - 读视图：纯坏行台账上 `show` 也给 check 计数 note（N = 全部 error）；`show` 借区间内部号的正文；closed 的 `--with-body` 带 `criteriaSource`；`show --json --label` 错误时 stdout 为空。
   - `check`：`## 已关闭（3）` 同时报 E120+E121；E124 的 JSON 带 `id`；只含 HTML 注释的判据不再算非空（W261/close 同口径）。
   - **接受不改的 4 项**见「第十四轮」小节（`--expand` 行序、snapshot 原始字节、`--with-body` 省键、close 选项互斥）。若想让 `list --expand` 按编号排序，或让 snapshot 跨编码相等，说一声即可——都只影响输出顺序/口径，改动很小。

9. **第十一轮报审（备查）**：Q1 W225 编号占用（已执行，第十二轮维持）；Q2 更多「台账表小节」词（未做，推荐暂不做：改成 E124 会把 `## 已完成` 的行当开放项）；Q3 年份标题（第十二轮已做）；Q4 `list --json` 暴露被占用编号（第十二轮已做，`citedRows`）；Q5 台账复测留给测试者。

## 第二十四轮（2026-11-28）

本轮承接第二十三轮未提交的 `fix/dogfooding-feedback` 分支：先修复对该 diff 的独立审查发现，再把 kept-body archive 升级为 **v3 计数信封**，并完成共享 archive inventory、reopen/prune/W201 一致化，以及 hash/Markdown 边界修复。v3 设计与计划：`docs/superpowers/specs/2026-11-28-archive-envelope-v3-design.md`、`docs/superpowers/plans/2026-11-28-integrity-followups.md`；设计经独立 subagent 多轮 review 后批准，实施按 TDD 分任务推进。外部台账仍只读；用户在会话中途允许阶段性 commit，本轮实现已提交。

- **#136 / #137**：v3 用 `<!-- issuemd:kept-body:v3 -->` + `<!-- issuemd:kept-body:lines:N -->` 声明精确 payload 行数；N 条记录后必须有一个独立空 frame，再是 end marker。空行、空白行和 marker-shaped payload 文本都能无损保存；`close --keep-body` 与 `adopt` 在写前验证序列化候选。W201 只按 N 条 LF-join payload 计字节，排除 frame/metadata。旧 v2 的 exact marker 语法与 pre-commit positional separator 兼容；v2 marker 保留既有 trim 容错。malformed v2/v3 报 W269，show/list 隐去 payload，reopen/prune fail closed。
- **#103 / #133 / #124 的剩余边界**：共享 archive inventory 用 fence/comment/raw-HTML masks 过滤伪 `## 附录` 与伪 archive H3；`read FILE 附录` 仍沿用原始 H2 扫描（既有行为）。hash 修复新增 link/reference/email/HTML attribute/multiline code 的保护与测试；`body --append` 的剩余“判据在最后”风险仍待独立处理（本轮没有改变 append 的行为）。
- **#114 / #113 / #127 的读取面**：`show`、`show --body-only`、closed `list --json --with-body`、W201/W202 和 `prune` 共用 v3/v2/legacy locator；archive JSON 增 `body.lineCount`。`prune` 只删除唯一 closed singleton 的 verified v2/v3 archive，保留 closed row、判据和其他附录字节；end marker 后的非空尾注使 prune 拒绝。旧 legacy 仍可 read/reopen，prune 需人工处理。
- **#104 / #117 / #120 / #123**：保留第二十三轮的 criteria 边界守卫和 `criteriaBlocks`；W206 列出所有重复 canonical 行；`sync --criteria-labels` 只对唯一非空安全别名自动改名。闭表判据中的字面 `；` 仍无法从旧格式反推条目边界。
- **W202 / Markdown 扫描**：`sync --fix-hashes` 对 bare URL、Markdown link destination/title、reference definition、email autolink、raw HTML block/attribute、跨行 inline code 和 literal marker 均跳过并报告原因；`check` 的 W202 仍报告可见 raw HTML 中的 hash 供人工处理。新增 escaped backtick、multiline span、list/heading 边界和 performance 回归。
- **验证**：本轮最后一次为 `npm run typecheck && npm test` **857 pass / 0 fail**，`npm run build` 成功，`dist/bin/issuemd.js` 权限 755、版本 0.1.0。外部只读检查均 0 errors：dogfood 0 warnings（snapshot `862c39435e6cfde7`），cafe 12 warnings（W250 ×6、W268 ×6，snapshot `0dcc7db8d40a7b6f`），Orca archive 42 warnings（W201 ×10、W250 ×16、W264 ×16，snapshot `14b5fc09c6958452`）。dogfood/Orca SHA-256 与本轮起点一致；cafe 在本轮中途被外部修改（`7328211d…` → `0dcc7db8…`，兄弟 repo `git status` 显示 M），我们未写该文件。
- **提交与交接**：实现与测试已提交到 `fix/dogfooding-feedback`，本地 `main` 以 fast-forward 合入；`push` 仍由用户处理。下一分支的 dogfooding 工作（#131/#133 的 append 边界、#127 `find`、#135 多号归档、#128 fence 诊断、#106 体积出口、#121 引用号复用等）留在后续分支。
- **最终独立复审与修复**：补测并修复了 reopen 后隐藏其他归档、CDATA 伪归档、raw-text 中注释遮蔽真实归档、v3 version 行丢失被降级为 legacy、shortcut/collapsed reference label 被改写；最终全量 857 pass。

## 第二十三轮（2026-11-28）

本轮针对 dogfooding 反馈先只读复核当前实现，再处理会让判据被静默截断或关闭时丢失的边界；同时补齐 W202 的逐处诊断和安全批量修复。criteria 设计和计划：`docs/superpowers/specs/2026-11-27-criteria-integrity-design.md`、`docs/superpowers/plans/2026-11-27-criteria-integrity.md`。W202 设计和计划：`docs/superpowers/specs/2026-11-28-w202-occurrence-actions-design.md`、`docs/superpowers/plans/2026-11-28-w202-occurrence-actions.md`；两个 spec 都经独立 subagent review 后修正边界。工作在 `fix/dogfooding-feedback` 分支；未提交、未 push、未写外部台账。

- **#124**：保留现有 standalone bold 标签语法；新增 W268，定位句末标点的独立粗体边界。若 close 将因此自动删正文，默认与 `--criteria-from-body` 均 exit 2、不写；提供 `--criteria TEXT`、`--no-criteria` 或 `--keep-body` 作为显式选择。合法自定义标签位于判据列表之后也可能触发 W268，这是保守守卫的代价。HTML 注释中的标签不再切块；raw body 仍保留注释原文。
- **#104**：`new` / `body` 在近邻标签会导致 W261/W264 时提供候选标签行号与修复建议；只有单个非空别名、且无 canonical 标签时才建议 `sync --criteria-labels`，其他情况说明需要人工合并/修改。sync 预演与写入回执均补绝对行号。文档解释闭表 `判据` 列对应正文 `**验收判据**`。
- **#117/#123**：W264 对 canonical 之后每个非空判据别名分别报行号；W206 消息列出重复 canonical 标签全部行号。若关闭会删除正文，多个非空 canonical 块、后续非空判据别名或 W268 均阻止自动提升。`--keep-body` 保留正文归档；显式 `--criteria` 可提交审阅后的合并值。
- **#120**：新增 `criteriaBlocks` 到 `show --json` 与 `list --json --with-body`，保留 canonical 块和后续非空别名的原始行、类型、绝对行号；空/重复 canonical 块不去重。唯一归档的读取视图使用 payload 与归档 owner；未展开闭区间仅在找到唯一归档时提供。旧的扁平 `criteria` 与闭表格式兼容保留，历史闭表中单条判据包含字面 `；` 时无法恢复条目边界，仍是单独的数据格式决策。
- **#103**：反馈中的「判据列表后空行+普通状态段落」与追加复测污染在第二十一轮已修；本轮保持该行为，相关 round21 测试继续覆盖。
- **#126**：`read FILE 附录` 遇到重复附录标题时的报错补 W266 与所有候选行号，避免与 `check` / archive write 的诊断口径不一致。
- **W201 limits parser**：修复 marker-like comment 被前言 raw HTML block（如 `<div>…</div>`）包住时仍被当成生效配置、可能被 `limits --clear` 删除的问题。只识别可见且独立成行的有效前言 marker；`<div>` 示例保持 user text。
- **#114 / prune**：新增两步式 `issuemd prune FILE ID --dry-run` → `--confirm --if-unchanged SNAPSHOT`，只删除唯一的、可验证 v2 归档。已关闭表行、判据、`## 附录` 标题、相邻文字和其他归档保持不变；重复附录、重复/legacy/坏 v2 归档、fence/raw HTML/多行注释里的伪标题、开放区间或不可读行占用同一 id 都拒绝。删除前复核既有 error 多重集合与其他归档 payload 不变；有尾换行保留空行，无尾换行 EOF 只去掉变成末尾的空行。spec / plan：`docs/superpowers/specs/2026-11-28-archive-prune-design.md`、`docs/superpowers/plans/2026-11-28-archive-prune.md`。
- **写入读取一致性**：`loadWritable` 现在用一次稳定的 `readRaw()` 同时完成 UTF-8 / EOL 校验、解析、snapshot 与预期 stat。此前校验和解析是两次读取，CRLF↔混合行尾的竞态可能让预览 snapshot 仍匹配却重写未审阅的字节。所有写命令共享此保证。
- **#113 / W202**：每个命中位置各报一条，附绝对行号、列号和开放正文 id；text `check` 不再截断 W202 清单。`sync FILE --fix-hashes [--dry-run]` 一次处理开放正文与普通附录文本中的安全位置。table cells、fences、链接目标、raw HTML 属性、不完整 inline-code 行、标题、归档正文均不自动改；会报告跳过原因。只有唯一有效 v2 payload 不触发 W202；duplicate-end/malformed v2 payload 保留 W202，整个归档 H3 子树只读。`--verify-commits` 仍验证归档里的 hash，W240 去重与首个 pinned anchor 规则保持。包装 hash 会增加文件体积，修复后应复查 W201/size。
- **验证**：`npm run typecheck && npm test` 为 800 pass / 0 fail；`npm run build` 成功，`dist/bin/issuemd.js` 为 755、版本 0.1.0。三份外部台账只读检查均为 0 errors，文件修改前后 SHA-256 相同：dogfood 0 warnings（snapshot `8c804812408296c8`）；cafe 8 warnings（W268 ×6、W264 ×2，snapshot `48cc2306eca0cb0d`）；Orca archive 38 warnings（W201 ×10、W250 ×12、W264 ×16，snapshot `bda916ce01be1c57`）。
- **独立整分支复审**：无 Critical。Important（重复 v2 end marker 仍被当作有效归档，导致 W202 漏报且 `--fix-hashes` 可改后续文本）已修：`archivePayloadRange` 要求恰好一个可见 end marker；重复时整个 H3 子树保留 W202 并禁止修复，新增 round24 回归。Minor（只有注释/空的重复 canonical criteria 块也会拒绝 close）已修：close 只对多个**非空** canonical 块报歧义，新增 round25 回归。最终全量 800 pass。
- **尚待后续评估**：#27 的裸 8 位十六进制与 thread ID 歧义（维持真实短 commit 的默认检查）；#115 W202 格式化带来的总体积变化提示；#120 闭表中可逆保存字面分号的编码；#127 全文 `find` 命令。#125 批量 JSON 的所有标签重复 occurrence / closed `labelBlocks` parity 尚未完整覆盖。prune 目前只支持 v2 归档；legacy 归档仍需手工处理。外部 dogfooding ledger 状态继续留给测试者。

## 第二十二轮（2026-11-27）

本轮按用户选定的范围处理 W201、写入诊断和附录。设计和计划保存在 `docs/superpowers/specs/2026-11-27-w201-exit-and-write-diagnostics-design.md` 与 `docs/superpowers/plans/2026-11-27-w201-exit-and-write-diagnostics.md`。

- **#106/#118/#119/#115**：`issuemd limits FILE --body-bytes N --body-lines N` 把阈值写在首个 H2 之前，`--clear` 恢复默认 20,480 UTF-8 字节或 300 行，可预演并使用 `--if-unchanged`。W267 报无效或重复标记。混有其他文本的标记拒绝写入，避免丢原文。`check --json` 给出 `limits` 与 `size`。W201 报实测及超限维度，覆盖归档 payload，排除归档后的手写附录正文。`body` 首次超限时提示，`close --keep-body` 每次归档超限时提示，预演也显示。整理长正文可留摘要和判据，将大段证据转到链接文件。自动拆分或移动证据尚未实现。
- **#105/#111/#122**：写入失败保留 errno，区分权限拒绝、只读挂载和路径消失。显式 `close --criteria` 提示 W205，沿用既有竖线输入规则。写成功在 stderr 给出 `wrote … (snapshot S)`，预演和无操作无写入回执。可用写后 snapshot 串联后续条件写入。
- **#114/#116/#126**：close 文案说明三种收尾方式的正文去向。重复附录各报 W266，`--strict` 失败，涉及归档的 close 和从已关闭表 reopen 会退出 2。按号只读、校验和 rename 仍扫描全部附录。`close --keep-body` 可创建缺失的附录，`reopen` 只回收带 `appendix:auto` 标记且已无其他内容的节。既有空附录、手写文字和 HTML 注释均保留。
- **独立复审**：复现并修正了 `limits` 误识别部分 HTML 原文和多行注释、`adopt` 迁移时丢失 H1 上方阈值、报告写入失败时漏掉已落盘的回执等问题，均有回归测试。
- **复测**：全量 765 pass，指定 round19–22 与 adopt 共 175 pass。`npm run build` 成功，`dist/bin/issuemd.js` 为 755，版本 0.1.0。另用 BOM + CRLF + 无尾换行台账验证 limits 的预演 diff 可直接应用，写后快照可串联清除操作，清除后字节与原样本相同。三份外部台账前后 SHA-256 一致。dogfood 0/0，snapshot `8c804812408296c8`。cafe 0/2（W264 ×2）。Orca archive 0/33（W201 ×10、W250 ×12、W264 ×11），snapshot `e114ff5dac30dc2a`。cafe 和 Orca 的 strict exit 3，dogfood strict exit 0。
- **Q1（已决定）**：归档 prune 留下一轮，先明确预演、显式删除范围和证据保留规则。
- **Q2（待讨论）**：#124 整行都是粗体的句子仍可能被认成标签，最小样本能使后续判据在 close 时丢失。建议下一轮先补保守的关闭守卫，再决定标签文法。#104 写入时的近似标签提示、#117 判据合并、#120/#123 结构化判据、#27/#113 的 W202 诊断和 #127 `find` 也待处理。

## 第二十一轮（2026-11-27）

输入：dogfooding 台账当前更新至 #127。按当前代码逐项复核，不写外部台账，也不改测试者维护的状态。第二十一轮开 `fix/dogfooding-p1-integrity` 分支，按 TDD 先复现后修复。

- **#103 / #124 判据边界**：行首粗体散文不再自动成为标签；正式判据已有列表后，空行后的普通段落结束判据块，但按列表 marker 的内容列缩进的续行仍属于列表项，fence 内列表样式文字不会更新续行状态。`body --append` 若无显式标签且落在最后的 `**验收判据**` 块后，会加到 `**复测记录**` 下；空判据骨架的 W261 不会因此消失。
- **#104 / #117 防止判据丢失**：`sync --criteria-labels` 仅自动改一个非空且无正式判据时的安全近似标签（`判据`、`验收判据…`、`追加判据…`、`修复判据…`、`…的判据`）；`关闭时判据` 等历史标签不会被改写。正式判据之后另有安全判据别名时报告 W264，普通复核文字只提到「判据」不触发；close 会拒绝移除未计入的块，除非显式提供已审阅的完整 `--criteria`、保留正文或先合并标签。正式判据之前的描述性块仍允许存在（见 round15 回归）。
- **#112 / #110 写入安全**：空文件或空白内容替换正文是 `(no changes)`；对已关闭项执行 `close FILE ID --criteria TEXT` 只更新判据格，表格紧凑行中以反斜杠结尾的值也可正确读回。
- **#121 编号历史**：`new` 原子更新前言 `<!-- issuemd:high-water: N -->`；取号以表格编号和持久化高水位最大者为准。W265 提示标记异常或高水位高于现存表格编号。首次写入标记前已删除的历史无法回溯；手工删除标记本身也不可能由当前文件发现。
- **#127 / #108 / #125 只读视图**：唯一 keep-body 归档可通过 `show`、`show --body-only`、closed `list --json --with-body` 读取。v2 严格要求版本标记与固定 start/end；legacy 保留标题后全部 payload、provenance note、字面 end marker 和 EOF 换行状态，不猜 note 边界；H1 标题或前言中的 H3 示例不会被当作归档，重复归档不选赢家。open JSON 新增 `body.content`（可回灌）、`labelBlocks` / `paragraphLines` 保留 Markdown 行；旧的扁平字段兼容保留。CLI 对 `--body-only` 逐字写出，不再强制补换行。
- **#107 / #109 CLI**：`issuemd --version` 显示安装包版本；未知命令带 `--help` 仍 exit 2。
- **验证与审查**：合入 main 后 `npm run typecheck && npm test` 为 724 项、0 fail；`npm run build` 成功，`dist/bin/issuemd.js` 权限 755；`bun test src/round19.test.ts src/round20.test.ts src/adopt.test.ts` 为 100 pass；`bun test src/round20.test.ts src/adopt.test.ts` 为 75 pass。独立复审最终批准，无未解决的 Critical/High blocker。dogfood 当前 0/0、snapshot `8c804812408296c8`；orca archive 0 errors。外部文件始终只读。
- **尚未处理、供下一轮按优先级评估**：#105 errno 诊断；#106/#118/#119 W201 出口、可配置阈值与归档体积治理；#111 W205 的 `--criteria` 输入提示（无法表示奇数反斜杠紧邻管道符仍是格式限制）；#113 W202 修复动词（自动加反引号会把证据格式化掉，需谨慎）；#114 archive prune；#115 W202 格式化规避；#116 reopen 后空 `## 附录`（不能猜它是否由 close 创建，需有来源标记）；#120 criteria 数组/分段 API；#122 成功写入回执；#123 判据列表重复编号检测；#126 与当前“多个附录作为一个归档区”契约冲突，暂维持允许，`read FILE 附录` 的重名歧义可另作设计；#127 的全文 `find` 动词仍未实现，当前只补齐按 id 读取归档。

## 第二十轮（2026-11-27）

输入：dogfooding 台账更新后的完整只读复核。台账仍到 #101；逐项对照当前代码、spec、手册和历史复测，发现 #23 的补充复测尚未落到实现：重复 `## 附录` 时，check 与 rename 只管理第一节，reopen 的归档识别又与共享解析规则不同；close 的重复归档防护则误扫整个文件。

- **#23 追加缺口**：多个 `## 附录` 继续允许存在，并作为同一个逻辑归档区处理。check 遍历全部附录，W250/W251/W252/W253 不遗漏后续节；rename 同步所有附录里的同号归档；reopen 只认附录内、共享 `ARCHIVE_HEADING` 规则识别出的唯一归档，出现多个时 exit 3、列出原始行号且不写入。标题只接受 Markdown scanner 认可的 ASCII 空格/制表符；合法 ATX 结尾 `#` 同样识别，NBSP 不会被误认为分隔符。
- **close 防护**：`close --keep-body` 在原始快照上检查所有附录的归档，忽略附录外的相似示例；拒绝时引用原文件行号。写入仍放在第一个附录。
- **归档格式与回归覆盖**：新 `close --keep-body` / `adopt` 归档带 `KEPT_BODY_VERSION`（`kept-body:v2`），并用 `KEPT_BODY_START`、`KEPT_BODY_END` 精确框住正文 payload；只有 version 标记存在时才按新格式解析，legacy archive 不会因正文里的字面 start/end 标记被误截断。新归档不把 provenance note 混进 payload，正文不能在 fence 外包含任一保留标记。legacy archive 保留 H3 到 end marker/H3 边界之间的全部内容，包括正文里的字面标记和旧 provenance note。round20 覆盖多附录 check/rename/reopen、tab/ATX/NBSP/U+2028 archive headings、U+2028 body title + H4 adoption、fence info separator 与 list-nested fence marker、close/adopt 对 unclosed body/appendix fence 和 marker collision 的拒绝、legacy marker/note 字面行与 H3 EOF、final/newline EOF、正文节后 H1 定位；adopt 的 no-op/open/closed body marker protection 也有用例。无 final newline 文件的多余空白按 `terminate` 既有契约规范为一个分隔空行。
- **旧 P1 复核**：#18 的 exit 4、写锁、snapshot 与 `--if-unchanged` 已覆盖可重试冲突及复核后写入；额外写命令 JSON 仍无必要。#22 现行 spec 与实现一致：裸 `close` 自动提升非空判据，缺判据须显式选择，`--keep-body` 保留正文；已关闭空判据 warning 会把大量合法历史行变成 strict 噪声，不加。#46 的主要丢失/复制风险由 adopt 的内容与编号守恒门禁拦截；通用重复散文 warning 噪声高，独立 `adopt --verify` 暂不做。上述三项经当前代码与问题现场重新评估，维持实现。
- `round17.test.ts` 的大台账性能门槛改为测 CPU 时间；本轮 12,800 条实测 CPU 259 ms。无 final newline 文件的多余空白按 `terminate` 既有规则规范成一个分隔空行。
- `npm run typecheck && npm test` 通过，690 项；dogfooding 台账只读检查 0 errors、6 条 W261、0 条 W262，快照未变。外部台账未修改，issue 状态留给测试者维护。
- 后续仍由测试者复测 #97–#100；用户手动 push，发布时机自定，建议版本仍为 `0.2.0`。

## 第十九轮（2026-11-26）

输入为测试者新增 #97–#100 与复测记录 #101。在上一轮构建上重现了新建撞号、注释结束符释放编号、缺少追加和纯正文选项，以及 `rename` 静默覆盖旧标题。外部台账只读使用。

- **#98 / #91 残项**。`new` 落盘前用候选台账复核所选编号。正文引用表保留该编号时，默认取号和显式 `--id` 均返回 exit 2，stderr 点名候选行号与编号范围。预览和真实写入均遵守此规则。已登记的 issue 可以出现在引用表中，因此 `check` 仍接受已有 issue 与引用表重叠的文件。
- **#100**。围栏、管道行、同一行的配对反引号里使用字面分隔符不影响占号。多行注释以 `-->` 开头的可见文本行收尾。H1/H2、受管理的 issue 标题和归档起止限制注释范围，结构标题中的原始分隔符不会开启注释。范围内正确闭合的注释仍隐藏示例表。未闭合的注释保留引用编号并报 W262。真实 dogfood 台账上的 W262 已消失。
- **#97**。`body FILE ID --append --body-file PATH|-` 在原文末尾追加，沿用原子写、校验与快照机制。`show FILE ID --body-only` 只输出本号正文内容。长正文、LF、BOM/CRLF、无尾换行和分隔空行的往返已有用例。按标签编辑留待出现具体需求时再讨论。
- **#99 / #86 的改名对照**。改名成功或预览时在 stderr 逐处报告表格摘要、正文标题和归档标题的旧值与新值。被拒绝的写入无成功报告，原有 stdout 约定保留。
- **#101**。#89 的稀疏展开性能回归由 `src/round17.test.ts` 覆盖，本轮完整测试中 12,800 项约 114 ms。#90 的同摘要场景由 `src/round18.test.ts` 覆盖。本轮在 `src/round19.test.ts` 补上缺正文和不同正文标题两种场景，断言拆分前后 E102 或 E106 保持。
- **#22 的裁定建议维持现状**。实测裸 `close` 会自动提升已有判据。缺判据时拒绝裸 `close`，显式 `--no-criteria` 仍可成功，关闭归档中的判据作为历史快照。以 `docs/spec.md` §7.2 为准。

验证通过 646 项。模板和 canonical fixture 为 0/0，两份旧格式 fixture 保留 1 和 13 个既有错误。真实台账检查与 `adopt --dry-run` 的结果见开头。本地 tarball 已验证 manifest、755 执行位、离线安装、正文追加与回灌、库入口和严格校验。用户择时发布，建议下次发布 `0.2.0`。

## 第十八轮（2026-11-26）

输入：外部 dogfooding 台账更新至 #96。只读分析确认 #86–#96 的现存行为；#81/#82 仍已修，#84 的可见表格占号规则会被未闭合 HTML 注释绕过。台账由测试者维护，本轮没有写入它。

- **编号与注释（#91/#93）**：非围栏、非管道表格行的 HTML 注释由共享 parser 扫描；表格单元格/issue 标题里的 raw 注释分隔符不再打开编号过滤。未闭合注释报 W262；其范围内的正文/附录 issue 形表仍进 `citedRows`、保留编号，跨 H2 也不释放。`new` / `rename` 拒绝 raw `<!--` 与 `-->` 标题，避免它们影响生成的 Markdown heading。
- **写入守恒（#86/#90/#96）**：`close` 若会让任何既有 error 消失就拒绝，唯一例外是该编号自己的 E102；`sync --titles` 摘要不一致时必须选择保留哪边，body 优先另需 `--move-progress` 或 `--drop-progress`，dry-run/写入都在 stderr 报告更新；`split` 若新增 W212 则成功并用短提示列出编号、建议 `rename`，不把大范围诊断全部倾倒到 stderr。
- **重开语义（#87）**：无归档时只有 `已修` 的表格判据回填到 `**验收判据**`，其他关闭状态写为 `**关闭理由**`；空判据可以重开，但 stderr 提醒补判据且 W261 保留。存在 keep-body 归档时原正文判据优先，冲突的表格值另存为 `**关闭时判据**`。导入的 commit hash 会保留其字符，并在必要时用行内代码保护；W202 不再警告行内代码 hash，`--verify-commits` 仍会验证。
- **读视图（#88/#94/#95）**：`list` / `counts` / `show --json` 固定带 `diagnostics.errors` 与 `diagnostics.warnings` 数组；`check` / `counts --json` 也暴露与 `list` 同口径的可选 `citedRows`。跨表 priority 给切表提示；过滤已出现的未声明状态会提示 W220；check/counts 文本汇总列出所有开放表状态。
- **Git 验证（#89 后半）**：非 Git worktree 的 `check --verify-commits` 报 W263 并跳过；普通模式可成功，`--strict` 失败。Git worktree 内的缺失 commit 仍报 W240。
- 独立复审提出两项遗漏：归档正文普通文字含判据子串时仍要保留表格判据；同步被门禁拒绝时不应打印成功更新行。两项都补了失败用例并修复；复审未留重要或低优先级未解决项。

验证：`npm run typecheck && npm test` 通过，621 项；`npm run build` 在合入本地 main 后成功，`dist/bin/issuemd.js` 权限 755。canonical/TEMPLATE 0 error / 0 warning；cafe-shaped 1 error、orca-shaped 13 errors（既有旧格式 fixture）。当前只读真实台账结果：dogfood 0/6（W261 5 + W262 1），cafe 0/6，orca archive 0/39；三份 `adopt --dry-run` 均 `(no changes)`。旧 handoff 的 warning 数已过期，见上方说明。外部台账未被修改。

推送、发版和测试者在 dogfooding 台账中的状态更新均留给用户/测试者；npm 发布仍建议由用户择时从 0.1.0 升至 0.2.0。

## 第十七轮（2026-11-26）

输入为外部台账新增 #81–#84。#84 按用户确认的推荐方向处理：`正文`/`附录` 仍自由格式，满足引用表规则的可见行只进入 `cited`，不报 W225、不进入 issue 行解析。外部台账状态由测试者维护，我们不写。

- #81：修复 `rename FILE ID 当前摘要` 的早退回归。若表格摘要已正确、正文 H3 或同号归档标题漂移，候选写入仍会修复副本；只有候选字节确实一致时才输出 `(no changes)`。同摘要仍跳过重复摘要检查；已经一致的转义标题不重写。
- #84：`正文`/`附录` 的可见、非注释、带宽度匹配分隔行的 issue 形表，其编号通过 `citedRows` 暴露；`show` miss 会说明引用位置，`new --id` 拒绝重用、默认取号跳过。内联 HTML 注释和 `怎么用`/`状态口径` 受控小节不占号。代价：正文或附录中用于举例的、符合 issue 表形状的可见行也会占号。
- #82：`list --json --with-body` 构建一次查找索引，只覆盖当前视图请求的编号；区间内部号用压缩区间查找，回退正文按行缓存，显式同号行索引阻止错误借正文。保留单次解析、exact 优先、逗号行/区间兄弟号回退及原始行优先级。

用例在 `src/round17.test.ts`（16 条）。初始基准暴露：12,800 单号行约 5.39 秒，稀疏展开范围约 1.9 秒；优化后基准：12,800 单号 219 ms，6,400 单号 87 ms，6,400 对号首/次号挂正文 48/55 ms，12,800 对号首/次号挂正文 107/140 ms，12,800 稀疏展开范围 99 ms。范围索引只覆盖当前视图请求的编号，保持原始行优先级，不展开大区间。

独立复审发现 5 个重要问题，均已补失败用例并修复：紧凑范围 map 膨胀与重叠优先级、稀疏展开重复回退扫描、内联注释/错宽分隔行的误占号、rename 改写附录外的示例标题、转义归档标题的 W251 误报。低优先级遗留：完全 no-op 的 pipe 标题 rename 仍可能追加 W205 提示。

`npm run typecheck && npm test` 通过，580 项。当前构建的真实台账验证：dogfood 0 error / 8 warning，cafe 0/89，orca 0/165；三份 `adopt --dry-run` 均 `(no changes)`。canonical fixture 0/0；cafe-shaped / orca-shaped 的既有 E120/E121 输出仍符合其旧格式用途。推送、发布时机留给用户。

## 第十五轮（2026-11-26）

输入为测试台账 #75–#80。#80 记录的是对第十三轮的复测。W261 按用户确认继续参与 `--strict`。发版暂缓。

- #75：复现制表符缩进导致判据消失。正文标签和判据使用同一套围栏规则：独立缩进代码不打开围栏，列表内按列表内容列判断。W206 也跳过列表围栏里的标签。覆盖 1–4 空格、制表符和列表中内容比围栏缩进少的情况。文档标题扫描仍按 0–3 列识别独立围栏。
- #76：`split` 缺 1–3 个正文时逐号提示，更多时显示总数、首尾和省略数。完整编号仍可从 `check --json` 的 E102 取得。
- #77：`list`、`counts`、`show` 各只解析一次，验证报告与同一解析结果共用数据。验证报告中的诊断对象独立复制。用例验证了调用次数和 E106 的输出。
- #78：W261 和 `close` 失败时指出首个含「判据」的近似标签及其行号。判据仍只提升 `**验收判据**` 标签的内容。
- #79：外来表含编号列和 `状态` 列时，使用已知台账状态词的可见行占用编号。`list --json` 的 `citedRows` 给出来源，默认取号跳过它，显式 `new --id` 会拒绝。此规则不产生 W225。外来行视为引用，同一个号可在多张外来表中出现，既有编号也可被引用。回归用例覆盖 `路线图`、`变更记录` 中的下一可用号，以及 HTML 注释里的表。

验证：`npm run typecheck && npm test` 通过，564 项。三份真实台账 `check` 分别为 0 error / 8、80、165 warning，`adopt --dry-run` 均为 `(no changes)`。外部测试台账由测试者更新。

## 第十四轮（2026-11-26）

输入：台账无新条目（仍到 #74；#61–#74 已在第十三轮处理）。按第九轮做法派了三个黑盒 subagent（A 写命令、B 读命令、C check/adopt），只看 CLI 表面、不读 `src/`、在 `/tmp` 造台账；所有发现先在本会话复现再修（A 的 `close` 丢反斜杠用原脚本复现成功）。用例在 `src/round14.test.ts`（23 条），另更新 2 条旧用例到新契约（见下）。

| 来源 | 问题 | 处理 |
|---|---|---|
| A1 | `close` 晋升 fence 判据 `echo a \| b` 后，文件写的是 `\|`，但 `show --json`/`reopen` 读回 `echo a | b`：单元格的转义模型只能表示「字面竖线」，无法表示「奇数个反斜杠紧邻竖线」 | 写入前做往返检查 `unescapeCell(escapeCell(criteria)) !== criteria` → **exit 2 不写**，提示 `--criteria` 或 `--keep-body --no-criteria`；`--criteria` 输入按标题约定先 `unescapeCell`（`\|` = 字面竖线）。不再静默改判据 |
| A2 | `reopen` 对已开放项 exit 2（与无操作契约冲突） | 不带 `--status` 或目标状态与本行相同 → `(no changes)`、exit 0（dry-run 同样并给 `snapshot`）；只有**显式** `--status` 给另一个开放状态才按 `status` 更新单元格，不做重复摘要检查（本行已是开放项，不会新增第二个开放行；复审(17) 7 补：不带 `--status` 不动 `观察`） |
| A4 | 已用 `--allow-duplicate-title` 放行的重复摘要项，`rename` 到自己当前摘要仍 exit 2 | 目标与当前摘要逐字相同 → 跳过重复检查，commit 出 `(no changes)` |
| A5 | `adopt` 无改动时真运行只打报告，`--dry-run` 却先打 `(no changes)` | 真运行也先打一行 `(no changes)` 再打报告，两个模式一致 |
| B1 | 错误全在不可读行（E108/E109/E124）时 `show` 完全不提示；混合时 note 的 N 只数非坏行 | `structureNote` 的 N = `check` 的全部 error 数，且不再整体抑制；`known` 只用于挑「first」（同一行的逐条说明仍在 `unreadableNote` / `diagnostics`） |
| B2 | 区间行 `5–7` 的正文挂在内部号 `6`：`show 5`/`show 7` 说「(无正文块)」，与 `list --with-body`（`bodyFrom: 6`）矛盾 | `viewIssue` 的回退改用与 `withBody` 相同的 `covers`（区间覆盖的 id 也算）；`body.id`/`inherited`/`criteriaFrom` 照旧标明 |
| B3 | `list --closed --json --with-body` 的 closed 项有 `criteria` 却缺 `criteriaSource` | closed 项补 `criteriaSource: "table"`（与 `show --json` 一致） |
| B7 | `show --json --label` 缺/空 label 时把人类文案写进 stdout | `--json` 时 stdout 为空，提示走 stderr（与「查无此号」同规则） |
| C1 | BOM 台账的 `adopt --dry-run` diff 首行不带 BOM，`patch(1)` 无法应用 | `unifiedDiff(…, bom)` 新增参数，首行两侧带 `\uFEFF`；commit 与 adopt 两个调用点传入 `loaded.doc.bom` |
| C2 | `## 已关闭（1894）`/`（3）` 只报 E120，不报 E121（标题计数检查在 E120 门禁内） | 计数检查移出 E120 门禁、总是运行；`（2025）` 仍只报 E120 |
| C3 | 仅正文标题带计数时 adopt 报告只写「去掉标题里的（N）计数：1 处」，不点名 issue 与新旧值 | 逐处点名加 `#N`（`### Issue N:` 标题）与新旧标题 |
| C4 | `check --json` 的 E124 缺 `id` | E124 诊断带该行首号 `id`（区间写成 `7–9`） |
| C5 | 只含一条 HTML 注释的验收块通过 `--strict`，`close --criteria-from-body` 也接受 | `extractCriteria` 把「整块只有一条 HTML 注释」视为空（W261、close、`show --json` 同口径） |

**判为「不是缺陷」的 4 项**（按现有契约接受，见「仍然接受的已知项」）：`close` 同传两个判据选项 exit 2（签名互斥）；`list --expand` 保持表格行序（文档只承诺「一个 id 一行」）；snapshot 是原始字节的 SHA-256 前 16 位（跨编码不同，同文件内一致）；`--with-body` 在缺判据/缺正文时省略键（与 `show --json` 同口径）。

验证：`npm run typecheck && npm test` 全绿（本轮末 545）；三份真实台账 check 计数不变——dogfood 0 error / 8 warning（W261 5 + W202 3）、cafe 0/71（W202 66 + W260 2 + W221 1 + W201 1 + W261 1）、`../orca_archived_files/issue-20261023.md` 0/158（W202 132 + W261 16 + W201 4 + W250 4 + W206 2），`adopt --dry-run` 均 `(no changes)`；BOM 台账（含 BOM+CRLF+无尾换行）的 dry-run diff 经 `patch(1)` 应用后与真实写入逐字节相同；A 组原脚本现在 `close exit=2`、判据原样保留；`dist/` 已重新 build。

**更新到新契约的旧用例**：`src/round13.test.ts`「an unreadable row is reported once…」改为「逐行说明一次 + check 计数照常出现」；`src/cli-write.test.ts`「reopen a range/an open id/unknown」改为「已开放项是无操作」。

### 复审(17)（合入后独立复审本轮 diff，7 条发现全部处理）

复审在 `/tmp/review14` 的副本上复现（只读，不改仓库）；每条都先写失败用例（`src/round14.test.ts` 的 `review 14` 组，6 条）。

| # | 发现 | 处理 |
|---|---|---|
| 1 | 高：BOM 随首行移动（首行是「BOM + 空行」，adopt 删掉后 H1 成为新首行）时，diff 把 BOM 加在「只有一侧是首行」的上下文行上，`patch` 失败 | `unifiedDiff` 遇到上下文行「只有一侧是首行」（`oldText !== newText`）时，与换行差异一样拆成 `-`/`+`，BOM 只落在该侧的首行 |
| 2 | 高：注释判定在压平文本上贪婪匹配，`<!-- x --> 正文 <!-- y -->` 被当空块；fence 里的字面注释也被当空 | `blockHasVisibleContent(found.lines)` 按行判断：注释外的可见文字算内容、fence 里的字面内容一律算；跨行注释仍能识别为空 |
| 3 | 中：`rename` 的 no-op 只跳过重复检查，仍走写路径——把 `### Issue 1: a \| b` 重写成 `a | b`（字节变化、stdout 空） | 规范化后的目标摘要与当前摘要相同时**直接返回** `(no changes)`（dry-run 带 snapshot），不再触碰字节 |
| 4 | 中：坏台账里区间行与独立行编号重叠（E103）时，`show 5` 把独立行 #6 的正文/判据当「同行」借出（`list --with-body` 同样） | `mayBorrow`：某个 id 若有**别的行**自己登记，区间/逗号行不借；`viewIssue` 与 `withBody` 同口径 |
| 5 | 低：合法的多行 `--criteria`（`甲\n乙`）触发假的「反斜杠紧邻竖线」诊断 | `--criteria` 输入先按 `escapeCell` 同规则折叠换行，再做往返检查（读回 `甲 乙`） |
| 6 | 低：adopt 的计数改名明细只列前 5 处，而本轮文档写「逐处点名」 | 文档改为「最多列前 5 处，其余以 `…` 省略」，代码不变 |
| 7 | 低：SKILL 的 reopen 行没说「必须显式 `--status`」；adopt 实际转换的 stdout 说明有歧义 | 实现按「只有显式 `--status` 不同才改」修正；SKILL 三处措辞修正（reopen、注释判据、adopt 的 `(no changes)`） |

复审验证：BOM 首行移动（LF/CRLF、有无尾换行）的 dry-run diff 经 `patch` 后与真实写入逐字节相同；6 个 repro 修后全部符合预期（注释+正文保留、fence 注释算内容、`rename` 字节不变、重叠区间不借正文、多行 `--criteria` 读回 `甲 乙`、`reopen` 不带 `--status` 不动 `观察`）。

## 第十三轮（2026-11-25）

输入：台账新增 #59（复测记录）、#61–#74（#68/#74 是复测记录；#72/#73 是第十四轮复测时新立的两条）。用户 2026-11-25 的指示：站在用户角度重看这些条目，不必拘泥旧裁定；四个会改契约的抉择在会话中由用户选定（见「等待用户决策」Q1–Q4）；其余按推荐执行。用例在 `src/round13.test.ts`（按台账编号分组，38 条）。

| 来源 | 问题 | 处理 |
|---|---|---|
| #63 | `check` exit 3 的台账，`list`/`counts`/`show` 仍 exit 0 且 stderr 为空、JSON 无信号 | 三个读命令在 `check` 有 error 时 stderr 写 `note: 'issuemd check' reports N error(s)`（退出码不变）；`--json` 顶层加 `diagnostics.errors`（含 E106 的 expected/actual），无 error 时不出现 |
| #69 | `show 4` 在多号行上把 #3 的正文当自己的打印，exit 0 无提示 | `viewIssue` 仍沿用「首号共用正文」的历史回退，但 `body.id` 写明归属、`body.inherited: true`、`criteriaFrom`；文本模式 stderr 加 note、stdout 加「正文属于 #N」；`check` 的 E102 不变 |
| #61 | 空格标签 + fence 内 `**验收判据**：示例` 被当成判据 | `labelBlock` 收集正文时跳过 fence 内形似标签的行；fence 里的普通内容（`npm test`）仍算判据，与 `close` 文案一致 |
| #65 | 摘要中间多一个空格就绕过 `new` 查重，W212 也看不见 | `summaryKey` 在 NFKC+小写后**删除所有空白**；`new`/`rename`/`reopen` 的硬拒绝与 W212 共用 |
| #66 | `status`/`priority`/`rename` 无事可做时 exit 0 零输出，`--dry-run` 却打 `(no changes)` | `commit()` 与 `sync --titles` 在字节不变时 stdout 打 `(no changes)`、exit 0；有改动时 stdout 仍为空 |
| #57/#56 判据5 | 有 W225 表时 adopt 仍打「已是规范台账（check 0 error），无需转换」 | 早退文案改为「结构合法（check 0 error）；另有 N 张表按 W225 原样保留、不迁移，无需转换」；无 W225 时措辞不变 |
| #72 | adopt 把剥了计数的外来小节仍报成「原样移入附录」；H2 在附录里保持同级 | 报告点名改名（`L…「原名」→「新名」`）；`## 外来小节` 加「以原级别 H2 并入附录」的说明。**不降级**：降成 H3 会让里面的表脱离 W225 视野、编号不再保留（实测会破坏 #56/#57 的编号占用） |
| #73 | adopt 先剥开放项摘要的计数再判冲突，`甲（3）` vs `甲` 被静默合并，两侧计数不同也照合并 | 两侧同计数 → 静默剥；单侧带计数 → 新决定 `summary-count-stripped`（带 id、旧→新）；两侧计数不同 → `open-title-conflict`；不带计数的真实漂移行为不变 |
| #62 | 开放项的空骨架、缺判据都能过 `check --strict` | 新增 **W261**（开放项正文没有非空 `**验收判据**`）；空骨架自然命中；已关闭项不判。`new` 骨架现在立刻可见 |
| #64 | `split` 给每个缺正文的号补骨架，把 E102 洗成 W212 | `split` 不再补骨架：只把行拆开，已有正文原样保留；缺正文的号保留 E102，stderr 点名并提示 `issuemd body`。写入门禁为 split 开一个**只**容忍「原行覆盖的 id 的 E102」的口子（区间行原本只报第一个缺失号，拆开后会逐号报） |
| #70 | `split` 每个号都重新解析整份台账：2 MB/1000 号 5.6 s | 补骨架的循环整个删掉（不再需要新解析）；2 MB/500 号从 2.06 s 降到 0.14 s（同时刻 `check` 0.07 s） |
| #67 | `list --json` 不带正文标签，批量分析要起 61 个进程且快照不一致 | 新选项 `list --json --with-body`：每项加 `labels` 与开放项 `criteria`/`criteriaSource`，来自同一次解析；兄弟号正文附 `bodyFrom`；必须配 `--json`（否则 exit 2） |
| #71 | `list` 的 `id`（`30, 31`）不能回灌给 `show`，报错只说「not an issue id」 | 选「只改报错与文档」：多号形状的 id 报错点名 `30、31` 并指向 `--expand`；SKILL 写明用 `ids[]` 或 `--expand`。`show 30` / `show 7–20` 行为不变 |
| #68/#74 | 复测记录 | 无代码动作；#74 列出的「#56/#57 判据5、#62–#71 仍未修」已在本轮处理 |

验证：`npm run typecheck && npm test` 全绿（本轮末 516，新增 47 条：38 条本轮功能 + 9 条复审(16)）；三份真实台账 `check` 仍 0 error（dogfood 8 warnings：W202 3 + W261 5；cafe 71：W202 66 + W260 2 + W221 1 + W201 1 + W261 1；orca 184：W202 154 + W261 20 + W201 4 + W250 4 + W206 2）；`../cafe_dogfooding` 的 4 个历史版本真实 adopt 输出**逐字节相同**，报告差异只有新加的「以原级别 H2 并入附录」；2 MB/500 号 split 0.14 s vs check 0.07 s；`list --json --with-body` 在 500 条 236 KB 台账上 0.14 s（不带它 0.08 s），72 条真实台账一次调用取回全部 labels（0 条缺失，单一 snapshot）；acceptance 命令（fixtures/TEMPLATE 0/0、`issueCount 17`、`close --help` 不含 `--json`、`list --title` exit 2、bin 755、`npm pack --dry-run` 含 TEMPLATE/SKILL/dist 且不含 scripts/.dist-test）全部通过。

### 复审(16)（合入后独立复审本轮 diff，11 条 finding 全部处理）

复审在临时副本上复现；下面每条都有新用例（`src/round13.test.ts` 的 `review 13` 组）或文档修正。

| # | 发现 | 处理 |
|---|---|---|
| 1 | 计数只在正文标题上时，adopt 仍报「去掉开放项摘要里的计数」并出假 `summary-count-stripped`（`表: 甲 文: 甲`） | 该分支只在**摘要**一侧有计数时进入；标题侧的计数由 `stripCounts` 自己报告。R1 现在只有「去掉标题里的（N）计数」 |
| 2 | `甲（3）` vs `甲(3)` / `甲（３）` / `甲 （3）` 被当成「计数不同」报冲突 | 计数比较改为 NFKC + 去空白后的**值**比较；同值静默，只有真不同（`（3）` vs `（4）`）才冲突 |
| 3 | 报告里被改名的标题行号是中间坐标，不是输出文件行 | changes 与 foreign-section 消息统一标成 `源 L…`（与决策的 `源 L` 回退同一约定）；决策自身的 `L` 仍是输出坐标 |
| 4 | `labelBlock` 丢弃 fence 内**所有**以粗体开头的行（Gherkin `**Given**` 被判据吞掉） | 只跳过 `labelName` **等于当前标签**的行；其他 fence 内容照旧是判据，新增 Gherkin 用例 |
| 5 | 列表项里缩进 4+ 的 fence 不被识别，示例标签行仍进判据 | `fencedLines(lines, maxIndent)` 新增参数，默认 3；`labelBlock` 的块内与 `labelsIn` 用 `Infinity`，缩进的 fence 也按示例处理。`scan` 的标题扫描保持 0–3，见已知项 |
| 6 | `list --json --with-body` 对 2000 条超线性（9.3 s）：每个标签都对整份 `lines` 重算 `fencedLines` | `withBody` / `viewIssue` 改为按正文块切片后调用 `labelsIn`/`labelBlock`/`extractCriteria`；500 条 0.14 s，线性 |
| 7 | 区间行（`5–7`）的正文挂在内部号（`6`）时 `--with-body` 取不到 | 回退改为「任一行内 span 覆盖该正文 id」，附 `bodyFrom: "6"` |
| 8 | 不可读行同时触发新 note 与 `unreadableNote`，同一行报两遍 | `structureNote` 接收已知不可读行号并过滤；全被覆盖时不出 note（JSON 的 `diagnostics` 仍是全量） |
| 9 | `show` 查无此号时（在坏台账上）不提示 check error | miss 分支也拼 `structureNote`（stderr） |
| 10 | `badIdText` 断言「这一行存在」，且对写命令给了 `--expand` 这种不解决问题的建议 | 改为「looks like one row holding N ids」；写命令提示 `issuemd split FILE <第一个号>`，`show` 提示 `--expand` |
| 11 | SKILL 说区间格子（`7–20`）回灌会 exit 2，实际 `show "7–20"` exit 0 | SKILL 改为「comma 格子不行；纯区间格子 `show` 接受并渲染整行」 |

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
issuemd list     FILE [--status S] [--priority P] [--closed] [--expand] [--json [--with-body]]
issuemd show     FILE ID [--body-only | [--json] [--label NAME]]
issuemd counts   FILE [--json]
issuemd read     FILE <H2 标题>

issuemd new      FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-] [--allow-duplicate-title]
issuemd close    FILE ID [--status S] [--criteria TEXT | --criteria-from-body | --no-criteria] [--keep-body]
issuemd reopen   FILE ID [--status S] [--allow-duplicate-title]
issuemd status   FILE ID NEW_STATUS
issuemd rename   FILE ID "NEW TITLE" [--allow-duplicate-title]
issuemd body     FILE ID --body-file PATH|- [--append]
issuemd priority FILE ID P0|P1|P2|P3|""
issuemd split    FILE ID
issuemd sync     FILE [--guide | --fix-tables | --titles [--prefer body|table] [--move-progress | --drop-progress]]
issuemd adopt    FILE [--dry-run] [--report PATH]
issuemd <command> --help
```

所有写命令另接受 `--dry-run`（stderr 打 `snapshot: S`）与 `--if-unchanged S`。读命令的 `--json` 顶层带 `snapshot`。`new` 成功时 stdout 只有分配到的编号。写命令找不到编号 → stderr + exit 1；编号格式非法 → exit 2。台账文件只读 → 真写 exit 2。**写命令算出的字节与原文相同**时不落盘，stdout 是 `(no changes)` + exit 0（与 `--dry-run` 同一措辞；真正有改动时 stdout 仍为空；`adopt` 无改动时先打这一行再打报告）。`reopen` 对已开放项：目标状态相同是无操作，`--status` 换另一个开放状态则更新单元格。`rename` 只有索引摘要、正文标题、归档标题都等于目标时才是无操作；相同摘要也能修复其他副本漂移（第十七轮）。`close` 拒绝「表格单元格无法表示」的判据（反斜杠紧邻竖线，exit 2，不写）。读命令在 `check` 有 error 时退出码不变，但 stderr 加 `note: 'issuemd check' reports N error(s) …`（N 是 `check` 的全部 error 数），`--json` 顶层带 `diagnostics.errors`；`show --json` 的 `--label` 错误时 stdout 为空。`list --json --with-body` 的 closed 项带 `criteriaSource: "table"`。

退出码：0 成功 / 1 没有这条 issue 或空结果 / 2 用法或 I/O / 3 校验失败 / **4 E130 并发改动或 `--if-unchanged` 不符（可重试）**。

## 架构要点（改之前必须知道）

- **`src/io.ts`** —— **不要改**。原子写、快照复核、BOM/行尾/尾换行/权限位。符号链接在 CLI 层（`loadWritable`）解析成真实路径再交给 io；硬链接数也在 CLI 层 `lstat`。**写锁也在 CLI 层**：`commit()` 与 adopt 都经 `lockedWrite(loaded.path, …)` 调 `writeAtomically`，新写路径不要直接调 `writeAtomically`。
- **`src/cli.ts`**：
  - `COMMANDS` 表是命令与选项的唯一来源：`run()` 用它拒绝越界选项、生成全局与 `<cmd> --help`。新增命令/选项要同时进 `COMMANDS`、`OPTION_HELP`、`OPTIONS`。`OPTION_HELP` 文案里别写别的命令专属的选项名（`close --help` 有用例断言不出现 `--json`）。
  - 写命令共享 `commit()`。候选内容经 `terminate`、`joinDocument`、`parseLedger`、`checkParsedLedger` 后，按 multiset 拒绝新增 error。`new` 在同一候选解析结果上通过 `validateCandidate` 查占号。`tolerate` 专用于 `split` 按原行覆盖编号放行细分的 E102。校验完成后，dry-run 打印 diff 与 snapshot，真实写入通过 `lockedWrite` 原子替换。E130 返回 exit 4，有硬链接时提示原路径和其他链接可能看到不同内容。
  - `cmdSplit` **不补正文骨架**（第十三轮，dogfood #64/#70）：拆行后按原来的 body 集合算 `missing`，不插入任何骨架；缺正文的号继续 E102，stderr 点名并提示 `issuemd body`。整段循环没有 `parseLedger`，性能与 `check` 同量级。
  - `Loaded = { doc, lines, path, links, snapshot }`。**`--if-unchanged` 在 `loadWritable(file, expected)` 里、刚读完文件时比对**，所以任何命令逻辑（「已关闭」之类）之前就 exit 4。所有写命令经 `openLedger(file, v["if-unchanged"])` 或（adopt）直接 `loadWritable(file, v["if-unchanged"])` 读文件；新写命令必须照做。
  - `snapshotOf(text)` = sha256 前 16 位十六进制。写路径对 `joinDocument(lines, doc)`、读路径对 `readFileSync(file, "utf8")` 求值；两者对合法 UTF-8 文件逐字节相同（BOM、CRLF、无尾换行都保留）。`run()` 校验格式（16 位小写十六进制），不对就 exit 2。
  - 插入正文块用 `insertBlock`（两侧恰好一个空行）；`close --keep-body` 的归档插入仍是 `insertLines` + 手动前导空行——`reopen` 的逐字节还原依赖它，别改成 insertBlock。
  - `cmdClose` 的判据规则：`--criteria` > `--no-criteria` > `--criteria-from-body`（空则拒）> 正文自动提升 > `--keep-body` 允许空 > 否则 exit 2。`--criteria` 先 `unescapeCell`（与标题同约定）；晋升前做 `unescapeCell(escapeCell(criteria)) === criteria` 往返检查，表格表示不了「反斜杠紧邻竖线」时 **exit 2 不写**（第十四轮，A1）。
  - `cmdNew`：先查重复摘要（只比开放行，`summaryKey` 归一），再取号；成功后 stdout 是编号（只在非 dry-run 时替换 `commit()` 的空 stdout）。`cmdRename` 同样查重复摘要（排除自己那一行；目标是已关闭项时不查）；若目标摘要等于表格摘要则绕过重复检查，但仍构造候选内容，让 `commit()` 判定整体字节是否无变化，从而修复正文标题/归档标题漂移，同时保留已一致的转义写法（第十七轮）。
  - `titleProblem()` = 空标题（第十二轮）+ 计数后缀（`countSuffix`，E121）+ 结尾 `#`；`new`/`rename` 用于输入，`reopen` 用于已关闭行的旧摘要。
  - `readOnlyRefusal()` 在 `commit()` 与 adopt 的写入前各调一次（`accessSync W_OK`）。
  - `missingIssue(verb, id)` / `badIdText()`：写命令的「没有这条」走 stderr；`show` 仍用 stdout 的 `(no such issue: N)`。`badIdText` 遇到多号形状（`30, 31`，`parseIds` 得到多个 span）时点名这些号并指向 `list --expand`（第十三轮，dogfood #71）。
  - 读命令的一致性 helper（第十三轮）：`structureNote(errors, knownLines)` / `diagnosticsField(errors)`。`cmdList` / `cmdCounts` / `cmdShow` 各跑一次 `checkLedger`；stderr 的 note 与 `--json` 的 `diagnostics` 都只在有 error 时出现。**N 是 `check` 的全部 error 数**（第十四轮：不因错误都在不可读行上而整体抑制）；`known` 只用于挑「first」，逐行细节仍由 `unreadableNote` / `diagnostics` 给出。`cmdShow` 的 `withNote` 现在拼 `structureNote + inheritedNote + twinNote`，查无此号的分支也拼 `structureNote`。
  - `list --with-body`（第十三轮 / 第十七轮）：`withBody(ledger, issue, index)` 在 `ledger-read.ts`，与 `viewIssue` 同源解析兄弟号正文（含区间行内部号，`bodyFrom` 标明）；必须配 `--json`，否则 exit 2。`cmdList` 按本次输出 ID 构造一次 `indexWithBody(ledger, issues, blocks)`，不展开未请求的区间编号；区间正文回退按 suffix + ID 二分取候选，并按行缓存，exact body 始终优先。显式同号行索引阻止错误借正文；扩大行序仍与 `findRow` 一致（#81/#82 复审修复）。两条读取路径都把正文块切片后调 `labelsIn`/`labelBlock`/`extractCriteria`。
  - `readBodyFile` 剥 BOM 与开头空行，拒绝 fence 外的 `KEPT_BODY_VERSION` / `KEPT_BODY_START` / `KEPT_BODY_END`。新归档带 version 标记，reopen 按 start/end 标记间的原行恢复；legacy archive 不按新标记猜边界，全部内容（含字面标记和旧 provenance note）保留进恢复的正文。
- **`src/ledger-edit.ts`**：
  - `escapeCell` / `unescapeCell`：竖线前反斜杠为奇数才算已转义，与 `ledger.ts` 的 `splitCells` 读法一致。标题输入用 `unescapeCell` 归一，别再写 `.replace(/\\\|/g, "|")`。
  - `extractCriteria()` 合并所有非空 `**验收判据**` 块（去重，`joinClauses` 连接：前段以 `；`/`;` 结尾时不再加 `；`）；close 提升与 `show --json criteria` 都走它。`labelName()` 把 `**验收判据：**` 归一成 `验收判据`，labelBlock / labelsIn / W206 都用它。
  - `labelBlock()` 是唯一的标签解析：从 `**标签**` 行到下一个标签行或标题；空行、列表、fence 内容都属于它。**fence 内与本标签同名的标签行不算内容**（第十三轮，dogfood #61；只跳同名标签，Gherkin 的 `**Given**` 仍是判据——复审(16) 4）；块内 fence 允许任意缩进（`fencedLines(own, Infinity)`），列表项里的示例也能识别。fence 里的普通内容（`npm test`）仍算判据。`findLabel`、`extractCriteria`、`show --json labels` 都走它。
  - 归档格式常量：`archiveHeading()`、`ARCHIVE_HEADING`、`KEPT_BODY_VERSION`、`KEPT_BODY_START`、`KEPT_BODY_END`。close / adopt / reopen / rename / check 共用，改格式只改这里，并跑 `keep-body round trip`。
  - `ledger-edit` 与 `ledger-check` 互相 import（只在函数里用对方，模块初始化时不能用）。
- **`src/ledger.ts`**：
  - `parseLedger` 的 `unreadable: UnreadableRow[]`：E108/E109 丢掉的表行，**以及 E124 的「游离行」**（`table: "stray"`）。下游（`maxIssueId`、`new --id` 撞号、`show` exit 3、`unreadableNote`、`list --json unreadableRows`）都靠它，所以 E124 行自动被保留编号。
  - `strayRows()`（#52）：台账表小节名下只把 `tableHeader` + `mappingFor` 接受的表作为 E124/unreadable；其他小节按 W225 / cited 规则处理。`怎么用`、`状态口径`、第一个 `索引`/`已关闭` 受控节跳过。`正文`/`附录` 不被当作正式 issue 表，但可见、非注释、带分隔行的引用型表行进入 cited、不报 W225（第十七轮 #84）。H1 与第一个 H2 之间的表不算。
  - `isTableSection`（台账表小节名正则）、**`mappingFor`（issue 表的列映射）**、**`tableHeader`（首行是不是表头）**、`isStatusWord` 都定义在这里，adopt 从这里 import。改其中任何一个都要同时看 check 与 adopt 两边。
  - `tableHeader(rows, synthetic)`（第十一轮）：首行不含数字 → 表头；首行下不是分隔行 → 无表头；`synthetic`（adopt 的 `fixSeparators` 自己补的分隔行）→ 有以数字开头的格就是数据（旧规则）；真实分隔行 → 表头，除非首行是 issue 行：首格是编号且其余格有非数字文字（`issueLike`），并且第二格是状态词 / 分隔行下没有行 / 下面每行都 `issueLike`。统计表（`| 2026 | 开放 | 关闭 |` 下接纯数字行）因此仍是表头。
  - `strayRows` 口径（第十一轮 + 第十七轮）：第一个 `索引`/`已关闭` 是规范表；`怎么用`/`状态口径` 是受控块；这些不按外来表处理。`正文`/`附录` 保持自由格式，只把可见、非注释、带分隔行的 issue 形表编号记入 `cited`，不报 W225、不入 `unreadable`。其他小节下按既有 W225 识别规则：真实分隔行，且表头含 id + 摘要/标题，或只有两列含 id，或表头位置是 issue 行；ID+状态无摘要列则只对状态格为默认词的行占号。
  - `parseLedger().cited`：外来表及 `正文`/`附录` 自由格式表里的引用编号，**不进 `unreadable`**（否则读命令会说「结果不完整」、`show` exit 3）。`cmdNew`（取号逐个跳过、`--id` 撞号 exit 2）、`cmdShow`（miss 时 stderr 提示）和 `list --json` 的 `citedRows` 用它。库导出的 `maxIssueId` 不看它。
  - **`countSuffix` / `stripCountSuffixes`**（第十二轮）：「标题末尾的计数」唯一定义。4 位 19xx/20xx 年份不算；全角数字算；整个标题只是 `（3）` 不算。调用方负责先去掉 `#` 标记、ATX 结尾 `#`、`Issue N:` 前缀：E121（ledger-check 对 Issue 标题取冒号后）、`titleProblem`（cli）、`stripCounts`（adopt，反复剥）、adopt 对开放行摘要也剥。
- **`src/ledger-check.ts`**：`PRIORITIES`、`summaryKey`（W212 的 NFKC/大小写/**删除全部空白**——第十三轮，dogfood #65）、`checkHashes` 区分 pinned（W202）与仅校验（判据列，给 W240 用）；`checkAppendix` 出 W250/W251/W252/W253。**W261**（第十三轮）：开放项正文没有非空 `验收判据` → warning，已关闭项不判（判据在表格列）；只含一条 HTML 注释的块不算非空（第十四轮）。`--strict` 仍只豁免 W250。
- **`src/ledger-read.ts`**：`ListedIssue` 带 `ids`/`count`；`expandIssues`（上限 10 万）；`viewIssue` 带 `labels`、`criteriaSource`，借正文用与 `withBody` 同一个 `covers`（区间内部号也算，第十四轮）；**`body.id` / `body.inherited` / `criteriaFrom`** 标明借用兄弟号正文（第十三轮，dogfood #69）；`withBody` 给 `list --json --with-body`（#67）。批量路径由 `indexWithBody()` 一次建立 row/id、正文块和显式行索引，再给每个 issue 复用；区间 fallback 按 owner id 二分查找，重叠独立行不得借正文（第十七轮 #82）。closed 项补 `criteriaSource: "table"`（第十四轮）。
- **`src/statuses.ts`**：默认状态词表 `STATUS_CLASSES`（第十一轮从 ledger-check 移出，ledger.ts 要用且不能与 ledger-check 循环引用）；`ledger-check` 仍 re-export。
- **`src/adopt.ts`**（改前读完它）：
  - `pipeBlocks(lines, sections, synthetic)`：表头走 `tableHeader`，`synthetic` 是 `fixSeparators` 补分隔行的行号集合。无表头宽 3 的块带 `rowStatus`：`rowsOf` 逐行判断，第二格是精确状态词的行按 `# | 状态 | 摘要`，其余按 `# | 摘要 | 判据`。
  - W225 的 `cited-table` 决定不在 adopt() 里产生，而在 `cmdAdopt` 对输出跑 check 后补上（早退路径也有）；报告因此在 check 之后渲染。
  - 开头：输入 `check` 0 error 且无 W220 → 原样返回。E124 是 error，所以「规范骨架 + 旧表」的混合文件会走完整转换。
  - `demoteHeadings`（第十二轮）：只在正文块里把 H4–H6 降级——从 `Issue` 标题（H1–H3，行首 0–3 空格）到下一个同级或更高级标题。旧 cafe 是 `## Issue N:` + `### 期望` + `####`，所以不能写成「下一个 H1–H3 结束」。
  - `stripCounts` 现在返回 `renames`（被改写的标题行 + 原名/新名，输入坐标）。`adopt()` 用 `separated.origin` 把它映射到输出坐标：报告里的「去掉标题里的（N）计数」点名每一处（**报告里标 `源 L…`**，因为此时输出行号还没定——复审(16) 3）；`foreign-section` 的消息据此区分「原样移入附录」与「标题去掉计数后移入附录」，H2 另加「以原级别 H2 并入附录」（第十三轮，dogfood #72）。
  - 开放项摘要计数（第十三轮，dogfood #73）：**先按原始摘要与原始正文标题比**（`headingTitleOf(originalTextAt(body.line))` 取 stripCounts 前的标题）。两侧相同 → 静默剥；**只有摘要带计数**且剥后相同 → `summary-count-stripped` 决定（带 id 与新旧值）；两侧都带计数时比较归一化后的计数值：同值静默、不同值才是 `open-title-conflict`；只在正文标题上的计数由 `stripCounts` 报告，不产生摘要决定（复审(16) 1/2）。别再把「先剥所有开放摘要、再判冲突」写回来——那会把真漂移吞掉。
  - 早退文案（第十三轮）：有 W225 警告时写「结构合法（check 0 error）；另有 N 张表按 W225 原样保留、不迁移，无需转换」，没有 W225 时仍写「已是规范台账」。无改动时真运行也先打 `(no changes)` 再打报告（第十四轮，A5）。
  - 正文标题与摘要的比较一律先 `unescapeCell(title)`：E106、adopt 的 `open-title-conflict`、`sync --titles`（第十二轮）。
  - `layoutLines`：被消费的表块的表头/分隔行，**加上表格小节里只有表头+分隔行的空表**（#52：混合文件里规范表是空的，以前会被当成说明文字复制进附录）。
  - `Row` 有 `criteria`（真判据）与 `extras`（附加列、溢出格、`原状态：X`）两个字段，**不要再把 extras 拼进 criteria**：开放项 extras 进 `**原表格判据**`，已关闭行在输出表时才拼成「判据；附加列」。`Row.overflow` 记溢出格数，`rawStatus` 记去格式前的状态格。
  - 开放正文组装：每个开放行按 `parseIds` 逐号生成 `bodyEntries`（已有正文或骨架），最后全体 `compareIds` 排序再展开；索引表行仍用 `sortedOpen`。
  - `movedBodyLines`：被搬进正文/归档的 `### Issue N:` 块，在 H1 说明与外来小节的逐字副本里跳过。`topBodyLines`：首个 H2 之前、且是 `bodyById` 选中的那份正文，在 H1 说明与前言里跳过（没选中的同号副本留原处转义）。`appendixBodies`：输入附录里的正文块，不参与挂载，原地改标题。
  - 列映射 `mappingFor`、状态优先级、保留规则、**守恒守卫**（逐行文本 + 编号集合）同前：新增任何「重建」逻辑时，要么把行复制到输出，要么把它加进 `regenerated`（= `rowLines` ∪ `layoutLines`）。
- **`src/write.ts`**：Myers 行级 diff + 3 行上下文多 hunk。`unifiedDiff(old, next, path, finalNewline, eol, bom)`：无尾换行时末行后加 `\ No newline at end of file`，只在一侧是末行的上下文行拆成 -/+，这样 `patch` 能应用。
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
26. `split` 不能替缺正文的号造骨架：E102 会因此消失（或变成 W212），一次合法写让 `check` 变宽松。缺正文就让它继续报，stderr 点名，让调用方用 `body` 决定写什么（第十三轮 #64）。
27. 写命令的「无改动」必须与 `--dry-run` 同词：stdout `(no changes)`。重试的调用方靠它区分「已经改过」与「刚才改成功」；`new` 的编号输出不受影响（第十三轮 #66）。
28. 读命令不能对 `check` 有 error 的台账保持沉默：stderr note + JSON `diagnostics`，但退出码不变——读一份坏台账去修它是正当用法（第十三轮 #63）。
29. `show` 的历史回退（多号行只在首号写正文）可以保留，但必须标明归属（`body.id` / `inherited` / `criteriaFrom`）。不标明就是与 `check` 的 E102 互相矛盾（第十三轮 #69）。
30. adopt 的「剥计数」不能先于「判冲突」：判断必须看 stripCounts 之前的原文标题。两侧同计数才静默；单侧带计数要被看见；计数不同是冲突（第十三轮 #73）。
31. 外来 H2 搬进附录**不要降级成 H3**：降级后它里面的表不再处于非台账小节名下，W225 消失、编号不再保留（第十三轮实测会让 `#56/#57` 的占用回退）。报告写「以原级别 H2 并入附录」即可。
32. 单元格的转义模型（`splitCells`/`escapeCell`）只能表示「字面竖线」和「偶数个反斜杠 + 竖线」；「奇数个反斜杠紧邻竖线」不可表示。把正文/用户文本写进单元格的路径必须先做往返检查，表示不了就拒绝，不能照写（第十四轮 close）。
33. 读命令的 check note 的 N 必须是 `check` 的总 error 数；不可读行只是细节，不是抑制整条 note 的理由（第十四轮）。
34. 区间行的正文归属必须在 `viewIssue` 与 `withBody` 用同一条 `covers` 规则，否则两个读命令互相矛盾（第十四轮）。
35. diff 要能应用到原始字节：BOM 属于首行，`unifiedDiff` 必须把它带上（第十四轮）。
36. 标题计数检查不能受 E120 门禁影响：`## 已关闭（3）` 既缺小节又有计数，两个都要报（第十四轮）。
37. `(no changes)` 契约对 `adopt` 与它的 `--dry-run` 同样适用：真运行先打一行再打报告（第十四轮）。

## 已完成的审查与验证

- 回归用例：`src/dogfood.test.ts`（按 dogfooding 编号分组；第九轮自测的用例以 `probe:` 开头，在文件末尾）、`src/round13.test.ts`（第十三轮，按 #61–#73 分组）、`src/round14.test.ts`（第十四轮黑盒发现）、`src/ledger-verbs.test.ts`、`src/write.test.ts`、`tests/bin.test.ts`（bin 执行位、FIFO 驱动的真实并发 → exit 4、打包 manifest）。
- 第八轮手工验证：`npm test` 前后 `dist/` 与 `dist/bin/issuemd.js` 的 inode + mtime 不变；故意制造类型错误时 `npm test` exit 1 且 `.dist-test` 不含残留；`npm pack --dry-run` 不含 `.dist-test`。
- 第八轮末尾派了独立 subagent 复审本轮 diff，结论见最后一节「第八轮复审」。

## 仍然接受的已知项

- **Legacy 归档没有版本标记时只能按 H3/最后可见 end marker 取边界**（第二十轮）：如果旧归档正文里恰好出现 `<!-- issuemd:kept-body:end -->`，`reopen` 会把它当成末行边界，后面的字面内容留在附录而不是被恢复。新归档带 `kept-body:v2` 标记，不受影响。手工修复方式是把那行放进 fence 或改成实体写法；不要再去猜 legacy 内容，猜测会删掉真实正文。
- **W261 会让历史台账的 `--strict` 变红**（第十三轮）：三份真实台账分别有 5 / 1 / 20 条开放项没有非空 `验收判据`（`check` 仍是 0 error）。这是「每条 issue 都应可验证」的直接代价；若下一轮觉得太吵，可讨论把 W261 收进一个只在 `--strict` 下启用的子级开关，但不要静默删掉它——空骨架正是 #62 的病灶。
- **摘要查重把「所有空白差异」当同一条**（第十三轮 #65）：`支持 IE11` / `支持 IE 11`、`Fix CSV` / `FixCSV` 会被 `new` 拒绝并报 W212。中文标题里空格不承载语义，英文里去掉空格也不是另一种写法，所以接受；真需要并存的用 `--allow-duplicate-title`。
- **读命令的 `diagnostics.errors` 与 error 数同长**：误把整份台账写成坏表时，`list --json` 会带很多条（与 `check --json` 一致）。消费者应按 `code`/`id` 自行截断。
- **`split` 对缺正文的开放区间会让 `check` 保持红色**（第十三轮 #64）：区间行原本只报第一个缺失号，拆开后逐号 E102；写入门禁对这同一些 id 的 E102 放行（`commit(..., tolerate)`），因此 split 之后 `check` 仍 exit 3，直到补齐正文。
- **写命令的 `(no changes)` 是一个输出契约变化**（第十三轮 #66）：以前无改动的 `status`/`priority`/`rename`/`body`/`sync` 是零 stdout，现在是一行 `(no changes)`；依赖「stdout 为空」判断的脚本需要调整。
- **外来 H2 进附录仍保持 H2**（第十三轮 #72）：报告会写「以原级别 H2 并入附录」，但 `## 附录` 之后的下一个 H2 在结构上会结束附录小节（`checkAppendix` 也只扫到那里）。不降级是刻意的——降级会破坏 W225 的编号占用。
- `list --json --with-body` 只给开放项补 `labels`/`criteria`（已关闭项本来就有判据列）；兄弟号正文用 `bodyFrom` 标明来源，不复制成自己的。
- `scan` 的标题扫描仍只认 0–3 空格缩进的 fence（`scan.ts` 顶部文档化的取舍）。列表项里缩进 4+ 的 fence 现在对判据/标签识别有效（`fencedLines` 的 `maxIndent` 参数），但其中的 `# 标题` 仍可能被当成真标题——这是扫描器的旧限制，不在第十三轮范围内。
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
- W225 表里超出安全整数的编号（`99999999999999999999`）既不进 `citedRows`，也不报 E109；kept-row 进附录时行首 `|` 被转义（`\| 备注 | x |`；黑盒指出「不严格是按原文」，未核实是否有意，下一轮可查 `neutralizePreserved`）。
- 正文里的 setext 标题（`文字` + `===`）让 adopt 以 E110 自拒（旧行为）；同一编号两份正文块被守恒守卫拒绝（旧行为）。
- 游离行（E124）首格解析不出编号时整行不报（无法判断它是 issue）；`new` 的重复摘要检查只看规范开放表，不看游离行——有 E124 的台账本来就该先 `adopt`。
- **表格单元格表示不了「奇数个反斜杠紧邻竖线」**（第十四轮）：`close` 晋升这种判据时 exit 2 不写；`--keep-body --no-criteria` 把正文原样留在附录是逃生口。这是 `splitCells`/`escapeCell` 的模型限制，改它要连带改所有单元格的解码规则（迁移风险大，未做）。
- **`list --expand` 保持表格行序**（第十四轮）：文档只承诺「一个 id 一行」；`100, 99` 展开为 `100`、`99`，行在它所在的位置展开。要排序的话是独立的小改动。
- **snapshot 是原始字节的 SHA-256 前 16 位**（第十四轮）：LF/CRLF/BOM/无尾换行是不同文件、不同 snapshot；同一文件内 `check`/读命令/写命令 dry-run 一致，`--if-unchanged` 用错编码的 token 会 exit 4（保守且安全）。
- **`list --json --with-body` 在缺判据/缺正文时省略 `criteria`/`criteriaSource`/`labels`**（第十四轮）：与 `show --json` 同口径；消费者按键是否存在判断。

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
node dist/bin/issuemd.js list fixtures/canonical-clean.md --json --with-body  # 每项带 labels / criteria，同一 snapshot
node dist/bin/issuemd.js close --help                        # 只列 close 的选项（含 --if-unchanged）
node dist/bin/issuemd.js list fixtures/canonical-clean.md --title x; echo $?   # 2
node dist/bin/issuemd.js status fixtures/canonical-clean.md 2 未决 | cat       # (no changes)，exit 0
node dist/bin/issuemd.js check ../issuemd_dogfooding/issue-20261124.md | tail -1   # 0 errors, 8 warnings（W261 5 条，见已知项）
node dist/bin/issuemd.js check ../orca_archived_files/issue-20261023.md | tail -1   # 0 errors, 158 warnings
node dist/bin/issuemd.js adopt fixtures/canonical-clean.md | head -1          # (no changes) 后接报告
node dist/bin/issuemd.js show fixtures/canonical-clean.md 2 --json --label 不存在 >/dev/null; echo $?   # stdout 空，1
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

