# 实施计划：诊断噪声、判据边界与归档清理

日期：2026-11-28。Spec：`docs/superpowers/specs/2026-11-28-diagnostics-boundaries-and-archives-design.md`。
工作分支：`fix/round27-diagnostics-archives`。全部按 TDD：先写失败用例并确认失败原因，再实现。
独立 review 已确认：legacy 不 prune（边界不可证明）、hidden-envelope 夹具必须保留 H3 可见、#150 要用 max=557 + 外部 #558 验证分配、prune 守卫需同时保护 framing 文本。

## 阶段 0：基线

- `npm run typecheck && npm test` 确认 946 项全绿。
- dogfood（`fafccc02351d27de`，0/34：W268 7 + W271 27）与 cafe（`17cbcb54de4eaa8b`，0/31：W268 20 + W271 1 + W264 2 + W250 8）快照；Orca 台账本轮不在原路径，改用 fixtures 与合成台账。

## 阶段 1：W268 复核小节与列表延续（#148）

测试（`src/criteria-boundaries.test.ts` 扩展）：
1. 本台账三种复核标题 + 列表：`**本轮追加现场（…）**`、`**第三十三轮复测（`h`）**`、`**已记录的相邻项（…）**` → 无 W268、close rc=0。
2. cafe 三种：`**诚实边界**`、`**补充实测（…）**`、`**另一半：…**` → 无 W268。
3. 保留：`   **非目标**` + `3.`、`**注意**` + `3.`、`**必须离线通过。**` + `3.` → 有 W268、close rc=2。
4. 列表延续：判据 `1./2.` + 小节标题 + `- 列表` → 不报；+ `3.` → 报。
5. 回归：判据后接另一个 `**验收判据**` / `**补充判据**` 仍走 W206/W264。

实现：`criteriaBoundaryHints()` 增加 `isReviewSectionLabel()` 与「同类型/递增列表延续」判断；不改 `ambiguousProse` 分支。

## 阶段 2：只遮信封 fail closed（#145 第 4 形态）

测试（`src/content-integrity.test.ts` 或新 `src/hidden-envelope.test.ts`）：
1. 用 `close --keep-body` 生成真实 v3 归档，然后只遮信封、保留 H3 可见：
   - version 行被 fence 包住；
   - start/count 行被 fence 包住；
   - version+start+count 全被 HTML 注释盖住；
   - 同样三种用 raw HTML。
2. 每种形态：`check` 报 W269（行号指向被遮 marker、带 id）、`--strict` exit 3；`show --body-only` exit 1 且 stderr 含 hidden；`prune --dry-run` exit 2；`reopen` exit 3 且文件字节不变。
3. 回归：整块遮挡的既有 W269 用例不变；普通 markerless legacy（payload 里含字面 `<!-- issuemd:kept-body:end -->`）仍可 `show`/`reopen`；v2 positional separator 不受影响。

实现：`locateArchivePayload()` 在 heading+1..+3 的**原始行**上识别「version 或其后的 start」被遮 → recognized refusal；不扫描 legacy payload 内部。`hiddenArchiveNote()` 也把可见归档的 recognized refusal 报出来。

## 阶段 3：跨台账引用（#150）

测试（新增 `src/cross-ledger-refs.test.ts`）：
1. 夹具最大号 557，正文 `见 Orca 台账 #558`：`check` 无 W271；`new` 得 **558**；`new --id 558` 成功；`find '#558' --json` 仍分类为 `reference`。
2. `cafe 台账 #999`、`ledger #12` 同样豁免。
3. `本台账 #21` / `this ledger #21`：仍 W271；`new` 跳过 21；`--id 21` 被拒。
4. 裸 `见 #21` 行为不变。
5. `new` 候选台账复核（写入前重扫）不再因 external 引用拒绝。

实现：`ProseReference.external`；过滤 `missingProseReferences`、`cmdNew.proseReservations`、`cmdNew` 的候选复核。自指词（本/该/这/此/同一/当前/本文/本文件/this/the current）不豁免。

## 阶段 4：prune 任意位置与 W250（#114）

测试（`src/round25.test.ts` 扩展）：
1. 三块 v3（`close --keep-body` 生成）：分别先删中间、再重新 preview 删末块、再删首块，均 rc=0；每次 confirm 前重新 `--dry-run` 取新 snapshot；其余块的 framing 文本与 payload 逐字节不变。
2. 首块 legacy + 后两块 v3：legacy 被拒且文案说明「无已验证信封边界」；两块 v3 可删。
3. 删除不会吞掉后续归档标题、附录标记或相邻正文：用 framing snapshot 断言。
4. W250 文案含 `issuemd prune`；`--strict` 仍不因 W250 失败。

实现：`prunableArchive` 维持 legacy 拒绝并改文案；`cmdPrune` 用 `archivePayloadSnapshot(excludeId)` **和**新的 `archiveFramingSnapshot(excludeId)` 双重比较（framing snapshot 取 heading..framingEnd，忽略尾部空行）；保留 errorIdentity 与尾注拒绝；改 W250 文案。

## 阶段 5：close --criteria 读法提示（#111）

测试（`src/round22.test.ts` 扩展）：
1. open：`close --status 已修 --criteria 'a \| b'` stderr 含既有 W205 句子，并含实际存储读法 `"a | b"`。
2. closed：`close --criteria 'a \| b'` 同样提示；无 pipe 时 stderr 不含 W205（保留既有断言）。
3. n=2 `a \\| b` 原样往返；n=1/3 的 stderr 明确显示读成什么。
4. `criteria --criteria 'a \| b'` 正文逐字保留（不回退）；open/closed 的 stdout 与成功回执格式不变。

实现：`criteriaPipeNote(criteria, raw)`；两条路径传原始输入；help/SKILL 文档。

## 阶段 6：粗体强调句不切断块（#124 方向 A）

测试（`src/criteria-boundaries.test.ts`）：
1. `**现象**` / 第一段 / `**注意：这是同一节里的强调句。**` / 第二段 → labels 只有 现象/验收判据，现象含第二段。
2. `**验收判据**` 内出现 `**问题：未复现。**` 时它属于判据文本，不终止块。
3. `**验收判据：**`、`**关联**`、`**判据**：…` 仍是标签；fence 内粗体行仍不算标签。
4. 写入侧 no-op：`body --body-file` 写含该强调句的正文，再以相同内容写入 → `(no changes)`。

实现：`parseLabelLine()` 前置 `isProseEmphasis()`，但只对 `注意/提醒/重要提示/警告：` 开头且句末有标点的整行粗体做此豁免；复核标题 `**第二十六轮复核（…）：仍未修。**` 仍是标签边界。

## 阶段 7：输出与文档（#115/#118/#128）

- `check` 文本摘要分组：W202=format、W201+W250=artifacts；为 0 不显示。断言完整摘要仍含 errors/warnings、KiB/lines、body、archived；`check --json` 形状不变。
- W270 文案断言含 close/reopen 后果。
- 文档：spec §W268/W271/W250/W269/W270/#4.4 读视图口径；SKILL 对应条目、`criteria` vs `close --criteria`、W201 密度数字。

## 阶段 8：真实台账只读复测与收尾

- dogfood/cafe `check` / `--json` / `--strict`：记录剩余 warning 计数；`show --json .criteria` 前后逐字相同；SHA-256 前后相同。显式外部上下文的 W271 应消失，无法从同一行确认来源的裸 `#N` 仍报，避免误豁免本台账引用。
- `npm run typecheck && npm test && npm run build`。
- 分阶段 commit；fast-forward 合入本地 `main`，删除已合并分支，build；按用户本轮临时授权 push `origin main`。
- 更新 `docs/handoff/handoff.md`（不写死 HEAD），给出 executive summary。
