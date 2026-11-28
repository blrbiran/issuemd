# Criteria Boundaries and Append Safety

## Intent

Preserve the user's acceptance criteria through retests and closure. A review note should be easy to append. A destructive close should stop when the text it would promote or discard needs a human decision.

## Approach

The current parser keeps some blank-separated prose inside a criterion list when another list or fence follows. W268 separately tracks whether it has seen a canonical label and a list item. The two paths can disagree. A new mandatory section syntax would make ownership explicit at the cost of a migration. The proposed approach keeps the existing label syntax, shares the parser's ownership and boundary decisions with W268, and makes `body --append` verify its effect before writing. Use an explicit label or reviewed input where the text permits more than one reading.

## Parsing and closure

- Record each canonical block's owned range and the reason for its end in the existing body parser. Use 1-based source coordinates across extraction, diagnostics, and close. Leave `criteria`, `criteriaBlocks`, and named labels readable through their current JSON fields.
- After a criterion list, a blank-separated unindented paragraph with no later peer list or fence ends the block as it does today. Where a peer list or fence makes ownership ambiguous, preserve the current `show.criteria` and `criteriaBlocks` until the author resolves the boundary. Warn with W268 on the first unindented prose line and refuse both automatic body-deleting close forms with exit 2. An indented list continuation or fence whose indentation establishes ownership remains part of the criteria and does not warn.
- A standalone bold label after a list can end a criteria block. Report W268 when subsequent visible list items could continue it, including `1. …` followed by `**注意**` and `2. …`. A standalone review heading followed by review prose or a fence is a normal boundary. A sentence-shaped bold heading after an already-ended criteria block does not warn.
- Treat `**第二十六轮复核**（…）：…` as an explicit review label with inline content. Limit new grammar to a bold label immediately followed by a balanced parenthetical qualifier and a colon. Bold-leading ordinary prose continues to follow the existing grammar. Prefer `**复核记录**：…` or an independent `**复核记录**` line in diagnostic and skill examples.
- W268 diagnostics must name the boundary, explain the competing interpretations, and recommend reviewing the blocks, supplying `--criteria TEXT`, or keeping the body. Keep the existing explicit `--no-criteria` choice. Dry-run and actual writes apply the same rule.

## Append safety

- For a body that already exists, an append preserves the pre-existing canonical criteria occurrences and non-empty supplement occurrences. Compare both their owned source lines and their promoted text after constructing the candidate. The flat string alone can hide repeated blocks and different ownership. Permit append to an item with no body using the existing missing-body behavior.
- Recognize labels through the body parser with fence and comment visibility. When the last canonical or supplement block would absorb unlabeled input, start a separate `复测记录` block. Use the first unused name in `复测记录`, `复测记录 2`, `复测记录 3`, and so on. Only visible labels, including visible labels with empty content, reserve a name. Preserve recognized non-criteria labels that callers explicitly supply.
- Refuse incoming visible canonical labels and labels eligible for W264 regardless of their position or content. This applies to an explicit first label and to a later label concealed by a preceding review heading. The command exits 2 before writing and tells the caller to quote source criteria inside a fence or replace the body with reviewed criteria. A fence or comment may contain a literal label. Verify the resulting criteria and boundary warnings on the full appended body too, since surrounding Markdown can change how the incoming text parses. Preview follows the same checks.

## W264 usability

- A later candidate with the same complete criterion content as one canonical block may be excluded from W264. Require equality of the content after removing each block's label syntax and outer blank lines. Retain interior line boundaries, list markers, punctuation and fence contents. Do not use substring or all-whitespace matching.
- Keep W264 and its close guard for additional conditions and ambiguous references. A label such as `判据（不变）` can contain substantive criteria. Recommend a review label for notes that merely refer back to a criterion. Keep `criteriaBlocks` available so consumers can see source occurrences, including duplicates.
- Leave `sync --criteria-labels` conservative. Open criterion narrowing, reference reservation, and reversible closed-table serialization remain separate contracts.

## Acceptance tests

Use `**验收判据**` followed by `1. 判据一。` and `2. 判据二。` as the base. Test each variation independently.

| Following content | `show.criteria` | Diagnostic and automatic close |
| --- | --- | --- |
| `**第二十六轮复核（2026-11-27）：仍未修。**` followed by prose and a fence | Only the original two items | No W268. Close succeeds. |
| `**第二十六轮复核**（2026-11-27）：仍未修。` followed by prose and a fence | Only the original two items | No W268. Close succeeds. |
| A blank-separated ordinary paragraph followed by `**复核（第 N 轮）：仍未修。**` and prose | Only the original two items | No W268. Close succeeds. |
| A blank-separated unindented paragraph followed by a blank-separated peer list or top-level fence, without a section label | Preserve the existing one-line projection, including the interleaved prose and peer list or fence contents | W268 on the paragraph. Both automatic close forms exit 2. |
| `**注意**` or a sentence-shaped bold line followed by the next numbered item | The same projection as today | W268 on the bold boundary. Both automatic close forms exit 2. |

Use blank lines between list items and review sections where appropriate. Test indentation-established continuations separately and assert that both reads and automatic close retain them without warning. Assert that a visible canonical or candidate label on the first or middle line of an append exits 2 without writing. A literal example inside a fence or comment stays out of criteria. Test an empty canonical block and a free-label collision covering visible, fenced, and commented names. For a body ending in canonical criteria with `复测记录` already reserved, assert that the tool writes `**复测记录 2**` and introduces no W206.

Track W264 for identical blocks, a substantive `判据（不变）` pointer, and a genuinely different candidate. Assert the promoted criteria and exit code for each close preview. Assert byte equality on every append or close refusal and compare fixture results before and after explicit overrides.
