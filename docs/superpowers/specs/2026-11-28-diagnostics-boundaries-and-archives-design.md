# 诊断噪声、判据边界与归档清理（第二十七轮）

日期：2026-11-28。输入：dogfooding 台账 #103/#111/#114/#124/#145/#148/#150、#115/#118/#128 的复测；上一轮已完成 #147 与 W268 的 `**非目标**` 小节。本轮只改这些条目，不改数据格式。

## 目标

1. 让 W268 只报「判据列表可能被切开」，不再把复核/边界小节标题当成歧义；同时保留 round23 的真阳性。
2. 只遮归档信封（标题可见）时 fail closed：`check` 报 W269，`show`/`prune`/`reopen` 拒绝，不再把信封当正文。
3. `#N` 引用带其他台账前缀（`Orca 台账 #558`、`ledger #N`）时不算本台账未登记引用，也不占号。
4. `prune` 能删除附录中任意位置的 v2/v3 归档；W250 文案指向 `prune`。legacy 仍不可 prune（无独立信封边界，删除区间可能吞掉 payload 后的用户正文），拒绝文案说明原因。
5. `close --criteria` 对反斜杠的改写不再静默：stderr 给出输入到单元格的读法；`criteria --criteria` 与 `close --criteria` 的域差异写进 help/SKILL。
6. 整行粗体且「内部冒号 + 句末标点」的强调句不再被当成标签，不再切断上一块。
7. `check` 摘要给出 format/artifacts 分组；W270 文案说明 close/reopen 后果；文档补 W201 的密度对照与读视图口径。

## 非目标

- 不新增 `criteriaItems`、不改变 `body.content` 的字节契约（#108/#144 等裁定）。
- 不改变 W201 的 `--strict` 口径（#106 待裁定）。
- 不新增 `narrow` / `--append --before` / `counts --markdown`（#140 需要独立设计）。
- 不改变归档 payload 的字节与 `reopen` 的逐字节还原。
- 不要求旧正文改写；解析修复应让旧正文自动读对。

## 设计

### 1. W268：复核小节白名单 + 列表延续

`criteriaBoundaryHints()` 目前对「判据块边界是独立粗体行、且其后再出现列表」一律报警。新增两道过滤：

- **复核小节**：边界行必须是第 0 列（`^**`），且 `labelName` 满足任一：
  - 含 `:` / `：`（带冒号的正文小标题，如 `另一半：…`）；
  - 以 `？` 结尾；
  - 以 `第 N 轮` / `本轮` / `下一轮` 开头；
  - 去掉末尾括号补注后，以 `复测/复核/核对/补充/实测/边界/非目标/复测记录/复核记录/追加现场/相邻项/风险点/背景/结论/后续/备注/代码锚点/证据文件/证据/说明` 结尾。
  - 判据别名（`isCriteriaLabel`）仍先走 W264，不在此白名单。
- **列表延续**：非白名单标签必须证明「后面的列表延续了判据列表」才报：
  - 找到判据块内边界前最后一个列表项与边界后第一个列表项；
  - 两者都是有序列表且 `laterNumber > earlierNumber`，或两者都是无序列表，才报；
  - 类型不同或没有前置列表项时不报。

保留：`**非目标**` 顶格 + 空行的既有豁免；缩进的 `**非目标**` + `3.` 仍报（round21 回归）；`**必须离线通过。**` + `3.` 仍报（round23 真阳性）。这一轮只调整 W268 的边界诊断，不改变标签解析，因此整行粗体强调句目前仍可能成为 label；#124 仅修复冒号在粗体内且句末有标点的强调句，`**必须离线通过。**` 继续作为 W268 真阳性保护。

### 2. 只遮信封：fail closed

`locateArchivePayload()` 在 legacy 兜底前增加：

- 扫描 `headingLine+1 .. min(section.line_end, headingLine+3)` 的**原始行**（不经 `visibleLine`）：若出现完整的 `kept-body:vN` 版本行，或紧随其后的 `kept-body:start`，而该行隐藏（fence/comment/raw HTML），返回 `refusal(line, "… is hidden inside a literal block", recognized: true)`。
- 只认结构位置上的信封序列，不扫描 legacy payload 内部；legacy 正文里字面出现的 marker 文本继续当普通数据（round21 回归）。

由此：`archiveEnvelopeDiagnostics` 对可见标题 + 隐藏信封报 W269；`reopen` 的 `locateArchivePayload().range` 为空 → exit 3；`show --body-only` 通过扩展后的 `hiddenArchiveNote`（可见归档但有 recognized refusal）给出原因；`prune` 同样拒绝。普通 markerless legacy 与 v2 的 positional separator 不受影响。

### 3. 跨台账引用

`ProseReference` 增可选 `external?: string`。`proseReferences()` 对每个 `#N`，只在该 token **同一行且其前方**找到最近的外部台账上下文时标 external：显式 `X 台账 #N` / `ledger #N`，或外部台账文件路径后紧接着列出的 `#N`。外部标记只作用于其后紧接的引用列表；遇到句号、句末标点或以 `另见/参见/also/see` 开始的新分句即结束。若最近上下文是 `本台账` / `this ledger` 则按本台账引用。没有同一行外部上下文的裸 `#N` 不猜来源，仍保留 W271 与占号。这避免通过跨段落猜台账来源而误放过本台账编号。

### 4. prune 任意位置与 W250

`prunableArchive()`：

- 仍只接受 `v2` / `v3`；legacy 继续拒绝，文案改为 `legacy archive has no verified envelope boundary; repair it to v2/v3 before pruning`（或保留现有 reason 并补一句）。原因：legacy 的 `framingEnd` 在无 end marker 时兜底到 `section.line_end`，可能连同 payload 后的用户正文一起删除；payload snapshot 排除目标 id，无法发现这类丢失。
- 删除区间仍为 `heading .. framingEnd`。
- 删除前后用 `archivePayloadSnapshot(candidate, idText)` **和** `archiveFramingSnapshot(candidate, idText)` 比较，替代 `archiveByteInventory` 的块行区间比较。framing snapshot 取每个存活归档的 `heading .. framingEnd`（不含 `framingEnd` 之后的块尾空行），因此既保护标题/版本/start/end/metadata/frame，又忽略删块后前一块尾部多出的分隔空行。保留 `errorIdentity` 门禁与「end marker 后非空尾注拒绝」。

W250 文案改为：`Issue body kept in 附录 by close --keep-body (remove it with 'issuemd prune FILE ID' once reopen is no longer needed)`。`W250` 仍不参与 `--strict`；spec/SKILL 的 prune 契约同步更新。

### 5. `close --criteria` 的反斜杠读法

`criteriaPipeNote(criteria, raw)` 改为：

- 有 pipe 时保留现有 `W205` 句子；
- 当 `raw` 与 `unescapeCell(raw)` 不同（即输入含表格式转义）时追加：`--criteria was read as table-cell text; stored value is "…" (write \\\\| for a literal backslash before a pipe)`。开放关闭与已关闭单元格两条路径都传原始输入。

help/SKILL 明确：`criteria --criteria` 接受正文 Markdown 原文；`close --criteria` 接受表格单元格约定（`\|` = 字面竖线）。

### 6. 粗体强调句不是标签

`parseLabelLine()` 在 `LABEL_LINE` 前判断：独立粗体行以 `注意：` / `提醒：` / `重要提示：` / `警告：` 开头且句末有标点时，作为强调句返回 `undefined`（普通段落）。不把所有「内部冒号 + 句末标点」一概当散文，因为真实复核标题（如 `**第二十六轮复核（…）：仍未修。**`）需要继续作为边界。影响 `bodyLabels`、`labelBlock`、`criteriaBoundaryHints`，写入侧不变。`**验收判据：**`（冒号结尾）与 `**非目标**` 不受影响。

### 7. 输出与文档

- `check` 文本摘要：`N errors, M warnings · format X, artifacts Y · …`，其中 format = W202，artifacts = W201 + W250；为 0 的组不显示。
- W270 文案追加 `; close --keep-body and reopen refuse while this fence is unclosed`。
- `docs/spec.md` / `SKILL.md`：补 W201 密度（英文 ~34 B/行 → 300 行 ≈ 10 KiB；中文 ~113 B/行 → 300 行 ≈ 33 KiB）；写明读视图「逐字节一致」指 issues/计数/行号，snapshot 与 size 除外；补充 W268/W271/prune/W250 新语义。

## 回归与验收

- 单元/CLI：白名单正反例、列表延续正反例、三种复核标题（本台账/cafe 形态）、缩进非目标与 round23 真阳性。
- 归档：只遮信封的 fence/comment/raw HTML 三形态；`check` W269、`show`/`prune`/`reopen` 拒绝且字节不变；可见归档四路径不变。
- 三块 v3 归档分别删中间/末块 rc=0，其余 payload 逐字节不变；legacy 块仍被拒绝且文案说明边界不可验证；W250 文案含 `prune`。
- 跨台账：`Orca 台账 #558` / `cafe 台账 #999` / `ledger #12` 不报 W271、`new` 得下一号、显式 `--id` 不被拒；`本台账 #21` 仍报 W271 并占号；裸 `#21` 仍报并占号。
- `close --criteria 'a \| b'` stderr 给出存储读法；`criteria` 原文不变。
- `**注意：…。**` 不再是标签；`现象` 块含后段；`**关联**` 与 `**判据**：…` 仍是标签。
- 三份真实台账只读复测：`criteria` 前后逐字相同；W268 为 0（或只剩真阳性）；带显式外部台账前缀/同一行外部台账路径的引用不再报 W271；没有可识别外部上下文的裸引用仍报并保留占号行为；SHA-256 前后相同。
