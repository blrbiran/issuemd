# <项目名> Issue 台账

> 唯一台账 + 唯一正文。状态只在下表；正文不写状态。编号不回收。
> 读法：`issuemd list <file>` / `issuemd show <file> <id>` / `issuemd check <file>`

## 怎么用

<!-- issuemd:guide:begin -->
| 你想做什么 | 命令 |
|---|---|
| 查看开放项 | `issuemd list FILE` |
| 读一条 | `issuemd show FILE ID` |
| 新增 | `issuemd new FILE --title "…"` |
| 关闭 | `issuemd close FILE ID --criteria-from-body` |
| 改状态 | `issuemd status FILE ID 状态` |
| 重命名 | `issuemd rename FILE ID "新标题"` |
| 校验 | `issuemd check FILE` |
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

## 已关闭

| # | 状态 | P | 摘要 | 判据 |
|---|---|---|---|---|

## 正文

## 附录