# Move Evidence Implementation Plan

**Reviewed design:** `docs/superpowers/specs/2026-11-28-move-evidence-design.md`.

1. In `src/move-evidence.test.ts` use temporary ledger fixtures to prove that moving an explicitly labeled block clears an active W201, preserves raw copied lines, leaves the canonical criteria and neighboring text intact, and refuses duplicate labels, unsafe appendices and final-visible references. Assert dry-run and stale snapshot behavior.
2. In `src/cli.ts` add `body --move-evidence LABEL`, with one exact owning row and visible body, and route it through `commit()`. In a dedicated module build the candidate with an explicit appendix heading, deterministic unique anchor, fenced literal source and a body link. Validate payload lines, criteria/W268, reference reservations and existing archive identities before write.
3. Run focused and full tests and review TypeScript and the write behavior independently. Document the active-body limits and CLI usage. Integrate only with a green suite.
