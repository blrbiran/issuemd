/**
 * issuemd CLI — a single-file issue ledger tool.
 *
 * One entry point, one spelling per action:
 *   issuemd check   FILE [--json] [--strict] [--verify-commits]
 *   issuemd list    FILE [--status S] [--priority P] [--closed] [--json]
 *   issuemd show    FILE ID [--json] [--label NAME]
 *   issuemd counts  FILE [--json]
 *   issuemd read    FILE <H2 标题>
 *
 * The write verbs (new/close/reopen/status/rename/sync) live below the read
 * verbs and all end in the same gate: build lines → re-check in memory →
 * print a diff or replace the file atomically.
 *
 * Exit codes:
 *   0  success
 *   1  no such issue / empty result
 *   2  usage or I/O error
 *   3  ledger validation failed
 */

import { parseArgs, type ParseArgsConfig } from "node:util";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

import { scan } from "./scan.js";
import { buildSections, countLines } from "./sections.js";
import { joinDocument, readDocument, writeAtomically, type Document } from "./io.js";
import { parseId, compareIds, type IdSpan } from "./issue-id.js";
import { bodyBlocks, maxIssueId, parseLedger, type Diagnostic } from "./ledger.js";
import { checkLedger, STATUS_CLASSES } from "./ledger-check.js";
import {
  bodySkeleton,
  extractCriteria,
  formatRow,
  guideBlockLines,
  insertLines,
  markerPair,
  removeLines,
  endsInFence,
  fencedLines,
  replaceCell,
  rewriteBlock,
  statusBlockLines,
  tableRange,
} from "./ledger-edit.js";
import {
  filterRows,
  findLabel,
  findRow,
  formatIssueRow,
  labelsIn,
  spanText,
  summaryLine,
  toListedIssue,
  viewIssue,
} from "./ledger-read.js";
import { unifiedDiff } from "./write.js";
import { adopt, type Decision } from "./adopt.js";

const HELP = `issuemd — read and maintain a single-file Markdown issue ledger

Usage:
  issuemd check   FILE [--json] [--strict] [--verify-commits]
  issuemd list    FILE [--status S] [--priority P] [--closed] [--json]
  issuemd show    FILE ID [--json] [--label NAME]
  issuemd counts  FILE [--json]
  issuemd read    FILE <H2 heading>

  [write — atomic, keeps BOM/line endings/mode; --dry-run prints a diff]:
  issuemd new     FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-]
  issuemd close   FILE ID [--criteria TEXT | --criteria-from-body] [--keep-body]
  issuemd reopen  FILE ID
  issuemd status  FILE ID NEW_STATUS
  issuemd rename  FILE ID "NEW TITLE"
  issuemd sync    FILE [--guide | --fix-tables | --titles [--prefer body|table]
                        [--move-progress | --drop-progress]]
  issuemd adopt   FILE [--dry-run] [--report PATH]

Options:
  --json                    machine-readable JSON output
  --strict                  check: fail on warnings (W250 is informational and never fails)
  --verify-commits          check: verify commit references in the ledger directory
  --status <S>              list: filter by status
  --priority <P>            list: filter by priority
  --closed                  list: show the closed table instead of the index
  --label <NAME>            show: print only the **NAME** paragraph
  --title <T>               new: summary/body title
  --id <N>                  new: explicit issue id
  --body-file <path|->      new: body from a file, or '-' for stdin
  --criteria <TEXT>         close: criteria column text
  --criteria-from-body      close: lift the **验收判据** block into the column (the default
                            when the body has one); refuses if it is missing or empty
  --no-criteria             close: close with an empty criteria cell on purpose
  --keep-body               close: move the body into 附录 instead of deleting it
  --guide                   sync: rewrite the controlled guide and status blocks
  --fix-tables              sync: add missing table separator rows
  --titles                  sync: align body headings with index summaries
  --prefer <body|table>     sync --titles: which side wins (default body)
  --move-progress           sync --titles: move progress text into the body
  --drop-progress           sync --titles: discard progress text
  --report <path>           adopt: write the decision list to a file
  --dry-run                 write: print a unified diff, don't modify the file

Exit codes: 0 ok, 1 no such issue, 2 usage error, 3 ledger validation error.
`;

export type CliResult = { code: number; stdout: string; stderr: string };

function ok(s: string): CliResult {
  return { code: 0, stdout: s, stderr: "" };
}
function noMatch(s: string): CliResult {
  return { code: 1, stdout: s, stderr: "" };
}
function err(s: string, code = 1): CliResult {
  return { code, stdout: "", stderr: s };
}

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  strict: { type: "boolean" },
  "verify-commits": { type: "boolean" },
  // list
  status: { type: "string" },
  priority: { type: "string" },
  closed: { type: "boolean" },
  // show
  label: { type: "string" },
  // shared write options
  "dry-run": { type: "boolean" },
  // new
  title: { type: "string" },
  id: { type: "string" },
  "body-file": { type: "string" },
  // close
  criteria: { type: "string" },
  "criteria-from-body": { type: "boolean" },
  "no-criteria": { type: "boolean" },
  "keep-body": { type: "boolean" },
  // sync
  guide: { type: "boolean" },
  "fix-tables": { type: "boolean" },
  titles: { type: "boolean" },
  prefer: { type: "string" },
  "move-progress": { type: "boolean" },
  "drop-progress": { type: "boolean" },
  // adopt
  report: { type: "string" },
} satisfies NonNullable<ParseArgsConfig["options"]>;

export async function run(argv: string[]): Promise<CliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    return err(`issuemd: ${(e as Error).message}\n${HELP}`, 2);
  }

  const { values, positionals } = parsed;
  const head = positionals[0];
  if (values.help || head == null) {
    return values.help ? ok(HELP) : err("issuemd: missing command. Try 'issuemd list FILE' or 'issuemd --help'\n", 2);
  }

  switch (head) {
    case "check":
      return cmdCheck(positionals.slice(1), values);
    case "list":
      return cmdList(positionals.slice(1), values);
    case "show":
      return cmdShow(positionals.slice(1), values);
    case "counts":
      return cmdCounts(positionals.slice(1), values);
    case "read":
      return cmdRead(positionals.slice(1));
    case "new":
      return cmdNew(positionals.slice(1), values);
    case "close":
      return cmdClose(positionals.slice(1), values);
    case "reopen":
      return cmdReopen(positionals.slice(1), values);
    case "status":
      return cmdStatus(positionals.slice(1), values);
    case "rename":
      return cmdRename(positionals.slice(1), values);
    case "sync":
      return cmdSync(positionals.slice(1), values);
    case "adopt":
      return cmdAdopt(positionals.slice(1), values);
    default:
      return err(
        `issuemd: unknown command '${head}'. Try 'issuemd list FILE' or 'issuemd --help'\n`,
        2,
      );
  }
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

// ---- shared helpers ----------------------------------------------------

/**
 * Read `file` from disk or stdin. Returns a CliResult on failure so callers
 * can just forward it — no raw ENOENT stack traces reach the user.
 */
function loadFile(file: string): { src: string } | CliResult {
  try {
    const src = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
    return { src };
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException).code === "ENOENT"
      ? `issuemd: cannot open '${file}': not found\n`
      : `issuemd: cannot open '${file}': ${(e as Error).message}\n`;
    return err(msg, 2);
  }
}

/** `parseLedger` returns diagnostics instead of throwing; views need them up front. */
function unusableLedger(ledger: ReturnType<typeof parseLedger>): CliResult | null {
  const missing = ledger.errors.filter(({ code }) => code === "E120");
  if (missing.length === 0) return null;
  return err(missing.map(({ code, message }) => `${code}: ${message}`).join("\n") + "\n", 3);
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map(({ code, line, id, message }) => `  L${line}${id ? ` #${id}` : ""} ${code}: ${message}`)
    .join("\n");
}

/** Ends a `close --keep-body` archive in 附录; `reopen` restores up to it. */
const KEPT_BODY_END = "<!-- issuemd:kept-body:end -->";

/** Drop leading and trailing blank lines; internal ones are content. */
function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

// ---- read commands -----------------------------------------------------

function cmdCheck(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) {
    return err("usage: issuemd check FILE [--json] [--strict] [--verify-commits]\n", 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  try {
    const report = checkLedger(loaded.src, file, {
      strict: v.strict,
      verifyCommits: v["verify-commits"],
    });
    const code = report.ok ? 0 : 3;
    if (v.json) return { code, stdout: JSON.stringify(report, null, 2) + "\n", stderr: "" };
    const lines = [`file: ${file}`, summaryLine(report.counts)];
    for (const [severity, diagnostics] of [["error", report.errors], ["warning", report.warnings]] as const) {
      const groups = new Map<string, Diagnostic[]>();
      for (const diagnostic of diagnostics) {
        const group = groups.get(diagnostic.code) ?? [];
        group.push(diagnostic);
        groups.set(diagnostic.code, group);
      }
      for (const [groupCode, group] of groups) {
        lines.push(`${severity} ${groupCode} x${group.length}`);
        for (const { line, id, message, expected, actual } of group.slice(0, 3)) {
          const details = expected === undefined
            ? ""
            : ` (expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)})`;
          lines.push(`  L${line}${id ? ` #${id}` : ""}: ${message}${details}`);
        }
        if (group.length > 3) lines.push(`  … (${group.length - 3} more, use --json for all)`);
      }
    }
    lines.push(`${report.errors.length} errors, ${report.warnings.length} warnings`);
    return { code, stdout: lines.join("\n") + "\n", stderr: "" };
  } catch (error) {
    return err(`issuemd check: ${(error as Error).message}\n`, 2);
  }
}

function cmdList(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) {
    return err("usage: issuemd list FILE [--status S] [--priority P] [--closed] [--json]\n", 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const ledger = parseLedger(loaded.src);
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;

  const table = v.closed ? "closed" : "open";
  const rows = filterRows(ledger.rows[table], { status: v.status, priority: v.priority });
  if (v.json) {
    const body = JSON.stringify(
      { file, table, issues: rows.map((row) => toListedIssue(row, table)) },
      null,
      2,
    );
    return rows.length === 0 ? { code: 1, stdout: body + "\n", stderr: "" } : ok(body);
  }
  if (rows.length === 0) return noMatch("(no issues)\n");
  return ok(rows.map(formatIssueRow).join("\n"));
}

function cmdCounts(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) return err("usage: issuemd counts FILE [--json]\n", 2);
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const report = checkLedger(loaded.src, file);
  const unusable = unusableLedger(parseLedger(loaded.src));
  if (unusable) return unusable;
  if (v.json) return ok(JSON.stringify({ file, counts: report.counts }, null, 2));
  return ok(summaryLine(report.counts) + "\n");
}

function cmdShow(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const id = rest[1];
  if (file == null || id == null || rest.length !== 2) {
    return err("usage: issuemd show FILE ID [--json] [--label NAME]\n", 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const ledger = parseLedger(loaded.src);
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;
  const view = viewIssue(ledger, id);
  if (!view) return noMatch(`(no such issue: ${id})\n`);

  if (v.label != null) {
    const range = view.body ?? { line: view.line, end: view.line };
    const found = findLabel(ledger.lines, range.line, range.end, v.label);
    if (!found) {
      const known = labelsIn(ledger.lines, range.line, range.end);
      return {
        code: 1,
        stdout: `(no label: ${v.label})\n`,
        stderr: known.length ? `labels in #${view.id}: ${known.join(", ")}\n` : "",
      };
    }
    if (found.text === "") {
      // An empty label is not a successful read: `close --criteria-from-body`
      // would promote it as an empty cell.
      return {
        code: 1,
        stdout: `(empty label: ${v.label})\n`,
        stderr: `label ${v.label} in #${view.id} exists but is empty (L${found.line})\n`,
      };
    }
    if (v.json) return ok(JSON.stringify({ ...view, paragraph: found.text }, null, 2));
    return ok(found.lines.join("\n"));
  }

  if (v.json) return ok(JSON.stringify(view, null, 2));

  const lines = [`#${view.id}  ${view.status}  ${view.priority || "-"}  ${view.summary}`];
  lines.push(`L${view.body?.line ?? view.line}-${view.body?.end ?? view.end}`);
  if (view.criteria) lines.push(`判据: ${view.criteria}`);
  lines.push("");
  if (view.body) {
    lines.push(view.body.text);
  } else if (view.table === "closed") {
    lines.push("(已关闭，只保留判据)");
  } else {
    lines.push("(无正文块)");
  }
  return ok(lines.join("\n"));
}

/**
 * Read one top-level section by its exact H2 title. No selectors: the ledger
 * only ever needs "give me `## 附录`" or "give me this named section".
 */
function cmdRead(rest: string[]): CliResult {
  const file = rest[0];
  const title = rest[1];
  if (file == null || title == null || rest.length !== 2) {
    return err("usage: issuemd read FILE <H2 heading>\n", 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const h2s = sections.filter((section) => section.level === 2);
  const matches = h2s.filter((section) => section.title === title);
  const candidates = h2s.map(({ line_start, title: name }) => `  L${line_start}  ## ${name}`).join("\n");
  if (matches.length === 0) {
    return err(`issuemd read: no H2 heading '${title}' in '${file}'\n${candidates}\n`, 2);
  }
  if (matches.length > 1) {
    const listed = matches.map(({ line_start }) => `  L${line_start}  ## ${title}`).join("\n");
    return err(`issuemd read: '${title}' matches ${matches.length} headings; nothing printed\n${listed}\n`, 2);
  }
  const section = matches[0]!;
  const lines = src.replace(/^﻿/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return ok(lines.slice(section.line_start - 1, section.line_end).join("\n"));
}

// ---- shared write plumbing --------------------------------------------

type Loaded = { doc: Document; lines: string[] };

/** Load a file for writing. Stdin is refused: there is nothing to write back. */
/**
 * The read path decodes UTF-8 with replacement, which is harmless for `check`
 * but destructive on write: every invalid byte would be replaced by U+FFFD in
 * the file. `readDocument` also normalises to a single EOL, so a file with one
 * CRLF line would come back with every line converted to CRLF. Refuse both
 * rather than silently rewriting bytes the user did not ask to touch.
 */
function writeBlockReason(file: string): "utf8" | "eol" | undefined {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    return undefined; // let readDocument report the real open error
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_ENCODING_INVALID_ENCODED_DATA") return "utf8";
    throw error;
  }
  const text = raw.toString("latin1");
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (crlf > 0 && lf > crlf) return "eol";
  return undefined;
}

function loadWritable(file: string): Loaded | CliResult {
  if (file === "-") return err("issuemd: write commands do not support stdin ('-')\n", 2);
  try {
    const blocked = writeBlockReason(file);
    if (blocked === "utf8") {
      return err(
        `issuemd: refusing to write '${file}': it is not valid UTF-8, and rewriting it would corrupt the bytes. ` +
          "Convert it to UTF-8 first.\n",
        2,
      );
    }
    if (blocked === "eol") {
      return err(
        `issuemd: refusing to write '${file}': it has mixed line endings, and this write would convert every line ` +
          "to one style. Normalise the line endings first.\n",
        2,
      );
    }
    const doc = readDocument(file);
    // Split without the trailing sentinel: `joinDocument` adds the final
    // newline back, so keeping the "" would double it on every rewrite.
    const lines = doc.text === ""
      ? []
      : (doc.finalNewline ? doc.text.slice(0, -1) : doc.text).split("\n");
    return { doc, lines };
  } catch (e) {
    return err(`issuemd: cannot open '${file}': ${(e as Error).message}\n`, 2);
  }
}

/**
 * A document with no final newline must not end in a newline after a write.
 * An appended block usually ends in a blank line, and `join("\n")` would turn
 * that blank into a trailing newline — so drop trailing blank lines whenever
 * the source had none.
 */
function terminate(lines: string[], doc: Document): string[] {
  if (doc.finalNewline) return lines;
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return end === lines.length ? lines : lines.slice(0, end);
}

/** `code|id|message` — the identity used to decide whether a diagnostic is new. */
const diagnosticKey = (d: Diagnostic) => `${d.code}|${d.id ?? ""}|${d.message}`;

/**
 * The single write gate shared by every ledger verb.
 *
 * 1. Join the candidate lines with the document's BOM/EOL/trailing-newline.
 * 2. Validate in memory and refuse if any error is *new* (exit 3).
 * 3. `--dry-run` prints a diff; otherwise replace atomically (E130 on a race).
 */
function commit(
  file: string,
  loaded: Loaded,
  before: Diagnostic[],
  candidate: string[],
  dryRun: boolean,
): CliResult {
  const newLines = terminate(candidate, loaded.doc);
  const content = joinDocument(newLines, loaded.doc);
  const after = checkLedger(content, file).errors;
  // Count, don't set: several codes (E110, E108, E122, …) carry no id, so a
  // second copy of an error that already exists must still be refused. One
  // baseline error buys exactly one identical candidate error, no more.
  const budget = new Map<string, number>();
  for (const diagnostic of before) {
    const key = diagnosticKey(diagnostic);
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  const introduced = after.filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    const remaining = budget.get(key) ?? 0;
    if (remaining === 0) return true;
    budget.set(key, remaining - 1);
    return false;
  });
  if (introduced.length > 0) {
    return err(
      `issuemd: refusing to write; the change would introduce ${introduced.length} error(s):\n` +
        formatDiagnostics(introduced) + "\n",
      3,
    );
  }
  if (dryRun) {
    const diff = unifiedDiff(loaded.lines, newLines, file);
    return ok(diff || "(no changes)\n");
  }
  const unchanged = newLines.length === loaded.lines.length &&
    newLines.every((line, index) => line === loaded.lines[index]);
  if (unchanged) return ok("");
  try {
    const written = writeAtomically(file, content, loaded.doc.stat);
    if (!written.ok) {
      return err(`issuemd: E130 '${file}' changed after it was read; re-read and retry\n`, 2);
    }
  } catch (error) {
    return err(`issuemd: cannot write '${file}': ${(error as Error).message}\n`, 2);
  }
  return ok("");
}

/** Ledger view plus the exact bytes it came from, for write verbs. */
function openLedger(file: string): { loaded: Loaded; ledger: ReturnType<typeof parseLedger>; errors: Diagnostic[] } | CliResult {
  const loaded = loadWritable(file);
  if ("code" in loaded) return loaded;
  const ledger = parseLedger(loaded.lines.join("\n"));
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;
  // Baseline diagnostics must be the checker's full set, not just the parser's:
  // the write gate only refuses *new* errors, so a pre-existing E112 in the
  // input must not look new after the edit.
  return { loaded, ledger, errors: checkLedger(loaded.doc.text, file).errors };
}

// ---- write commands ---------------------------------------------------

/**
 * Where a new body block for `id` belongs: before the first body whose id is
 * larger, else just past the last body. Bodies must stay strictly ascending
 * (E105), so appending blindly would fail for an explicitly low `--id`.
 */
function bodyInsertAt(
  ledger: ReturnType<typeof parseLedger>,
  id: IdSpan,
  bodySectionEnd: number,
): number {
  const blocks = [...bodyBlocks(ledger)].sort((a, b) => compareIds(a.id, b.id));
  const later = blocks.find((block) => compareIds(block.id, id) > 0);
  if (later) return later.line;
  const last = blocks.at(-1);
  return last ? last.end + 1 : bodySectionEnd + 1;
}

/** Rows in `status`'s category, used by close/reopen/status decisions. */
function statusCategory(status: string): "open" | "closed" | undefined {
  return Object.hasOwn(STATUS_CLASSES, status)
    ? STATUS_CLASSES[status as keyof typeof STATUS_CLASSES]
    : undefined;
}

/**
 * A title ending in a whitespace-separated `#` cannot round-trip through a
 * heading: CommonMark strips the trailing `#` as a closing sequence, so the
 * body title the tool just wrote would no longer match the table summary
 * (E106). Refuse before writing, with a message that says why.
 */
function titleEndsWithHash(title: string): string | null {
  const hashes = /#+\s*$/.exec(title);
  if (!hashes) return null;
  const before = title.slice(0, hashes.index);
  // The heading template inserts `: ` before the title, so a title that is
  // *only* hashes is also followed by a space in the rendered heading.
  if (before !== "" && !/\s$/.test(before)) return null; // `C#` is fine
  const stem = before.trim();
  return "the title ends with '#'; Markdown strips a trailing '#' as a heading's closing marker, " +
    `so the body title would not match the summary. Rephrase it (e.g. '${stem ? `${stem} ` : ""}hash #').`;
}

/** `--body-file PATH|-` wins over the default skeleton; a bare `-` is stdin. */
function readBodyFile(spec: string): { lines: string[] } | CliResult {
  try {
    const raw = spec === "-" ? readFileSync(0, "utf8") : readFileSync(spec, "utf8");
    // A UTF-8 BOM is an encoding marker, not body text. Left in place it ends
    // up mid-document and breaks label matching on the first line.
    const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const lines = src.replaceAll("\r\n", "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    // An unclosed fence would swallow every heading after the body — including
    // `## 附录` — and `check` would still pass, so refuse it up front.
    if (endsInFence(lines)) {
      return err("issuemd new: --body-file ends inside an unclosed code fence\n", 2);
    }
    // A top-level heading inside a body ends the issue block early: `show`
    // stops at it and `close` leaves it behind as orphaned content, all while
    // `check` stays green.
    const fenced = fencedLines(lines);
    const heading = lines.findIndex((line, index) => !fenced[index] && /^ {0,3}#{1,2}(?:[ \t]|$)/.test(line));
    if (heading !== -1) {
      return err(
        `issuemd new: --body-file may not contain a top-level heading (## or #): '${lines[heading]!.trim()}'.\n` +
          "Use **bold labels** inside an issue body.\n",
        2,
      );
    }
    return { lines };
  } catch (e) {
    return err(`issuemd: cannot read --body-file: ${(e as Error).message}\n`, 2);
  }
}

function cmdNew(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) {
    return err("usage: issuemd new FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-]\n", 2);
  }
  if (v.title == null || v.title.trim() === "") return err("issuemd new: --title is required\n", 2);
  const title = v.title.trim().replace(/\s+/g, " ").replace(/\\\|/g, "|");
  const badTitle = titleEndsWithHash(title);
  if (badTitle) return err(`issuemd new: ${badTitle}\n`, 2);
  const status = v.status ?? "未决";
  const priority = v.priority ?? "P2";
  const category = statusCategory(status);
  if (!category) return err(`issuemd new: unknown status '${status}'\n`, 2);
  if (category === "closed") {
    return err(
      `issuemd new: '${status}' is a closed status; create the issue open, then run ` +
        `'issuemd close FILE ID --status ${status} --criteria "…"'\n`,
      2,
    );
  }

  const opened = openLedger(file);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const max = maxIssueId(ledger.rows);
  let idText = String(max + 1);
  if (v.id == null && !Number.isSafeInteger(max + 1)) {
    return err(
      `issuemd new: the next id after ${max} is outside the supported integer range; pass --id explicitly\n`,
      2,
    );
  }
  // Ids are never recycled (spec §4.4). An explicit `--id` at or below the
  // historical maximum is the only place a "new number" can be a reused one,
  // so W211 is raised here rather than by the history-free `check`.
  let reusedNumber = false;
  if (v.id != null) {
    // Ids are `\d+[a-z]?` (the real ledgers contain `393b`), not plain ints.
    if (!/^[1-9]\d*[a-z]?$/.test(v.id) || parseId(v.id) == null) {
      return err(`issuemd new: --id expects a positive id like 42 or 393b, got '${v.id}'\n`, 2);
    }
    idText = v.id;
    // `2` and `2a` are distinct issues, so a suffixed id is always genuinely
    // new; only a bare number at or below the current max can be a reuse.
    reusedNumber = /^\d+$/.test(idText) && Number.parseInt(idText, 10) <= max;
    if (findRow(ledger, idText)) return err(`issuemd new: id ${idText} already exists\n`, 2);
  }
  const id = Number.parseInt(idText, 10);

  let body: string[];
  if (v["body-file"] != null) {
    const read = readBodyFile(v["body-file"]);
    if ("code" in read) return read;
    body = [`### Issue ${idText}: ${title}`, "", ...read.lines, ""];
  } else {
    body = bodySkeleton(idText, title);
  }

  const index = tableRange(ledger, "open");
  if (!index) return err("issuemd new: the 索引 table is missing\n", 3);

  // Keep the index ascending: insert before the first row with a larger id.
  const insertAt = (() => {
    for (const row of ledger.rows.open) {
      if (row.ids[0]!.start > id) return row.line;
    }
    return index.end + 1;
  })();

  let lines = insertLines(loaded.lines, insertAt, [formatRow([idText, status, priority, title])]);
  // The body position is computed after the index edit, which sits above 正文
  // and therefore shifts every later line by one.
  const afterIndex = parseLedger(lines.join("\n"));
  const shiftedBody = afterIndex.sections.find((section) => section.level === 2 && section.title === "正文");
  if (!shiftedBody) return err("issuemd new: the 正文 section is missing\n", 3);
  const span = parseId(idText);
  if (!span) return err(`issuemd new: '${idText}' is not a valid issue id\n`, 2);
  lines = insertLines(lines, bodyInsertAt(afterIndex, span, shiftedBody.line_end), body);

  const result = commit(file, loaded, errors, lines, !!v["dry-run"]);
  const warnings: string[] = [];
  if (reusedNumber) {
    warnings.push(`W211: id ${idText} is at or below the highest existing id ${max}; numbers are not recycled\n`);
  }
  if (title.includes("|")) {
    warnings.push("W205: the title contains a pipe; it was escaped in the table cell\n");
  }
  return result.code === 0 && warnings.length > 0 ? { ...result, stderr: result.stderr + warnings.join("") } : result;
}

function cmdClose(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const idText = rest[1];
  if (file == null || idText == null || rest.length !== 2) {
    return err("usage: issuemd close FILE ID [--criteria TEXT | --criteria-from-body] [--keep-body]\n", 2);
  }
  const criteriaFlags = [v.criteria != null, !!v["criteria-from-body"], !!v["no-criteria"]].filter(Boolean).length;
  if (criteriaFlags > 1) {
    return err("issuemd close: choose one of --criteria, --criteria-from-body, --no-criteria\n", 2);
  }
  const opened = openLedger(file);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return noMatch(`(no such issue: ${idText})\n`);
  if (found.table === "closed") return err(`issuemd close: #${idText} is already closed\n`, 2);
  if (found.inRange) {
    return err(
      `issuemd close: #${idText} is inside retired range ${spanText(found.span)}; close a concrete issue instead\n`,
      2,
    );
  }
  if (found.row.ids.length > 1) {
    return err(
      `issuemd close: #${idText} shares a row with other ids (${found.row.ids.map(spanText).join(", ")}); ` +
        "split the row first\n",
      2,
    );
  }
  const status = v.status ?? "已修";
  if (statusCategory(status) !== "closed") {
    return err(`issuemd close: '${status}' is not a closed status\n`, 2);
  }

  // Match the full id: `2` and `2a` are distinct issues with distinct bodies.
  const block = bodyBlocks(ledger).find(
    (candidate) => `${candidate.id.start}${candidate.id.suffix}` === idText,
  );
  const bodyText = block ? ledger.lines.slice(block.line - 1, block.end) : [];
  const keepBody = !!v["keep-body"] && block != null;
  // Criteria are stored once and must not vanish silently (spec §7.2): the
  // body is deleted by close, so whatever it says has to land somewhere.
  const fromBody = extractCriteria(bodyText);
  let criteria: string;
  if (v.criteria != null) {
    criteria = v.criteria;
  } else if (v["no-criteria"]) {
    criteria = "";
  } else if (v["criteria-from-body"]) {
    if (fromBody == null) {
      return err(
        `issuemd close: #${idText} has no non-empty **验收判据** in its body (fenced examples do not count); ` +
          "pass --criteria TEXT or --no-criteria\n",
        2,
      );
    }
    criteria = fromBody;
  } else if (fromBody != null) {
    criteria = fromBody; // the default: promote what the body already says
  } else if (keepBody) {
    criteria = ""; // nothing is lost: the whole body moves to 附录
  } else {
    return err(
      `issuemd close: #${idText} has no criteria to record (no --criteria and no **验收判据** in the body). ` +
        "Pass --criteria TEXT, --keep-body, or --no-criteria to close it without criteria on purpose\n",
      2,
    );
  }

  // Highest line number first so earlier coordinates stay valid.
  let lines = loaded.lines;

  // The archived heading is deliberately not an `Issue N:` heading: 附录
  // must not contain issue headings (E123), so the id moves into the text.
  let archive: string[] | undefined;
  if (block) {
    if (keepBody) {
      // Drop only the heading, then any leading blank lines: assuming a blank
      // line follows the heading would silently eat the first body line of a
      // tightly written ledger.
      const kept = bodyText.slice(1);
      while (kept.length > 0 && kept[0]!.trim() === "") kept.shift();
      while (kept.length > 0 && kept.at(-1)!.trim() === "") kept.pop();
      archive = [
        `### #${idText} ${found.row.summary}（已关闭，正文保留）`,
        "",
        `> 关闭时以 --keep-body 保留了原正文；状态见「已关闭」表。`,
        "",
        ...kept,
        // An explicit end: text appended to 附录 later would otherwise belong
        // to this H3, and `reopen` would pull it into the issue body.
        KEPT_BODY_END,
      ];
    }
    lines = removeLines(lines, block.line, block.end - block.line + 1);
  }
  if (archive) {
    // Locate 附录 *after* the body removal: it may sit before 正文, in which
    // case inserting first would shift the block we then delete.
    const afterRemoval = parseLedger(lines.join("\n"));
    const target = afterRemoval.sections.find((section) => section.level === 2 && section.title === "附录");
    if (target) {
      lines = insertLines(lines, target.line_end + 1, ["", ...archive]);
    } else {
      lines = insertLines(lines, lines.length + 1, ["", "## 附录", "", ...archive]);
    }
  }
  // The row is located again after the archive insertion: 附录 may sit above
  // 索引, in which case the insertion shifts the row. Using the stale line
  // number would delete the wrong line (and the gate would refuse with a
  // confusing E102/E104 pointing at the user's ledger).
  const afterArchive = parseLedger(lines.join("\n"));
  const rowNow = findRow(afterArchive, idText);
  if (!rowNow) return err(`issuemd close: #${idText} disappeared from the index during the edit\n`, 2);
  lines = removeLines(lines, rowNow.row.line, 1);
  const closedAt = tableRange(parseLedger(lines.join("\n")), "closed");
  if (!closedAt) return err("issuemd close: the 已关闭 table is missing\n", 3);
  lines = insertLines(lines, closedAt.end + 1, [
    formatRow([idText, status, found.row.priority, found.row.summary, criteria]),
  ]);

  const result = commit(file, loaded, errors, lines, !!v["dry-run"]);
  if (keepBody && result.code === 0) {
    return { code: 0, stdout: result.stdout, stderr: `W250: kept the body of #${idText} by moving it into 附录\n` };
  }
  return result;
}

function cmdReopen(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const idText = rest[1];
  if (file == null || idText == null || rest.length !== 2) {
    return err("usage: issuemd reopen FILE ID\n", 2);
  }
  const opened = openLedger(file);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return noMatch(`(no such issue: ${idText})\n`);
  if (found.table === "open") return err(`issuemd reopen: #${idText} is already open\n`, 2);
  if (found.inRange) {
    return err(`issuemd reopen: #${idText} is a range; reopen is not supported\n`, 2);
  }
  if (found.row.ids.length > 1) {
    return err(
      `issuemd reopen: #${idText} shares a row with other ids (${found.row.ids.map(spanText).join(", ")}); ` +
        "split the row first\n",
      2,
    );
  }

  const priority = found.row.priority || "P2";
  const criteria = found.row.criteria.trim();
  // `close --keep-body` archived the body in 附录 precisely so it could be
  // recovered. Restore it instead of leaving an empty skeleton and a W250
  // heading that claims the (now open) issue still has a kept body.
  const archiveHeading = new RegExp(`^#${idText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .*（已关闭，正文保留）$`);
  const archived = ledger.sections.find(
    (section) => section.level === 3 && archiveHeading.test(section.title),
  );
  // The archive spans heading → end marker. Archives written before the
  // marker existed fall back to the H3's extent, minus trailing blank lines
  // (those separate it from whatever follows and must stay).
  let archiveSpan: { start: number; end: number } | undefined;
  let restored: string[] | undefined;
  if (archived) {
    const fenced = fencedLines(loaded.lines);
    let end = archived.line_end;
    for (let line = archived.line_start + 1; line <= archived.line_end; line++) {
      if (!fenced[line - 1] && loaded.lines[line - 1]!.trim() === KEPT_BODY_END) {
        end = line;
        break;
      }
    }
    while (end > archived.line_start && loaded.lines[end - 1]!.trim() === "") end--;
    restored = trimBlank(loaded.lines.slice(archived.line_start, end)
      .filter((line) => line.trim() !== KEPT_BODY_END && !/^>\s*关闭时以 --keep-body/.test(line)));
    // `close` inserted one blank line before the archive; take it back.
    const start = archived.line_start > 1 && loaded.lines[archived.line_start - 2]!.trim() === ""
      ? archived.line_start - 1
      : archived.line_start;
    archiveSpan = { start, end };
  }

  // Remove the later block first so the earlier coordinates stay valid.
  const removals = [
    { line: found.row.line, count: 1 },
    ...(archiveSpan ? [{ line: archiveSpan.start, count: archiveSpan.end - archiveSpan.start + 1 }] : []),
  ].sort((a, b) => b.line - a.line);
  let lines = loaded.lines;
  for (const removal of removals) lines = removeLines(lines, removal.line, removal.count);

  const fresh = parseLedger(lines.join("\n"));
  const index = tableRange(fresh, "open");
  if (!index) return err("issuemd reopen: the 索引 table is missing\n", 3);
  const insertAt = (() => {
    for (const row of fresh.rows.open) {
      if (row.ids[0]!.start > found.span.start) return row.line;
    }
    return index.end + 1;
  })();
  lines = insertLines(lines, insertAt, [
    formatRow([spanText(found.span), "未决", priority, found.row.summary]),
  ]);

  // Coordinates for the body block are taken after the index edit landed,
  // so they already reflect the one-line shift it caused.
  const reopened = parseLedger(lines.join("\n"));
  const bodySection = reopened.sections.find(
    (section) => section.level === 2 && section.title === "正文",
  );
  if (!bodySection) return err("issuemd reopen: the 正文 section is missing\n", 3);
  const bodyAt = bodyInsertAt(reopened, found.span, bodySection.line_end);
  const bodyLines = restored && restored.length > 0
    ? [`### Issue ${spanText(found.span)}: ${found.row.summary}`, "", ...restored, ""]
    : bodySkeleton(spanText(found.span), found.row.summary, criteria);
  lines = insertLines(lines, bodyAt, bodyLines);

  return commit(file, loaded, errors, lines, !!v["dry-run"]);
}

function cmdStatus(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const idText = rest[1];
  const next = rest[2];
  if (file == null || idText == null || next == null || rest.length !== 3) {
    return err("usage: issuemd status FILE ID NEW_STATUS\n", 2);
  }
  if (!statusCategory(next)) return err(`issuemd status: unknown status '${next}'\n`, 2);
  const opened = openLedger(file);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return noMatch(`(no such issue: ${idText})\n`);
  if (found.inRange) {
    return err(`issuemd status: #${idText} is a range; change a concrete issue\n`, 2);
  }
  if (found.row.ids.length > 1) {
    return err(
      `issuemd status: #${idText} shares a row with other ids (${found.row.ids.map(spanText).join(", ")}); ` +
        "split the row first\n",
      2,
    );
  }
  // `status` is also the repair verb for a typo'd word: an undeclared status
  // has no category, so fall back to the table the row actually lives in.
  const from = statusCategory(found.row.status);
  const to = statusCategory(next)!;
  const current = from ?? found.table;
  if (current !== to) {
    const verb = to === "closed" ? "issuemd close" : "issuemd reopen";
    return err(
      `issuemd status: #${idText} is ${found.row.status} (${current}); ` +
        `${next} is ${to} — use '${verb}'\n`,
      2,
    );
  }

  const lines = [...loaded.lines];
  lines[found.row.line - 1] = replaceCell(lines[found.row.line - 1]!, 1, next);
  return commit(file, loaded, errors, lines, !!v["dry-run"]);
}

function cmdRename(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const idText = rest[1];
  const title = rest[2];
  if (file == null || idText == null || title == null || rest.length !== 3) {
    return err("usage: issuemd rename FILE ID \"NEW TITLE\"\n", 2);
  }
  const next = title.trim().replace(/\s+/g, " ").replace(/\\\|/g, "|");
  if (next === "") return err("issuemd rename: title must not be empty\n", 2);
  const badTitle = titleEndsWithHash(next);
  if (badTitle) return err(`issuemd rename: ${badTitle}\n`, 2);
  const opened = openLedger(file);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return noMatch(`(no such issue: ${idText})\n`);
  if (found.inRange) {
    return err(`issuemd rename: #${idText} is a range; rename a concrete issue\n`, 2);
  }
  if (found.row.ids.length > 1) {
    return err(
      `issuemd rename: #${idText} shares a row with other ids (${found.row.ids.map(spanText).join(", ")}); ` +
        "split the row first\n",
      2,
    );
  }

  const lines = [...loaded.lines];
  lines[found.row.line - 1] = replaceCell(lines[found.row.line - 1]!, 3, next);
  const block = bodyBlocks(ledger).find(
    (candidate) => `${candidate.id.start}${candidate.id.suffix}` === idText,
  );
  if (block) lines[block.line - 1] = `### Issue ${idText}: ${next}`;
  const result = commit(file, loaded, errors, lines, !!v["dry-run"]);
  if (next.includes("|") && result.code === 0) {
    return { ...result, stderr: result.stderr + "W205: the new title contains a pipe; it was escaped in the table cell\n" };
  }
  return result;
}

function cmdAdopt(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) {
    return err("usage: issuemd adopt FILE [--dry-run] [--report PATH]\n", 2);
  }
  const loaded = loadWritable(file);
  if ("code" in loaded) return loaded;
  if (v.report != null) {
    const refused = reportTargetProblem(file, v.report);
    if (refused) return err(`issuemd adopt: refusing --report '${v.report}': ${refused}\n`, 2);
  }

  let result;
  try {
    result = adopt(loaded.doc.text);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "no-rows" || code === "lost-content") {
      return err(`issuemd adopt: ${(error as Error).message}\n`, 3);
    }
    throw error;
  }
  const report = renderAdoptReport(file, result.changes, result.decisions);
  const target = joinDocument(result.lines, loaded.doc);
  const after = checkLedger(target, file).errors;
  if (after.length > 0) {
    // The converted text was never written, so its line numbers point at
    // nothing the user can open. Most lines are copied verbatim, so look each
    // one up in the source; say so plainly when it cannot be found.
    const located = after.map((diagnostic) => {
      const converted = result.lines[diagnostic.line - 1];
      const source = converted == null ? -1 : loaded.lines.indexOf(converted);
      const where = source >= 0 ? `source L${source + 1}` : "source line unknown";
      return `  ${where} (converted L${diagnostic.line})${diagnostic.id ? ` #${diagnostic.id}` : ""} ` +
        `${diagnostic.code}: ${diagnostic.message}`;
    });
    return err(
      `issuemd adopt: the converted ledger still has ${after.length} error(s); nothing written\n` +
        located.join("\n") + "\n" + report,
      3,
    );
  }
  const writeReport = (): CliResult | null => {
    if (v.report == null) return null;
    try {
      writeFileSync(v.report, report);
      return null;
    } catch (error) {
      return err(`issuemd adopt: cannot write --report: ${(error as Error).message}\n`, 2);
    }
  };
  if (v["dry-run"]) {
    // The report is the point of a dry run (review the decisions first); it
    // is never the ledger and never someone else's file (checked above).
    const failed = writeReport();
    if (failed) return failed;
    const diff = unifiedDiff(loaded.lines, result.lines, file);
    return ok((diff || "(no changes)\n") + "\n" + report);
  }
  const unchanged = result.lines.length === loaded.lines.length &&
    result.lines.every((line, index) => line === loaded.lines[index]);
  if (!unchanged) {
    try {
      const written = writeAtomically(file, target, loaded.doc.stat);
      if (!written.ok) return err(`issuemd: E130 '${file}' changed after it was read; re-read and retry\n`, 2);
    } catch (error) {
      return err(`issuemd: cannot write '${file}': ${(error as Error).message}\n`, 2);
    }
  }
  // Written after the ledger so a failed conversion never leaves a report
  // that describes a write that did not happen.
  const failed = writeReport();
  if (failed) return failed;
  return ok(report);
}

/**
 * `--report` used to be a bare `writeFileSync`: pointed at the ledger it
 * replaced the ledger with the report (even under --dry-run), and it truncated
 * any existing file. Only a new path, or a previous adopt report, is allowed.
 */
function reportTargetProblem(ledgerPath: string, reportPath: string): string | null {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  if (real(reportPath) === real(ledgerPath)) return "it is the ledger being adopted";
  let existing: string;
  try {
    existing = readFileSync(reportPath, "utf8");
  } catch {
    return null; // a new file
  }
  if (existing.startsWith("adopt: ")) return null; // our own previous report
  return "the file exists and is not an earlier adopt report; choose a new path or remove it first";
}

function renderAdoptReport(file: string, changes: string[], decisions: Decision[]): string {
  const out = [`adopt: ${file}`, ""];
  out.push("机械改动：");
  out.push(...(changes.length ? changes.map((change) => `  - ${change}`) : ["  （无）"]));
  out.push("", `待决事项（${decisions.length}）：`);
  if (decisions.length === 0) out.push("  （无）");
  const group = new Map<string, Decision[]>();
  for (const decision of decisions) {
    const list = group.get(decision.kind) ?? [];
    list.push(decision);
    group.set(decision.kind, list);
  }
  for (const [kind, list] of group) {
    out.push(`  ${kind} x${list.length}`);
    for (const decision of list) {
      const id = decision.id ? ` #${decision.id}` : "";
      const pair = decision.table != null
        ? `\n      表: ${decision.table}\n      文: ${decision.body ?? ""}`
        : "";
      // `L` is the output file; a decision with nothing left to point at in
      // the output falls back to the input coordinate, never a fake `L0`.
      const where = decision.line > 0
        ? `L${decision.line}`
        : decision.sourceLine != null ? `源 L${decision.sourceLine}` : "L?";
      out.push(`    ${where}${id} ${decision.message}${pair}`);
    }
  }
  return out.join("\n") + "\n";
}

function cmdSync(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) {
    return err(
      "usage: issuemd sync FILE [--guide | --fix-tables | --titles [--prefer body|table]]\n",
      2,
    );
  }
  const modes = [!!v.guide, !!v["fix-tables"], !!v.titles].filter(Boolean).length;
  if (modes === 0) return err("issuemd sync: choose --guide, --fix-tables or --titles\n", 2);
  if (modes > 1) return err("issuemd sync: run one mode at a time\n", 2);
  if ((v["move-progress"] || v["drop-progress"]) && !v.titles) {
    return err("issuemd sync: --move-progress/--drop-progress require --titles\n", 2);
  }
  if (v["move-progress"] && v["drop-progress"]) {
    return err("issuemd sync: choose --move-progress or --drop-progress, not both\n", 2);
  }
  const prefer = v.prefer ?? "body";
  if (prefer !== "body" && prefer !== "table") {
    return err(`issuemd sync: --prefer expects body or table, got '${prefer}'\n`, 2);
  }

  const opened = openLedger(file);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;
  let lines = loaded.lines;

  if (v.guide) {
    // Only the owning section counts. A lookalike marker indented under a
    // list in 附录 used to make the rewrite silently do nothing ("(no
    // changes)", exit 0) while check kept failing. Each block is rewritten
    // against a fresh parse because the first rewrite shifts every later line.
    const blocks = [
      { title: "怎么用", begin: "<!-- issuemd:guide:begin -->", end: "<!-- issuemd:guide:end -->", content: guideBlockLines() },
      { title: "状态口径", begin: "<!-- issuemd:statuses:begin -->", end: "<!-- issuemd:statuses:end -->", content: statusBlockLines() },
    ];
    for (const block of blocks) {
      const section = parseLedger(lines.join("\n")).sections
        .find((candidate) => candidate.level === 2 && candidate.title === block.title);
      if (!section) return err(`issuemd sync --guide: the ${block.title} section is missing\n`, 3);
      const range = { start: section.line_start, end: section.line_end };
      if (!markerPair(lines, block.begin, block.end, range)) {
        return err(
          `issuemd sync --guide: 「${block.title}」 must contain exactly one ordered ${block.begin} / ${block.end} pair\n`,
          3,
        );
      }
      lines = rewriteBlock(lines, block.begin, block.end, block.content, range);
    }
    return commit(file, loaded, errors, lines, !!v["dry-run"]);
  }

  if (v["fix-tables"]) {
    lines = fixTables(lines, ledger);
    return commit(file, loaded, errors, lines, !!v["dry-run"]);
  }

  return syncTitles(file, loaded, ledger, errors, prefer, v);
}

function syncTitles(
  file: string,
  loaded: Loaded,
  ledger: ReturnType<typeof parseLedger>,
  errors: Diagnostic[],
  prefer: "body" | "table",
  v: Values,
): CliResult {
  // Keyed by the full id: `21` and `21a` are different issues and must not
  // resolve to the same body block.
  const blocks = bodyBlocks(ledger);
  const byId = new Map(blocks.map((block) => [`${block.id.start}${block.id.suffix}`, block]));
  const index = tableRange(ledger, "open");
  if (!index) return err("issuemd sync: the 索引 table is missing\n", 3);

  type Change = { id: string; oldSummary: string; title: string; rowLine: number; bodyLine?: number };
  const changes: Change[] = [];
  for (const row of ledger.rows.open) {
    if (row.ids.length !== 1) continue;
    const id = spanText(row.ids[0]!);
    const block = byId.get(id);
    if (!block) continue;
    if (foldWhitespace(block.title) === foldWhitespace(row.summary)) continue;
    changes.push({ id, oldSummary: row.summary, title: block.title, rowLine: row.line, bodyLine: block.line });
  }
  if (changes.length === 0) return ok("");

  const progress = changes.filter((change) => PROGRESS.test(change.oldSummary));
  if (prefer === "body" && progress.length > 0 && !v["move-progress"] && !v["drop-progress"]) {
    const listed = progress.map(({ id, oldSummary }) => `  #${id}  ${oldSummary}`).join("\n");
    return err(
      `issuemd sync --titles: ${progress.length} summary/summary pair(s) carry progress text; nothing written\n` +
        `${listed}\n` +
        "re-run with --move-progress (keep it in the body) or --drop-progress (discard it)\n",
      3,
    );
  }

  let lines = [...loaded.lines];
  for (const change of changes.sort((a, b) => b.rowLine - a.rowLine)) {
    if (prefer === "body") {
      lines[change.rowLine - 1] = replaceCell(lines[change.rowLine - 1]!, 3, change.title);
    } else if (change.bodyLine != null) {
      lines[change.bodyLine - 1] = `### Issue ${change.id}: ${change.oldSummary}`;
    }
  }

  if (prefer === "body" && v["move-progress"]) {
    // Insert from the bottom up so earlier line numbers remain valid.
    const note = (summary: string) => `> **进展（来自旧表）**：${summary}`;
    for (const change of progress.sort((a, b) => (b.bodyLine ?? 0) - (a.bodyLine ?? 0))) {
      if (change.bodyLine == null) continue;
      // Anchor to the heading, not to "heading + 2": a body written with no
      // blank line after its heading would put the note in the next issue.
      const after = lines[change.bodyLine];
      lines = after !== undefined && after.trim() === ""
        ? insertLines(lines, change.bodyLine + 2, [note(change.oldSummary), ""])
        : insertLines(lines, change.bodyLine + 1, ["", note(change.oldSummary), ""]);
    }
  }

  return commit(file, loaded, errors, lines, !!v["dry-run"]);
}

/** Add a separator row after any pipe block that lacks one. */
function fixTables(lines: string[], ledger: ReturnType<typeof parseLedger>): string[] {
  const missing = ledger.blocks.filter((block) => !block.separator);
  let result = [...lines];
  for (const block of [...missing].sort((a, b) => b.line - a.line)) {
    const width = block.rows[0]!.length;
    const separator = `|${"---|".repeat(width)}`;
    const inLedgerTable = ledger.sections.some(
      (section) =>
        (section.title === "索引" || section.title === "已关闭") &&
        block.line > section.line_start &&
        block.line <= section.line_end,
    );
    // A short separator (the right number of `---` cells, wrong count) is the
    // case the parser flags as "missing separator". Replacing that row is the
    // only fix that does not leave a malformed data row behind.
    const second = block.rows[1];
    const isShortSeparator =
      second !== undefined && second.length > 0 && second.every((cell) => /^:?-+:?$/.test(cell));
    const needsHeader = inLedgerTable && block.rows[0]!.join(" | ") !== COLUMN_HEADERS[width];
    if (isShortSeparator) {
      result = insertLines(removeLines(result, block.line + 1, 1), block.line + 1, [separator]);
    } else if (needsHeader) {
      result = insertLines(result, block.line, [canonicalHeaderLine(width), separator]);
    } else {
      result = insertLines(result, block.line + 1, [separator]);
    }
  }
  return result;
}

function canonicalHeaderLine(width: number): string {
  return width === 4 ? formatRow(["#", "状态", "P", "摘要"]) : formatRow(["#", "状态", "P", "摘要", "判据"]);
}

const COLUMN_HEADERS: Record<number, string> = {
  4: "# | 状态 | P | 摘要",
  5: "# | 状态 | P | 摘要 | 判据",
};

const PROGRESS = /已落地|仍缺|仍无|仍逐|仍走/;
const foldWhitespace = (text: string) => text.trim().replace(/\s+/g, " ");