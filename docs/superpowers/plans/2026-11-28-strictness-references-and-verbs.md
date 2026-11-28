# 实施计划：strict 分层、引用判号、判据终点与语义编辑动词

日期：2026-11-28。Spec：`docs/superpowers/specs/2026-11-28-strictness-references-and-verbs-design.md`。
工作分支：`feat/round28-strictness-refs-verbs`。全部按 TDD：先写失败用例并确认失败原因，再实现。
本轮的四个口径已由用户拍板：strict 只对数据/结构失败；裸写引用只保护 high-water+1 以内；#103 采用列表续接判定；同时做 W264 指针、criteriaItems、narrow/review。

## 阶段 0：基线

- `npm run typecheck && npm test` 确认 974 项全绿（当前 HEAD `fd06e7a`）。
- 只读快照：dogfood 台账 `0 errors / 22 warnings`（W271×22、W201×1）；`--strict` exit 3。
- 不写任何外部台账。

## 阶段 1：引用三分类与判号上限（#150 / #152）

测试（新增 `src/reference-ceiling.test.ts`）：
1. `见本台账 #558`（夹具 max=557）：W271=1；`new` 得 558；`new --id 558` 被拒并点名行号。
2. 13 种本台账写法（`见本台账`、`参见本台账`、`详见本台账`、`另见本台账`、`据本台账`、`见本台账#558`、`见该台账`、`参见此台账`、`见当前台账`、`见本文档台账`、`见当前这份台账`、`this ledger`、`本台账`）全部 W271=1、占号。
3. `日本台账 #3`、`Orca 台账 #558`、`cafe 台账 #999`、`…/issue-20261023.md #558`：W271=0、不占号。
4. 裸写：`见 #21`（max=20）W271=1、`new` 得 22；`见 #558`（max=152）W271=0、`new` 得 153。
5. `见本台账 #558` 在 max=152 时 W271=1（显式本地不受 ceiling 限制）。
6. 句号作用域：`本台账已关闭。见 #21` 按裸写处理（W271=1，占号）；`另见` 后的本地提及仍生效。
7. `find '#558' --json` 仍把 external 命中标为 `reference`（检索分类不回退）。
8. 回归：W225 citedRows、`new --id` 的既有拒绝、`9–20` 退休段保护不变。

实现：
- `ProseReference` 增 `local?: true`；`externalLedgerContext()` 返回 external/local/none，抽出 `selfLedgerName()`（逐字剥引用动词，禁止无边界后缀匹配）。
- 新增 `referenceCeiling(ledger) = max(maxIssueId, highWater) + 1` 与 `reservedProseReferences(ledger)`（external 跳过；local 保留；bare 只保留 ≤ ceiling）。
- `missingProseReferences()`、`cmdNew` 的 `proseReservations` 共用 `reservedProseReferences`。

## 阶段 2：Phase 1 小修

测试：
- `src/close-override.test.ts`：941 字符旧判据 + `close --criteria 'z。'`：stderr 首行 < 200 B，含 `941`；`--dry-run` 同样截断；相同判据为 `(no changes)` 且无 override 行。
- `src/cli-version-counts.test.ts`：`--version` 匹配 `^\d+\.\d+\.\d+ \(build: .+\)$`；`counts --markdown` 的数字与 `counts`/`check` 一致；`--markdown --json` exit 2。
- `src/criteria-boundaries.test.ts` 扩展：`sync --criteria-labels` 对 `**判据**：讨论中，尚未定稿。` 默认 skip 且 W261 保留；`--force` 才改名；带列表的近邻标签仍自动改名。
- close 缺判据文案含 `file shrinks` 与 `file grows`。

实现：
- `overrideNote` 的旧/新值按 120 字符截断并附 `(N chars)`。
- `--version` 输出 `${VERSION} (build: ${dirname(fileURLToPath(import.meta.url))})`。
- `sync --criteria-labels` 增加 `--force`；默认要求 `blockHasListItems()`；skip 文案点明 `--force`。
- `counts --markdown` 输出 `- open N (…, …) · closed M`；`--markdown --json` exit 2。
- #114 文案改「文件变小 / 文件变大，稍后 prune」。

## 阶段 3：strict 分层与 W264 指针（#106 / #138）

测试（新增 `src/strict-tiers.test.ts`、`src/criteria-pointers.test.ts`）：
1. 只有 W201/W202/W250/W264 的台账 `--strict` exit 0；加入 W261 或 W271 后 exit 3。
2. `**判据（不变）**` + 一行复核叙述：无 W264；`close --criteria-from-body --dry-run` rc=0；`sync --criteria-labels` 不把它列为候选。
3. `**判据（不变）**` + 列表：仍 W264、close rc=2。
4. 真·`**追加判据**` + 新内容：仍 W264、close rc=2。
5. 内容逐字相同的 `**追加判据**`：无 W264（既有行为）。
6. W264 文案含「renaming would create a duplicate label」与 `--keep-body` / `--criteria` 出路。

实现：
- `STRICT_EXEMPT = new Set(["W201","W202","W250","W264"])`；`strictFailures` 用它过滤；help/SKILL 同步。
- `criteriaSourceKey` 去重保留；新增 `isCriteriaPointerLabel()` 与 `blockHasListItems()`；`criteriaOccurrencesFromLabelBlocks()` 把「指针标签 + 无列表项」标为 `alreadyCovered`。
- `criteriaAliasRepair()` 排除已覆盖指针；W264 文案更新。

## 阶段 4：判据块终点（#103）

测试（新增 `src/criteria-termination.test.ts`）：
1. `1. A` / 空行 / 叙述 / 空行 / `- B`：`criteria = "1. A"`，无 W268，close 不把 B 当判据。
2. `1. A` / 空行 / 叙述 / 空行 / `2. B`：W268 + close rc=2；`criteria` 仍含叙述与 B（保守）。
3. `- A` / 空行 / 叙述 / 空行 / `- B`：W268 + close rc=2。
4. `- A` / 空行 / 叙述 / 空行 / `2. B`：块在叙述前结束。
5. 缩进续行、fence 示例、`#29` 形态、多段列表全部回归。
6. dogfood 台账的 `criteria` 只增不减的条目：逐条比较改动前后，确认没有把真实判据截掉（只减少被误吞的叙述）。

实现：`labelBlock()` 的空行 lookahead 改为「续接同一列表」判定（`continuesSameList`：双方有序则编号递增，双方无序则同类型，缩进续行/围栏算续接，类型不同则结束）；`ambiguousProse` 只在续接时设置。

## 阶段 5：criteriaItems（#120 / #123）

测试（新增 `src/criteria-items.test.ts`）：
1. `1. 第一条；它自己含分号` / `2. 第二条` → `criteriaItems.length = 2`，`[0]` 含分号。
2. 两段 canonical（`1. A` 与 `1. C` / `2. D`）→ `["A","C","D"]`。
3. `list --json --with-body` 与 `show --json` 的 items 逐条相等。
4. 已关闭项无归档：`[criteria]` + `criteriaJoined: true`（含 `；` 时）；有归档且与单元格一致时用归档条目。
5. 无判据 → 两个字段都不出现；`criteria`/`criteriaBlocks` 不变。
6. fence 内列表行不被当成新条目；标签行内联内容成为第一项。

实现：`criteriaItemsFromBlock()` / `criteriaItemsFromOccurrences()`；`IssueView` 与 `ListedIssue` 增可选字段；`viewIssue`/`withBody` 接线（开放项用 occurrences；关闭项优先归档一致，否则 `[criteria]` + joined）。

## 阶段 6：narrow 与 body --append --before（#140）

测试（新增 `src/narrow.test.ts`、`src/append-before.test.ts`）：
1. `narrow F 2 --criteria "新判据" --status 部分解决 --note "复测通过"`：状态、判据、`**复核记录**：YYYY-MM-DD …` 一次写入；`check` 0 error；不新增 W264/W268。
2. 只给 `--criteria`：状态不变；`(no changes)` 当三者都无变化。
3. 已关闭项、竞争判据、歧义正文、闭合状态 → exit 2 且字节不变。
4. `--dry-run` 与真跑 diff 一致；`--if-unchanged` 过期 exit 4。
5. `body F ID --body-file X --append --before 验收判据`：新段落在判据前，`criteria` 逐字不变，`check` 不新增 warning。
6. `--before` 缺失/多个标签 → exit 2 并列出可用标签或行号；`--before` 单独出现 exit 2；追加内容含判据标签 exit 2。

实现：
- `narrow`：复用 `editOpenCriteria()`；随后在 canonical 标签前插入唯一 `**复核记录**` 块（本地日期，冲突加序号）；用 `replaceCell(...,1,status)` 改状态；`validateCandidate` 断言 criteria 逐字、状态只按请求变化、不新增 W268/W264/W206/W261；`report` 列三项，`receipt` 一行。
- `body --before`：`OPTIONS`/help/usage 增加；按 `labelName` 找唯一标签；`insertBlock(lines, labelLine, addition)`；候选解析后比较 criteria occurrences 与 W268/W264/W261 不新增。

## 阶段 7：文档、复测与集成

- `docs/spec.md`：strict 豁免表、引用三分类与 ceiling、W264 指针、#103 终点、criteriaItems 字段、narrow/--before/counts --markdown/--version、W271 语义。
- `skills/issuemd/SKILL.md`：warning 表标注 strict 参与；新命令与选项；`--append --before` 的落点说明；criteriaItems 的 JSON 示例；`sync --criteria-labels --force`。
- `README.md`：命令表补 narrow/--before/--markdown。
- 只读复测：dogfood W271 22 → ceiling 内数量；`--strict` 结果；三份台账 SHA 前后不变。
- 全量：`npm run typecheck && npm test && npm run build`。
- 每阶段一个 commit；最后 fast-forward 合入 `main`，删除已合并分支，build，push `origin main`（用户本轮临时授权）。

## 风险与回退

- 判据终点变化可能缩短部分 `criteria`：以「原文仍在正文、criteriaBlocks 保留原始块」为安全边界；若真实台账逐条比较出现真实判据减少，回退该条并记录。
- 引用 ceiling 可能让远期裸写引用失去保护：显式 `本台账 #N` 不受影响；测试覆盖 `#121` 判据 4 的低号场景。
- `narrow` 的日期依赖本地时钟：测试用正则，不写死日期。
- `criteriaItems` 是新增字段：任何解析失败都退回 `[criteria]`，不改变既有字段。
