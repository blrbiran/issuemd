# 一个入口，只做台账

`issuemd` 不提供通用 Markdown 命令。它没有 `toc` / `ls` / `grep` / `set` / `rm` / `promote` / `mv`，也没有选择器语法；`issuemd FILE` 不是任何命令的简写，而是一个用法错误。要读普通 Markdown 的某一节，用 `issuemd read FILE <H2 标题>`；要编辑普通 Markdown，用 lilmd 或编辑器。

**Why this is not obvious**: P0 把 lilmd 的命令整批拷进来，它们工作正常，删掉看起来是净损失。而且「同一个 bin 什么都能干」对 CLI 是一种常见直觉。

**实测依据**：同一个 `rename` 既是「改一行标题」又是「索引摘要与正文标题同改」，实测在台账上只改了正文标题、吃掉 `Issue 2:` 前缀，而 `check` 仍报 0 error。为了让通用 `rm` 不破坏台账，P1 被迫让通用层认识台账——耦合方向反了。只要两套语义共用一个入口，每一次新增台账保证都要在通用命令里再补一次判断。

**Consequences**

- 每条命令只有一种写法、一个语义。「`issuemd FILE` 是不是等于 `list`」这类问题不再存在。
- 台账写命令共享一个门禁：内存里重跑 `check`，只拒绝新出现的 error。通用命令没有这个门禁，所以它们的写路径必须删掉，而不是留着「反正也没人用」。
- 代价：`issuemd` 不再是 lilmd 的超集，两个工具的命令表面各自演进。用户若想要 lilmd 的读命令，装 lilmd。
- 连带删除了 `src/select.ts`（通用选择器）与 `src/render.ts`（TOC 渲染）。台账不需要它们；`read` 的精确 H2 匹配只有十几行。
