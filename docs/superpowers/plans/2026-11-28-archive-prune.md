# Archive prune implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a two-step, exact-id `issuemd prune FILE ID` that removes one verified v2 kept-body archive without touching the closed row, its criteria, other archives, or appendix prose.

**Architecture:** Locate a single true visible appendix H3 with an exact v2 envelope, refuse every ambiguous ownership/boundary, build an insertion-free candidate by removing exactly the H3-through-end-marker span, then validate that the baseline error multiset and every non-target archive payload are unchanged before using the existing atomic write gate.

**Tech Stack:** TypeScript, Bun tests, existing `parseLedger()`, `archivePayloadRange()`, `commit()` and `readRaw()`.

**Spec:** `docs/superpowers/specs/2026-11-28-archive-prune-design.md`

## Global Constraints

- Real pruning requires `--confirm --if-unchanged S` from a prior `--dry-run` of the same id; no flags/both modes/confirm without snapshot exit `2`.
- Target must be one closed singleton row with no open, range, or unreadable owner of the same id.
- Target must be one true visible `## 附录` H3, outside fences and raw HTML blocks, with exactly one v2 version line, one exact start marker, and exactly one eligible end marker; otherwise exit `2` (zero archives exit `1`).
- Only the H3 heading through its end marker is removed; all other bytes, including neighboring blank lines and the appendix heading, are preserved.
- Baseline check errors must keep the same code/id/message/expected/actual multiset (ignoring line shifts), and non-target archive payloads must be byte-identical.
- Newline-terminated files keep surviving blank lines; an unterminated file at EOF may drop only blank lines that become terminal.
- Do not modify external ledgers; do not commit or push.

## Review Focus

- A complete v2-looking archive inside `<pre>` or a fence must not be a target; pin in Task 1.
- Multiple visible end markers or marker-like indented code must fail closed; pin in Task 1.
- An open range `1–3` or unreadable row holding `2` blocks pruning closed `2`; pin in Task 1 and Task 2.
- Preview and apply must produce identical bytes and preserve neighboring text; pin in Task 2.
- Existing legacy, malformed, or duplicate archives must be refused, not guessed; pin in Task 1.

---

### Task 1: Strict archive locator and ownership

**Files:**
- Modify: `src/ledger.ts`
- Test: `src/round25.test.ts`

**Interfaces:**
- Produce `prunableArchive(ledger, id)` returning either `{ section, range }` or a typed refusal `{ code: 1 | 2; reason: string; lines: number[] }`.
- The locator uses fence + raw-HTML-block visibility, exact standalone `KEPT_BODY_VERSION`/`KEPT_BODY_START`/`KEPT_BODY_END` matches, duplicate detection, and full-id ownership checks.

- [x] **Step 1: Write failing locator tests**

  Cover a valid unique v2 archive; zero archives; duplicate appendices; duplicate archive headings; legacy markerless/versionless archives; malformed version/start/end order; two visible end markers; an end marker indented inside code; a complete v2 example inside `<pre>`; closed singleton plus open `1–3`; and an unreadable row naming the id.

- [x] **Step 2: Run the tests and confirm failure**

  Run: `bun test src/round25.test.ts`
  Expected: locator/refusal export is missing.

- [x] **Step 3: Implement the locator**

  Add a raw-HTML block helper next to the existing HTML-tag set, then implement `prunableArchive()` in `ledger.ts`. Position rows at the first duplicate or the exact failure line; do not choose among candidates.

- [x] **Step 4: Run focused tests and confirm pass**

  Run: `bun test src/round25.test.ts`
  Expected: every ambiguity refuses with the documented exit code and lines.

### Task 2: The `prune` command

**Files:**
- Modify: `src/cli.ts`
- Test: `src/round25.test.ts`

**Interfaces:**
- Consume `prunableArchive()` from Task 1 and `readRaw()`-based `loadWritable()`.
- Register `prune` usage/options; implement `cmdPrune()`.

- [x] **Step 1: Write failing command tests**

  Verify flag combinations; preview/apply parity; stale snapshot exit `4`; multi-id/range refusal; closed-row and criteria preservation; neighbor prose and blank lines; non-target archive bytes; error-multiset guard; W250/W201 counts after pruning; BOM+CRLF/no-final-newline preview patched through `patch(1)` equals applied bytes; newline-terminated trailing blanks retained; unterminated EOF only drops new terminal blanks.

- [x] **Step 2: Run the tests and confirm failure**

  Run: `bun test src/round25.test.ts`
  Expected: `prune` is an unknown command.

- [x] **Step 3: Implement `cmdPrune()`**

  Validate flags, locate the target, build the candidate by removing only the located span, enforce the baseline-error multiset and non-target archive invariants, then call `commit()` with a `pruned #ID` receipt. Ensure dry-run prints the diff and snapshot; apply requires confirmation and the snapshot.

- [x] **Step 4: Run focused tests and confirm pass**

  Run: `bun test src/round25.test.ts`
  Expected: valid target prunes exactly once; every unsafe case refuses without bytes changing.

### Task 3: Document and verify

**Files:**
- Modify: `docs/spec.md`
- Modify: `skills/issuemd/SKILL.md`
- Modify: `README.md`
- Modify: `docs/handoff/handoff.md`
- Test: full suite

- [x] **Step 1: Document the two-step workflow and refusals**

  Update the command list and explain that v1 prunes only a unique valid v2 archive; legacy/duplicate/malformed/ambiguous cases remain manual.

- [x] **Step 2: Run focused tests**

  Run: `bun test src/round25.test.ts`
  Expected: all pass.

- [x] **Step 3: Run full verification**

  Run: `npm run typecheck && npm test`
  Expected: typecheck and full suite pass.

- [x] **Step 4: Build and recheck external ledgers read-only**

  Run: `npm run build`, check dogfooding/cafe/Orca with SHA-256 before and after.
  Expected: build succeeds; external bytes unchanged; record counts and snapshots.

- [x] **Step 5: Update handoff without pinning HEAD**

  Record decisions, verification, and any deferred archive-policy questions.
