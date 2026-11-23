# 自持 lilmd 源码，而非依赖或 fork

lilmd 的写入路径有七个会静默改错文件的行为（BOM 吞标题、fence 内 heading 被改写、重复选择器只改第一个、CRLF 混写、stdin 文案说谎、`promote` 造出两个 H1、台账无表感知），且写入是非原子的 `writeFileSync` 直写。这些恰好是 issuemd 最需要控制的代码。因此把 `src/` 与 `bin/` 原样拷入本仓库自行维护，而不是以依赖形式引用 lilmd，也不是 fork 上游仓库。

**Considered options**

- *依赖 `lilmd` npm 包*：七处缺陷都要在包外绕过，共用的写入语义隔着包边界改不动。
- *fork 上游仓库*：会把上游的提交历史与发布节奏带进来，而 lilmd 后续只做维护、由 issuemd 取代。
- *按接口重写*：功能等价但代码从零写起，读取侧 800 行已验证逻辑要重测。

**Consequences**

issuemd 使用 MIT。P0 从 lilmd 的 `b557b02` 复制 Markdown 相关模块。该上游版本未附许可证，公开分发前需核实上游代码的授权。P0 裁掉向量、嵌入、banner 和 pretty 功能，运行时依赖为零。计划发布到 `@blrbiran/issuemd`，命令名仍是 `issuemd`。