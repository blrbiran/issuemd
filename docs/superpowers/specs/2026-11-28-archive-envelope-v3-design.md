# Archive envelope v3 design

## Intent

Keep `close --keep-body`, `adopt`, `show`, `list --with-body`, `check`, `reopen`, and `prune` consistent for archive payloads containing blank lines, raw HTML, comments, fences, or literal marker text. V2 searches for an end marker, so marker-shaped payload text can be mistaken for the boundary and HTML/comment blocks can hide a generated marker. V3 uses a counted payload boundary and preserves the old v2 grammar.

## Goals

- Make the v3 payload boundary depend on an exact number of payload line records, never on searching payload text for marker strings.
- Preserve leading, trailing, empty, whitespace-only, and literal marker lines inside the payload.
- Preserve the document's accepted BOM, uniform EOL, and final-newline state when closing/reopening.
- Keep v2 archives under their committed grammar and never interpret v3 metadata as v2 envelope syntax.
- Make all archive consumers use one version-aware locator/validator.
- Make `close` and `adopt` validate their fully serialized archive before changing issue state or writing.

## Non-goals

- Do not rewrite or migrate existing archives during reads.
- Do not change issue status or criteria while pruning.
- Do not build a full CommonMark parser.
- Do not modify the external dogfooding ledger.

## Approaches

1. **Extend v2 with a separator marker.** Existing v2 payloads may contain that marker, and blank lines cannot be partitioned reliably between payload and framing. Reject this approach.
2. **Introduce v3 with an exact payload line count.** The version selects one grammar; the count assigns every line, including empty and marker-shaped lines, to payload or envelope. This is the chosen approach.
3. **Reject all payloads containing raw HTML, comments, or marker-like text.** That avoids some ambiguity but rejects useful evidence and still cannot preserve arbitrary blank lines.

## V3 grammar

A new `close --keep-body` or `adopt` archive is represented by these line records:

```text
### #N <summary>（已关闭，正文保留）
<!-- issuemd:kept-body:v3 -->
<!-- issuemd:kept-body:start -->
<!-- issuemd:kept-body:lines:N -->
<payload record 1>
...
<payload record N>

<!-- issuemd:kept-body:end -->
```

`N` is a safe integer counting the exact payload array records after the metadata line and before the one empty framing record. It counts empty and whitespace-only records. For `N=0`, the next record after metadata is the empty frame; for a payload consisting of one empty record, there is one empty payload record and then a second, distinct empty frame. Thus the line array represents both cases without inference from EOL bytes. The frame record must be exactly empty, not whitespace-only, and the end marker is the next record after it.

The count includes literal `kept-body:*` lines wherever they occur in those N records. Body ingestion/adoption must allow such lines for v3 archives; the parser never searches the counted region for version, start, line-count, frame, or end markers. Only exact required metadata at its fixed pre-payload offsets is framing. Duplicate or reordered envelope markers outside the counted range are malformed.

`N` counts the decoded line records, not source bytes. The existing writer accepts valid UTF-8 and uniform LF or CRLF, retains the BOM and document-wide final-newline bit, and rejects mixed EOL/invalid input on writes. Reopen restores the same line records and those file-level properties; byte-for-byte claims apply to that accepted input contract. W201 counts `N` lines and `Buffer.byteLength(payloadLines.join("\n"))`, excluding the frame and every envelope marker, with no extra final-newline byte. `body.content` and `body.text` retain their string compatibility; add `body.lineCount: N` so JSON distinguishes zero records from one empty record. `body.content` and `body.text` retain their string compatibility and use the current archive serialization: for N>0, LF-joined payload records plus one LF output terminator; for N=0, the empty string. Add `body.lineCount: N` so JSON distinguishes N=0 from N=1 with one empty record. `--body-only` emits no bytes for N=0; for N>0 it joins records with the document EOL and applies the existing output-terminator rule, so N=1 empty emits one EOL when the rule requires a terminator.

For v3, a body payload whose final physical record would be swallowed by `terminate()` when reopened must not be silently shortened. Reopen must verify the candidate's restored body records equal the N archive records before writing; if the document's final-newline constraint makes that impossible, refuse with exit 3 and leave the file unchanged. In the ordinary ledger shape, a following section provides the structural line boundary; tests must also cover the no-appendix EOF case.

## Archive discovery and visibility

Use one shared archive inventory, built from the parsed headings plus the same fence, multiline-comment, and raw-HTML visibility masks. Only visible `## 附录` headings and visible archive H3 headings create archive owners or section boundaries. An H3-looking line inside `<pre>`, a fence, or a comment cannot split an archive or become a prune target. An archive subtree ends at the next genuine visible H1–H3 heading, not at a hidden scanner result. A write target (`## 附录`) that is itself hidden or inside another HTML/comment/fence block is not usable.

The shared inventory also defines which lines are frozen payload for W202, which lines count for W201, and which archive bytes prune must preserve. The writer validates the final serialized candidate with this same inventory before committing. This prevents `close`/`adopt` from reporting success when the new archive cannot be found by readers.

## Writer validation and HTML visibility

The v3 count gives the structural boundary even when payload lines contain marker-like text. The calculated end marker must remain outside fences and raw-text HTML blocks so later appendix material is not swallowed. A multiline HTML comment opened inside the payload is allowed: the exact end-marker comment closes it at the calculated boundary, and `check` retains W262 for the source comment. A candidate ending in an unclosed fence or raw-text HTML block (`<pre>`, `<script>`, `<style>`, `<textarea>`) is refused before the table row/body changes. Closed block-tag content such as `<div>…</div>` is followed by the distinct empty frame record, which ends the CommonMark block and exposes the end marker. Test custom elements, standalone opening/closing/void tags, raw-text tags, and comments on both close and adopt.

## V2 and legacy compatibility

- `kept-body:v2` retains the committed grammar: exact standalone version and start lines immediately after the heading, then exactly one exact standalone visible end line strictly after start. The in-progress pre-commit v2 writer also emitted one compatibility shape: exactly one empty record, one `kept-body:separator` record, then the end marker. Preserve that positional shape as envelope framing because current readers already exclude it; all other v2 separator/`lines:N` occurrences remain payload text. If the positional shape is used, its blank is framing even if a hand-edited payload happens to have the same suffix.
- V2 end-before-start, duplicate visible end markers, unsupported version headers, hidden/missing boundaries are malformed. Malformed v2 is not reinterpreted as legacy. V2 marker matching is exact and unindented; hidden marker-shaped lines inside fences/comments/raw HTML are payload, never boundaries. Ordinary nonblank text after a valid end marker is appendix text: readers/check leave it outside the payload, reopen removes the archive and preserves the note, and prune refuses because deleting the H3 would orphan the note.
Dispatch first checks the fixed version slot: the first line after the archive H3. Exact `v2` or `v3` selects that grammar; an unsupported `vN` there is malformed. If the first line is blank or a start/lines marker and a visible version declaration appears within the following two envelope lines, report W269 for a displaced header instead of falling back to legacy. For v3, validate the fixed metadata and count first; only after the N payload records are established are version-shaped lines inside that range treated as literal payload, while additional declarations outside the range and before the archive end are malformed. For v2, payload begins after the fixed start line and ends at its one selected end marker; version-shaped lines inside that payload are literal. If no version header is present in the fixed slot or displaced-header prefix, use markerless legacy parsing. Unsupported/displaced declarations never silently fall back to legacy. V2-to-v3 conversion is never automatic.

## Shared command behavior

One version-aware locator returns the visible archive owner, version, exact payload line range, calculated end line, frame line (v3), and refusal reason. `show`, `show --body-only`, `list --json --with-body`, W201, W202 archive suppression, `reopen`, and `prune` consume this result. Prune adds ownership and deletion-scope validation without a second marker grammar.

- Valid v3: show/list expose exactly N records; W201 measures only those records; reopen removes the exact envelope/frame and restores N records plus the existing `关闭时判据` history behavior when table-only criteria need preserving; prune removes the archive H3 through calculated end and preserves the closed row and unrelated appendix bytes.
- Valid v2 and legacy: retain their version-specific payload/reopen behavior. Malformed v2 uses the fail-closed behavior above. `prune` accepts uniquely owned, structurally valid v2 and v3 archives; markerless legacy archives remain manual-only.
- Malformed v2/v3: show/list withhold archive body; check emits W269 with exact source lines and `--strict` fails; reopen exits 3 and prune exits 2 without writing. Close/adopt candidate validation must reject its own malformed serialized archive before commit; a warning-only W269 is not sufficient protection at the write gate.
- Nonblank text after the end marker within the archive H3 is appendix text, never payload. Show/list/check keep it outside the payload; reopen removes the archive through the end and leaves the note in the appendix. Prune refuses because deleting the H3 would orphan the note. For newline-terminated files, prune preserves every surviving blank line, including blanks that become terminal. For unterminated files, prune may drop only empty records that become terminal due to removal; it preserves all whitespace-only records and every nonblank appendix line. If satisfying these rules would alter any other archive payload, prune refuses.
- Adopt's existing mechanical normalization, including its `（空）` placeholder for an empty converted body and `trimBlankEdges`, happens before v3 line counting. Reopen restores that normalized adopted payload exactly; it does not restore source edge whitespace that adopt intentionally discarded.

## Verification

Add tests for: v3 `N=0`; one empty record; payloads with zero, one, and multiple trailing empty/whitespace-only records at EOF and before appendix text; literal version/start/lines/end marker lines inside payload and duplicate marker lines outside it; normal body input through close and adopt; closed `</div>` plus a distinct frame; unclosed `<pre>` and fence refused before write, plus unclosed comment accepted with W262 and end-marker closure; fake H3 siblings inside HTML/comment/fence ignored; append targets hidden by HTML/comments refused; show/list/reopen/prune/W201 agreeing on one inventory and payload; v2 literal `kept-body:lines:N`/separator text preserved; malformed v2 end-before-start, duplicates, hidden-only end, and unsupported version refusal; malformed v3 metadata/count/frame/end placement and hidden calculated end; W269 consistency across commands; post-end note behavior including H4 note, sibling H3, and adjacent archives; prune preservation of blank lines and unterminated EOF behavior; table-only criteria history after reopen; BOM+CRLF+no-final-newline and mixed-EOL/invalid-UTF8 contract; W201 exact-limit and one-byte-over multibyte cases; and adopt empty/trimmed payload semantics. Run focused suites, then `npm run typecheck && npm test`, `npm run build`, and read-only external ledger checks.
