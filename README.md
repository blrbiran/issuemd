# issuemd

A CLI for **single-file issue ledgers** — the kind of Markdown where a table holds status, one `### Issue N:` block per open issue holds the root cause, and a closed section holds only the acceptance criteria.

`issuemd check` validates a canonical ledger and reports errors and warnings with line numbers. The other commands read and maintain the same file.

```bash
issuemd check   FILE [--json] [--strict] [--verify-commits]
issuemd list    FILE [--status S] [--priority P] [--closed] [--expand] [--json [--with-body]]
issuemd show    FILE ID [--json] [--label 验收判据]
issuemd counts  FILE [--json]
issuemd read    FILE <H2 heading>

issuemd new     FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-] [--allow-duplicate-title]
issuemd close   FILE ID [--status S] [--criteria TEXT | --criteria-from-body | --no-criteria] [--keep-body]
issuemd reopen  FILE ID [--status S] [--allow-duplicate-title]
issuemd status  FILE ID NEW_STATUS
issuemd rename  FILE ID "NEW TITLE" [--allow-duplicate-title]
issuemd body    FILE ID --body-file PATH|-
issuemd priority FILE ID P0|P1|P2|P3|""
issuemd split   FILE ID
issuemd sync    FILE [--guide | --fix-tables | --titles [--prefer body|table]
                      [--move-progress | --drop-progress]]
issuemd adopt   FILE [--dry-run] [--report PATH]
```

Every write verb is atomic, keeps the file's BOM, line endings, trailing newline and mode bits, and validates the result before replacing the file: a change that would introduce a new `check` error is refused with exit `3` and nothing is written. `--dry-run` prints a unified diff instead (one hunk per changed region) and a `snapshot` on stderr; `--if-unchanged SNAPSHOT` then applies the write only if nobody changed the file since. `new` prints the id it filed; a write that would leave the bytes identical prints `(no changes)` and exits `0`. A file that is not valid UTF-8, or that mixes LF and CRLF, is refused with exit `2` rather than being silently re-encoded. `close` never drops criteria silently: it promotes the body's `**验收判据**` by default and refuses when there is nothing to record unless you say `--no-criteria`.

Each command accepts only its own options (`issuemd <command> --help`); anything else is exit `2`. The exit code is `0` on success, `1` for an unknown issue or empty result, `2` for usage or I/O errors, `3` for validation failures, and `4` when the file changed between read and write (`E130`; re-read and retry). Add `--strict` to fail on warnings (`W250`, the "body kept in the appendix" hint, is informational and never fails strict) or `--verify-commits` to look up referenced commits in the ledger's Git repository.

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

Node.js 20 or later:

```bash
npm install -g @blrbiran/issuemd
issuemd --help
```

To work on issuemd itself, build and link from this checkout instead:

```bash
npm ci
npm run build
npm link
issuemd list fixtures/canonical-clean.md
issuemd check fixtures/canonical-clean.md
```

With Bun available, run `npm test` to compile into `.dist-test/` and run the tests; it never touches `dist/`, so a linked `issuemd` keeps running the last real build while you test work in progress. `npm run build` (also run by `prepack`) is what updates `dist/`: it compiles into a staging directory and swaps it in, so the linked CLI keeps working during a rebuild, and a type error leaves the previous `dist/` in place. The npm package is [`@blrbiran/issuemd`](https://www.npmjs.com/package/@blrbiran/issuemd).

### As a library

The same package exposes its parser, checker and reader with TypeScript declarations — `scan`, `parseLedger`, `bodyBlocks`, `checkLedger`, `findRow`, `viewIssue`, `readDocument`, `writeAtomically`, the id helpers and their types:

```ts
import { checkLedger, parseLedger } from "@blrbiran/issuemd";
const report = checkLedger(source, "ledger.md");
const ledger = parseLedger(source);
```

## Design

- [`/docs/spec.md`](docs/spec.md) — the full specification: measured problems, canonical format, invariants, command surface, implementation plan, acceptance criteria on synthetic fixtures.
- [`/docs/adr/`](docs/adr/) — the decisions that would look arbitrary without context (why no compatibility layer, why closing deletes the body, why the summary equals the body title).
- [`/GLOSSARY.md`](GLOSSARY.md) — the vocabulary: ledger, index, closed table, body block, pipe block, criteria, progress text, drift.
- [`/TEMPLATE.md`](TEMPLATE.md) — an empty ledger that already passes `check`; copy it and run `issuemd new` to start.
- [`/skills/issuemd/SKILL.md`](skills/issuemd/SKILL.md) — the agent-facing skill, shipped inside the npm package (`files` includes it) and droppable into `~/.agents/skills/issuemd/`.

Three principles run through all of them:

1. **Status is stored once.** A body never repeats its status; the table is the only place it exists.
2. **Counts are computed, never stored.** `issuemd counts` prints them; nothing in a heading encodes them.
3. **Criteria is stored once.** In the body while open, in the closed table once closed.

## One format, no compatibility layer

Earlier editions of the ledgers need conversion before running `check`. `issuemd adopt FILE --dry-run --report decisions.md` previews the mechanical changes — merging a duplicated closed table, stripping `（N）` from headings, adding missing table separators, demoting body `####` to bold labels, moving the bodies of closed issues into the appendix — and writes a report: what it changed, what it kept verbatim, and the semantic defaults it applied (conflicting titles, progress text, statuses inferred from group headings, rows holding several ids) for you to review. It keeps every line it does not convert — header prose, notes beside tables, narrative sections, unmapped tables — and refuses to write if any input line would be lost. A ledger that already passes `check` is left untouched. Both shapes it was built for (`fixtures/cafe-shaped.md`, `fixtures/orca-shaped.md`) convert to a ledger whose `check` is clean.

There is exactly one command surface: `issuemd` is a ledger tool, not a general Markdown editor. Reading a section of an ordinary Markdown file is `issuemd read FILE <H2 heading>`, and nothing else.

## Status

P0–P5 are implemented: the Markdown baseline, byte-faithful atomic writes, the canonical parser and `check`, the read views, the ledger write verbs, `adopt`, and the agent skill (now packaged). `new`, `close`, `reopen`, `status`, `rename`, `body`, `priority`, `split` and `sync` all share one gate that re-runs `check` in memory and refuses any change that introduces a new error.

The two hand-written cross-check scripts (`check-issues.mjs`, `verify-facts.mjs`) that predated `check` have been removed. `skills/issuemd/SKILL.md`, `TEMPLATE.md` and `THIRD_PARTY_NOTICES.md` ship in the npm package; `files` is `dist` plus those three files, and `build` produces a fresh `dist` (staged, then swapped in) so a deleted source can't linger in the tarball.

## License

issuemd uses MIT for its own code — see `LICENSE`. The Markdown CLI baseline was copied from [`lilmd`](https://github.com/molefrog/lilmd) at `b557b02`; that project ships no license file, so `THIRD_PARTY_NOTICES.md` records the attribution and the MIT terms applied to the derived files (`src/scan.ts`, `src/write.ts`).