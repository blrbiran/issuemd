# 补齐台账写命令：body / priority / split / reopen --status

状态：**已实现，待 owner 复核**（2026-11-24，分支 `feat/ledger-verbs`，未合入 `main`）。
来源：dogfooding 台账 `issue-20261124.md` 的 #10、#16/#24、#30、#44。

## 问题

命令面目前按「状态事务」枚举（new / close / reopen / status / rename / sync）。但台账里还有三类日常改动没有命令，只能手改，于是绕过写入门禁：

| 改动 | 现在 | 后果 |
|---|---|---|
| 补充/改写开放 issue 的正文 | 手改 | 手改后忘了 `check` 就是漂移；`close`+`reopen` 当编辑器用会丢原文 |
| 调整优先级 | 手改表格 | 唯一一项只能手改的行元数据 |
| 拆开 `\| 20, 24, 29 \|` | 手改 | per-id 命令的报错让你「split the row first」，但没有命令；skill 又说别手改表格 → 死锁 |
| reopen 到 `观察` / `部分解决` | 只能回到 `未决` 再 `status` | 两次事务，中间态是错的 |

ADR 0006 的约束仍然成立：**只做台账，不加通用 Markdown 命令**。下面四项都是台账事务：每个都只动一条 issue 的固定位置，走同一个 `commit()` 门禁（内存重跑 check、只拒新 error、原子写、`--dry-run` 出 diff）。

## 设计

### `issuemd body FILE ID --body-file PATH|- [--dry-run]`

替换开放 issue 正文块中**标题以下**的全部内容（标题不变，仍由摘要决定）。输入与 `new --body-file` 完全同一套校验：剥 BOM、拒绝 `#`/`##`、拒绝未闭合 fence；`###`/Setext 由门禁以 E110 拒绝。

- 已关闭的 id → exit 2（已关闭项没有正文；要改判据用 `close` 之前的正文，或手改判据列）。
- 多号行 / 区间 → exit 2，与其他 per-id 命令一致。
- 开放项没有正文块（E102 状态）→ 按编号位置新建一个。
- 不提供按标签改（`--label X --set`）：一次换整块更好审（diff）也更难出半截错误。需要改一段时：`show --json` 取 `body.text` → 改 → `body --body-file -`。

### `issuemd priority FILE ID P [--dry-run]`

只改该行的 `P` 单元格。开放与已关闭行都可以。`P` 必须是 `P0`–`P3` 或 `""`（与 `new` 同一词表）。多号行 / 区间 → exit 2。

### `issuemd split FILE ID [--dry-run]`

把 ID 所在的多号行（`| 20, 24, 29 |`）或区间行（`| 7–20 |`）拆成每个编号一行：状态、优先级、摘要、判据原样复制，按编号升序原位放置。

- 单号行 → exit 2（没有可拆的）。
- 区间展开超过 1000 行 → exit 2（`1–199` 这类退休区间通常不该拆；真要拆请分段手改）。
- 开放表里拆出的编号若没有正文块，按摘要生成标签骨架（否则就是 E102）。
- 反向的 merge 不做：合并多条 issue 是语义决定，留给人。
- 开放表里拆出的几行摘要相同，`check` 会报 W212（开放项重复摘要），直到逐条 `rename`；已关闭表拆出的行不报（W212 只比较开放项）。

### `issuemd reopen FILE ID [--status S] [--dry-run]`

`S` 必须是开放分类的状态（`未决` / `部分解决` / `观察`），默认 `未决`。关闭前的状态不记录在任何地方，所以默认值仍是 `未决`，不做「恢复原状态」。

### 选项与帮助

四个命令都进 `COMMANDS` 表：只接受自己的选项，`issuemd <cmd> --help` 打印自己的用法。per-id 命令拒绝多号行时的提示改为指向真实命令：`split the row first: issuemd split FILE <id>`。

## 不做

- 通用正文编辑（按选择器改段落、插入、删除）——ADR 0006。
- 自动锁 / 排队（dogfooding #18 第 4 点）——E130 + exit 4 + 重试协议已足够；需要时另开设计。
- `adopt --verify=<原文件>` 的独立比对命令（#46 第 2 点）——adopt 已内置「每行都在输出里」的守恒自检。

## 验收

- 每个命令：`--dry-run` 不改字节、diff 只含目标行；被拒绝的写不留半截修改；写后 `check` 的 error 不增加。
- `body`：替换后 `show --label` 读到新内容；已关闭 id exit 2；输入含 `## x` exit 2。
- `priority`：`Q9` exit 2；已关闭行可改。
- `split`：`| 20, 24, 29 |` 拆后三个 id 都能被 `close`/`rename`/`status` 单独操作，`check` 0 error；区间可拆。
- `reopen --status 观察` 落在 `观察`；`--status 已修` exit 2。
