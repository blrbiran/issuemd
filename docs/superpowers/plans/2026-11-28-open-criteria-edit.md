# Open Issue Criteria Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit open acceptance criteria safely and require explicit close intent for supplied table criteria.

**Architecture:** Use the shared body parser for candidate spans, verify the candidate before the standard transaction, and resolve the current row state before applying the close guard.

**Tech Stack:** TypeScript, Node CLI, Bun tests.

**Spec:** `docs/superpowers/specs/2026-11-28-open-criteria-edit-design.md`

## Global Constraints

- Preserve other ledger bytes, status and metadata. Keep the external ledgers read-only.
- Use a nonempty single line of Markdown for the new command. Keep closed-table encoding and correction behavior.

## Review Focus

- Comments adjacent to or within a label cannot be silently removed.
- Explicitly numbered lists can be replaced. Unlabeled prose and competing label aliases require review.
- Dry-run, stale snapshots, and repeated applications use normal transaction semantics.
- Help and error recovery must show the now-required explicit status.

### Task 1: Close guard and open edit

- [x] Add `src/open-criteria.test.ts` CLI tests for the exact #147 invocation, explicit close, open edit with literal pipe and backslash, insertion, competing labels, comments, multiline lists, separators and optimistic concurrency.
- [x] Run the focused tests and confirm the missing guard and verb fail.
- [x] Register `criteria`, add `cmdCriteria(rest: string[], v: Values): CliResult`, and implement a body-line candidate edit using shared label ranges. Refuse unsafe source spans and ensure the canonical block reparses as the supplied payload. Add the guard in `cmdClose` after closed-cell handling.
- [x] Update current CLI call sites, examples and docs. Keep closed-cell tests and intentional open-close override coverage distinct.
- [x] Review the diff independently. Add regressions for indented code, thematic breaks, long numeric prose, ambiguous issue ownership, and nested `非目标` labels before integration.
- [x] Run typecheck, the final full suite, and `git diff --check` before integration.
