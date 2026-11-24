# Glossary

Terms used by issuemd, its spec, and its users. Each entry is a definition, not a rule — rules live in `docs/spec.md`, decisions in `docs/adr/`.

## Ledger

A single Markdown file that is both the index and the record of a project's issues. It holds an index table, a closed table, and one body block per open issue. "Issue document", "issue 台账", and "ledger" all mean this; **ledger** is the canonical term.

## Index

The table listing **open** issues only, with columns `# | 状态 | P | 摘要`. Its number of rows equals the number of open issues. It never lists a closed issue. Formerly called 状态总览 / 待处理 / 索引.

## Closed table

The table listing every closed issue, with columns `# | 状态 | P | 摘要 | 判据`. It holds no duplicate of the index — the two tables' id sets are disjoint. Formerly called 已关闭.

## Body / body block

The `### Issue <n>: <title>` section holding one open issue's full description. There is exactly one body block per open issue, in ascending id order. Closed issues have no body block.

## Criteria (判据)

The evidence that an issue is actually closed — a test count, a commit, a measured result. While the issue is open, criteria live in the body under a `**验收判据**` label. On `close`, they move into the closed table's 判据 column, so **there is exactly one criteria per issue at any time**, never two.

## Status

A single word from the declared vocabulary (`未决` / `部分解决` / `观察` / `已修` / `延后` / `决定不改` / `不是缺陷` / `范围外` / `撤回` / `并入` / `未分类`) that classifies an issue as open or closed. Status exists **only** in a table cell — never in a heading, never in a body.

## Summary (摘要)

The full title of an issue, stored in the index table **and** as the body block's H3. Both copies are byte-identical after whitespace normalisation; `rename` changes both in one transaction. Read commands truncate for display; truncation is never stored.

## Progress text (进展)

Narrative about how far along an issue is — "已落地", "仍缺", "仍逐". Progress belongs in the body, never in a table cell. Table cells hold the stable label: *what the issue is*, not *where it stands*. The distinction is why the summary column and the body title can be the same string.

## Drift

Any state where two places claim to describe the same fact and disagree. Drift is not a mistake by the author; it is the predictable result of storing one fact twice without a check. A ledger is drift-free when `check` exits 0.

## Pipe block

A maximal run of consecutive lines starting with `|`. The **parsing unit** of a ledger — not "GFM table", because a pipe block may lack a `|---|` separator row, in which case it has no header and every line is data. Treating such a block as a table with a header silently loses its first row.

## Id

An issue number matching `^[0-9]+[a-z]?$` (`393b` is real). Ids ascend, are never recycled, and `new` takes `max + 1`. A single cell may hold several ids (`20, 24, 29`) or a retired range (`1–199`). Only `new` can observe reuse: an explicit `new --id N` with `N` at or below the highest existing id still writes but warns `W211`. A static `check` has no notion of "new", so it cannot.

## Retired range

A closed-table row whose id cell is a range, asserting that every id inside it was closed with no further record kept. It lets ~150 empty numbers be stated in one row instead of fabricating 150 rows.

## Appendix

A free-format `##` section after the body — dated review logs, evidence transcripts. issuemd leaves its general content alone, but two things touch it: it forbids `### Issue` headings inside it (`E123`), so no ledger data can hide there; and `close --keep-body` archives a body as a plain `### #N <summary>（已关闭，正文保留）` heading, which `check` reports as `W250`. Any other heading or prose is untouched.

## Adopt

The one-time rewrite of a non-canonical ledger into canonical form. It performs only mechanical edits and emits a **decision list** for everything it will not decide itself (title conflicts, progress text that would be lost, closed issues that still have bodies). It never makes a semantic judgement on the author's behalf — that authority belongs to `migrate`-by-agent plus human review.