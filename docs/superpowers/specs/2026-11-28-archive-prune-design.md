# Archive prune design

## Intent

Allow an owner to remove one obsolete `close --keep-body` archive without reopening the issue or editing Markdown by hand. Archive payloads may contain large evidence that is no longer needed, so deletion must be explicit and reviewable.

## Current evidence

- `close --keep-body` writes a frozen body payload under `## 附录`; it is readable by `show`/`list`, counted by W201 and W250, but has no deletion verb.
- `reopen` restores the payload and changes the issue back to open; it is not a safe substitute for removing obsolete evidence.
- Multiple/malformed archives are ambiguous and already fail closed for reads/writes.

## Approaches

1. **Reopen, edit, and close again.** This changes issue state and can alter criteria/bytes while the goal is only to discard archived evidence.
2. **Add a bulk prune policy by age or size.** This requires new retention rules and could remove more evidence than intended.
3. **Add exact-id pruning with a preview and mandatory confirmation for the actual delete.** This removes only the selected unique archive and leaves its closed table row and criteria intact. Choose this approach because it makes scope explicit and matches the single-file write gate.

## Design

- Add `issuemd prune FILE ID --dry-run` and `issuemd prune FILE ID --confirm --if-unchanged S`.
- These are two required invocations: `--dry-run` alone previews the exact bytes and prints snapshot S; apply requires both `--confirm` and that snapshot. Neither flag, both modes together, `--confirm` without a snapshot, or `--if-unchanged` without `--confirm` returns exit `2` without writing. A stale snapshot returns exit `4`. The snapshot guards only the file revision; it does not bind the selected id or mode. The operator must repeat and confirm the exact id shown in the preview.
- Do not accept ranges or multi-id rows. Count every open/closed row whose parsed span covers the requested id, plus unreadable rows that reserve it; require exactly one owner and that it is a closed singleton row. Ambiguous ownership refuses rather than trusting `findRow()`'s first match.
- Count exact-ID archive headings across every true, visible `## 附录` before validating payload envelopes. The appendix H2 and archive H3 must be outside fences and raw HTML blocks. Zero headings returns exit `1` (`no archive`); more than one heading, duplicate appendices (W266), markerless legacy archives, malformed v2 payloads, or missing boundaries all exit `2` with candidate lines and no write. Require exactly one `KEPT_BODY_VERSION` and one exact standalone start marker, and exactly one eligible standalone end marker outside literal blocks. Multiple eligible end markers are ambiguous and exit `2`; a complete archive example inside `<pre>` or a fenced block is never a deletion target. V1 pruning does not guess legacy payload boundaries.
- Remove only the selected archive H3 heading through its visible v2 end marker, inclusive. Require every other line in that H3 subtree to be envelope content or whitespace; if user notes exist before the version marker or after the end marker, refuse with their lines rather than orphan them under another heading. Preserve the closed table row and criteria cell, every neighboring line, every other archive and appendix section, and the `## 附录` heading. Do not auto-remove `appendix:auto` or leave cleanup to a second implicit edit.
- Before preview or apply, validate the candidate against the full baseline: the multiset of pre-existing check errors must be unchanged (compare code/id/message/expected/actual, ignoring line shifts), and every non-target archive id and payload must remain byte-identical. Refuse with exit `3` if either invariant changes. All write commands now derive UTF-8/EOL validation, parsed text, snapshot, and the expected stat from one stable `readRaw()` buffer, so a preview token cannot authorize rewriting bytes that changed between validation and parsing.
- For newline-terminated input, retain surviving blank lines even when they become terminal. For an unterminated file whose removed v2 archive was at EOF, remove only blank lines that become terminal so the result remains unterminated. Preview and apply use the same candidate bytes.
- A successful apply emits the normal post-write snapshot receipt plus an archive-pruned receipt. After pruning, W250/W201 counts reflect remaining archives; no status transition occurs.

## Goals and non-goals

- Exact-ID scope, preview-first workflow, and a second explicit confirmation for actual deletion.
- Preserve the ledger's row, criteria, other archive payloads, appendix prose, line endings, BOM, final-newline state, and permissions.
- Do not add age-based or bulk pruning, do not reopen the issue, and do not prune ordinary appendix prose.
- Do not alter either external dogfooding ledger.

## Verification

Add TDD cases for required two-step confirmation and `--if-unchanged`, stale snapshot exit `4`, preview/apply parity, exact closed singleton ownership with conflicting open ranges/unreadable rows, missing/duplicate/malformed/legacy archive refusal, duplicate appendix refusal, H3/markers inside `<pre>` or fences, multiple visible end markers, unchanged baseline error multiset and non-target archive inventory, multi-id/range refusal, preserved table criteria and neighboring appendix prose, W250/W201 counts, line-ending/BOM/mode preservation, newline-terminated trailing blanks, and EOF archives with/without a final newline. Then run typecheck, the full suite, build, and the three external ledger checks read-only.