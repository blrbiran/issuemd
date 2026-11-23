# issuemd 规格（v1）

> **一句话**：`lilmd` 让 agent 便宜地读一节；`issuemd` 让「状态表、正文、计数」三处**结构上不可能对不上**。
> **形态**：CLI（lilmd 的超集）+ skill。单文件、纯 Markdown、零运行时依赖。
> **现场**：`cafe_dogfooding/issue-20261119.md`（2663 行）与 `orca_dogfooding/issue-20261023.md`（2107 行），均为真实台账。
> 本文所有数字都是本机实测，命令与原始输出见附录 A。

## 1. 结论

### 1.1 四句话

1. **格式已经收敛，但收敛到了三个结构缺陷上。** 两份台账自发长成同一个形状（表定状态、按编号放正文、已关闭只留判据），orca 甚至手写了 46 行 `check-issues.mjs` 去守它。缺的不是格式，是把格式变成命令。
2. **现状的漂移不是手误，是结构必然。** 实测 cafe 有 **27/28** 条正文标题与表摘要不一致、**47/48** 条已修记录的标题在两张表之间也不一致。这些不一致**无法靠纪律修好**，因为它们源自「同一个东西存了三份」。
3. **最合理的格式不是二选一，而是分层：** 一份**规范格式**（canonical），让不变量在结构上成立；一份**兼容层**，能原地读写现存两种布局。`issuemd` 两者都做，并用 `migrate` 把旧台账搬过去。
4. **写路径不能照抄 lilmd。** 实测 lilmd 0.5.0 有 7 个会**静默改错**的行为（BOM 吞掉首个标题、`promote` 造出两个 H1、重复标题只改第一个、CRLF 混写、stdin body 文案说谎、fence 内 `#` 被改写、无表感知）。issuemd 必须 fork 后逐个修掉。

### 1.2 一句话记忆

> **表是索引，正文是记录，判据只存一份，计数从不落盘。**

### 1.3 不做什么

- **不做 SQL 写入层。** mdsql 的 `rewrite_table()`（`src/markdown.rs:68-115`）改一行会重写整张表：列宽重算并重新 padding、`extract_text()` 只拼 `NodeValue::Text` 导致行内代码/链接退化、`content.lines()` 把 CRLF 归一成 LF。这是反面教材。
- **不引入新文件格式。** 台账仍是一个 `.md`，仍能被 `lilmd` 和 `cat` 读。
- **不做多文件台账、GitHub 同步、服务端。**
- **不接管 handoff。** handoff 是自由文本，`lilmd` 够用。

---

## 2. 现状格式为什么不合理（量化）

这一节的每条结论都有实测支撑；它们是后面格式设计的**依据**，不是抱怨。

### 2.1 缺陷一：同一个「标题」存了三份，于是必有漂移

cafe 里同一条 issue 的标题存在于：状态总览第 4 列、已关闭表摘要列、正文 H3。三份各自演进：

| 比较 | 不一致 | 总数 |
|---|---|---|
| 正文 H3 ↔ 状态总览 | **27** | 28 |
| 已关闭表摘要 ↔ 状态总览 | **47** | 48 |

```text
#6   状态总览: 心跳测试钩子 + fake Codex 的 interrupt-before-waiter 修复；全量连续多轮 276/276
     已关闭表: 心跳测试钩子 + fake Codex 的 interrupt-before-waiter
#1   状态总览: `findCafeFile` 把目录当 `.cafe`；`~/.cafe` 遮蔽整个 `$HOME`，`loadIdentity` 抛 EISDIR，pi 扩展静默失效
     已关闭表: `findCafeFile` 把目录当 `.cafe`，`~/.cafe` 遮蔽 `$HOME`
```

**根因不是懒，是列语义被写坏了**：第 4 列在已关闭项上写「当前进展 + 验收结果」，在开放项上写「问题描述」。同一列承担两种职责，任何一个改动都会让三份副本分叉。

数据佐证：开放项的表摘要里有 **5/28** 含 `已落地 / 仍缺 / 仍逐 / 仍走` 这类进展词（`#27 #31 #33 #34 #39`），而正文标题只有 0 条含。也就是说表在「汇报进度」，正文在「描述问题」——它们本来就不该相等。

### 2.2 缺陷二：计数写进标题，导致选择器和文档一起漂

orca 用 `## 待处理（16）`、`### 已修（212）`、`### 决定不改（7）` 编码计数。代价有两层：

**第一层，计数会错。** 按编号数（不是行数，见 2.5）重算：

| 小节 | 声明 | 实际编号数 |
|---|---|---|
| `已修（212）` + 7 个续节 | **212** | **211** |
| `owner 裁决不跟踪（23）` | 23 | 23 |
| `决定不改（7）` | 7 | 7（2 行） |
| `延后（6）` | 6 | 6 |
| `不是缺陷 / 产品裁决（7）` | 7 | 7（3 行） |
| `未分类（5）` | 5 | 5（1 行） |
| `范围外（3）/撤回（3）/并入（3）` | 3/3/3 | 3/3/3 |

作者的计数纪律其实很好，只错了 1 处——但**只要计数写在标题里，就永远有这一处**。

**第二层，标题变成不稳定选择器。** handoff 里出现过三种互不兼容的读法：

```bash
lilmd issue-20261023.md "/^待处理（13）$/"   # 当时 13
lilmd issue-20261023.md "/^待处理（31）$/"   # 后来 31
lilmd issue-20261023.md "/^待处理（50）$/"   # 后来 50
```

历史声明值 `已修（32）`、`已修（139）`、`已修（175）` 也都出现过。**每次计数变化，所有引用它的文档都得跟着改**，而不改也不会报错，只是悄悄读不到。

### 2.3 缺陷三：冗余的第二张全量表，等于 48 个额外漂移点

cafe 的「状态总览」是**全量 76 行**（48 已修 + 28 开放），而「已关闭」表另有 48 行。这 48 条在两个地方各存一份摘要，实测 47/48 已经不一致。

一个可以验证的观察：**48 条已修行与已关闭表的编号集合完全相等**。这说明第二张表没有携带任何「状态总览」没有的信息——它只是一个重复视图。重复视图应当**计算得出**，不该手工维护。

orca 恰好相反：`## 待处理` 只放 16 条开放项，与已关闭表**零交集**。所以 orca 的 16 条正文标题 0 不一致，cafe 的 28 条里 27 条不一致——差别不在纪律，在**有没有冗余副本**。

### 2.4 缺陷四：承载富文本的列 + 非法表格（渲染层直接坏掉）

**4a. 表格单元格装不下正文需要的结构。** orca 正文用 **125 个 `**加粗标签**`、0 个 H4**；cafe 用 **174 个 H4、0 个加粗标签**。两种风格都合理，但表格单元格既不能放多行，也不能放列表，还要求转义 `|`（orca 台账里确有 `keep-local\|keep-remote`）。让表格同时当「状态源」和「摘要源」，就等于强迫作者把记录压缩成一行。

**4b. orca 有 11 个管道块不是合法 GFM 表格。** 实测：

```bash
pandoc -f gfm orca_dogfooding/issue-20261023.md -t html | grep -c '<table'   # 17
pandoc -f gfm orca_dogfooding/issue-20261023.md -t html | grep -c '^<p>|'    # 11
```

11 个块（**90 行**）缺 `|---|` 分隔行，**包括整个「待处理（16）」区和 `已修（212）` 的前五个续块**。渲染结果是它们被合并成一段 `<p>`，内容里夹着字面 `|`：

```html
<p>| 416 | ccmem 的 Codex 接入与省 context 策略：hooks 已装但未 trust… | | 429 | syncskill 没有“删技能”命令…</p>
```

对 `lilmd` 无碍（按行扫描），但**任何人用浏览器 / GitHub / 编辑器预览时，最需要看的「待处理」清单是一段乱码**。cafe 的 43 个管道块全部合法。

### 2.5 三个必须记住的口径（写错就会误报）

| 口径 | 事实 | 写错的后果 |
|---|---|---|
| **按编号计数，不按行计数** | 一格可写多号：`\| 20, 24, 29, 38, 40, 55 \|` 是 6 个编号，`\| 101 / 104 \|` 是 2 个 | 按行算会把 5 个合法小节全部误报（7 vs 2、5 vs 1…） |
| **L1 与 L2 的「状态表 ↔ 已关闭表」语义相反** | cafe：状态表含已修，与已关闭表**必须完全相等**；orca：两表**必须不相交** | 套一条规则会误报 cafe 的 48 条合法冗余 |
| **解析单位是「管道块」，不是「GFM 表格」** | 无分隔行的块没有表头——把首行当表头，会把 16 条待处理读成 12 条 | 直接漏掉 4 条（实测过） |

---

## 3. 规范格式（canonical，v2）

设计目标：**让 2.1–2.4 的四类缺陷在结构上无法表达**。

### 3.1 五条结构决定

| # | 决定 | 消灭了哪个缺陷 |
|---|---|---|
| **S1** | 索引表**只放开放项**；已关闭项只存在于「已关闭」表 | 2.3（无冗余副本） |
| **S2** | **开放项**标题存两份（索引摘要 + 正文 H3），由 `rename` 一次事务同改；**已关闭项**标题只存一份（已关闭表摘要），且不留正文 | 2.1（三份 → 两份/一份） |
| **S3** | **计数不出现在任何标题里**；`## 索引`、`## 已关闭` 是固定标题 | 2.2（选择器永不漂移） |
| **S4** | 表摘要写**稳定标签**（是什么），进展写正文；判据只存一处 | 2.1（列语义单一） |
| **S5** | 所有表格必须有 `\|---\|`；`issuemd sync --fix-tables` 可修 | 2.4b（渲染不再坏） |

### 3.2 骨架

```markdown
# <Project> Issue 台账

> 唯一台账 + 唯一正文。状态只在下表；正文不写状态。编号不回收。
> 读法：`issuemd list <file>` / `issuemd show <file> <id>` / `issuemd check <file>`
> 现场不写死 HEAD，用 `git log --oneline -3` 现查。

## 怎么用

<!-- issuemd:guide:begin -->
（工具生成的命令表；`issuemd sync` 会重写此块，块外文字不动）
<!-- issuemd:guide:end -->

## 状态口径

| 状态 | 分类 |
|---|---|
| 未决 | open |
| 部分解决 | open |
| 观察 | open |
| 已修 | closed |
| 延后 | closed |
| 决定不改 | closed |

## 索引

| # | 状态 | P | 摘要 |
|---|---|---|---|
| 65 | 未决 | P0 | loopback 免 token 且不校验 Origin/Host |
| 31 | 部分解决 | P1 | Thread 事件热路径逐条同步落盘 |

## 已关闭

| # | P | 摘要 | 判据 |
|---|---|---|---|
| 6 | P3 | 心跳测试钩子 + fake Codex interrupt-before-waiter | `70e0b26`：全量连续多轮 276/276 |

## 正文

### Issue 65: loopback 免 token 且不校验 Origin/Host

**现象**：…
**根因**：…
**期望**：…
**验收判据**：…
```

与现状相比只有 5 处变化：索引只放开放项、去掉标题里的计数、已关闭表删掉重复摘要的来源、正文标题与索引摘要一一对应、guide 用受控块包起来。**旧台账可以逐条搬过来，没有信息损失。**

### 3.3 不变量

| 编号 | 不变量 | 级别 | 依据 |
|---|---|---|---|
| I1 | 每条正文块在「索引」里有且仅有一行；每行有且仅有一条正文块 | error | `check-issues.mjs` 已有 |
| I2 | 正文块按编号严格升序、编号唯一 | error | 同上 |
| I3 | 正文 H3 标题 == 索引摘要（trim + 压缩空白后逐字相等） | error | 消灭 2.1 |
| I4 | 「索引」与「已关闭」编号集合**不相交** | error | S1 |
| I5 | 正文区不出现 `**状态**` 行 | error | 两份台账均为 0，纪律已被接受 |
| I6 | 任何标题不含 `（N）` 计数 | error | S3 |
| I7 | 所有表格必须有分隔行 | error | S5 |
| I8 | 所有状态词在「状态口径」表中声明过 | warn | 词表是团队的，不替人裁决 |
| I9 | 「状态口径」声明的 open/closed 分类与实际使用一致 | warn | 防止把 open 项写进已关闭表 |

> I6/I7 在规范格式里是 **error**，在兼容层里降为 **warn**（旧的 orca 台账有 11 处非表格、cafe 有计数标题，不能一上来就红）。`--format=canonical` 时升为 error。

### 3.4 为什么这样比 orca 更合理（而不是更啰嗦）

orca 用「一个状态一个小节」表达分组，代价是**换状态要跨表移动行**，而跨表移动是最难做对的行级操作（要重算两处计数、保持各自升序、处理小节合并）。canonical 用**一张表 + 状态列**：

- 换状态 = 改一个单元格（1 行 diff，无搬移）；
- 分组读 = `issuemd list --status 未决`（视图，不落盘）；
- 计数 = `issuemd counts --json`（计算，不落盘）。

也就是说：**把「分组」和「计数」从文档结构里搬到查询里**。这是本设计最大的简化。

代价是单表会变长（开放项通常 10–50 行，可接受）；已关闭表仍然会很长，但它只是判据仓库，本来就该用 `issuemd list --closed` 或 `grep` 去查。

---

## 4. 兼容层（adopt 现存台账，零迁移）

`issuemd` 必须能原地读写现有的两种布局，否则无法落地。

### 4.1 L1（cafe 型）

一张**全量**表，状态是列。语义：`closed 状态行集合 == 已关闭表编号集合`。

### 4.2 L2（orca 型）

状态由 H3 标题承载，行内不写状态。语义：两表**不相交**。

### 4.3 识别顺序

1. 索引区表头含 `状态` 列 → **L1**。
2. 索引区的状态由 H3 标题首位状态词承载 → **L2**。
3. 都不匹配 → `E120`，打印看到的表头与前 3 行。

`--layout l1|l2|canonical` 可强制。

### 4.4 `issuemd migrate`

```bash
issuemd migrate old.md --to canonical --dry-run
```

一次性把 L1/L2 转成 canonical：删掉索引里的已修行（信息已进已关闭表）、去标题计数、补分隔行、正文标题对齐索引摘要（默认 `--prefer=body`，因为正文标题更接近「问题描述」；`--prefer=table` 则用表摘要）。

`migrate` 的输出必须能被 `check --format=canonical` 判为 0 error，并且**逐字节 diff 只包含预期改动的行**。

**无损规则**：若旧表摘要比正文标题多出的文字含进展词（W260 的判据），`migrate` **不许静默丢弃**——它把这些文字作为一行 `> **进展（来自旧表）**：…` 追加到该条正文末尾，并在输出里列出「N 条摘要被搬进正文」。这是 `migrate` 与 `sync` 的关键区别：`sync` 对齐格式，`migrate` 保证信息守恒。

---

## 5. 语义模型与解析规则

### 5.1 逻辑模型

```text
Ledger
├── head:     H1 + 引用块（自由文本）
├── guide:    怎么用 / 状态口径（工具只重写受控块）
├── index:    开放项（canonical/L2）或全量（L1）
├── closed:   已关闭（只留判据）
├── body:     正文（按编号）
└── issues:   [{id, status, priority, title, criteria?, bodySection, rowRef}]
```

### 5.2 管道块 vs GFM 表格

- 解析单位是**管道块**：连续以 `|` 开头的行。
- 分隔行（`|---|`）**可选**；有则首行是表头，无则全部是数据行。
- 无分隔行的块仍必须解析出编号（否则 orca 的 16 条会漏 4 条），同时报 `W207`/`E121`。

### 5.3 单元格

1. 只在**未转义**的 `|` 处切分（`\|` 属内容）。
2. 每格 `trim()`。
3. 格数 != 表头格数 → `E108`，报行号与两边格数。
4. **不做内联 markdown 解析**：反引号、链接原样保留。
5. **编号单元格支持多号**：提取第 1 列全部 `\d+[a-z]?`。

### 5.4 编号

`\d+[a-z]?`（实测有 `393b`）。为正，不回收；`issuemd new` 取 `max+1`。

### 5.5 列映射

| 区 | 表头 | 语义 |
|---|---|---|
| canonical index | `# \| 状态 \| P \| 摘要` | 直接映射 |
| L1 index | `# \| 状态 \| P \| 标题` | 同上 |
| L2 index | `# \| 摘要 \| 判据` | 状态来自 H3 标题 |
| closed | `# \| P? \| 摘要 \| 判据/裁决/说明` | **按表头名**映射，缺列降级 warn |

实测 closed 表头至少 5 种：`#|P|摘要|判据`、`#|摘要|判据`、`#|摘要|裁决`、`#|判据`、`#|说明`。

---

## 6. 状态词表

| 状态 | 分类 | 出现于 |
|---|---|---|
| `未决` | open | cafe ✓ orca ✓ |
| `部分解决` | open | cafe ✓ orca ✓ |
| `观察` | open | cafe ✓ |
| `已修` | closed | cafe ✓ orca ✓ |
| `延后` | closed | orca ✓ |
| `决定不改` | closed | orca ✓ |
| `不是缺陷` | closed | orca ✓（含「/ 产品裁决」变体） |
| `范围外` / `撤回` / `并入` / `未分类` | closed | orca ✓ |

canonical 里词表**写在文档内**（`## 状态口径` 的表格），这样台账自解释、`check` 可交叉验证。配置文件可覆盖。

`issuemd.config.json`（可选，向上查找）：

```json
{
  "sections": { "index": ["索引", "状态总览", "待处理"], "closed": ["已关闭"], "body": ["正文"] },
  "layout": "auto",
  "statuses": { "open": ["未决", "部分解决", "观察"], "closed": ["已修", "延后", "决定不改"] },
  "idPattern": "^\\d+[a-z]?$",
  "limits": { "bodyWarnBytes": 20480, "bodyWarnLines": 300 },
  "lint": { "pinnedHash": true }
}
```

---

## 7. check 规则

### 7.1 errors（退出码 3）

| 码 | 规则 | 依据 |
|---|---|---|
| E101 | 正文块有、索引无对应行 | 2.3 的 `lilmd rm` 现场 |
| E102 | 索引行有、正文块无 | 同上（反向） |
| E103 | 同一表内编号重复 | `check-issues.mjs` |
| E104 | **L1**：索引 closed 行集合 ≠ 已关闭表；**L2/canonical**：两表交集非空 | §2.5 口径 |
| E105 | 正文块未按编号升序 | `check-issues.mjs` |
| E106 | 正文 H3 标题 ≠ 索引摘要 | cafe 27/28 |
| E107 | 正文出现 `**状态**` 行 | 两份台账均 0 |
| E108 | 行格数 ≠ 表头格数 | 新增 |
| E109 | 编号不匹配 `idPattern` | `393b` |
| E120 | 无法识别布局 | 新增 |
| E121 | 标题含 `（N）` 计数（canonical 强制；兼容层 W230） | §2.2 |
| E122 | 表格缺分隔行（canonical 强制；兼容层 W207） | §2.4b |

### 7.2 warnings

| 码 | 规则 |
|---|---|
| W201 | 缺少骨架标签（仅 `skeleton.mode: on`） |
| W202 | 单条正文超 `limits` |
| W203 | 出现疑似写死的短哈希（`\b[0-9a-f]{7,40}\b`） |
| W204 | guide 里点名的标题在文档中不存在（**只查存在性，不查数量**，避免「四个顶层节」这类口径歧义） |
| W260 | 索引摘要含进展词（`已落地/仍缺/仍无/仍逐/仍走`），而正文标题不含：说明列语义已混用，覆盖前需确认进展信息不丢 |
| W205 | 单元格含未转义 `\|` |
| W206 | 同一条内标签/小标题重复 |
| W207 | 管道块缺分隔行（兼容层） |
| W210 | 表头有未映射的多余列 |
| W211 | 编号 ≤ 历史最大编号（疑似复用） |
| W220 | 未在「状态口径」声明的状态词 |
| W230 | 标题里的 `（N）` 与实际编号数不符（兼容层；orca 有 12 个计数标题、其中 1 个错） |
| W240 | `--verify-commits` 时 commit 不存在 |

### 7.3 `--verify-commits`（默认关）

扫描短哈希 → `git cat-file -e <sha>^{commit}`；缺失报 `W240`。（来自用户真实动作：cafe 台账重构时手工核对了 13 个 commit。）

### 7.4 输出契约

```text
$ issuemd check issue-20261119.md
layout: l1   sections: index=状态总览 closed=已关闭 body=正文
open 28 (未决 20, 部分解决 7, 观察 1)   closed 48
error E106 x27
  L455  #16  body: `$cafe` 已被 Codex 注入 skill，模型仍先本地查代码
             row : `$cafe` 已被 Codex 识别并注入 skill，模型仍本地改…
  … (26 more, use --json for all)
warning W260 x5
  L47   #31  摘要: 尾部读 + meta 上限 + 事件字节计数已落地；仍逐事件同步 append…
             body: Thread 事件热路径逐条同步落盘…（表里多出的「进展」会丢）
error 27，warning 5。
`issuemd sync FILE --titles --prefer=body --move-progress --dry-run` 可预览修复
（不加 --move-progress/--drop-progress 会拒绝执行：覆盖会丢掉 5 条进展）。
```

`--json` 时 stdout 只有 JSON：

```json
{
  "file": "issue-20261119.md",
  "layout": "l1",
  "counts": { "open": 28, "closed": 48, "byStatus": { "未决": 20, "部分解决": 7, "观察": 1, "已修": 48 } },
  "errors": [{ "code": "E106", "id": "16", "line": 455, "expected": "…", "actual": "…" }],
  "warnings": [{ "code": "W207", "line": 45, "message": "管道块缺分隔行" }],
  "ok": false
}
```

---

## 8. 台账写操作

三条共同约束：

1. **原子**：算新内容 → 写同目录临时文件 → `fsync` → `rename`。任一校验失败不落盘。
2. **行级**：未涉及的物理行按原字节照抄（CRLF / BOM / 无尾换行）。diff 只含预期行。
3. **可预演**：`--dry-run` 输出 unified diff 并 exit 0。

### 8.1 `new`

```bash
issuemd new FILE 77 --title "Web 侧栏宽度不可调" --status 未决 --priority P2 --dry-run
```

事务：校验编号未用且 > `max`（否则 W211）→ 插入索引行（升序）→ 插入正文骨架 → 若目标管道块缺分隔行则补上（diff 显式体现）→ 内存重跑 check → 落盘。

写**正文骨架**时可按 `skeleton.mode` 生成 `**现象** / **根因** / **期望** / **验收判据**` 标签（canonical 默认标签式，与 orca 风格一致；`--skeleton=h4` 生成 cafe 风格）。

### 8.2 `close`

```bash
issuemd close FILE 57 --criteria-from-body   # 或 --criteria "…"
```

事务：从索引删行 → 从正文删块（`--keep-body` 时保留并 warn W250）→ 已关闭表按编号插入 → 若 `--criteria-from-body`，把正文里 `**验收判据**` / `#### 验收判据` 的内容提升为判据列（**这是判据去重的关键**：开放时判据在正文，关闭后判据在表，任何时刻只有一份）。

### 8.3 `status`

只在 open↔open 或 closed↔closed 内改（改单元格；L2 需移行）。跨分类必须 `close`/`reopen`：

```text
$ issuemd status FILE 56 已修
error: #56 当前 观察（open），目标 已修（closed）跨分类，请用 issuemd close
```

### 8.4 `rename`（修 cafe 27/28 的那条）

同时改索引摘要与正文 H3，一次事务、要么都不改。新标题含 `|` 时自动转义并 W205。

### 8.5 `counts`

```bash
issuemd counts FILE [--json] [--fix]
```

输出每个小节/每个状态的**编号数**。`--fix` 只在兼容层（L2）里重写标题里的 `（N）`；canonical 下 `--fix` 直接报「canonical 不应有计数」并 exit 2（因为 E121 是 error，修法是删计数而不是改数字）。

### 8.6 `sync`

只做机械修复：

| 开关 | 行为 |
|---|---|
| `--titles` | 对齐正文标题与索引摘要；**方向必须显式**：`--prefer body`（默认）把正文标题写回表格，`--prefer table` 反过来；命中 W260 时必须配 `--move-progress` 或 `--drop-progress` |
| `--counts` | 重写兼容层标题计数 |
| `--fix-tables` | 补 `\|---\|`（修 W207/E122） |
| `--guide` | 重写 guide 受控块 |
| `--move-progress` / `--drop-progress` | W260 护栏：搬运进展进正文 / 明确丢弃 |
| `--dry-run` | 输出 diff；须能验证「只改了 N 行」 |

`sync` 不删正文、不移行、不改状态。这条边界让 agent 敢无人值守跑 `sync --dry-run`。

**为什么默认 `--prefer body`**：实测 cafe 的表摘要里有 5/28 条含「已落地 / 仍缺 / 仍逐 / 仍走」这类进展词，而正文标题是干净的问题描述。默认 table→body 会把进展文字塞进 TOC、并丢掉原描述；默认 body→table 才符合 S4（进展属于正文）。

**但「覆盖」会丢信息，所以加护栏**：`sync --titles` 一旦命中 W260，**默认拒绝执行**并 exit 3，要求显式二选一：

- `--move-progress`：先把表摘要里多出的进展文字追加到该条正文（`> **进展（来自旧表）**：…`），再覆盖。**信息守恒**。
- `--drop-progress`：直接覆盖，明确承认丢失（diff 里保留 `-` 行，可 `git diff` 找回）。

这样「只改 N 行」这个承诺不会被悄悄违反：要么多出 N 行正文追加，要么你必须签字。

---

## 9. 写入安全

| 要求 | 判据 | 对应 |
|---|---|---|
| BOM 保留且首个标题可见 | 带 BOM 台账的 TOC 必须列出 H1 | D1 |
| 层级只改真标题 | fence 内 `#` 行在 `promote/demote/mv` 后逐字节不变 | D2 |
| 重复选择器报错 | 匹配 >1 时 exit 2，列出所有 `L行号 标题`，不写文件 | D3 |
| 行尾保持 | CRLF 输入写后仍 `CRLF`，无混合行 | D4 |
| body 输入 | `--body` 与 `--body-file -` 都可用，文案一致 | D5 |
| 结构校验 | `promote` 若使某节与祖先同级则拒绝并提示 `mv` | D6 |
| 表感知 | 台账命令删正文时同步删行；通用 `rm` 提示「该块在索引有对应行」 | D7 |
| 尾换行 | 原文件无尾换行时写后仍无 | 需回归 |
| 模式位 | 写后权限不变 | 新增 |
| 并发保护 | 写前 `stat` 的 mtime+size 与读入时一致，否则 exit 2（E130） | 新增 |

lilmd 的 7 个缺陷实测（附录 A.1）：D1 BOM 吞掉首个标题、D2 fence 内 `#` 被改写、D3 重复标题静默改第一个、D4 CRLF 混写、D5 stdin 文案说谎、D6 `promote` 造出两个 H1、D7 无表感知。

---

## 10. 命令参考

```text
读取（与 lilmd 完全兼容）
  issuemd FILE                             TOC + 行号
  issuemd toc|read|ls|grep|code|links …   同 lilmd，选择器语法不变

通用写（修复 D1–D7）
  issuemd set|append|insert|rm|rename|promote|demote|mv … --body '…' [--dry-run]

台账读
  issuemd check   FILE [--json] [--strict] [--verify-commits] [--layout auto|l1|l2] [--format canonical]
  issuemd list    FILE [--status S] [--priority P] [--closed] [--json]
  issuemd show    FILE ID [--json] [--max-lines N]
  issuemd counts  FILE [--json] [--fix]

台账写（全部 --dry-run）
  issuemd new     FILE ID --title "T" [--status S] [--priority P] [--body-file PATH|-] [--skeleton labels|h4]
  issuemd close   FILE ID [--criteria "…" | --criteria-from-body] [--keep-body]
  issuemd reopen  FILE ID
  issuemd status  FILE ID NEW_STATUS
  issuemd rename  FILE ID "T"
  issuemd sync    FILE [--titles] [--counts] [--fix-tables] [--guide]
  issuemd migrate FILE --to canonical [--prefer body|table]

全局
  --config PATH   默认向上查找 issuemd.config.json
  --no-color      CI 默认
```

退出码：0 成功 / 1 没匹配到 / 2 用法错误 / **3 check 发现 error**。

---

## 11. Skill 设计

目录：`~/.agents/skills/issuemd/SKILL.md`（与 lilmd skill 同构，可并列使用）。

触发：issue 台账 / 台账 / 状态总览 / 待处理 / 关一条 issue / 新增 issue / 核对台账 / `issuemd`。

正文骨架（沿用 lilmd 的节奏：探测 → loop → 写作规则 → 陷阱）：

1. **探测**：`command -v issuemd`。
2. **survey**：`issuemd FILE` → `issuemd list FILE`。
3. **读一条**：`issuemd show FILE 65`。
4. **改状态的唯一姿势**：`new` / `close` / `status` / `rename` / `reopen`。**禁止**用 `set` 手改状态表。
5. **改完必跑** `issuemd check FILE`；exit 3 就是没拉齐。
6. **陷阱**（可 grep）：
   - 表格必须有 `|---|`（`E122`/`W207`）；orca 台账有 11 处现成反例。
   - 一格可写多个编号；**计数按编号算，不按行算**。
   - L1 与 L2 的「索引 ↔ 已关闭」语义相反，别套同一条规则。
   - 计数不要写进标题（`E121`）；换了计数就等于换了选择器。
   - 单元格里的 `|` 写 `\|`（`E108`/`W205`）。
   - 编号 `\d+[a-z]?`，不回收旧号。
   - `--body` 首尾各留一个空行。
   - 状态只在表里（`E107`）。
7. **交给 owner 的写法**：结论必须带 `file:line` + 可复制命令 + 原始输出；不写死 HEAD，给查法。

---

## 12. 实施计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 脚手架** | bun + bunup + tsconfig + `bin/issuemd.ts`；平移 scan/sections/select/render/write 与单测 | `bun test` 全绿；`issuemd FILE` 与 `lilmd FILE` 逐字节相同 |
| **P1 修 7 缺陷** | D1–D7，每条先写 RED（直接取附录 A.1 探针） | 7 个用例红→绿；`file` 验证 CRLF/BOM 保持 |
| **P2 台账模型** | 管道块解析（含无分隔行）、多编号单元格、L1/L2 识别、E1xx/W2xx、`--json` | cafe：**27 E106 + 5 W260**，**0 E104 / 0 W204**；orca：**0 error + W230(212≠211) + 11 W207** |
| **P3 台账写** | `new`/`close`/`rename`/`status`/`sync`/`counts`；原子写 + `--dry-run` | cafe 副本上 `sync --titles --move-progress --dry-run` 的 diff **恰好 27 行表格单元格 + 7 处正文追加** |
| **P4 canonical + migrate** | `migrate --to canonical`（含无损搬运进展文字）；`check --format canonical` | §13 的 A11–A13 |
| **P5 skill + 文档** | `SKILL.md`、README、`--help`、`TEMPLATE.md` | 无上下文 subagent 只读 SKILL.md 能完成三件事 |

P0–P3 是主体；P4 的价值最高（它把「格式本身不对」这件事一次性修掉）。

---

## 13. 用真实台账验收

| # | 场景 | 期望 |
|---|---|---|
| A1 | `issuemd check orca/issue-20261023.md` | exit 0；0 error；W230 报 `已修 212 ≠ 211`；W207 报 **11** 个非表格块 |
| A2 | `issuemd check cafe/issue-20261119.md` | exit 3；**27** 个 E106；**0** E104；**5** 个 W260；**0** W204（guide 点名的 4 个标题都存在） |
| A3 | `issuemd sync cafe/… --titles --prefer=body --dry-run` | **exit 3**：命中 5 个 W260，要求 `--move-progress`/`--drop-progress` |
| A3b | 同上加 `--move-progress` | diff = **27** 行索引摘要单元格 + **5** 处正文追加；正文 H3 与既有文字不变 |
| A4 | A3 应用后 `issuemd check cafe/…` | E106 归零 |
| A5 | `issuemd new <副本> 77 --title "x" --dry-run` | diff 含索引 1 行 + 正文 1 块（canonical 无计数改动） |
| A6 | `issuemd close <副本> 77 --criteria-from-body --dry-run` | diff 含索引 −1 行、正文 −1 块、已关闭 +1 行；判据来自正文 |
| A7 | CRLF 副本跑 `sync --counts` | `file` 仍报 CRLF，无混合行尾 |
| A8 | 带 BOM 副本跑 `issuemd FILE` | TOC 列出 H1 |
| A9 | `issuemd counts orca/…` | 除 `已修` 外全部 ✓ |
| A10 | `issuemd sync orca/… --fix-tables --dry-run` | diff 恰好 **11** 处插入分隔行 |
| A11 | `issuemd migrate cafe/… --to canonical --dry-run` | 索引只剩 28 行（删 48 已修行）、无标题计数；**5 条表的进展文字被搬进正文**且原文不丢 |
| A12 | `issuemd migrate orca/… --to canonical --dry-run` | 标题去计数、补 11 处分隔行、H3 分组合并成单表 + 状态列 |
| A13 | A11/A12 应用后 `check --format canonical` | 0 error |

**A2 的 27 == A3 的 27**，**A1 的 11 == A10 的 11**——工具必须自己发现这些数字，并且只改这些行。这是整份验收最有价值的部分：它不是「跑通」，而是「与人工核对过的已知真相吻合」。

---

## 14. 风险与开放问题

| # | 问题 | 现状 | 建议 |
|---|---|---|---|
| Q1 | 把 orca 的 H3 分组合并成单表，会让「早期已关闭」「owner 裁决不跟踪」这类**语义分组**丢失 | 未处理 | canonical 允许 closed 区保留 H3 分组（只是不允许计数）；`migrate` 默认保留分组 |
| Q2 | `migrate --prefer` 在两边标题都「还行」时会丢信息 | 存在 | 默认 `--prefer=body`；`--dry-run` 必看 |
| Q3 | 单元格含换行/代码块 | 不支持 | `E108` 并提示拆行 |
| Q4 | >10k 行解析耗时 | 未测（2663 行 < 10ms） | P4 补 10k 基准 |
| Q5 | canonical 的单表在 50+ 开放项时会变长 | 可接受 | 提供 `list --status` 视图；不建议再拆表 |
| Q6 | 给 orca 补分隔行属于「改文档」而非「改工具」 | 需 owner 拍板 | `sync --fix-tables` 默认只 `--dry-run`；真应用需显式确认 |

---

## 15. 自查记录：三个被数据推翻的结论

写这份 spec 的过程中，我先得出过三个错误结论，都推翻了，记在这里以免下一位重犯：

| 曾以为 | 实测 | 教训 |
|---|---|---|
| 「已关闭」表声明数与行数不符（212 vs 189、7 vs 2、5 vs 1） | 一格可写多个编号；**按编号数**算，除 `已修` 差 1 外全部相等 | 计数口径必须先定义再判漂移 |
| 编号不得同时出现在索引与已关闭表 | cafe 的 L1 索引是**全量 76 行**，48 条已修与已关闭表**必然重复且完全一致** | 一条规则不能套两种布局 |
| orca 的待处理只有 12 条（16 条里少 4） | 无分隔行的管道块没有表头，朴素实现把首行当表头 | 解析单位是管道块，不是 GFM 表格 |
| 正文标题应当等于表摘要（因此 cafe 有 27 处「错」） | cafe 的表第 4 列实际在写**进展 + 判据**（5/28 含进展词），与正文「问题描述」职责不同 | 先分清列语义，再定不变量；否则会把设计缺陷误判成执行缺陷 |

---

## 附录 A：实测原始输出

> 环境：macOS，`node v22.23.1`，`bun 1.4.4`，lilmd 0.5.0，mdsql 0.1.0，pandoc（GFM 渲染验证）。

### A.1 lilmd 7 个缺陷探针

```bash
printf '\xef\xbb\xbf# T\n\n## A\n\na\n' > bom.md && lilmd bom.md
# bom.md  L1-5  1 heading
#   ## A  L3-5            ← H1 消失（D1）
```

```bash
printf '# T\n\n## A\n\nbody\n\n```md\n## not a heading\n```\n\n## B\n\nb\n' > f.md
lilmd demote f.md "=A"
# ```md 块内 `## not a heading` → `### not a heading`（D2）
```

```bash
printf '# T\n\n## Dup\n\none\n\n## Dup\n\ntwo\n' > d.md
lilmd set d.md "=Dup" --body '
X
'
# 静默改第一个 Dup（D3）
```

```bash
printf '# T\r\n\r\n## A\r\n\r\nold\r\n' > crlf.md
lilmd set crlf.md "=A" --body '
new
'
od -c crlf.md | head -2
# 0000000    #       T  \r  \n  \r  \n   #   #       A  \r  \n  \n   n   e
#                                                         ^^ 混合行尾（D4）
```

```bash
printf 'new-from-stdin\n' | lilmd set p.md "=A"
# lilmd set: --body <text> is required (or pipe content via stdin)
# exit=2                                  ← 文案声称支持 stdin（D5）
```

```bash
printf '# T\n\n## A\n\n#### deep\n\nx\n' > lv.md
lilmd promote lv.md "=A" && cat lv.md
# # T
# # A          ← 两个 H1（D6）
# ### deep
```

```bash
lilmd rm led.md "/Issue 1:/" && cat led.md
# 状态表 `| 1 | 未决 |` 仍在（D7）
```

### A.2 漂移统计

```text
cafe : index 76 行 / closed 48 行 / body 28
       正文 H3 ↔ 索引摘要     不一致 27 / 28（唯一一致 #56）
       closed 摘要 ↔ 索引摘要 不一致 47 / 48
       索引中「已修」集合 == closed 集合 (true)   ← 48 条冗余，信息量为 0
orca : index 16 行 / closed 261 行 / closed 编号 275 / body 16
       正文 H3 ↔ 索引摘要     不一致 0 / 16
       索引 ↔ closed 交集 0
```

### A.3 计数（按编号，非按行）

```text
已修：189 + 9 + 2 + 3 + 2 + 1 + 3 + 2 = 211   （标题声明 212）
owner 裁决不跟踪：23 = 23
决定不改：7 = 7（2 行）
延后：6 = 6
不是缺陷 / 产品裁决：7 = 7（3 行）
未分类：5 = 5（1 行）
范围外 / 撤回 / 并入：3 / 3 / 3
```

### A.4 结构规模

| 文件 | 行数 | H2 | 管道块（合法 / 非表） | 索引 | 正文 | 已关闭 |
|---|---|---|---|---|---|---|
| cafe `issue-20261119.md` | 2663 | 5 | 43 / 0 | 76 行 | 28 | 48 编号 |
| orca `issue-20261023.md` | 2107 | 5 | 17 / **11** | 16 行 | 16 | 275 编号 / 261 行 |

### A.5 渲染验证（pandoc GFM）

```bash
pandoc -f gfm orca_dogfooding/issue-20261023.md -t html | grep -c '<table'   # 17
pandoc -f gfm orca_dogfooding/issue-20261023.md -t html | grep -c '^<p>|'    # 11
pandoc -f gfm cafe_dogfooding/issue-20261119.md  -t html | grep -c '<table'   # 43
```

orca「待处理」区渲染成一个 `<p>`，内容夹着字面 `|`：

```html
<p>| 416 | ccmem 的 Codex 接入与省 context 策略：hooks 已装但未 trust… | | 429 | syncskill 没有“删技能”命令…</p>
```

### A.6 正文风格差异（解释为什么骨架必须是 lint 而非硬约束）

| 台账 | H4 数量 | `**加粗标签**` | 含验收判据 |
|---|---|---|---|
| cafe | **174** | 0 | 28/28（`#### 验收判据`） |
| orca | **0** | **125**（`**期望**` 9、`**现象**` 7、`**验收判据**` 7…） | 7/16 在正文，9/16 在表格判据列 |

两种都合理 → `skeleton.mode` 默认 `off`。

### A.7 lilmd 代码规模（fork 基线）

| 文件 | 行数 |
|---|---|
| `src/cli.ts` | 1155 |
| `src/write.ts` | 231 |
| `src/select.ts` | 179 |
| `src/scan.ts` | 173 |
| `src/banner.ts` | 153 |
| `src/vector.ts` | 135 |
| `src/render.ts` | 115 |
| `src/sections.ts` | 89 |
| `src/pretty.ts` | 58 |
| `src/embed.ts` | 52 |

测试断言：`cli 80 / render 16 / scan 17 / sections 12 / select 27 / write 27 / integration 8`，可整体平移。

**可裁掉的依赖**：`@huggingface/transformers`、`@libsql/client`（`index`/`retrieve`）、`terminal-image`（banner）。issuemd v1 不需要。

### A.8 `check-issues.mjs` 覆盖范围（orca 手写原型，46 行）

| 规则 | 已覆盖 | issuemd |
|---|---|---|
| 表 ↔ 正文一一对应 | ✅ | ✅ |
| 正文升序、无重复 | ✅ | ✅ |
| 正文标题 == 表摘要 | ✅ | ✅ |
| 正文无 `**状态**` | ✅ | ✅ |
| 表内编号不重复 | ✅ | ✅ |
| 声明计数 | ❌ | ✅ W230 |
| 非表格管道块 | ❌（安静当成表格） | ✅ W207/E122 |
| 多编号单元格 | ❌（只取第一个数字） | ✅ |
| 转义 `\|` / 列数 | ❌（朴素 `split('\|')`） | ✅ E108/W205 |
| L1 vs L2 语义 | ❌（只认 orca 一种） | ✅ |
| JSON / 退出码 3 | ❌ | ✅ |
| 自动修复 | ❌ | ✅ `sync` / `close` |
| canonical 迁移 | ❌ | ✅ `migrate` |

`issuemd check` = 上表全部 ✅，并补齐所有 ❌。
