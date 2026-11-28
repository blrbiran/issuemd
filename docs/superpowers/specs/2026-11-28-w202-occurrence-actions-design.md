# W202 occurrence repair design

## Intent

Make W202 actionable in one check/repair cycle. Users need every relevant source location for a repeated token, a reliable issue id for body hits, and a mechanical way to mark intentional literal hashes without rewriting an entire body by hand.

## Current evidence

- `checkHashes()` stores one location per hash token so Git verification can deduplicate work. That also discards later W202 locations.
- W202 does not include an issue id for hashes in open body blocks.
- `sync` has no W202 repair mode.
- W202 scans visible keep-body archive payloads, which are frozen and cannot be edited while closed; this can leave `--strict` failing until reopen.
- Text check output limits each warning code to a few examples, which obscures many distinct hashes.

## Approaches

1. **Keep one W202 per hash and add `also at` locations.** This is a small output change but still leaves the user to edit content manually.
2. **Report every occurrence and add a mechanical sync mode.** This keeps source locations explicit and makes the recommended literal-evidence conversion one reviewed operation.
3. **Silence W202 globally and rely on `--verify-commits`.** This misses stale or fabricated short hashes outside a Git worktree and changes the purpose of W202.

Choose approach 2. It preserves the checker’s existing classification and verification semantics while adding a write path with preview and atomic candidate validation.

## Design

### W202 occurrence reporting

- Share one raw-source hash scanner between `check` and `sync --fix-hashes`. It reports each unprotected hash occurrence; repeated tokens on the same or different lines remain distinct locations.
- JSON warnings carry a 1-based absolute line and Unicode-scalar column. For a token in open body content strictly after a parsed issue heading and through its body end, include the full body id only when that id belongs to the open table and not the closed table. Orphan/closed body text, managed headings, and ordinary appendix prose have no id.
- Text `check` prints all W202 occurrences, without the general per-code display cap, so one output is sufficient to drive one repair.
- Keep two classifications over the shared raw token scan. W202 uses the full fence scanner (including list-relative fences), inline-code protection, and valid archive payload suppression. `--verify-commits` preserves the current token-eligibility set exactly, including hashes in list-relative fences and archive payloads; it remains opt-in and keeps the current unique-token W240 anchor rule: use the first pinned occurrence when present, otherwise the first scanned occurrence. Suppressing a W202 occurrence may therefore leave a W240 anchor there, and its reported line can move after a hash is wrapped.
- A recognized valid kept-body archive payload does not emit W202, but its tokens remain eligible for optional Git verification. Continue W202 scanning on archive headings and on ordinary appendix prose after a valid v2 end marker. For malformed v2 archives, continue reporting W202 in the payload, but make the managed heading and full H3 subtree read-only to `sync --fix-hashes` and report the skipped locations.
- Archive ranges come only from `archivePayloadRange()`: v2 requires exactly one standalone, unfenced end marker and the payload stops before it; duplicate eligible end markers make the archive malformed. Legacy uses its established payload boundary. Apply the rule independently to every recognized archive heading, including duplicate archives. A missing/ambiguous boundary never licenses an edit.

### Mechanical repair

- Add `issuemd sync FILE --fix-hashes [--dry-run] [--if-unchanged S]`.
- Wrap every W202-eligible occurrence in inline code in open issue body content and ordinary `## 附录` text, preserving all other bytes on the line.
- Use the same source scanner and exclusions as `check` for fences (including list-relative fences), existing inline-code spans, UUIDs, and date/timestamp numeric runs. Repair also skips every cell of a parsed table—including cited tables in `正文` and `附录`—and syntax-bearing spans it cannot safely wrap (Markdown link destinations, autolinks, raw HTML attributes, unmatched inline-code delimiters). It reports each skipped W202 location with a manual-edit reason.
- Do not modify closed-table criteria, table delimiters or cells, index summaries, body headings, archive headings, or any valid kept-body archive heading/payload. A malformed/ambiguous v2 archive's whole H3 subtree is read-only. Ordinary appendix text after a valid v2 end marker remains eligible.
- Require a safe wrapper boundary: adding backticks must not merge into an existing code span or alter Markdown links. If the scanner cannot prove that, leave the token unchanged and report it as skipped.
- Reuse the existing optimistic write gate. Dry-run shows the exact diff; real writes report each changed source line and the post-write snapshot; no-op remains `(no changes)`. Preview and apply use the same insertion-only candidate and preserve the same pre-existing structural errors at the same source lines.
- `--verify-commits` still sees hashes inside the newly added inline-code spans.

## Goals

- One check output identifies all W202 locations and body ids.
- One reviewed sync operation clears eligible W202 occurrences in body and ordinary appendix prose.
- Frozen archive payload remains byte-for-byte available to `reopen` and does not keep `--strict` red solely for W202.
- Hash verification remains deduplicated and behaviorally unchanged.

## Non-goals and limits

- Do not reinterpret ambiguous 7–40 character hex strings as thread ids; #27 remains a separate token-classification decision.
- Do not rewrite index summaries, body headings, archive headings, closed criteria cells, fences, existing code spans, or archives.
- W202 repair can increase file size by adding backticks; existing size metrics and W201 are the signal for that tradeoff.
- Do not modify external dogfooding ledgers.

## Verification

Add regressions for a repeated hash across several open-body lines (including absolute line, column, and full id), multiple hashes on one line, comma/range rows and orphan/closed bodies, ordinary appendix prose, valid and malformed archives including text after the v2 end marker, closed criteria cells, index summaries, parsed citation tables in正文/附录, fences (including list-relative fences), inline code, Markdown link destinations, unmatched backticks, UUIDs, numeric dates, one-pass `sync --fix-hashes`, skipped locations, dry-run/no-op, byte preservation outside wrapped spans, BOM + CRLF + no final newline patch round-trip, trailing blank lines, preservation of existing structural errors, and unchanged W240/W263 behavior including archive-only and list-relative-fence tokens whose W202 classification differs.