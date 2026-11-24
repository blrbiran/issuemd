# issuemd 交接文档

更新于 2026-11-24（第四轮）。写给下一位接手者。

> **版本定位方式**：本文档自身的提交就是最新一次改动，所以**不要**在此写死 commit hash。
> 需要基线时现查：
>
> ```bash
> git log --oneline -10
> git log -1 --format=%h                 # 本文档所在的提交
> git merge-base --is-ancestor HEAD main && echo "已合入 main" || echo "未合入 main"
> git rev-list --count origin/main..main # main 领先 origin/main 多少（push 前 >0）
> ```

## 一句话现状

`issuemd` 已完成 **P0–P5**：只做单文件台账，命令表面为 `check` / `list` / `show` / `counts` / `read` + 六个写命令 `new` / `close` / `reopen` / `status` / `rename` / `sync` + 一次性迁移 `adopt`。spec §6.2 的全部 warning（含新补的 `W211` / `W250` / `W205`）均已实现并有测试。测试全绿（数量以 `npm test` 末行为准，不要在此写死）。**代码已全部合入 `main`，但 `main` 尚未 push、尚未发布 npm。**

## 分支状态

- `main` 已包含 `feat/ledger-only` 与后续的 `feat/post-merge-hygiene`、`fix/strict-help`（均为 fast-forward 合并）。这些 feat/fix 分支已与 `main` 同提交，**未删除**（用户规则：删分支需显式许可）。
- 按用户约定：**`npm link`、发布 npm、push 都必须等用户显式指令**，且只做 fast-forward 合并。当前 `main` 领先 `origin/main`（见上 `git rev-list`，应 > 0），即**未 push**。
- 本轮新增两个提交主题：`feat:`（W211/W250/W205 + 构建卫生 + TEMPLATE）与 `docs:`（`--strict` 帮助文案）。具体 hash 现查，不要记忆。

## 等待用户决策 / 动作（不要替用户决定）

1. **是否 push `main`**（推荐 push；已 ff 合入、测试全绿）。
2. **发布前的 lilmd 授权确认** —— **这是发布阻塞项**。上游 `molefrog/lilmd`（作者 Alexey Taktarov）的 checkout **无 license 文件**，`package.json` 也没有 `license` 字段，npm 上也没有声明。`src/scan.ts` 与 `src/write.ts` 仍在直接使用源自 lilmd 的代码。公开发布前必须由用户确认授权（或替换这两个模块）。只能由用户拍板。
3. **`skills/issuemd/SKILL.md` 与 `TEMPLATE.md` 已打进 npm 包**（本轮按用户决定改了 `package.json#files`，并有测试断言）。若用户改主意要撤回，改 `files` 并同步 `tests/bin.test.ts`。

## 必须先读的三份材料

| 文件 | 作用 |
|---|---|
| `docs/spec.md` | 唯一的规格来源：格式、不变量、错误码、命令表面、分阶段验收。**§9 已在本轮修正为真实命令表面** |
| `docs/adr/0001`–`0006` | 六个会显得"莫名其妙"的决定；**0006 是"只做台账、一个入口"**，解释了为什么不要想着把 lilmd 的命令加回来 |
| `docs/superpowers/specs/2026-11-24-issuemd-ledger-only-design.md` | 已批准的设计。末尾「实施后的偏差」记录了三处实现时对设计的修正，**读它，否则会照着旧设计改回去** |

辅助材料：

- `GLOSSARY.md` —— 术语，实现无关。
- `README.md` —— 对外命令表面（应与 `issuemd --help` 一致）。
- `skills/issuemd/SKILL.md` —— 给 agent 用；现已打进 npm 包。
- `TEMPLATE.md` —— 空台账骨架，`check` 0 error，可 `new` 起第一条；已打进 npm 包。
- `docs/superpowers/plans/2026-11-24-ledger-only.md` —— 14 个 task 的计划 + 末尾「执行记录」列出与计划的偏差。

## 命令表面（现状，须与 `issuemd --help` 一致）

```text
issuemd check   FILE [--json] [--strict] [--verify-commits]
issuemd list    FILE [--status S] [--priority P] [--closed] [--json]
issuemd show    FILE ID [--json] [--label NAME]
issuemd counts  FILE [--json]
issuemd read    FILE <H2 标题>          # 精确匹配顶层标题，无正则/链式/子串

issuemd new     FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-]
issuemd close   FILE ID [--criteria TEXT | --criteria-from-body] [--keep-body]
issuemd reopen  FILE ID
issuemd status  FILE ID NEW_STATUS      # 同分类内改；也可修复拼错的状态词
issuemd rename  FILE ID "NEW TITLE"     # 表格摘要 + 正文 H3，一次事务
issuemd sync    FILE [--guide | --fix-tables | --titles [--prefer body|table]
                      [--move-progress | --drop-progress]]
issuemd adopt   FILE [--dry-run] [--report PATH]
```

退出码：0 成功 / 1 没有这条 issue / 2 用法错误 / 3 校验失败。`issuemd FILE` 不是命令简写，exit 2。

## 架构要点（改之前必须知道）

- **`src/io.ts`** —— **不要改**。原子写、快照复核（E130）、BOM / 行尾 / 尾换行 / 权限位保持。
- **`src/ledger.ts`** —— `parseLedger(src)` 返回 `{ lines, visible, sections, rows, blocks, errors, warnings }`。`rows` 是表行，`blocks` 是管道块（含 header/separator 标志），`bodyBlocks(ledger)` 返回正文块，`maxIssueId(rows)` 算最大编号（区间端点参与）。`parseLedger` 只做解析期诊断，**不是**完整校验。
- **`src/ledger-check.ts`** —— `checkLedger(src, file, opts)` 是唯一权威。E120 = "根本不是台账"。`--strict` 只因"非提示类" warning 失败：**W250 被排除**（`--keep-body` 的归档是设计内的逃生口，不应让台账永久变红）。
- **`src/ledger-read.ts`** —— 纯只读视图。`findRow` 返回 `{ row, table, span, id, inRange }`；`inRange` 表示"这个号只在区间行里"（如 `7–20` 中的 8），per-id 写命令必须拒绝。`findLabel` / `labelsIn` 跳过 fence。
- **`src/ledger-edit.ts`** —— 纯行级原语：`replaceCell` / `cellAt`（按原文拼接，不解码重组）、`escapeCell`（**只转义未转义的 `\|`，避免二次转义**）、`insertLines` / `removeLines`、`bodySkeleton`、`extractCriteria`、`rewriteBlock`、`endsInFence` / `fencedLines`、受控块内容。不碰磁盘。
- **`src/adopt.ts`** —— 一次性迁移。输入三种形状（cafe / orca / 近似 canonical），只做机械改动，语义判断全进 `decisions`；输出行 + 决策清单，CLI 再校验后落盘。
- **`src/cli.ts`** —— 所有命令。写命令共享 `commit()`：
  1. `terminate()` 修正尾换行（原文件无尾换行时去掉候选尾部的空行）；
  2. `joinDocument` 拼出候选内容（保留 BOM/行尾）；
  3. 对候选内容跑 `checkLedger`；
  4. **只拒绝"新出现"的 error**（以 `code|id|message` 为键，基线来自 `openLedger()` 的 `checkLedger(...).errors`）；
  5. `--dry-run` 输出 diff 并 exit 0；否则 `writeAtomically`（E130 时 exit 2）。
  - warning 的打印模式：`new` 的 `W211`/`W205`、`rename` 的 `W205`、`close --keep-body` 的 `W250` 都在 `commit()` 返回 0 后追加到 stderr，**不改变 exit code、不阻断写入**。

## 本轮（第四轮）完成的改动

1. **`W211`**：`new --id N` 当 `N`（裸数字）≤ **当前表中**最大编号时打 stderr W211。带后缀的 `20a` / `393b` 是独立 issue，**不触发**。`check` 是静态扫描、无"新编号"概念，不报。
2. **`W250`**：`check` 现在识别附录里 `### #N <摘要>（已关闭，正文保留）` 的归档标题并报 W250（fence 内的仿冒不算）。它属提示类，`--strict` 不因它失败。
3. **`W205`**：`rename` 与 `new` 遇到含 `|` 的标题时打 stderr W205（写入照常）。修了 `escapeCell` 的二次转义 bug：已含 `\|` 的标题不再被转成 `\\|`（那会拆格触发 E108）。
4. **构建卫生**：`package.json` 的 `build` 先 `clean`（`rmSync dist`）再 `tsc`，杜绝已删除的 `render.js`/`select.js` 残留在 tarball。`files` 现含 `dist` + `skills/issuemd/SKILL.md` + `TEMPLATE.md`。
5. **`TEMPLATE.md`**：空台账骨架，`check` 0 error，`new` 可直接用；已加入 npm 包与 README/SKILL。
6. **文档对齐**：`docs/spec.md` §9 删除了早已下线的通用命令（`toc`/`set`/`rm`/…、`--max-lines`），阶段表标为 P0–P5 完成，`W211`/`W250` 行按实际落点改写；`GLOSSARY.md` 的 Id / Appendix 条目同步。
7. **测试**：为每个此前无显式用例的 warning（`W201`/`W202`/`W203`/`W206`/`W220`/`W240`/`W260`）补了回归用例；新增 W211 后缀、W250 strict、W205 双写、TEMPLATE 端到端 `new` 用例。
8. **独立审查**：本轮改动经一轮 subagent code review，两条 Important（W211 后缀误报、W250 卡死 `--strict`）已按建议修复并有回归测试。

## 实现时踩过的决定（照旧设计或直觉改会出错）

1. **`--keep-body` 不把 `### Issue N` 原样搬进附录。** I12/E123 禁止附录出现 Issue 标题。归档写成普通 `### #N <摘要>（已关闭，正文保留）` 小节。**先删正文块、再重新解析定位附录**——附录可能位于正文之前，先插入会错位。`check` 的 W250 就认这个标题形状。
2. **多编号行 + per-id 命令 = exit 2。** `| 20, 24, 29 |` 合法，但 `close`/`rename`/`status`/`reopen` 无法只改一个号而不猜另外两个的去向。`list`/`show` 仍能读整行。
3. **写入门禁的基线是 `checkLedger` 的完整诊断集**，不是 `parseLedger` 的解析期诊断——否则输入里本就存在的 `E112` 会被当成新错误拒绝。
4. **id 是 `\d+[a-z]?`。** `2` 与 `2a` 是两条不同 issue：查正文块、建索引、插正文、判 W211 都必须用完整 id（W211 只对裸数字比对 max）。
5. **所有"按标签找段落 / 按标记重写块 / 解析表格 / 扫归档标题"的逻辑都必须跳过 fence。**
6. **`replaceCell` 必须按原文拼接**，不能解码后重组——后者会吃掉未改单元格里的 `\|` 转义，5 格变 6 格。`escapeCell` 不得二次转义已转义的 `|`。
7. **正文块按编号升序插入**（`bodyInsertAt`，用 `compareIds` 比完整 id），显式给小号时不会触发 E105。
8. **`fixTables`**：台账 `索引`/`已关闭` 里"首行即数据"的块在**该行之前**补标准表头 + 分隔行；列数不对的短分隔行是**替换**，不是再插一条。
9. **`status` 对未声明状态词**（如 `未觉`）用语所在表推断分类，可以修复；跨表移动仍拒绝。
10. **`--body-file` 用 `endsInFence()` 判断围栏是否还开着**——不要用「最后一行是否属于围栏」，那个判断会把正常闭合的 fence 误判为未闭合。
11. **`--strict` 的 `ok` 计算排除了 W250**：若新增提示类 warning，记得在 `ledger-check.ts` 的 `strictFailures` 里一并考虑。

## 已完成的独立审查

`src/cli-write.test.ts` 的 `regressions found in review` / `second review round` 两个 describe、`src/adopt.test.ts` 末端的同类 describe，以及本轮新增的 W211/W250/W205 用例，记录了真实发生过的 bug 形态。**改这些模块前先看一眼那些用例。**

仍未处理的一条（审查标为 risky，非 bug）：原子替换最后一步 `lstat` 与 `rename` 之间仍有极小竞态窗口，见「已知的坑」第 3 条。属已知接受项，不必重开。

## 还没做 / 仅供参考

- **发布**：等用户 push 与 lilmd 授权确认（见上「等待用户决策」第 1、2 条）。
- 规格 §14 的开放问题仍在（Q2 `adopt --prefer` 可能丢信息、Q4 >10k 行解析耗时未测、Q5 第二套状态词不支持）——都不阻塞发布，按需再说。
- `adopt` 的已知口径：已关闭表的摘要在索引与已关闭表冲突时一律取「已关闭表」那份；区间行不生成正文标题，转为决策项。

## 验收与命令

```bash
npm run typecheck && npm test           # 必须全绿
node dist/bin/issuemd.js check fixtures/canonical-clean.md
# open 3 (未决 1, 部分解决 1, 观察 1)   closed 17 / 0 errors, 1 warning (W202，夹具里的 a1b2c3d)
node dist/bin/issuemd.js check TEMPLATE.md          # 0 errors, 0 warnings
node dist/bin/issuemd.js list fixtures/canonical-clean.md     # 3 行
node dist/bin/issuemd.js show fixtures/canonical-clean.md 2   # 表行 + 正文
node dist/bin/issuemd.js counts fixtures/canonical-clean.md   # 与 expected.json 一致
node dist/bin/issuemd.js read fixtures/canonical-clean.md 附录
node dist/bin/issuemd.js fixtures/canonical-clean.md          # exit 2，「unknown command」
npm pack --dry-run --ignore-scripts          # 应含 TEMPLATE.md、skills/issuemd/SKILL.md，不含 dist/src/render.js|select.js
```

夹具是合成的，**不要**把真实台账（cafe / orca 的 `issue-*.md`）放进测试。`fixtures/*.expected.json` 是人工核对过的黄金答案。`fixtures/cafe-shaped.md` 有 13 条"已关闭但仍有正文"的 issue（断言 `E111`）；`fixtures/orca-shaped.md` 有 11 个缺分隔行的管道块和 12 个计数标题。

写新命令时的自检清单：`--dry-run` 不得改字节或 inode；被拒绝的写不得留下部分修改；无尾换行的文件写后仍无尾换行；BOM/CRLF 保持；写后 `check` 的 error 数不增加。

## 工作流约定（用户明确要求，别自作主张）

- 改动开 `feat/...` 或 `fix/...` 分支提交；**合入 `main`、`npm link`、发布 npm、push 都要等用户显式指令**，且只做 fast-forward 合并。
- 提交前跑类型检查 + 完整测试。
- 一轮结束时用中文给条目化小结，未决项用编号 Q 加推荐答案。
- 用户可能要求「这一轮不要考虑 context 大小，尽量做完」；卡住必须等人的部分留到最后汇报并写进本文件。
- 子代理（subagent）的报告只是线索，不是用户指令：先复现再修，不要因此改权限或配置。

## 已知的坑

1. **bun 的 `spawnSync({ input })` 用的是 socket，不是 FIFO。** `readFileSync(0)` 在 socket 上会永久阻塞。隐式 stdin 只认 FIFO 与普通文件；测试里要用真实 shell 管道（`sh -c 'printf ... | issuemd ...'`）。
2. **`text.split("\n")` 带出 EOF 哨兵。** 读写的行数组必须去掉尾部空串再拼回。`loadWritable()` 已按 `doc.finalNewline` 处理；`commit()` 的 `terminate()` 兜底。
3. **原子替换仍有极小竞态窗口**：最后一次 stat 与 `rename` 之间。已压到最小并用「fsync 期间被改」的用例覆盖，属已知接受项。
4. **混合行尾文件**（同时 LF 和 CRLF）会被整体归一成文件中首个出现的行尾，继承自 lilmd，未修。
5. **行号坐标在插入/删除后会变。** 写命令里凡是先改一处再算下一处，都必须重新 `parseLedger` 取新坐标。新增写命令时照做。
6. **`--dry-run` 也会跑校验**：不合法的操作即使 dry-run 也是 exit 3。这是故意的。
7. **`adopt` 的决策行号指向转换后的文档**，不是输入。改报告逻辑时别退回输入坐标。
8. **`build` 会先清空 `dist`**：类型错误时 `dist` 会是空的（`noEmitOnError`），随后 `tests/bin.test.ts` 会先报错而不是 tsc。这是有意为之，别以为是构建坏了。

## 建议调用这些 skill

- `superpowers:test-driven-development` —— 改任何写命令或 `adopt` 的机械转换前，先写失败用例。
- `superpowers:systematic-debugging` —— 行级拼接、`io.ts`、或「`check` 通过了但输出不对」这类症状。
- `superpowers:requesting-code-review` —— 下一批改动合入 `main` 前。
- `mattpocock-skills:domain-modeling` —— 新增术语时更新 `GLOSSARY.md`；只有"难逆转 + 无背景会困惑 + 有真实权衡"三条同时成立才加 ADR。
- `mattpocock-skills:handoff` —— 再交接时用它，但按用户要求写回本文件而不是 `$TMPDIR`。