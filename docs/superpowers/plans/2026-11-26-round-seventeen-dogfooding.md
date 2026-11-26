# Round Seventeen Dogfooding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix rename drift recovery (#81), reserve visible referenced IDs in free-form 正文/附录 sections (#84), and make batched `list --json --with-body` scale near-linearly (#82).

**Architecture:** Keep issue-table parsing and free-form section parsing separate. Extend `cited` with qualifying IDs from 正文/附录, make rename's no-op depend on the complete candidate bytes, and provide one indexed lookup context to the batch body-enrichment path.

**Tech Stack:** TypeScript, Bun tests, existing ledger parser and CLI.

**Spec:** `docs/superpowers/specs/2026-11-26-round-seventeen-dogfooding-design.md`

## Global Constraints

- `src/io.ts` is not changed.
- `正文` and `附录` remain free-form and their tables are not migrated into issue rows.
- `list --json --with-body` parses the ledger once and preserves its current output fields and body-inheritance rules.
- No external dogfooding ledger is edited; no push or npm publish.
- Run `npm run typecheck && npm test`; after fast-forward merge to main, run `npm run build`.

## Review Focus

- Repeated IDs and rows duplicated between canonical issue tables and free-form sections must block a second ID assignment without turning the free-form row into a writable issue.
- HTML-commented tables and `怎么用`/`状态口径` controlled tables must not newly reserve IDs.
- Same-summary rename must repair body and archive drift while leaving a truly consistent escaped title byte-identical.
- Multi-ID, range, and overlapping-row body ownership must remain identical after lookup indexing.
- Large batch lookup must avoid per-issue scans through every row and body block; retain output equivalence and one parse.

---

### Task 1: Rename repairs drift while retaining no-op safety

**Files:**
- Modify: `src/cli.ts:1612-1671`
- Test: `src/round17.test.ts`

**Interfaces:** Uses existing `cmdRename`, `bodyBlocks`, `ARCHIVE_HEADING`, and `commit` behavior; no new public API.

- [x] **Step 1: Add failing tests** for same-summary rename repairing an E106 body heading and a W251 archive heading, plus consistent escaped-pipe title remaining byte-identical and bypassing duplicate-title rejection.
- [x] **Step 2: Run** `bun test src/round17.test.ts` and confirm failures demonstrate the early-return defect.
- [x] **Step 3: Build candidate lines before deciding the no-op.** Keep the same-summary duplicate guard bypass; let the complete candidate content determine whether to write. Preserve the original heading line when its decoded title already equals the target.
- [x] **Step 4: Run** `bun test src/round17.test.ts` and confirm all #81 cases pass.

### Task 2: Reserve referenced IDs in 正文/附录

**Files:**
- Modify: `src/ledger.ts` (cited row detection)
- Modify: `docs/spec.md` (section scan / cited-ID behavior)
- Modify: `skills/issuemd/SKILL.md` (number reservation behavior)
- Test: `src/round17.test.ts`

**Interfaces:** Reuse `PipeBlock`, `tableHeader`, `ID_COLUMN`, `isStatusWord`, `cited`, and existing JSON `citedRows` projection.

- [x] **Step 1: Add failing tests** for an issue-shaped table in 正文, the same table after `close --keep-body`, `new --id` refusal, default numbering skip, and no change for commented-out or controlled guide/status tables.
- [x] **Step 2: Run** `bun test src/round17.test.ts` and confirm identifiers from the first two cases currently go unreserved.
- [x] **Step 3: Adjust `strayRows` section handling.** Keep canonical and controlled sections skipped; allow 正文/附录 through a cited-only path using existing table and visible-row rules. Do not emit W225 for these two sections and do not add rows to `unreadable`.
- [x] **Step 4: Update spec and SKILL** to state that visible qualifying IDs in free-form 正文/附录 tables are cited/reserved while the content remains unparsed.
- [x] **Step 5: Run** focused tests and confirm cited rows are visible with section/line source and both explicit/default allocation are safe.

### Task 3: Index batched with-body lookups

**Files:**
- Modify: `src/ledger-read.ts:38-53,105-156,174-204`
- Modify: `src/cli.ts:450-470` (batch context construction)
- Test: `src/round17.test.ts`

**Interfaces:** Add `WithBodyIndex` with requested-ID row lookup, exact body lookup, explicit-row ownership, compact range resolution, and row-line cached fallback. `indexWithBody(ledger, issues, blocks)` builds the batch context; `withBody(ledger, issue, index)` reuses it, while its default supports standalone callers.

- [x] **Step 1: Add equivalence tests** for canonical rows, comma rows with sibling body, ranges with interior body, compact ranges with overlaps, and expanded sparse ranges; assert exact ownership and unchanged output fields.
- [x] **Step 2: Add performance regression checks** for one-time requested-ID indexing, compact ranges without ID expansion, and cached range fallback; retain the single-`parseLedger` check.
- [x] **Step 3: Run** focused tests and benchmarks on generated 6,400 and 12,800 single-ID rows, comma rows with first-/second-ID bodies, and a 12,800-ID expanded sparse range; record timings.
- [x] **Step 4: Implement reusable requested-ID maps, compact range resolution, and per-row fallback caching**; make the batch command pass one shared lookup context into each `withBody` call.
- [x] **Step 5: Re-run** equivalence tests and benchmarks; target under 1 second for 12,800 single-ID rows and expanded sparse range, while preserving one parse and exact output semantics.

### Task 4: Full verification and handoff

**Files:**
- Modify: `docs/handoff/handoff.md`

- [x] **Step 1: Run** `npm run typecheck && npm test`.
- [x] **Step 2: Build** with `npm run build` after merging the green branch to local main.
- [x] **Step 3: Check fixtures and actual ledgers** using built CLI: three fixtures, dogfooding ledger, and the cafe/orca ledgers; confirm existing check outcomes and `adopt --dry-run` output remain stable. Do not modify external ledgers.
- [x] **Step 4: Update handoff** with round 17 findings, changes, verification, branch/main integration status, and outstanding manual push/publish decisions; avoid hardcoding HEAD hashes.
- [x] **Step 5: Request an independent code review** of the completed diff and address confirmed defects before final report.
