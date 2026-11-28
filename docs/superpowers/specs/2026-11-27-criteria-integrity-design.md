# Criteria integrity design

## Intent

Prevent issuemd from silently misreading or deleting acceptance criteria when bold prose resembles a label, when criteria use nearby labels, or when criteria are split across repeated blocks. This serves ledger authors and agents who rely on `show`, `list --with-body`, `check`, and `close` as faithful views of issue requirements.

## Current evidence

- A fully bold sentence inside a criteria list matches the standalone-label grammar. `labelBlock()` ends the criteria block there; later criteria are omitted from `show` and can be lost by ordinary `close`.
- Ordinary bold-leading prose with text outside the closing `**` was corrected in round 21.
- `sync --criteria-labels` can rename one unambiguous nearby criteria label, but `new` and `body` do not surface the actionable hint at write time, and sync receipts omit the source line.
- W264 protects a recognized nearby criteria label after canonical criteria, but only reports one candidate. Multiple canonical criteria blocks are flattened into one cell; W206 warns, yet `close` can still discard their grouping.
- Criteria currently use a legacy one-line table value. A literal `；` inside one criterion is ambiguous after flattening.

## Approaches

1. **Require explicit labels everywhere.** Reject or ignore every standalone bold line. This removes ambiguity but breaks existing valid labels such as `**关联**` and would require broad migration.
2. **Keep parsing and rely on W261/W206.** This preserves behavior but leaves the destructive close path available when criteria were cut off or flattened.
3. **Preserve the existing syntax with a narrow sentence safeguard, retain raw criteria blocks in JSON, and gate destructive close when grouping or recognized supplements are ambiguous.** This is the recommended approach: it fixes the demonstrated data-loss shape without removing compact labels, makes batch reads faithful, and lets explicit `--criteria` serve as a reviewed merge.

## Design

### Label interpretation

- Preserve the existing label grammar, including custom standalone labels that end in punctuation. Do not globally reinterpret existing labels.
- Do not recognize a label line inside an HTML comment or a fence; use the shared comment/fence visibility rules for label discovery and criteria extraction. Keep the raw comment lines in body output.
- Add W268 for a standalone bold line after a canonical `验收判据` label that ends in sentence punctuation and appears after at least one criterion list item. Detect it as a boundary that interrupts criteria, including unspaced CJK sentences. Include its source line and label text, and explain that prose can be rewritten with only the emphasis word bolded; otherwise use reviewed `--criteria` or `--keep-body`. Keep the current label grammar; a legitimate custom label in this position may also warn, and the user can resolve the ambiguity with explicit close input.
- Add regressions for a fully bold sentence between criteria items, a compact punctuation-ending custom label such as `**待确认？**` in that position, a multiline comment, ordinary bold-leading prose, colon labels, and fenced examples.

### Structured read output

- Add an additive occurrence-based `criteriaBlocks` array to `show --json` and `list --json --with-body`. Each entry is `{ line, label, kind, lines }`: `line` is a 1-based absolute ledger line; `lines` includes the label line and owned content, with only trailing blank lines trimmed as in `labelBlock()`; `kind` is `canonical` or `supplement`.
- Include every canonical occurrence, including empty and identical repeated blocks. Include non-empty recognized criteria aliases only when they occur after the first canonical block. An earlier alias remains descriptive for compatibility with the existing precedence rule; `关闭时判据` remains historical information, not a supplement.
- Resolve the same body owner for single-item and batch views. For a closed item, derive blocks only from a unique usable archive payload, using its source offset; omit the field when the payload is missing or ambiguous. The closed `criteria` value continues to come from the table.
- Keep the existing flat `criteria` and named `labels` fields unchanged for compatibility.

### Close safety

- A close that would delete the body refuses automatic promotion when W268 applies, when there are multiple non-empty canonical criteria blocks, or when a non-empty recognized supplement follows canonical criteria. Apply the same eligibility and visible-content checks to W264 and the close guard; comment-only blocks do not count. Report every affected source line and recommend reviewed `--criteria` text or `--keep-body`.
- Aliases before the first canonical block remain descriptive and are not promoted or guarded, matching the existing exact-label precedence rule. `关闭时判据` remains historical information.
- Explicit `--criteria` and `--no-criteria` remain reviewed ways to choose the table value. `--keep-body` retains the source block even when automatic promotion is used.
- W206/W264/W268 diagnostics identify all relevant label lines, not only the later one.
- On `reopen` of an older archive whose parsed criteria now differs from the stored table value, keep archive source lines unchanged and preserve the differing table value as `**关闭时判据**`; do not infer whether it was automatically or explicitly set.
- Do not add a new merge flag in this slice.

### Write-time nearby-label guidance

- When `new` or `body` would leave a non-empty recognized criteria alias that W261 cannot promote, report the alias and source line. Suggest `sync --criteria-labels` only when its eligibility rules are satisfied; otherwise explain that the caller must resolve the ambiguity or edit the body explicitly.
- Include source line numbers in sync preview and write receipts.
- Preserve ambiguity behavior: do not rename when a canonical label exists or several aliases make the choice unclear.
- Explain that the closed table column `判据` is populated from the body label `**验收判据**`.

## Goals

- Sentence-like bold boundaries cannot silently hide criteria from destructive close.
- All canonical criteria blocks and their source locations are visible through JSON; `body.content` remains the faithful source when a suspicious boundary is reported.
- Ambiguous destructive promotion requires explicit review.
- Existing compact labels, colon labels, legacy flat criteria, and stdout contracts remain compatible.

## Non-goals and known limit

- Do not change the closed table schema or invent boundaries inside historical flat criteria values.
- A literal semicolon within one criterion remains ambiguous in the legacy closed cell; the raw JSON block representation and `--keep-body` preserve source evidence. A versioned reversible cell encoding is a separate design decision.
- Do not rewrite either external dogfooding ledger.

## Verification

Add focused regressions before implementation for the fully bold sentence, close refusing multi-block criteria without explicit criteria, explicit criteria close succeeding, line-addressed aliases, and structured output parity across `show`, `list --with-body`, and archived reads. Then run the full typecheck and test suite, build `dist/`, and recheck the three external ledgers read-only.