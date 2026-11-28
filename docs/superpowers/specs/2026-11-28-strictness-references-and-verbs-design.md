# 第二十八轮设计：strict 分层、引用判号、判据终点与语义编辑动词

日期：2026-11-28
状态：待独立复审
关联：dogfooding #103、#104、#106、#107、#114、#115、#120、#123、#138、#140、#150、#151、#152

## 1. 背景

外部 dogfooding 台账最后两轮（第三十八、三十九轮）针对 `fd06e7a` 复核，主要结论仍然成立。用户已对四个口径拍板：

1. `--strict` 只对「数据保全 / 结构」类 warning 失败；W201、W202、W250、W264 只提示。
2. 裸写的跨台账引用只保护 `high-water + 1` 以内的号；更高的裸写视为历史/外部引用，不报 W271、不占号。
3. `#103` 的判据块终点采用「列表续接」规则。
4. 本轮同时处理 W264 指针标签、`criteriaItems`、`narrow`/review 动词，以及 Phase 1 的安全修复。

本设计把这些口径落成可实现的契约。用户已授权本轮按推荐执行、每阶段提交、最后 fast-forward 合入 `main` 并 push 一次。

## 2. 目标与非目标

### 目标

- 修复 `见本台账 #N` 被当外部引用、`new` 复用编号的 fail-open（#152）。
- 让 `--strict` 在长期台账上表达「数据是否安全」，而不是「是否有可机械消除的提示」（#106）。
- 让 W264 不把「判据（不变）」这类纯指针当成未计入判据（#138），并保留真·第二判据块的关闭守卫。
- 给 `#103` 一个确定的判据块终点：普通叙述后若没有续接同一列表，就不再算判据。
- 给 JSON 读视图增加按原始列表项切分的 `criteriaItems`，不改变扁平 `criteria`（#120/#123）。
- 增加 `narrow` 与 `body --append --before`，覆盖「追加复核、缩窄判据」两个高频动作（#140）。
- 补齐 `--version` 构建路径、`counts --markdown`、stderr 截断、`sync --criteria-labels` 内容守卫、close 文案（#107/#151/#104/#114）。

### 非目标

- 不改单元格 `；` 拼接格式，不做 `close → reopen` 的条目边界可逆（#120 判据 4 不承诺）。
- 不改归档 payload 的原始字节契约（#108/#144 继续按 `docs/spec.md` 的既有口径）。
- 不新增全文索引；`find` 仍是线性扫描。
- 不改变 W225 表、高水位、归档信封和 `prune` 的既有语义，除非本设计明确说明。
- 不实现通用的 `review` 动词；本轮只做 `narrow` 和 `--append --before`。

## 3. 跨台账引用与判号（#150 / #152 / #121 判据 4）

### 3.1 三分类

`proseReferences()` 目前只输出 `external?: string`。改为：

```ts
type ProseReference = {
  id: string;
  line: number;
  start: number;
  end: number;
  /** The nearest ledger mention names another file. */
  external?: string;
  /** An explicit mention of this ledger (`本台账`, `this ledger`, …). */
  local?: true;
};
```

`externalLedgerContext()` 返回 `{ external: name } | { local: true } | undefined`：

- 最近的 `X 台账` / `X ledger` 提及，若 `selfLedgerName(X)` 为真 → `{ local: true }`。
- 否则 → `{ external: name }`。
- 无提及，但 `ledger:` 前缀（且不是 this/the current）→ `{ external: "another ledger" }`。
- 句号 / `. ` / `；另见` 等作用域结束后，local 与 external 都失效，回到「裸写」。

`selfLedgerName(name)` 的实现：

1. 反复剥掉开头的引用动词/引导词：
   `请|另|参|详|关于|根据|依据|参考|记在|登记在|写在|列在|见|据|按|如|在`（按词逐个剥，`参见本` → `本`，`登记在本` → `本`，`根据本` → `本`）。
2. 剥掉后匹配 `^(?:本|该|这|此|同一|当前|current|本文|本文件|本文档|本份|这份|该份|当前这份|this)$`。
   `LEDGER_MENTION` 的捕获组在 `the current ledger` 里只能拿到 `current`，所以 `current` 必须单列。
3. 不做无边界后缀匹配，避免 `日本台账` 被误判为本地。

### 3.2 保留与上报规则

新增导出 `reservedProseReferences(ledger)`（或等价谓词），三处共用：

- `missingProseReferences()`（W271 来源）
- `cmdNew` 的 `proseReservations`
- `check` 的 W271 文案

谓词：

```text
external        → 跳过（不报、不占号）
local           → 保留（无论号多大）
bare            → 只有当 id 的数值 ≤ referenceCeiling(ledger) 时保留
```

`referenceCeiling(ledger) = max(maxIssueId(rows, unreadable), 所有有效 high-water 值) + 1`。

- `highWaterRecords()` 的 `value` 可能缺失（畸形 marker）；先过滤 `value == null`，否则 `Math.max` 得到 `NaN`，会让所有裸写都被当成「低于上限」。
- 无 high-water 时等价于「本台账最大号 + 1」，与测试者建议一致。
- `21a` 这类带后缀的号按数值部分比较。
- 裸写高于 ceiling 的号不再出现在 `check --json` 的 W271 里，也不阻止 `new`。
- `cmdNew` 的两个占号入口（`proseReservations` 与写入前的 `validateCandidate` 复核）都必须走 `reservedProseReferences`，不能只改其中一个。

### 3.3 文案

W271 文案保持「本台账未登记的编号」，但明确区分：

```text
Prose references #N, which is not tracked in this ledger. This ID is reserved against reuse here.
```

（现有文案已足够；本轮不新增措辞。）

### 3.4 验收

- `见本台账 #558`：W271=1，`new` 跳过 558（当 558 = max+1 时）。
- `见 #558`（max=152）：W271=0，`new` 不因它跳号。
- `见 #21`（max=20）：W271=1，`new` 得 22。
- `Orca 台账 #558`、`cafe 台账 #999`、`…/issue-20261023.md #558`：W271=0，不占号。
- 13 种 `本台账` 变体（见 #152 表）全部判 local。
- `日本台账 #3` 判 external（不因后缀误判）。

## 4. `--strict` 分层（#106 / #115 判据 3）

### 4.1 规则

`strictFailures` 排除集合：

```ts
const STRICT_EXEMPT = new Set(["W201", "W202", "W250", "W264"]);
```

理由：

- W201（体积）、W202（hash 格式）、W250（归档存在）、W264（附加判据块）都有独立守卫或机械出口；它们是「维护建议」，不是「当前数据不安全」。
- W261（无判据）、W265（高水位回退）、W268（判据歧义）、W269/W270（隐藏/未闭合归档）、W271（悬空引用）继续失败：它们代表可验证性、编号保全或归档可读性已经受损。
- 其余 warning（W206/W212/W220/W221/W240/W251/W252/W253/W260/W262/W263/W266/W267）保持现状。

### 4.2 输出

- 文本摘要已按 `format/artifacts/other` 分组；本轮不改格式。
- `--strict` 帮助文本改为：`fail on warnings except W201, W202, W250, W264`。
- `check --json` 不新增字段；`ok` 的计算只改 `strictFailures`。
- SKILL 的 warning 表逐条标注哪些不参与 `--strict`。

### 4.3 验收

- Orca 式台账（只有 W201/W250/W264）`--strict` exit 0。
- 有 W261 / W271 的台账 `--strict` exit 3。
- 单条 `W202` 不再让 strict 失败。

## 5. W264 指针标签（#138）

### 5.1 指针语义

标签匹配：

```ts
const CRITERIA_POINTER = /^(?:判据|验收判据)[（(](?:不变|同上|同\s*#\d+[a-z]?|见上文|参见上文|见前文)[）)]$/u;
```

注意：`追加判据` / `修复判据` 不是指针，不能进这个正则。

当一个 supplement 块同时满足：

1. 标签匹配 `CRITERIA_POINTER`；
2. 块内没有列表项（无序或有序 `LIST_ITEM` 都不存在，只看可见行）；
3. 块文本（`block.text`）整段匹配「可选上下文前缀 + 无变化断言」：

   ```ts
   /^(?:[^，,；;。]*[，,])?[ \t]*(?:判据)?(?:不变|未变|照旧|同上|同上所述|与上文一致|仍然成立|依旧成立|就是上面那条|见上文|参见上文|见前文)[。.!！]?$/u
   ```

则视为 `alreadyCovered`。

> 第 3 条是必要的安全边界：`**判据（不变）**` 后面如果写「同上，但还需离线通过。」，
> 它引入了新条件，必须继续报 W264。只有整段以「无变化」表述收尾才算指针。
> 现有测试 `only complete source-identical criteria repeats skip W264` 的三种 tail 中，
> 前两种由 source-key 去重覆盖，第三种必须仍报 W264。
> 空块本来就在 `text === ""` 时被跳过，白名单只负责「指向同一判据的短句」。

- `criteriaOccurrencesFromLabelBlocks()` 标记 `alreadyCovered: true`；
- `criteriaSupplementHints()` 不再报 W264；
- `close --criteria-from-body` 不再因它 exit 2；
- `sync --criteria-labels` 不把它列为可改名候选（避免改成第二个 `验收判据` 触发 W206）。

若指针块里包含列表项，仍按真·附加判据处理（保守）。

### 5.2 内容完全相同的块

现有 `criteriaSourceKey` 去重继续有效；指针规则是它的补充，不替代它。

### 5.3 文案

W264 改为：

```text
Possible additional criteria block is not included in the canonical criteria: L…: review **…**.
Merge it into **验收判据** (renaming it would create a duplicate label), close with --keep-body, or pass reviewed --criteria TEXT.
```

### 5.4 验收

- `**判据（不变）**` + 一行复核叙述：无 W264，`close --criteria-from-body` exit 0。
- `**判据（不变）**` + 列表：仍有 W264，close rc=2。
- 真·`**追加判据**` + 新内容：仍有 W264，close rc=2。
- 内容逐字相同的 `**追加判据**`：无 W264（既有行为不回退）。

## 6. 判据块终点（#103）

### 6.1 规则

在 `labelBlock()` 的「已有列表项 + 空行」分支中，把「后面是否还有列表」改为「后面是否续接同一列表」：

- 设 `lastMarker` 为块内最后一个可见列表标记（有序号或无序类型）。
- 空行后第一个非空、非缩进续行的**可见非围栏**行 `prose` 触发判定。
  - 若空行后直接是围栏定界行（`fenced[look-1]`），按现状跳过，不设 `ambiguousProse`
    ——这保持 round23「`1. A` / 空行 / fence / 粗体标签 / `2. B`」恰好一条 W268 的计数。
- 从 `prose` 向后找第一条 label / 标题 / 列表 / 围栏：
  - label 或标题 → 块在 `prose` 前结束。
  - 列表项：
    - 两者都有序且后者编号 > 前者 → 续接（`ambiguousProse = prose`，块继续）。
    - 两者都无序 → 续接。
    - 类型不同（有序 ↔ 无序）→ 不续接，块在 `prose` 前结束。
  - 缩进续行（`isListContinuation`）→ 续接。
  - 围栏开始 → 续接（fenced 示例可能属于判据；保留 W268 歧义提示）。
  - 普通叙述 / 块结束 → 不续接，块在 `prose` 前结束。

### 6.2 结果

| 形状 | 结果 |
|---|---|
| `1. A` / 空行 / 叙述 / 空行（无后续列表） | 块在叙述前结束（既有行为） |
| `1. A` / 空行 / 叙述 / 空行 / `- B` | 块在叙述前结束；`criteria` 只含 A |
| `1. A` / 空行 / 叙述 / 空行 / `2. B` | 续接；`criteria` 含 A、叙述、B；W268 报歧义 |
| `1. A` / 空行 / 叙述 / 空行 / `1. B`（重新从 1 开始） | 块在叙述前结束（新列表，不续接） |
| `- A` / 空行 / 叙述 / 空行 / `- B` | 续接；W268 报歧义 |
| `- A` / 空行 / 叙述 / 空行 / `2. B` | 块在叙述前结束 |
| `- A` / 空行 / 缩进续行 | 续接（多段条目） |
| `**验收判据**` / 空行 / 列表 | 完整读出（#29 不回退） |

### 6.3 交互

- `criteriaBoundaryHints()` 的 `ambiguousProse` 只在新规则仍续接时产生；W268 与 `close` 守卫保持。
- `criteriaItems` 跟随新的块边界。
- 现有 `round23`/`round25` 的真阳性用例必须继续通过；若某个用例依赖「不同列表也算续接」，按本规则更新期望并在测试名中说明。
  已确认一处：`src/criteria-boundaries.test.ts` 的
  `"ambiguous list boundary refuses destructive automatic close"` 里
  `复核状态。 / 1. 仍属判据？`（有序列表从 1 重新开始）现在应视为新列表，
  块在叙述前结束、无 W268；其余三条（缩进的 `**非目标**`、`**注意**`、围栏）不变。
- 空行后直接是围栏时不产生 `ambiguousProse`：round23 的
  `1. A / blank / fence / bold label / 2. B` 必须仍恰好一条 W268。

### 6.4 验收

- #103 最小复现：`criteria` 不含「当前状态：…」。
- `1. A` / 叙述 / `- B`：`criteria = "1. A"`，`close` 不再把 B 当判据。
- `1. A` / 叙述 / `2. B`：W268 + close rc=2（保守）。
- #29、fence、多段列表回归全绿。

## 7. `criteriaItems`（#120 / #123）

### 7.1 字段

在 `show --json` 与 `list --json --with-body` 的 issue 对象上新增（可选）：

```ts
criteriaItems?: string[];
criteriaJoined?: true;
```

- 开放项：按**原始 canonical 判据块的列表项**切分，`criteria` 字符串不变。
- 已关闭项：
  - 若存在唯一归档，且归档中提取的判据文本（`criteriaTextFromOccurrences`）与表格单元格逐字相同 → 用归档块切分。
  - 否则 `criteriaItems = [criteria]`；当单元格含 `；` 时附 `criteriaJoined: true`，表示条目边界已丢失。
- 无判据（undefined 或空串）→ 两个字段都不出现。

### 7.2 切分规则

`criteriaItemsFromOccurrences(occurrences)`：

1. 只取 `kind === "canonical"` 且 `text !== ""` 的块；按 `text` 去重（与 `criteriaTextFromOccurrences` 同口径）。
2. 每个块：
   - 跳过标签行；标签行冒号后的内联内容作为第一项的起始文本（若为空则忽略）。
   - 可见行逐行处理：
     - 空行：标记段落边界；下一个**非缩进**的新段落另起条目，缩进续行仍属当前条目。
     - 围栏定界行：跳过，且不清空当前条目（空行后的围栏仍是当前条目的示例）。
     - 列表项（`LIST_ITEM`，可见）：flush 当前条目，去掉标记后作为新条目。
     - 其他行：拼到当前条目（用单个空格连接）。
     - HTML 注释隐藏行：跳过。
   - 若最终没有任何条目但 `block.text` 非空 → `[block.text]`。
3. 跨块按出现顺序拼接。

例：

```text
**验收判据**

1. 第一条；它自己含分号
2. 第二条
```

→ `["第一条；它自己含分号", "第二条"]`。

两段 canonical（`1. A` 与 `1. C` / `2. D`）→ `["A", "C", "D"]`；不重新编号、不合并文本。

### 7.3 非目标

- 不从扁平单元格反推条目（明确 `criteriaJoined`）。
- 不改变 `criteria`、`criteriaBlocks`、`criteriaSource`。

### 7.4 验收

- 最小复现 `.criteriaItems | length` = 2，`[0]` 含分号。
- 两块 canonical → 3 个条目。
- `list --with-body` 与 `show` 逐条相等。
- 已关闭项：无归档 → 单条目 + `criteriaJoined`；归档与单元格一致 → 真条目。
- 单块正文行为与既有测试一致。

## 8. `narrow` 动词（#140）

### 8.1 用法

```text
issuemd narrow FILE ID --criteria TEXT [--status S]
                 [--note TEXT | --note-file PATH]
                 [--dry-run] [--if-unchanged SNAPSHOT]
```

一次原子完成：

1. 用 `editOpenCriteria()` 替换唯一 canonical `**验收判据**` 块（沿用 #147 的保护：多块、歧义、竞争标签都拒绝）。
2. 可选地把状态改成另一个**开放**状态（`未决` / `部分解决` / `观察` 等）；闭合状态拒绝并提示用 `close`。
3. 可选地在判据块之前插入一条带日期的复核记录：

   ```text
   **复核记录**：YYYY-MM-DD <note 第一行>
   <note 其余行>
   ```

   若正文已有 `复核记录`，使用 `复核记录 2`、`复核记录 3` 避免 W206。
4. 三项都无变化 → `(no changes)` exit 0。

### 8.2 校验

- `ID` 必须是开放项；已关闭项 exit 2，提示 `close --criteria`。
- `--criteria` 必须是一行非空 Markdown，且不含 `<!--` / `-->`（与 `criteria` 命令同一校验）。
- `--note` 与 `--note-file` 互斥；note 内容不得含顶层标题（`#`/`##`）、HTML 注释定界符，
  或用 `parseLabelLine()` / `isCriteriaLabel()` 能识别的标签行（包括判据标签）。
- 三步编辑之间**重新解析**候选台账，不按旧的绝对行号继续拼接：
  1. 用 `editOpenCriteria()` 替换判据；
  2. 重新解析，找 canonical 标签行，用 `insertBlock()` 插复核记录；
  3. 重新解析，找开放行，用 `replaceCell(..., 1, status)` 改状态。
- 写前候选必须满足：
  - 提取出的 `criteria` 与 `--criteria` 逐字相同；
  - 相对基线不新增 W268 / W264 / W206 / W261；
  - 状态单元格只按请求改变；
  - `commit()` 的既有 error 门禁不变。
- 失败时不写盘，exit 2/3 按现有约定。

### 8.3 输出

- 成功：`wrote FILE #ID narrowed (snapshot …)` + 逐项 `criteria updated at L…`、`status 未决 → 部分解决`、`note inserted at L…`。
- `--dry-run`：unified diff + snapshot，不写。
- note 的日期来自本地时钟；测试用 `\d{4}-\d{2}-\d{2}` 断言，不写死日期。

### 8.4 验收

- 未决项的 criteria + status + note 一次写入；`check` 0 error；不新增 W264/W268。
- 只给 `--criteria` 时状态不变。
- 已关闭项、竞争判据、歧义正文、闭合状态都 exit 2 且字节不变。
- `--dry-run` 与真跑 diff 一致。

## 9. `body --append --before LABEL`（#140）

### 9.1 用法

```text
issuemd body FILE ID --body-file PATH|- --append --before LABEL
```

- `--before` 只能与 `--append` 同用；单独出现 exit 2。
- `LABEL` 精确匹配 `labelName`（`**验收判据**` 与 `验收判据` 等价）。

### 9.2 行为

- 在开放项正文里找唯一匹配的可见标签行：
  - 0 个 → exit 2，列出该 issue 的可用标签（按出现顺序）。
  - 多个 → exit 2，列出各自行号，要求人工处理。
- 用 `insertBlock(lines, labelLine, addition)` 插在该行之前（自动补分隔空行）。
- 候选必须满足（插入在判据之前会让后续行号整体下移，不能比较绝对行号）：
  - `criteriaTextFromOccurrences()` 前后逐字不变；
  - 每个判据块的 `{label, kind, lines}`（不含 `line`）前后逐项相同；
  - `criteriaBoundaryHints()` 按 `detail` 的多重集合比较，不按 `line`；
  - 不新增 W268、W264、W261；
  - 追加内容不得包含判据标签（沿用现有 append 守卫）。
- 失败 exit 2，字节不变。

### 9.3 文档

- SKILL/spec 示例：把复核段放在判据之前时应自带标签：

  ```text
  **复核记录**：2026-11-28 …
  ```

  否则内容会归属到前一个标签块。

### 9.4 验收

- `--append --before 验收判据`：新段落在判据前，`criteria` 逐字不变，`check` 不新增 warning。
- 不存在的标签：exit 2 并列出可用标签。
- 多标签同名：exit 2 带行号。
- 追加内容含 `**验收判据**`：exit 2。
- 原有 `--append` 行为不回退。

## 10. Phase 1 小修

### 10.1 #151：close override 截断

`overrideNote` 的旧/新判据超过 120 字符时：

```text
#N closing criteria override: "前 117 字符…" (941 chars) → "新判据"
```

- `(no changes)` 时不打印。
- `--dry-run` 同样截断；stdout diff 仍完整。
- 回归：正常长度判据的回显不变。

### 10.2 #107：构建路径

`issuemd --version` 输出：

```text
0.1.0 (build: /absolute/path/to/dist/src)
```

- 第一 token 仍是 semver，满足 #107 判据 4。
- 路径来自运行中 `cli.js` 的 `import.meta.url`。测试通过进程内 `run()` 时它是 `src/cli.ts`
  所在目录（不是 `dist`），所以断言只要求「绝对路径 + 以 `/src` 或 `/dist/src` 结尾」；
  真实全局命令会打印 checkout 的 `dist/src` 绝对路径。
- `--help` 的 version 行更新。

### 10.3 #104：sync --criteria-labels 内容守卫

- 默认只有「块内至少一个可见列表项」的候选才会自动改名。
- 否则 `skipped #N: block has no list items; pass --force to rename it anyway`。
- `--force` 才允许改无列表项的块。
- 已有 canonical 时的 skip 语义不变；指针块不进入候选。
- 回归：带列表的近邻标签仍自动改名；W261 场景仍可用；`--dry-run` 一致。

### 10.4 #114：close 体积文案

缺判据报错改为：

```text
Pass --status S --criteria TEXT to record a conclusion, --no-criteria to leave the cell empty
and delete the body (the file shrinks), or --keep-body to retain evidence in 附录
(the file grows; prune later when reopen is no longer needed).
```

### 10.5 counts --markdown

- 新增 `--markdown`：输出一条可直接粘进头注的 Markdown 列表项：

  ```text
  - open 24 (未决 13, 部分解决 11) · closed 127
  ```

  与 `counts` 的纯文本行（`open 24 (...)   closed 127`）不同，便于直接粘进 Markdown。
- `--markdown --json` → exit 2。
- 与 `check` 的 open/closed 和子状态数逐字一致。

## 11. 兼容性与迁移

- 所有 JSON 变更都是新增可选字段；`criteria`、`criteriaBlocks`、`criteriaSource` 不变。
- `--strict` 只会更宽松，不会让原本绿的台账变红；原本因 W201/W202/W250/W264 红的台账会转绿，这是本轮目的。
- W271 只会减少（裸写高于 ceiling 的引用不再报），显式 `本台账` 引用不减少。
- 判据块终点变化会让一部分 `criteria` 变短（去掉误吞的叙述）；`criteriaBlocks` 会相应减少被误算的行。这是修复，不是数据丢失——原文仍在正文。
- `sync --criteria-labels` 默认更保守；需要旧行为的调用方加 `--force`。
- 文档必须同步的既有断言（否则文档与实现矛盾）：
  - `docs/spec.md:332`：W264 的 `--strict` 失败描述；
  - `docs/spec.md:335`：裸写 `#N` 的占号/复用描述（加 ceiling）；
  - `skills/issuemd/SKILL.md:112`：`--strict` 的「except W250」；
  - `skills/issuemd/SKILL.md:119`：W201「It fails `--strict`」；
  - `skills/issuemd/SKILL.md:130`：裸写引用「reserves/refuses reuse」。
- `criteriaAliasRepair()` 是 `new`/`body` 的 W261 提示共用的；本轮只把「指针已覆盖」过滤放进
  该函数（提示理应消失），列表项/`--force` 门禁只放在 `sync --criteria-labels`，
  以免改变写入期提示。

## 12. 测试与集成

- 新增测试文件（沿用 bun:test + `run()`）：
  - `src/reference-ceiling.test.ts`（#150/#152）
  - `src/strict-tiers.test.ts`
  - `src/criteria-pointers.test.ts`（#138）
  - `src/criteria-termination.test.ts`（#103）
  - `src/criteria-items.test.ts`
  - `src/narrow.test.ts`
  - `src/append-before.test.ts`
  - `src/cli-version-counts.test.ts`（#107/#140）
  - `src/close-override.test.ts`（#151）
- 回归：`npm run typecheck && npm test && npm run build`。
- 只读复测：dogfood 台账 W271 从 22 降到 ceiling 内的数量；`--strict` 只剩 W201/W271（W271 视引用而定）。
- 每阶段一个 commit；全部完成后 fast-forward 合入 `main`，build，按用户本轮授权 push 一次。

## 13. 备选方案与取舍

- **strict 只豁免 W264**：不能解决 W201 造成的长期 exit 3；用户已选更宽的分层。
- **W264 用内容包含判定代替指针白名单**：无法覆盖「判据（不变）」这类语义指针；指针白名单更可解释。
- **#103 只在显式标签处结束**：会让叙述继续被吞，不符合用户选择的规则。
- **criteriaItems 从扁平字符串 split**：会把含分号的条目拆错，正是 #120 的问题；必须按原始块切。
- **narrow 做成通用 review**：API 面更大、语义更模糊；先做窄动词，必要时下轮扩展。
- **裸写全部不占号**：会让 `见 #12` 失去保护（#121 判据 4 回退）；ceiling 方案保留低号保护。
