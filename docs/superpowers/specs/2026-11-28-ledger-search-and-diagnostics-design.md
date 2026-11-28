# Ledger Search and Safety Diagnostics

## Scope

Add the remaining read and diagnostic improvements that fit the existing file and CLI contracts. The three external ledgers serve as read-only inputs.

## Unclosed fences (#128)

Report W270 at the opening delimiter of a fence still open at the end of a managed body or visible appendix. Share the fence state machine with `fencedLines` and `endsInFence`; list-relative fences end on outdent. Do not count a literal delimiter inside an HTML comment or raw HTML block as the opener. Include an issue ID for body diagnostics. Ordinary check succeeds for warning-only input and strict check exits 3. The diagnostic points to the opener and asks the reader to close the fence before modifying the affected section. A verified archive's framed payload and its metadata do not serve as appendix-level openers.

## Prose references (#121)

Reserve an isolated visible `#N` or `#Na` token in managed body prose or visible appendix prose and verified archive payload. Use whitespace, punctuation, or a CJK character as neighboring delimiters. Skip fences, HTML, inline code, pipe-table rows, managed headings, URLs, Markdown links and reference definitions. Do not infer references in arbitrary bare numbers. Do not advance high water to the largest reference. Default `new` skips references it would assign, explicit `--id` refuses and points to a source line, and a candidate write checks the new body too so a cited number cannot be claimed in the same operation. Existing issue rows remain valid reference targets. W271 reports the first occurrence of each referenced ID absent from managed and unreadable rows. Legacy history whose references and high-water metadata are both absent cannot be inferred.

## Literal search (#127)

`issuemd find FILE PATTERN [--json]` uses one case-sensitive literal substring and searches open and closed table summaries, managed body text and uniquely owned usable archive payloads. Ignore duplicate, malformed, and masked archives. No regex. Results are in source order, one per matching line per field, with `{id, table, line, where, text}`. For grouped summaries return the row's displayed ID. For body and archive hits return the actual source owner. A match entirely within a recognized `#N` token uses `where: "reference"` and retains its containing issue's ID. Search textual mentions by keyword under their actual owner. Do not infer a semantic target without a spelled ID. JSON contains `matches` and existing snapshot and diagnostics conventions. A valid search with zero matches exits 0 and returns an empty result. No filename or content is sent externally by the command.

## Hash repair result (#143)

`sync --fix-hashes` retains its current exit contract and per-occurrence skip reasons. Emit a stable summary `W202: wrapped N, skipped N, remaining N` on stderr for both preview and actual writes. Count `remaining` by checking the same candidate as the write, because not all skipped contexts produce W202 warnings. Add an opt-in `--require-complete` which exits 3 without replacing the file if W202 would remain on that candidate. With the flag, preview likewise exits 3 and emits no misleading applied diff. Empty and fully repaired candidates exit 0.

## Progress lint (#139)

Share one matcher for W260 and progress classification in title sync. Prefer explicit status clauses and quoted-text exclusion. Remove bare `仍无`, `仍走`, and `仍逐` substrings from automatic classification. Retain explicit cues such as `已修，待现场复核`, `本轮已落地`, and `仍缺现场验证`. Report the matched cue and its one-based column within the decoded summary. When `sync --titles --move-progress` sees a W260 issue with no title change to move, point out that it needs a reviewed `rename` and body update. Preserve existing title conflict and write guards.

## Source visibility

Use managed body and appendix ranges and the shared archive inventory. Apply the existing fence and HTML masks to references. For inline references use existing Markdown code, tag and link-destination ranges. Visible link labels remain eligible. `find` searches the source shown by each body view, including quoted examples, and only marks a hit as `reference` if it overlaps an eligible reference token. Hash repair keeps its existing context exclusions. Only a single visible, valid archive per closed owner contributes an archive search result. Treat overlapping or unowned archive sections as opaque for search.

## Verification

Temporary fixtures cover top-level and list-relative fence boundaries, literal examples, both kinds of number allocation, citation conflicts in incoming content, historical range endpoints, deterministic find ownership and empty results, hash repair with none/some/all safe positions, and false and true progress cues. Run the complete suite and read-only smoke checks after integration.
