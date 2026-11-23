# issuemd

A CLI for **single-file issue ledgers** — the kind of Markdown where a table holds status, one `### Issue N:` block per open issue holds the root cause, and a closed section holds only the acceptance criteria.

`issuemd check` validates a canonical ledger and reports errors and warnings with line numbers. The other commands read and maintain the same file.

```bash
issuemd check   FILE [--json] [--strict] [--verify-commits]
issuemd list    FILE [--status S] [--priority P] [--closed] [--json]
issuemd show    FILE ID [--json] [--label 验收判据]
issuemd counts  FILE [--json]
issuemd read    FILE <H2 heading>

issuemd new     FILE --title T [--id N] [--status S] [--priority P]
issuemd close   FILE ID [--criteria TEXT | --criteria-from-body] [--keep-body]
issuemd reopen  FILE ID
issuemd status  FILE ID NEW_STATUS
issuemd rename  FILE ID "NEW TITLE"
issuemd sync    FILE [--guide | --fix-tables | --titles [--prefer body|table]]
issuemd adopt   FILE [--dry-run] [--report PATH]
```

Every write verb is atomic, keeps the file's BOM, line endings, trailing newline and mode bits, and validates the result before replacing the file: a change that would introduce a new `check` error is refused with exit `3` and nothing is written. `--dry-run` prints a unified diff instead.

The exit code is `0` on success, `1` for an unknown issue or empty result, `2` for usage or I/O errors, and `3` for validation failures. Add `--strict` to fail on warnings or `--verify-commits` to look up referenced commits in the ledger's Git repository.

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
issuemd list fixtures/canonical-clean.md
issuemd check fixtures/canonical-clean.md
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

Earlier editions of the ledgers need conversion before running `check`. `issuemd adopt FILE --dry-run --report decisions.md` previews the mechanical changes — merging a duplicated closed table, stripping `（N）` from headings, adding missing table separators, demoting body `####` to bold labels, moving the bodies of closed issues into the appendix — and writes a decision list for everything it will not decide: conflicting titles, progress text, status words outside the vocabulary, rows holding several ids. It never makes a semantic call. Both shapes it was built for (`fixtures/cafe-shaped.md`, `fixtures/orca-shaped.md`) convert to a ledger whose `check` is clean.

There is exactly one command surface: `issuemd` is a ledger tool, not a general Markdown editor. Reading a section of an ordinary Markdown file is `issuemd read FILE <H2 heading>`, and nothing else.

## Status

P0–P4 are implemented: the Markdown baseline, byte-faithful atomic writes, the canonical parser and `check`, the read views, the ledger write verbs, and `adopt`. `new`, `close`, `reopen`, `status`, `rename` and `sync` all share one gate that re-runs `check` in memory and refuses any change that introduces a new error.

The two hand-written cross-check scripts (`check-issues.mjs`, `verify-facts.mjs`) that predated `check` have been removed. What remains from P5 is a packaging decision: whether to ship `skills/issuemd/SKILL.md` in the npm package (today `files` is `dist` only, and a test pins that).

## License

issuemd uses MIT for its own code. The Markdown CLI baseline was copied from [`lilmd`](https://github.com/molefrog/lilmd) at `b557b02`. The upstream checkout has no license file. Confirm permission to redistribute that code before a public release.