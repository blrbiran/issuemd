# Criteria Boundary and Append Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-28-criteria-boundaries-and-append-design.md` (independently reviewed and revised).

**Goal:** Preserve read compatibility where ownership is ambiguous, guard automatic close, and keep retest appends from changing acceptance criteria.

1. Add failing CLI cases in `src/criteria-boundaries.test.ts` for short and sentence-like labels followed by continued list items, ambiguous prose followed by a peer list/fence, and safe review headings in both qualified forms. Change `labelBlock` in `src/ledger-edit.ts` to expose `end`, `boundary`, and ambiguity information from the same ownership decision. Use it in `criteriaBoundaryHints` and W268. Add a qualified-label grammar for the colon-delimited form and keep real nested continuations. Update the old W268 test that expected a warning even though no continuation exists.
2. Add failing append tests for canonical and supplemental labels at the start and in the middle, changed list/fence ownership, literal examples, and a collision with an existing `复测记录` label. Implement a whole-input label check and compare candidate criteria and W268 information before writing an existing body. Use the first available visible retest label when wrapping unlabeled appends at the end of criteria. Keep missing-body creation behavior.
3. Add failing tests for exact repeated content under a different criteria label, a one-item subset, and differently structured text with the same one-line projection. Compare source content after removing label syntax and outer blanks. Preserve all JSON occurrences and require review for different or ambiguous content.
4. Document the changes in `docs/spec.md` and `skills/issuemd/SKILL.md`. Run the focused suite, typecheck, full tests and build. Independently review code and regression coverage before integration.
