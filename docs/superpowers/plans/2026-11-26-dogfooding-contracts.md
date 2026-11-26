# Dogfooding Contract Clusters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed dogfooding #86–#96 issues with consistent rules for issue-ID reservation, loss-aware writes, reopening, machine-readable views, and commit verification.

**Architecture:** Keep the existing parser, CLI write gate, and read helpers. Add one authoritative comment/citation parse result, apply command-specific diagnostic-preservation rules to close/sync/split, and derive batch JSON fields and user hints from the parsed snapshot. Preserve intentional repairs and existing atomic-write behavior.

**Tech Stack:** TypeScript, Bun test runner, Node.js CLI, existing `checkLedger` / `parseLedger` pipeline.

**Spec:** `docs/superpowers/specs/2026-11-26-dogfooding-contracts-design.md`

## Global Constraints

- Do not edit the external dogfooding ledger.
- Do not modify `src/io.ts`; write through the existing CLI lock and atomic-write path.
- Use TDD: write each failing regression test before implementation and confirm the failure is the reported behavior.
- Preserve BOM, CRLF/LF, final newline, permissions, and unrelated lines.
- Preserve closed HTML-comment and fenced-example behavior; unclosed comments must not release cited IDs.
- `close` may remove only the selected issue's E102 from its baseline error set; other baseline errors may not disappear silently.
- Keep `rename` and `sync --titles` able to repair E106 when the chosen side and any discarded/preserved text are explicit.
- `reopen` must preserve archived body criterion A as current if it conflicts with closed-table value B; preserve B as closure history.
- Push and npm release remain user-controlled.

## Review Focus

1. A title containing raw `<!--` or `-->` must be refused before any file change; the body-heading renderer must not start an HTML comment or hide later sections.
2. A multi-line comment crossing H2 sections must produce one W262 and reserve each visible issue-shaped row after the opener; a closed comment and a fenced comment must preserve existing behavior.
3. A close that removes E106/E110 or an unrelated baseline error must refuse; closing an issue whose only baseline error is its own E102 remains allowed.
4. `sync --titles` must preserve W260 and report replacements identically in dry-run and write mode; explicit preference alone must not discard unique text without move/drop choice.
5. JSON diagnostics and cited rows must match `check --json` for a snapshot; unknown but present statuses remain discoverable with a W220 hint, and overlapping invalid counts are not silently normalized.

---

## File Map

- `src/ledger.ts`: HTML comment spans, free-form cited rows, unclosed-comment W262 parser warning, and cited IDs.
- `src/ledger-check.ts`: W202 treatment for inline-code evidence; W263 when commit verification is unavailable outside Git.
- `src/cli.ts`: close's baseline-error preservation, title-input validation, sync consent and change report, split W212 warning, diagnostics/citedRows JSON, cross-table filter hints, reopen content provenance, and W263 reporting.
- `src/ledger-read.ts`: status summary display including undeclared open statuses.
- `src/round18.test.ts`: focused regressions for all clusters, using existing fixture helpers.
- `README.md`: concise overview of loss-aware close, explicit sync choice, and skipped commit verification.
- `docs/spec.md`: normative exit codes, diagnostics, title sync, close/reopen semantics, comment/citation and commit-verification rules.
- `skills/issuemd/SKILL.md`: user-facing command behavior for changed contracts.
- `docs/handoff/handoff.md`: current completed work, remaining user-owned actions, and next-session pointers; no hard-coded commit hash.

## Tasks

### Task 1: Make comment visibility safe for ID allocation (#91, #93)

**Files:**
- Modify: `src/ledger.ts`
- Modify: `src/cli.ts`
- Test: `src/round18.test.ts`

**Interfaces:**
- Keep `parseLedger(src)` as the authority returning `warnings` and `cited`.
- Introduce/adjust one helper in `ledger.ts` to return both lines inside closed HTML comments and ranges opened but not closed; use it in `strayRows` only for free-form tables.
- W262 diagnostics use `{ code: "W262", line: openerLine, message: ... }`.

- [x] **Step 1: Write failing tests** for (a) unclosed comment before a free-form table: `check` has W262, `citedRows` contains its ID, explicit `new --id` refuses and default numbering skips it; (b) comment beginning in table cell does not open a span; (c) same opener inside a fence does not open a span; (d) properly closed prose comment still hides its example table; (e) comment spans across H2 sections and reserves appendix IDs.
- [x] **Step 2: Run focused tests and confirm expected failures** with `bun test src/round18.test.ts`.
- [x] **Step 3: Implement the shared comment-span calculation** in `src/ledger.ts`; keep line visibility fence-aware, exclude table rows as openers, and preserve closed-comment visibility semantics. Attach W262 to the opener. Continue recording cited IDs inside an unclosed span with a reason such as `inside unclosed HTML comment from Lx`.
- [x] **Step 4: Refuse raw HTML comment delimiters in title inputs** in `new` and `rename`, before constructing candidate bytes; stderr suggests a spaced or entity spelling and exit code is 2.
- [x] **Step 5: Run focused tests and confirm they pass**, including the existing `src/round17.test.ts` comment/citation coverage.

### Task 2: Prevent close, sync, and split from silently worsening data (#86, #90, #96)

**Files:**
- Modify: `src/cli.ts`
- Test: `src/round18.test.ts`

**Interfaces:**
- Reuse `diagnosticKey()` and the `before` diagnostic set returned by `openLedger()`.
- Keep `commit()`'s global rule as “no new errors”; add a close-specific comparison rather than imposing diagnostic equality on all verbs.

- [x] **Step 1: Write failing close tests** for E106, E110, and an unrelated baseline error removed by the candidate; assert exit 3, diagnostic code/id, and unchanged file. Add the exception test: selected issue's sole E102 may disappear when it is intentionally closed with explicit criteria.
- [x] **Step 2: Run focused tests and confirm failures** with `bun test src/round18.test.ts`.
- [x] **Step 3: Add close-specific error-loss validation**: compare baseline and candidate error multiplicities by diagnostic identity; refuse if any baseline error is missing except E102 whose `id` equals the exact selected ID. Do this before commit/write, with remediation guidance for E106 (`rename` or `sync --titles`) and structural errors (`check`).
- [x] **Step 4: Write failing sync tests** for unrelated summary/body strings: bare `sync --titles` refuses; `--prefer body` alone refuses; `--prefer body --move-progress` preserves the old summary in the body; `--prefer body --drop-progress` replaces it; `--prefer table` preserves the summary and updates the body title; all mutating modes report old/new text in stderr in dry-run and real runs. Keep the existing W260 scenarios.
- [x] **Step 5: Run focused tests and confirm sync failures** with `bun test src/round18.test.ts`.
- [x] **Step 6: Implement explicit sync consent and reporting**. For unrelated text, permit table preference directly; require body preference plus move/drop option. Continue the current progress-specific W260 guard. Report each changed summary as `updated #N: "old" → "new"` to stderr for dry-run and real writes.
- [x] **Step 7: Write failing split test** for two IDs with bodies and identical summary; assert split succeeds, W212 is present after split, and stderr identifies both IDs and recommends `rename`. Retain the existing missing-body E102 behavior.
- [x] **Step 8: Implement split warning** by comparing pre/post W212 diagnostics and identifying newly duplicated IDs; do not alter the existing E102 tolerance.
- [x] **Step 9: Run focused tests and confirm Task 2 passes**.

### Task 3: Make reopen preserve criterion meaning (#87)

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/ledger-check.ts`
- Test: `src/round18.test.ts`

**Interfaces:**
- `bodySkeleton(id, title, criteria)` stays unchanged; construct labeled body content in `cmdReopen` when status provenance requires it.
- Keep archive extraction and removal behavior intact.

- [x] **Step 1: Write failing tests** for: `已修` with real criterion; rationale statuses (`决定不改`, `延后`, `范围外`, `不是缺陷`, `撤回`, `并入`, `未分类`) putting the cell under `关闭理由`; no-criteria reopen succeeding with explicit warning and W261; archive criterion A differing from table B restoring A and preserving B under `关闭时判据`; commit hash movement not creating W202; byte-identical round trip when archived criterion and table value agree.
- [x] **Step 2: Run focused tests and confirm failures** with `bun test src/round18.test.ts`.
- [x] **Step 3: Implement status-aware body reconstruction**: with no archive, only `已修` puts non-empty cell text under `验收判据`; other closed states use `关闭理由`. For an archive, restore it as-is and append `关闭时判据` only when B is not already present. Empty B remains empty and emits a missing-criteria warning.
- [x] **Step 4: Make W202 ignore hashes inside inline code spans** while preserving existing behavior for hashes outside code spans and closed-table verification; add a focused direct checker test for `a1b2c3d` in and outside code spans.
- [x] **Step 5: Run focused tests and confirm Task 3 passes**, including existing close/reopen byte-roundtrip tests.

### Task 4: Unify batch read JSON and text summaries (#88, #94, #95)

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/ledger-read.ts`
- Test: `src/round18.test.ts`

**Interfaces:**
- Extend `diagnosticsField` to accept `errors: Diagnostic[]` and `warnings: Diagnostic[]` and return required `{ diagnostics: { errors: ..., warnings: ... } }`.
- `summaryLine` consumes `openStatusCounts(rows.open)` derived from the parsed open table; this avoids adding a new count field to JSON.

- [x] **Step 1: Write failing JSON tests** for clean, warning-only, error-only, and mixed ledgers across `list`, `counts`, and `show`; assert stable diagnostics arrays and equality with `check --json` by code/line/id. Assert `check --json` and `counts --json` cite the same rows as `list --json`.
- [x] **Step 2: Run focused tests and confirm failures** with `bun test src/round18.test.ts`.
- [x] **Step 3: Implement stable JSON fields** for list/counts/show and expose `citedRows` from the same parsed snapshot on check/counts/list (omit only when empty). Keep `check`'s established top-level errors/warnings.
- [x] **Step 4: Write failing filter/count tests** for priority present only in other table, priority present in both, invalid priority, undeclared present status, undeclared absent status, and an open-status summary with one/two undeclared values. Include an overlapping invalid ledger and assert raw status counts plus structural errors remain visible.
- [x] **Step 5: Run focused tests and confirm filter/count failures** with `bun test src/round18.test.ts`.
- [x] **Step 6: Implement cross-table priority note**, and warning on filtering by an undeclared-but-present status. Format text status summaries to include every present open status; preserve raw `byStatus` values and existing structural overlap diagnostics.
- [x] **Step 7: Run focused tests and confirm Task 4 passes**.

### Task 5: Report skipped Git commit verification (#89)

**Files:**
- Modify: `src/ledger-check.ts`
- Modify: `src/cli.ts`
- Test: `src/round18.test.ts`

**Interfaces:**
- Add W263 diagnostic on check when `--verify-commits` cannot identify a Git worktree; W240 remains “commit not found”.
- Keep `Options.verifyCommits` and check exit code rules; W263 fails `--strict` as an ordinary warning.

- [x] **Step 1: Write failing tests** for a clean non-Git temp directory (normal check exit 0 + W263; strict exit 3 + W263), a non-Git directory with a ledger error (exit 3 and both result classes), and a Git repo with missing commit (W240, no W263).
- [x] **Step 2: Run focused tests and confirm failures** with `bun test src/round18.test.ts`.
- [x] **Step 3: Detect “not a Git worktree” distinctly** from `git cat-file` failures; add W263 and return normal diagnostics rather than throwing. Keep unexpected Git failures as explicit I/O/system errors.
- [x] **Step 4: Run focused tests and confirm Task 5 passes**.

### Task 6: Update normative docs and verify the complete change

**Files:**
- Modify: `docs/spec.md`
- Modify: `skills/issuemd/SKILL.md`
- Modify: `docs/handoff/handoff.md`

- [x] **Step 1: Update `docs/spec.md`** for W262/W263, reserved rows under malformed comments, title delimiter refusal, close error-loss rules, sync consent, split W212 warning, reopen criterion provenance, stable JSON diagnostics/citedRows, count formatting, and verification exit behavior.
- [x] **Step 2: Update `skills/issuemd/SKILL.md` and `README.md`** with the user-facing command behavior for these changes.
- [x] **Step 3: Run `npm run typecheck && npm test`**; expected all tests pass. If a failure occurs, diagnose before proceeding.
- [x] **Step 4: Review full diff for scope and data-safety violations**; do not write the external ledger.
- [x] **Step 5: Run read-only CLI verification**: canonical fixture and `TEMPLATE.md` remain clean; test `cafe-shaped.md` and `orca-shaped.md` retain their documented old-format results; run `check` and `adopt --dry-run` on all three real ledgers. If current files differ from the previous handoff's recorded warning counts, record current values as newer external data; do not edit them or require them to match stale counts.
- [x] **Step 6: Obtain independent TypeScript code review** and fix any confirmed important findings with regression tests.
- [x] **Step 7: Commit the verified change, fast-forward merge to local `main`, then run `npm run build`** and confirm `dist/bin/issuemd.js` remains executable (755). Never push or publish.
- [x] **Step 8: Update handoff** with issue disposition, tests, current ledger baselines, branch/merge state, remaining user decisions (push/release), and next actions. Describe the base relatively; do not write a fixed HEAD hash.
