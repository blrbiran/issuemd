---
name: issuemd
description: |
  Read and edit a single-file issue ledger (issue 台账) with structural guarantees: one status table, one body block per open issue, criteria stored once. Use this skill whenever a task touches an issue ledger — 台账 / issue 文档 / 状态总览 / 待处理 / 关一条 issue / 新增 issue / 核对台账 / 改 issue 状态 / 修台账漂移 — or when you are about to hand-edit a `| # | 状态 | … |` table and a `### Issue N:` body in the same file. Also trigger when a ledger check fails or when titles/status/counts disagree. Use issuemd for ledgers; use lilmd or any text editor for ordinary Markdown — issuemd is deliberately not a general Markdown tool.
---

# issuemd — an issue ledger that cannot drift

`issuemd` keeps three places in agreement: the status table, the body blocks, and the criteria. It is a ledger tool only — it has no generic Markdown editing verbs, so every command below is about issues.

The rule that matters: **never hand-edit a ledger.** A ledger has structure; use the command that changes all affected places at once, then prove it with `check`. That includes body prose: `issuemd body` replaces an open issue's body through the same gate.

## Check the tool first

```bash
command -v issuemd && issuemd --help >/dev/null
```

If it is missing:

- `npm install -g @blrbiran/issuemd` (Node.js 20+).
- **Inside an issuemd checkout**: `npm ci && npm run build && npm link` (or run `node dist/bin/issuemd.js` directly).

If neither works, fall back to `lilmd` + a manual consistency pass, and say so once. Don't burn turns reinstalling.

Starting a brand-new ledger? Copy the packaged `TEMPLATE.md` (it already passes `check`) and add the first issue with `issuemd new`.

## The loop

### 1. Survey

```bash
issuemd list FILE               # open issues: id, status, priority, summary
issuemd list FILE --status 未决
issuemd list FILE --closed      # the closed table; text output includes 判据
issuemd find FILE '关键词' --json  # search both tables, issue bodies and readable archives
issuemd list FILE --json        # each entry has ids[] and count; top level rowCount/issueCount
issuemd list FILE --json --with-body   # + labels/criteria per issue, from the same parse (one snapshot)
issuemd list FILE --expand      # one entry per id (`20, 24` and `7–20` rows are expanded)
issuemd counts FILE             # per-status counts, computed (never stored)
issuemd read FILE 附录          # any top-level section, verbatim
```

`list` counts rows, `counts` counts ids: a `7–20` row is one row and 14 issues. Use `--json` (`count`, `issueCount`) or `--expand` when you need ids. `--with-body` adds each issue's labels and criteria from one snapshot; `labelBlocks` keeps original Markdown, `body.content` is ready for `body --body-file -`, and a unique kept-body archive is exposed as `body.archived` plus its payload. Use it instead of one `show` call per issue.

An unknown `--status` word is exit `2` (with the vocabulary listed); a closed status on the open table tells you to add `--closed`. An undeclared status that actually appears in the ledger is still filterable so you can inspect it, but stderr warns W220. `check` / `counts` text summaries include every open-table status, including undeclared words, so the buckets do not silently omit them. A priority that occurs only in the other table gets the parallel `add --closed` / `drop --closed` hint. If stderr says some table rows **could not be read**, the result is incomplete — run `check` and fix those rows first. If `check` itself would fail, `list`/`counts`/`show` still exit 0/1 but print a `note: 'issuemd check' reports N error(s) …` line. Their JSON always includes `diagnostics: {errors, warnings}` arrays, including empty arrays. `check --json` and `counts --json` expose `citedRows` when present, with the same shape as `list --json`.

**Feeding `list` back into per-id commands:** an `id` is the cell as written. A comma cell (`30, 31`) is not a single issue: use `ids[]` (or `--expand`) and pass one id, or you get exit `2` naming the ids. A pure range cell (`7–20`) is accepted by `show` and renders the whole row.

`issuemd FILE` is not a shortcut: it exits `2` with `unknown command`. Every command takes only its own options (`issuemd <command> --help`); a stray option is exit `2`, not silently ignored.

### 2. Read one issue

```bash
issuemd show FILE 65                 # read with table row, line range and heading
issuemd show FILE 65 --body-only     # extract editable body text
issuemd show FILE 65 --label 验收判据  # just that labelled block
issuemd show FILE 65 --json          # row + criteria + body.text (heading-inclusive) + body.content (body-only) + labelBlocks + criteriaBlocks
```

A labelled block starts with a standalone `**标签**` line or a line that separates the bold label from its text with `:` / `：`; it ends at the next recognized label or heading. A bold sentence such as `**必须**先完成 A` is content, not a label. A blank line followed by a list belongs to the current block. `--label` on a label with nothing under it is exit `1` with "exists but is empty". JSON `labels` and `paragraph` are flattened one-line summaries; `labelBlocks` and `paragraphLines` preserve the original Markdown lines, including fences and blank lines. `criteriaBlocks` is an occurrence-based array with 1-based absolute `line`, `label`, `kind`, and raw `lines`; it preserves repeated/empty canonical blocks and non-empty later supplements. `criteria` remains a flat compatibility string with `criteriaSource` (`table` for closed issues, `body` for open ones).

Use `--body-only` when you need text ready for `--body-file`. For an open issue it emits the body without the heading or separator blank lines. For a closed issue with one recognized kept-body archive, it emits the archive payload; legacy provenance notes and edge whitespace are preserved. A missing or borrowed body gives exit `1` with empty stdout. This mode cannot be combined with `--json` or `--label`.

A multi-id row may keep one body under any of its ids (a comma row under any listed id, a range row under any id it covers). `show` still finds it for the other ids, but says so: `body.id` is the issue the text belongs to, `body.inherited: true` marks a borrowed body, `criteriaFrom` names the owner, and text mode prints `note: the body shown belongs to #N`. `check` still reports E102 for an id with no body of its own.

### 3. Change state — only with a ledger verb

```bash
issuemd new    FILE --title "…" --priority P2              # id defaults to max+1; status 未决
issuemd new    FILE --title "…" --body-file body.md        # body.md: text *under* the heading
issuemd close  FILE 57                                     # promotes the body's 验收判据
issuemd close  FILE 57 --status 延后 --criteria "owner: 转设计"
issuemd close  FILE 57 --no-criteria                       # deliberately delete the body and leave criteria empty
issuemd close  FILE 57 --keep-body                         # retain evidence in 附录
issuemd limits FILE --body-bytes 40960 --body-lines 600     # project-specific W201 thresholds
issuemd limits FILE --clear                                # restore defaults
issuemd status FILE 56 部分解决                            # open→open or closed→closed only
issuemd reopen FILE 57 --status 观察                       # default 未决
issuemd rename FILE 16 "new summary"                       # table + body title + archive heading
issuemd body   FILE 16 --body-file new-body.md             # replace an open issue's body text
issuemd body   FILE 16 --append --body-file retest.md      # append a paragraph atomically
issuemd priority FILE 16 P1                                # P0–P3 or ""
issuemd split  FILE 24                                     # `20, 24, 29` → three rows (no bodies invented)
issuemd prune  FILE 57 --dry-run                          # preview deleting one kept-body archive
issuemd prune  FILE 57 --confirm --if-unchanged SNAPSHOT  # then delete exactly that archive
```

Every one of these is atomic and supports `--dry-run` (a unified diff, one hunk per changed region). Use `--dry-run` first whenever the file is not a scratch copy.

- **`close` never drops criteria silently.** With no flag it promotes the body's `**验收判据**`; if there is none it refuses (exit `2`) — pass `--criteria TEXT`, `--keep-body`, or `--no-criteria` to choose deliberately. On an already closed id, `close FILE ID --criteria TEXT` updates only the table cell; status, summary, and body stay untouched, and stderr reports the old and new values. `--criteria-from-body` refuses when the block is missing or empty. A fence *under* the label is part of the criteria (its content is promoted); a `**验收判据**` line *inside* a fence is just text and never starts a block of its own. Lists in one block are joined with `；` in the cell. Multiple non-empty canonical blocks (W206), later non-empty criteria aliases (W264), or a sentence-shaped bold boundary in a criteria list (W268) block automatic close if it would delete the body; review every source line and pass complete `--criteria TEXT`, choose `--no-criteria` intentionally, or use `--keep-body`. The old closed table cell is a flat string and cannot recover literal `；` boundaries; use `criteriaBlocks` or keep the body for source structure. An empty `--criteria ""` is refused (an unset variable, usually); say `--no-criteria` if you mean it. `--criteria` follows the title convention: `\|` spells a literal pipe. A criteria lifted from the body that a table cell cannot store — a backslash directly before `|`, as in a shell `echo a \| b` inside a fence — is refused (exit `2`) instead of being silently rewritten; close with `--keep-body --no-criteria` to keep the body verbatim in 附录. Close also refuses if it would make any pre-existing error disappear, except the selected issue's own E102; repair E106 or other errors before closing.
- **`status` refuses to cross the open/closed boundary** — that is a `close`/`reopen`, because crossing changes three places, not one. It also repairs a typo'd status word (`W220`) inside the same table.
- **`reopen`** puts the issue back as `未决` (or `--status 观察` / `部分解决`); the old open status is not recorded. With no kept-body archive, only `已修` restores the closed-table cell as `**验收判据**`; other closed statuses restore it as `**关闭理由**`. If the cell is empty, reopen succeeds but stderr says to add acceptance criteria; W261 remains, so `--strict` fails until you add them. If the body was kept with `--keep-body`, its archived `**验收判据**` stays current; a different closed-table value is preserved as `**关闭时判据**`. For a closed issue, duplicate `## 附录` sections make `reopen` refuse with exit `2` (W266). Duplicate archives within one section still give exit `3`. `close --keep-body` can create a missing appendix and refuses duplicate sections. `reopen` reclaims an empty, tool-created appendix carrying `<!-- issuemd:appendix:auto -->`, while preserving pre-existing appendices and any user content. Reopen of an already-open issue is a no-op unless explicit `--status` names a different open status.
- **`prune` removes one archived body, not the issue.** Preview with `--dry-run`, then repeat with `--confirm --if-unchanged SNAPSHOT`. The closed row and its criteria stay; only a unique valid `close --keep-body` v2/v3 archive is removed. Duplicate/legacy/malformed archives, duplicate appendices, and ids also owned by open ranges or unreadable rows are refused. The operation also refuses if it would change the existing error set or another archive's payload. It never removes the `## 附录` heading or neighboring prose. The snapshot guards the file revision; it does not bind the id, so confirm the same id you previewed.
- **`--body-file`** (for `new` and `body`) is the text that goes *under* `### Issue N: <title>` — never include the heading yourself (a file that starts with `### Issue N:` is refused, exit `2`). Minimal file: `printf '**现象**：…\n\n**验收判据**：…\n' > body.md`. To edit a paragraph, use `show FILE ID --body-only`, edit the text, then pass it to `issuemd body FILE ID --body-file -`. To add a retest note, pass just the new paragraph to `body --append --body-file PATH|-`.
- **A title starting with `-`** must be attached with `=`: `--title="--body-file 的语义"`; otherwise you get `Option '--title' argument is ambiguous`.
- **Priorities are `P0`–`P3` or empty.** `new` refuses anything else; `check` warns `W221` about existing ones.
- **`split` never invents a body.** Use `issuemd body FILE ID --body-file -` to add missing bodies. For more than three missing bodies, stderr shows the count, first and last id, and how many ids were omitted. Get the complete E102 list from `issuemd check FILE --json`. If splitting creates W212 duplicate-summary warnings, split succeeds but stderr names the affected IDs and recommends renaming one after splitting.
- **A no-op write says so.** If the verb would leave the bytes identical, stdout is one line `(no changes)` and the exit code is 0 — the same words `--dry-run` uses. A real change keeps stdout empty (`new` prints only the id). On success, stderr includes `wrote FILE <operation> (snapshot S)`. Use the new snapshot for the next `--if-unchanged` write. An `adopt` that changes nothing prints `(no changes)` and then its report; a real conversion prints the report starting with `adopt: FILE`.
- **`new` checks its own incoming references.** If the proposed body reserves the ID `new` would assign, both preview and write return exit `2` with the cited row and its IDs. A table can still refer to a different issue.
- **`rename` reports changed title copies on stderr.** Both preview and a successful write show the old and new values for each affected summary or title.
- **`new` prints the id it filed** — one line on stdout (`ID=$(issuemd new FILE --title "…")`). Use that; don't re-`list` to guess the newest row while others may be writing.
- `new` refuses (exit `2`) a summary that an **open** issue already has (compared after NFKC/case/space folding) and names that issue — after a timed-out retry, that usually means your first call landed. `rename` and `reopen` refuse the same way when another open issue already has that summary. Add `--allow-duplicate-title` only when it really is a second issue; `check` then keeps reporting the pair as `W212`.

### 4. Prove it

```bash
issuemd check FILE                # exit 0 ok / 2 usage or I/O / 3 found errors (never 1)
issuemd check FILE --json         # machine-readable
issuemd check FILE --strict       # warnings fail too (except W250)
```

Exit code **3** means structural errors. Fix them before reporting anything as done.

`check` warnings worth knowing:

- `W201` — a live body or retained archive payload exceeds 300 lines or 20 KiB (20,480 UTF-8 bytes) by default. It fails `--strict`. Write previews and applied `body` changes report a first crossing, and `close --keep-body` reports an oversized archive. Keep conclusions and acceptance criteria in the body and move long evidence to a linked file when appropriate. `limits` changes the thresholds in that ledger only. `check --json` shows the effective `limits` and the `size` breakdown.
- `W266` — duplicate `## 附录` headings. Resolve the headings before archive writes. Read-only per-ID access still works when the archive is unique.
- `W267` — invalid or duplicate `issuemd:limits` metadata. Defaults apply. Use `limits` to rewrite or clear the preamble marker.
- `W202` — a short hash pinned in visible body/appendix text, including raw HTML text or attributes (it rots). Each occurrence is reported with line, column, and an open-body id when available. Commits in the closed table's 判据 column are expected and are not W202; `--verify-commits` checks them and reports W240 for a commit the repo does not have. Hashes in inline code (including multiline code spans) and fences are literal evidence and do not trigger W202. `sync FILE --fix-hashes --dry-run` previews safe backtick wrapping in open bodies and ordinary appendix text; table cells, Markdown link destinations/titles, bare URLs/autolinks, email autolinks, raw HTML blocks and attributes, headings, and kept-body archives are skipped with reasons. Wrapping can increase size, so review W201/size afterward. The stderr summary includes `wrapped`, `skipped`, and `remaining` occurrence counts. Add `--require-complete` to refuse the entire write if any W202 would remain.
- `W212` duplicate summary · `W220` undeclared status · `W221` undeclared priority · `W225` issue-shaped table outside the ledger tables (kept as text) · `W261` an open issue whose body has no non-empty `**验收判据**` (a bare `new` skeleton, or criteria deleted — it cannot be closed until one is written). A block holding only HTML comments (outside a fence) does not count; text beside a comment, and fenced content, do. If the body has a similarly named label such as `**验收判据（复测用）**`, W261 and `close` point to its line. Use `**验收判据**` for criteria that `close` should promote.
- `W262` — an HTML comment remains open at the next ledger section, managed issue heading, archive boundary, or EOF. Same-line code spans, fences, and pipe-table rows treat comment delimiters as literal text. Finish a multiline comment with a line starting with `-->` in the same section or issue. Issue-shaped tables in an unclosed comment remain reserved and visible in `citedRows`.
- `W263` — `--verify-commits` was skipped because the ledger is outside a Git worktree. Normal `check` may succeed with this warning; `--strict` fails. In a Git worktree, a missing commit remains W240.
- `W264` — a body has canonical criteria followed by a non-empty candidate such as `补充判据` or `验收标准`. Each warning carries its source line and fails `--strict`. Earlier descriptive labels, empty/comment-only blocks, and prose that merely mentions `判据` do not trigger it. Close refuses automatic promotion when it would delete the body. Use `--keep-body` to preserve the source or pass reviewed `--criteria` text.
- `W268` — a bold boundary may separate two criteria list items, or prose before a later list or fence could belong to a separate section. The read view preserves the existing criterion text in the second case. Use an explicit `**复核记录**：` label for review notes or provide reviewed `--criteria`. Choose `--keep-body` to retain the full source.
- `W269` — malformed or hidden v2/v3 archive framing. `check --strict` fails. When the only matching archive is masked by a fence, comment, or raw HTML, `show --body-only`, `reopen`, `prune`, and `close --keep-body` point to its heading for manual review. Close/adopt validate their candidate archives before writing.
- `W270` — an unclosed code fence in an issue body or visible appendix. Close it at the reported opener before modifying the affected section.
- `W271` — visible prose references a missing issue ID. `new` reserves that ID, skips it during allocation, and refuses explicit reuse. Code examples and link destinations do not reserve IDs.
- `W265` — the allocation high-water marker is malformed/duplicated or exceeds the highest visible table ID, which may mean a historical row was removed. `new` always allocates above the persisted mark.

- `W250` — an appendix archive left by `close --keep-body` (or `adopt`). Current writers use `kept-body:v3` with `kept-body:lines:N`; the line count defines payload records, including empty lines and literal marker text, followed by one empty frame record and the end marker. `W201` excludes metadata and frame lines. Readers keep v2 and markerless legacy semantics; W269 identifies malformed envelopes. Leave archive boundaries alone. The archive is a frozen snapshot, not a second copy of the criteria. `W251`/`W252` mean someone hand-edited it out of step. `W253` means a second copy of the same body sits in 附录 (an escaped `\### Issue N:` left by an older `adopt`, or a repeated archive): keep one, delete the other by hand, then `check`.

### 5. Fix drift mechanically

Preview moving a unique evidence label out of an open issue with `issuemd body FILE ID --move-evidence LABEL --dry-run`. Apply the reviewed diff with `--if-unchanged SNAPSHOT`. The source stays in the same ledger under `## 附录`; the active body retains a link. This can clear W201 by shortening the active body.

```bash
issuemd sync FILE --titles --prefer=body --move-progress --dry-run
issuemd sync FILE --fix-tables --dry-run
issuemd sync FILE --criteria-labels --dry-run
issuemd sync FILE --fix-hashes --dry-run
issuemd sync FILE --guide --dry-run
```

`sync` never deletes a body, never moves a row, never changes a status. `--criteria-labels` renames one non-empty recognized alias (`判据`, `验收判据…`, `追加判据…`, `修复判据…`, or a label ending with `的判据`) only when no canonical criteria label exists; it leaves historical labels such as `关闭时判据` unchanged and skips ambiguous cases. Each change is reported with its source line, including in dry-run. Rows it cannot fix (several ids in one row) are listed on stderr.

The closed table column is named `判据`, but open bodies must use the exact label `**验收判据**` for criteria that close should promote. After `new` or `body`, issuemd reports a nearby criteria alias and its line. When exactly one alias can be renamed safely it suggests `issuemd sync FILE --criteria-labels`; if an exact label already exists, the alias is empty, or several aliases compete, inspect and resolve the body manually.

When `--titles` finds different table and body titles, choose which side to keep. `--prefer table` keeps the table summary and updates the body title. To choose the body title, specify `--prefer body` plus `--move-progress` (preserve the old summary in the body) or `--drop-progress` (discard it). A bare `--titles` or `--prefer body` refuses to write. Each title change is named on stderr in both dry-run and real runs. W260 protections still apply: `--prefer table` refuses progress wording.

A write verb that cannot find the id exits `1` with the message on stderr, so a `--dry-run` diff on stdout is never mixed with it.

## Several agents, one ledger

Writes are optimistic: each command re-checks the file just before replacing it. If someone else wrote in between, it refuses with **exit `4`** (`E130 … changed after it was read`) and changes nothing. Then: re-read (`show` / `list`), decide again, retry the command. A read that races another writer's replace also exits `4` (`E130 … changed while it was being read`). Exit `4` is the only retryable code — `2` is your usage error, `3` is the ledger.

A successful write (exit `0`) is never lost to a parallel writer: the final check-and-replace runs under a lock file `.FILE.issuemd-lock` beside the ledger (held for milliseconds). If an exit-`4` message names that lock and no issuemd process is running, delete the file.

- `--dry-run` previews the file *as it is now*; it is not a lock. It prints `snapshot: S` on stderr. To apply exactly what you reviewed, run the real command with `--if-unchanged S`: if anyone wrote in between, it exits `4` and changes nothing — re-run the dry-run and review again. Every `--json` read view (`show`, `list`, `counts`, `check`) carries the same `snapshot` field, so "read, decide, write" works the same way: `show --json` → decide → `close … --if-unchanged S`.
- Don't have two agents edit the same issue at once; if a `close` says "already closed", someone else closed it — re-read before acting.
- Use one path for a shared ledger. A symlink is fine (writes go through to the target); a hard link is not (the other name keeps the old content after a write — you get a warning).

## Format rules that will bite you

- **A ledger needs `## 索引`, `## 已关闭` and `## 正文`** (plus `## 怎么用` / `## 状态口径`). Missing any of the three core sections is `E120` — "not a ledger"; start from `TEMPLATE.md`.
- **Issue rows live only in `## 索引` and `## 已关闭`.** An issue table under an old ledger-table heading (`## 待处理`, `## 总览`) is not read: `check` reports `E124` per row, its ids are reserved, and `show` exits `3`. Run `issuemd adopt FILE` to move the rows in. Under any other heading (`## 复核记录`), a table whose header names an id column plus `摘要`/`标题` — or only an id column and one other (`| # | 说明 |`) — is treated as text: `check` warns `W225` once per table, adopt leaves it alone and says so (`cited-table`), and its ids are reserved (default numbering steps over them when it gets there; `new --id N` on one exits `2`; `list --json` lists them under `citedRows`). Move real issues into the tables by hand, or rename the `#` column if they are not issues. A row above the separator counts as a data row, not a header, only when it is plainly an issue row: an id, then a status word (`| 7 | 未决 | 甲 |`), or nothing below the separator.
- **Foreign tables with an ID and `状态` column can reserve IDs without W225.** In a table with a matching separator and no title column, a row with a ledger status such as `未决` or `已修` reserves its ID. Roadmap-specific values such as `进行中` leave the ID available. See `list --json` → `citedRows`.
- `## 正文` and `## 附录` remain free-form and their tables are not parsed as issues. Visible issue-shaped rows there reserve IDs and appear in `citedRows`; this prevents `close --keep-body` from making an ID reusable. Tables inside properly closed HTML comments and the controlled `怎么用` / `状态口径` sections do not reserve IDs. If a comment is unclosed, W262 warns and following free-form tables still reserve their IDs.
- **Every table needs a `|---|` separator row.** A block of `|`-lines without it is not a table — it renders as one paragraph of literal pipes (`E122`).
- **Count issues by id, not by row.** One cell may hold several ids (`| 20, 24, 29 |` is three) or a retired range (`| 1–199 |`).
- **No headings inside an issue body.** Use `**bold labels**`; `####` inside a body is `E110`. Read one labelled block with `show --label`.
- **A closed issue must have no body block.** Closing deletes it and promotes `**验收判据**` into the table; a leftover block is `E111`.
- **Never put counts in headings** (`## 待处理（16）`). Every count change then invalidates every reference, and stale ones fail silently (`E121`).
- **Status lives only in the table.** A `**状态**` line in a body is an error (`E107`).
- **The summary and the body title are the same string.** Don't shorten one; `rename` changes both.
- **Escape pipes inside cells** as `\|` — including inside backticks. Too many cells is `E108`, whose message says so.
- **A title may not end with ` #` or a count like `（2）`** — Markdown strips a trailing hash from the body heading, and counts in headings are `E121` (a four-digit year such as `（2025）` is not a count). `new` / `rename` refuse both up front; `reopen` of an old closed row with such a summary tells you to `rename` it first. `new` / `rename` also refuse raw HTML comment delimiters in titles (`&lt;!--` / `-->`); use a spaced or entity spelling when referring to them.
- **Writes respect a read-only file** (`chmod 444`): exit `2`, nothing written; `--dry-run` still previews.
- **Writes refuse files they would corrupt.** A ledger that is not valid UTF-8, or that mixes LF and CRLF, gets exit `2` with an explanation instead of a silently re-encoded rewrite.
- **Ids are `\d+[a-z]?`** (`393b` is real) and are never recycled. `new` stores the highest allocated number in a preamble marker; deleting the highest closed row does not make that number available again. On an old ledger without a marker, the first `new` can only start from the highest row still present. Explicit `new FILE --id N` at or below the current visible/high-water maximum prints `W211`.
- **`--body-file` may not contain `#` / `##` headings** (they would end the issue block while `check` still passed) and may not end inside an open fence; `###` or Setext headings are refused by the write gate (`E110`). A leading BOM and leading blank lines are stripped, so writing back `body.text` minus its heading changes nothing. A v3 archive's line count preserves literal `kept-body:*` lines in the payload; they are not treated as internal boundaries.
- **`read` matches a top-level `##` heading exactly** — no regex, no substring, no chain. A duplicate or missing title exits `2` and lists the candidates; duplicate `## 附录` specifically reports W266.
- **A row that holds several ids, or a range, is read-only for per-id verbs.** `close`, `reopen`, `status`, `rename`, `body` and `priority` all refuse it with exit `2` and the same message:

  ```text
  issuemd reopen: #20 shares a row with other ids (20, 24, 29); split the row first: issuemd split FILE 20
  ```

  `issuemd split FILE 20` gives every id its own row (fields copied). Missing bodies keep their E102 diagnostics. See stderr for the summary and use `issuemd body` to add them. Ranges over 1000 ids are refused.

## Writing issues an owner can act on

Each open issue must stand alone: environment (`file:line`, command, raw output), reproduction steps, expected behaviour, acceptance criteria. Never pin a commit hash in prose — give the lookup command instead (`git log --oneline -3`). The closed table's 判据 column is the one place a commit belongs.

Don't write status into the body. The table is the only place status exists, which is why the table and the body can never contradict each other on that axis.

## Adopting an old ledger

```bash
issuemd adopt OLD.md --dry-run --report decisions.md   # review first; the ledger is not touched
issuemd adopt OLD.md --report decisions.md             # then convert
```

It does the mechanical part (add missing sections, merge a duplicated closed table, drop closed rows from the index, strip `（N）` from headings, add missing table separators, demote body `####` to bold labels, archive closed issues' bodies in the appendix) and **keeps everything else verbatim**: the H1's own prose stays in place, text around the controlled blocks stays, and notes, narrative sections and unmapped tables move to `## 附录`. It refuses to write if any input line would disappear, or if the result would still fail `check` (errors then name **source** lines). A ledger that already passes `check` is left untouched.

The report has three parts: mechanical changes, content kept verbatim, and the semantic defaults it applied (title conflicts, closed statuses inferred from group headings or `决定不改：…` cells, unknown statuses as `未分类`, multi-id rows). Read the last part and fix what you disagree with. `--report` never overwrites the ledger or an unrelated file.

## Quick reference

```bash
issuemd list FILE --status 未决           # what's open
issuemd show FILE 65                      # one issue, row + body
issuemd check FILE --json                 # verify (exit 3 = errors)
issuemd new    FILE --title "…"           # add
issuemd close  FILE 57                    # criteria come from the body
issuemd rename FILE 16 "…"                # fix drift
issuemd sync   FILE --titles --dry-run    # preview mechanical fixes
issuemd adopt  OLD.md --dry-run           # one-time conversion
issuemd <command> --help                  # that command's options
```

Exit codes: `0` ok · `1` no such issue / empty result · `2` usage or I/O error · `3` ledger validation failed · `4` file changed concurrently (retry). Read-only commands are safe anywhere. Write commands modify the file in place; `--dry-run` prints a diff instead.
