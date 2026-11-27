# 第二十二轮设计：W201 出口、写路径诊断、归档卫生

日期：2026-11-27 · 输入：dogfooding 台账 #103–#127 复核（见 `docs/handoff/handoff.md` 第二十一轮）
范围：Batch A（#106/#118/#119/#115）、Batch B（#122/#105/#111）、Batch C1（#126/#114 文案/#116）

## 意图

测试者的复核里有一组问题共享同一个根：**`check` 的分数可以被格式化或搬家刷绿，而真正在膨胀的内容没有出口**。同时写命令对「我到底改了什么」完全沉默，写失败时把四种完全不同的原因折叠成一句「只读」。本轮把这些从「可见但不行为」推进到「可配置、可度量、可清理」。

非目标（留给下一轮）：`archive list/drop` 与 prune 动词（#114 判据 3）、`find`（#127 尾项）、`criteriaItems`（#120）、W202 全位置报告与 `--fix-hashes`（#113）、近邻判据块取舍（#117）。

反目标：不引入 `.issuemd.json` 之类的新配置文件；不要求环境变量；不要求每次调用传参数。

## Approaches（已在对话中选定）

| 决定 | 选项 | 选择 |
|---|---|---|
| W201 阈值存储 | 环境变量 / 第二个配置文件 / 命令行参数 / **台账前言标记** | **台账前言 HTML 注释**，缺省 20 KiB / 300 行 |
| 阈值写入方式 | 手改注释 / **新增 `limits` 动词** | **`limits` 动词**，走 `commit()` 门禁 |
| 空 `## 附录` 回收 | 启发式 / 只报警 / **来源标记** | **`appendix:auto` 标记** |
| 重复 `## 附录` | 维持一区 / **唯一性拒绝** | **W266 + close/reopen exit 2**（推翻 round 20 写入侧） |
| 写成功回执 | 静默 / opt-in / **统一一行** | **每次成功一行 stderr，含 snapshot** |

## 设计

### 1. 台账内 limits（#118、#106 一半）

前言（第一个 H2 之前）允许一条：

```markdown
<!-- issuemd:limits: body-bytes=20480 body-lines=300 -->
```

- 解析：只认前言、只认 `key=value`、只认 `body-bytes` / `body-lines` 两个键；正安全整数。
- 缺省：无标记 → `{bodyBytes: 20480, bodyLines: 300, source: "default"}`。
- 异常：重复标记、坏值、未知键 → **W267**（strict 失败），点名行号并声明「已退回默认值」。`limits` 动词拒绝写坏值（exit 2）。`limits` 也拒绝重写与正文混在一行或未独立闭合的标记，保全相邻文本。
- `check --json` 顶层固定带 `limits: {bodyBytes, bodyLines, source}`。
- `adopt` 前言逐字保留，标记随文迁移。

### 2. W201 度量与消息（#118、#119、#115）

- 消息报实测值与超出维度：`Issue body exceeds limits: 24883 UTF-8 bytes (limit 20480), 471 lines (limit 300)`，只列超出的维度。
- 度量域扩展到**附录归档块**：每个 `### #N …（已关闭，正文保留）` 的可读 payload 单独计算，超限报同一 W201，`id` 指向原编号。
- 手写（非归档）的 `## 附录` 内容不度量：它不是 issue 正文，也无 id 可归属；这一点写进 spec 与 SKILL。
- `check --json` 顶层新增 `size`：`{bytes, lines, bodyLines, archivedLines, archivedBlocks}`。
- 文本摘要行追加体积：`0 errors, 3 warnings · 1.1 MiB / 10,969 lines · body 8,812 · archived 1,622 in 12 block(s)`。

### 3. 写入期 W201 提示（#106 判据 3）

`body`（替换与追加）首次超限、或 `close --keep-body` 产生超限归档时，stderr 追加 W201，并复用 `check` 的实测值。关闭时提醒已有超限，方便使用者决定是否留档。退出码仍为 0，`--dry-run` 同样提示。

### 4. 写成功回执（#122）

所有写命令成功后 stderr 追加一行统一格式：

```
wrote FILE #N <verb detail> (snapshot S)
```

- `status`：`status 未决 → 观察`；`priority`：`priority P2 → P1`；`close`：`closed as 已修`；`reopen`：`reopened as 未决`；`body`：`body replaced, 412 bytes` / `body appended, 412 bytes`；`new`：`new #N`；`split`：`split into N rows`；`rename` 保留逐条明细并追加快照行；`limits`：`limits body-bytes 20480 → 30720`。
- snapshot 为**写入后**内容的前 16 位，可直接喂下一步 `--if-unchanged`。
- `(no changes)` 与 `--dry-run` 不产生回执。
- 实现：`commit()` 增加 `receipt?: string`（由调用方给动作描述），成功后统一拼 `wrote …`。

### 5. errno 分档（#105）

`readOnlyRefusal` 保留错误对象：

| errno | 文案 |
|---|---|
| `EACCES` | 现文案 + `chmod u+w FILE` |
| `EPERM` | 「权限或策略拒绝（沙箱 / immutable 标志 / 受管目录），不是文件 mode」 |
| `EROFS` | 「文件系统只读挂载」 |
| `ENOENT` | 「文件已不在；重新 list/show 后再试」 |
| 其他 | 带原始 `code` 与 message |

父目录不可写的 `issuemd-lock` 路径改用同一套分类措辞。

### 6. `close --criteria` 的竖线提示（#111）

输入经 `unescapeCell` → `escapeCell` 后若与输入不同（即发生了转义改写），stderr 追加 `W205: the criteria contain a pipe; it was stored escaped in the table cell`。往返本身保持「标题约定」不变；不支持表达的奇偶情形仍 exit 2（既有行为）。

### 7. 重复 `## 附录`（#126）

- 新增 **W266**：`## 附录` 多于一个时逐条给行号，strict 失败。
- `close --keep-body`（需要写归档时）与 `reopen`（需要选归档时）在附录数 > 1 → **exit 2**，stderr 列出全部候选行号，文件字节不变。
- 不写归档的 `close`（无 `--keep-body`）不受影响。
- 扫描类行为（W250–W253、`rename` 同步归档标题）继续遍历全部附录。
- 更新 round-20 用例与 handoff 记录这次写入侧反转。

### 8. 空 `## 附录` 回收（#116）

- `close --keep-body` 因**原本没有附录**而新建时，写入 `## 附录` 后紧跟 `<!-- issuemd:appendix:auto -->`。
- `reopen` 删除归档后，若该附录带 auto 标记且节内除标记和空行外无原始内容（用户注释也算内容） → 连同标记整节删除；否则保留。
- 既有台账里没有标记的空附录不动（只有 `check` 可给 informational 提示，本轮不加 warning，避免真实台账变红）。
- 从此「先 close --keep-body 再 reopen」在无附录台账上字节可逆。

### 9. `close` 缺判据的文案与 help（#114 判据 1/2）

- 报错与 `--help` 点明三条出口的体积后果：`--no-criteria` 清空表格判据并移除未保留的正文。`--criteria TEXT` 记录结论。`--keep-body` 将证据留在文件内。
- SKILL 的 `close` 示例组补一条不带 `--keep-body` 的常规收尾。

## 约束

- 全部走 TDD：先写失败用例（`src/round22.test.ts`），再实现。
- 字节保真：原子写、CRLF/BOM/无尾换行、`--dry-run` diff 可 `patch`。
- 既有 724 项必须保持绿；契约变更处同步改旧用例并在 handoff 记录。
- 真实台账（dogfood / cafe / orca）只读复测，不写外部文件。

## 留给实现者的判断

- W266 用 warning（strict 失败）而非 error，理由是单附录台账完全不受影响，且 error 会让既有双附录台账无法再用任何写命令自救（需要手改）。
- `limits` 标记的插入位置与 high-water 一致（首个 H2 前），两者可共存，互不覆盖。