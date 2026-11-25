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
issuemd list FILE --json        # each entry has ids[] and count; top level rowCount/issueCount
issuemd list FILE --json --with-body   # + labels/criteria per issue, from the same parse (one snapshot)
issuemd list FILE --expand      # one entry per id (`20, 24` and `7–20` rows are expanded)
issuemd counts FILE             # per-status counts, computed (never stored)
issuemd read FILE 附录          # any top-level section, verbatim
```

`list` counts rows, `counts` counts ids: a `7–20` row is one row and 14 issues. Use `--json` (`count`, `issueCount`) or `--expand` when you need ids. `--with-body` adds each issue's `labels` and open-issue `criteria` to the same call — use it instead of one `show` per issue, which both costs N processes and mixes snapshots.

An unknown `--status` word is exit `2` (with the vocabulary listed); a closed status on the open table tells you to add `--closed`. If stderr says some table rows **could not be read**, the result is incomplete — run `check` and fix those rows first. If `check` itself would fail, `list`/`counts`/`show` still exit 0 but print a `note: 'issuemd check' reports N error(s) …` line, and their `--json` carries `diagnostics.errors`; a view of a broken ledger must not look healthy.

**Feeding `list` back into per-id commands:** an `id` is the cell as written. A comma cell (`30, 31`) is not a single issue: use `ids[]` (or `--expand`) and pass one id, or you get exit `2` naming the ids. A pure range cell (`7–20`) is accepted by `show` and renders the whole row.

`issuemd FILE` is not a shortcut: it exits `2` with `unknown command`. Every command takes only its own options (`issuemd <command> --help`); a stray option is exit `2`, not silently ignored.

### 2. Read one issue

```bash
issuemd show FILE 65                 # the body block, plus its table row
issuemd show FILE 65 --label 验收判据  # just that labelled block
issuemd show FILE 65 --json          # {id,table,status,priority,summary,criteria,criteriaSource,line,end,body{line,end,text},labels}
```

A labelled block runs from `**标签**` to the next label or heading — a blank line followed by a list belongs to it. `--label` on a label with nothing under it is exit `1` with "exists but is empty". `--json` gives every label as one line in `labels`, and `criteria` with `criteriaSource` (`table` for closed issues, `body` for open ones).

A multi-id row may keep one body under any of its ids (a comma row under any listed id, a range row under any id it covers). `show` still finds it for the other ids, but says so: `body.id` is the issue the text belongs to, `body.inherited: true` marks a borrowed body, `criteriaFrom` names the owner, and text mode prints `note: the body shown belongs to #N`. `check` still reports E102 for an id with no body of its own.

### 3. Change state — only with a ledger verb

```bash
issuemd new    FILE --title "…" --priority P2              # id defaults to max+1; status 未决
issuemd new    FILE --title "…" --body-file body.md        # body.md: text *under* the heading
issuemd close  FILE 57                                     # promotes the body's 验收判据
issuemd close  FILE 57 --status 延后 --criteria "owner: 转设计"
issuemd close  FILE 57 --keep-body                         # archive the body under 附录
issuemd status FILE 56 部分解决                            # open→open or closed→closed only
issuemd reopen FILE 57 --status 观察                       # default 未决
issuemd rename FILE 16 "new summary"                       # table + body title + archive heading
issuemd body   FILE 16 --body-file new-body.md             # replace an open issue's body text
issuemd priority FILE 16 P1                                # P0–P3 or ""
issuemd split  FILE 24                                     # `20, 24, 29` → three rows (no bodies invented)
```

Every one of these is atomic and supports `--dry-run` (a unified diff, one hunk per changed region). Use `--dry-run` first whenever the file is not a scratch copy.

- **`close` never drops criteria silently.** With no flag it promotes the body's `**验收判据**`; if there is none it refuses (exit `2`) — pass `--criteria TEXT`, `--keep-body`, or `--no-criteria` to close without criteria on purpose. `--criteria-from-body` refuses when the block is missing or empty. A fence *under* the label is part of the criteria (its content is promoted); a `**验收判据**` line *inside* a fence is just text and never starts a block of its own. Lists — and repeated `**验收判据**` blocks — are joined with `；` in the cell. An empty `--criteria ""` is refused (an unset variable, usually); say `--no-criteria` if you mean it. `--criteria` follows the title convention: `\|` spells a literal pipe. A criteria lifted from the body that a table cell cannot store — a backslash directly before `|`, as in a shell `echo a \| b` inside a fence — is refused (exit `2`) instead of being silently rewritten; close with `--keep-body --no-criteria` to keep the body verbatim in 附录.
- **`status` refuses to cross the open/closed boundary** — that is a `close`/`reopen`, because crossing changes three places, not one. It also repairs a typo'd status word (`W220`) inside the same table.
- **`reopen`** puts the issue back as `未决` (or `--status 观察` / `部分解决`); the status it had before closing is not recorded anywhere. If the body was kept with `--keep-body`, it is restored verbatim and the archive removed; otherwise you get the label skeleton with the criteria filled in. Reopening an issue that is already open is a no-op (`(no changes)`, exit `0`) unless an explicit `--status` names a different open status, which is applied.
- **`--body-file`** (for `new` and `body`) is the text that goes *under* `### Issue N: <title>` — never include the heading yourself (a file that starts with `### Issue N:` is refused, exit `2`). Minimal file: `printf '**现象**：…\n\n**验收判据**：…\n' > body.md`. To change one paragraph: take `show FILE ID --json` → `body.text`, drop the heading line, edit, pipe it back with `issuemd body FILE ID --body-file -`.
- **A title starting with `-`** must be attached with `=`: `--title="--body-file 的语义"`; otherwise you get `Option '--title' argument is ambiguous`.
- **Priorities are `P0`–`P3` or empty.** `new` refuses anything else; `check` warns `W221` about existing ones.
- **`split` never invents a body.** An id that had no body keeps none after the split: `check` still reports E102 and stderr names the ids, so write one with `issuemd body FILE ID --body-file -`. (An empty skeleton would turn a real error into a warning.)
- **A no-op write says so.** If the verb would leave the bytes identical, stdout is one line `(no changes)` and the exit code is 0 — the same words `--dry-run` uses. A real change keeps stdout empty (`new` prints only the id). An `adopt` that changes nothing prints `(no changes)` and then its report; a real conversion prints the report starting with `adopt: FILE`.
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

- `W202` — a short hash pinned in prose (it rots). Commits in the closed table's 判据 column are expected and are not W202; `--verify-commits` checks them and reports `W240` for a commit the repo does not have.
- `W212` duplicate summary · `W220` undeclared status · `W221` undeclared priority · `W225` issue-shaped table outside the ledger tables (kept as text) · `W261` an open issue whose body has no non-empty `**验收判据**` (a bare `new` skeleton, or criteria deleted — it cannot be closed until one is written). A block holding only HTML comments (outside a fence) does not count; text beside a comment, and fenced content, do.
- `W250` — an appendix archive left by `close --keep-body` (or `adopt`): a `### #N <summary>（已关闭，正文保留）` heading ending at `<!-- issuemd:kept-body:end -->`. Intentional, informational, never fails `--strict`. Leave the marker alone: `reopen` restores exactly the text above it. The archive is a frozen snapshot, not a second copy of the criteria. `W251`/`W252` mean someone hand-edited it out of step. `W253` means a second copy of the same body sits in 附录 (an escaped `\### Issue N:` left by an older `adopt`, or a repeated archive): keep one, delete the other by hand, then `check`.

### 5. Fix drift mechanically

```bash
issuemd sync FILE --titles --prefer=body --dry-run
issuemd sync FILE --fix-tables --dry-run
issuemd sync FILE --guide --dry-run
```

`sync` never deletes a body, never moves a row, never changes a status. That boundary is what makes it safe to run unattended with `--dry-run`. Rows it cannot fix (several ids in one row) are listed on stderr.

If `--titles` reports W260 (a table summary carries progress text the body title lacks), it **refuses to run** until you pick `--move-progress` (append that text to the body, losing nothing) or `--drop-progress` (overwrite, knowingly). `--prefer table` refuses too (it would copy the progress text into the body title). `--prefer` only goes with `--titles`.

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
- **Every table needs a `|---|` separator row.** A block of `|`-lines without it is not a table — it renders as one paragraph of literal pipes (`E122`).
- **Count issues by id, not by row.** One cell may hold several ids (`| 20, 24, 29 |` is three) or a retired range (`| 1–199 |`).
- **No headings inside an issue body.** Use `**bold labels**`; `####` inside a body is `E110`. Read one labelled block with `show --label`.
- **A closed issue must have no body block.** Closing deletes it and promotes `**验收判据**` into the table; a leftover block is `E111`.
- **Never put counts in headings** (`## 待处理（16）`). Every count change then invalidates every reference, and stale ones fail silently (`E121`).
- **Status lives only in the table.** A `**状态**` line in a body is an error (`E107`).
- **The summary and the body title are the same string.** Don't shorten one; `rename` changes both.
- **Escape pipes inside cells** as `\|` — including inside backticks. Too many cells is `E108`, whose message says so.
- **A title may not end with ` #` or a count like `（2）`** — Markdown strips a trailing hash from the body heading, and counts in headings are `E121` (a four-digit year such as `（2025）` is not a count). `new` / `rename` refuse both up front; `reopen` of an old closed row with such a summary tells you to `rename` it first.
- **Writes respect a read-only file** (`chmod 444`): exit `2`, nothing written; `--dry-run` still previews.
- **Writes refuse files they would corrupt.** A ledger that is not valid UTF-8, or that mixes LF and CRLF, gets exit `2` with an explanation instead of a silently re-encoded rewrite.
- **Ids are `\d+[a-z]?`** (`393b` is real) and are never recycled. `new FILE --id N` with `N` at or below the highest existing id still writes, but prints `W211` — don't reuse a number just because its row is gone.
- **`--body-file` may not contain `#` / `##` headings** (they would end the issue block while `check` still passed) and may not end inside an open fence; `###` or Setext headings are refused by the write gate (`E110`). A leading BOM and leading blank lines are stripped, so writing back `body.text` minus its heading changes nothing. The line `<!-- issuemd:kept-body:end -->` is refused outside a code fence.
- **`read` matches a top-level `##` heading exactly** — no regex, no substring, no chain. A duplicate or missing title exits `2` and lists the candidates.
- **A row that holds several ids, or a range, is read-only for per-id verbs.** `close`, `reopen`, `status`, `rename`, `body` and `priority` all refuse it with exit `2` and the same message:

  ```text
  issuemd reopen: #20 shares a row with other ids (20, 24, 29); split the row first: issuemd split FILE 20
  ```

  `issuemd split FILE 20` gives every id its own row (fields copied). Bodies are not invented: an id that had none keeps its E102 and is named on stderr — write it with `issuemd body`. Ranges over 1000 ids are refused.

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
