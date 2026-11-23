# Fixtures and CLI Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the synthetic acceptance inputs and build a Node CLI that matches lilmd’s Markdown command behavior for P0.

**Architecture:** Copy Markdown modules from the local lilmd checkout. Compile the TypeScript entry point and modules with npm and keep Bun for test execution.

**Tech Stack:** TypeScript, Node.js, npm, Bun.

**Spec:** `docs/spec.md`, sections 9, 12 and 13.

## Global Constraints

- Binary `issuemd`, npm package `@blrbiran/issuemd`, zero runtime dependencies.
- Use synthetic ledgers. F2 and F3 are inputs for `adopt`; F4 is input for the write-preservation tests.
- This plan covers P0. The write-safety changes and ledger verbs belong to subsequent phases.

## Review Focus

- Verify that relative paths resolve from outside the project, the bin works under Node, stdin reads work, JSON is free of extra output, and a dry run leaves the source intact.

### Task 1 — Synthetic fixtures

- [x] Create `fixtures/cafe-shaped.md` with 13 closed issues retaining bodies, and `fixtures/orca-shaped.md` with 11 missing separators and 12 count headings. Record hand-checked counts and decisions in `fixtures/*.expected.json`.
- [x] Create `fixtures/crlf-bom.md` with BOM, CRLF, and no trailing newline. Preserve its representation in `.gitattributes`.
- [x] Add the fixture integrity assertions in `tests/fixtures.test.ts` and verify with `bun test tests/fixtures.test.ts`.

### Task 2 — Node CLI and P0 tests

- [x] Add `tests/bin.test.ts` to exercise the compiled bin, including argv parsing, stdin, TOC, JSON, a dry run from another cwd and absence of omitted commands in help. Run it before compiling the bin and observe that the bin is missing.
- [x] Copy `src/{cli,index,scan,sections,select,render,write}.ts`, companion unit tests, and `bin/lilmd.ts` as `bin/issuemd.ts`. Remove the vector, embedding, image help and pretty paths plus their tests. Replace upstream integration corpus coverage with synthetic inputs.
- [x] Set `package.json#bin.issuemd` to `dist/bin/issuemd.js` and use `tsconfig.json` for Node ESM output. Run `npm test` and `npm run typecheck`.
- [x] Compare the compiled binary and installed lilmd on all four synthetic fixtures using identical arguments. Verify `npm link` and invoke `issuemd` outside the project using an isolated npm prefix. Install a locally packed tarball separately to check the packaged bin and its module resolution.
