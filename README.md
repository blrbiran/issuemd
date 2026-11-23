# issuemd

A CLI for **single-file issue ledgers** — the kind of Markdown where a table holds status, one `### Issue N:` block per open issue holds the root cause, and a closed section holds only the acceptance criteria.

The P0 build provides the Markdown commands from [`lilmd`](https://github.com/molefrog/lilmd) with plain-text and JSON reads. The examples below describe the planned ledger commands, which will update the table, body, and criteria together.

```bash
issuemd check issue-20261119.md          # exit 3 = structural errors
issuemd list issue-20261119.md           # open issues only
issuemd show issue-20261119.md 65        # one issue: table row + body
issuemd close issue-20261119.md 57 --criteria-from-body
issuemd sync issue-20261119.md --titles --prefer=body --dry-run
```

## Why

Long-lived ledgers drift in three predictable ways. All three were measured on two real ledgers (2.7k and 2.1k lines):

| Drift | Measured |
|---|---|
| Body title vs the table summary | **15 of 15** open issues disagree |
| The same summary stored a third time (closed table) | **60 of 61** disagree |
| A heading that encodes a count (`### 已修（212）`) | actually **211** |

None of these are typos. They are what happens when the same fact is stored more than once and nothing checks it.

The sharper lesson came from reading each ledger's own "how to use" table: one says *"change only the status row; never touch the body"* — and has since accumulated **13 closed issues whose bodies are still there**, growing the file by 40 lines. The other says *"closed? delete the block"* — and has **0 of 16** title mismatches. The two ledgers contradict each other on what closing means, and one of them has already rotted. `issuemd` takes the second direction and makes it an invariant.

It also fixes a rendering bug that no checker noticed: **11 pipe blocks** in a real ledger have no `|---|` separator, so under GFM they are not tables at all — the entire "open issues" section renders as one paragraph of literal `|` characters.

## Install

Build and link from this checkout with Node.js 20 or later and npm.

```bash
npm ci
npm run build
npm link
issuemd fixtures/canonical-clean.md
```

With Bun available, run `npm test` to build the CLI and run its tests. The planned npm package name is `@blrbiran/issuemd`.

## Design

- [`/docs/spec.md`](docs/spec.md) — the full specification: measured problems, canonical format, invariants, command surface, implementation plan, acceptance criteria on synthetic fixtures.
- [`/docs/adr/`](docs/adr/) — the decisions that would look arbitrary without context (why no compatibility layer, why closing deletes the body, why the summary equals the body title).
- [`/GLOSSARY.md`](GLOSSARY.md) — the vocabulary: ledger, index, closed table, body block, pipe block, criteria, progress text, drift.
- [`/skills/issuemd/SKILL.md`](skills/issuemd/SKILL.md) — the agent-facing skill (drop into `~/.agents/skills/issuemd/`).

Three principles run through all of them:

1. **Status is stored once.** A body never repeats its status; the table is the only place it exists.
2. **Counts are computed, never stored.** `issuemd counts` prints them; nothing in a heading encodes them.
3. **Criteria is stored once.** In the body while open, in the closed table once closed.

## One format, no compatibility layer

Existing ledgers are **not** adopted at runtime. `issuemd adopt FILE --dry-run --report decisions.md` performs the mechanical rewrites and prints everything it will not decide on its own — title conflicts, progress text that would otherwise be lost, closed issues that still have bodies. An agent plus a human finish the job once; after that there is a single format.

## Status

P0 ships the Markdown CLI baseline. Use the generic write commands on test copies during this phase. P1 covers the known write-safety defects, and P2 onward adds the ledger-specific commands described in [the implementation plan](docs/spec.md#12-实施计划).

## License

issuemd uses MIT for its own code. The Markdown CLI baseline was copied from [`lilmd`](https://github.com/molefrog/lilmd) at `b557b02`. The upstream checkout has no license file. Confirm permission to redistribute that code before a public release.