# issuemd

A CLI for **single-file issue ledgers** — the kind of Markdown where a table holds status, one `### Issue N:` block per open issue holds the root cause, and a closed section holds only the acceptance criteria.

`issuemd check` validates a canonical ledger and reports errors and warnings with line numbers.

```bash
issuemd check fixtures/canonical-clean.md
issuemd check fixtures/canonical-clean.md --json
```

The exit code is `0` on success, `2` for usage or I/O errors, and `3` for validation failures. Add `--strict` to fail on warnings or `--verify-commits` to look up referenced commits in the ledger's Git repository.

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

Earlier editions of the ledgers need conversion before running `check`. The planned `issuemd adopt FILE --dry-run --report decisions.md` will preview mechanical changes and flag decisions about conflicting titles, progress text, and closed issues that still have bodies.

## Status

P2 provides the canonical parser and `check`. The generic Markdown write commands preserve trailing blank lines and skip writes when the contents are unchanged. They recheck the file immediately before replacing it. Ledger-specific mutation and conversion are later milestones in [the implementation plan](docs/spec.md#12-实施计划).

## License

issuemd uses MIT for its own code. The Markdown CLI baseline was copied from [`lilmd`](https://github.com/molefrog/lilmd) at `b557b02`. The upstream checkout has no license file. Confirm permission to redistribute that code before a public release.