# Archive and Integrity Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the reviewed hash-repair safeguards and replace ambiguous kept-body archives with a shared, line-counted v3 format while preserving v2 and legacy data.

**Architecture:** Keep Markdown source normalization and heading parsing in the existing scanner/ledger modules. Add one shared archive discovery and validation path, then route all writers/readers/checks through it. Use the v3 `lines:N` record count to distinguish payload from framing; keep the exact committed v2 grammar and the in-flight positional v2 separator variant compatible.

**Tech Stack:** TypeScript, Bun tests, existing CLI `run()`, `parseLedger()`, scanner helpers, and atomic `commit()` write gate.

**Spec:** `docs/superpowers/specs/2026-11-28-archive-envelope-v3-design.md`

## Global Constraints

- Do not modify the three external dogfooding ledgers.
- Preserve existing CLI output/JSON fields; add only `body.lineCount` for archive views.
- V3 `N` counts exact payload line records, including empty/whitespace-only lines; the frame is a separate, exactly empty record.
- W201 counts `Buffer.byteLength(payloadLines.join("\n"))` and the N line records, excluding metadata and frame.
- V2 and markerless legacy archives keep their specified grammars; V2 literal `lines:N` remains payload, and the in-flight positional separator suffix remains compatible.
- A writer must validate the serialized candidate archive before committing issue state/body changes; W269 alone cannot guard a write.
- Reopen must verify that the restored body contains the exact archived payload records before writing; table-only criteria history remains a separate appended `关闭时判据` label.
- All tests and builds run locally; commit only after full review and verification; never push.

## Review Focus

- A heading-shaped line inside raw HTML/comment/fence cannot split the archive owner or make an example a prune target; pin in Task 1.
- V3 N=0, one empty record, multiple edge blanks, marker text inside payload, and frame/end offsets remain distinguishable; pin in Tasks 2–4.
- Unclosed `<pre>`, comment, or fence makes close/adopt refuse before any bytes change; closed `</div>` with a frame blank succeeds; pin in Task 3.
- V2 positional separator archives remain readable/reopenable while a literal separator elsewhere in v2 payload remains data; pin in Task 2.
- Link titles, email autolinks, ordered-list continuation, escaped backticks, reference-definition titles, and multiline HTML attributes are never rewritten by hash repair; pin in Task 5.

---

### Task 1: Shared visible archive inventory

**Files:**
- Modify: `src/ledger.ts`
- Modify: `src/ledger-check.ts`
- Modify: `src/ledger-read.ts`
- Modify: `src/cli.ts`
- Test: `src/review-regression.test.ts`, `src/round25.test.ts`

**Interfaces:**
- Produce `archiveInventory(ledger) -> { archives: ArchiveSection[]; appendixSections: Section[]; masks: ArchiveMasks }` in `src/ledger.ts`.
- `ArchiveMasks` contains one fence/comment/raw-HTML visibility result for the immutable `ledger.lines` array; `ArchiveSection` contains the owning visible appendix, genuine visible H3 heading, and its next genuine H1–H3 boundary.
- Envelope malformation diagnostics are added by Task 2's version-aware validator and attached to the inventory result there.
- [x] **Step 1: Write failing visibility tests**

  Cover fake archive H3 lines inside `<pre>`, block HTML including standalone `<span>`, comments, fences, a real archive after a hidden fake heading, and an append target whose `## 附录` is itself hidden.

- [x] **Step 2: Run the tests to confirm failure**

  Run: `bun test src/review-regression.test.ts src/round25.test.ts`
  Expected: a hidden example is currently considered a prune candidate or causes the real archive boundary to be wrong.

- [x] **Step 3: Implement the shared inventory**

  Scan masks once per immutable ledger line array; filter heading candidates through fences, multiline comments, and raw-HTML blocks; derive archive H3 end lines from the next visible heading. Keep `Section` parsing for the rest of the ledger unchanged.

- [x] **Step 4: Route archive consumers through the inventory**

  Replace each archive-specific `sections.filter(...)`/marker scan in check, read, reopen, prune, metrics, and hash repair with this inventory. Preserve current ownership/range checks.

- [x] **Step 5: Run focused tests**

  Run: `bun test src/review-regression.test.ts src/round20.test.ts src/round21.test.ts src/round22.test.ts src/round23.test.ts src/round24.test.ts src/round25.test.ts`
  Expected: hidden examples are ignored; genuine adjacent archives retain their own payloads.

### Task 2: Version-aware v2/v3 payload locator

**Files:**
- Modify: `src/ledger.ts`
- Modify: `src/ledger-read.ts`
- Modify: `src/ledger-check.ts`
- Test: `src/review-regression.test.ts`, `src/round20.test.ts`, `src/round21.test.ts`, `src/round22.test.ts`, `src/round24.test.ts`, `src/round25.test.ts`

**Interfaces:**
- Add `KEPT_BODY_VERSION_V2`, `KEPT_BODY_VERSION_V3`, `KEPT_BODY_LINES_PREFIX`, and a parser for the exact standalone `<!-- issuemd:kept-body:lines:N -->` syntax; N is `0` or a positive decimal integer with no leading zero and must be a safe integer.
- Extend the archive locator result with `{ version: "v2" | "v3" | "legacy"; start; end; finalNewline; payloadLineCount; framingEnd; refusal? }`.
- V3 dispatch selects the fixed version slot, validates start and line-count metadata, reads exactly N records, verifies the distinct empty frame and end marker at calculated offsets, and then checks visibility/ownership.
- V2 dispatch preserves the committed grammar and the in-flight positional separator suffix. Malformed V2 end-before-start, duplicate visible ends, or hidden-only ends refuse; v2 metadata-like payload text is not reinterpreted.

- [x] **Step 1: Write failing locator tests**

  Cover N=0, one empty record, trailing blank records, v3 literal version/start/lines/end text inside payload, misplaced/duplicate metadata outside the payload, calculated end hidden by raw HTML/comment/fence, malformed v2 marker order, and positional v2 separator compatibility.

- [x] **Step 2: Run focused tests to confirm failure**

  Run: `bun test src/review-regression.test.ts src/round20.test.ts src/round21.test.ts src/round22.test.ts src/round24.test.ts`
  Expected: current readers count markers rather than deriving the v3 boundary from N.

- [x] **Step 3: Implement shared v2/v3 parsing**

  Keep v2 and legacy parsing as explicit branches. For v3, compute `payloadStart = linesMetadataLine + 1`, `frameLine = payloadStart + N`, and `endLine = frameLine + 1`; validate exact line contents, integer range, visible owner and end, and no record truncation. For v2, require end strictly after start and preserve the positional separator compatibility suffix.

- [x] **Step 4: Add W269 and fail-closed read behavior**

  Emit W269 for malformed/displaced/unsupported version declarations or malformed v2/v3 boundaries. `show`/`list` withhold archive bodies; W201/W202 do not treat malformed subtrees as valid payloads.

- [x] **Step 5: Run focused tests**

  Run: `bun test src/review-regression.test.ts src/round20.test.ts src/round21.test.ts src/round22.test.ts src/round24.test.ts`
  Expected: all versioned marker and payload-boundary cases pass.

### Task 3: V3 serialization and write-time validation

**Files:**
- Modify: `src/ledger-edit.ts`
- Modify: `src/cli.ts`
- Modify: `src/adopt.ts`
- Modify: `src/ledger.ts`
- Test: `src/review-regression.test.ts`, `src/round20.test.ts`, `src/round22.test.ts`, `src/round25.test.ts`, `src/adopt.test.ts`, `src/dogfood.test.ts`

**Interfaces:**
- Add `serializeKeptBodyV3(id, summary, payloadLines) -> string[]` to `src/ledger-edit.ts`; it writes v3 header, exact `lines:N`, N payload records, one empty frame, and the calculated end marker.
- Add `validateSerializedArchive(ledger, id, expectedPayloadLines) -> string | undefined` in `src/ledger.ts`; it verifies one visible v3 owner, a valid locator result, and exact equality of the located payload records.
- `close --keep-body` and the archive-producing adopt path use `serializeKeptBodyV3`; adopt applies its existing normalization and `（空）` placeholder before counting.

- [x] **Step 1: Write failing writer tests**

  Cover close/adopt with zero lines, one empty line, trailing whitespace lines, literal v2/v3 marker lines through normal body input, a closed `<div>`, unclosed `<pre>` and fence, an unclosed comment closed by the generated end marker with W262 retained, and hidden/invalid appendix insertion target. Assert unsafe cases refuse without changing source bytes and literal markers survive valid archives.

- [x] **Step 2: Run tests to confirm failure**

  Run: `bun test src/review-regression.test.ts src/round22.test.ts src/adopt.test.ts`
  Expected: close/adopt currently emit v2 without a count-derived payload boundary; their archive output has no stable record count for literal markers/edge blanks.

- [x] **Step 3: Implement the v3 serializer**

  Serialize N from the exact payload array after close/adopt normalization; do not trim or synthesize payload records in the serializer. Add the separate empty frame line after N records.

- [x] **Step 4: Validate the final candidate before write**

  Build the complete candidate archive, derive the shared inventory, and refuse if the archive owner/end is hidden by a fence/raw-text HTML block or payload records differ from the requested records. A multiline comment in payload may be closed by the calculated v3 end marker and must retain W262. Do not rely on warning-only W269 in the generic errors-only commit gate.

- [x] **Step 5: Run focused tests**

  Run: `bun test src/review-regression.test.ts src/round19.test.ts src/round20.test.ts src/round22.test.ts src/adopt.test.ts src/dogfood.test.ts`
  Expected: valid v3 archives are readable and unsafe writers fail without changing bytes.

### Task 4: Reopen, prune, and payload views

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/ledger.ts`
- Modify: `src/ledger-read.ts`
- Modify: `src/ledger-check.ts`
- Test: `src/review-regression.test.ts`, `src/round20.test.ts`, `src/round21.test.ts`, `src/round22.test.ts`, `src/round25.test.ts`

**Interfaces:**
- `archivePayloadRange()` is the single source for payload lines, v2/v3 end offsets, and W201/W202 scope.
- Archive JSON adds `body.lineCount` while retaining string-valued `body.content`/`body.text`; text is LF-joined records plus one LF when N>0, empty for N=0.
- `reopen` validates the candidate restored body records against the source archive records before writing. Existing table-only criteria history is appended as `关闭时判据` after payload validation.

- [x] **Step 1: Write failing reader/reopen/prune tests**

  Cover show, `--body-only`, list JSON, W201, W202, reopen, and prune for N=0, N=1 empty, edge blank records, v3 marker-shaped payload records, v2 literal metadata/positional separator, table-only criteria history, H4 notes after end, sibling H3 archives, and no-final-newline EOF.

- [x] **Step 2: Run focused tests to confirm failure**

  Run: `bun test src/review-regression.test.ts src/round20.test.ts src/round21.test.ts src/round22.test.ts src/round24.test.ts src/round25.test.ts`
  Expected: archive views disagree on current marker scanning and reopen does not have a v3 record-count assertion.

- [x] **Step 3: Route consumers and restore exact records**

  Use the shared locator for show/list/check/reopen/prune. Reopen copies exactly N payload records, applies `关闭时判据` separately when needed, then checks the candidate body lines before the atomic write.

- [x] **Step 4: Implement prune rules**

  Accept one verified v2/v3 archive owned by one closed singleton. Keep every non-target appendix byte unchanged. Preserve all trailing blank records for terminated files; for an unterminated EOF target, remove only empty records that become terminal, preserve whitespace-only and nonblank records, or refuse if another archive inventory changes.

- [x] **Step 5: Run focused tests**

  Run: `bun test src/review-regression.test.ts src/round20.test.ts src/round21.test.ts src/round22.test.ts src/round24.test.ts src/round25.test.ts`
  Expected: payload views, W201, reopen, and prune agree for all valid versions.

### Task 5: Finalize hash/comment repair review findings

**Files:**
- Modify: `src/scan.ts`
- Modify: `src/hash-scan.ts`
- Modify: `src/ledger-edit.ts`
- Modify: `src/ledger.ts`
- Modify: `src/ledger-check.ts`
- Modify: `src/cli.ts`
- Test: `src/review-regression.test.ts`, `src/round24.test.ts`

**Interfaces:**
- `multilineInlineCodeRanges(lines, fenced)` respects escaped opener runs, closing runs inside code, blank/thematic/heading/list interruption rules, and only matched delimiter pairs.
- `markdownLinkDestinationRanges(lines)` protects destination and title spans, including angle destinations, balanced/escaped parentheses, multiline destinations, and reference-definition titles.
- `htmlTagRanges(lines)` protects quoted attributes across lines; email and URL autolinks are reported as non-repairable spans.

- [x] **Step 1: Write failing scanner/comment tests**

  Cover reference link titles on following lines, `<123+deadbee@x.y>` email autolinks, valid spans closed by a backslash-preceded backtick, an ordered `2.` line inside a continuing paragraph, list-block interruption, escaped `\\<!--`, comment closure followed by visible text, HTML comment syntax inside multiline code, last-body-line W202 ownership, empty plus nonempty criteria aliases, and thousands of safe link ranges. Pin the intentional scope: `check` may report W202 inside raw HTML, while automatic repair skips raw HTML with a reason; do not silently rewrite it.

- [x] **Step 2: Run focused tests to confirm failure**

  Run: `bun test src/review-regression.test.ts src/round24.test.ts`
  Expected: at least one protected title/email/code/comment case is rewritten or misclassified by the current scanner.

- [x] **Step 3: Implement minimal scanner corrections**

  Pair equal delimiter runs with Markdown opener/closer escape rules, reset only at actual block interruptions, append range entries in place, and build range masks lazily only when W202 occurrences exist. Preserve explicit line/column/id ownership for the final line of each open body.

- [x] **Step 4: Run focused tests**

  Run: `bun test src/review-regression.test.ts src/round24.test.ts`
  Expected: protected source bytes remain identical and ordinary W202 prose remains repairable.

### Task 6: Docs, full verification, review, merge

**Files:**
- Modify: `docs/spec.md`
- Modify: `skills/issuemd/SKILL.md`
- Modify: `README.md` if command/format guidance changes
- Modify: `docs/handoff/handoff.md`
- Full test suite

- [x] **Step 1: Document v3, v2 compatibility, W269, and safe hash repair**

  State the exact line-count/frame rules, payload lineCount/JSON behavior, adoption normalization, malformed archive outcomes, and safe hash-repair exclusions. Keep historical v2 and legacy handling explicit.

- [x] **Step 2: Run full verification**

  Run: `npm run typecheck && npm test && npm run build && git diff --check`
  Expected: all tests pass, build succeeds, no whitespace errors.

- [x] **Step 3: Review final diff and verify external ledgers read-only**

  Confirm dogfood/cafe/Orca archive checks and before/after SHA-256 values. Do not modify those files.

- [ ] **Step 4: Review and commit the current branch**

  Stage the reviewed working tree, inspect the staged diff, get a fresh code review and commit review, then commit with a Conventional Commit message and Claude attribution.

- [ ] **Step 5: Fast-forward merge to `main` and build**

  Confirm the feature branch is a direct descendant, switch to `main`, `git merge --ff-only`, then run `npm run build`. Do not push.

- [ ] **Step 6: Start a new feature branch for remaining dogfooding work**

  After the merge/build, open a separate `fix/dogfooding-followups` branch before further code changes. Record deferred independent tasks in the final handoff.
