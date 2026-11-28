# Criteria Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make ambiguous acceptance-criteria boundaries visible and prevent close from discarding grouped or supplemental criteria without explicit review.

**Architecture:** Keep the existing Markdown label grammar and flat table-cell `criteria` field. Add a focused W268 detector for sentence-shaped standalone bold labels after canonical criteria, add source-addressed structured criteria blocks to JSON, and make close refuse ambiguous automatic promotion. Reuse existing criteria-alias eligibility for write-time advice.

**Tech Stack:** TypeScript, Bun test runner, existing `run()` CLI tests.

**Spec:** `docs/superpowers/specs/2026-11-27-criteria-integrity-design.md`

## Global Constraints

- Do not change the closed table schema or reinterpret historical flat criteria values.
- W268 applies to a standalone bold boundary ending in sentence punctuation after at least one criterion list item under canonical criteria; preserve the current label grammar.
- Closed HTML comments and fences do not create label boundaries; raw comment lines remain in body output.
- Explicit `--criteria` and `--no-criteria` are reviewed table-value choices; `--keep-body` retains the source body.
- `criteriaBlocks.line` is a 1-based absolute ledger line; each `lines` array contains its label line and owned content, with trailing blank lines trimmed.
- Do not write to either external dogfooding ledger.
- Do not commit or push during this implementation.

## Review Focus

- A fully bold sentence between criteria items must produce W268 and block implicit close; pin in Task 1 and Task 2.
- A standalone custom label ending in punctuation remains a label but may produce W268 after a criteria list; an explicit colon form does not; pin in Task 1 and Task 2.
- A label-shaped line inside a closed multiline HTML comment must not cut a criteria block; pin in Task 1 and Task 3.
- Repeated canonical blocks and non-empty later aliases must remain separately visible and require explicit close review; pin in Task 2 and Task 3.
- A recognized alias with a canonical label already present must not be offered an inapplicable `sync --criteria-labels`; pin in Task 4.

---

### Task 1: Detect sentence-shaped criteria boundaries

**Files:**
- Modify: `src/ledger-edit.ts`
- Modify: `src/ledger-check.ts`
- Test: `src/round23.test.ts`

**Interfaces:**
- Produce `criteriaBoundaryHints(lines: string[], offset?: number, fenced?: boolean[]): { line: number; label: string }[]` in `ledger-edit.ts`.
- The boundary helper reports standalone bold lines ending in sentence punctuation after a canonical `验收判据` label and at least one list item. It must see the label boundary itself, including unspaced CJK sentences. Shared comment visibility excludes hidden lines.

- [x] **Step 1: Write failing W268 tests**

  Add tests showing a fully bold sentence between criteria items produces W268 at the sentence line; a compact punctuation label remains a boundary; a matching line inside a closed multiline comment or fence does not create a label or W268; a bold-leading phrase with text outside `**` does not produce W268.

- [x] **Step 2: Run the focused tests and confirm failure**

  Run: `bun test src/round23.test.ts`
  Expected: new W268 assertions fail because no detector or diagnostic exists.

- [x] **Step 3: Implement the shared detector and W268 warning**

  Add `criteriaBoundaryHints()` in `ledger-edit.ts` using the existing fence scanner plus shared HTML comment visibility. Call it for each open body in `ledger-check.ts` and emit W268 with issue id, absolute source line, and bold text. Make label discovery and criteria text extraction ignore comment contents while preserving raw body lines.

- [x] **Step 4: Run focused tests and confirm pass**

  Run: `bun test src/round23.test.ts`
  Expected: all new detector cases pass and existing behavior is unchanged.

### Task 2: Guard destructive close

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/ledger-edit.ts`
- Modify: `src/ledger-check.ts`
- Test: `src/round23.test.ts`

**Interfaces:**
- Consume W268 from Task 1.
- Produce `criteriaOccurrences(lines: string[], offset?: number, fenced?: boolean[]): { line: number; label: string; kind: "canonical" | "supplement"; lines: string[]; text: string }[]`. It includes every canonical occurrence and non-empty recognized supplements after the first canonical occurrence; closed comments and fences do not create occurrences.
- Use `criteriaOccurrences()` for W264 and the close guard. Make W206 for duplicate canonical labels report every source line.

- [x] **Step 1: Write failing close tests**

  Verify implicit close and `--criteria-from-body` return exit 2 without changing bytes for W268, multiple non-empty canonical blocks, and non-empty later supplements; stderr names every relevant line and offers reviewed `--criteria`, `--no-criteria`, or `--keep-body`. Verify those explicit paths work. Empty/comment-only supplements do not block close. Assert that `criteriaOccurrences()` retains every canonical occurrence and every eligible later supplement in order.

- [x] **Step 2: Run the focused tests and confirm failure**

  Run: `bun test src/round23.test.ts`
  Expected: close currently succeeds and removes the body for W268 and repeated canonical blocks; occurrence export is absent; later aliases may already be refused, but not consistently across all occurrences or empty/comment-only blocks.

- [x] **Step 3: Add the close refusal**

  Implement `criteriaOccurrences()` with visible block content; use it to emit W264 for every non-empty later supplement and W206 with every canonical label line. Refuse automatic promotion when the body is deleted and W268, multiple non-empty canonical blocks, or later supplements exist. Let explicit criteria/no-criteria and keep-body retain their documented meanings.

- [x] **Step 4: Run the focused tests and confirm pass**

  Run: `bun test src/round23.test.ts`
  Expected: ambiguous body promotion is blocked, while explicit reviewed paths work.

### Task 3: Expose source-preserving criteria blocks

**Files:**
- Modify: `src/ledger-edit.ts`
- Modify: `src/ledger-read.ts`
- Modify: `src/cli.ts` if JSON projection requires it
- Test: `src/round23.test.ts`

**Interfaces:**
- Consume `criteriaOccurrences()` from Task 2.
- Project `criteriaOccurrences()` into top-level `criteriaBlocks` on `show --json` and each `list --json --with-body` issue. Each entry is `{ line, label, kind, lines }.
- Closed rows derive blocks from the resolved unique archive payload with absolute source line offsets.

- [x] **Step 1: Write failing JSON parity tests**

  Test repeated canonical blocks, a later recognized supplement, a literal `；` in one item, a fenced line, a comment-only block, and a closed archive. Assert 1-based absolute lines, label-plus-content lines with trailing blanks trimmed, occurrence ordering, source-content preservation, and equality between `show` and batch list for the same resolved body owner.

- [x] **Step 2: Run the focused tests and confirm failure**

  Run: `bun test src/round23.test.ts`
  Expected: `criteriaBlocks` is absent.

- [x] **Step 3: Implement structured extraction and projection**

  Extract canonical and recognized later supplement occurrences using visible label boundaries; preserve raw lines and absolute locations. Use the resolved archive payload and owner for closed rows. Leave flat `criteria` and named `labels` unchanged.

- [x] **Step 4: Run focused tests and confirm pass**

  Run: `bun test src/round23.test.ts`
  Expected: single-read and batch JSON expose identical source-preserving blocks.

### Task 4: Improve nearby-label repair guidance

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/ledger-edit.ts` only if a shared eligibility result is needed
- Modify: `skills/issuemd/SKILL.md`
- Test: `src/round23.test.ts`

**Interfaces:**
- Reuse the same criteria-alias eligibility rule as `sync --criteria-labels`.
- Guidance must identify the alias and source line; recommend sync only when sync would change it. Otherwise direct the user to review/resolve the ambiguity manually.

- [x] **Step 1: Write failing write-guidance tests**

  Verify `new` and `body` report the line-addressed repair command for one eligible alias, do not recommend sync when canonical criteria or competing aliases exist, and explain the body-label/table-column mapping.

- [x] **Step 2: Run the focused tests and confirm failure**

  Run: `bun test src/round23.test.ts`
  Expected: successful writes currently omit the actionable alias guidance.

- [x] **Step 3: Add eligibility-aware guidance and line-numbered sync receipts**

  Share the existing alias selection rule; add source line numbers to dry-run and successful sync change reports without changing content.

- [x] **Step 4: Update the skill and verify focused tests**

  Document `判据` table column → `**验收判据**` body label, when sync is eligible, and the manual fallback. Run: `bun test src/round23.test.ts`.
  Expected: all write, sync, and compatibility assertions pass.

### Task 5: Update the contract and run full verification

**Files:**
- Modify: `docs/spec.md`
- Modify: `README.md` if the command behavior is described there
- Modify: `docs/handoff/handoff.md`
- Test: full existing suite

- [x] **Step 1: Document W268, structured criteria blocks, close guard, and write-time alias guidance**

  Keep the flat closed-cell limitation explicit: a literal semicolon inside a criterion cannot be reconstructed from historical cells; `criteriaBlocks` and `--keep-body` retain source structure.

- [x] **Step 2: Run focused tests**

  Run: `bun test src/round23.test.ts`
  Expected: all round 23 tests pass.

- [x] **Step 3: Run full verification**

  Run: `npm run typecheck && npm test`
  Expected: typecheck succeeds and the full suite passes.

- [x] **Step 4: Rebuild and recheck external ledgers read-only**

  Run: `npm run build`, then `issuemd check --json` on dogfooding, cafe, and Orca archive ledgers.
  Expected: build succeeds; external ledger bytes remain unchanged; report any new warnings with counts and snapshots.

- [x] **Step 5: Update handoff with decisions, verification, branch state, and remaining review items**

  Do not hard-code the resulting HEAD hash; the handoff update itself changes it.
