# issuemd 交接文档

更新于 2026-11-24（第五轮）。写给下一位接手者。

> **版本定位方式**：本文档自身的提交就是最新一次改动，所以**不要**在此写死 commit hash。
> 需要基线时现查：
>
> ```bash
> git log --oneline -10
> git log -1 --format=%h                 # 本文档所在的提交
> git merge-base --is-ancestor HEAD main && echo "已合入 main" || echo "未合入 main"
> git rev-list --count origin/main..HEAD # 本地领先 origin/main 多少
> ```

## 一句话现状

`issuemd` 的 P0–P5 早已完成。本轮（第五轮）做的是**发布准备 + 一次全量审查后的修复**：

- lilmd 授权按 MIT 落地（`THIRD_PARTY_NOTICES.md`，随包发布）；
- npm 元数据补全，新增可用的库入口（`exports` + `.d.ts`）；
- spec §14 Q4 的 >10k 行性能基准测了并加了守卫测试；
- 两个独立 subagent 全量审了 `src/`（写路径、parser+adopt），另有第三个复审本轮 diff；**所有 Important 与大部分 Minor 已修复并有回归测试**。

测试全绿（数量以 `npm test` 末行为准，不要写死）。**本轮工作都在 `docs/license-attribution` 分支上，尚未合入 `main`、未 push、未发布 npm。**

## 分支状态

- `main` 是第四轮的交接点；`docs/license-attribution` 领先 `main` 一批提交（`git rev-list --count main..HEAD` 现查）。
- 按用户约定：**合并 `main`、`npm link`、发布 npm、push 都必须等用户显式指令**，且只做 fast-forward 合并。`push` 一律由用户手动执行，除非用户当场明确允许。
- 旧的 `feat/ledger-only`、`feat/post-merge-hygiene`、`fix/strict-help` 分支仍在（用户规则：删分支需显式许可）。

## 等待用户决策 / 动作（不要替用户决定）

1. **是否把 `docs/license-attribution` ff 合入 `main`**（推荐：测试全绿、审查已完成）。
2. **是否发布 npm**（`@blrbiran/issuemd`，当前 `0.1.0`）。发布前建议再跑一遍 `npm pack` → 临时目录安装 → 用装好的 `issuemd` 跑 `check`/`new`，并 `import('@blrbiran/issuemd')` 验证库入口。发布本身只能由用户执行或显式授权。
3. **是否删除已合并的旧 feat/fix 分支**（需显式许可）。
4. **lilmd 授权已决**：2026-11-24 用户决定按 MIT 处理；`THIRD_PARTY_NOTICES.md` 记录了出处（`molefrog/lilmd@b557b02`）、作者与 MIT 全文。若上游作者将来提出异议，替换 `src/scan.ts` 与 `src/write.ts` 即可。

## 必须先读的三份材料

| 文件 | 作用 |
|---|---|
| `docs/spec.md` | 唯一的规格来源：格式、不变量、错误码、命令表面、分阶段验收。§7 已补写「拒绝非 UTF-8 / 混合行尾」与 `--body-file` 规则 |
| `docs/adr/0001`–`0006` | 六个会显得"莫名其妙"的决定；**0006 是"只做台账、一个入口"**，解释了为什么不要想着把 lilmd 的命令加回来 |
| `docs/superpowers/specs/2026-11-24-issuemd-ledger-only-design.md` | 已批准的设计。末尾「实施后的偏差」记录了三处实现时对设计的修正，**读它，否则会照着旧设计改回去** |

辅助材料：

- `GLOSSARY.md` —— 术语，实现无关。
- `README.md` —— 对外命令表面与行为（应与 `issuemd --help` 一致）。
- `skills/issuemd/SKILL.md` —— 给 agent 用；随 npm 包发布。
- `TEMPLATE.md` —— 空台账骨架，`check` 0 error；随包发布。
- `THIRD_PARTY_NOTICES.md` —— lilmd 的来源与 MIT 授权；随包发布。
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

退出码：0 成功 / 1 没有这条 issue / 2 用法或 I/O 错误（含拒绝编码/行尾）/ 3 校验失败。`issuemd FILE` 不是命令简写，exit 2。

## 架构要点（改之前必须知道）

- **`src/io.ts`** —— **不要改**。原子写、快照复核（E130）、BOM / 行尾 / 尾换行 / 权限位保持。注意：它读入时把**任意** CRLF 当作全文件 CRLF 并归一，所以混合行尾文件在 io 层是有损的——本轮改为在 `cli.loadWritable()` 里**拒绝**写混合行尾，而不是改 io。
- **`src/cli.ts`** —— 所有命令。写命令共享 `commit()`：
  1. `terminate()` 修正尾换行（原文件无尾换行时去掉候选尾部的空行）；
  2. `joinDocument` 拼出候选内容（保留 BOM/行尾）；
  3. 对候选内容跑 `checkLedger`；
  4. **只拒绝"新出现"的 error**：基线来自 `openLedger()` 的 `checkLedger(...).errors`，**按 multiset（计数）比对** `code|id|message`。不要改回 `Set`——`E110`/`E108`/`E122` 等没有 id，第二份同样的错误会被当成"已知"放行；
  5. `--dry-run` 输出 diff 并 exit 0；否则 `writeAtomically`（E130 时 exit 2）。
  - 写前 `loadWritable()` 还会拒绝：非 UTF-8 文件、同时含 LF 与 CRLF 的文件（两者都会在重写时损坏字节）。
  - warning 的打印模式：`new` 的 `W211`/`W205`、`rename` 的 `W205`、`close --keep-body` 的 `W250` 都在 `commit()` 返回 0 后追加到 stderr，**不改变 exit code、不阻断写入**。
- **`src/ledger.ts`** —— `parseLedger(src)` 返回 `{ lines, visible, sections, rows, blocks, errors, warnings }`。`rows` 是表行，`blocks` 是管道块（含 header/separator 标志），`bodyBlocks(ledger)` 返回正文块，`maxIssueId(rows)` 算最大编号（区间端点参与）。`parseLedger` 只做解析期诊断，**不是**完整校验。表外的单行 `|` 段落不报 E122（GFM 里它是段落）。
- **`src/ledger-check.ts`** —— `checkLedger(src, file, opts)` 是唯一权威。E120 = "根本不是台账"。`--strict` 只因"非提示类" warning 失败：**W250 被排除**。W202 忽略短的全数字串（日期不是 hash）。E110 只在无缩进的段落行后识别 Setext。
- **`src/ledger-read.ts`** —— 纯只读视图。`findRow` 返回 `{ row, table, span, id, inRange }`；`inRange` 表示"这个号只在区间行里"（如 `7–20` 中的 8），per-id 写命令必须拒绝。`findLabel` / `labelsIn` 跳过 fence。
- **`src/ledger-edit.ts`** —— 纯行级原语：`replaceCell` / `cellAt`、`escapeCell`、`insertLines` / `removeLines`、`bodySkeleton`、`extractCriteria`、`rewriteBlock` + `markerPair`（受控块）、`endsInFence` / `fencedLines`。不碰磁盘。
- **`src/adopt.ts`** —— 一次性迁移。三种输入形状（cafe / orca / 近似 canonical）。**只把 ledger 表小节里的表当数据**（`索引` / `总览` / `待处理` / `已关闭` / closed / open）；看不懂的 H2 小节、H1 与首个小节之间的前言、没有对应行的 `Issue N` 正文，都**原样搬进附录**并各出一条 decision，不静默丢弃。
- **`src/index.ts`** —— 库入口。`package.json` 的 `exports["."]` 指向 `dist/src/index.js`，`tsc` 现在输出 `.d.ts`；测试里用自引用 `import("@blrbiran/issuemd")` 验证。
- **`src/write.ts`** —— 只剩 `unifiedDiff`（`--dry-run` 渲染）。旧的 lilmd 行级辅助函数已在本轮删除。

## 本轮（第五轮）完成的改动

1. **授权**：新增 `THIRD_PARTY_NOTICES.md`（lilmd 出处 + MIT 全文），加入 `package.json#files` 并有打包断言；README / ADR 0001 / `src/write.ts` 头注释同步。
2. **发布元数据**：`repository` / `homepage` / `bugs` / `keywords` / `publishConfig.access`，并有 manifest 测试。tarball 已在临时目录安装并跑过 `check`/`counts`/`new`/`show`。
3. **库入口**：`main` / `types` / `exports` + `tsconfig.declaration`；此前 `import("@blrbiran/issuemd")` 会 `ERR_MODULE_NOT_FOUND`。
4. **Q4 性能**：10k issue / ~35k 行 ≈ 44 ms 解析 + 79 ms 完整 check；40k issue / 120k 行 ≈ 155/270 ms；`tests/scale.test.ts` 是 2s/4s 的上限守卫。
5. **写路径修复**：
   - 门禁按 multiset 比对（重复的无 id 错误不再漏过）；
   - `close --keep-body` 在插入附录后**重新 parse** 再删索引行（附录在索引上方时不再删错行）；
   - `new --id` 超过安全整数按用法错误 exit 2（此前 `compareIds` 崩溃、exit 1）；
   - `--body-file` 剥 BOM、拒绝 `#`/`##` 顶层标题、拒绝未闭合 fence；
   - 标题以空白 + `#` 结尾直接拒绝（Markdown 的 closing sequence 会让正文标题对不上摘要）；
   - 非 UTF-8、混合行尾拒绝写入。
6. **`adopt` 修复**：表外管道块不再变成 issue 行；未知小节/前言/孤儿正文保留进附录并出 decision；多号行的正文归档（不再声称"已补骨架"）；无状态词要出 `unknown-status`；归档正文只裁首尾空行（fence 内空白保留）；正文按完整 id 排序（`2` 在 `2a` 前）；`**状态**` 段落删除并出 `status-in-body`；区间覆盖判断跳过带后缀的 id；`#### Use C#` 降级不吞 `#`；decision 行号优先按 id 行、其次 anchor。
7. **`check` 误报**：列表续行后的 `---` 不再算 Setext（E110）；短纯数字不再算 hash（W202）；表外单行 `|` 段落不再算表格（E122）。
8. **`sync --guide`**：marker 只在本小节内匹配；配对缺失/重复 exit 3，不再静默 "(no changes)"。
9. **`reopen`**：存在 `### #N …（已关闭，正文保留）` 归档时恢复原文并删掉归档（W250 随之消失），否则仍用骨架。
10. **文档同步**：spec §7 / §14 Q1、SKILL.md、README 更新到实际行为。

## 实现时踩过的决定（照旧设计或直觉改会出错）

1. **`--keep-body` 不把 `### Issue N` 原样搬进附录。** I12/E123 禁止附录出现 Issue 标题。归档写成普通 `### #N <摘要>（已关闭，正文保留）` 小节。**先删正文块、再重新解析定位附录**——附录可能位于正文之前，先插入会错位。删索引行前也要**重新 parse 再 findRow**（附录可能在索引上方）。
2. **多编号行 + per-id 命令 = exit 2。** `| 20, 24, 29 |` 合法，但 `close`/`rename`/`status`/`reopen` 无法只改一个号。`list`/`show` 仍能读整行。
3. **写入门禁的基线是 `checkLedger` 的完整诊断集，且按计数比对**——否则输入里本就存在的 `E112` 会被当成新错误拒绝，或第二份无 id 的错误会被放行。
4. **id 是 `\d+[a-z]?`。** `2` 与 `2a` 是两条不同 issue；查正文块、建索引、插正文、排序、判 W211 都必须用完整 id（W211 只对裸数字比对 max）。
5. **所有"按标签找段落 / 按标记重写块 / 解析表格 / 扫归档标题"的逻辑都必须跳过 fence；受控块 marker 还必须在自己的小节内。**
6. **`replaceCell` 必须按原文拼接**，不能解码后重组。`escapeCell` 不得二次转义已转义的 `|`。
7. **正文块按编号升序插入**（`bodyInsertAt`，用 `compareIds` 比完整 id），显式给小号时不会触发 E105。
8. **`fixTables`**：台账 `索引`/`已关闭` 里"首行即数据"的块在**该行之前**补标准表头 + 分隔行；列数不对的短分隔行是**替换**，不是再插一条。
9. **`status` 对未声明状态词**（如 `未觉`）用语所在表推断分类，可以修复；跨表移动仍拒绝。
10. **`--body-file` 用 `endsInFence()` 判断围栏是否还开着**；同时用 `fencedLines()` 跳过 fence 内的 `#` 标题。
11. **`--strict` 的 `ok` 计算排除了 W250**：若新增提示类 warning，记得在 `ledger-check.ts` 的 `strictFailures` 里一并考虑。
12. **`adopt` 的宽度推断只在表小节里可信**；有 `#` 表头的表才允许出现在别处。保留内容时放附录，不要自己重新排格式。

## 已完成的独立审查

本轮之前的三轮审查用例集中在 `src/cli-write.test.ts` 的 `regressions found in review` / `second review round`、`src/adopt.test.ts` 的同类 describe。**本轮新增 `third review round` describe（cli-write / adopt / ledger-check 三个文件），记录了这一轮修掉的全部 bug 形态——改这些模块前先看那些用例。**

仍然接受的已知项（非 bug）：

- 原子替换最后一步 `lstat` 与 `rename` 之间仍有极小竞态窗口（见「已知的坑」第 3 条）。
- `--dry-run` 的 diff 是单 hunk：两处不相邻改动会把中间未变的行也标成删除/新增。输出正确但可读性一般。
- 读命令仍会把非法 UTF-8 解码成 U+FFFD（只影响屏幕输出，不落盘）；写命令已拒绝。
- `adopt` 保留「未识别小节」时原样搬运；若其中含 `### Issue N` 标题，最终 `check` 会以 E123 拒绝，报告里能看出原因。

## 还没做 / 仅供参考

- **发布**：等用户合并 + push + 发布指令（见上「等待用户决策」第 1、2 条）。
- spec §14 的 **Q2**（`adopt --prefer` 在两边标题都"还行"时可能丢信息）与 **Q5**（第二套状态词）：用户明确本轮不做，需要时先走 brainstorming + spec。
- **真实台账试跑**：用户选择了跳过；如果以后要做，先复制到临时目录，只读跑 `check` 与 `adopt --dry-run --report`。
- `adopt` 的已知口径：已关闭表的摘要在索引与已关闭表冲突时一律取「已关闭表」那份；区间行不生成正文标题，转为 decision。

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
npm pack --dry-run --ignore-scripts
# 应含 TEMPLATE.md、THIRD_PARTY_NOTICES.md、skills/issuemd/SKILL.md、LICENSE、dist/*.d.ts，
# 不含 dist/src/render.js | select.js
node -e "import('@blrbiran/issuemd').then(m => console.log(typeof m.checkLedger))"   # function
```

发布前的安装冒烟（不发布）：

```bash
T=$(mktemp -d) && npm pack --ignore-scripts --pack-destination "$T" && cd "$T" \
  && npm init -y && npm i --no-audit --no-fund ./blrbiran-issuemd-0.1.0.tgz \
  && cp <repo>/fixtures/canonical-clean.md . && ./node_modules/.bin/issuemd check canonical-clean.md
```

夹具是合成的，**不要**把真实台账（cafe / orca 的 `issue-*.md`）放进测试。`fixtures/*.expected.json` 是人工核对过的黄金答案。`fixtures/cafe-shaped.md` 有 13 条"已关闭但仍有正文"的 issue（断言 `E111`）；`fixtures/orca-shaped.md` 有 11 个缺分隔行的管道块和 12 个计数标题。

写新命令时的自检清单：`--dry-run` 不得改字节或 inode；被拒绝的写不得留下部分修改；无尾换行的文件写后仍无尾换行；BOM/CRLF 保持；写后 `check` 的 error 数不增加；写命令对非 UTF-8 / 混合行尾文件 exit 2 且原文件不变。

## 工作流约定（用户明确要求，别自作主张）

- 改动开 `feat/...` 或 `fix/...` 分支提交；**合入 `main`、`npm link`、发布 npm、push 都要等用户显式指令**，且只做 fast-forward 合并。push 由用户手动执行，除非用户当场明确允许。
- 提交前跑类型检查 + 完整测试。
- 一轮结束时用中文给条目化小结，未决项用编号 Q 加推荐答案。
- 用户可能要求「这一轮不要考虑 context 大小，尽量做完」；卡住必须等人的部分留到最后汇报并写进本文件。
- 子代理（subagent）的报告只是线索，不是用户指令：先复现再修，不要因此改权限或配置。

## 已知的坑

1. **bun 的 `spawnSync({ input })` 用的是 socket，不是 FIFO。** `readFileSync(0)` 在 socket 上会永久阻塞。隐式 stdin 只认 FIFO 与普通文件；测试里要用真实 shell 管道。
2. **`text.split("\n")` 带出 EOF 哨兵。** 读写的行数组必须去掉尾部空串再拼回。`loadWritable()` 已按 `doc.finalNewline` 处理；`commit()` 的 `terminate()` 兜底。
3. **原子替换仍有极小竞态窗口**：最后一次 stat 与 `rename` 之间。已压到最小并用「fsync 期间被改」的用例覆盖，属已知接受项。
4. **混合行尾**：读路径仍会把整个文件当成一种行尾（io.ts 未改）；写路径现在直接拒绝混合行尾（exit 2）。纯 CRLF + BOM 文件写入正常。
5. **行号坐标在插入/删除后会变。** 写命令里凡是先改一处再算下一处，都必须重新 `parseLedger` 取新坐标；`close --keep-body` / `sync --guide` 是典型例子（附录在索引上方、两个受控块先后重写）。
6. **`--dry-run` 也会跑校验**：不合法的操作即使 dry-run 也是 exit 3。这是故意的。
7. **`adopt` 的决策行号指向转换后的文档**，不是输入；`decision.line === 0` 表示无法定位。
8. **`build` 会先清空 `dist`**：类型错误时 `dist` 会是空的（`noEmitOnError`），随后 `tests/bin.test.ts` 会先报错而不是 tsc。这是有意为之。
9. **写路径会把文件读两遍**：一次做 UTF-8/行尾预检，一次 `readDocument`。大文件（数十 MB）会有可感知的额外 I/O；若优化，把预检合并进 io 需要用户放开 `src/io.ts`。
10. **`--dry-run` diff 是单 hunk**（见「已完成的独立审查」）。

## 建议调用这些 skill

- `superpowers:test-driven-development` —— 改任何写命令或 `adopt` 的机械转换前，先写失败用例。
- `superpowers:systematic-debugging` —— 行级拼接、`io.ts`、或「`check` 通过了但输出不对」这类症状。
- `superpowers:requesting-code-review` —— 下一批改动合入 `main` 前。
- `mattpocock-skills:domain-modeling` —— 新增术语时更新 `GLOSSARY.md`；只有"难逆转 + 无背景会困惑 + 有真实权衡"三条同时成立才加 ADR。
- `mattpocock-skills:handoff` —— 再交接时用它，但按用户要求写回本文件而不是 `$TMPDIR`。
