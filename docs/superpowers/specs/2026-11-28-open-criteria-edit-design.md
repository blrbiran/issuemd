# Open Issue Criteria Editing Design

## Intent

Let users revise the acceptance criteria of an open issue without changing its status or deleting its evidence body. Prevent the reported `close FILE ID --criteria TEXT` mistake from silently closing an issue when the caller intended only to edit its criteria.

## Approaches

1. Add a dedicated criteria-edit command and keep the current `close --criteria` behavior. This is backward compatible, but leaves the demonstrated accidental-close path intact.
2. Add a dedicated criteria-edit command and require `--status` when `close --criteria` targets an open issue. This narrowly protects the ambiguous invocation while keeping ordinary `close FILE ID` behavior. **Selected.**
3. Add only a confirmation flag to `close`, without a criteria-edit command. This prevents one mistake but leaves open criteria with no direct editing verb.

## Proposed behavior

- Add `issuemd criteria FILE ID --criteria TEXT` for a single open issue row. It updates only the exact `**验收判据**` block in that issue's body, leaves the status, summary, all other body blocks, and table bytes outside that body block unchanged, and uses the standard dry-run, snapshot, atomic write, validation, and receipt behavior.
- If the open body has no canonical acceptance-criteria block, add one without replacing or reordering existing evidence. If the target is ambiguous (multiple canonical blocks, supplemental criteria, or a W268 boundary that prevents identifying the block safely), refuse without writing and report the relevant lines. Multi-id/range rows remain subject to the existing per-id restriction.
- For an open issue, `close FILE ID --criteria TEXT` requires an explicit `--status S`. Without it, refuse before writing and direct the user to `issuemd criteria`. When the supplied value differs from the body criteria, report both values in the preview and successful write. Ordinary `close FILE ID` retains its existing default status behavior. Closed issue `close --criteria` continues to update only the closed table cell.
- Update command help, generated usage, README, spec, and `skills/issuemd/SKILL.md` so the distinction is explicit.

## Goals and non-goals

- Goal: separate editing open-body criteria from closing an issue, while preserving evidence and status.
- Goal: make the reported invocation fail safely and give an actionable alternative.
- Non-goal: edit several ids or ranges in one operation, infer merges among competing criteria blocks, or change the closed-table criteria format.
- Non-goal: redesign general semantic body editing (#140).

## Constraints and implementation notes

- Follow current TypeScript CLI, `loadWritable`/`commit` transaction, diagnostics, and body-label parsing conventions.
- Keep existing `close` behavior except for the ambiguous open-item `--criteria` invocation without explicit `--status`.
- Add regression coverage for preserving status/evidence, inserting a missing criteria block, ambiguity refusals, dry-run/snapshot behavior, and the exact #147 invocation.
- The external dogfooding ledger is reference material only and must remain unmodified.

## Source boundaries

Insert a missing block before the body's trailing separator lines. Require a unique, existing body, and examine visible labels in the whole body, including aliases before a canonical block. Duplicate canonical labels count even when empty. Refuse alias-only or competing criteria with line numbers.

`TEXT` is a nonempty single line of body Markdown. Reject CR/LF. Preserve literal pipes and backslashes. Replace clearly owned inline text and list content, leaving surrounding separators unchanged. Refuse a replacement span containing comments, fences, or ambiguous unlabeled content. Verify the candidate has a single canonical block containing the supplied text and preserves the neighboring body structure. Use a canonical `**验收判据**：` label when inserting. Document explicit `close FILE ID --status 已修 --criteria TEXT` wherever the open-item override is suggested.