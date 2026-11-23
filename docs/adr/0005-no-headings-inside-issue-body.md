# 正文块内禁止 Markdown 标题

issue 正文只允许 `**加粗标签**`（`**现象**`、`**根因**`、`**期望**`、`**验收判据**` 等），不允许任何 `#`–`######` 标题；违反即 E110。需要只读一段时用 `issuemd show FILE ID --label 验收判据`。

**Considered options**

- *允许 H4 并约束标签词表*：保留 `lilmd "Issue 65 >> 验收判据"` 这类选择器，但让标题层级重新承载语义，`promote`/`demote`/`mv` 会在正文上腐化结构（lilmd 已有 D2/D6 两个实测缺陷）。
- *不管*：正文结构无约束，`###` 唯一性的保证失效，TOC 与 `check` 都要猜哪个 H4 属于哪条 issue。

**Consequences**

`### Issue N:` 成为「一条 issue 一行」的唯一层级，TOC、`check`、`mv` 都不必消歧。cafe 的 174 个 H4 由 `adopt` 降级为加粗标签，视觉损失很小。`show --label` 用约 30 行代码换回按段读取的能力，且对上下文更省。