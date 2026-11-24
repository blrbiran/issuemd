---
name: issuemd
description: |
  Read and edit a single-file issue ledger (issue 台账) with structural guarantees: one status table, one body block per open issue, criteria stored once. Use this skill whenever a task touches an issue ledger — 台账 / issue 文档 / 状态总览 / 待处理 / 关一条 issue / 新增 issue / 核对台账 / 改 issue 状态 / 修台账漂移 — or when you are about to hand-edit a `| # | 状态 | … |` table and a `### Issue N:` body in the same file. Also trigger when a ledger check fails or when titles/status/counts disagree. Use issuemd for ledgers; use lilmd or any text editor for ordinary Markdown — issuemd is deliberately not a general Markdown tool.
---

# issuemd — an issue ledger that cannot drift

`issuemd` keeps three places in agreement: the status table, the body blocks, and the criteria. It is a ledger tool only — it has no generic Markdown editing verbs, so every command below is about issues.

The rule that matters: **never hand-edit a status table.** A ledger has structure; use the command that changes all affected places at once, then prove it with `check`.

## Check the tool first

```bash
command -v issuemd || npm install -g @blrbiran/issuemd
```

Starting a brand-new ledger? Copy the packaged `TEMPLATE.md` (it already passes `check`) and add the first issue with `issuemd new`.

If `issuemd` is unavailable and cannot be installed, fall back to `lilmd` + a manual consistency pass, and say so once. Don't burn turns reinstalling.

## The loop

### 1. Survey

```bash
issuemd list FILE               # open issues only: id, status, priority, summary
issuemd list FILE --status 未决
issuemd list FILE --closed      # the closed table, with criteria
issuemd counts FILE             # per-status counts, computed (never stored)
issuemd read FILE 附录          # any top-level section, verbatim
```

`list` is the cheap view. Don't read the whole table if you only need to know what's open.

### 2. Read one issue

```bash
issuemd show FILE 65                 # the body block, plus its table row
issuemd show FILE 65 --label 验收判据  # just that labelled paragraph
issuemd show FILE 65 --json          # {id,table,status,priority,summary,criteria,body}
```

Reading the row and the body together is the point: if they disagree, `show` tells you.

### 3. Change state — only with a ledger verb

```bash
issuemd new    FILE --title "…" --status 未决 --priority P2   # id defaults to max+1
issuemd close  FILE 57 --criteria-from-body      # criteria moves to the closed table
issuemd close  FILE 57 --keep-body               # archive the body under 附录 (reopen restores it)
issuemd status FILE 56 部分解决                  # open→open or closed→closed only
issuemd reopen FILE 57
issuemd rename FILE 16 "new summary"             # table + body title, one transaction
```

Every one of these is atomic and supports `--dry-run`. Use `--dry-run` first whenever the file is not a scratch copy.

`status` refuses to cross the open/closed boundary — that is a `close`, because crossing changes three places, not one.

### 4. Prove it

```bash
issuemd check FILE                # exit 0 ok / 1 no match / 2 usage / 3 found errors
issuemd check FILE --json         # machine-readable
```

Exit code **3** means structural errors. Fix them before reporting anything as done. `check` also reports `W250` for an appendix entry left by `close --keep-body` (a `### #N <summary>（已关闭，正文保留）` heading, ended by `<!-- issuemd:kept-body:end -->`) — that's intentional, not drift. Leave the marker alone: `reopen` restores exactly the text above it.

### 5. Fix drift mechanically

```bash
issuemd sync FILE --titles --prefer=body --dry-run
issuemd sync FILE --fix-tables --dry-run
issuemd sync FILE --guide --dry-run
```

`sync` never deletes a body, never moves a row, never changes a status. That boundary is what makes it safe to run unattended with `--dry-run`.

If `--titles` reports W260 (a table summary carries progress text the body title lacks), it **refuses to run** until you pick `--move-progress` (append that text to the body, losing nothing) or `--drop-progress` (overwrite, knowingly).

## Format rules that will bite you

- **Every table needs a `|---|` separator row.** A block of `|`-lines without it is not a table — it renders as one paragraph of literal pipes (`E122`).
- **Count issues by id, not by row.** One cell may hold several ids (`| 20, 24, 29 |` is three) or a retired range (`| 1–199 |`).
- **No headings inside an issue body.** Use `**bold labels**`; `####` inside a body is `E110`. Read one labelled paragraph with `show --label`.
- **A closed issue must have no body block.** Closing deletes it and promotes `**验收判据**` into the table; a leftover block is `E111`.
- **Never put counts in headings** (`## 待处理（16）`). Every count change then invalidates every reference, and stale ones fail silently (`E121`).
- **Status lives only in the table.** A `**状态**` line in a body is an error (`E107`).
- **The summary and the body title are the same string.** Don't shorten one; `rename` changes both.
- **Escape pipes inside cells** as `\|` (`E108` / `W205`).
- **A title may not end with ` #`** — Markdown strips the trailing hash from the body heading, so it could never match the table summary. `new` / `rename` refuse it up front.
- **Writes refuse files they would corrupt.** A ledger that is not valid UTF-8, or that mixes LF and CRLF, gets exit `2` with an explanation instead of a silently re-encoded rewrite.
- **Ids are `\d+[a-z]?`** (`393b` is real) and are never recycled. `new FILE --id N` with `N` at or below the highest existing id still writes, but prints `W211` — don't reuse a number just because its row is gone.
- **`--body-file` replaces the whole body**; without it, `new` writes the four-label skeleton (`现象` / `根因` / `期望` / `验收判据`). A body file may not contain `#` / `##` headings (they would end the issue block while `check` still passes) and may not end inside an open fence; a leading BOM is stripped.
- **`read` matches a top-level `##` heading exactly** — no regex, no substring, no chain. A duplicate or missing title exits `2` and lists the candidates.
- **A row that holds several ids is read-only for per-id verbs.** `close`/`rename`/`status` on `| 20, 24, 29 |` refuse; split the row first.

## Writing issues an owner can act on

Each open issue must stand alone: environment (`file:line`, command, raw output), reproduction steps, expected behaviour, acceptance criteria. Never pin a commit hash that will rot — give the lookup command instead (`git log --oneline -3`).

Don't write status into the body. The table is the only place status exists, which is why the table and the body can never contradict each other on that axis.

## Adopting an old ledger

```bash
issuemd adopt OLD.md --dry-run --report decisions.md
```

It does the mechanical part (add missing sections, merge a duplicated closed table, drop closed rows from the index, strip `（N）` from headings, add missing table separators, demote body `####` to bold labels, move closed issues' bodies into the appendix) and lists what it will not decide: title conflicts, progress text, status words outside the vocabulary, rows holding several ids. Read the report; approve or fix each item. It never makes a semantic call for you, and it refuses to write if the result would still fail `check`.

## Quick reference

```bash
issuemd list FILE --status 未决           # what's open
issuemd show FILE 65                      # one issue, row + body
issuemd check FILE --json                 # verify (exit 3 = errors)
issuemd new    FILE --title "…"           # add
issuemd close  FILE 57 --criteria-from-body
issuemd rename FILE 16 "…"                # fix drift
issuemd sync   FILE --titles --dry-run    # preview mechanical fixes
issuemd adopt  OLD.md --dry-run           # one-time conversion
```

Read-only commands are safe anywhere. Write commands modify the file in place; `--dry-run` prints a diff instead. `issuemd --help` lists every flag.