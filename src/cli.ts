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

import { createHash } from "node:crypto";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  accessSync, closeSync, constants as fsConstants, lstatSync, openSync, readFileSync, realpathSync, statSync,
  unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { scan } from "./scan.js";
import { buildSections, countLines } from "./sections.js";
import { joinDocument, readDocument, writeAtomically, type Document } from "./io.js";
import { parseId, parseIds, compareIds, type IdSpan } from "./issue-id.js";
import { bodyBlocks, countSuffix, maxIssueId, parseLedger, type Diagnostic } from "./ledger.js";
import { checkLedger, PRIORITIES, STATUS_CLASSES, summaryKey } from "./ledger-check.js";
import {
  bodySkeleton,
  escapeCell,
  extractCriteria,
  unescapeCell,
  formatRow,
  guideBlockLines,
  archiveHeading,
  ARCHIVE_HEADING,
  ARCHIVE_NOTE,
  KEPT_BODY_END,
  insertBlock,
  insertLines,
  labelName,
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
  expandIssues,
  formatListedIssue,
  labelsIn,
  spanText,
  summaryLine,
  toListedIssue,
  viewIssue,
  withBody,
} from "./ledger-read.js";
import { unifiedDiff } from "./write.js";
import { adopt, type Decision } from "./adopt.js";

/** Exit codes, shared by the global and per-command help. */
const EXIT_CODES =
  "Exit codes: 0 ok, 1 no such issue / empty result, 2 usage or I/O error, 3 ledger validation error,\n" +
  "            4 the file changed after it was read (E130) — re-read and retry.";

/**
 * Every command, its usage line and the options it accepts. `run` refuses any
 * other option (exit 2) instead of silently ignoring it (dogfood #13/#14):
 * `list --title x` or `new --json` used to "work" and do nothing.
 */
const COMMANDS = {
  check: { usage: "issuemd check   FILE [--json] [--strict] [--verify-commits]", options: ["json", "strict", "verify-commits"] },
  list: { usage: "issuemd list    FILE [--status S] [--priority P] [--closed] [--expand] [--json [--with-body]]", options: ["status", "priority", "closed", "expand", "json", "with-body"] },
  show: { usage: "issuemd show    FILE ID [--json] [--label NAME]", options: ["json", "label"] },
  counts: { usage: "issuemd counts  FILE [--json]", options: ["json"] },
  read: { usage: "issuemd read    FILE <H2 heading>", options: [] },
  new: { usage: "issuemd new     FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-] [--allow-duplicate-title]", options: ["title", "id", "status", "priority", "body-file", "allow-duplicate-title", "dry-run", "if-unchanged"] },
  close: { usage: "issuemd close   FILE ID [--status S] [--criteria TEXT | --criteria-from-body | --no-criteria] [--keep-body]", options: ["status", "criteria", "criteria-from-body", "no-criteria", "keep-body", "dry-run", "if-unchanged"] },
  reopen: { usage: "issuemd reopen  FILE ID [--status S] [--allow-duplicate-title]", options: ["status", "allow-duplicate-title", "dry-run", "if-unchanged"] },
  status: { usage: "issuemd status  FILE ID NEW_STATUS", options: ["dry-run", "if-unchanged"] },
  rename: { usage: "issuemd rename  FILE ID \"NEW TITLE\" [--allow-duplicate-title]", options: ["allow-duplicate-title", "dry-run", "if-unchanged"] },
  body: { usage: "issuemd body    FILE ID --body-file PATH|-", options: ["body-file", "dry-run", "if-unchanged"] },
  priority: { usage: "issuemd priority FILE ID P0|P1|P2|P3|\"\"", options: ["dry-run", "if-unchanged"] },
  split: { usage: "issuemd split   FILE ID", options: ["dry-run", "if-unchanged"] },
  sync: { usage: "issuemd sync    FILE [--guide | --fix-tables | --titles [--prefer body|table] [--move-progress | --drop-progress]]", options: ["guide", "fix-tables", "titles", "prefer", "move-progress", "drop-progress", "dry-run", "if-unchanged"] },
  adopt: { usage: "issuemd adopt   FILE [--dry-run] [--report PATH]", options: ["dry-run", "report", "if-unchanged"] },
} as const satisfies Record<string, { usage: string; options: readonly string[] }>;
type Command = keyof typeof COMMANDS;

/** Option help, one entry per flag; continuation lines start with spaces. */
const OPTION_HELP: Record<string, string> = {
  json: "--json                    machine-readable JSON output (read commands)",
  strict: "--strict                  check: fail on warnings (W250 is informational and never fails)",
  "verify-commits": "--verify-commits          check: verify commit references in the ledger directory (W240)",
  status:
    "--status <S>              list: filter; new/reopen: open status (未决); close: closed status (已修)",
  priority:
    "--priority <P>            list: filter by priority; new: P0–P3 or \"\" (default P2); change later: issuemd priority FILE ID P",
  closed: "--closed                  list: show the closed table instead of the index",
  expand: "--expand                  list: one entry per id (a `20, 24` or `7–20` row becomes several)",
  "with-body":
    "--with-body               list --json: add each issue's body labels and 验收判据 from one parse\n" +
    "                            (the `show --json` fields, without 61 separate calls)",
  label: "--label <NAME>            show: print only the **NAME** block",
  title: "--title <T>               new: summary/body title (starts with '-'? write --title=\"-…\")",
  id: "--id <N>                  new: explicit issue id",
  "allow-duplicate-title":
    "--allow-duplicate-title   write it even though another open issue has the same summary",
  "body-file": "--body-file <path|->      new/body: body text under the heading (no `### Issue` line), or '-' for stdin",
  criteria: "--criteria <TEXT>         close: criteria column text",
  "criteria-from-body":
    "--criteria-from-body      close: lift the **验收判据** block into the column (the default\n" +
    "                            when the body has one); refuses if it is missing or empty",
  "no-criteria": "--no-criteria             close: close with an empty criteria cell on purpose",
  "keep-body": "--keep-body               close: move the body into 附录 instead of deleting it",
  guide: "--guide                   sync: rewrite the controlled guide and status blocks",
  "fix-tables": "--fix-tables              sync: add missing table separator rows",
  titles: "--titles                  sync: align body headings with index summaries",
  prefer: "--prefer <body|table>     sync --titles: which side wins (default body)",
  "move-progress": "--move-progress           sync --titles: move progress text into the body",
  "drop-progress": "--drop-progress           sync --titles: discard progress text",
  report: "--report <path>           adopt: write the decision list to a new file (or over an earlier report)",
  "dry-run": "--dry-run                 write: print a unified diff, don't modify the file; stderr gives its snapshot",
  "if-unchanged":
    "--if-unchanged <S>        write: exit 4 unless the file still has snapshot S (printed by --dry-run;\n" +
    "                            also the `snapshot` field of JSON views), so you apply what you reviewed",
};

const READ_COMMANDS: Command[] = ["check", "list", "show", "counts", "read"];
const HELP = [
  "issuemd — read and maintain a single-file Markdown issue ledger",
  "",
  "Usage:",
  ...READ_COMMANDS.map((name) => `  ${COMMANDS[name].usage}`),
  "",
  "  [write — atomic, keeps BOM/line endings/mode; --dry-run prints a diff]:",
  ...(Object.keys(COMMANDS) as Command[]).filter((name) => !READ_COMMANDS.includes(name))
    .map((name) => `  ${COMMANDS[name].usage}`),
  "",
  "  issuemd <command> --help   that command's usage and options",
  "",
  "Options:",
  ...Object.values(OPTION_HELP).map((text) => `  ${text}`),
  "",
  EXIT_CODES,
  "",
].join("\n");

function commandHelp(name: Command): string {
  const { usage, options } = COMMANDS[name];
  const lines = [`usage: ${usage}`, ""];
  if (options.length > 0) lines.push("Options:", ...options.map((option) => `  ${OPTION_HELP[option]}`), "");
  lines.push(EXIT_CODES, "");
  return lines.join("\n");
}

export type CliResult = { code: number; stdout: string; stderr: string };

function ok(s: string): CliResult {
  return { code: 0, stdout: s, stderr: "" };
}
function noMatch(s: string): CliResult {
  return { code: 1, stdout: s, stderr: "" };
}
/** A write verb's "no such issue": stderr, so it never mixes into a --dry-run diff on stdout. */
function missingIssue(verb: string, id: string): CliResult {
  const bad = badIdText(verb, id);
  if (bad) return bad;
  return { code: 1, stdout: "", stderr: `issuemd ${verb}: no such issue: ${id}\n` };
}
/** `4-x` is not "absent", it is not an id at all: a usage error (exit 2). */
function badIdText(verb: string, id: string): CliResult | undefined {
  if (parseId(id)) return undefined;
  // A cell like `30, 31` is what `list` prints for one row; passing it back is
  // the natural script mistake. Name the ids and the way forward instead of
  // only "not an issue id" (dogfood #71).
  const spans = parseIds(id);
  if (spans && spans.length > 1) {
    const spelled = spans.map(spanText).join(", ");
    const hint = verb === "show"
      ? "pass one id, or use 'issuemd list FILE --expand'"
      : `pass one id, or split that row first with 'issuemd split FILE ${spanText(spans[0]!)}'`;
    return err(
      `issuemd ${verb}: '${id}' looks like one row holding ${spans.length} ids (${spelled}), not a single issue; ${hint}\n`,
      2,
    );
  }
  return err(`issuemd ${verb}: '${id}' is not an issue id (expected something like 42 or 393b)\n`, 2);
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
  "if-unchanged": { type: "string" },
  // new
  title: { type: "string" },
  id: { type: "string" },
  "allow-duplicate-title": { type: "boolean" },
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
  // list
  expand: { type: "boolean" },
  "with-body": { type: "boolean" },
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
    const message = (e as Error).message;
    const hint = /ambiguous/.test(message)
      ? "A value that starts with '-' must be attached with '=', e.g. --title=\"--body-file is confusing\".\n"
      : "";
    return err(`issuemd: ${message}\n${hint}Try 'issuemd --help'.\n`, 2);
  }

  const { values, positionals } = parsed;
  const head = positionals[0];
  if (head == null) {
    return values.help ? ok(HELP) : err("issuemd: missing command. Try 'issuemd list FILE' or 'issuemd --help'\n", 2);
  }
  if (Object.hasOwn(COMMANDS, head)) {
    const command = head as Command;
    if (values.help) return ok(commandHelp(command));
    const allowed: readonly string[] = COMMANDS[command].options;
    const stray = Object.keys(values).filter((name) => !allowed.includes(name));
    if (stray.length > 0) {
      return err(
        `issuemd ${command}: ${stray.map((name) => `--${name}`).join(", ")} ${stray.length > 1 ? "are" : "is"} ` +
          `not supported by '${command}'\nusage: ${COMMANDS[command].usage}\n`,
        2,
      );
    }
  } else if (values.help) {
    return ok(HELP);
  }
  // Hex is case-insensitive; snapshots are printed (and compared) in lower case.
  if (typeof values["if-unchanged"] === "string") values["if-unchanged"] = values["if-unchanged"].toLowerCase();
  const expected = values["if-unchanged"];
  if (expected != null && !SNAPSHOT.test(expected)) {
    return err(`issuemd: --if-unchanged expects the 16-hex-digit snapshot printed by --dry-run or a --json view, got '${expected}'\n`, 2);
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
    case "body":
      return cmdBody(positionals.slice(1), values);
    case "priority":
      return cmdPriority(positionals.slice(1), values);
    case "split":
      return cmdSplit(positionals.slice(1), values);
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
    return err(`usage: ${COMMANDS.check.usage}\n`, 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  try {
    const report = checkLedger(loaded.src, file, {
      strict: v.strict,
      verifyCommits: v["verify-commits"],
    });
    const code = report.ok ? 0 : 3;
    if (v.json) {
      return { code, stdout: JSON.stringify({ ...report, snapshot: snapshotOf(loaded.src) }, null, 2) + "\n", stderr: "" };
    }
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
    return err(`usage: ${COMMANDS.list.usage}\n`, 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const ledger = parseLedger(loaded.src);
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;
  if (v["with-body"] && !v.json) {
    return err("issuemd list: --with-body applies to --json output; add --json\n", 2);
  }
  const report = checkLedger(loaded.src, file);

  const table = v.closed ? "closed" : "open";
  // A typo'd filter used to look exactly like an empty result (dogfood #33).
  // A word that really occurs in the ledger is always allowed: that is how
  // rows with an undeclared status (W220) are found.
  const everyRow = [...ledger.rows.open, ...ledger.rows.closed];
  if (v.status != null && !statusCategory(v.status) && !everyRow.some((row) => row.status === v.status)) {
    return err(
      `issuemd list: unknown status '${v.status}'; statuses: ${Object.keys(STATUS_CLASSES).join(" / ")}\n`,
      2,
    );
  }
  if (v.priority != null && !PRIORITIES.includes(v.priority) && !everyRow.some((row) => row.priority === v.priority)) {
    return err(`issuemd list: unknown priority '${v.priority}'; priorities: ${PRIORITIES.filter(Boolean).join(" / ")}\n`, 2);
  }
  const rows = filterRows(ledger.rows[table], { status: v.status, priority: v.priority });
  const wrongTable = v.status != null && statusCategory(v.status) != null && statusCategory(v.status) !== table
    ? `'${v.status}' is ${statusCategory(v.status)}; ${table === "open" ? "add --closed" : "drop --closed"} to list it\n`
    : "";
  const incomplete = unreadableNote(ledger);
  const stderr = structureNote(report.errors, new Set(ledger.unreadable.map((row) => row.line))) +
    wrongTable + incomplete;
  let issues = rows.map((row) => toListedIssue(row, table));
  if (v.expand) {
    const expanded = expandIssues(issues);
    if (!expanded) return err("issuemd list: --expand would produce more than 100000 entries\n", 2);
    issues = expanded;
  }
  if (v["with-body"]) {
    const blocks = bodyBlocks(ledger);
    issues = issues.map((issue) => withBody(ledger, issue, blocks));
  }
  if (v.json) {
    const unreadableRows = ledger.unreadable
      .filter((row) => row.table === table || row.table === "stray")
      .map(({ line, reason, ids }) => ({ line, reason, ...(ids ? { ids: ids.map(spanText) } : {}) }));
    // Ids reserved by W225 tables: not issues, but `new` will not hand them out.
    const citedRows = ledger.cited.map(({ line, reason, ids }) => ({ line, reason, ids: (ids ?? []).map(spanText) }));
    const body = JSON.stringify(
      {
        file,
        snapshot: snapshotOf(loaded.src),
        table,
        rowCount: rows.length,
        issueCount: issues.reduce((sum, issue) => sum + issue.count, 0),
        issues,
        ...(unreadableRows.length ? { unreadableRows } : {}),
        ...(citedRows.length ? { citedRows } : {}),
        ...diagnosticsField(report.errors),
      },
      null,
      2,
    );
    return { code: rows.length === 0 ? 1 : 0, stdout: body + "\n", stderr };
  }
  if (rows.length === 0) return { code: 1, stdout: "(no issues)\n", stderr };
  return { code: 0, stdout: issues.map(formatListedIssue).join("\n") + "\n", stderr };
}

/** The unreadable row whose first cell names `id`, if any. */
function unreadableHolding(ledger: ReturnType<typeof parseLedger>, id: string, rows = ledger.unreadable) {
  const wanted = parseId(id);
  if (!wanted) return undefined;
  return rows.find((row) => (row.ids ?? []).some((span) =>
    span.suffix === wanted.suffix && span.start <= wanted.start && wanted.start <= span.end));
}

/** A stderr note for read views when some table rows could not be parsed. */
function unreadableNote(ledger: ReturnType<typeof parseLedger>): string {
  if (ledger.unreadable.length === 0) return "";
  const listed = ledger.unreadable.slice(0, 5).map(({ line, reason }) => `  L${line}: ${reason}`).join("\n");
  return `warning: ${ledger.unreadable.length} table row(s) could not be read; this result is incomplete ` +
    `(run 'issuemd check'):\n${listed}\n`;
}

/**
 * A read view of a ledger whose `check` fails must say so: `list`, `counts`
 * and `show` used to exit 0 with no hint while `check` exited 3, so a caller
 * could not tell it was reading a ledger the tool itself rejects (dogfood
 * #63). Exit codes stay 0/1 — reading a broken ledger to repair it is a
 * legitimate use. Errors already described by `unreadableNote` (same lines)
 * are left out, so one bad row is not reported twice.
 */
function structureNote(errors: Diagnostic[], known: Set<number> = new Set()): string {
  // N is what `check` reports, so the two views agree. Suppressing the note
  // when every error sat on an unreadable row (round 13) left `show` silent
  // on an E108-only ledger; `known` now only picks a readable "first".
  if (errors.length === 0) return "";
  const first = errors.find(({ line }) => !known.has(line)) ?? errors[0]!;
  return `note: 'issuemd check' reports ${errors.length} error(s) (first: ${first.code} L${first.line}` +
    `${first.id ? ` #${first.id}` : ""}); this view may not reflect the ledger\n`;
}

/** The same fact for `--json` consumers: only present when there are errors. */
function diagnosticsField(errors: Diagnostic[]): { diagnostics?: { errors: Record<string, unknown>[] } } {
  if (errors.length === 0) return {};
  return {
    diagnostics: {
      errors: errors.map(({ code, line, id, message, expected, actual }) => ({
        code, line, ...(id !== undefined ? { id } : {}), message,
        ...(expected !== undefined ? { expected, actual } : {}),
      })),
    },
  };
}

function cmdCounts(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) return err(`usage: ${COMMANDS.counts.usage}\n`, 2);
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const report = checkLedger(loaded.src, file);
  const ledger = parseLedger(loaded.src);
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;
  const stderr = structureNote(report.errors, new Set(ledger.unreadable.map((row) => row.line))) +
    unreadableNote(ledger);
  if (v.json) return { code: 0, stdout: JSON.stringify({ file, snapshot: snapshotOf(loaded.src), counts: report.counts, ...diagnosticsField(report.errors) }, null, 2) + "\n", stderr };
  return { code: 0, stdout: summaryLine(report.counts) + "\n", stderr };
}

function cmdShow(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const id = rest[1];
  if (file == null || id == null || rest.length !== 2) {
    return err(`usage: ${COMMANDS.show.usage}\n`, 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const ledger = parseLedger(loaded.src);
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;
  const report = checkLedger(loaded.src, file);
  const view = viewIssue(ledger, id);
  if (!view) {
    const bad = unreadableHolding(ledger, id);
    if (bad) {
      return err(`issuemd show: #${id} is in an unreadable table row (L${bad.line}: ${bad.reason}); fix it, then re-run\n`, 3);
    }
    // With --json, stdout is JSON or nothing: a script parsing it must not
    // get the text-mode placeholder.
    // Cited by a W225 table: not tracked, but say where the number is used.
    const cited = unreadableHolding(ledger, id, ledger.cited);
    const citedNote = cited ? `issuemd show: #${id} is not tracked, but is cited at L${cited.line} (${cited.reason})\n` : "";
    const missing = badIdText("show", id) ??
      (v.json ? { code: 1, stdout: "", stderr: `issuemd show: no such issue: ${id}\n` } : noMatch(`(no such issue: ${id})\n`));
    // A miss on a ledger whose check fails is worth a note too (review 13).
    const missNote = structureNote(report.errors, new Set(ledger.unreadable.map((row) => row.line)));
    const result = citedNote && missing.code === 1 ? { ...missing, stderr: citedNote + missing.stderr } : missing;
    return missNote === "" ? result : { ...result, stderr: missNote + result.stderr };
  }
  // The same id may also sit in a row show cannot read (an old 待处理 table,
  // E124): this view is then only one of two conflicting records.
  const twin = unreadableHolding(ledger, id);
  const twinNote = twin
    ? `warning: #${id} also appears in an unreadable table row (L${twin.line}: ${twin.reason}); ` +
      "this view may be out of date (run 'issuemd check')\n"
    : "";
  // A multi-id row may keep one body under a sibling id; say whose it is
  // instead of presenting it as this issue's own (dogfood #69).
  const inheritedNote = view.body?.inherited
    ? `note: the body shown belongs to #${view.body.id} (same row; #${view.id} has no body block of its own)\n`
    : "";
  const baseNote = structureNote(report.errors, new Set(ledger.unreadable.map((row) => row.line))) + inheritedNote;
  const withNote = (result: CliResult): CliResult =>
    baseNote === "" && twinNote === "" ? result : { ...result, stderr: baseNote + twinNote + result.stderr };

  if (v.label != null) {
    const range = view.body ?? { line: view.line, end: view.line };
    const found = findLabel(ledger.lines, range.line, range.end, labelName(v.label));
    if (!found) {
      const known = labelsIn(ledger.lines, range.line, range.end);
      // With --json, stdout is JSON or nothing — a caller parsing it must not
      // receive the text-mode placeholder (same rule as "no such issue").
      const knownNote = known.length ? `labels in #${view.id}: ${known.join(", ")}\n` : "";
      return withNote(v.json
        ? { code: 1, stdout: "", stderr: `(no label: ${v.label})\n${knownNote}` }
        : { code: 1, stdout: `(no label: ${v.label})\n`, stderr: knownNote });
    }
    if (found.text === "") {
      // An empty label is not a successful read: `close --criteria-from-body`
      // would promote it as an empty cell.
      const why = `label ${v.label} in #${view.id} exists but is empty (L${found.line})\n`;
      return withNote(v.json
        ? { code: 1, stdout: "", stderr: `(empty label: ${v.label})\n${why}` }
        : { code: 1, stdout: `(empty label: ${v.label})\n`, stderr: why });
    }
    if (v.json) return withNote(ok(JSON.stringify({ ...view, paragraph: found.text, snapshot: snapshotOf(loaded.src), ...diagnosticsField(report.errors) }, null, 2)));
    return withNote(ok(found.lines.join("\n")));
  }

  if (v.json) return withNote(ok(JSON.stringify({ ...view, snapshot: snapshotOf(loaded.src), ...diagnosticsField(report.errors) }, null, 2)));

  const lines = [`#${view.id}  ${view.status}  ${view.priority || "-"}  ${view.summary}`];
  lines.push(`L${view.body?.line ?? view.line}-${view.body?.end ?? view.end}`);
  if (view.body?.inherited) lines.push(`正文属于 #${view.body.id}（同一行；本号没有自己的正文块）`);
  if (view.criteria) lines.push(`判据: ${view.criteria}`);
  lines.push("");
  if (view.body) {
    lines.push(view.body.text);
  } else if (view.table === "closed") {
    lines.push("(已关闭，只保留判据)");
  } else {
    lines.push("(无正文块)");
  }
  return withNote(ok(lines.join("\n")));
}

/**
 * Read one top-level section by its exact H2 title. No selectors: the ledger
 * only ever needs "give me `## 附录`" or "give me this named section".
 */
function cmdRead(rest: string[]): CliResult {
  const file = rest[0];
  const title = rest[1];
  if (file == null || title == null || rest.length !== 2) {
    return err(`usage: ${COMMANDS.read.usage}\n`, 2);
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

/**
 * `path` is where the bytes really live: a symlinked ledger is read and
 * written through to its target, so the link itself survives the atomic
 * rename (dogfood #19). `links` > 1 means other hard links exist; they keep
 * the old inode after a rename, which callers are warned about.
 */
type Loaded = { doc: Document; lines: string[]; path: string; links: number; snapshot: string };

/**
 * A short content hash of the file's bytes (dogfood #18). Read views report
 * it, `--dry-run` prints it, and `--if-unchanged` refuses a write when the
 * file no longer has it — closing the gap between a reviewed preview and the
 * real run that E130 (which only guards one command's own read) cannot see.
 */
export function snapshotOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
const SNAPSHOT = /^[0-9a-f]{16}$/;

function snapshotNote(loaded: Loaded): string {
  return `snapshot: ${loaded.snapshot} (apply exactly this preview: add --if-unchanged ${loaded.snapshot})\n`;
}

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

function loadWritable(file: string, expected?: string): Loaded | CliResult {
  if (file === "-") return err("issuemd: write commands do not support stdin ('-')\n", 2);
  try {
    const path = lstatSync(file).isSymbolicLink() ? realpathSync(file) : file;
    const links = statSync(path).nlink;
    const blocked = writeBlockReason(path);
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
    const doc = readDocument(path);
    // Split without the trailing sentinel: `joinDocument` adds the final
    // newline back, so keeping the "" would double it on every rewrite.
    const lines = doc.text === ""
      ? []
      : (doc.finalNewline ? doc.text.slice(0, -1) : doc.text).split("\n");
    const snapshot = snapshotOf(joinDocument(lines, doc));
    if (expected != null && expected !== snapshot) {
      return err(
        `issuemd: E130 '${file}' changed since snapshot ${expected} (now ${snapshot}); ` +
          "re-read or re-run the dry-run, review again, then retry\n",
        4,
      );
    }
    return { doc, lines, path, links, snapshot };
  } catch (e) {
    return openFailure(file, e);
  }
}

/**
 * A write command could not read its ledger. io's "E130 file changed while
 * being read" means another writer replaced the file mid-read: that is the
 * concurrency case, retryable like every other E130 (exit 4), not an I/O error.
 */
export function openFailure(file: string, e: unknown): CliResult {
  const message = (e as Error).message;
  if (message.startsWith("E130")) {
    return err(`issuemd: E130 '${file}' changed while it was being read; re-read and retry\n`, 4);
  }
  return err(`issuemd: cannot open '${file}': ${message}\n`, 2);
}

/**
 * A document with no final newline must not end in a newline after a write.
 * An appended block usually ends in a blank line, and `join("\n")` would turn
 * that blank into a trailing newline — so drop trailing blank lines whenever
 * the source had none.
 */
function terminate(lines: string[], doc: Document, original: string[] = []): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  if (!doc.finalNewline) return end === lines.length ? lines : lines.slice(0, end);
  // A write never adds blank lines at the end of the file: removing the last
  // body of 正文 used to leave its separating blank line dangling at EOF.
  let kept = 0;
  while (kept < original.length && original[original.length - 1 - kept] === "") kept++;
  const allowed = Math.min(lines.length - end, kept);
  return end + allowed === lines.length ? lines : lines.slice(0, end + allowed);
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
  /**
   * Diagnostics this verb may introduce on purpose. Only `split` uses it: a
   * range row reports one E102 for its first missing body, and splitting it
   * reports one per id — the same missing bodies, now named individually
   * (dogfood #64). Everything else keeps the strict "no new error" gate.
   */
  tolerate?: (diagnostic: Diagnostic) => boolean,
): CliResult {
  const newLines = terminate(candidate, loaded.doc, loaded.lines);
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
  const refused = tolerate ? introduced.filter((diagnostic) => !tolerate(diagnostic)) : introduced;
  if (refused.length > 0) {
    return err(
      `issuemd: refusing to write; the change would introduce ${refused.length} error(s):\n` +
        formatDiagnostics(refused) + "\n",
      3,
    );
  }
  if (dryRun) {
    const diff = unifiedDiff(loaded.lines, newLines, file, loaded.doc.finalNewline, loaded.doc.eol, loaded.doc.bom ? "\uFEFF" : "");
    return { code: 0, stdout: diff || "(no changes)\n", stderr: snapshotNote(loaded) };
  }
  const unchanged = newLines.length === loaded.lines.length &&
    newLines.every((line, index) => line === loaded.lines[index]);
  // A verb that asked for the state the ledger is already in changed nothing;
  // say that on stdout (the same words `--dry-run` uses) instead of exiting 0
  // with empty output, which a retrying caller could not tell from a write
  // (dogfood #66).
  if (unchanged) return ok("(no changes)\n");
  const readOnly = readOnlyRefusal(file, loaded);
  if (readOnly) return readOnly;
  try {
    const written = lockedWrite(loaded.path, content, loaded.doc.stat);
    if ("locked" in written) return written.locked;
    if (!written.ok) {
      return err(`issuemd: E130 '${file}' changed after it was read; re-read and retry\n`, 4);
    }
  } catch (error) {
    return err(`issuemd: cannot write '${file}': ${(error as Error).message}\n`, 2);
  }
  return { code: 0, stdout: "", stderr: hardLinkNote(file, loaded) };
}

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 30_000;

function holderAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * writeAtomically re-checks the snapshot right before its rename, but two
 * writers can both pass that check and then both rename: the first write is
 * lost while its command exited 0 (round-ten probe: 7 of 29 parallel writes).
 * A lock file beside the ledger makes check + rename one critical section
 * among issuemd writers; the loser then sees the new snapshot and exits 4.
 * Held for milliseconds, so a waiter polls briefly; a lock whose holder is
 * gone (or that is far older than any write) is taken over.
 */
function lockedWrite(
  path: string,
  content: string,
  expected: Document["stat"],
): ReturnType<typeof writeAtomically> | { locked: CliResult } {
  const lock = join(dirname(path), `.${basename(path)}.issuemd-lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } catch (error) {
        closeSync(fd);
        unlinkSync(lock);
        throw error;
      }
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder = NaN;
    let age = 0;
    // A lock path issuemd cannot read (a directory, a dangling link, mode
    // 000) was not made by a writer: never take it over, but never spin on
    // it either — wait out the deadline like any held lock.
    let readable = true;
    try {
      holder = Number.parseInt(readFileSync(lock, "utf8"), 10);
      age = Date.now() - statSync(lock).mtimeMs;
    } catch (error) {
      // ENOENT is "released meanwhile" only if the path itself is gone; a
      // dangling symlink also reads as ENOENT and would spin forever.
      let gone = false;
      try {
        lstatSync(lock);
      } catch {
        gone = true;
      }
      if (gone) continue;
      readable = false;
    }
    // An empty file is a holder that has not written its pid yet.
    const starting = Number.isNaN(holder) && age < LOCK_STALE_MS;
    if (readable && !starting && (!holderAlive(holder) || age > LOCK_STALE_MS)) {
      try {
        unlinkSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (Date.now() >= deadline) {
      return {
        locked: err(
          `issuemd: another issuemd write is in progress (lock '${lock}', pid ${Number.isNaN(holder) ? "?" : holder}); ` +
            "nothing written. Retry; if no issuemd is running, delete the lock file\n",
          4,
        ),
      };
    }
    Atomics.wait(pause, 0, 0, 10);
  }
  try {
    return writeAtomically(path, content, expected);
  } finally {
    // Release only our own lock: if it was taken over as stale meanwhile,
    // the file now belongs to another writer.
    try {
      if (Number.parseInt(readFileSync(lock, "utf8"), 10) === process.pid) unlinkSync(lock);
    } catch {
      // Already gone: nothing to release.
    }
  }
}

/**
 * An atomic replace only needs the directory to be writable, so a ledger
 * someone made read-only (chmod 444, to protect it) would be rewritten
 * anyway. Honour the mode: dry-runs still work, real writes do not.
 */
function readOnlyRefusal(file: string, loaded: Loaded): CliResult | undefined {
  try {
    accessSync(loaded.path, fsConstants.W_OK);
    return undefined;
  } catch {
    return err(`issuemd: refusing to write '${file}': the file is read-only (make it writable first); nothing written\n`, 2);
  }
}

/** The atomic rename gives the ledger a new inode; other hard links keep the old one. */
function hardLinkNote(file: string, loaded: Loaded): string {
  if (loaded.links <= 1) return "";
  return `warning: '${file}' had ${loaded.links - 1} other hard link(s); they still show the old content ` +
    "(an atomic write replaces the file). Use one path, or a symlink, for a shared ledger.\n";
}

/** Ledger view plus the exact bytes it came from, for write verbs. */
function openLedger(
  file: string,
  expected?: string,
): { loaded: Loaded; ledger: ReturnType<typeof parseLedger>; errors: Diagnostic[] } | CliResult {
  const loaded = loadWritable(file, expected);
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

/**
 * A row holding several ids, or a range, cannot be changed for one id. Every
 * per-id verb refuses it the same way and names the command that fixes it.
 */
function perIdRefusal(verb: string, idText: string, found: NonNullable<ReturnType<typeof findRow>>): CliResult | null {
  if (!found.inRange && found.row.ids.length === 1) return null;
  const ids = found.row.ids.map(spanText).join(", ");
  const what = found.row.ids.length > 1 ? `shares a row with other ids (${ids})` : `is inside the range ${ids}`;
  return err(`issuemd ${verb}: #${idText} ${what}; split the row first: issuemd split FILE ${idText}\n`, 2);
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
/** Why a summary cannot become a body heading, or null. */
function titleProblem(title: string): string | null {
  // new/rename refuse an empty title up front; reopen of an empty summary
  // would otherwise write `### Issue N: ` (round-twelve probe).
  if (title.trim() === "") return "the title is empty.";
  // A heading ending in a count is E121 (spec §2.2); say it before the gate does.
  if (countSuffix(title)) {
    return "the title ends with a count like '（2）'; headings must not carry counts (E121). Drop or reword it.";
  }
  return titleEndsWithHash(title);
}

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
function readBodyFile(spec: string, verb = "new"): { lines: string[] } | CliResult {
  try {
    const raw = spec === "-" ? readFileSync(0, "utf8") : readFileSync(spec, "utf8");
    // A UTF-8 BOM is an encoding marker, not body text. Left in place it ends
    // up mid-document and breaks label matching on the first line.
    const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const lines = src.replaceAll("\r\n", "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    // The heading is followed by exactly one blank line; leading blanks in
    // the input (`show --json` body.text minus its heading starts with one)
    // would otherwise pile up on every edit.
    while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
    // An unclosed fence would swallow every heading after the body — including
    // `## 附录` — and `check` would still pass, so refuse it up front.
    if (endsInFence(lines)) {
      return err(`issuemd ${verb}: --body-file ends inside an unclosed code fence\n`, 2);
    }
    // The most common slip: piping `show --json` body.text (which includes
    // the heading) straight back. The gate would only say E105/E106.
    if (lines.length > 0 && /^ {0,3}#{1,6}[ \t]+Issue\s+\S+?\s*:/.test(lines[0]!)) {
      return err(
        `issuemd ${verb}: --body-file starts with an issue heading ('${lines[0]!.trim()}'); ` +
          "the body is the text below the heading, which issuemd writes itself. Drop that first line " +
          "(show --json body.text includes it)\n",
        2,
      );
    }
    // A top-level heading inside a body ends the issue block early: `show`
    // stops at it and `close` leaves it behind as orphaned content, all while
    // `check` stays green.
    const fenced = fencedLines(lines);
    const heading = lines.findIndex((line, index) => !fenced[index] && /^ {0,3}#{1,2}(?:[ \t]|$)/.test(line));
    if (heading !== -1) {
      return err(
        `issuemd ${verb}: --body-file may not contain a top-level heading (## or #): '${lines[heading]!.trim()}'.\n` +
          "Use **bold labels** inside an issue body.\n",
        2,
      );
    }
    // The marker ends a kept-body archive; in a body it would cut the archive
    // short at close --keep-body. Inside a fence it is an example and fine.
    const marker = lines.findIndex((line, index) => !fenced[index] && line.trim() === KEPT_BODY_END);
    if (marker !== -1) {
      return err(
        `issuemd ${verb}: --body-file may not contain the line '${KEPT_BODY_END}' outside a code fence ` +
          "(it marks the end of a kept-body archive)\n",
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
    return err(`usage: ${COMMANDS.new.usage}\n`, 2);
  }
  if (v.title == null || v.title.trim() === "") return err("issuemd new: --title is required\n", 2);
  const title = unescapeCell(v.title.trim().replace(/\s+/g, " "));
  const badTitle = titleProblem(title);
  if (badTitle) return err(`issuemd new: ${badTitle}\n`, 2);
  const status = v.status ?? "未决";
  const priority = v.priority ?? "P2";
  if (!PRIORITIES.includes(priority)) {
    return err(`issuemd new: --priority expects one of ${PRIORITIES.filter(Boolean).join(", ")} or "", got '${priority}'\n`, 2);
  }
  const category = statusCategory(status);
  if (!category) return err(`issuemd new: unknown status '${status}'\n`, 2);
  if (category === "closed") {
    return err(
      `issuemd new: '${status}' is a closed status; create the issue open, then run ` +
        `'issuemd close FILE ID --status ${status} --criteria "…"'\n`,
      2,
    );
  }

  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  // A retried `new` (the first call landed, its reply was lost) is the usual
  // way a ledger grows a duplicate. Refuse and name the existing issue so the
  // caller can treat it as filed (dogfood #34); closed rows never block.
  const twin = ledger.rows.open.find((row) => summaryKey(row.summary) === summaryKey(title));
  if (twin && !v["allow-duplicate-title"]) {
    const ids = twin.ids.map(spanText).join(", ");
    return err(
      `issuemd new: open issue #${ids} already has this summary ('${twin.summary}'); nothing written. ` +
        "If this is a retry, it is already filed. To file another one anyway, add --allow-duplicate-title\n",
      2,
    );
  }

  const max = maxIssueId(ledger.rows, ledger.unreadable);
  // Ids cited by W225 tables are reserved but not issues: skip them one by
  // one instead of jumping past the largest (an error-code table citing 500
  // must not move the next issue to 501).
  let next = max + 1;
  for (let cited = unreadableHolding(ledger, String(next), ledger.cited); cited;
    cited = unreadableHolding(ledger, String(next), ledger.cited)) {
    // Step over the whole cited span at once (`1–900000000` must not loop).
    const span = (cited.ids ?? []).find((s) => s.suffix === "" && s.start <= next && next <= s.end);
    next = span ? span.end + 1 : next + 1;
  }
  let idText = String(next);
  if (v.id == null && !Number.isSafeInteger(next)) {
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
    const bad = unreadableHolding(ledger, idText);
    if (bad) return err(`issuemd new: id ${idText} already exists in an unreadable row (L${bad.line}: ${bad.reason})\n`, 2);
    const cited = unreadableHolding(ledger, idText, ledger.cited);
    if (cited) {
      return err(
        `issuemd new: id ${idText} is reserved: L${cited.line} is ${cited.reason}; ` +
          "pick another id, or rename that table's '#' column if its numbers are not issues\n",
        2,
      );
    }
  }
  const span = parseId(idText);
  if (!span) return err(`issuemd new: '${idText}' is not a valid issue id\n`, 2);

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
      if (compareIds(row.ids[0]!, span) > 0) return row.line;
    }
    return index.end + 1;
  })();

  let lines = insertLines(loaded.lines, insertAt, [formatRow([idText, status, priority, title])]);
  // The body position is computed after the index edit, which sits above 正文
  // and therefore shifts every later line by one.
  const afterIndex = parseLedger(lines.join("\n"));
  const shiftedBody = afterIndex.sections.find((section) => section.level === 2 && section.title === "正文");
  if (!shiftedBody) return err("issuemd new: the 正文 section is missing\n", 3);
  lines = insertBlock(lines, bodyInsertAt(afterIndex, span, shiftedBody.line_end), body);

  const committed = commit(file, loaded, errors, lines, !!v["dry-run"]);
  // A caller that let `new` pick the id must learn it from this reply:
  // re-listing to guess "the newest row" races with other writers.
  const result = committed.code === 0 && !v["dry-run"] ? { ...committed, stdout: `${idText}\n` } : committed;
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
    return err(`usage: ${COMMANDS.close.usage}\n`, 2);
  }
  // `--criteria "$CRIT"` with CRIT unset is the usual way to pass nothing;
  // that is --no-criteria by accident, so say so instead of writing it.
  if (v.criteria != null && v.criteria.trim() === "") {
    return err("issuemd close: --criteria is empty; pass the criteria text, or --no-criteria to close without any\n", 2);
  }
  const criteriaFlags = [v.criteria != null, !!v["criteria-from-body"], !!v["no-criteria"]].filter(Boolean).length;
  if (criteriaFlags > 1) {
    return err("issuemd close: choose one of --criteria, --criteria-from-body, --no-criteria\n", 2);
  }
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return missingIssue("close", idText);
  // Same row, same diagnosis for every per-id verb: check the row shape
  // before "already closed", or a multi-id closed row reads as a state error.
  const refused = perIdRefusal("close", idText, found);
  if (refused) return refused;
  if (found.table === "closed") return err(`issuemd close: #${idText} is already closed\n`, 2);
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
    // Input convention, as for titles: `\|` is how a caller spells a literal
    // pipe (unescapeCell); the cell then stores the escaped form.
    criteria = unescapeCell(v.criteria);
  } else if (v["no-criteria"]) {
    criteria = "";
  } else if (v["criteria-from-body"]) {
    if (fromBody == null) {
      return err(
        `issuemd close: #${idText} has no non-empty **验收判据** in its body (a label line inside a code fence is an example and does not count); ` +
          "pass --criteria TEXT or --no-criteria\n",
        2,
      );
    }
    criteria = fromBody;
  } else if (fromBody != null) {
    criteria = fromBody; // the default: promote what the body already says
  } else if (keepBody) {
    criteria = ""; // nothing is lost: the whole body moves to 附录
  } else if (v["keep-body"]) {
    return err(
      `issuemd close: #${idText} has no body to keep and no criteria to record; ` +
        "pass --criteria TEXT, or --no-criteria to close it without criteria on purpose\n",
      2,
    );
  } else {
    return err(
      `issuemd close: #${idText} has no criteria to record (no --criteria and no **验收判据** in the body). ` +
        "Pass --criteria TEXT, --keep-body, or --no-criteria to close it without criteria on purpose\n",
      2,
    );
  }

  // A table cell cannot store a backslash directly before `|`: the reader
  // takes it as a pipe escape (`echo a \| b` reads back as `echo a | b`), so
  // promoting the text would change it silently. Refuse and name the ways
  // out (round 14 black-box finding).
  if (unescapeCell(escapeCell(criteria)) !== criteria) {
    return err(
      `issuemd close: the criteria contain '\\|' (a backslash directly before a pipe), which a table cell cannot store without changing it; ` +
        "pass --criteria with the text as it should read in the table, or close with --keep-body --no-criteria to keep the body verbatim in 附录\n",
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
      const keptFenced = fencedLines(kept);
      if (kept.some((line, index) => !keptFenced[index] && line.trim() === KEPT_BODY_END)) {
        return err(
          `issuemd close: the body of #${idText} contains '${KEPT_BODY_END}' outside a code fence; ` +
            "reopen would cut the body there. Fence it or remove it first (issuemd body)\n",
          3,
        );
      }
      archive = [
        archiveHeading(idText, found.row.summary),
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
    // An archive appended after an unclosed fence is code to every reader:
    // check and reopen would never see it (the body is gone for good).
    const insertAt = target ? target.line_end : lines.length;
    if (endsInFence(lines.slice(0, insertAt))) {
      return err(
        `issuemd close: 附录 ends inside an unclosed code fence; close the fence first, ` +
          "or the kept body would be swallowed by it\n",
        3,
      );
    }
    // A second archive for the same id (an old one without an end marker, a
    // W252 leftover) would make reopen restore the wrong text.
    const fencedNow = fencedLines(lines);
    const existing = lines.findIndex((text, index) => !fencedNow[index] && ARCHIVE_HEADING.exec(text)?.[1] === idText);
    if (existing >= 0) {
      return err(
        `issuemd close: 附录 already has an archive for #${idText} (L${existing + 1}); ` +
          "merge or remove it first, then close --keep-body\n",
        3,
      );
    }
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
    return { code: 0, stdout: result.stdout, stderr: result.stderr + `W250: kept the body of #${idText} by moving it into 附录\n` };
  }
  return result;
}

function cmdReopen(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const idText = rest[1];
  if (file == null || idText == null || rest.length !== 2) {
    return err(`usage: ${COMMANDS.reopen.usage}\n`, 2);
  }
  const reopenStatus = v.status ?? "未决";
  if (statusCategory(reopenStatus) !== "open") {
    return err(`issuemd reopen: --status expects an open status (未决 / 部分解决 / 观察), got '${reopenStatus}'\n`, 2);
  }
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return missingIssue("reopen", idText);
  const refused = perIdRefusal("reopen", idText, found);
  if (refused) return refused;
  if (found.table === "open") {
    // Already open: asking for the status it already has changes nothing
    // (the `(no changes)` contract); asking for another open status is a
    // plain status update. Neither can create a second open row, so the
    // duplicate-summary guard below does not apply to this branch.
    if (found.row.status === reopenStatus) {
      return v["dry-run"]
        ? { code: 0, stdout: "(no changes)\n", stderr: snapshotNote(loaded) }
        : ok("(no changes)\n");
    }
    const lines = [...loaded.lines];
    lines[found.row.line - 1] = replaceCell(lines[found.row.line - 1]!, 1, reopenStatus);
    return commit(file, loaded, errors, lines, !!v["dry-run"]);
  }
  // Closed rows may carry summaries that cannot be a body heading (older
  // ledgers); reopening needs one, so name the fix instead of failing the gate.
  const badSummary = titleProblem(found.row.summary);
  if (badSummary) {
    return err(
      `issuemd reopen: #${idText}'s summary cannot be a body heading: ${badSummary}\n` +
        `rename it first: issuemd rename ${file} ${idText} "…"\n`,
      2,
    );
  }
  // Reopening is the third way two open rows end up with one summary (a
  // duplicate closed as 并入, then reopened); refuse it like new/rename.
  if (!v["allow-duplicate-title"]) {
    const twin = ledger.rows.open.find((row) => summaryKey(row.summary) === summaryKey(found.row.summary));
    if (twin) {
      return err(
        `issuemd reopen: open issue #${twin.ids.map(spanText).join(", ")} already has this summary ('${twin.summary}'); ` +
          `nothing written. Rename one of them (issuemd rename ${file} ${idText} "…") or add --allow-duplicate-title\n`,
        2,
      );
    }
  }

  // "" is a legal priority (most open rows in real ledgers have none).
  const priority = found.row.priority;
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
    // Only the archive's own marker and note line are markup; the same text
    // inside the body (a fenced example) is content and must come back.
    const markerAt = !fenced[end - 1] && loaded.lines[end - 1]!.trim() === KEPT_BODY_END ? end : undefined;
    const content = loaded.lines.slice(archived.line_start, markerAt ? end - 1 : end);
    const noteAt = content.findIndex((line) => line.trim() !== "");
    if (noteAt >= 0 && ARCHIVE_NOTE.test(content[noteAt]!)) content.splice(noteAt, 1);
    restored = trimBlank(content);
    // The closed row's criteria may have been given on the command line and
    // exist nowhere in the archived text; reopening must not lose them.
    if (criteria !== "" && extractCriteria(restored) !== criteria && !restored.some((line) => line.includes(criteria))) {
      restored.push("", `**关闭时判据**：${criteria}`);
    }
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
      // Full ids: `2` sorts before `2a`.
      if (compareIds(row.ids[0]!, found.span) > 0) return row.line;
    }
    return index.end + 1;
  })();
  lines = insertLines(lines, insertAt, [
    formatRow([spanText(found.span), reopenStatus, priority, found.row.summary]),
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
  lines = insertBlock(lines, bodyAt, bodyLines);

  return commit(file, loaded, errors, lines, !!v["dry-run"]);
}

function cmdStatus(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const idText = rest[1];
  const next = rest[2];
  if (file == null || idText == null || next == null || rest.length !== 3) {
    return err(`usage: ${COMMANDS.status.usage}\n`, 2);
  }
  if (!statusCategory(next)) return err(`issuemd status: unknown status '${next}'\n`, 2);
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return missingIssue("status", idText);
  const refused = perIdRefusal("status", idText, found);
  if (refused) return refused;
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
    return err(`usage: ${COMMANDS.rename.usage}\n`, 2);
  }
  const next = unescapeCell(title.trim().replace(/\s+/g, " "));
  if (next === "") return err("issuemd rename: title must not be empty\n", 2);
  const badTitle = titleProblem(next);
  if (badTitle) return err(`issuemd rename: ${badTitle}\n`, 2);
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;

  const found = findRow(ledger, idText);
  if (!found) return missingIssue("rename", idText);
  const refused = perIdRefusal("rename", idText, found);
  if (refused) return refused;
  // Renaming is the other way two open rows end up with one summary; refuse
  // it like `new` does (dogfood #34). Renaming a duplicate to the summary it
  // already shows changes nothing, so the no-op must not become an error.
  if (found.table === "open" && next !== found.row.summary && !v["allow-duplicate-title"]) {
    const twin = ledger.rows.open.find(
      (row) => row.line !== found.row.line && summaryKey(row.summary) === summaryKey(next),
    );
    if (twin) {
      return err(
        `issuemd rename: open issue #${twin.ids.map(spanText).join(", ")} already has this summary ('${twin.summary}'); ` +
          "nothing written. To use it anyway, add --allow-duplicate-title\n",
        2,
      );
    }
  }

  const lines = [...loaded.lines];
  lines[found.row.line - 1] = replaceCell(lines[found.row.line - 1]!, 3, next);
  const block = bodyBlocks(ledger).find(
    (candidate) => `${candidate.id.start}${candidate.id.suffix}` === idText,
  );
  if (block) lines[block.line - 1] = `### Issue ${idText}: ${next}`;
  // A kept-body archive heading is a third copy of the summary; keep it in
  // step, or it silently disagrees with the table forever (dogfood #40).
  const fenced = fencedLines(lines);
  lines.forEach((text, index) => {
    const match = fenced[index] ? null : ARCHIVE_HEADING.exec(text);
    if (match && match[1] === idText) lines[index] = archiveHeading(idText, next);
  });
  const result = commit(file, loaded, errors, lines, !!v["dry-run"]);
  if (next.includes("|") && result.code === 0) {
    return { ...result, stderr: result.stderr + "W205: the new title contains a pipe; it was escaped in the table cell\n" };
  }
  return result;
}

/**
 * Replace the text under an open issue's heading. The heading stays (it is
 * the summary); input rules are `new --body-file`'s. Without this verb every
 * body edit was a hand edit that skipped the write gate (dogfood #16/#24).
 */
function cmdBody(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const idText = rest[1];
  if (file == null || idText == null || rest.length !== 2 || v["body-file"] == null) {
    return err(`usage: ${COMMANDS.body.usage}\n`, 2);
  }
  const read = readBodyFile(v["body-file"], "body");
  if ("code" in read) return read;
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;
  const found = findRow(ledger, idText);
  if (!found) return missingIssue("body", idText);
  const refused = perIdRefusal("body", idText, found);
  if (refused) return refused;
  if (found.table === "closed") {
    return err(`issuemd body: #${idText} is closed; a closed issue has no body (reopen it first)\n`, 2);
  }
  const block = bodyBlocks(ledger).find((candidate) => `${candidate.id.start}${candidate.id.suffix}` === idText);
  let lines = loaded.lines;
  if (block) {
    const heading = lines[block.line - 1]!;
    lines = removeLines(lines, block.line, block.end - block.line + 1);
    lines = insertBlock(lines, block.line, [heading, "", ...read.lines]);
  } else {
    const section = ledger.sections.find((candidate) => candidate.level === 2 && candidate.title === "正文");
    if (!section) return err("issuemd body: the 正文 section is missing\n", 3);
    const at = bodyInsertAt(ledger, found.span, section.line_end);
    lines = insertBlock(lines, at, [`### Issue ${idText}: ${found.row.summary}`, "", ...read.lines]);
  }
  return commit(file, loaded, errors, lines, !!v["dry-run"]);
}

/** Change one row's priority; the only row field that had no verb (dogfood #30). */
function cmdPriority(rest: string[], v: Values): CliResult {
  const [file, idText, next] = rest;
  if (file == null || idText == null || next == null || rest.length !== 3) {
    return err(`usage: ${COMMANDS.priority.usage}\n`, 2);
  }
  if (!PRIORITIES.includes(next)) {
    return err(`issuemd priority: expected one of ${PRIORITIES.filter(Boolean).join(", ")} or "", got '${next}'\n`, 2);
  }
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;
  const found = findRow(ledger, idText);
  if (!found) return missingIssue("priority", idText);
  const refused = perIdRefusal("priority", idText, found);
  if (refused) return refused;
  const lines = [...loaded.lines];
  lines[found.row.line - 1] = replaceCell(lines[found.row.line - 1]!, 2, next);
  return commit(file, loaded, errors, lines, !!v["dry-run"]);
}

/**
 * Split a multi-id (`20, 24, 29`) or range (`7–9`) row into one row per id,
 * copying every field, so the per-id verbs can act on each (dogfood #44).
 * Open ids that end up without a body get the label skeleton.
 */
function cmdSplit(rest: string[], v: Values): CliResult {
  const [file, idText] = rest;
  if (file == null || idText == null || rest.length !== 2) return err(`usage: ${COMMANDS.split.usage}\n`, 2);
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;
  const found = findRow(ledger, idText);
  if (!found) return missingIssue("split", idText);
  if (!found.inRange && found.row.ids.length === 1) {
    return err(`issuemd split: #${idText} already has a row of its own\n`, 2);
  }
  const LIMIT = 1000;
  const total = found.row.ids.reduce((sum, span) => sum + (span.end - span.start + 1), 0);
  if (total > LIMIT) {
    return err(`issuemd split: the row holds ${total} ids; splitting more than ${LIMIT} is refused (split it by hand in parts)\n`, 2);
  }
  const spans: IdSpan[] = found.row.ids
    .flatMap((span) => Array.from({ length: span.end - span.start + 1 }, (_, at): IdSpan => (
      span.start === span.end ? span : { start: span.start + at, end: span.start + at, suffix: "" })))
    .sort(compareIds);
  const { row, table } = found;
  const cells = (id: string) => table === "open"
    ? [id, row.status, row.priority, row.summary]
    : [id, row.status, row.priority, row.summary, row.criteria];
  // A split used to write an empty skeleton body for every id that had none.
  // That turned the row's E102 ("index ID has no body") into silence or a
  // W212 duplicate: one legal write made `check` less honest (dogfood #64).
  // Bodies stay as they are; ids without one keep their E102 and are named.
  const bodyIds = new Set(bodyBlocks(ledger).map((block) => `${block.id.start}${block.id.suffix}`));
  let lines = removeLines(loaded.lines, row.line, 1);
  lines = insertLines(lines, row.line, spans.map((span) => formatRow(cells(spanText(span)))));
  const missing = table === "open"
    ? spans.filter((span) => !bodyIds.has(`${span.start}${span.suffix}`)).map(spanText)
    : [];
  const rowIds = new Set(spans.map(spanText));
  // The ids this row covers are the only E102s split may multiply: they were
  // already reported (once, for the first missing one) before the split.
  const result = commit(file, loaded, errors, lines, !!v["dry-run"], (diagnostic) =>
    diagnostic.code === "E102" && diagnostic.id != null && rowIds.has(diagnostic.id));
  if (result.code !== 0 || missing.length === 0) return result;
  const note = `issuemd split: no body block for ${missing.map((id) => `#${id}`).join(", ")}; ` +
    "nothing was invented — write one with 'issuemd body FILE ID --body-file -'\n";
  return { ...result, stderr: result.stderr + note };
}

function cmdAdopt(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) {
    return err(`usage: ${COMMANDS.adopt.usage}\n`, 2);
  }
  const loaded = loadWritable(file, v["if-unchanged"]);
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
  const target = joinDocument(result.lines, loaded.doc);
  const checked = checkLedger(target, file);
  const after = checked.errors;
  // Tables adopt keeps as text although they look like issue tables (W225):
  // say so, even when nothing else changes (#56/#57).
  const citedTables: Decision[] = checked.warnings
    .filter(({ code }) => code === "W225")
    .map(({ line }) => ({
      kind: "cited-table",
      line,
      message: "这张表看起来像 issue 表，但不在台账表小节下：不迁移、原样保留（W225）；表里的编号已被占用，new 不会再发",
    }));
  const report = renderAdoptReport(file, result.changes, [...result.decisions, ...citedTables], !!v["dry-run"]);
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
    const diff = unifiedDiff(loaded.lines, result.lines, file, loaded.doc.finalNewline, loaded.doc.eol, loaded.doc.bom ? "\uFEFF" : "");
    return { code: 0, stdout: (diff || "(no changes)\n") + "\n" + report, stderr: snapshotNote(loaded) };
  }
  const unchanged = result.lines.length === loaded.lines.length &&
    result.lines.every((line, index) => line === loaded.lines[index]);
  if (!unchanged) {
    const readOnly = readOnlyRefusal(file, loaded);
    if (readOnly) return readOnly;
    try {
      const written = lockedWrite(loaded.path, target, loaded.doc.stat);
      if ("locked" in written) return written.locked;
      if (!written.ok) return err(`issuemd: E130 '${file}' changed after it was read; re-read and retry\n`, 4);
    } catch (error) {
      return err(`issuemd: cannot write '${file}': ${(error as Error).message}\n`, 2);
    }
  }
  // Written after the ledger so a failed conversion never leaves a report
  // that describes a write that did not happen.
  const failed = writeReport();
  if (failed) return failed;
  // Same words as every other no-op write, and as this command's --dry-run:
  // a retrying caller can tell "already converted" from "just converted".
  return {
    code: 0,
    stdout: (unchanged ? "(no changes)\n\n" : "") + report,
    stderr: unchanged ? "" : hardLinkNote(file, loaded),
  };
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

/** Decisions that only record where unrecognised text was kept verbatim. */
const KEPT_KINDS = new Set<Decision["kind"]>(["cited-table", "kept-row", "foreign-section", "preamble", "orphan-body", "section-prose", "kept-section-text"]);

/**
 * Three parts (dogfood #17): what changed mechanically, what was kept
 * verbatim, and the semantic defaults adopt applied — those are written too
 * (a dry run says "would be"), each naming the side it chose; review them.
 */
function renderAdoptReport(file: string, changes: string[], decisions: Decision[], dryRun = false): string {
  const out = [`adopt: ${file}`, ""];
  out.push("机械改动：");
  out.push(...(changes.length ? changes.map((change) => `  - ${change}`) : ["  （无）"]));
  const kept = decisions.filter((decision) => KEPT_KINDS.has(decision.kind));
  const defaults = decisions.filter((decision) => !KEPT_KINDS.has(decision.kind));
  const section = (title: string, list: Decision[]) => {
    out.push("", `${title}（${list.length}）：`);
    if (list.length === 0) out.push("  （无）");
    const group = new Map<string, Decision[]>();
    for (const decision of list) {
      const entries = group.get(decision.kind) ?? [];
      entries.push(decision);
      group.set(decision.kind, entries);
    }
    for (const [kind, entries] of group) {
      out.push(`  ${kind} x${entries.length}`);
      for (const decision of entries) {
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
  };
  section("原样保留的内容", kept);
  section(dryRun ? "将按默认处理、请复核的决定（真实运行时会写入）" : "已按默认处理、请复核的决定（已写入）", defaults);
  return out.join("\n") + "\n";
}

function cmdSync(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) {
    return err(`usage: ${COMMANDS.sync.usage}\n`, 2);
  }
  const modes = [!!v.guide, !!v["fix-tables"], !!v.titles].filter(Boolean).length;
  if (modes === 0) return err("issuemd sync: choose --guide, --fix-tables or --titles\n", 2);
  if (modes > 1) return err("issuemd sync: run one mode at a time\n", 2);
  if ((v["move-progress"] || v["drop-progress"]) && !v.titles) {
    return err("issuemd sync: --move-progress/--drop-progress require --titles\n", 2);
  }
  if (v.prefer != null && !v.titles) {
    return err("issuemd sync: --prefer only applies to --titles\n", 2);
  }
  if ((v["move-progress"] || v["drop-progress"]) && v.prefer === "table") {
    return err("issuemd sync: --move-progress/--drop-progress apply to --prefer body (the table summary is replaced)\n", 2);
  }
  if (v["move-progress"] && v["drop-progress"]) {
    return err("issuemd sync: choose --move-progress or --drop-progress, not both\n", 2);
  }
  const prefer = v.prefer ?? "body";
  if (prefer !== "body" && prefer !== "table") {
    return err(`issuemd sync: --prefer expects body or table, got '${prefer}'\n`, 2);
  }

  const opened = openLedger(file, v["if-unchanged"]);
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
  // Rows sync cannot touch (several ids share one summary) are reported, so
  // "nothing drifted" and "drifted but skipped" no longer look identical.
  const skipped: string[] = [];
  for (const row of ledger.rows.open) {
    if (row.ids.length !== 1 || row.ids[0]!.start !== row.ids[0]!.end) {
      const drifted = row.ids
        .map((span) => byId.get(spanText(span)))
        .some((block) => block != null && foldWhitespace(unescapeCell(block.title)) !== foldWhitespace(row.summary));
      if (drifted) skipped.push(row.ids.map(spanText).join(", "));
      continue;
    }
    const id = spanText(row.ids[0]!);
    const block = byId.get(id);
    if (!block) continue;
    // `\|` in a heading renders as `|`: not drift (E106 compares the same way).
    const title = unescapeCell(block.title);
    if (foldWhitespace(title) === foldWhitespace(row.summary)) continue;
    changes.push({ id, oldSummary: row.summary, title, rowLine: row.line, bodyLine: block.line });
  }
  const skippedNote = skipped.length === 0
    ? ""
    : `issuemd sync --titles: skipped ${skipped.length} multi-id row(s) whose summary differs from a body title ` +
      `(split the row first, then re-run): ${skipped.map((ids) => `#${ids}`).join("; ")}\n`;
  if (changes.length === 0) {
    // Same contract as every other dry-run: say "(no changes)", give the snapshot.
    return v["dry-run"]
      ? { code: 0, stdout: "(no changes)\n", stderr: snapshotNote(loaded) + skippedNote }
      : { code: 0, stdout: "(no changes)\n", stderr: skippedNote };
  }

  // Progress text is whatever the table summary carries beyond the body
  // title (`标题甲（进展：已修一半）`, `标题甲 [WIP]`), not only the few words
  // PROGRESS knows: replacing that summary would drop it silently (probe 10).
  const carriesExtra = ({ oldSummary, title }: Change) => {
    const table = foldWhitespace(oldSummary);
    const heading = foldWhitespace(title);
    return heading !== "" && table.length > heading.length && table.includes(heading);
  };
  // Only --prefer body loses the table wording; --prefer table copies it into
  // the heading, so there only real progress words are refused (review 11).
  const progress = changes.filter((change) =>
    PROGRESS.test(change.oldSummary) || (prefer === "body" && carriesExtra(change)));
  if (prefer === "body" && progress.length > 0 && !v["move-progress"] && !v["drop-progress"]) {
    const listed = progress.map(({ id, oldSummary }) => `  #${id}  ${oldSummary}`).join("\n");
    return err(
      `issuemd sync --titles: ${progress.length} table summary(ies) carry text the body title lacks (progress notes); nothing written\n` +
        `${listed}\n` +
        "re-run with --move-progress (keep it in the body) or --drop-progress (discard it), " +
        "or use --prefer table if the table wording is the title you want\n",
      3,
    );
  }

  // --prefer table would copy the progress text into the body heading,
  // spreading exactly the drift W260 is about.
  if (prefer === "table" && progress.length > 0) {
    const listed = progress.map(({ id, oldSummary }) => `  #${id}  ${oldSummary}`).join("\n");
    return err(
      `issuemd sync --titles --prefer table: ${progress.length} table summary(ies) carry progress text; nothing written\n` +
        `${listed}\n` +
        "use --prefer body with --move-progress (keep it in the body) or --drop-progress, or rename those issues first\n",
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

  const result = commit(file, loaded, errors, lines, !!v["dry-run"]);
  return skippedNote ? { ...result, stderr: result.stderr + skippedNote } : result;
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