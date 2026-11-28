# Move Evidence Out of an Issue Body

## Scope

For #106, add one atomic in-ledger path for moving a named evidence section out of an open issue's body. W201 tracks the length of the active body. This operation reduces that length while preserving evidence in the same file. File-wide size reporting remains available.

`issuemd body FILE ID --move-evidence LABEL [--dry-run] [--if-unchanged SNAPSHOT]` applies only to a singleton open issue with one exact visible occurrence of the requested label. It is mutually exclusive with `--append` and `--body-file`. A missing or duplicate label is a refusal. Recognized criteria labels and `关闭时判据` are ineligible. Require a single visible appendix, or create one if it is absent and a visible insertion is safe.

Copy the label and all of its owned lines verbatim into a new `### Issue evidence from #ID` heading in the appendix (plain prose, outside the kept-body archive namespace). Store them inside a tilde fence longer than every tilde run in the copied source. Replace the body label's owned range with a concise link to a unique generated Markdown anchor on that appendix heading. Preserve label boundary semantics using explicit colon before the link. Use a deterministic free anchor ID on repeated extractions. Empty whitespace and unrelated sections remain outside the range. Include a visible reference in the appendix heading and maintain existing textual ID reservations by refusing if a copied range holds the ledger's last visible reference to a number. Never write a sidecar or a second file.

Reuse the transaction validator. Resolve exactly one owning open singleton row and one managed body. Preserve raw source records and the ledger's EOL convention. Compare ordered criteria occurrences without line coordinates, W268 details after mapping moved coordinates, and the set of prose-reserved IDs. Verify the destination and copied records in the parsed candidate and preserve every archive span, heading and payload. Place the new evidence before the first existing appendix child so an existing legacy archive cannot absorb it. Refuse to move an existing generated link a second time.

Use `body --move-evidence --dry-run` to review the exact source and destination, then rerun the same command with `--if-unchanged`. Report whether the active body still has W201. The operation uses the existing write lock and a single Markdown file.

## Verification

Tests cover ordinary move with W201 dropping, preview and byte-faithful copied lines, duplicate label, blocked criteria labels, orphaned reference, stale snapshot, fenced appendix and duplicate appendices. No real ledger is changed by these tests.
