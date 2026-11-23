# 自持 lilmd 源码，而非依赖或 fork

lilmd 的写入路径有七个会静默改错文件的行为（BOM 吞标题、fence 内 heading 被改写、重复选择器只改第一个、CRLF 混写、stdin 文案说谎、`promote` 造出两个 H1、台账无表感知），且写入是非原子的 `writeFileSync` 直写。这些恰好是 issuemd 最需要控制的代码。因此把 `src/` 与 `bin/` 原样拷入本仓库自行维护，而不是以依赖形式引用 lilmd，也不是 fork 上游仓库。

**Considered options**

- *依赖 `lilmd` npm 包*：七处缺陷都要在包外绕过，共用的写入语义隔着包边界改不动。
- *fork 上游仓库*：会把上游的提交历史与发布节奏带进来，而 lilmd 后续只做维护、由 issuemd 取代。
- *按接口重写*：功能等价但代码从零写起，读取侧 800 行已验证逻辑要重测。

**Consequences**

lilmd 无 LICENSE 文件、`package.json` 无 `license` 字段、npm registry 上 license 为 null；仓库作者与本项目作者为同一人，故按 MIT 处理并在 README 注明 derived from lilmd。向量、嵌入、banner、pretty 四个模块及其六个运行时依赖随之删除，运行时依赖归零。包名不能沿用 `issuemd`（npm 上已被 2014 年的同名包占用），发布为 `@blrbiran/issuemd`，`bin` 仍叫 `issuemd`。