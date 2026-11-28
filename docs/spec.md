# issuemd 规格（v2）

> **一句话**：`lilmd` 让 agent 便宜地读一节；`issuemd` 让「状态表、正文、判据」三处在**结构上不可能对不上**。
> **形态**：CLI（只做台账，**不是** lilmd 的超集，见 ADR 0006）+ skill。单文件、纯 Markdown、零运行时依赖。
> **参考现场**：`orca_archived_files/issue-20261023.md`（2108 行）与 `cafe_dogfooding/issue-20261119.md`（2701 行），均为真实台账，仅作设计参考，**不进入测试夹具**。
> 本文所有数字均为本机实测，命令见附录 A。

## 1. 结论

### 1.1 五句话

1. **格式已经收敛到三个结构缺陷上。** 两份台账自发长成「表定状态 + 按编号放正文 + 已关闭只留判据」，但都靠人肉纪律守，而其中一份已经守不住。
2. **漂移不是手误，是结构必然。** cafe 实测 **15/15** 条开放项的正文标题与索引摘要不相等、**60/61** 条已关闭项的摘要在两表之间不相等。它们源于「同一事实存了多份」。
3. **只有一种格式。** 不做兼容层，不做运行时 `migrate`。旧台账由 agent 一次性转写，此后只认 canonical；转写工具 `adopt` 只做机械改动并输出待决清单。
4. **cafe 已经用 2701 行证明「关闭不删正文」会烂掉。** 其「怎么用」写的是「只改状态总览那一行；正文不动」，于是 13 条已关闭 issue 的正文永久堆积。orca 的「怎么用」写的是「closed？删掉那一块」。两份台账在关闭语义上互为反例，规范格式取 orca 的方向。
5. **写路径不能照抄 lilmd。** lilmd 0.5.0 实测有 7 个会**静默改错**的行为（BOM 吞标题、fence 内 `#` 被改写、重复标题只改第一个、CRLF 混写、stdin 文案说谎、`promote` 造两个 H1、无表感知）。issuemd 拷贝其代码后逐个修掉。

### 1.2 一句话记忆

> **表是索引，正文是记录，判据只存一份，计数从不落盘。**

### 1.3 不做什么

- **不做兼容层。** 不识别 L1/L2，不支持双语义，不保留 `--layout`。`check` 只认 canonical。
- **不做 SQL 写入层。** mdsql 的 `rewrite_table()` 改一行会重写整张表（列宽重排、行内代码退化、CRLF 归一）——反面教材。
- **不引入新文件格式。** 台账仍是一个 `.md`，仍能被 `lilmd` 和 `cat` 读。
- **不做多文件台账、GitHub 同步、服务端。**
- **不接管 handoff。** handoff 是自由文本。

---

## 2. 实测：缺陷与协议矛盾

### 2.1 同一标题存两份或三份，必然分叉

cafe 实测（当前文件）：

| 比较 | 不一致 | 总数 |
|---|---|---|
| 开放项：正文 H3 ↔ 索引摘要 | **15** | 15 |
| 已关闭项：已关闭表摘要 ↔ 索引摘要 | **60** | 61 |

```text
#65  索引摘要: loopback 免 token 且不校验 Origin/Host
     正文 H3 : P0 安全：loopback 免 token 且不校验 Origin/Host，任意网页可 POST /api/orders、/api/baristas、/api/shutdown（CSRF + DNS rebinding）
```

**根因是列语义被写坏**：索引第 4 列在写「短标签」，正文 H3 在写「完整描述」。两者职责不同，于是永远不相等。规范格式的解法不是放弃等式，而是**让两处存同一个字符串，显示时截断**（见 S2）。

对照：orca 的 16 条开放项正文标题与索引摘要 **0/16 不一致**——因为它两处存的是同一份。差别不在纪律，在结构。

### 2.2 计数写进标题，选择器跟着漂

orca 有 **12** 个标题含 `（N）`：`## 待处理（16）`、`### 已修（212）`、`### 决定不改（7）`…

代价有两层。**第一层，计数会错**：按编号数（不是行数）重算，`已修` 声明 212，实际 **211**。作者纪律很好，只错这一处——但只要计数写在标题里，就永远有这一处。

**第二层，标题变成不稳定选择器**：

```bash
lilmd issue-20261023.md "/^待处理（13）$/"   # 当时 13
lilmd issue-20261023.md "/^待处理（31）$/"   # 后来 31
lilmd issue-20261023.md "/^待处理（50）$/"   # 后来 50
```

每次计数变化，所有引用它的文档都得改；不改不报错，只是悄悄读不到。

### 2.3 冗余的第二张全量表 = 48 个额外漂移点

cafe 的「状态总览」是全量 76 行，而「已关闭」表另有 61 行。61 条已关闭项在两处各存一份摘要，实测 **60/61 已不一致**。已验证：索引中 `已修` 的编号集合与已关闭表**完全相等**——第二张表不携带任何新信息，只是一个手工维护的重复视图。

orca 恰好相反：`## 待处理` 只放 16 条开放项，与已关闭表**零交集**，因此 0 不一致。

### 2.4 无分隔行的管道块，渲染层直接坏掉

orca 有 **11** 个管道块（**90 行**）缺 `|---|` 分隔行，**包括整个「待处理」区和 `已修` 的前五个续块**：

```bash
pandoc -f gfm orca/issue-20261023.md -t html | grep -c '<table'   # 17
pandoc -f gfm orca/issue-20261023.md -t html | grep -c '^<p>|'    # 11
```

渲染结果是它们被合并成一段 `<p>`，内容夹着字面 `|`。cafe 的 44 个管道块全部合法。

### 2.5 两份台账的成文协议互相矛盾

| 台账 | 「怎么用」原文 | 后果 |
|---|---|---|
| cafe 第 25 行 | `改某条状态 → 只改「状态总览」那一行；正文不动` | 已关闭项正文永不删除，已堆积 **13** 条 |
| orca 第 25 行 | `改某条状态 → lilmd set / lilmd insert，然后 node check-issues.mjs` | 关闭时删正文（`check-issues.mjs` 报错文案即 `closed? delete the block`） |

cafe 的 13 条孤儿正文（#56–#60、#65–#70、#75、#76）不是手误，是照协议执行的结果。**规范格式取 orca 方向，并把「已关闭项不得有正文块」提升为 error（E111）。**

### 2.6 三个必须记住的口径

| 口径 | 事实 | 写错的后果 |
|---|---|---|
| **按编号计数，不按行计数** | 一格可写多号：`\| 20, 24, 29, 38, 40, 55 \|` 是 6 个编号 | 按行算会把 5 个合法小节全部误报 |
| **解析单位是「管道块」，不是「GFM 表格」** | 无分隔行的块没有表头——把首行当表头，会把 16 条待处理读成 12 条 | 直接漏掉 4 条 |
| **索引与已关闭表编号集合必须不相交** | 唯一格式，唯一规则 | 套错会把冗余当合法 |

### 2.7 一条勘误

本规格 v1 曾写「orca 手写了 46 行 `check-issues.mjs` 去守它」。实测：该脚本在本仓库根目录（`check-issues.mjs`，60 行，未纳入 git），只认 orca 一种布局，覆盖 5 条规则。它作为实现期参照，P5 后删除，由 `issuemd check` 取代。v1 附录 A.8 的覆盖率对照表随之作废。

---

## 3. 规范格式（canonical）

设计目标：**让 2.1–2.4 的四类缺陷在结构上无法表达**。

### 3.1 六条结构决定

| # | 决定 | 消灭了哪个缺陷 |
|---|---|---|
| **S1** | 索引表**只放开放项**；已关闭项只存在于「已关闭」表 | 2.3 |
| **S2** | **摘要与正文 H3 存同一字符串**（trim + 压缩空白后逐字相等），显示时截断；`rename` 一次事务同改 | 2.1 |
| **S3** | **计数不出现在任何标题里**；`## 索引`、`## 已关闭` 是固定标题 | 2.2 |
| **S4** | 表摘要写**稳定标签**（是什么），进展写正文；判据只存一处 | 2.1 |
| **S5** | 所有表格必须有 `\|---\|`；`sync --fix-tables` 可修 | 2.4 |
| **S6** | 正文块内**不得出现任何 Markdown 标题**，一律用 `**标签**`；只读取段用 `show --label` | 层级唯一；通用命令已删（ADR 0006），正文由台账写命令维护 |

### 3.2 骨架

```markdown
# <Project> Issue 台账

> 唯一台账 + 唯一正文。状态只在下表；正文不写状态。编号不回收。
> 读法：`issuemd list <file>` / `issuemd show <file> <id>` / `issuemd check <file>`

## 怎么用

<!-- issuemd:guide:begin -->
（工具生成的命令表；`issuemd sync --guide` 重写此块，块外文字不动）
<!-- issuemd:guide:end -->

## 状态口径

<!-- issuemd:statuses:begin -->
| 状态 | 分类 |
|---|---|
| 未决 | open |
| 部分解决 | open |
| 观察 | open |
| 已修 | closed |
| 延后 | closed |
| 决定不改 | closed |
| 不是缺陷 | closed |
| 范围外 | closed |
| 撤回 | closed |
| 并入 | closed |
| 未分类 | closed |
<!-- issuemd:statuses:end -->

## 索引

| # | 状态 | P | 摘要 |
|---|---|---|---|
| 65 | 未决 | P0 | loopback 免 token 且不校验 Origin/Host |
| 31 | 部分解决 | P1 | Thread 事件热路径逐条同步落盘 |

## 已关闭

| # | 状态 | P | 摘要 | 判据 |
|---|---|---|---|---|
| 6 | 已修 | P3 | 心跳测试钩子 + fake Codex interrupt-before-waiter | `70e0b26`：全量连续多轮 276/276 |
| 1–199 | 决定不改 | | 无记录 | 早期关闭，编号已退休 |

## 正文

### Issue 65: loopback 免 token 且不校验 Origin/Host

**现象**：…
**根因**：…
**期望**：…
**验收判据**：…

## 附录

（自由格式：复核记录、证据转录。不得出现 `### Issue N`。）
```

### 3.3 不变量

| 编号 | 不变量 | 级别 |
|---|---|---|
| I1 | 每条正文块在「索引」里有且仅有一行；每行有且仅有一条正文块 | error |
| I2 | 正文块按编号严格升序、编号唯一 | error |
| I3 | 正文 H3 标题 == 索引摘要（trim + 压缩空白后逐字相等） | error |
| I4 | 「索引」与「已关闭」编号集合**不相交** | error |
| I5 | 正文区不出现 `**状态**` 行 | error |
| I6 | 任何标题不含 `（N）` 计数；四位年份（19xx/20xx，如 `（2025）`）不算计数（第十二轮） | error |
| I7 | 所有管道块必须有分隔行 | error |
| I8 | 正文块内不出现 Markdown 标题 | error |
| I9 | 已关闭项的编号不出现在正文区 | error |
| I10 | 状态词必须在「状态口径」块内声明过 | error |
| I11 | 「状态口径」块与工具内置词表逐字一致 | error |
| I12 | 附录区不出现 `### Issue` | error |
| I13 | 所有状态词在词表内 | warn（词表是工具的，覆盖须改工具） |

> 规范格式下 I6/I7/I8/I9/I11 均为 error，不降级——因为不再有兼容层。

### 3.4 为什么比 orca 更合理

orca 用「一个状态一个 H3 小节」表达分组，代价是**换状态要跨小节移动行**，而跨小节移动是最难做对的行级操作（重算计数、保持升序、处理合并）。canonical 用**一张表 + 状态列**：

- 换状态 = 改一个单元格（1 行 diff，无搬移）；
- 分组读 = `issuemd list --status 未决`（视图，不落盘）；
- 计数 = `issuemd counts --json`（计算，不落盘）。

**把「分组」和「计数」从文档结构搬进查询。** 这是本设计最大的简化。代价是单表变长（开放项通常 10–50 行，可接受）；已关闭表很长，但它只是判据仓库，用 `list --closed` 或 `grep` 查。

---

## 4. 语义模型与解析规则

### 4.1 逻辑模型

```text
Ledger
├── head:      H1 + 引用块（自由文本）
├── guide:     ## 怎么用（受控块，工具重写）
├── statuses:  ## 状态口径（受控块，工具重写）
├── index:     ## 索引  → 开放项
├── closed:    ## 已关闭 → {id | id区间, status, priority?, summary, criteria}
├── body:      ## 正文  → [{id, title, lines}]
├── appendix:  ## 附录  （自由格式，不解析）
└── issues:    [{id, status, priority, summary, criteria?, bodyRange?, rowRange}]
```

### 4.2 管道块 vs GFM 表格

- 解析单位是**管道块**：连续以 `|` 开头的行（fence 外）。
- 分隔行（`|---|`）**必须存在**（canonical）。缺失 → `E122`，但仍尝试解析：无分隔行则**全部是数据行**，不把首行当表头。

### 4.3 单元格

1. 只在**未转义**的 `|` 处切分（`\|` 属内容）。
2. 每格 `trim()`。
3. 格数 != 表头格数 → `E108`，报行号与两边格数。
4. **不做内联 markdown 解析**：反引号、链接原样保留。
5. **编号单元格支持多号与区间**：提取 `\d+[a-z]?`；`1–199` / `1-199` / `1~199` 展开为区间。

### 4.4 编号

`^[0-9]+[a-z]?$`（实测有 `393b`）。为正，不回收；`new` 取 `max+1`（区间端点参与 max 计算）。每次 `new` 在 H1 前言写入或推进 `<!-- issuemd:high-water: N -->`，即使已关闭行后来被删，默认取号仍从已分配高水位继续。没有标记的旧台账以首次 `new` 时仍可见的最大编号为起点，无法追溯标记出现前已删除的历史。

### 4.5 列映射

| 区 | 表头 | 语义 |
|---|---|---|
| 索引 | `# \| 状态 \| P \| 摘要` | 直接映射，列序固定 |
| 已关闭 | `# \| 状态 \| P \| 摘要 \| 判据` | 直接映射，`P` 可空 |

列序固定，可按表头名做一次自校验；表头不符 → `E112`。

---

## 5. 状态词表

| 状态 | 分类 |
|---|---|
| `未决` | open |
| `部分解决` | open |
| `观察` | open |
| `已修` | closed |
| `延后` | closed |
| `决定不改` | closed |
| `不是缺陷` | closed |
| `范围外` | closed |
| `撤回` | closed |
| `并入` | closed |
| `未分类` | closed |

词表**写死在工具里**并由 `sync --guide` 渲染进 `## 状态口径` 受控块；`check` 校验两者逐字一致（I11）。v1 **不提供配置文件**——想改词表就改工具，避免文档里存在第二份真相。

`并入` 的目标编号写在判据列（`并入 #263`），`check` 校验该编号在台账内存在（W210）。

---

## 6. check 规则

### 6.1 errors（退出码 3）

| 码 | 规则 | 依据 |
|---|---|---|
| E101 | 正文块有、索引无对应行 | 2.3 的 `lilmd rm` 现场 |
| E102 | 索引行有、正文块无 | 反向 |
| E103 | 同一表内编号重复 | `check-issues.mjs` |
| E104 | 索引与已关闭表编号集合相交 | S1 |
| E105 | 正文块未按编号升序 | `check-issues.mjs` |
| E106 | 正文 H3 标题 ≠ 索引摘要（比较前折叠空白；标题里的 `\|` 按渲染结果当 `|`，与转义的单元格对齐；`sync --titles` 判漂移同口径——第十二轮） | cafe 15/15 |
| E107 | 正文出现 `**状态**` 行 | 两份台账均 0 |
| E108 | 行格数 ≠ 表头格数（格数偏多时提示「可能是单元格里的 `\|` 没转义」） | 新增 |
| E109 | 编号格式无效、编号或计数超出 JSON 的安全整数范围 | `393b`、大区间 |
| E110 | 正文块内出现 Markdown 标题 | S6 |
| E111 | 已关闭项的编号仍出现在正文区 | cafe 13 条孤儿 |
| E112 | 缺骨架节或表头不符 | 新增 |
| E120 | 不是合法台账（无 `## 索引` / `## 已关闭` / `## 正文`） | 新增 |
| E121 | 标题以 `（N）` / `(N)` 计数结尾（括号内可有空白，全角数字也算；ATX 结尾的 `##` 不影响判定；`Issue N:` 标题只看冒号后的标题；整个标题只是 `（3）` 时它就是标题本身，不算计数；连续多个计数 `甲（2）（3）` adopt 全部剥掉）；四位年份 19xx/20xx 不算——只按数值范围区分，所以恰好落在 1900–2099 的真实计数（`## 已关闭（2013）`）会漏报，1894 之类的年份仍报。check、`new`/`rename`/`reopen` 的标题检查与 adopt 的剥计数共用同一条规则；计数与「小节是否齐全」无关：`## 已关闭（3）` 同时报 E120 与 E121，`## 已关闭（2025）` 只报 E120（第十四轮）。 | 2.2 |
| E122 | 管道块缺分隔行 | 2.4 |
| E123 | 附录区出现 `### Issue` | 新增 |
| E124 | 小节名像台账表（`待处理`、`总览`、`已关闭`…，即 adopt 会迁移表行的小节；`索引` / `已关闭` 本身除外）的 H2 里出现 adopt 会迁移的表行：与 adopt 共用同一个列映射（`mappingFor`）——表头含 `#`/`编号`/`ID` 列，且有 `摘要`/`标题` 列，或有 `状态`/`P`/判据类列可推断摘要，或只有两列；无表头时宽 2–5。口径与 adopt 迁移哪些表完全一致（adopt 也只从这类小节读表行）：其他小节名下的同形表见 W225，`## 路线图` 下的 `| ID | 状态 | 说明 |` 什么都不报。表头判定与 adopt 同一个函数（`tableHeader`）：首行不含数字 → 表头；首行下没有分隔行 → 按 adopt 补分隔行后的读法：有以数字开头的格就是数据行、否则是表头；首行后接真实分隔行 → 表头（`| 2026 | 开放 | 关闭 |`、`负责人2`），除非它明显是写在表头位置的 issue 行：首格是编号、其余格里有非数字文字，并且第二格恰好是状态词、或分隔行下面没有行、或下面至少有一行也是这样的编号行（`| 7 | 未决 | 甲 |` + `|---|`；`| 7 | 甲 | 乙 |` + `|---|` + `| 8 | 丙 | 丁 |`。统计表 `| 2026 | 开放 | 关闭 |` 下接 `| 12 | 3 | 4 |` 仍是表头。dogfood #56、第十一轮复审）。只有台账真正读取的那一节（第一个 `## 索引` / `## 已关闭`）被跳过：`## 索引（旧）`、`## 已关闭（2025）`、第二个 `## 索引` 里的表照常报 E124、编号占用。adopt 自己补的分隔行（无表头表）沿用旧规则：含以数字开头的单元格 → 数据行。这些行不进 `rows`，但其编号按不可读行处理：参与取号与撞号，`show` exit 3 指向该行，读命令 stderr 提示结果不完整。修法：`issuemd adopt FILE` 把它们搬进索引/已关闭（dogfood #52）。`--json` 的诊断带该行首号的 `id`（区间行写成 `7–9`），消费者不必只靠行号定位（第十四轮）。 | 新增 |
| E130 | 原子替换前复核文件标识、大小和时间戳，发现变更时拒绝写入。**退出码 4**（可重试），不是 3。读入时文件恰被别的写者替换（io 的「changed while being read」）同样 exit 4，以前误报为 exit 2 的 I/O 错误（第十一轮）。「复核 + rename」在台账旁的锁文件 `.<文件名>.issuemd-lock`（内容为持有者 pid）里进行：没有它时两个并发写可能都通过复核、都 rename，先写的那份 exit 0 却丢失（第十轮实测 29 次成功写丢 7 次）。锁只在毫秒级的替换期间持有；等待最多 2 秒仍被占用 → exit 4；持有进程已不存在或锁超过 30 秒视为残留、直接接管；锁路径读不了（目录、悬空链接、权限 000）不接管，等满 2 秒后 exit 4；释放时只删内容仍是自己 pid 的锁 | 新增 |

### 6.2 warnings

| 码 | 规则 |
|---|---|
| W201 | 单条正文或归档 payload 超过生效阈值。默认 20 KiB（20,480 UTF-8 字节）或 300 行。消息列出实测值及超限维度。按 LF 计量正文，排除标题及归档封装。手写附录内容不计。 |
| W202 | 正文/附录可见内容（包括 raw HTML 标记与属性）中出现疑似写死的短哈希（每个出现处单独报告，带 1-based 行号和列号；位于开放 issue 正文时带完整 id）。不报 UUID、7–39 位纯数字、行内代码（含跨行 code span）、fence（含列表内缩进 fence）、已关闭表判据，以及有效 keep-body 归档 payload。`--fix-hashes` 还将链接目标/标题、裸 URL、www/email autolink、raw HTML 标签属性与 block、无法安全闭合的 inline-code 视为只读并报告跳过原因；这些位置的 hash 仍可能被 `check` 报告以便人工处理。保留 W240 的独立验证资格与锚点规则：`--verify-commits` 仍验证闭表判据、inline-code、归档和列表 fence 中出现的 hash。 |
| W203 | guide 里点名的标题在文档中不存在（**只查存在性**） |
| W205 | 单元格含未转义 `\|` 或换行 |
| W206 | 同一条正文内标签重复；每个重复诊断都列出该标签全部出现行号。粗体 Q/A 对话行仍可通过 `show --label` 读取，但重复的问答轮次不视为重复台账标签 |
| W210 | 已关闭表的 `并入` 目标编号不存在 |
| W212 | 两条**开放**行（单号）的摘要规范化后相同（NFKC、大小写，**所有空白字符都删除**——`甲 乙` / `甲乙` / `甲　乙` 视为同一条，`导出 CSV` / `导出CSV` 也是），疑似同一 issue 记了两次；`new` 默认用同一个键拒绝与开放项同名的摘要（exit 2，点名已有编号），`--allow-duplicate-title` 放行后由 `check` 持续报出。已关闭的行不参与（重复项以 `并入` 关闭即视为已解决） |
| W211 | 新编号 ≤ 当前表格最大编号或 allocation high-water mark（疑似复用）。带后缀的号（`20a`、`393b`）仍是独立 issue。只在 `new --id` 时打到 stderr；显式号低于持久化高水位但未占用时允许写入并提示 |

| W220 | 状态词未在状态口径块声明 |
| W221 | 优先级不在 `P0`–`P3` 或空之内（`new` 直接拒绝这类值，exit 2） |
| W225 | 小节名不像台账表的 H2（`复核记录`、`变更记录`…，`正文`/`附录`/`怎么用`/`状态口径` 除外）里有表头含 `#`/`编号`/`ID` 列、且有 `摘要`/`标题` 列或只有两列（`\| # \| 说明 \|`）的表，或表头位置是 issue 行（见 E124 的表头判定）的表；必须有分隔行（没有分隔行的管道行渲染成段落，不算）。它不被当成 issue（adopt 原样保留，报告里写 `cited-table`），但**编号占用**：默认取号到达它时跳过（`max+1` 起逐个跳过被引用的编号，不会因为表里有 500 就跳到 501）、`new --id N` exit 2 点名那一行，`show N` 仍 exit 1 但 stderr 说明在哪里被引用（第十一轮推翻「不占用」，dogfood #56）。三列以上、没有摘要列的表（`\| ID \| 状态 \| 说明 \|`）不报 W225。有合法分隔行且同时含编号列和 `状态` 列时，只有状态格使用台账默认词（如 `未决`、`已修`）的行占用编号并进入 `citedRows`（dogfood #79）。`正文`/`附录` 仍为自由格式且不报 W225，但其中可见、非注释的 issue 形表遵循相同编号占用与 `citedRows` 规则，避免正文归档后释放编号（dogfood #84）。每张表报一次、指向第一条能解析出编号的行。是 issue 就人工把行移进索引/已关闭；不是就把 `#` 列改名即可消除。第八轮这类表报 E124，但 adopt 不迁移它们，于是 check 与 adopt 互相指认（dogfood #54） |
| W240 | `--verify-commits` 时 commit 不存在 |
| W250 | `close --keep-body`（或 `adopt`）把正文搬进附录。写命令当场打 stderr；共享 archive inventory 按可见 H3 标题识别所有 `## 附录` 中的归档，忽略 fences/comments/raw HTML 中的伪标题。新归档以 `&lt;!-- issuemd:kept-body:v3 -->` 标记版本，以 `&lt;!-- issuemd:kept-body:start -->` 起始，再以 `&lt;!-- issuemd:kept-body:lines:N -->` 声明后续 N 条 payload 行记录；N 条之后必须有一个独立空 frame 行，随后是 `&lt;!-- issuemd:kept-body:end -->`。marker-like 行在 N 条 payload 内是普通正文，绝不通过扫描 marker 文本确定边界。W201 只计算 N 条记录及 LF-join 后 UTF-8 字节，不计元数据或 frame。v2 保留 exact version/start/end 规则及 pre-commit positional separator 兼容形态；markerless legacy 按旧规则读取。Malformed v2/v3 报 W269；`check --strict` 失败，show/list 隐去 archive body，reopen/prune 拒绝；close/adopt 在写前验证候选格式。Post-end 非空文字不属 payload；reopen 保留尾注，prune 拒绝移除其 H3。**W250 属提示类，`--strict` 不因它失败**。归档是「冻结的历史快照」，其中的 `**验收判据**` 不算判据的第二份（§7.2） |
| W269 | v2/v3 kept-body envelope 缺 marker、计数/顺序/可见性无效、version header 被挪位或不支持。可见附录内，fence、注释或 raw HTML 遮住带相邻 version 和 start marker 的归档标题时，同样报告编号和标题行。`--strict` 失败。仅有遮挡候选时，`show --body-only`、`reopen`、`prune` 与 `close --keep-body` 提示人工检查。可见归档仍按原规则校验，close/adopt 在写前拒绝损坏的候选 envelope |
| W251 | 归档标题里的摘要 ≠ 已关闭表摘要（`rename` 会同步归档标题，手改才会出现） |
| W252 | 归档对应的 issue 已重新开放（`reopen` 正常会收回归档，手改才会出现） |
| W253 | 同一 issue 的正文在附录里还有另一份（转义的 `\### Issue N:` 副本，或重复归档）；旧版 `adopt` 会把表格小节里的正文存两份 |
| W260 | 索引摘要含进展词（`已落地/仍缺/仍无/仍逐/仍走`），应移入正文 |
| W261 | 开放项的正文没有非空的 `**验收判据**` 块（`new` 不带 `--body-file` 写出的空骨架、判据被删掉的正文都算）。`close` 用 `--criteria-from-body` 时本来就会拒绝它，但空壳会一直留在 `list` 里（dogfood #62）。warning 级、`--strict` 失败；已关闭项不判（判据在表格列），正文缺失另有 E102。整块只有 HTML 注释（渲染后什么也没有；注释外的可见文字、fence 里的字面内容都算）不算非空，`close --criteria-from-body` 同样拒绝（第十四轮）。如果正文有近似标签，提示会列出其位置；当一个非空、无歧义的近邻标签可由 `sync --criteria-labels` 修复时，`new` / `body` 会在写入回执后给出该命令。闭表的 `判据` 列对应正文中的精确标签 `**验收判据**`。
| W262 | 报告未闭合 HTML 注释的起始行。围栏、管道表格行和同一行配对反引号中的字面分隔符不参与扫描。多行注释以 `-->` 开头的可见文本行收尾。H1/H2、受管理的 issue 或归档标题以及归档结束标记构成注释边界。正确闭合的注释隐藏其示例表，未闭合范围内的自由格式 issue 形表仍进入 `citedRows` 并保留编号。`--strict` 因 W262 失败。 |
| W263 | `--verify-commits` 在非 Git worktree 中跳过：列出首个待验证 hash 的行号与说明。普通 `check` 可成功，`--strict` 失败；有效 Git worktree 中缺少 commit 仍报 W240。 |
| W264 | 正文已有可提升的 `**验收判据**`，其后另有未计入的非空判据块。候选标签包括已有判据别名、以「判据」结尾的标签（可带括注）及 `判定标准`、`完成标准`、`验收标准`、`必须满足`，每块各报行号，`--strict` 失败。排除正式判据之前的描述性标签、`关闭时判据`、空块和仅注释块。`sync --criteria-labels` 仍用较窄的别名规则。默认 close 与 `--criteria-from-body` 拒绝移除正文。`--keep-body` 保留原文。审阅后可以用显式 `--criteria` 或 `--no-criteria` 选定判据列的值并关闭。 |
| W268 | 判据列表后出现可能分隔判据条目的独立粗体标签，或同一个判据块内的无缩进段落后还有列表或 fence。保留该段的读取结果并报告歧义行，`--strict` 失败。把复核内容放在 `**复核记录**：` 下可明确边界。默认 close 与 `--criteria-from-body` 拒绝删正文，可用审阅后的 `--criteria`、`--no-criteria` 或 `--keep-body`。 |
| W270 | 正文或可见附录以未闭合代码围栏收尾，指出起始行。正文诊断带编号。修复围栏后再写入，`--strict` 失败。 |
| W271 | 正文或附录中的可见 `#N` / `#Na` 引用了未登记编号。带编号和首次引用的位置，`--strict` 失败。`new` 顺序跳过该号，显式 `--id` 拒绝占用，也会复核将要写入的正文。持久化高水位继续独立追踪已分配号码。 |
| W265 | 前言里的 `issuemd:high-water` 标记重复/格式错误，或它高于当前表格最大编号（可能有历史行被删）；`new` 使用该高水位避免重新分配编号。 |
| W266 | 存在多个 `## 附录`，`check` 每个标题各报一条，`--strict` 失败。归档写入、恢复和 `read FILE 附录` 都报 W266、列出所有候选行号并拒绝猜选。 |
| W267 | 台账前言的 `issuemd:limits` 格式无效或重复。使用默认值，`--strict` 失败。 |

### 6.3 `--verify-commits`（默认关）

扫描可验证的短哈希（含已关闭表判据列里的）→ 先确认台账目录位于 Git worktree，再运行 `git cat-file -e <sha>^{commit}`；Git worktree 中缺失报 `W240`。非 Git 目录报 `W263` 并跳过，普通模式可成功、`--strict` 失败。

### 6.4 输出契约

```text
$ issuemd check issue-20261119.md
file: issue-20261119.md
open 15 (未决 8, 部分解决 7)   closed 61
error E106 x15
  L1819 #65  body: P0 安全：loopback 免 token 且不校验 Origin/Host，任意网页可 POST /api/orders…
             row : loopback 免 token 且不校验 Origin/Host
  … (14 more, use --json for all)
error E111 x13
  L1053 #56  已关闭，但正文区仍有 `### Issue 56:` 块
  … (12 more)
warning W206 x2
  …
error 28, warning 2。exit 3。
`issuemd sync FILE --titles --prefer=body --move-progress --dry-run` 可预览正文优先并保留旧摘要的标题对齐。
```

`check` / `counts` 文本摘要会列出开放表实际出现的所有状态，包括未声明状态；有效台账的各状态数之和等于 open 总数。结构错误导致编号重叠时，保留每个状态的原始分桶并由 E103 等诊断指出问题。

`--json` 时 stdout 只有 JSON：

```json
{
  "file": "issue-20261119.md",
  "counts": { "open": 15, "closed": 61, "byStatus": { "未决": 8, "部分解决": 7, "已修": 61 } },
  "errors": [{ "code": "E106", "id": "65", "line": 1819, "expected": "…", "actual": "…" }],
  "warnings": [{ "code": "W206", "id": "65", "line": 1830, "message": "重复标签 现象" }],
  "ok": false
}
```

`check --json` / `counts --json` 在存在外部引用表时附 `citedRows: [{ line, reason, ids }]`，与 `list --json` 同一口径，无引用时省略。`list` / `counts` / `show` 的 `--json` 始终附 `diagnostics: { errors: [], warnings: [] }`（数组可为空）；两类诊断来自同一次解析，并与 `check --json` 的 `errors` / `warnings` 按 `code`、`line`、`id` 对齐。文本 `check` / `counts` 按开放表逐状态计数，未声明状态也照实列出，W220 提醒词表不匹配；`list --status` 可筛出实际存在的未声明词但会输出 W220 提示。`list --priority P` 的 P 若只在另一张表中出现，会提示切换 `--closed`。

---

## 7. 台账写操作

三条共同约束：

1. **原子**：算新内容 → 写同目录临时文件 → `fsync` → `rename`。任一校验失败不落盘。
2. **行级**：未涉及的物理行按原字节照抄（CRLF / BOM / 无尾换行 / 模式位）。diff 只含预期行。
3. **可预演**：`--dry-run` 输出 unified diff（每个改动区域一个 hunk，3 行上下文）并 exit 0。diff 能直接喂给 `patch`（第十一轮）：文件没有尾换行时最后一行后面带 `\ No newline at end of file`；同一处改动里先列删除行再列新增行；CRLF 文件的内容行保留 `\r`。dry-run 是「现在这一刻」的预览，**不**锁定快照；真正写入时仍会复核，文件已被别人改过就 exit 4（E130），重读后重试。dry-run 在 stderr 打印 `snapshot: S`（文件字节 sha256 的前 16 位十六进制）；所有写命令接受 `--if-unchanged S`，读入时文件已不是 S 就 exit 4、不动文件——「复核过的预览」与「真正写入」之间被别人改过时，不会写进一份没人看过的 diff（dogfood #18）。`check` / `list` / `show` / `counts` 的 `--json` 顶层带同一个 `snapshot`，可用于「读 → 决定 → 写」。S 格式不对 exit 2（十六进制不分大小写）。
4. **不猜编码/行尾**：输入不是合法 UTF-8，或同时含 LF 与 CRLF（任一写都会把整个文件归一成一种行尾），写命令直接 exit 2 并说明原因，不做有损转换。
5. **只读**：文件本身不可写（`chmod 444`）时真正写入 exit 2、不动文件（原子替换只需目录可写，不查就会无视只读位）；`--dry-run` 照常。
6. **链接**：符号链接路径会解析到目标文件读写，链接本身保留；有其他硬链接的文件写后另一个名字仍是旧内容（原子替换换了 inode），写命令打 warning。

真实落盘后 stderr 增加一行 `wrote FILE <操作> (snapshot S)`。S 根据写后的字节生成，可传给下一条 `--if-unchanged`。预演和无操作没有写入回执。`new` 的 stdout 仍只含分配的编号。

### `limits`

`issuemd limits FILE --body-bytes N --body-lines N` 在首个 H2 之前写入 `<!-- issuemd:limits: body-bytes=N body-lines=N -->`。每个值为正安全整数，可只设置一维。`--clear` 删除标记并恢复默认值。支持 `--dry-run` 和 `--if-unchanged`。只有前言中可见、独立成行、且不在 fence、多行注释或 raw HTML block 里的标记才生效；示例内容（如 `<div>` 中的标记）保持用户原文，`limits --clear` 不会删除。未配置时行数约束阅读篇幅，UTF-8 字节数衡量输入体积。

`check --json` 提供 `limits: {bodyBytes, bodyLines, source}`（`source` 为 `default` 或 `ledger`）与 `size: {bytes, lines, bodyLines, archivedLines, archivedBlocks}`。`size.bytes` 包含 BOM 和原换行字节。`check` 的文本摘要也显示体积。`body` 在首次超限时提示，`close --keep-body` 在归档 payload 超限时提示，预演也显示提示。整理长正文时，可将历史证据存到单独文件，再使用 `body --body-file` 留下链接及判据。

### 7.1 `new`

```bash
issuemd new FILE --title "Web 侧栏宽度不可调" --status 未决 --priority P2 --dry-run
issuemd new FILE --id 77 --title "…"        # 显式给号（撞号报错）
```

事务：取号（默认 `max+1`，区间端点与 allocation high-water 标记参与）→ 插入索引行（升序）→ 插入正文骨架 → 推进 `<!-- issuemd:high-water: N -->` → 内存重跑 check → 落盘。

正文骨架默认 `**现象** / **根因** / **期望** / **验收判据**` 四个加粗标签；`--body-file PATH|-` 替换的是**标题以下**的正文（不要自己写 `### Issue N:`，标题来自 `--title`）。正文文件里的 `#` / `##` 顶层标题会被拒绝（它会提前结束正文块而 `check` 仍通过），未闭合的 fence 也会被拒绝；`###` 与 Setext 标题由写入门禁以 E110 拒绝；以 `### Issue N:` 开头（把 `show --json` 的 `body.text` 原样回写）时 exit 2 并提示删掉那一行；开头的 BOM 与开头的空行会被剥掉（标题下恰好一个空行，`show --json` 的 `body.text` 去掉标题后原样回写不产生改动）；正文文件可包含 archive marker 的字面文本：新归档以 v3 line count 界定 payload，marker-shaped 内容不作为内部边界；v2/legacy archives 仍由版本规则读取 `&lt;!-- issuemd:kept-body:v2 -->` / `&lt;!-- issuemd:kept-body:start -->` / `&lt;!-- issuemd:kept-body:separator -->` / `&lt;!-- issuemd:kept-body:end -->`。`new` / `rename` 的标题拒绝原始 `&lt;!--` 与 `-->`，避免标题写入 Markdown heading 后开启或结束注释；需要讨论这些分隔符时可写 `< !--` 或 `&lt;!--`。`reopen` 只把归档自己的结束标记与说明行当标记，正文里 fence 中的同样文字原样恢复。

`--priority` 只接受 `P0`–`P3` 或空串（默认 `P2`）。默认取号 `max+1` 超出安全整数范围时 exit 2，要求显式 `--id`。不可读的表行（E108/E109）、规范表以外的 issue 表行（E124）与外来表中保留的编号（见 W225，包括仅保留编号的状态行）也参与取号与撞号检查。新摘要与某个**开放**项的摘要规范化后相同时 exit 2、不写，并点名已有编号——重试的调用方据此知道「已经记过」（dogfood #34）；确需另记一条加 `--allow-duplicate-title`。已关闭项同名不拦。

写入和 dry-run 都用完整候选台账复核所选编号。若本次带入的引用表保留了这个号，`new` 返回 exit 2 并指出候选行号和编号范围。保留现有的默认取号逻辑，其他已登记 issue 仍可被合法引用（dogfood #98）。

成功写入后 stdout 只有一行：分配到的编号（如 `16`、`393b`），调用方不必再 `list` 猜「最新一行」（多个写者时会猜错）。`--dry-run` 的 stdout 仍只有 diff。

### 7.2 `close`

```bash
issuemd close FILE 57 --criteria-from-body   # 或 --criteria "…"
```

事务：从索引删行 → 从正文删块（`--keep-body` 时把该块移入 `## 附录` 并 warn W250；归档以 `&lt;!-- issuemd:kept-body:v3 -->`、`&lt;!-- issuemd:kept-body:lines:N -->` 保存 exact payload line count，N 条 payload 后有一个独立空 frame 和 `&lt;!-- issuemd:kept-body:end -->`；`reopen` 用同一 locator 恢复原始 N 条记录）→ 已关闭表按编号插入 → 把正文 `**验收判据**` 块提升为判据列（**判据去重的关键**：开放时在正文，关闭后在表）。

判据从哪来（判据不得静默丢失）：

| 参数 | 行为 |
|---|---|
| `--criteria TEXT` | 用给定文本；按标题约定解转义（`\|` 表示字面竖线），换行折叠为空格（单元格不能换行），二者都在第十四轮；空串或全空白 → exit 2（多半是变量没设，要空判据请用 `--no-criteria`） |
| `--criteria-from-body` | 提升正文的 `**验收判据**` 块（`**验收判据：**` 写法等同；标签下 fence 里的内容属于判据；多段或列表以 `；` 连接）。块不存在或为空（fence 里出现的标签行是示例，不算）→ exit 2，不写。若自动提升会删除多块判据、非空的后续判据别名，或 W268 标记的句子形粗体边界，也 exit 2；先审阅并用 `--criteria TEXT` 明确完整结果，或用 `--keep-body` 保留原文。

| `--no-criteria` | 明确以空判据关闭 |
| 都不给 | 正文有一个无歧义的非空判据块 → 自动提升；若存在 W268 边界、多块或非空后续别名且 close 会删除正文 → exit 2 并要求显式审阅；没有判据时 `--keep-body` 允许空判据（正文整体保留，信息不丢），否则 exit 2，要求三选一 |

`--status S` 选关闭状态（默认 `已修`）。对已关闭编号执行 `close FILE ID --criteria TEXT` 时，只更新关闭表判据格，不改状态、摘要或正文，并在 stderr 报告旧值与新值。**标签块**的边界：从 `**标签**` 行到下一个可识别的标签行或标题为止；标签行必须独立成行或在粗体标签后使用 `:` / `：` 分隔内容，粗体强调句（如 `**必须**先完成 A`）属于当前块。闭合的 HTML 注释和 fence 内的粗体行不会创建标签边界；注释原文仍保留在 raw body 输出中。空行与列表都属于它；列表续行按 marker 的内容列缩进判断（制表符按 4 列 tab stop 计算）。在验收判据已有列表项后，空行再接无缩进普通段落会结束判据块；若该段后还有列表项或 fence，读取时继续计入，并用 W268 提醒关闭前确认归属。独立粗体标签将可能属于同一列表的判据条目隔开时也报 W268。需要复核的内容建议另起 `**复核记录**：` 标签。`**标签**（括注）：正文` 同样可明确边界。提升进单元格时段落与列表项以 `；` 连接、无序列表符号去掉、fence 内代码保留。

正文里有多个 `**验收判据**` 块时，`show --json.criteria` 为兼容仍按顺序以 `；` 展平所有非空块，`criteriaBlocks` 保留各块边界。`check` 用 W206 列出所有块的行号；普通 close 与 `--criteria-from-body` 在会删除正文时拒绝自动把多块展平进表格。读完全部块后，可用显式 `--criteria TEXT` 提交完整合并结果，或用 `--keep-body` 保留原文。即使一个判据块内含字面 `；`，旧闭表格也无法还原条目边界；结构化 JSON 与 keep-body 归档保留原始行。

`--keep-body` 的拒绝情形（exit 3，不写）：准备插入归档的目标 `## 附录` 小节末尾处于未闭合的 fence 里（归档会被吞进代码块，`check` 与 `reopen` 都看不到）；任一附录里已有该编号的归档（`reopen` 会恢复错的那份）；正文中的 v3 archive marker-shaped 文本由 payload line count 保留，不会被当作边界；若候选归档 end marker 被未闭合的 fence/raw-text HTML block 隐藏，close exit 3、不写。正文中的多行 HTML 注释由 v3 end marker 闭合，W262 仍报告其起始行。没有正文块时 `--keep-body` 无物可留，按「都不给」处理并在报错里说明。

`--keep-body` 与提升判据同时发生时，附录归档里仍有一份原文判据：归档定义为**冻结的历史快照**（只读，`reopen` 用），不算判据的第二份；表格那一份是唯一的现行判据。

正文晋升的判据若含「反斜杠紧邻竖线」（fence 里的 `echo a \| b` 是常见写法），表格单元格无法原样存储——读回时 `\|` 会被当成字面的 `|`，反斜杠丢失。`close` 因此拒绝写入（exit 2，不落盘），提示改用 `--criteria` 写表格里应显示的文本，或 `--keep-body --no-criteria` 把正文原样留在附录（第十四轮黑盒）。

`close` 不能借删除或归档正文来抹掉已有诊断：除被关闭编号自身的 E102（该 issue 没有正文，关闭后可消除）外，只要候选内容会让任一基线 error 消失，就拒绝写入并点名错误。E106 应先用 `rename` / `sync --titles` 修正；其他错误先按 `check` 修复。适用于 `close` 与 `close --keep-body`，避免把错误藏进附录后令 `reopen` 永久失败（dogfood #86）。

### 7.3 `status`

只在 open↔open 或 closed↔closed 内改单元格；跨分类必须 `close`/`reopen`：

```text
$ issuemd status FILE 56 已修
error: #56 当前 观察（open），目标 已修（closed）跨分类，请用 issuemd close
```

### 7.4 `rename`

同时改索引摘要、正文 H3，以及所有 `## 附录` 小节里同号的 `--keep-body` 归档标题，一次事务、要么都不改。新标题含 `|` 时自动转义并 warn W205。开放 issue 改成另一条**开放** issue 的摘要（与 `new` 同一规范化）时 exit 2、不写，并点名那条；确需如此加 `--allow-duplicate-title`。已关闭 issue 的改名、改成已关闭项的摘要都不拦。参数按标题规则规范化后与表格摘要相同，仍会跳过重复摘要拒绝；只有正文标题与目标相同、且若存在同号 `--keep-body` 归档标题也相同，才是无操作（`(no changes)`、exit 0），并保留已经一致的标题原文/转义字节。若相关副本漂移，同摘要 `rename` 会修复漂移副本（第十七轮 #81）。成功预览或写入在 stderr 逐项列出被替换的表格摘要、正文标题和归档标题的旧值与新值（#99）。

### 7.5 `reopen`

从已关闭表删行 → 索引插入行 → 正文插入骨架。无归档时，仅 `已修` 行的非空判据进入 `**验收判据**`；`延后`、`决定不改`、`不是缺陷`、`范围外`、`撤回`、`并入`、`未分类` 等其他关闭状态的单元格内容写入 `**关闭理由**`，不冒充验收标准。空判据仍可重开，命令在 stderr 提醒补写；W261 保持可见，`--strict` 可能失败直到补齐判据。

当唯一 `## 附录` 里存在唯一同号归档时，`reopen` 恢复正文并回收归档。存在重复附录时，`close --keep-body` 与从已关闭表 `reopen` 退出 2 并列出标题行号。没有附录时，`close --keep-body` 可创建新节并写入 `<!-- issuemd:appendix:auto -->`。`reopen` 只回收带此标记且移走归档后没有其他内容的节。已有空附录和含用户内容的附录保留。新归档格式为 `### #N <摘要>（已关闭，正文保留）`、`kept-body:v3`、start marker、`lines:N` 元数据、恰好 N 条 payload 行记录、一个空 frame 行与 end marker；payload 内的 marker-shaped 行是普通数据。v2 保留已提交格式与 pre-commit positional separator 兼容形态；markerless 旧归档按 legacy 格式处理。所有版本都由同一 archive locator 读取；v2/v3 malformed envelope 报 W269，reopen/prune fail closed。`reopen` 逐行恢复 payload；若关闭表判据不在归档正文中，会在恢复内容之后另存 `**关闭时判据**`。`prune` 对 end marker 后非空尾注拒绝，防止删除 H3 后使尾注失去归属。裸 hash 从关闭表格回填正文时会用行内代码标记；W202 将行内代码中的 hash 作为字面证据。普通关闭项没有可恢复的正文，`--keep-body` 是保留证据的方式。

已是开放项时不再 exit 2：不带 `--status`、或目标状态与本行相同，都是无操作（stdout `(no changes)`、exit 0；`--dry-run` 同样并给 `snapshot`）；只有**显式** `--status` 给出另一个开放状态时，才按 `status` 更新该单元格（不做重复摘要检查——本行已是开放项，不会新增第二个开放行）（第十四轮；复审后明确「不带 --status 不改 `观察`」）。

### 7.5a `body` / `priority` / `split`（2026-11-24 补齐，设计见 `docs/superpowers/specs/2026-11-24-ledger-verbs-design.md`）

- `body FILE ID --body-file PATH|- [--append]` 默认替换开放 issue 标题以下的正文。`--append` 在原文末尾新增一段，保留原有正文行和文档格式；若正文最后一个标签属于判据且追加内容不以标签开头，放入首个未使用的 `**复测记录**`、`**复测记录 2**` 等标签。追加段中的可见判据标签或会改变判据归属的写入 exit 2。引用判据原文时用代码围栏；修订判据时用正文替换。空白追加/替换都是无操作。判据块在已有列表项后遇到空行及普通段落时结束；缩进达到列表 marker 内容列的续行（制表符按 4 列 tab stop 计算）仍属该项。如果之后在同一标签范围内还有列表项或 fence，则这些内容仍属于判据。两种模式的输入规则同 `new --body-file`，已关闭 id exit 2，开放项缺正文块时可按编号位置新建。
- `priority FILE ID P`：只改 `P` 单元格，开放/已关闭都行；`P` 只能是 `P0`–`P3` 或空。
- `split FILE ID`：把 ID 所在的多号行或区间行拆成每号一行（字段原样复制、升序原位）。**不替任何号补正文**：原本没有正文的号拆分后仍然没有，E102 继续报出（区间行会从「第一个缺失号」变成逐号报出），split 在 stderr 提示用 `issuemd body` 补写。缺失编号超过 3 个时，提示只列总数、首尾编号和省略数，完整清单用 `issuemd check FILE --json` 里的 E102 获取（dogfood #64、#76）。如果拆分新增 W212，命令 exit 0 并在 stderr 概括受影响编号、建议拆分后用 `rename` 区分；完整诊断见 `check --json`（dogfood #90）。单号行 exit 2；超过 1000 个号 exit 2。只解析一次台账（dogfood #70）。
- `reopen --status S`：S 必须是开放分类，默认 `未决`。
- `reopen` 的摘要与某个开放项规范化后相同（例如以 `并入` 关闭的重复项被重开）时 exit 2、不写，点名已有编号并给出 `issuemd rename`；确需重开加 `--allow-duplicate-title`，之后由 W212 持续报出。
- 所有 per-id 命令（close/reopen/status/rename/body/priority）对多号行、区间行用同一句话拒绝，并给出 `issuemd split FILE <id>`；`close`/`reopen` 先判行形状、再判开关状态。

- `body FILE ID --move-evidence LABEL` 把一个唯一可见的证据块移进同文件的附录，并在正文留下链接。用 `--dry-run` 审阅搬移范围和目标，再用 `--if-unchanged` 应用。移动减少活动正文体积，`check` 仍报告整份文件的大小。命令保护判据、编号引用和现有归档。

### 7.6 `counts`

```bash
issuemd counts FILE [--json]
```

输出每个状态与整表的**编号数**。不写盘（canonical 里没有计数可修）。

### 7.6a `find`

`find FILE PATTERN [--json]` 按大小写敏感的字面字符串匹配开放和已关闭摘要、开放正文以及唯一归属的可读归档。结果按源文件行序输出，每个字段的匹配行只输出一次。若行内命中可见的编号引用，`where` 为 `reference`，`id` 仍是引用所在的条目。JSON 顶层含 `file`、`snapshot`、`diagnostics` 和 `matches`。空结果 exit 0。以 `-` 开头的模式用 `issuemd find FILE --json -- PATTERN`。

### 7.7 `sync`

只做机械修复：

| 开关 | 行为 |
|---|---|
| `--titles` | 对齐正文标题与索引摘要。摘要和正文标题相同时是 no-op；不同时必须明确选择：`--prefer table` 保留表格摘要并改正文标题；`--prefer body --move-progress` 把旧摘要完整保存为正文进展后改表格摘要；`--prefer body --drop-progress` 明确丢弃旧摘要并改表格摘要。只给 `--titles` 或只给 `--prefer body` 都 exit 3、不写。W260 护栏保留：正文优先需显式 move/drop，表格优先命中 W260 仍拒绝。所有真实或 dry-run 标题变化都在 stderr 点名旧值、新值。多号行仍跳过并点名，提示先拆行 |
| `--criteria-labels` | 当开放项没有 `**验收判据**`、只有一个非空安全近似标签（`判据`、`验收判据…`、`追加判据…`、`修复判据…` 或以 `的判据` 结尾）时，将标签名改为 `验收判据`，保留正文行与内容。多个近似标签、已有正式标签、空块及历史标签（如 `关闭时判据`）不自动处理。每项在 stderr 报告，dry-run 与真实写入一致 |
| `--fix-hashes` | 把开放正文与普通附录文本中可安全包裹的 W202 命中包进行内代码，一次修复所有出现处。dry-run 显示精确 diff；真实写入报告每个改动位置和新 snapshot。跳过所有解析表格单元格、code fence、行内代码（含跨行 code span）、Markdown 链接目标、bare URL/autolink、raw HTML block/属性、无法安全闭合的行内代码，以及归档标题/正文；坏归档子树也不改，命中位置在 stderr 点名原因 |
| `--fix-tables` | 补 `\|---\|`（修 E122），列数按表头补齐或报 E108 |
| `--guide` | 重写 `## 怎么用` 与 `## 状态口径` 受控块 |
| `--move-progress` / `--drop-progress` | 仅与显式 `--prefer body` 配用：保留旧摘要为正文进展 / 明确丢弃旧摘要 |
| `--dry-run` | 输出 diff；须能验证「只改了 N 行」 |

`--fix-hashes` 只处理能证明是普通正文文本的位置。一个 W202 命中若在表格、链接目标、raw HTML 属性、不完整的 inline-code 行、受管理标题或归档区，修复命令会保留原字节并在 stderr 说明位置；摘要/标题应通过 `rename` 或人工编辑处理。给正文加反引号可能增加文件体积，检查 W201 与 size 指标确认影响。

`sync` 不删正文、不移行、不改状态。这条边界让 agent 敢无人值守跑 `sync --dry-run`。`--titles` 跳过的多号行（摘要与某个正文标题不一致）在 stderr 逐条列出，提示先拆行。

**选择护栏**：`--prefer` 只能配 `--titles`。变更摘要时必须显式选一侧；`--prefer body` 还必须配 `--move-progress` 或 `--drop-progress`，保证摘要文本得到保留或由用户明确舍弃。命中 W260 时同样要求 move/drop，`--prefer table` 命中 W260 则拒绝，因为它会把进展写入正文标题。每项变更在 stderr 输出 `updated #N summary/body title: "旧值" → "新值"`，dry-run 与真实运行一致。无事可做的 `--titles --dry-run` 仍输出 `(no changes)` 并在 stderr 给 `snapshot`。

写命令找不到编号时 exit 1，提示写在 stderr（不混进 `--dry-run` 的 stdout diff）；读命令 `show` 仍在 stdout 打 `(no such issue: N)`；`show --json` 或 `show --body-only` 时 stdout 为空，提示在 stderr。

---

### 7.8 `prune`

```bash
issuemd prune FILE ID --dry-run                 # 预览要删除的字节，stderr 给出 snapshot
issuemd prune FILE ID --confirm --if-unchanged SNAPSHOT
```

只删除**一个**可验证的 v2/v3 keep-body 归档，保留已关闭表行、判据和其他附录内容。要求目标为唯一的已关闭单号行；开放区间行、逗号行、不可读行同时占用该 id 时 exit 2。附录 H2 与 archive H3 必须是真实可见标题；v2 的固定 metadata/end markers 与 v3 计数行、frame/end 必须满足对应版本规则。存在重复 `## 附录`、重复同号归档、markerless legacy、malformed envelope、end marker 后的非空尾注时拒绝。无版本的 legacy archives 仍可 read/reopen，但 `prune` 需人工处理。v1 不猜边界，也不做批量或按时间的清理。

真实删除必须使用预览得到的 snapshot；两个参数缺失、同时给 `--dry-run --confirm`、`--confirm` 无 snapshot、或 snapshot 单独出现都 exit 2，过期 snapshot exit 4。写入前重新检查：既有 error 的多重集合（code/id/message/expected/actual，忽略行号漂移）必须不变，其他归档的 id 与 payload 必须逐字节不变，否则 exit 3。预览与落盘共用同一候选字节；有尾换行文件保留幸存空行，无尾换行 EOF 只去掉因此变成末尾的空行。成功后 stderr 给出 `wrote … #ID archive pruned (snapshot S)`。

## 8. 写入安全

| 要求 | 判据 | 对应 |
|---|---|---|
| BOM 保留且首个标题可见 | 带 BOM 台账的 TOC 必须列出 H1 | D1 |
| 层级只改真标题 | fence 内 `#` 行在 `promote/demote/mv` 后逐字节不变 | D2 |
| 重复选择器报错 | 匹配 >1 时 exit 2，列出所有 `L行号 标题`，不写文件 | D3 |
| 行尾保持 | CRLF 输入写后仍 `CRLF`，无混合行 | D4 |
| body 输入 | `--body` 与 `--body-file -` 都可用，文案一致 | D5 |
| 结构校验 | `promote` 若使某节与祖先同级则拒绝并提示 `mv` | D6 |
| 表感知 | 台账命令删正文时同步删行；通用 `rm` 在台账上拒绝 | D7 |
| 尾换行 | 原文件无尾换行时写后仍无 | 新增 |
| 模式位 | 写后权限不变 | 新增 |
| 并发保护 | 写前 `stat` 的 mtime+size 与读入时一致，否则 exit 4（E130，可重试） | 新增 |

lilmd 的 7 个缺陷实测见附录 A.1。它们的**根因是 `writeFileSync` 直接覆盖 + 正则扫全文**；issuemd 改为「先按 fence 感知切块，再行级拼接，最后原子写」。

---

## 9. 命令参考

> 见 ADR 0006：`issuemd` 只有一个入口、只做台账。lilmd 的读命令与通用写命令（`toc` / `ls` / `grep` / `set` / `rm` / `promote` / `mv` …）**已删除**，本表是唯一权威，须与 `issuemd --help` 一致。

```text
台账读
  issuemd check   FILE [--json] [--strict] [--verify-commits]
  issuemd list    FILE [--status S] [--priority P] [--closed] [--expand] [--json [--with-body]]
  issuemd show    FILE ID [--body-only | [--json] [--label NAME]]
  issuemd counts  FILE [--json]
  issuemd read    FILE <H2 标题>          # 精确匹配顶层标题，无选择器/正则
  issuemd --version                          # 当前安装包版本

台账写（全部 --dry-run，原子写且保持 BOM/行尾/模式位）
  issuemd new     FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-] [--allow-duplicate-title]
  issuemd close   FILE ID [--status S] [--criteria TEXT | --criteria-from-body | --no-criteria] [--keep-body]
  issuemd reopen  FILE ID [--status S] [--allow-duplicate-title]
  issuemd status  FILE ID NEW_STATUS
  issuemd rename  FILE ID "NEW TITLE" [--allow-duplicate-title]
  issuemd body    FILE ID --body-file PATH|- [--append]
  issuemd priority FILE ID P0|P1|P2|P3|""
  issuemd split   FILE ID
  issuemd sync    FILE [--guide | --fix-tables | --titles [--prefer body|table]
                        [--move-progress | --drop-progress] | --criteria-labels]

迁移（一次性，不进运行时）
  issuemd adopt   FILE [--dry-run] [--report PATH]
```

退出码：0 成功 / 1 没有这条 issue 或结果为空 / 2 用法或 I/O 错误 / **3 check 发现 error** / **4 文件在读取后被改动（E130），重读后重试**。`issuemd FILE` 不是命令简写，exit 2。写命令算出的内容与原文逐字节相同时不落盘，stdout 打 `(no changes)`（与 `--dry-run` 同一措辞）、exit 0——重试的调用方能区分「已经改过」与「刚才改成功」；真正有改动时 stdout 仍为空（`new` 只有编号一行）（dogfood #66）。`adopt` 无改动时同样先打一行 `(no changes)`，再打迁移报告，与该命令的 `--dry-run` 一致（第十四轮）。

每个命令只接受自己的选项（见 `issuemd <command> --help`）；给了别的命令的选项（`list --title`、`new --json`、`check --closed`）一律 exit 2，不静默忽略。未知命令即使带 `--help` 也保持 exit 2，不把全局帮助误报为探测成功。`list --status` / `--priority` 的值既不在词表也不在台账中时 exit 2；实际出现在台账中的未声明状态仍可过滤，但 stderr 提示 W220。关闭类状态用在开放表上会提示加 `--closed`；优先级只在另一张表中出现时也会提示切表。

读命令遇到不可读的表行时在 stderr 说明结果不完整，`list --json` 附 `unreadableRows`；外来表保留的编号不属于不可读行。`list --json`（开放与 `--closed` 都）附 `citedRows: [{ line, reason, ids }]`（没有时省略），agent 不必跑 `check` 也知道哪些编号不会被分配（第十二轮；W225 表引用的编号若同时是已登记的 issue 也照列）。`check --json` 与 `counts --json` 也在有引用时附同一 `citedRows`。`show` 查到的编号若还出现在某条不可读行（如 E124 的旧表）里，照常输出并在 stderr 点名那一行；`list --json` 每项带 `ids` 与 `count`，顶层带 `rowCount` / `issueCount`（`issueCount` 与 `counts` 一致）。

**读视图与 `check` 的一致性（第十三轮，dogfood #63；第十八轮）**：`check` 有 error 时，`list` / `counts` / `show` 的退出码仍是 0/1（读一份坏台账去修它是正当用法），但会在 stderr 写一行 `note: 'issuemd check' reports N error(s) (first: CODE L… )`。三者的 `--json` 始终附 `diagnostics: { errors: [...], warnings: [...] }`，数组可为空并始终存在；诊断与同快照的 `check --json` 按 `code` / `line` / `id` 对齐，包含 E106 的 `expected` / `actual`。`N` 是 `check` 报告的全部 error 数（包括不可读行）；错误全部落在不可读行上时也照常出现，只是与 `unreadableNote` 的逐行说明并列（第十四轮）。

**纯正文（dogfood #97；JSON 回灌 #108；归档读取 #127）**：对开放项，`show FILE ID --body-only` 输出该 issue 标题以下的正文，去除首尾分隔空行，保留内容空白与行尾约定；未编辑时可回灌 `body FILE ID --body-file -` 并保持字节不变。`show --json` 的 `body.content` 与 `--body-only` 内容一致（JSON 使用 LF），`body.text` 保留旧的含标题视图以兼容既有消费者。`list --json --with-body` 也附 `body.content`，可批量读取后直接回灌。对只有一个可识别 keep-body 归档的已关闭项，同一命令输出归档 payload；`show --json` 的 `body` 加 `archived: true`、`lineCount` 与 payload，内容按 v2/v3 版本规则提取。v3 的 N 条 payload 行记录逐行保留（包括空行和 marker-shaped 行），frame 与 metadata 不计入。legacy 归档不猜测 provenance note 边界，展示标题后至可见 end marker / H3 边界的全部文字。`list --closed --json --with-body` 同样附唯一归档的 body。无归档的已关闭项、缺正文或借用兄弟项的正文仍 exit 1，stdout 为空。`--body-only` 与 `--json`、`--label` 互斥。

**正文归属（dogfood #69）**：`show` 先找本号自己的 `### Issue N:` 块；找不到时沿用「同一行只在首号写一段正文」的历史写法，借同一行其他号的正文——逗号行任一 id、区间行任一被覆盖的 id（`5–7` 的正文挂在 `6` 也算）——但某个 id 自己有独立行时（重复编号，E103）不借它的正文，`show` 与 `list --with-body` 同口径（第十四轮复审）；`--json` 的 `body` 带 `id`（正文真正属于哪个号）与 `inherited: true`，`criteria` 另带 `criteriaFrom`，文本模式在 stderr 写 `note: the body shown belongs to #N`、stdout 写明「正文属于 #N」。`check` 仍对没有自己正文的号报 E102。

**`list --json --with-body`（dogfood #67；lossless labels #125；criteria structure #120/#123）**：每项附 `labels` 的单行摘要及 `labelBlocks` 的原始 Markdown 行；含判据标签时，另附 `criteriaBlocks: [{ line, label, kind, lines }]`，保留每次 canonical 判据与首个 canonical 块之后的非空别名块。`line` 是台账中的 1-based 绝对行号；`lines` 含标签行及其正文，仅去掉块尾空行；`kind` 为 `canonical` 或 `supplement`。空 canonical 块和重复 canonical 块保留，历史标签 `关闭时判据` 不算补充判据。开放项带 `body.content`（不含正文标题，可回灌 `body --body-file -`），`criteria` / `criteriaSource: "body"`；已关闭项的 `criteria` 带 `criteriaSource: "table"`，且唯一 keep-body 归档会附 `body.archived: true`、payload 与从同一 payload 计算的 `criteriaBlocks`。未展开的闭合区间行仅在其中有唯一可用归档时附带正文结构；多归档保持歧义并省略。正文来自同行兄弟号时附 `bodyFrom`。`show --json` 同样附 `labelBlocks`、`body.content` 与 `criteriaBlocks`，`body.text` 保持原有含标题语义；`show --json --label` 另附 `paragraphLines`。原有扁平 `labels` / `paragraph` / `criteria` 保持兼容。所有条目来自同一次解析，顶层 `snapshot` 一份，批量分析不必逐条 `show`。`--with-body` 必须配 `--json`（否则 exit 2）。

### 9.1 不要把这些命令加回来

`toc` / `read`（除台账版 H2 读取外）/ `ls` / `grep` / `code` / `links` / `set` / `append` / `insert` / `rm` / `promote` / `demote` / `mv` 以及选择器语法都不存在。要读普通 Markdown 的某一节，用 `issuemd read FILE <H2 标题>`；要编辑普通 Markdown，用编辑器或 lilmd。原因见 ADR 0006，不重复。

---

## 10. `adopt`：一次性转写

不做兼容层，旧台账由 agent 转写。`adopt` 只承担**机械且可验证**的部分，其余进待决清单。

```bash
issuemd adopt old.md --dry-run --report decisions.md
```

机械改动（会出现在 diff 里）：

1. 补全骨架节（`## 索引` / `## 已关闭` / `## 正文` / `## 附录`）。
2. 删掉索引中 `closed` 分类的行（信息已在已关闭表）。
3. 去掉所有标题末尾的 `（N）` 计数（与 E121 同一规则：`（2025）` 这类四位年份保留）。报告里这一条点名（最多列前 5 处，其余以 `…` 省略）`源 L…`，`### Issue N:` 标题另带 `#N` 与新旧标题（第十四轮）。
4. 给所有管道块补分隔行。
5. 把正文块内的 `####` 小标题降级为 `**加粗标签**`。正文块 = 从 `Issue` 标题（H1–H3；旧 cafe 用 `## Issue N:` 加 `### 期望` 子节）到下一个同级或更高级标题；外来小节里的 `####` 原样保留（第十二轮）。标题行首可有 0–3 个空格、`#` 后可以是制表符，与 CommonMark 和 check 的读法一致。开放项摘要与正文标题用同一规则去掉末尾计数，两边都带计数时不报 `open-title-conflict`。
6. 索引加 `状态` 列；已关闭表加 `状态` 列（由原 H3 分组名映射到词表）。
7. 把 `## 怎么用` 里的手写编辑协议替换为工具生成块（原文进 `-` 行）。

写入待决清单（**不自动决定**）：

| 待决项 | 判据 | 建议默认 |
|---|---|---|
| 摘要与正文标题冲突 | 逐条列出两边文本 | `--prefer=body` |
| 表摘要含进展词 | W260 判据 | 搬进正文，附 `> **进展（来自旧表）**：…` |
| 已关闭但仍有正文 | E111 判据（cafe 13 条） | 判据提升进表；正文搬 `## 附录` |
| 状态词不在词表 | I13 判据 | 列出现有词与最接近的映射 |
| 一格多号 | 解析出多个 id | 拆成多行 / 保留合并行 |
| 编号区间 | 解析出 `1–199` | 保留区间行 |
| 语义分组名 | H3 分组不属于任何状态 | 列出，供人决定丢弃或映射 |
| 附录性内容 | `复核记录`、证据转录 | 原样搬 `## 附录` |

`adopt` 的承诺只有一条：**不做你没批准的事**。它不保证语义正确，也不追求一步到位；输出必须能被 `check` 判为 0 error（附录内容除外）。

2026-11-24 dogfooding 后的补充（实现见 `src/adopt.ts`）：

- **已合规就不动**：输入 `check` 0 error 且无 W220 时，原样返回；没有任何 W225 表时报告「已是规范台账」，有 W225 表时报告写「结构合法（check 0 error）；另有 N 张表按 W225 原样保留、不迁移，无需转换」——不再让「无需转换」一句话盖住仍在文件里的非规范表（dogfood #57）。空 TEMPLATE 不再被判成「不是台账」；已有的空 `## 附录` 不删。规范骨架加一节旧表（`## 待处理`）的混合文件因 E124 不算合规，照常转换；规范表只有表头时视为重建，不当说明文字复制进附录。
- **内容守恒自检**：除了被转换成表行的行（及其表头/分隔行）、重建的规范标题、受控块和正文里的 `**状态**` 行，**每一行输入**都必须在输出里出现，否则拒绝写入（exit 3，列出源行号）。输入表格里的每个编号也必须出现在输出表格里。两项检查都通过时，报告的「机械改动」里会写一行 `守恒自检：issue N → N；表格行以外的 K 行原文都在输出里`。
- 表格小节（`## 待处理` 等）里的 `### Issue N:` 是正文块，不是叙述：开放项进 `## 正文`，已关闭项进归档，不再另外当作「小节说明」复制一份（dogfood #50）。
- 不在 `## 正文` 和表格小节里的 `### Issue N:` 正文块（H1 下面、外来小节里）同样是正文：搬进 `## 正文` 或归档，原处的逐字副本里去掉这几行，不留第二份。
- 第一个 H2 之前（H1 下面，或文件没有 H1）的正文块不算说明文字：adopt 采用的那份搬进 `## 正文`、归档，或作为孤立正文进附录，说明与前言的副本里去掉它；同号的另一份（`## 正文` 里那份优先）与区间标题留在原处，标题转义成文字。前言（H1 之前的文字）进附录时同样转义。
- adopt 只从台账表小节名（`待处理`、`总览`…）下读表行；其他小节里即使是 `| # | 摘要 |` 的表也原样保留，不迁移（与 W225 一致）。报告（含「已是规范台账」的早退）对每张 W225 表写一条 `cited-table`，说明它不迁移、编号已占用。被迁移的表里没有编号的行（`| 备注 | a | b |`）按原文移入附录并写 `kept-row`，不再当表头丢掉（第十一轮复审）。无表头的三列表默认按 `# | 摘要 | 判据` 读；**逐行**判断：第二格恰好是状态词的那一行（`| 7 | 未决 | 甲 |`）按 `# | 状态 | 摘要` 读（dogfood #56）。
- **外来小节搬进附录时**：标题里的 `（N）` 计数会被剥掉，报告必须点名改名（`标题去掉（N）计数后移入附录（L…「原名」→「新名」）`），不再写成「原样移入附录」；原级别是 H2 的小节另写「以原级别 H2 并入附录」，不悄悄改变结构，也不降级（降级会让里面的表脱离 W225 视野、编号不再保留）（dogfood #72）。
- **开放项摘要里的 `（N）` 计数**（dogfood #73）：表摘要与正文标题都带同一个计数 → 静默剥掉；只有一侧带计数 → 剥掉并出一条 `summary-count-stripped`（带 id 与新旧摘要，列在「按默认处理、请复核」）；两侧计数不同（`甲（3）` vs `甲（4）`）→ `open-title-conflict`，不当成「剥完就一样」。不带计数的真实漂移（`甲2025` vs `甲2026`）照旧冲突。
- 输入 `## 附录` 里已有的 `### Issue N:` 不当正文用：原地留在附录，标题改成 `### #N 摘要（附录里原有的正文）`，出 `orphan-body` 决定；N 是开放项时正文用 `## 正文` 里那份或补骨架，决定里提示用 `issuemd body` 换。
- `### Issue 3–5:` 这类不是单个编号的正文标题挂不到任何 issue：连同内容原样（标题转义）移入附录，出 `foreign-section` 决定；对应的开放行照常逐号补骨架。
- **H1 下的原有说明**留在原处；`## 怎么用` / `## 状态口径` 只重写 marker 之间的块，块外文字原样保留（出 `kept-section-text`）。
- **表格小节里非表行的内容**（分组说明 `> owner 裁决…`、叙述性 H3、映射不了的表）连同分组标题搬进附录（出 `section-prose`）。
- 带括注的规范标题（`## 正文（按编号）`、`## 已关闭（只留判据）`）按规范节处理，括注去掉并记入机械改动。
- **列映射**：表头有 `#` + `摘要/标题` 时按名映射；无 `判据` 时 `裁决/说明/理由/原因/结论/备注` 当判据；其余列以「列名：值」追加进判据。没有摘要列时按宽度 2–5 猜（只在台账表格小节内），宽度 ≥6 不猜、原样保留。
- **状态**：行内状态列 > 判据格开头的状态词（`决定不改：……` → 状态 `决定不改`，判据取冒号后）> 分组标题。都没有时开放表记 `未决`、已关闭表记 **`未分类`**（从不默认 `已修`），并出 `unknown-status`。状态格只去掉中性的包装再认：强调符（`**未决**`）、开头的勾号（`✅ 已修`）、结尾括注（`已修（v2）`）。去掉的不只是强调符时，原格写成 `原状态：…`；`❌ 已修`、`已修？`、`~~已修~~` 这类否定/存疑写法不认，按未知词处理。仍不在词表里的词照旧按开放 `未决` / 已关闭 `未分类` 处理，但原词以 `原状态：X` 写进输出（已关闭行的判据格、开放项正文的 `**原表格判据**`），不只留在报告里。
- **同号多行**（索引与已关闭表各一行，或同一张表里重复）按字段合并：状态与优先级取索引；摘要跟随最终所在的表（仍开放取索引的，已关闭取已关闭表的）；没被采用的摘要在 `duplicate-row` 里逐字列出（已关闭项的「索引 vs 已关闭表」那一对仍由 `closed-title-conflict` 列两边文本）。
- 开放行在旧表里带的判据/附加列追加到正文末尾的 `**原表格判据**`（出 `extra-columns`）。附加列（`负责人` 等非判据列、超出表头的格）**从不**进骨架的 `**验收判据**`——否则之后一个不带参数的 `close` 会把它当判据提升；已关闭行的判据格是「判据；附加列」。
- **开放的多号行 / 区间行**（`2, 3`、`7–9`）按 `check` 的 E102 规则逐号补正文：已有 `### Issue N:` 的挂上去，没有的补骨架（`missing-body` 列出编号）；标题统一用行摘要，原正文标题不同的写成正文开头的 `**原正文标题**` 并出 `open-title-conflict`。超过 1000 个号的开放区间不展开，出 `id-range`。
- 首格像编号却解析不出（`9–7`、超出安全整数的区间）的行仍按原文移入附录，但单独出 `id-range` 点名，说明其中的编号不会被保留；比表头多出来的格（多半是没转义的 `|`）接在判据后并出 `extra-columns`。
- 已关闭仍有正文的条目，归档格式与 `close --keep-body` 相同（`reopen` 可恢复）。
- 转换结果仍有 error 时，诊断给**源文件行号**（`source L…`）；决策的行号指向输出文件，定位不到时给 `源 L…`，不再出现 `L0`。
- `--report PATH` 不能是台账本身，也不能覆盖与 adopt 无关的已有文件（覆盖上一次的 adopt 报告可以）；`--dry-run` 时照样写报告（这是推荐的复核流程），台账不动。
- 报告分三段：机械改动 / 原样保留的内容 / 已按默认处理、请复核的决定。

---

## 11. Skill 设计

目录：`skills/issuemd/SKILL.md`。

触发：issue 台账 / 台账 / 状态总览 / 待处理 / 关一条 issue / 新增 issue / 核对台账 / `issuemd`。

骨架（沿用 lilmd 的节奏：探测 → loop → 写作规则 → 陷阱）：

1. **探测**：`command -v issuemd`。
2. **survey**：`issuemd list FILE`（`issuemd FILE` 不是命令简写，exit 2）。
3. **读一条**：`issuemd show FILE 65`（要单段用 `--label 验收判据`）。
4. **改状态的唯一姿势**：`new` / `close` / `status` / `rename` / `reopen`。**禁止**用 `set` 手改状态表。
5. **改完必跑** `issuemd check FILE`；exit 3 就是没拉齐。
6. **陷阱**（可 grep）：
   - 表格必须有 `|---|`（`E122`）。
   - 一格可写多个编号与区间；**计数按编号算，不按行算**。
   - 计数不要写进标题（`E121`）。
   - 正文块内不许有标题（`E110`），用 `**标签**`。
   - 已关闭项不能留正文（`E111`）。
   - 单元格里的 `|` 写 `\|`（`E108`/`W205`）。
   - 编号 `\d+[a-z]?`，不回收旧号（显式 `--id` 落在历史最大号以内时 `new` 打 `W211`）。
   - `--body` 首尾各留一个空行。
   - 状态只在表里（`E107`）。
7. **交给 owner 的写法**：结论必须带 `file:line` + 可复制命令 + 原始输出；不写死 HEAD，给查法（`git log --oneline -3`）。

---

## 12. 实施计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 脚手架** ✅ | 拷贝 lilmd `src/` + `bin/`，改包名为 `@blrbiran/issuemd`，MIT LICENSE，裁掉 vector/embed/banner/pretty | `npm test` 全绿；`issuemd FILE` 与 `lilmd FILE` 对同一输入逐字节相同 |
| **P1 修 7 缺陷** ✅ | D1–D7，每条先写 RED（直接取附录 A.1 探针），再实现原子写与行级拼接 | 13 个用例红→绿；真实 shell 下复验七个缺陷；模式位/E130 覆盖 |
| **P2 台账模型** ✅ | 管道块、多编号与区间、规范骨架和 `issuemd check FILE --json` | 合规样本 3 条开放、17 个关闭编号、0 个错误。坏例逐条报告 13 个 `E111`，带原文件行号 |
| **P3 台账写** ✅ | `new`/`close`/`status`/`rename`/`reopen`/`sync`/`counts`；原子写 + `--dry-run` | 每个命令的 diff 与预期行数逐字相符 |
| **P4 `adopt`** ✅ | 机械改动 + 待决清单 + `--report` | 对 cafe 形状的 mock 输出清单条目数与预期一致 |
| **P5 skill + 文档 + 清理** ✅ | SKILL.md、README、`--help`、TEMPLATE.md；删 `check-issues.mjs` 与 `verify-facts.mjs`；`SKILL.md` 打进 npm 包 | 无上下文 subagent 只读 SKILL.md 能完成三件事 |

依赖：P0 → P1 → P2 → {P3, P4} → P5。

---

## 13. 验收（mock fixtures）

不使用真实台账。`fixtures/` 下有四份合成文档，各自固定一组验收数据：

| 编号 | fixture | 用途 | 关键断言 |
|---|---|---|---|
| F1 | `fixtures/canonical-clean.md` | 规范格式 | `check` exit 0，开放 3 条，关闭 17 个编号，最大编号 20 |
| F2 | `fixtures/cafe-shaped.md` | 旧全量表布局 | `adopt` 列出 13 条仍有正文的已关闭项、2 条开放项标题冲突和 1 条携带进展的摘要 |
| F3 | `fixtures/orca-shaped.md` | 旧分组布局 | `adopt` 识别 11 个缺分隔行的管道块、12 个计数标题、1 处计数不符，保留无表头块的首行数据 |
| F4 | `fixtures/crlf-bom.md` | 编码边界 | 首个标题可读，写入后保留 BOM 和 CRLF，末尾仍无换行 |

`fixtures/*.expected.json` 记录人工核对过的结果。F1 用于 `check` 和 `counts`，F2/F3 用于 `adopt`，F4 用于字节保持测试。

---

## 14. 风险与开放问题

| # | 问题 | 现状 | 建议 |
|---|---|---|---|
| Q1 | 关闭即删正文后，`reopen` 只能从判据反推，原描述不可逆 | 已接受；`--keep-body` 的归档会被 `reopen` 恢复 | `--keep-body` 把正文搬 `## 附录`，信息可找回 |
| Q2 | `adopt --prefer` 在两边标题都「还行」时会丢信息 | 存在 | 默认 `--prefer=body`；`--dry-run` 必看 |
| Q3 | 单元格含换行/代码块 | 不支持 | `E108` 并提示拆行 |
| Q4 | >10k 行解析耗时 | 已测（2026-11-24）：10k issue / ~35k 行 ≈ 44ms 解析 + 79ms 完整 `check`；40k issue / 120k 行 ≈ 155ms + 270ms，无明显超线性 | `tests/scale.test.ts` 是上限守卫（2s/4s），不是微基准；解析器保持线性 |
| Q5 | 若团队需要第二套状态词 | v1 不支持 | 改工具或等 config |
| Q6 | 给旧台账补分隔行属于「改文档」 | 由 `adopt` 承担 | 默认 `--dry-run`；真应用需显式确认 |

---

## 15. 自查记录：被数据推翻的结论

| 曾以为 | 实测 | 教训 |
|---|---|---|
| `check-issues.mjs` 已丢失 | 在本仓库根目录，60 行、未入 git、只认 orca | 别信二手报告，先 `find` 两次 |
| 两份台账都「关闭即删正文」 | cafe 有 13 条孤儿正文；其协议明写「正文不动」 | 协议本身可能互相矛盾，先读协议再看数据 |
| cafe 的 27/28 是漂移 | 现在 15/15，且差异来自「短标签 vs 完整描述」 | 先分清列语义，再定不变量 |
| 已关闭表按编号升序 | cafe 按修复批次排序 | 升序只约束正文区，不约束已关闭表 |
| orca 的待处理只有 12 条 | 无分隔行的管道块没有表头，朴素实现把首行当表头 | 解析单位是管道块 |

---

## 附录 A：实测原始输出

> 环境：macOS，`node v22.23.4`，`npm 10.9.9`，`bun 1.3.14`，lilmd 0.5.0，pandoc。

### A.1 lilmd 7 个缺陷探针（已复现）

```bash
printf '\xef\xbb\xbf# T\n\n## A\n\na\n' > bom.md && lilmd bom.md
# bom.md  L1-5  1 heading
#   ## A  L3-5                     ← H1 消失（D1）

printf '# T\n\n## A\n\nbody\n\n```md\n## not a heading\n```\n\n## B\n\nb\n' > f.md
lilmd demote f.md "=A"; grep -n 'not a heading' f.md
# 8:### not a heading              ← fence 内被改写（D2）

printf '# T\n\n## Dup\n\none\n\n## Dup\n\ntwo\n' > d.md
lilmd set d.md "=Dup" --body 'X'
# 静默改第一个 Dup（D3）

printf '# T\r\n\r\n## A\r\n\r\nold\r\n' > crlf.md
lilmd set crlf.md "=A" --body 'new'; od -c crlf.md | head -2
# 0000000   # T \r \n \r \n # #    A \r \n  \n   n e w
#                                          ^^ 混入 LF（D4）

printf 'new-from-stdin\n' | lilmd set p.md "=A"
# lilmd set: --body <text> is required (or pipe content via stdin)   exit=2  ← 文案说谎（D5）

printf '# T\n\n## A\n\n#### deep\n\nx\n' > lv.md
lilmd promote lv.md "=A"
# # T
# # A                             ← 两个 H1（D6）

lilmd rm led.md "/Issue 1:/"
# 状态表 `| 1 | 未决 |` 仍在（D7）
```

### A.2 结构规模（当前文件）

| 文件 | 行数 | H2 | H3 | 管道块（合法 / 非表） | 索引 | 正文 | 已关闭 |
|---|---|---|---|---|---|---|---|
| cafe `issue-20261119.md` | 2701 | 5 | 36 | 44 / 0 | 76 行 | 28（13 条已关闭仍在） | 61 编号 |
| orca `issue-20261023.md` | 2108 | 5 | 42 | 17 / **11** | 16 行 | 16 | 273 编号 / 261 行 |

### A.3 orca 按编号计数（实测）

```text
未决 13 / 部分解决 3 / 已修 211（标题声明 212）
owner 裁决不跟踪 23 / 早期已关闭 5 / 决定不改 7（2 行）
延后 6 / 不是缺陷·产品裁决 7（3 行）/ 未分类 5（1 行）
范围外 3 / 撤回 3 / 并入 3
合计 289 个唯一编号；含（N）的标题 12 个
```

### A.4 cafe 漂移（实测）

```text
索引 76 行 = 已修 61 + 部分解决 7 + 未决 8
已关闭表 61 行 = 索引中已修集合（完全相等）
正文块 28 = 开放 15 + 孤儿 13（#56–60, #65–70, #75, #76）
开放项正文标题 vs 索引摘要：15/15 不同
已关闭项摘要 vs 索引摘要：60/61 不同
```

### A.5 渲染验证（pandoc GFM）

```bash
pandoc -f gfm orca/issue-20261023.md -t html | grep -c '<table'   # 17
pandoc -f gfm orca/issue-20261023.md -t html | grep -c '^<p>|'    # 11
pandoc -f gfm cafe/issue-20261119.md  -t html | grep -c '<table'  # 44
```

### A.6 正文风格差异（解释为什么骨架是 lint 而非硬约束）

| 台账 | H4 数量 | `**加粗标签**` | 判据位置 |
|---|---|---|---|
| cafe | 174 | 0 | 正文 `#### 验收判据`（28/28） |
| orca | 0 | 125 | 正文 7 / 表格判据列 9 |

canonical 只允许加粗标签（S6）；cafe 的 174 个 H4 由 `adopt` 降级。

### A.7 lilmd 代码规模（拷贝基线）

| 文件 | 行数 | 处置 |
|---|---|---|
| `src/cli.ts` | 1155 | 拆分为 `cli/` 下按命令分组 |
| `src/write.ts` | 231 | 重写（行级 + 原子） |
| `src/select.ts` | 179 | 保留，修分词器 |
| `src/scan.ts` | 173 | 保留，加 fence 状态输出 |
| `src/banner.ts` | 153 | 删除 |
| `src/vector.ts` | 135 | 删除 |
| `src/render.ts` | 115 | 保留 |
| `src/sections.ts` | 89 | 保留 |
| `src/pretty.ts` | 58 | 删除 |
| `src/embed.ts` | 52 | 删除 |

测试基线：7 个文件（cli 80 / render 16 / scan 17 / sections 12 / select 27 / write 27 / integration 8）。可平移，但 `write` 的 27 个断言需按新写入语义重写。

**裁掉的依赖**：`@huggingface/transformers`、`@libsql/client`、`terminal-image`、`chalk`、`marked`、`marked-terminal` → **零运行时依赖**。
