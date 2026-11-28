# Hidden Content Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent automatic close from dropping overlooked criteria and reopen from replacing a hidden archive with a skeleton.

**Architecture:** Reuse W264 and the existing close gate for additional criteria candidates. Record masked v2/v3 candidates separately in the shared archive inventory and use that information in diagnostics and command fallbacks.

**Tech Stack:** TypeScript, Bun tests, Node CLI.

**Spec:** `docs/superpowers/specs/2026-11-28-hidden-content-fail-closed-design.md`

## Global Constraints

Use temporary fixtures for write tests. Preserve source bytes on refusal and keep the three external ledgers read-only. Keep commits and publication separate from implementation.

## Review Focus

- Reopened bodies can include `关闭时判据` as historical evidence. It remains outside W264.
- A label containing only an HTML comment remains empty for the guard.
- Hidden archive-shaped text can be legitimate visible archive payload. Verify it does not create a candidate.
- A hidden candidate beside a visible archive must never become the payload or deletion target.
- An isolated H3 or marker inside a literal block must not become an archive candidate.

### Task 1: Report and guard omitted criteria

**Files:** `src/ledger-edit.ts`, `src/ledger-check.ts`, `src/cli.ts`, `src/content-integrity.test.ts`, `docs/spec.md`.

**Interfaces:** The existing `criteriaOccurrencesFromLabelBlocks(blocks: LabelBlock[], offset?: number): CriteriaOccurrence[]` supplies W264 and the structured read view. Preserve `isCriteriaAlias(label: string): boolean` as the narrower auto-rename policy.

- [x] Add tests for the reported labels after canonical criteria. `check --json` includes `code: "W264", id: "2"` and the heading line, strict exits 3, both automatic close forms exit 2, and source bytes match the original. Add controls for an earlier alias, comment-only block, and `关闭时判据`.
- [x] Run `bun test src/content-integrity.test.ts` and confirm the omission causes failure.
- [x] Expand the supplement predicate and clarify the close refusal. Preserve explicit override and archive behavior. Document the distinction between detection and auto-rename.
- [x] Rerun the focused file and `src/round23.test.ts src/round25.test.ts`.

### Task 2: Diagnose masked archives and refuse unsafe fallback

**Files:** `src/ledger.ts`, `src/ledger-check.ts`, `src/cli.ts`, `src/content-integrity.test.ts`, `src/round25.test.ts`, `docs/spec.md`.

**Interfaces:** Add `ArchiveInventory.hiddenArchives` with records containing `id`, `line`, and `mask`. `hiddenArchiveRefusal(inventory: ArchiveInventory, id: string)` returns the existing `ArchivePruneRefusal` shape with candidate lines, or `undefined`. Use W269 for hidden framing.

- [x] Test fence, comment, and raw HTML wrappers around an archive. Assert `W269` with the target ID and line, strict exit 3, candidate-specific `show`, `prune`, and `reopen` refusal, and unchanged source bytes. Cover `close --keep-body` on an open row with a hidden-only archive. Cover the three archive controls in Review Focus.
- [x] Run `bun test src/content-integrity.test.ts src/round25.test.ts` and confirm failure in the absent-archive fallback.
- [x] Scan masked H3/version/start prefixes within visible appendices while excluding verified payload ranges. Emit W269 and use the hidden data only on the no-visible-record path.
- [x] Rerun the focused tests and `src/review-regression.test.ts`. Run `npm run typecheck && npm test` and `npm run build` after independent review.

### Review and verification

- Supplemental criteria preceded by an inline comment use the visibility-aware block text for the nonempty check.
- A markerless legacy range cannot absorb a masked candidate. Legacy reopen refuses when it would move that candidate, and `show --body-only` refuses if a sibling archive would stand in for the masked target.
- The existing raw HTML fixture expectations now distinguish a masked archive from an absent archive. Both cases still refuse pruning.
- Typecheck and build passed. The complete suite passed 875 tests with zero failures. The additional appendix scan participates in several existing inventory calls. A per-command cache remains a separate optimization.
