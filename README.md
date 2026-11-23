# issuemd

A CLI for **single-file issue ledgers** — the kind of Markdown where a table holds status, one `### Issue N:` block per open issue holds the root cause, and a closed section holds only the acceptance criteria.

It is a superset of `lilmd` (`npm i -g lilmd`): every read and write command works the same way, plus a set of ledger-aware verbs that change the table, the body, and the counts **in one transaction**, and a `check` that proves nothing drifted.

```bash
issuemd check issue-20261119.md          # exit 3 = structural errors
issuemd list issue-20261119.md           # open issues only
issuemd show issue-20261119.md 65        # one issue: table row + body
issuemd close issue-20261119.md 57 --criteria-from-body
issuemd sync issue-20261119.md --titles --prefer=body --dry-run
```

## Why

Long-lived ledgers written by agents drift in three predictable ways. All three were measured on two real ledgers (2.6k and 2.1k lines):

| Drift | Measured |
|---|---|
| Body title vs the table summary | **27 of 28** open issues disagree |
| The same title stored a third time (closed table) | **47 of 48** disagree |
| A heading that encodes a count (`### 已修（212）`) | actually **211** |

None of these are typos. They are what happens when the same fact is stored three times and nothing checks it. `issuemd` stores each fact once, or checks it on every run.

It also fixes a rendering bug that no checker noticed: **11 pipe blocks** in a real ledger have no `|---|` separator, so under GFM they are not tables at all — the entire "open issues" section renders as one paragraph of literal `|` characters.

## Install

```bash
npm install -g issuemd --registry=https://registry.npmmirror.com
```

## Design

- `/SPEC.md` — the full specification: measured problems, canonical format, compatibility layer for existing layouts, invariants, command surface, implementation plan, acceptance criteria using the two real ledgers.
- `/SKILL.md` — the agent-facing skill (drop into `~/.agents/skills/issuemd/`).
- `/verify-facts.mjs` — re-checks every number quoted in the spec against the two real ledgers (`node verify-facts.mjs`, exit 1 on drift). Run it after editing `/SPEC.md`.

Two principles run through both:

1. **Status is stored once.** A body never repeats its status; the table is the only place it exists.
2. **Counts are computed, never stored.** `issuemd counts` prints them; nothing in a heading encodes them.

## Compatibility

Existing ledgers are adopted without migration:

- **L1** — one full table with a `状态` column (closed rows mirroring the closed section).
- **L2** — status carried by `### 未决（13）`-style headings; the table holds open issues only.

`issuemd migrate FILE --to canonical` converts either to the canonical layout, carrying any progress text in old table summaries into the body rather than dropping it.

## Status

Specification complete, implementation starting at P0 (fork lilmd, fix seven silent-corruption bugs, then the ledger model). See `/SPEC.md` §12.
