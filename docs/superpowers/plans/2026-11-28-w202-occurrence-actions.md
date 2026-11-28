# W202 occurrence repair implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Show every W202 hash location in one check and provide one reviewed sync operation that safely wraps eligible literal hashes.

**Architecture:** Add a shared source-span scanner for hash tokens, but keep the W202 reporting classification separate from the legacy Git-verification token set. Reuse parsed body/archive ranges to assign ids and protect frozen payloads. Implement `sync --fix-hashes` as insertion-only edits through the existing candidate validator and atomic writer.

**Tech Stack:** TypeScript, Bun test runner, existing `checkParsedLedger()` and `commit()` pipeline.

**Spec:** `docs/superpowers/specs/2026-11-28-w202-occurrence-actions-design.md`

## Global Constraints

- W202 eligibility preserves the existing hash pattern, UUID exclusion, and all-numeric 40-character exception, with list-relative fences newly treated as code for W202.
- `--verify-commits` preserves its current token eligibility and first-pinned anchor selection, including archive payloads and list-relative fences.
- W202 gets one diagnostic per occurrence with 1-based absolute line and Unicode-scalar column; full issue id is present only for a valid open-body owner.
- Repair skips every parsed table cell, fences, existing code spans, syntax-bearing link/HTML spans, managed headings, closed criteria cells, and all archive headings/payloads.
- Malformed/ambiguous v2 archive H3 subtrees are read-only to repair; skipped hits are reported.
- Edits only insert backticks around selected spans. Preserve line endings, BOM, final-newline state, unrelated text, and pre-existing structural diagnostics.
- Do not modify external dogfooding ledgers. Do not commit or push.

## Review Focus

- The same token in a closed criteria cell and an open body produces W202 only for the open-body occurrence, while W240 remains deduplicated and keeps its original anchor rule; pin in Task 1.
- Two occurrences on one line have distinct columns, and text output does not truncate W202; pin in Task 1.
- An archive payload suppresses W202 but still participates in optional W240; ordinary text after the v2 end marker remains W202-eligible; pin in Task 2.
- A table cell containing a W202 token is reported but never auto-wrapped, preserving cited ids; pin in Task 3.
- Link destinations, unmatched backticks, malformed archives, and list-relative fences cannot be broken by repair; pin in Task 3.

---

### Task 1: Preserve occurrences and verification tokens separately

**Files:**
- Create: `src/hash-scan.ts`
- Modify: `src/ledger-check.ts`
- Modify: `src/ledger.ts`
- Modify: `src/cli.ts`
- Test: `src/round24.test.ts`

**Interfaces:**
- Produce `hashSpans(text: string): { hash: string; start: number; end: number }[]` in `src/hash-scan.ts`; offsets are UTF-16 code-unit offsets into the exact source line.
- `checkHashes()` derives W202 occurrences and the legacy unique verification map from the same spans but applies their independent classification rules.

- [x] **Step 1: Write failing occurrence and W240 tests**

  Cover three repeated occurrences across two open body lines (each warning has line, scalar column, and body id); two same-line copies (different columns); one token shared by closed criteria and open prose (W202 on prose only); hashes inside ordinary and list-relative fences (no W202); and `--verify-commits` still emits one W240/W263 using the prior anchor/eligibility behavior.

- [x] **Step 2: Run the focused tests and confirm failure**

  Run: `bun test src/round24.test.ts`
  Expected: current W202 emits only the first location per hash, has no column/id, and text check caps W202 examples at three.

- [x] **Step 3: Implement shared hash spans and occurrence diagnostics**

  Add `hashSpans()` with UUID and numeric-token filtering, and add optional `column` to `Diagnostic` in `ledger.ts`. In `ledger-check.ts`, create W202 per pinned occurrence, add open-body id from full parsed block id only when it belongs to the open table and not the closed table, and keep a separate unique map for Git verification with the exact previous first-pinned/first-scanned anchor semantics. In `cmdCheck`, print `Lline:column`, print all W202 diagnostics, and retain the display cap for other codes.

- [x] **Step 4: Run focused tests and confirm pass**

  Run: `bun test src/round24.test.ts`
  Expected: all locations appear once, W202 text is complete, and W240/W263 match the legacy contract.

### Task 2: Exclude frozen archive payloads from W202

**Files:**
- Modify: `src/ledger-check.ts`
- Test: `src/round24.test.ts`

**Interfaces:**
- Consume `hashSpans()` from Task 1.
- Use `archivePayloadRange()` for every recognized archive H3; W240 continues to use the legacy verification set even when W202 suppresses an archive payload.

- [x] **Step 1: Write failing archive tests**

  Cover a valid v2 archive payload, prose immediately after its end marker, a legacy archive, duplicate archives, malformed v2 boundaries, and an archive-only missing commit under `--verify-commits`.

- [x] **Step 2: Run the focused tests and confirm failure**

  Run: `bun test src/round24.test.ts`
  Expected: W202 currently fires inside valid frozen payloads.

- [x] **Step 3: Separate archive W202 visibility from verification collection**

  Suppress W202 only for the exact valid archive payload range. Keep headings and text after the valid end marker eligible. For malformed v2 archives, retain W202 but pass their entire managed H3 subtree as non-repairable context for Task 3.

- [x] **Step 4: Run focused tests and confirm pass**

  Run: `bun test src/round24.test.ts`
  Expected: archive W202 behavior matches the spec; W240 still verifies archive-only tokens once.

### Task 3: Add safe `sync --fix-hashes`

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/ledger-edit.ts` or `src/hash-scan.ts` for repair-span context
- Test: `src/round24.test.ts`

**Interfaces:**
- Consume shared hash spans and W202 classification from Tasks 1–2.
- Produce a sync mode that returns insertion-only candidate lines plus changed/skipped source locations.

- [x] **Step 1: Write failing repair tests**

  Verify one invocation wraps every eligible occurrence in open bodies and ordinary appendix text. Verify preview diff can be applied with `patch` and matches the real write for BOM + CRLF + no final newline. Add skipped-hit assertions for parsed table/cited cells, link destinations, raw HTML attributes, unmatched code delimiters, and malformed archive subtrees; valid archives and list-relative fences produce no repairable W202. Verify existing inline code, UUIDs, numeric dates, and closed criteria remain unchanged; skipped reasons name source lines. Verify no-op and post-write snapshot receipt.

- [x] **Step 2: Run focused tests and confirm failure**

  Run: `bun test src/round24.test.ts`
  Expected: `--fix-hashes` is unknown or not implemented, and protected contexts are not classified.

- [x] **Step 3: Implement sync repair and fail-closed eligibility**

  Add `--fix-hashes` to the sync options and dispatch. Identify eligible open-body content and ordinary appendix text. Exclude all parsed tables, fences, inline code, link destinations, raw HTML attributes, managed headings, archive ranges, and malformed archive subtrees. Apply replacements from right to left by source offset, through `commit()` and the existing candidate gate. Report edited and skipped locations; preserve exact bytes outside inserted backticks.

- [x] **Step 4: Run focused tests and confirm pass**

  Run: `bun test src/round24.test.ts`
  Expected: all W202 hits in the safe scope clear in one pass, unsafe hits remain with an explicit reason, and patch/write bytes match.

### Task 4: Document and verify

**Files:**
- Modify: `docs/spec.md`
- Modify: `skills/issuemd/SKILL.md`
- Modify: `docs/handoff/handoff.md`
- Test: full existing suite

- [x] **Step 1: Document occurrence locations, W240 preservation, archive behavior, and sync scope**

  State which W202 hits are repairable, which remain for `rename`/manual editing, and why W202 wrapping may increase W201 size.

- [x] **Step 2: Run focused tests**

  Run: `bun test src/round24.test.ts`
  Expected: all round 24 tests pass.

- [x] **Step 3: Run full verification**

  Run: `npm run typecheck && npm test`
  Expected: typecheck succeeds and the full suite passes.

- [x] **Step 4: Rebuild and check external ledgers read-only**

  Run: `npm run build`, then check dogfooding, cafe, and Orca archive files without writing them; compare SHA-256 before and after.
  Expected: build succeeds, external bytes are unchanged, and warning categories/counts/snapshots are recorded.

- [x] **Step 5: Update handoff without pinning HEAD**

  Record branch, verification, decisions, and remaining issues. The handoff commit itself changes HEAD, so use commands for locating the current revision instead of a fixed hash.
