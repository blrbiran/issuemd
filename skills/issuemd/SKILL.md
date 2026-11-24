---
name: issuemd
description: |
  Read and edit a single-file issue ledger (issue 台账) with structural guarantees: one status table, one body block per open issue, criteria stored once. Use this skill whenever a task touches an issue ledger — 台账 / issue 文档 / 状态总览 / 待处理 / 关一条 issue / 新增 issue / 核对台账 / 改 issue 状态 / 修台账漂移 — or when you are about to hand-edit a `| # | 状态 | … |` table and a `### Issue N:` body in the same file. Also trigger when a ledger check fails or when titles/status/counts disagree. Use issuemd for ledgers; use lilmd or any text editor for ordinary Markdown — issuemd is deliberately not a general Markdown tool.
---

# issuemd — an issue ledger that cannot drift

`issuemd` keeps three places in agreement: the status table, the body blocks, and the criteria. It is a ledger tool only — it has no generic Markdown editing verbs, so every command below is about issues.

The rule that matters: **never hand-edit a status table.** A ledger has structure; use the command that changes all affected places at once, then prove it with `check`. Body *prose* (adding a repro step, updating a root cause) has no dedicated verb yet: edit it by hand, then run `issuemd check FILE` immediately.

## Check the tool first

```bash
command -v issuemd && issuemd --help >/dev/null
```

If it is missing:

- **Inside an issuemd checkout**: `npm ci && npm run build && npm link` (or run `node dist/bin/issuemd.js` directly).
- **Once the package is published**: `npm install -g @blrbiran/issuemd`. Until then that command fails with `ENOTFOUND`/404 — don't retry it.

If neither works, fall back to `lilmd` + a manual consistency pass, and say so once. Don't burn turns reinstalling.

Starting a brand-new ledger? Copy the packaged `TEMPLATE.md` (it already passes `check`) and add the first issue with `issuemd new`.

## The loop

### 1. Survey

```bash
issuemd list FILE               # open issues: id, status, priority, summary
issuemd list FILE --status 未决
issuemd list FILE --closed      # the closed table; text output includes 判据
issuemd list FILE --json        # each entry has ids[] and count; top level rowCount/issueCount
issuemd list FILE --expand      # one entry per id (`20, 24` and `7–20` rows are expanded)
issuemd counts FILE             # per-status counts, computed (never stored)
issuemd read FILE 附录          # any top-level section, verbatim
```

`list` counts rows, `counts` counts ids: a `7–20` row is one row and 14 issues. Use `--json` (`count`, `issueCount`) or `--expand` when you need ids.

An unknown `--status` word is exit `2` (with the vocabulary listed); a closed status on the open table tells you to add `--closed`. If stderr says some table rows **could not be read**, the result is incomplete — run `check` and fix those rows first.

`issuemd FILE` is not a shortcut: it exits `2` with `unknown command`. Every command takes only its own options (`issuemd <command> --help`); a stray option is exit `2`, not silently ignored.

### 2. Read one issue

```bash
issuemd show FILE 65                 # the body block, plus its table row
issuemd show FILE 65 --label 验收判据  # just that labelled block
issuemd show FILE 65 --json          # {id,table,status,priority,summary,criteria,criteriaSource,line,end,body{line,end,text},labels}
```

A labelled block runs from `**标签**` to the next label or heading — a blank line followed by a list belongs to it. `--label` on a label with nothing under it is exit `1` with "exists but is empty". `--json` gives every label as one line in `labels`, and `criteria` with `criteriaSource` (`table` for closed issues, `body` for open ones).

### 3. Change state — only with a ledger verb

```bash
issuemd new    FILE --title "…" --priority P2              # id defaults to max+1; status 未决
issuemd new    FILE --title "…" --body-file body.md        # body.md: text *under* the heading
issuemd close  FILE 57                                     # promotes the body's 验收判据
issuemd close  FILE 57 --status 延后 --criteria "owner: 转设计"
issuemd close  FILE 57 --keep-body                         # archive the body under 附录
issuemd status FILE 56 部分解决                            # open→open or closed→closed only
issuemd reopen FILE 57                                     # back to 未决
issuemd rename FILE 16 "new summary"                       # table + body title + archive heading
```

Every one of these is atomic and supports `--dry-run` (a unified diff, one hunk per changed region). Use `--dry-run` first whenever the file is not a scratch copy.

- **`close` never drops criteria silently.** With no flag it promotes the body's `**验收判据**`; if there is none it refuses (exit `2`) — pass `--criteria TEXT`, `--keep-body`, or `--no-criteria` to close without criteria on purpose. `--criteria-from-body` refuses when the block is missing or empty (a fenced example does not count). Lists are joined with `；` in the cell.
- **`status` refuses to cross the open/closed boundary** — that is a `close`/`reopen`, because crossing changes three places, not one. It also repairs a typo'd status word (`W220`) inside the same table.
- **`reopen`** puts the issue back as `未决`; the previous open status is not kept. If the body was kept with `--keep-body`, it is restored verbatim and the archive removed; otherwise you get the label skeleton with the criteria filled in.
- **`--body-file`** is the text that goes *under* `### Issue N: <title>` — never include the heading yourself (it would be a second heading: E105). Minimal file: `printf '**现象**：…\n\n**验收判据**：…\n' > body.md`.
- **A title starting with `-`** must be attached with `=`: `--title="--body-file 的语义"`; otherwise you get `Option '--title' argument is ambiguous`.
- **Priorities are `P0`–`P3` or empty.** `new` refuses anything else; `check` warns `W221` about existing ones.
- `new` with a summary that already exists prints `W212` (possible duplicate, e.g. after a retry) — check `list` before filing again.

### 4. Prove it

```bash
issuemd check FILE                # exit 0 ok / 2 usage or I/O / 3 found errors (never 1)
issuemd check FILE --json         # machine-readable
issuemd check FILE --strict       # warnings fail too (except W250)
```

Exit code **3** means structural errors. Fix them before reporting anything as done.

`check` warnings worth knowing:

- `W202` — a short hash pinned in prose (it rots). Commits in the closed table's 判据 column are expected and are not W202; `--verify-commits` checks them and reports `W240` for a commit the repo does not have.
- `W212` duplicate summary · `W220` undeclared status · `W221` undeclared priority.
- `W250` — an appendix archive left by `close --keep-body` (or `adopt`): a `### #N <summary>（已关闭，正文保留）` heading ending at `<!-- issuemd:kept-body:end -->`. Intentional, informational, never fails `--strict`. Leave the marker alone: `reopen` restores exactly the text above it. The archive is a frozen snapshot, not a second copy of the criteria. `W251`/`W252` mean someone hand-edited it out of step.

### 5. Fix drift mechanically

```bash
issuemd sync FILE --titles --prefer=body --dry-run
issuemd sync FILE --fix-tables --dry-run
issuemd sync FILE --guide --dry-run
```

`sync` never deletes a body, never moves a row, never changes a status. That boundary is what makes it safe to run unattended with `--dry-run`. Rows it cannot fix (several ids in one row) are listed on stderr.

If `--titles` reports W260 (a table summary carries progress text the body title lacks), it **refuses to run** until you pick `--move-progress` (append that text to the body, losing nothing) or `--drop-progress` (overwrite, knowingly).

## Several agents, one ledger

Writes are optimistic: each command re-checks the file just before replacing it. If someone else wrote in between, it refuses with **exit `4`** (`E130 … changed after it was read`) and changes nothing. Then: re-read (`show` / `list`), decide again, retry the command. Exit `4` is the only retryable code — `2` is your usage error, `3` is the ledger.

- `--dry-run` previews the file *as it is now*; it is not a lock. A later real write still re-checks and may exit `4`.
- Don't have two agents edit the same issue at once; if a `close` says "already closed", someone else closed it — re-read before acting.
- Use one path for a shared ledger. A symlink is fine (writes go through to the target); a hard link is not (the other name keeps the old content after a write — you get a warning).

## Format rules that will bite you

- **A ledger needs `## 索引`, `## 已关闭` and `## 正文`** (plus `## 怎么用` / `## 状态口径`). Missing any of the three core sections is `E120` — "not a ledger"; start from `TEMPLATE.md`.
- **Every table needs a `|---|` separator row.** A block of `|`-lines without it is not a table — it renders as one paragraph of literal pipes (`E122`).
- **Count issues by id, not by row.** One cell may hold several ids (`| 20, 24, 29 |` is three) or a retired range (`| 1–199 |`).
- **No headings inside an issue body.** Use `**bold labels**`; `####` inside a body is `E110`. Read one labelled block with `show --label`.
- **A closed issue must have no body block.** Closing deletes it and promotes `**验收判据**` into the table; a leftover block is `E111`.
- **Never put counts in headings** (`## 待处理（16）`). Every count change then invalidates every reference, and stale ones fail silently (`E121`).
- **Status lives only in the table.** A `**状态**` line in a body is an error (`E107`).
- **The summary and the body title are the same string.** Don't shorten one; `rename` changes both.
- **Escape pipes inside cells** as `\|` — including inside backticks. Too many cells is `E108`, whose message says so.
- **A title may not end with ` #`** — Markdown strips the trailing hash from the body heading, so it could never match the table summary. `new` / `rename` refuse it up front.
- **Writes refuse files they would corrupt.** A ledger that is not valid UTF-8, or that mixes LF and CRLF, gets exit `2` with an explanation instead of a silently re-encoded rewrite.
- **Ids are `\d+[a-z]?`** (`393b` is real) and are never recycled. `new FILE --id N` with `N` at or below the highest existing id still writes, but prints `W211` — don't reuse a number just because its row is gone.
- **`--body-file` may not contain `#` / `##` headings** (they would end the issue block while `check` still passed) and may not end inside an open fence; `###` or Setext headings are refused by the write gate (`E110`). A leading BOM is stripped.
- **`read` matches a top-level `##` heading exactly** — no regex, no substring, no chain. A duplicate or missing title exits `2` and lists the candidates.
- **A row that holds several ids, or a range, is read-only for per-id verbs.** `close`, `reopen`, `status` and `rename` all refuse it with exit `2`:

  ```text
  issuemd reopen: #20 shares a row with other ids (20, 24, 29); split the row first
  issuemd status: #10 is a range; change a concrete issue
  ```

  There is no split verb yet: split the row by hand (one row per id, same status/summary/criteria), then `issuemd check`.

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
