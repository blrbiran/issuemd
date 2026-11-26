# Dogfooding issue clusters: unified behavior contracts

Date: 2026-11-26
Status: Implemented on feature branch; final review pending

## Intent

Address the currently reproducible user-facing issues in dogfooding #86–#96 by making related commands follow shared, predictable contracts. The main risks are duplicate issue IDs, silent loss of unique text, a write that hides a structural error, and read views that give inconsistent accounts of the same ledger.

The external dogfooding ledger is evidence only and remains maintained by its tester. This work updates issuemd code, tests, and its normative documentation; it does not edit that ledger.

## Scope and goals

1. Preserve safe ID reservation in free-form `正文` and `附录`, even when examples contain HTML comment delimiters or comments are malformed.
2. A write command must not appear to repair a ledger by hiding an error or discarding unique content unless the user explicitly chose that outcome.
3. `reopen` must distinguish an acceptance criterion from a closure rationale and make missing criteria visible.
4. Read commands must expose consistent counts, cross-table filter hints, and machine-readable diagnostics.
5. `--verify-commits` must distinguish an unavailable Git repository from a missing commit.
6. `split` must disclose when it creates a duplicate-summary warning.

Out of scope: changing the dogfooding ledger, revisiting #81/#82 implementation, broadly changing all existing warning severities, or changing push/release timing.

## Evidence checked

- Current checkout is clean `main`, with zero commits ahead of `origin/main`; this differs from the previous handoff snapshot.
- Current code confirms #93/#91 in `src/ledger.ts:175–190`, #86 in `cmdClose` plus the count-only `commit` gate, #87 in `cmdReopen`, #88/#94 in JSON construction and list filters, #95 in `summaryLine`, #89 in `checkHashes`, #90 in `cmdSplit`, and #96 in `cmdSync`.
- The tester's #90 correction is accepted: the distinct-body-title example already has E106 before split. The confirmed split regression is newly introduced W212 and a clean `--strict` result becoming failing.
- #81 and #82 are implemented. #84 is implemented for visible free-form tables but is bypassed by the malformed/embedded-comment cases in #91/#93.

## Approaches considered

1. **Patch each issue independently.** Small changes, but each command can make its own interpretation of content preservation and diagnostics. Rejected because it leaves inconsistent contracts across `close`, `sync`, `split`, and read views.
2. **Use one global before/after diagnostic equality rule for every write.** Simple to explain, but it would reject intentional repairs such as `rename` fixing E106 and could block legitimate state transitions. Rejected as too broad.
3. **Define shared contracts by issue cluster and enforce them in the affected paths.** A shared parser rule for comment visibility and ID reservation; explicit loss/error checks in the relevant write commands; stable read diagnostics; and focused output for Git verification and split. **Recommended.** This preserves command intent while making exceptions explicit and testable.

## Proposed contracts

### A. Markdown comments and reserved IDs (#91, #93; #84 regression coverage)

- A comment opener in a Markdown table row or a title stored in a table cell does not begin an HTML comment for ID scanning. `new` and `rename` reject raw `<!--` / `-->` in titles with a clear message because the same bytes in a generated Markdown heading can alter rendered content; users can write the spaced or entity form when they mean to discuss the delimiter.
- Comment state is derived from actual HTML comment spans outside fences and table rows. Properly closed comments continue to hide example tables, preserving existing behavior for intentionally commented-out examples.
- An unterminated comment produces W262 with its opening line. Issue-shaped table rows encountered after the opener remain reserved for allocation and are exposed in `citedRows` with an explanatory reason; malformed comment syntax must not make IDs reusable. This is conservative accounting: the rows remain hidden Markdown content until the comment is closed, but their IDs cannot be reissued.
- Comment state follows Markdown's actual span through headings. It is not reset at H2 boundaries; W262 identifies the unclosed opener so the author can repair it.
- `check`, `list --json`, `new --id`, and default allocation use the same parsed comment/table facts.

### B. Write preservation and diagnostics (#86, #90, #96)

- Writes that are meant to repair a mismatch (`rename`, `sync --titles`) may remove E106 only by making the changed side explicit. `close` is a state transition, not a repair: it refuses if any baseline error would disappear, except E102 for the exact issue being closed (that error is resolved by removing the open row). It names the lost diagnostic and a repair command. This prevents plain close from deleting evidence and prevents `--keep-body` from creating an archive that cannot be reopened.
- `sync --titles` requires an explicit choice when summaries differ. `--prefer table` explicitly keeps the table summary. Choosing the body title requires explicit `--prefer body` plus `--move-progress` to preserve the old summary as progress text or `--drop-progress` to discard it. Real title changes are reported on stderr in both dry-run and real runs. Existing W260 protections remain.
- `split` continues to split rows and does not invent bodies. If splitting creates W212, it succeeds with a clear stderr warning naming the affected IDs and recommending `rename` after the split. It must not silently turn a clean `--strict` ledger into a failing one.
- Avoid introducing a generic rule that all old diagnostics must remain byte-identical: commands with a repair purpose may resolve the diagnostics they directly address. Their output must identify material changes and preserve unique content unless the caller chose a discard path.

### C. Reopening semantics (#87)

- If a `close --keep-body` archive has body criterion A and the closed table stores a different value B, A remains the current acceptance criterion after reopen because it is the restored body. B is preserved under a distinct `**关闭时判据**` label as closure history. Without an archive, a non-empty `已修` cell becomes `**验收判据**`; other closed statuses retain the cell as `**关闭理由**`.
- Commit hash tokens preserved from a closed 判据 cell keep their exact characters. When the imported token is not already in inline code, `reopen` wraps it in backticks so W202 treats it as literal evidence, not pinned prose; unrelated unformatted hashes continue to warn. `--verify-commits` still verifies hashes in inline code.
- An empty criterion cell remains empty on reopen, and the command warns that the reopened issue needs acceptance criteria. W261 remains authoritative; `--strict` may therefore fail until the user adds criteria. Reopen itself must still succeed. W261's existing non-empty rule treats a hash-only cell as non-empty; this change does not add a second quality test for criterion content.
- Only `已修` is considered an acceptance-result status in the existing vocabulary; no additional closed status is reclassified.
- `close --keep-body` / `reopen` remains byte-faithful for valid archived bodies.

### D. Read views and status presentation (#88, #94, #95)

- `list --json`, `counts --json`, and `show --json` always include `diagnostics: {errors, warnings}` arrays, even when empty. Their values come from the same parsed snapshot and match `check --json` by code, line, and id. `check --json` retains its established top-level `errors` and `warnings` arrays.
- `check --json` and `counts --json` expose `citedRows` using the same shape and contents as `list --json`, omitting the field when empty to match the established optional-field convention.
- `list --priority P` reports when P occurs only in the other table, parallel to the existing status hint. Invalid priority values still exit 2.
- Text `check`/`counts` summaries list every open status actually present, including undeclared statuses. For a structurally valid ledger, the status counts sum to the open total. If structural errors create overlapping rows, the summary preserves the raw per-status counts and check diagnostics identify the invalid overlap. `list --status` continues allowing an undeclared status that actually occurs (useful for diagnosis), but prints a W220 warning; an unknown status absent from both tables still exits 2.
- `byStatus` retains its current raw, truthful mapping. W220 in diagnostics is the declaration signal; status words are not silently remapped to a synthetic bucket.

### E. Git verification and non-git directories (#89)

- If `--verify-commits` is requested outside a Git worktree, `check` emits W263 (`commit verification skipped: not a Git repository`) and completes with exit 0 (or 3 if ledger errors exist). Because W263 is a warning, `--strict --verify-commits` exits 3 until verification can run. A missing commit inside a Git worktree continues to produce W240. Verification inside a Git worktree keeps current behavior.
- The already-fixed `--expand --with-body` behavior remains covered by a regression assertion that expanded output equals the corresponding per-ID view and does not scale by rescanning all body blocks per expanded ID.

## Non-goals and constraints

- Do not modify `src/io.ts`; all writes continue through the existing CLI lock and atomic-write path.
- Do not edit the external test ledger.
- Do not silently discard any text from the table summary during title synchronization.
- Do not make a malformed comment itself block all read/write access to the ledger; report it and preserve IDs conservatively.
- Keep `#84` free-form table behavior and existing closed-comment/fenced-comment tests intact.
- Maintain byte preservation for BOM, line endings, final newline, and unrelated lines.

## Verification expectations

- Add targeted failing tests before implementation for each contract, including #91/#93 through both `new --body-file` and `new --title`; `close` with E106/E110 and with unrelated baseline errors; all `sync --titles` preference paths; `split` creating W212; reopen of `已修`, rationale statuses, commit evidence, and empty criteria; stable JSON diagnostics and cited IDs; status/priority filtering; and verification outside Git.
- Run `npm run typecheck && npm test`, then `npm run build` after the implementation is ready to integrate, per the repository handoff.
- Validate canonical fixtures and the real ledgers read-only. Do not write tester status updates.

## Decisions and implementation calls

Owner selected the recommended behavior for the four high-impact choices:

1. **Unclosed comments reserve IDs.** Rows after an unclosed comment remain cited even though Markdown hides them; W262 points to the opener. Properly closed comments and fenced examples keep current visibility behavior.
2. **Title replacement needs explicit choice.** When sync would replace unique summary text, the user must choose the body or table side; preserving or discarding body-preference text uses `--move-progress` / `--drop-progress`.
3. **Close cannot make errors disappear.** Preserve every baseline error diagnostic across close except E102 for the exact row being closed. This allows closing a deliberately bodyless issue while preventing close from hiding E106/E110 or other existing errors.
4. **Archived body criterion wins after reopen.** Restore the archived body criterion as current. If the closed-table cell differs, preserve that value under `**关闭时判据**` as history.

Builder questions are resolved as follows:

- Raw `<!--` / `-->` in `new` or `rename` titles is refused because these bytes have Markdown comment meaning in generated headings; the diagnostic will suggest a spaced or entity spelling.
- When no archive exists, only `已修` restores the table cell as `**验收判据**`; all other closed statuses use `**关闭理由**`. No other current status word means success of a fix.
- Reopened closed-table hash tokens keep their exact characters. If a token was plain text, `reopen` wraps it in inline code so W202 treats it as literal evidence; existing inline code stays unchanged. `--verify-commits` still verifies hashes inside inline code.
- An empty criterion cell remains empty on reopen, and the command warns that the reopened issue needs acceptance criteria. W261 remains authoritative; `--strict` may therefore fail until the user adds criteria. Reopen itself must still succeed. W261's existing non-empty rule treats a hash-only cell as non-empty; this change does not add a second quality test for criterion content.
- For structurally valid ledgers, count breakdowns sum to totals. If duplicate/overlapping rows make the ledger invalid, keep per-status counts truthful and expose the overlap through existing structural errors rather than assigning an ID to an arbitrary status.
- W263 is a warning for skipped commit verification outside Git. Normal check can succeed with the warning; `--strict` fails because verification was explicitly requested but could not run.
- `split` emits a warning and succeeds if it introduces W212; rejecting would block the per-ID rename needed to resolve the duplicate.

## Verification expectations

- Add targeted failing tests before implementation for each contract, including #91/#93 through both `new --body-file` and `new --title`; closing with E106/E110 and with unrelated baseline errors; all `sync --titles` preference paths; `split` creating W212; reopen of `已修`, rationale statuses, commit evidence, and empty criteria; stable JSON diagnostics and cited IDs; status/priority filtering; and verification outside Git.
- Run `npm run typecheck && npm test`, then `npm run build` after the implementation is ready to integrate, per the repository handoff.
- Validate canonical fixtures and the real ledgers read-only. Do not write tester status updates.
