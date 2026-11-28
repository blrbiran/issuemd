# Hidden Content Fail-Closed Design

## Intent

Prevent `issuemd` from silently discarding or orphaning user-authored issue content when a close or reopen operation cannot account for that content. These fixes cover two concrete paths reported by dogfooding: unrecognized criteria-like blocks removed by `close` (#141), and archive records hidden from the shared archive inventory but treated as absent by `reopen` (#145).

The user-facing rule is: if the command cannot prove that all relevant content is preserved, promoted, or deliberately discarded, it must refuse the destructive write and identify what needs review.

## Goals

- A body-deleting `close` must not silently discard non-empty, criteria-like blocks that are omitted from the criteria written to the closed row.
- A `reopen` must not create a replacement skeleton when a plausible archive for that ID exists in an appendix but is hidden by a fence, HTML comment, or raw HTML mask.
- `check`, `show`, `reopen`, and `prune` must distinguish a genuinely absent archive from a hidden archive candidate.
- Refusals must preserve source bytes and provide the candidate ID and source line.
- Existing visible, valid v2/v3 and legacy archive behavior must remain intact.

## Non-goals

- Redefining the full Markdown label grammar or the criteria-list boundary rules. Those belong to the separate criteria-boundary design covering #103/#124/#131/#133/#138/#142.
- Reserving issue IDs from free-form prose (#121).
- Automatically repairing hidden archives or guessing whether a hidden heading is an example or genuine data.
- Changing external dogfooding ledgers.

## Approaches

1. **Local write guards.** Add separate checks in `close` and `reopen`. This is a smaller diff, but leaves `check`, read commands, and write commands with different definitions of hidden or unaccounted content.
2. **Shared candidate inventories and explicit accounting.** Extend the existing shared parsing paths to expose non-empty criteria-like candidates not represented in the promoted criteria, and hidden archive candidates separately from usable visible archives. Diagnostics and destructive commands consume those same records. This costs more implementation and regression work but prevents each command from independently treating “not recognized” as “absent.”

**Chosen approach:** shared candidate inventories, with conservative fail-closed behavior at destructive write boundaries. This fits the existing shared archive inventory and criteria diagnostics architecture and avoids silent fallback when evidence is ambiguous.

## Criteria-like body blocks (#141)

- Scan visible, non-empty blocks after the first canonical `验收判据` label. Include existing aliases, labels ending in `判据` with an optional parenthetical qualifier, and the explicit labels `判定标准`, `完成标准`, `验收标准`, and `必须满足`. Exclude the tool-generated history label `关闭时判据`. The existing precedence for labels before the first canonical block remains part of the contract for this fix. Revisit that precedence in the criteria-boundary design.
- Report every candidate in `check` as W264, with the issue ID, label line, and label text. A ledger with only these warnings still passes ordinary `check` and fails `check --strict` with exit 3. The diagnostic explains that automatic promotion leaves out the candidate and points to `--keep-body` or reviewed criteria input.
- Automatic body-deleting `close` and `close --criteria-from-body` refuse with exit 2 before writing when W264 applies to the issue. `--keep-body` permits closing with the original body preserved. Explicit `--criteria TEXT` or `--no-criteria` permits the existing body-deleting close after the operator chooses the replacement value or an empty criteria cell. The refusal must distinguish these destructive overrides from preservation with `--keep-body`.
- Keep automatic rename eligibility narrow. Decisions about identical blocks and pointer text belong to #138 in the criteria-boundary design.

## Hidden archive candidates (#145)

- Within a visible appendix, record a masked archive H3 if its immediate next two lines are a v2/v3 version marker and the start marker. Use the existing archive heading and marker syntax. This prefix corroborates ownership even if a subsequent boundary is broken. Isolated markers, headings without framing, and lookalikes inside a verified visible payload are excluded. Markerless legacy archives keep their existing visible behavior.
- Keep the ID, heading line, and masking reason. Detect headings masked by fences, HTML comments, and raw HTML blocks.
- When there is no visible archive for the target, `reopen` refuses before creating a skeleton. `show --body-only` and `prune` report the same hidden candidate instead of reporting absence. Include the ID and heading line and request manual review. `close --keep-body` also refuses to create a second archive for a hidden-only ID.
- A visible v2/v3 record continues through existing validation. A hidden lookalike does not displace a verified visible record for the same ID, and hidden candidates cannot be restoration or deletion targets. Legacy ranges have no verified ownership. If restoring a legacy range would move a hidden candidate's heading, refuse and identify the overlapping ID and line.
- `check` must emit a warning for each hidden archive candidate, with ID and line. `--strict` must fail. Use an existing archive-integrity code if its documented semantics fit; otherwise allocate an unused warning code and document it.
- A hidden candidate may be an example rather than a real archive. Since those cases cannot always be distinguished mechanically, the safe behavior is to report and refuse ambiguous destructive operations, not to restore or remove hidden bytes.
- Visible valid archive behavior, exact v3 payload accounting, v2/legacy read compatibility, duplicate handling, and `prune` snapshot safeguards remain unchanged.

## Compatibility and safety constraints

- No source or external ledger bytes may change on a refusal.
- Read-only output for ordinary files without candidates remains unchanged.
- Existing diagnostics must not be silently reclassified as clean; JSON and text outputs should identify candidate IDs and source lines consistently.
- W269 already denotes malformed visible archive envelopes. If it is reused for hidden candidates, its message and documentation must clearly cover invisibility as a distinct reason; otherwise use a new warning code.
- Fail-closed checks must run before `commit()` and before any candidate rewrite or skeleton insertion.

## Verification expectations

- `close` fixtures with a canonical block plus each of `补充判据`, `新增判据`, `收窄判据`, and `判定标准` containing a non-empty list: default close and `--criteria-from-body` refuse without byte changes; `check --json` identifies each issue and line. Confirm explicit reviewed options behave as documented and `--keep-body` preserves the source block.
- Include a criteria-like candidate before the canonical block to prevent first-canonical-only scanning.
- Hidden archive fixtures for fence, comment, and raw HTML masks: `check --json` reports ID and line, `check --strict` fails, `show`, `reopen`, and `prune --dry-run` refuse with the same candidate; `reopen` and `prune` preserve bytes.
- Include visible valid v2/v3, legacy, malformed visible envelope, unrelated marker examples, and a hidden lookalike beside a visible valid archive to ensure candidates neither suppress valid reads nor authorize deletion.
- Run the full repository typecheck and test suite after implementation, then build. Do not run checks or writes against external dogfooding ledgers.

## Builder decisions

- The implementation may choose the warning code after checking the current registry, while preserving stable JSON diagnostics.
- Candidate matching should reuse existing parser masks and criteria extraction where possible; if a parser fact cannot be shared without broadening Markdown behavior, introduce a narrowly named candidate scanner rather than changing unrelated parsing semantics.
- For criteria-text equivalence, compare using the existing criteria normalization/representation where available. If a candidate contains any non-empty material not represented in the selected row criteria, treat it as unaccounted; do not infer equivalence from the label alone.
