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
import { readFileSync } from "node:fs";

import { scan } from "./scan.js";
import { buildSections, countLines } from "./sections.js";
import { joinDocument, readDocument, writeAtomically, type Document } from "./io.js";
import { bodyBlocks, maxIssueId, parseLedger, type Diagnostic } from "./ledger.js";
import { checkLedger, STATUS_CLASSES } from "./ledger-check.js";
import {
  bodySkeleton,
  extractCriteria,
  formatRow,
  guideBlockLines,
  insertLines,
  removeLines,
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

Options:
  --json                    machine-readable JSON output
  --strict                  check: fail on warnings
  --verify-commits          check: verify commit references in the ledger directory
  --status <S>              list: filter by status
  --priority <P>            list: filter by priority
  --closed                  list: show the closed table instead of the index
  --label <NAME>            show: print only the **NAME** paragraph
  --title <T>               new: summary/body title
  --id <N>                  new: explicit issue id
  --body-file <path|->      new: body from a file, or '-' for stdin
  --criteria <TEXT>         close: criteria column text
  --criteria-from-body      close: lift the **验收判据** paragraph into the column
  --keep-body               close: move the body into 附录 instead of deleting it
  --guide                   sync: rewrite the controlled guide and status blocks
  --fix-tables              sync: add missing table separator rows
  --titles                  sync: align body headings with index summaries
  --prefer <body|table>     sync --titles: which side wins (default body)
  --move-progress           sync --titles: move progress text into the body
  --drop-progress           sync --titles: discard progress text
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
  "keep-body": { type: "boolean" },
  // sync
  guide: { type: "boolean" },
  "fix-tables": { type: "boolean" },
  titles: { type: "boolean" },
  prefer: { type: "string" },
  "move-progress": { type: "boolean" },
  "drop-progress": { type: "boolean" },
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
    if (v.json) return ok(JSON.stringify({ ...view, paragraph: found.text }, null, 2));
    return ok(`**${found.label}**：${found.text}`);
  }

  if (v.json) return ok(JSON.stringify(view, null, 2));

  const lines = [`#${view.id}  ${view.status}  ${view.priority || "-"}  ${view.summary}`];
  lines.push(`L${view.body?.line ?? view.line}-${view.body?.end ?? view.end}`);
  if (view.criteria) lines.push(`判据: ${view.criteria}`);
  lines.push("");
  lines.push(view.body ? view.body.text : "(已关闭，只保留判据)");
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
function loadWritable(file: string): Loaded | CliResult {
  if (file === "-") return err("issuemd: write commands do not support stdin ('-')\n", 2);
  try {
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
  newLines: string[],
  dryRun: boolean,
): CliResult {
  const content = joinDocument(newLines, loaded.doc);
  const after = checkLedger(content, file).errors;
  const known = new Set(before.map(diagnosticKey));
  const introduced = after.filter((diagnostic) => !known.has(diagnosticKey(diagnostic)));
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
  return { loaded, ledger, errors: ledger.errors };
}

function parseIntArg(v: string | undefined, flag: string): { value: number } | CliResult {
  if (v == null) return err(`issuemd: ${flag} expects a value\n`, 2);
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || String(n) !== v.trim()) {
    return err(`issuemd: ${flag} expects an integer, got '${v}'\n`, 2);
  }
  return { value: n };
}

// ---- write commands ---------------------------------------------------

/** Rows in `status`'s category, used by close/reopen/status decisions. */
function statusCategory(status: string): "open" | "closed" | undefined {
  return Object.hasOwn(STATUS_CLASSES, status)
    ? STATUS_CLASSES[status as keyof typeof STATUS_CLASSES]
    : undefined;
}

/** `--body-file PATH|-` wins over the default skeleton; a bare `-` is stdin. */
function readBodyFile(spec: string): { lines: string[] } | CliResult {
  try {
    const src = spec === "-" ? readFileSync(0, "utf8") : readFileSync(spec, "utf8");
    return { lines: src.replaceAll("\r\n", "\n").split("\n").filter((line, index, all) => index < all.length - 1 || line !== "") };
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
  const title = v.title.trim().replace(/\s+/g, " ");
  const status = v.status ?? "未决";
  const priority = v.priority ?? "P2";
  const category = statusCategory(status);
  if (!category) return err(`issuemd new: unknown status '${status}'\n`, 2);
  if (category === "closed") return err(`issuemd new: '${status}' is a closed status; use '\''issuemd close'\''\n`, 2);

  const opened = openLedger(file);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const max = maxIssueId(ledger.rows);
  let id = max + 1;
  if (v.id != null) {
    const parsed = parseIntArg(v.id, "--id");
    if ("code" in parsed) return parsed;
    id = parsed.value;
    if (id < 1) return err("issuemd new: --id must be a positive integer\n", 2);
    const clash = findRow(ledger, String(id));
    if (clash) return err(`issuemd new: id ${id} already exists\n`, 2);
  }

  let body: string[];
  if (v["body-file"] != null) {
    const read = readBodyFile(v["body-file"]);
    if ("code" in read) return read;
    body = [`### Issue ${id}: ${title}`, "", ...read.lines, ""];
  } else {
    body = bodySkeleton(String(id), title);
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

  const bodySection = ledger.sections.find((section) => section.level === 2 && section.title === "正文");
  if (!bodySection) return err("issuemd new: the 正文 section is missing\n", 3);

  let lines = insertLines(loaded.lines, insertAt, [formatRow([String(id), status, priority, title])]);
  lines = insertLines(lines, bodySection.line_end === bodySection.line_start ? bodySection.line_start + 2 : bodySection.line_end + 1, body);

  return commit(file, loaded, errors, lines, !!v["dry-run"]);
}

function cmdClose(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const idText = rest[1];
  if (file == null || idText == null || rest.length !== 2) {
    return err("usage: issuemd close FILE ID [--criteria TEXT | --criteria-from-body] [--keep-body]\n", 2);
  }
  if (v.criteria != null && v["criteria-from-body"]) {
    return err("issuemd close: choose --criteria or --criteria-from-body, not both\n", 2);
  }
  const opened = openLedger(file);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return noMatch(`(no such issue: ${idText})\n`);
  if (found.table === "closed") return err(`issuemd close: #${idText} is already closed\n`, 2);
  if (found.span.start !== found.span.end) {
    return err(
      `issuemd close: #${idText} is inside retired range ${spanText(found.span)}; close a concrete issue instead\n`,
      2,
    );
  }
  const status = v.status ?? "已修";
  if (statusCategory(status) !== "closed") {
    return err(`issuemd close: '${status}' is not a closed status\n`, 2);
  }

  const block = bodyBlocks(ledger).find((candidate) => candidate.id.start === found.span.start);
  const bodyText = block ? ledger.lines.slice(block.line - 1, block.end) : [];
  const criteria = v.criteria ?? (v["criteria-from-body"] ? extractCriteria(bodyText) ?? "" : "");

  // Highest line number first so earlier coordinates stay valid.
  let lines = loaded.lines;

  const keepBody = !!v["keep-body"] && block != null;
  const appendix = ledger.sections.find((section) => section.level === 2 && section.title === "附录");

  if (block) {
    if (keepBody) {
      // 附录 sits after 正文, so insert there first, then delete the block.
      const at = (appendix?.line_end ?? block.end) + 1;
      lines = insertLines(lines, at, ["", ...bodyText]);
    }
    lines = removeLines(lines, block.line, block.end - block.line + 1);
  }
  // 索引 precedes 正文, so its line number survived the body deletion.
  lines = removeLines(lines, found.row.line, 1);
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
  if (found.span.start !== found.span.end) {
    return err(`issuemd reopen: #${idText} is a range; reopen is not supported\n`, 2);
  }

  const priority = found.row.priority || "P2";
  const criteria = found.row.criteria.trim();
  let lines = removeLines(loaded.lines, found.row.line, 1);

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

  const bodySection = parseLedger(lines.join("\n")).sections.find(
    (section) => section.level === 2 && section.title === "正文",
  );
  if (!bodySection) return err("issuemd reopen: the 正文 section is missing\n", 3);
  lines = insertLines(lines, bodySection.line_end + 1, bodySkeleton(spanText(found.span), found.row.summary, criteria));

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
  if (found.span.start !== found.span.end) {
    return err(`issuemd status: #${idText} is a range; change a concrete issue\n`, 2);
  }
  const from = statusCategory(found.row.status);
  const to = statusCategory(next);
  if (from !== to) {
    const verb = to === "closed" ? "issuemd close" : "issuemd reopen";
    return err(
      `issuemd status: #${idText} is ${found.row.status} (${from ?? "unknown"}); ` +
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
  const next = title.trim().replace(/\s+/g, " ");
  if (next === "") return err("issuemd rename: title must not be empty\n", 2);
  const opened = openLedger(file);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return noMatch(`(no such issue: ${idText})\n`);
  if (found.span.start !== found.span.end) {
    return err(`issuemd rename: #${idText} is a range; rename a concrete issue\n`, 2);
  }

  const lines = [...loaded.lines];
  lines[found.row.line - 1] = replaceCell(lines[found.row.line - 1]!, 3, next);
  const block = bodyBlocks(ledger).find((candidate) => candidate.id.start === found.span.start);
  if (block) lines[block.line - 1] = `### Issue ${spanText(found.span)}: ${next}`;
  return commit(file, loaded, errors, lines, !!v["dry-run"]);
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
    lines = rewriteBlock(lines, "<!-- issuemd:guide:begin -->", "<!-- issuemd:guide:end -->", guideBlockLines());
    lines = rewriteBlock(lines, "<!-- issuemd:statuses:begin -->", "<!-- issuemd:statuses:end -->", statusBlockLines());
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
  const blocks = bodyBlocks(ledger);
  const byId = new Map(blocks.map((block) => [block.id.start, block]));
  const index = tableRange(ledger, "open");
  if (!index) return err("issuemd sync: the 索引 table is missing\n", 3);

  type Change = { id: string; oldSummary: string; title: string; rowLine: number; bodyLine?: number };
  const changes: Change[] = [];
  for (const row of ledger.rows.open) {
    if (row.ids.length !== 1) continue;
    const id = spanText(row.ids[0]!);
    const block = byId.get(row.ids[0]!.start);
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
    for (const change of progress.sort((a, b) => (b.bodyLine ?? 0) - (a.bodyLine ?? 0))) {
      if (change.bodyLine == null) continue;
      lines = insertLines(lines, change.bodyLine + 2, [`> **进展（来自旧表）**：${change.oldSummary}`, ""]);
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
    // A headerless data block in a ledger table would promote its first row
    // to a header, so the canonical header row goes in along with the rule.
    const needsHeader = inLedgerTable && block.rows[0]!.join(" | ") !== COLUMN_HEADERS[width];
    result = insertLines(
      result,
      block.line + 1,
      needsHeader ? [canonicalHeaderLine(width), separator] : [separator],
    );
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