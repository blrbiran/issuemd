# Round Nineteen Dogfooding Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and the repository TDD workflow.

**Goal:** Preserve reserved IDs and make routine body and title edits safe to inspect.

**Architecture:** Use the shared candidate parser for allocation checks. Bound comment scanning by ledger structure. Route body append and rename through the existing atomic write gate.

**Tech Stack:** TypeScript, Node.js 20+, Bun tests.

**Spec:** The approved #97–#100 behavior in the session, recorded below. Update `docs/spec.md`, `README.md`, and `skills/issuemd/SKILL.md` with the shipped CLI contract.

## Global Constraints

- Keep the tester ledger read-only. Use synthetic fixture copies for every write test.
- Preserve existing CLI stdout conventions and snapshots. Test against `.dist-test/` and keep the linked build available for ongoing retests.
- Reuse the existing parser, diagnostic gate, and optimistic atomic write path. Add no dependencies.

## Review Focus

- An incoming table reserves the selected ID or a whole range. An ordinary reference to another issue remains legal.
- Matched backtick spans, fences, and pipe rows cannot supply comment delimiters. Genuine comments inside one issue can still hide example tables.
- A pending comment cannot absorb citations across an issue or top-level section boundary.
- A long body on CRLF, with unusual separator blanks or no final newline, survives extraction and replacement byte for byte. Append preserves the original bytes around the inserted paragraph.
- A write refused by validation or snapshot checks never prints a successful rename report.

### Task 1: Candidate ID guard (#98, #91)

- [x] Add tests in `src/round19.test.ts` for default `21`, explicit `30`, a range covering the next ID, and an unrelated registered ID reference. Verify the first cases refuse without a diff or byte changes and the last one allocates `21`.
- [x] Run `bun test src/round19.test.ts` and verify collision cases fail on the baseline.
- [x] In `src/cli.ts`, validate the selected ID against the candidate ledger’s `cited` rows before writing or showing a diff. Reuse the candidate parse in the shared gate. Return exit 2 with the selected ID and the cited row or range. A file may legitimately cite a registered ID, so `check` does not lint historic overlaps.
- [x] Run the focused tests.

### Task 2: Comment scoping (#100)

- [x] Add tests in the same suite for both literal delimiters in matched code spans, for ignored table and fence closers, and for a standalone closer beyond a top-level or managed issue heading. Verify actual local comment blocks continue hiding example tables.
- [x] Run the focused tests and verify these regressions fail before implementation.
- [x] In `src/ledger.ts`, bound a pending comment by outer ledger headings and managed body/archive headings. Ignore literal delimiters in fenced lines and pipe rows, and inline code openers. Accept a multiline close on a prose line only when the delimiter starts that line’s visible text. Keep W262 and reserve tables in unclosed ranges.
- [x] Run the focused suite and the round seventeen/eighteen comment tests.

### Task 3: Body append and extraction (#97)

- [x] Add tests for exact extraction and round trip of a long CRLF/BOM body without a final newline, append with leading/trailing body blanks and an adjacent issue, stale snapshots, empty append, missing/closed/borrowed bodies, and incompatible show options.
- [x] Run the focused suite and verify the new modes fail before implementation.
- [x] Expose `show --body-only` and `body --append --body-file PATH|-` in `src/cli.ts`. Extract only owned body content. Treat the equivalent replacement as a byte-identical no-op. Insert append text at the end of the owned block with a blank separator while preserving existing lines, keep the standard body/file validation and snapshot path, and create a missing open body by the same rule as replacement.
- [x] Run the focused suite and compiled CLI tests.

### Task 4: Rename reporting (#99)

- [x] Add tests for drifted table/body and archived copies, parity between preview and real write, no-op, and refusal without a success message.
- [x] Run the focused suite and verify the cases requiring reports fail before implementation.
- [x] In `cmdRename`, collect the old and new semantic titles for each changed copy and append the report to stderr only after a successful preview or write.
- [x] Run typecheck, the full suite, isolated build, and read-only fixture/real ledger checks. Review the diff and document user-facing flags and semantics.
