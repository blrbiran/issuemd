---
name: issuemd
description: |
  Read and edit a single-file issue ledger (issue 台账) with structural guarantees: one status table, one body block per open issue, criteria only once. Use this skill whenever a task touches an issue ledger — 台账 / issue 文档 / 状态总览 / 待处理 / 关一条 issue / 新增 issue / 核对台账 / 改 issue 状态 / 修台账漂移 — or when you are about to hand-edit a `| # | 状态 | … |` table and a `### Issue N:` body in the same file. Also trigger when a ledger check fails or when titles/status/counts disagree. Prefer issuemd over lilmd for ledgers; use lilmd for ordinary long Markdown.
---

# issuemd — an issue ledger that cannot drift

`lilmd` lets you read one section of a big file cheaply. `issuemd` does that **and** keeps three places in agreement: the status table, the body blocks, and the criteria.

The rule that matters: **never hand-edit a status table.** A ledger has structure; use the command that changes all affected places at once, then prove it with `check`.

## Check the tool first

```bash
command -v issuemd || npm install -g issuemd --registry=https://registry.npmmirror.com
```

If `issuemd` is unavailable and cannot be installed, fall back to `lilmd` + a manual consistency pass, and say so once. Don't burn turns reinstalling.

## The loop

### 1. Survey

```bash
issuemd FILE                    # TOC + line ranges
issuemd list FILE               # open issues only: id, status, priority, summary
issuemd list FILE --status 未决
issuemd counts FILE             # per-section counts, computed (never stored)
```

`list` is the cheap view. Don't read the whole table if you only need to know what's open.

### 2. Read one issue

```bash
issuemd show FILE 65            # the body block, plus its table row
issuemd show FILE 65 --json     # {id,status,priority,title,criteria,body}
```

Reading the row and the body together is the point: if they disagree, `show` tells you.

### 3. Change state — only with a ledger verb

```bash
issuemd new    FILE 77 --title "…" --status 未决 --priority P2
issuemd close  FILE 57 --criteria-from-body      # criteria moves to the closed table
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

Exit code **3** means structural errors. Fix them before reporting anything as done.

### 5. Fix drift mechanically

```bash
issuemd sync FILE --titles --prefer=body --dry-run
issuemd sync FILE --counts --dry-run
issuemd sync FILE --fix-tables --dry-run
```

`sync` never deletes a body, never moves a row, never changes a status. That boundary is what makes it safe to run unattended with `--dry-run`.

If `--titles` reports W260 (a table summary carries progress text the body title lacks), it **refuses to run** until you pick `--move-progress` (append that text to the body, losing nothing) or `--drop-progress` (overwrite, knowingly).

## Format rules that will bite you

- **Every table needs a `|---|` separator row.** A block of `|`-lines without it is not a table — it renders as one paragraph of literal pipes. Real ledger has 11 such blocks; `check` reports them as `W207` (or `E122` under `--format=canonical`).
- **Count issues by id, not by row.** One cell may hold several ids: `| 20, 24, 29 |` is three. Counting rows will make you "find" errors in five correct sections.
- **The two index semantics are opposite.** Some ledgers' status table lists *all* issues (closed ones mirror the closed table exactly); others list *only* open ones (disjoint from the closed table). `issuemd` detects which and applies the right rule.
- **Never put counts in headings** (`## 待处理（16）`). Every count change then changes the selector, and stale references fail silently. `check` flags it; `counts` prints numbers without storing them.
- **Status lives only in the table.** A `**状态**` line in a body is an error (`E107`).
- **Escape pipes inside cells** as `\|` (`E108` / `W205`).
- **Ids are `\d+[a-z]?`** (`393b` is real) and are never recycled.
- **Pad `--body` with a newline on both ends**, same discipline as lilmd.

## Writing issues an owner can act on

Each open issue must stand alone: environment (`file:line`, command, raw output), reproduction steps, expected behaviour, acceptance criteria. Never pin a commit hash that will rot — give the lookup command instead (`git log --oneline -3`).

Don't write status into the body. The table is the only place status exists, which is why the table and the body can never contradict each other on that axis.

## Quick reference

```bash
issuemd FILE                              # survey
issuemd list FILE --status 未决           # what's open
issuemd show FILE 65                      # one issue, row + body
issuemd check FILE --json                 # verify (exit 3 = errors)
issuemd new    FILE 77 --title "…"        # add
issuemd close  FILE 57 --criteria-from-body
issuemd rename FILE 16 "…"                # fix drift
issuemd sync   FILE --titles --dry-run    # preview mechanical fixes
issuemd migrate FILE --to canonical --dry-run   # adopt a non-canonical ledger
```

Read-only commands are safe anywhere. Write commands modify the file in place; `--dry-run` prints a diff instead. `issuemd --help` lists every flag.
