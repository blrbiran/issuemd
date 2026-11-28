# Ledger Search and Diagnostics Implementation Plan

**Design:** `docs/superpowers/specs/2026-11-28-ledger-search-and-diagnostics-design.md` (independently reviewed).

1. W270. Add CLI regressions for a trailing fence in the last issue and in an appendix, plus closed fences, list outdent and HTML examples. Make `scan.ts` provide the final opener position as well as the mask, reuse it from `endsInFence`, and emit a strict-failing warning from `ledger-check.ts`. Keep temporary fixtures confined to tests.
2. W271 and find. Create a dedicated `ledger-search.ts` source-range reader and use it from check and new. Build row ownership from symbolic spans, never expand ranges to assign ownership. Mask literal contexts for reference classification. Reuse parsed rows and archive lookup from one ledger read in `find`. Exercise source order, grouped owners, hidden/malformed archives and no-match JSON, then verify exact `new` skipping and candidate rejection in both dry-run and real writes.
3. W202 and W260. Add tests for hash repair summary and opt-in refusal before any write, plus quoted progress cues and an actionable no-op title sync. Reuse candidate validation for repair counts. Preserve existing flags and structured diagnostics. Scope `--require-complete` to `--fix-hashes`.
4. Run focused tests before and after implementation, independently review the source changes, update the user-facing command reference, run the full suite and build, then verify `main` after integration.
