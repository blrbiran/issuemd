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
import { fileURLToPath } from "node:url";

import { inlineCodeRanges, scan } from "./scan.js";
import { hashRepairContextSkipReason, hashRepairRanges, hashRepairSkipReason, hashSpans } from "./hash-scan.js";
import { matchProgressCue } from "./progress-matcher.js";
import { buildSections, countLines } from "./sections.js";
import { decodeDocument, joinDocument, readRaw, writeAtomically, type Document } from "./io.js";
import { parseId, parseIds, compareIds, IdSet, type IdSpan } from "./issue-id.js";
import { archiveInventory as discoverArchives, archivePayloadRange, archivePayloadSnapshot, archiveFramingSnapshot, hiddenArchiveRefusal, locateArchivePayload, validateSerializedArchive, bodyBlocks, countSuffix, DEFAULT_LIMITS, effectiveLimits, highWaterRecords, HIGH_WATER_MARKER, htmlBlockLines, LIMITS_MARKER, limitsRecords, maxIssueId, parseLedger, prunableArchive, type Diagnostic } from "./ledger.js";
import { checkLedger, checkParsedLedger, PRIORITIES, STATUS_CLASSES, summaryKey } from "./ledger-check.js";
import { findLedgerText, reservedProseReferences } from "./ledger-search.js";
import { buildMoveEvidence, validateMoveEvidence } from "./move-evidence.js";
import {
  bodySkeleton,
  bodyVisibility,
  escapeCell,
  criteriaLabelHint,
  criteriaAliasRepair,
  criteriaOccurrences,
  criteriaBoundaryHints,
  labelBlock,
  blockHasListItems,
  isCriteriaLabel,
  extractCriteria,
  editOpenCriteria,
  bodyLabels,
  unescapeCell,
  formatRow,
  guideBlockLines,
  archiveHeading,
  serializeKeptBodyV3,
  ARCHIVE_HEADING,
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
  openStatusCounts,
  spanText,
  ledgerSize,
  summaryLine,
  toListedIssue,
  viewIssue,
  withBody,
  indexWithBody,
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
  show: { usage: "issuemd show    FILE ID [--body-only | [--json] [--label NAME]]", options: ["json", "label", "body-only"] },
  counts: { usage: "issuemd counts  FILE [--json | --markdown]", options: ["json", "markdown"] },
  find: { usage: "issuemd find    FILE PATTERN [--json]", options: ["json"] },
  limits: { usage: "issuemd limits  FILE [--body-bytes N] [--body-lines N] [--clear]", options: ["body-bytes", "body-lines", "clear", "dry-run", "if-unchanged"] },
  read: { usage: "issuemd read    FILE <H2 heading>", options: [] },
  new: { usage: "issuemd new     FILE --title T [--id N] [--status S] [--priority P] [--body-file PATH|-] [--allow-duplicate-title]", options: ["title", "id", "status", "priority", "body-file", "allow-duplicate-title", "dry-run", "if-unchanged"] },
  close: { usage: "issuemd close   FILE ID [--status S] [--criteria TEXT | --criteria-from-body | --no-criteria] [--keep-body]", options: ["status", "criteria", "criteria-from-body", "no-criteria", "keep-body", "dry-run", "if-unchanged"] },
  reopen: { usage: "issuemd reopen  FILE ID [--status S] [--allow-duplicate-title]", options: ["status", "allow-duplicate-title", "dry-run", "if-unchanged"] },
  status: { usage: "issuemd status  FILE ID NEW_STATUS", options: ["dry-run", "if-unchanged"] },
  rename: { usage: "issuemd rename  FILE ID \"NEW TITLE\" [--allow-duplicate-title]", options: ["allow-duplicate-title", "dry-run", "if-unchanged"] },
  body: { usage: "issuemd body    FILE ID (--body-file PATH|- [--append] | --move-evidence LABEL)", options: ["body-file", "append", "move-evidence", "dry-run", "if-unchanged"] },
  criteria: { usage: "issuemd criteria FILE ID --criteria TEXT", options: ["criteria", "dry-run", "if-unchanged"] },
  priority: { usage: "issuemd priority FILE ID P0|P1|P2|P3|\"\"", options: ["dry-run", "if-unchanged"] },
  split: { usage: "issuemd split   FILE ID", options: ["dry-run", "if-unchanged"] },
  prune: { usage: "issuemd prune   FILE ID (--dry-run | --confirm --if-unchanged SNAPSHOT)", options: ["confirm", "dry-run", "if-unchanged"] },
  sync: { usage: "issuemd sync    FILE [--guide | --fix-tables | --titles [--prefer body|table] [--move-progress | --drop-progress] | --criteria-labels [--force] | --fix-hashes [--require-complete]]", options: ["guide", "fix-tables", "titles", "criteria-labels", "force", "fix-hashes", "require-complete", "prefer", "move-progress", "drop-progress", "dry-run", "if-unchanged"] },
  adopt: { usage: "issuemd adopt   FILE [--dry-run] [--report PATH]", options: ["dry-run", "report", "if-unchanged"] },
} as const satisfies Record<string, { usage: string; options: readonly string[] }>;
type Command = keyof typeof COMMANDS;

/** Option help, one entry per flag; continuation lines start with spaces. */
const OPTION_HELP: Record<string, string> = {
  json: "--json                    machine-readable JSON output (read commands)",
  version: "--version                 print the installed package version and the running build directory",
  strict: "--strict                  check: fail on warnings except W201, W202, W250 and W264",
  "verify-commits": "--verify-commits          check: verify commit references in the ledger directory (W240)",
  status:
    "--status <S>              list: filter; new/reopen: open status (未决); close: closed status (已修)",
  priority:
    "--priority <P>            list: filter by priority; new: P0–P3 or \"\" (default P2); change later: issuemd priority FILE ID P",
  "body-bytes": "--body-bytes <N>          limits: W201 byte limit for one issue body (UTF-8; default 20480)",
  "body-lines": "--body-lines <N>          limits: W201 line limit for one issue body (default 300)",
  clear: "--clear                   limits: remove the marker and use the defaults",
  closed: "--closed                  list: show the closed table instead of the index",
  markdown: "--markdown                counts: print one Markdown bullet with the same counts",
  expand: "--expand                  list: one entry per id (a `20, 24` or `7–20` row becomes several)",
  "with-body":
    "--with-body               list --json: add each issue's body labels and 验收判据 from one parse\n" +
    "                            (the `show --json` fields, without 61 separate calls)",
  label: "--label <NAME>            show: print only the **NAME** block",
  "body-only": "--body-only               show: print only this issue’s body, ready for --body-file",
  title: "--title <T>               new: summary/body title (starts with '-'? write --title=\"-…\")",
  id: "--id <N>                  new: explicit issue id",
  "allow-duplicate-title":
    "--allow-duplicate-title   write it even though another open issue has the same summary",
  "body-file": "--body-file <path|->      new/body: use bold labels inside the body; no #, ##, or leading ### Issue heading\n" +
    "                            Pass '-' to read from stdin",
  append: "--append                  body: add text at the end of the existing issue body",
  "move-evidence": "--move-evidence <LABEL>   body: move one visible evidence block into 附录 and link it from the body",
  criteria: "--criteria <TEXT>         criteria: replace the open body's acceptance criteria with one Markdown line\n" +
    "                            close: table-cell text; on an open id, requires --status and removes the body unless --keep-body\n" +
    "                            close: on a closed id, correct the criteria cell only; \\| spells a literal pipe",
  "criteria-from-body":
    "--criteria-from-body      close: lift the **验收判据** block into the column (the default\n" +
    "                            when the body has one); refuses if it is missing or empty",
  "no-criteria": "--no-criteria             close: leave the criteria cell empty and delete the body (unless kept)",
  "keep-body": "--keep-body               close: retain the body as evidence in 附录; the archived text stays in the file",
  guide: "--guide                   sync: rewrite the controlled guide and status blocks",
  "fix-tables": "--fix-tables              sync: add missing table separator rows",
  titles: "--titles                  sync: align body headings with index summaries",
  "criteria-labels": "--criteria-labels         sync: rename one unambiguous nearby criteria label per issue",
  force: "--force                   sync --criteria-labels: rename even when the block has no list items",
  "fix-hashes": "--fix-hashes              sync: wrap W202 literal hashes in safe body/appendix prose spans",
  "require-complete": "--require-complete       sync --fix-hashes: refuse if any W202 warning would remain",
  confirm: "--confirm                 prune: delete the reviewed archive (requires --if-unchanged snapshot)",
  prefer: "--prefer <body|table>     sync --titles: which side wins (default body)",
  "move-progress": "--move-progress           sync --titles: move progress text into the body",
  "drop-progress": "--drop-progress           sync --titles: discard progress text",
  report: "--report <path>           adopt: write the decision list to a new file (or over an earlier report)",
  "dry-run": "--dry-run                 write: print a unified diff, don't modify the file; stderr gives its snapshot",
  "if-unchanged":
    "--if-unchanged <S>        write: exit 4 unless the file still has snapshot S (printed by --dry-run;\n" +
    "                            also the `snapshot` field of JSON views), so you apply what you reviewed",
};

const READ_COMMANDS: Command[] = ["check", "list", "show", "find", "counts", "read"];
const BUILD_DIR = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  for (const path of [resolve(BUILD_DIR, "../package.json"), resolve(BUILD_DIR, "../../package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@blrbiran/issuemd" && pkg.version) return pkg.version;
    } catch {
      // Try the package root relative to the other supported runtime layout.
    }
  }
  return "unknown";
})();
const HELP = [
  "issuemd — read and maintain a single-file Markdown issue ledger",
  "",
  "Usage:",
  ...READ_COMMANDS.map((name) => `  ${COMMANDS[name].usage}`),
  "  issuemd --version",
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

export type CliResult = { code: number; stdout: string; stderr: string; rawStdout?: true };

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
  "help": { type: "boolean", short: "h" },
  version: { type: "boolean" },
  strict: { type: "boolean" },
  "verify-commits": { type: "boolean" },
  markdown: { type: "boolean" },
  // limits
  "body-bytes": { type: "string" },
  "body-lines": { type: "string" },
  clear: { type: "boolean" },
  confirm: { type: "boolean" },
  // list
  status: { type: "string" },
  priority: { type: "string" },
  closed: { type: "boolean" },
  // show
  label: { type: "string" },
  "body-only": { type: "boolean" },
  // shared write options
  "dry-run": { type: "boolean" },
  "if-unchanged": { type: "string" },
  // new
  title: { type: "string" },
  id: { type: "string" },
  "allow-duplicate-title": { type: "boolean" },
  "body-file": { type: "string" },
  append: { type: "boolean" },
  "move-evidence": { type: "string" },
  // close
  criteria: { type: "string" },
  "criteria-from-body": { type: "boolean" },
  "no-criteria": { type: "boolean" },
  "keep-body": { type: "boolean" },
  // sync
  guide: { type: "boolean" },
  "fix-tables": { type: "boolean" },
  titles: { type: "boolean" },
  "criteria-labels": { type: "boolean" },
  force: { type: "boolean" },
  "fix-hashes": { type: "boolean" },
  "require-complete": { type: "boolean" },
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
    if (values.version) return ok(`${VERSION} (build: ${BUILD_DIR})\n`);
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
    case "find":
      return cmdFind(positionals.slice(1), values);
    case "list":
      return cmdList(positionals.slice(1), values);
    case "show":
      return cmdShow(positionals.slice(1), values);
    case "counts":
      return cmdCounts(positionals.slice(1), values);
    case "limits":
      return cmdLimits(positionals.slice(1), values);
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
    case "criteria":
      return cmdCriteria(positionals.slice(1), values);
    case "priority":
      return cmdPriority(positionals.slice(1), values);
    case "split":
      return cmdSplit(positionals.slice(1), values);
    case "prune":
      return cmdPrune(positionals.slice(1), values);
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
    const ledger = parseLedger(loaded.src);
    const report = checkParsedLedger(ledger, file, {
      strict: v.strict,
      verifyCommits: v["verify-commits"],
    });
    const code = report.ok ? 0 : 3;
    if (v.json) {
      return {
        code,
        stdout: JSON.stringify({ ...report, ...citedRowsField(ledger), limits: effectiveLimits(ledger), size: ledgerSize(ledger, loaded.src), snapshot: snapshotOf(loaded.src) }, null, 2) + "\n",
        stderr: "",
      };
    }
    const lines = [`file: ${file}`, summaryLine(report.counts, openStatusCounts(ledger.rows.open))];
    for (const [severity, diagnostics] of [["error", report.errors], ["warning", report.warnings]] as const) {
      const groups = new Map<string, Diagnostic[]>();
      for (const diagnostic of diagnostics) {
        const group = groups.get(diagnostic.code) ?? [];
        group.push(diagnostic);
        groups.set(diagnostic.code, group);
      }
      for (const [groupCode, group] of groups) {
        lines.push(`${severity} ${groupCode} x${group.length}`);
        const displayed = groupCode === "W202" ? group : group.slice(0, 3);
        for (const { line, column, id, message, expected, actual } of displayed) {
          const details = expected === undefined
            ? ""
            : ` (expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)})`;
          lines.push(`  L${line}${column == null ? "" : `:${column}`}${id ? ` #${id}` : ""}: ${message}${details}`);
        }
        if (groupCode !== "W202" && group.length > 3) lines.push(`  … (${group.length - 3} more, use --json for all)`);
      }
    }
    const size = ledgerSize(ledger, loaded.src);
    const archive = size.archivedBlocks > 0 ? ` · archived ${size.archivedLines} in ${size.archivedBlocks} block(s)` : "";
    const warningGroups = [
      ["format", report.warnings.filter(({ code }) => code === "W202").length],
      ["artifacts", report.warnings.filter(({ code }) => code === "W201" || code === "W250").length],
      ["other", report.warnings.filter(({ code }) => code !== "W202" && code !== "W201" && code !== "W250").length],
    ].filter(([, count]) => Number(count) > 0).map(([name, count]) => `${String(name)} ${Number(count)}`).join(", ");
    lines.push(
      `${report.errors.length} errors, ${report.warnings.length} warnings${warningGroups ? ` · ${warningGroups}` : ""} · ${(size.bytes / 1024).toFixed(1)} KiB / ${size.lines} lines · body ${size.bodyLines}${archive}`,
    );
    return { code, stdout: lines.join("\n") + "\n", stderr: "" };
  } catch (error) {
    return err(`issuemd check: ${(error as Error).message}\n`, 2);
  }
}

function cmdFind(rest: string[], v: Values): CliResult {
  const [file, pattern] = rest;
  if (!file || !pattern || /[\r\n]/.test(pattern) || rest.length !== 2) {
    return err(`usage: ${COMMANDS.find.usage}\nProvide a non-empty single-line literal pattern. For a leading dash, put -- before the pattern.\n`, 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const ledger = parseLedger(loaded.src);
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;
  const { errors, warnings } = checkParsedLedger(ledger, file);
  const matches = findLedgerText(ledger, pattern);
  const stdout = v.json
    ? JSON.stringify({ file, snapshot: snapshotOf(loaded.src), diagnostics: { errors, warnings }, matches }, null, 2) + "\n"
    : matches.length
      ? matches.map(({ id, table, line, where, text }) => `L${line}\t#${id}\t${table}\t${where}\t${text}`).join("\n") + "\n"
      : "(no matches)\n";
  return { code: 0, stdout, stderr: structureNote(errors) };
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
  const report = checkParsedLedger(ledger, file);

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
  const otherTable = table === "open" ? "closed" : "open";
  const wrongPriority = v.priority != null &&
      !ledger.rows[table].some((row) => row.priority === v.priority) &&
      ledger.rows[otherTable].some((row) => row.priority === v.priority)
    ? `'${v.priority}' only occurs in the ${otherTable} table; ${table === "open" ? "add --closed" : "drop --closed"} to list it\n`
    : "";
  const undeclaredStatus = v.status != null && statusCategory(v.status) == null &&
      everyRow.some((row) => row.status === v.status)
    ? `warning W220: status '${v.status}' is undeclared; this filter matches the existing row as written\n`
    : "";
  const incomplete = unreadableNote(ledger);
  const stderr = structureNote(report.errors, new Set(ledger.unreadable.map((row) => row.line))) +
    wrongTable + wrongPriority + undeclaredStatus + incomplete;
  let issues = rows.map((row) => toListedIssue(row, table));
  if (v.expand) {
    const expanded = expandIssues(issues);
    if (!expanded) return err("issuemd list: --expand would produce more than 100000 entries\n", 2);
    issues = expanded;
  }
  if (v["with-body"]) {
    const blocks = bodyBlocks(ledger);
    const index = indexWithBody(ledger, issues, blocks);
    issues = issues.map((issue) => withBody(ledger, issue, index));
  }
  if (v.json) {
    const unreadableRows = ledger.unreadable
      .filter((row) => row.table === table || row.table === "stray")
      .map(({ line, reason, ids }) => ({ line, reason, ...(ids ? { ids: ids.map(spanText) } : {}) }));
    // IDs reserved by external tables are exposed separately from unreadable rows.
    const body = JSON.stringify(
      {
        file,
        snapshot: snapshotOf(loaded.src),
        table,
        rowCount: rows.length,
        issueCount: issues.reduce((sum, issue) => sum + issue.count, 0),
        issues,
        ...(unreadableRows.length ? { unreadableRows } : {}),
        ...citedRowsField(ledger),
        ...diagnosticsField(report.errors, report.warnings),
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

function diagnosticJson(diagnostic: Diagnostic): Record<string, unknown> {
  const { code, line, id, message, expected, actual } = diagnostic;
  return {
    code, line, ...(id !== undefined ? { id } : {}), message,
    ...(expected !== undefined ? { expected, actual } : {}),
  };
}

/** Stable machine-readable diagnostics for JSON read views. */
function diagnosticsField(errors: Diagnostic[], warnings: Diagnostic[]) {
  return {
    diagnostics: {
      errors: errors.map(diagnosticJson),
      warnings: warnings.map(diagnosticJson),
    },
  };
}

/** The same cited-row view for every JSON command that exposes ledger data. */
function citedRowsField(ledger: ReturnType<typeof parseLedger>) {
  const citedRows = ledger.cited.map(({ line, reason, ids }) => ({ line, reason, ids: (ids ?? []).map(spanText) }));
  return citedRows.length ? { citedRows } : {};
}

function cmdCounts(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) return err(`usage: ${COMMANDS.counts.usage}\n`, 2);
  if (v.markdown && v.json) return err("issuemd counts: choose --markdown or --json\n", 2);
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const ledger = parseLedger(loaded.src);
  const report = checkParsedLedger(ledger, file);
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;
  const stderr = structureNote(report.errors, new Set(ledger.unreadable.map((row) => row.line))) +
    unreadableNote(ledger);
  if (v.json) return { code: 0, stdout: JSON.stringify({ file, snapshot: snapshotOf(loaded.src), counts: report.counts, ...citedRowsField(ledger), ...diagnosticsField(report.errors, report.warnings) }, null, 2) + "\n", stderr };
  const summary = summaryLine(report.counts, openStatusCounts(ledger.rows.open));
  return { code: 0, stdout: (v.markdown ? `- ${summary.replace(/ {3}/, " · ")}` : summary) + "\n", stderr };
}

function cmdShow(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const id = rest[1];
  if (file == null || id == null || rest.length !== 2) {
    return err(`usage: ${COMMANDS.show.usage}\n`, 2);
  }
  if (v["body-only"] && (v.json || v.label != null)) {
    return err("issuemd show: cannot combine --body-only with --json or --label\n", 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const ledger = parseLedger(loaded.src);
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;
  const report = checkParsedLedger(ledger, file);
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
      (v.json || v["body-only"] ? missingIssue("show", id) : noMatch(`(no such issue: ${id})\n`));
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

  if (v["body-only"]) {
    if (view.table === "closed" && (!view.body?.archived || view.body.id !== view.id)) {
      const hidden = hiddenArchiveNote(discoverArchives(ledger), view.id, ledger);
      if (hidden) return withNote(err(`issuemd show: ${hidden}\n`));
    }
    if (!view.body || view.body.inherited || (view.table === "closed" && !view.body.archived)) {
      return withNote(err(`issuemd show: #${id} has no body of its own\n`));
    }
    const eol = loaded.src.includes("\r\n") ? "\r\n" : "\n";
    if (view.body.archived) {
      return withNote({ ...ok(view.body.text.replace(/\n/g, eol)), rawStdout: true });
    }
    const end = bodyContentEnd(ledger.lines, view.body.line, view.body.end);
    const body = trimBlank(ledger.lines.slice(view.body.line, end));
    if (body.length === 0) return withNote(ok(""));
    const ending = end < ledger.lines.length || loaded.src.endsWith("\n") ? eol : "";
    return withNote({ ...ok(body.join(eol) + ending), rawStdout: true });
  }

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
    if (v.json) return withNote(ok(JSON.stringify({ ...view, paragraph: found.text, paragraphLines: found.lines, snapshot: snapshotOf(loaded.src), ...diagnosticsField(report.errors, report.warnings) }, null, 2)));
    return withNote(ok(found.lines.join("\n")));
  }

  if (v.json) return withNote(ok(JSON.stringify({ ...view, snapshot: snapshotOf(loaded.src), ...diagnosticsField(report.errors, report.warnings) }, null, 2)));

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
    const code = title === "附录" ? "W266 " : "";
    return err(`issuemd read: ${code}'${title}' matches ${matches.length} headings; nothing printed\n${listed}\n`, 2);
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
function writeBlockReason(raw: Buffer): "utf8" | "eol" | undefined {
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
    // Validation, parsing and the snapshot come from one stable byte read.
    const { raw, stat } = readRaw(path);
    const blocked = writeBlockReason(raw);
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
    const doc: Document = { ...decodeDocument(raw), stat };
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
function terminate(
  lines: string[],
  doc: Document,
  original: string[] = [],
  preserveTrailingBlanks = false,
): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  if (!doc.finalNewline) return end === lines.length ? lines : lines.slice(0, end);
  if (preserveTrailingBlanks) return lines;
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
  { tolerate, allowLost, observeCheck, validateCandidate, preserveTrailingBlanks, report, receipt }: {
    /** Split may name missing bodies individually instead of once per range. */
    tolerate?: (diagnostic: Diagnostic) => boolean;
    /** Existing errors a verb is allowed to resolve intentionally. */
    allowLost?: (diagnostic: Diagnostic) => boolean;
    /** Optional observer for warnings computed with the candidate snapshot. */
    observeCheck?: (report: ReturnType<typeof checkLedger>) => void;
    validateCandidate?: (ledger: ReturnType<typeof parseLedger>) => CliResult | undefined;
    /** Reopen may restore source body lines that were archived before EOF. */
    preserveTrailingBlanks?: boolean;
    /** A previewable change summary; printed on --dry-run and on the real write. */
    report?: string;
    /** One line describing what changed; printed with the post-write snapshot. */
    receipt?: string;
  } = {},
): CliResult {
  const newLines = terminate(candidate, loaded.doc, loaded.lines, preserveTrailingBlanks);
  const content = joinDocument(newLines, loaded.doc);
  const parsed = parseLedger(content);
  const checked = checkParsedLedger(parsed, file);
  const after = checked.errors;
  observeCheck?.(checked);
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
  if (allowLost) {
    const remaining = new Map<string, number>();
    for (const diagnostic of after) {
      const key = diagnosticKey(diagnostic);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const lost = before.filter((diagnostic) => {
      const key = diagnosticKey(diagnostic);
      const count = remaining.get(key) ?? 0;
      if (count > 0) {
        remaining.set(key, count - 1);
        return false;
      }
      return !allowLost(diagnostic);
    });
    if (lost.length > 0) {
      const detail = lost.map((diagnostic) => {
        const fix = diagnostic.code === "E106" && diagnostic.id
          ? `; align its title with 'issuemd rename ${file} ${diagnostic.id} \"…\"' or 'issuemd sync ${file} --titles'`
          : "; repair the existing error before closing (run 'issuemd check')";
        return `  L${diagnostic.line}${diagnostic.id ? ` #${diagnostic.id}` : ""} ${diagnostic.code}: ${diagnostic.message}${fix}`;
      }).join("\n");
      return err(`issuemd close: refusing to make ${lost.length} existing error(s) disappear:\n${detail}\n`, 3);
    }
  }
  const candidateRefusal = validateCandidate?.(parsed);
  if (candidateRefusal) return candidateRefusal;
  if (dryRun) {
    const diff = unifiedDiff(loaded.lines, newLines, file, loaded.doc.finalNewline, loaded.doc.eol, loaded.doc.bom ? "\uFEFF" : "");
    return { code: 0, stdout: diff || "(no changes)\n", stderr: (report ?? "") + snapshotNote(loaded) };
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
    return writeFailure(file, error);
  }
  // The caller learns what landed and which bytes to feed the next
  // --if-unchanged, without a second `show` (dogfood #122).
  const receiptLine = receipt ? writeReceipt(file, receipt, content) : "";
  return { code: 0, stdout: "", stderr: (report ?? "") + receiptLine + hardLinkNote(file, loaded) };
}

function writeReceipt(file: string, description: string, content: string): string {
  const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]/g, (character) => JSON.stringify(character).slice(1, -1).replace(/[\u2028\u2029]/g, " "));
  return `wrote ${oneLine(file)} ${oneLine(description)} (snapshot ${snapshotOf(content)})\n`;
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

function writeFailure(file: string, error: unknown, target: "file" | "directory" = "directory"): CliResult {
  const { code, message } = error as NodeJS.ErrnoException;
  let reason: string;
  switch (code) {
    case "EACCES":
      reason = target === "file"
        ? "the file is read-only or write permission was denied (if you own it, check whether chmod u+w is appropriate)"
        : "permission denied while writing in the ledger directory";
      break;
    case "EPERM": reason = "write denied by permissions or policy (for example a sandbox or immutable file)"; break;
    case "EROFS": reason = "the filesystem is mounted read-only"; break;
    case "ENOENT": reason = "the file or its directory is no longer there; re-read it with 'issuemd list' or 'issuemd show' before retrying"; break;
    default: return err(`issuemd: cannot write '${file}': ${message}\n`, 2);
  }
  return err(`issuemd: cannot write '${file}': ${code}: ${reason} (${message}); nothing written\n`, 2);
}

/** Honor read-only files even when the parent directory permits replacement. */
function readOnlyRefusal(file: string, loaded: Loaded): CliResult | undefined {
  try {
    accessSync(loaded.path, fsConstants.W_OK);
    return undefined;
  } catch (error) {
    return writeFailure(file, error, "file");
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
): { loaded: Loaded; ledger: ReturnType<typeof parseLedger>; errors: Diagnostic[]; warnings: Diagnostic[] } | CliResult {
  const loaded = loadWritable(file, expected);
  if ("code" in loaded) return loaded;
  const ledger = parseLedger(joinDocument(loaded.lines, loaded.doc));
  const unusable = unusableLedger(ledger);
  if (unusable) return unusable;
  // Baseline diagnostics must be the checker's full set, not just the parser's:
  // the write gate only refuses *new* errors, so a pre-existing E112 in the
  // input must not look new after the edit.
  const { errors, warnings } = checkParsedLedger(ledger, file);
  return { loaded, ledger, errors, warnings };
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

function hiddenArchiveNote(inventory: ReturnType<typeof discoverArchives>, id: string, ledger: ReturnType<typeof parseLedger>): string | undefined {
  const visible = inventory.archives.filter((archive) => archive.id === id);
  const malformed = visible
    .map(({ section }) => locateArchivePayload(ledger, section, inventory.masks).refusal)
    .find((refusal) => refusal?.recognized);
  if (malformed) return `#${id}: ${malformed.reason} (L${malformed.line})`;
  if (visible.length > 0) return undefined;
  const refusal = hiddenArchiveRefusal(inventory, id);
  if (refusal) return `#${id}: ${refusal.reason} (${refusal.lines.map((line) => `L${line}`).join(", ")})`;
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
  // Raw comment delimiters in a generated Markdown heading can hide the rest
  // of the document even though they look like ordinary title text.
  if (title.includes("<!--") || title.includes("-->")) {
    return "the title contains a raw HTML comment delimiter; write it as '< !--' or '&lt;!--' instead.";
  }
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
          "the body is the text below the heading, which issuemd writes itself. " +
          "Use show --body-only or extract body.content from show --json (body.text includes the heading)\n",
        2,
      );
    }
    // A top-level heading inside a body ends the issue block early: `show`
    // stops at it and `close` leaves it behind as orphaned content, all while
    // `check` stays green.
    const fenced = fencedLines(lines, true);
    const heading = lines.findIndex((line, index) => !fenced[index] && /^ {0,3}#{1,2}(?:[ \t]|$)/.test(line));
    if (heading !== -1) {
      return err(
        `issuemd ${verb}: --body-file may not contain a top-level heading (## or #): '${lines[heading]!.trim()}'.\n` +
          "Use **bold labels** inside an issue body.\n",
        2,
      );
    }
    return { lines };
  } catch (e) {
    return err(`issuemd: cannot read --body-file: ${(e as Error).message}\n`, 2);
  }
}

function writeHighWaterMark(lines: string[], ledger: ReturnType<typeof parseLedger>, value: number): string[] {
  const marker = `${HIGH_WATER_MARKER} ${value} -->`;
  const records = highWaterRecords(ledger);
  if (records.length > 0) {
    let updated = [...lines];
    updated[records[0]!.line - 1] = marker;
    for (const record of records.slice(1).reverse()) updated = removeLines(updated, record.line, 1);
    return updated;
  }
  const firstH2 = ledger.sections.find((section) => section.level === 2)?.line_start ?? lines.length + 1;
  const at = firstH2 > 1 && lines[firstH2 - 2]?.trim() === "" ? firstH2 - 1 : firstH2;
  return insertLines(lines, at, [marker]);
}

function writeLimitsMarker(lines: string[], ledger: ReturnType<typeof parseLedger>, values: { bodyBytes: number; bodyLines: number } | null): string[] {
  const records = limitsRecords(ledger);
  if (values == null) {
    let updated = [...lines];
    for (const record of [...records].reverse()) updated = removeLines(updated, record.line, 1);
    return updated;
  }
  const marker = `${LIMITS_MARKER} body-bytes=${values.bodyBytes} body-lines=${values.bodyLines} -->`;
  if (records.length > 0) {
    let updated = [...lines];
    updated[records[0]!.line - 1] = marker;
    for (const record of records.slice(1).reverse()) updated = removeLines(updated, record.line, 1);
    return updated;
  }
  const firstH2 = ledger.sections.find((section) => section.level === 2)?.line_start ?? lines.length + 1;
  const at = firstH2 > 1 && lines[firstH2 - 2]?.trim() === "" ? firstH2 - 1 : firstH2;
  return insertLines(lines, at, [marker]);
}

/** Set or clear the per-ledger W201 limits kept in the preamble. */
function cmdLimits(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) {
    return err(`usage: ${COMMANDS.limits.usage}\n`, 2);
  }
  const bytes = v["body-bytes"];
  const linesOption = v["body-lines"];
  if (v.clear && (bytes != null || linesOption != null)) {
    return err("issuemd limits: --clear removes the marker; do not combine it with --body-bytes or --body-lines\n", 2);
  }
  if (!v.clear && bytes == null && linesOption == null) {
    return err(`issuemd limits: nothing to do; pass ${"`"}--body-bytes N${"`"}, ${"`"}--body-lines N${"`"} or ${"`"}--clear${"`"}\nusage: ${COMMANDS.limits.usage}\n`, 2);
  }
  const positive = (raw: string, flag: string): number | CliResult => {
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return err(`issuemd limits: ${flag} expects a positive whole number, got '${raw}'\n`, 2);
    }
    return Number(raw);
  };
  const values: { bodyBytes: number; bodyLines: number } = { ...DEFAULT_LIMITS };
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;
  const unsafe = limitsRecords(ledger).filter(({ unsafeToRewrite }) => unsafeToRewrite);
  if (unsafe.length > 0) {
    const locations = unsafe.map(({ line }) => `L${line}`).join(", ");
    return err(`issuemd limits: W267 the limits marker must be a standalone comment (${locations}); repair it without removing neighboring text\n`, 2);
  }
  const current = effectiveLimits(ledger);
  values.bodyBytes = current.bodyBytes;
  values.bodyLines = current.bodyLines;
  if (bytes != null) {
    const parsed = positive(bytes, "--body-bytes");
    if (typeof parsed !== "number") return parsed;
    values.bodyBytes = parsed;
  }
  if (linesOption != null) {
    const parsed = positive(linesOption, "--body-lines");
    if (typeof parsed !== "number") return parsed;
    values.bodyLines = parsed;
  }
  const lines = writeLimitsMarker(loaded.lines, ledger, v.clear ? null : values);
  const change: string[] = [];
  if (values.bodyBytes !== current.bodyBytes) change.push(`body-bytes ${current.bodyBytes} → ${values.bodyBytes}`);
  if (values.bodyLines !== current.bodyLines) change.push(`body-lines ${current.bodyLines} → ${values.bodyLines}`);
  const receipt = v.clear ? "limits cleared" : `limits ${change.join(", ") || "marker updated"}`;
  return commit(file, loaded, errors, lines, !!v["dry-run"], { receipt });
}

function criteriaAliasWriteHint(file: string, lines: string[], id: string): string {
  const candidate = parseLedger(lines.join("\n"));
  const block = bodyBlocks(candidate).find((entry) => `${entry.id.start}${entry.id.suffix}` === id);
  if (!block) return "";
  const bodyLines = candidate.lines.slice(block.line - 1, block.end);
  const repair = criteriaAliasRepair(bodyLines, block.line - 1);
  if (!repair) return "";
  const locations = repair.candidates.map(({ label, line }) => `L${line} **${label}**`).join(", ");
  const mapping = "闭表判据列只从正文 **验收判据** 标签提升";
  if (repair.eligible) {
    const quotedFile = `'${file.replace(/'/g, "'\\''")}'`;
    return `W261: #${id} has a nearby criteria label at ${locations}; ${mapping}. Rename it with issuemd sync ${quotedFile} --criteria-labels\n`;
  }
  return `W261/W264: #${id} has nearby criteria labels at ${locations}; ${mapping}; ` +
    `automatic label repair is unavailable because ${repair.reason}; review or edit the body manually\n`;
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

  const records = highWaterRecords(ledger);
  if (records.some((record) => record.value == null)) {
    return err("issuemd new: the allocation high-water mark is malformed; repair its preamble marker before allocating another id\n", 3);
  }
  const historicMax = records.reduce((highest, record) => Math.max(highest, record.value ?? 0), 0);
  const max = Math.max(maxIssueId(ledger.rows, ledger.unreadable), historicMax);
  // Ids cited by W225 tables are reserved but not issues: skip them one by
  // one instead of jumping past the largest (an error-code table citing 500
  // must not move the next issue to 501).
  const proseReservations = new Map(reservedProseReferences(ledger).reverse().map((reference) => [reference.id, reference]));
  let next = max + 1;
  if (v.id == null) while (Number.isSafeInteger(next)) {
    const cited = unreadableHolding(ledger, String(next), ledger.cited);
    if (!cited && !proseReservations.has(String(next))) break;
    // Step over the whole cited span at once (`1–900000000` must not loop).
    const span = cited?.ids?.find((s) => s.suffix === "" && s.start <= next && next <= s.end);
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
    const reference = proseReservations.get(idText);
    if (reference) return err(`issuemd new: id ${idText} is reserved by a prose reference at L${reference.line}; pick another id\n`, 2);
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
  lines = writeHighWaterMark(lines, ledger, Math.max(max, span.start));

  const committed = commit(file, loaded, errors, lines, !!v["dry-run"], {
    receipt: `#${idText} new`,
    validateCandidate(candidate) {
      const reference = reservedProseReferences(candidate).find(({ id }) => id === idText);
      if (reference) {
        return err(`issuemd new: id ${idText} is reserved by a prose reference in the proposed ledger at L${reference.line}; pick another --id or edit the incoming text\n`, 2);
      }
      const cited = unreadableHolding(candidate, idText, candidate.cited);
      if (!cited) return;
      return err(
        `issuemd new: id ${idText} is reserved by a table in the proposed ledger ` +
          `(L${cited.line}, IDs ${(cited.ids ?? []).map(spanText).join(", ")}); ` +
          "nothing written. Pick another --id or edit the incoming reference table.\n",
        2,
      );
    },
  });
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
  if (result.code === 0) {
    const aliasHint = criteriaAliasWriteHint(file, lines, idText);
    if (aliasHint) warnings.push(aliasHint);
  }
  return result.code === 0 && warnings.length > 0 ? { ...result, stderr: result.stderr + warnings.join("") } : result;
}

const APPENDIX_AUTO = "<!-- issuemd:appendix:auto -->";

function duplicateAppendixRefusal(verb: string, appendices: { line_start: number }[]): CliResult | undefined {
  if (appendices.length <= 1) return;
  const locations = appendices.map(({ line_start }) => `L${line_start}`).join(", ");
  return err(`issuemd ${verb}: W266 multiple ## 附录 sections (${locations}); resolve the duplicate headings before writing archives\n`, 2);
}

function criteriaPipeNote(criteria: string, raw: string): string {
  const pipe = criteria.includes("|")
    ? "W205: pipes in --criteria are escaped in the Markdown cell; input \\| denotes a literal pipe\n"
    : "";
  const rewritten = unescapeCell(raw) !== raw
    ? `--criteria was read as table-cell text; stored value is ${JSON.stringify(criteria)} (write \\\\| for a literal backslash before a pipe)\n`
    : "";
  return pipe + rewritten;
}

/** Keep a one-line receipt short: a 900-character old criterion used to push `wrote` off screen. */
function shortenNote(value: string, byteLimit = 120): string {
  if (Buffer.byteLength(value) <= byteLimit) return JSON.stringify(value);
  let bytes = 0;
  let kept = "";
  for (const char of value) {
    const width = Buffer.byteLength(char);
    if (bytes + width > byteLimit - 3) break; // leave room for the ellipsis
    bytes += width;
    kept += char;
  }
  return `${JSON.stringify(kept + "…")} (${Array.from(value).length} chars)`;
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
  const { loaded, ledger, errors, warnings: baselineWarnings } = opened;

  const found = findRow(ledger, idText);
  if (!found) return missingIssue("close", idText);
  // Same row, same diagnosis for every per-id verb: check the row shape
  // before "already closed", or a multi-id closed row reads as a state error.
  const refused = perIdRefusal("close", idText, found);
  if (refused) return refused;
  if (found.table === "closed") {
    if (v.criteria == null) return err(`issuemd close: #${idText} is already closed\n`, 2);
    if (v.status != null || v["keep-body"] || v["criteria-from-body"] || v["no-criteria"]) {
      return err("issuemd close: on an already closed issue, only --criteria may update the recorded criteria\n", 2);
    }
    const criteria = unescapeCell(v.criteria).replace(/[\r\n]+/g, " ");
    if (unescapeCell(escapeCell(criteria)) !== criteria) {
      return err("issuemd close: the criteria contain '\\|' (a backslash directly before a pipe), which a table cell cannot store without changing it\n", 2);
    }
    if (criteria === found.row.criteria) return commit(file, loaded, errors, loaded.lines, !!v["dry-run"]);
    const lines = [...loaded.lines];
    lines[found.row.line - 1] = replaceCell(lines[found.row.line - 1]!, 4, criteria);
    return commit(file, loaded, errors, lines, !!v["dry-run"], {
      report: `updated #${idText} criteria: ${shortenNote(found.row.criteria ?? "")} → ${shortenNote(criteria)}\n` + criteriaPipeNote(criteria, v.criteria),
      receipt: `#${idText} criteria`,
    });
  }
  if (v.criteria != null && v.status == null) {
    return err(`issuemd close: #${idText} is open. To edit its acceptance criteria, use 'issuemd criteria FILE ID --criteria TEXT'. ` +
      "To close it with supplied criteria, pass --status S explicitly and use --keep-body if you want to retain the body.\n", 2);
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
  const h2Sections = ledger.sections.filter((section) => section.level === 2);
  const bodySection = h2Sections.find((section) => section.title === "正文");
  const preserveTrailingBlanks = keepBody && bodySection != null && h2Sections.at(-1) === bodySection &&
    block?.end === bodySection.line_end;
  if (keepBody) {
    const archiveIndex = discoverArchives(ledger);
    const appendices = archiveIndex.appendices;
    const ambiguity = duplicateAppendixRefusal("close", appendices);
    if (ambiguity) return ambiguity;
    const existing = archiveIndex.archives.find(({ id }) => id === idText)?.section;
    if (existing) {
      return err(
        `issuemd close: 附录 already has an archive for #${idText} (L${existing.line_start}); ` +
          "merge or remove it first, then close --keep-body\n",
        3,
      );
    }
    const hidden = hiddenArchiveNote(archiveIndex, idText, ledger);
    if (hidden) return err(`issuemd close: ${hidden}\n`, 3);
  }
  // Criteria are stored once and must not vanish silently (spec §7.2): the
  // body is deleted by close, so whatever it says has to land somewhere.
  const fromBody = extractCriteria(bodyText);
  const labelHint = block ? criteriaLabelHint(bodyText, block.line - 1) : undefined;
  const hintText = labelHint ? `${labelHint.message}; ` : "";
  const multipleCanonical = block && criteriaOccurrences(bodyText, block.line - 1)
    .filter((occurrence) => occurrence.kind === "canonical" && occurrence.text.trim() !== "").length > 1;
  const criteriaRisks = baselineWarnings.filter((warning) => warning.id === idText &&
    (warning.code === "W268" || warning.code === "W264" ||
      (multipleCanonical && warning.code === "W206" && warning.message.startsWith("Duplicate body label: 验收判据;"))));
  if (block && criteriaRisks.length > 0 && !keepBody && v.criteria == null && !v["no-criteria"]) {
    const details = [...new Set(criteriaRisks.map(({ code, message }) => `${code} ${message}`))].join("; ");
    return err(
      `issuemd close: #${idText} has ambiguous criteria boundaries (${details}); ` +
        "review and merge with --status S --criteria TEXT, use --no-criteria intentionally, or preserve the body with --keep-body\n",
      2,
    );
  }
  let criteria: string;
  if (v.criteria != null) {
    // Input convention, as for titles: `\|` is how a caller spells a literal
    // pipe (unescapeCell); the cell then stores the escaped form. A cell
    // cannot hold a newline, so fold it here exactly as escapeCell would —
    // otherwise the lossy check below would blame the wrong character.
    criteria = unescapeCell(v.criteria).replace(/[\r\n]+/g, " ");
  } else if (v["no-criteria"]) {
    criteria = "";
  } else if (v["criteria-from-body"]) {
    if (fromBody == null) {
      return err(
        `issuemd close: #${idText} has no non-empty **验收判据** in its body; ` +
          (hintText || "a label line inside a code fence is an example and does not count; ") +
          "pass --status S --criteria TEXT or --no-criteria\n",
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
        "pass --status S --criteria TEXT, or --no-criteria to close it without criteria on purpose\n",
      2,
    );
  } else {
    return err(
      `issuemd close: #${idText} has no criteria to record (no --criteria and no non-empty **验收判据** in the body). ` +
        (labelHint ? `${labelHint.message}. ` : "") +
        "Pass --status S --criteria TEXT to record a conclusion, --no-criteria to leave the cell empty and delete the body (the file shrinks), " +
        "or --keep-body to retain evidence in 附录 (the file grows; prune later when reopen is no longer needed)\n",
      2,
    );
  }

  // `new`/`rename` tell the caller a pipe was escaped in the cell (W205);
  // `close --criteria` used to rewrite the input just as silently (dogfood
  // #111). Report it on the same terms.
  const escapedNote = v.criteria == null ? "" : criteriaPipeNote(criteria, v.criteria);
  // A table cell cannot store a backslash directly before `|`: the reader
  // takes it as a pipe escape (`echo a \| b` reads back as `echo a | b`), so
  // promoting the text would change it silently. Refuse and name the ways
  // out (round 14 black-box finding).
  if (unescapeCell(escapeCell(criteria)) !== criteria) {
    return err(
      `issuemd close: the criteria contain '\\|' (a backslash directly before a pipe), which a table cell cannot store without changing it; ` +
        "pass --status S --criteria with the text as it should read in the table, or close with --keep-body --no-criteria to keep the body verbatim in 附录\n",
      2,
    );
  }

  // Highest line number first so earlier coordinates stay valid.
  let lines = loaded.lines;

  // The archived heading is deliberately not an `Issue N:` heading: 附录
  // must not contain issue headings (E123), so the id moves into the text.
  let archive: string[] | undefined;
  let archivedPayloadLines: string[] | undefined;
  if (block) {
    if (keepBody) {
      // Preserve the source block's lines exactly after its heading. The first
      // blank separates heading from body; any additional edge blanks belong to
      // the user's text and must survive close/reopen.
      const kept = bodyText.slice(1);
      if (endsInFence(kept, true)) {
        return err(
          `issuemd close: the body of #${idText} ends inside an unclosed code fence; close the fence before archiving it\n`,
          3,
        );
      }
      archivedPayloadLines = kept;
      archive = serializeKeptBodyV3(idText, found.row.summary, kept);
    }
    lines = removeLines(lines, block.line, block.end - block.line + 1);
  }
  if (archive) {
    // Locate 附录 *after* the body removal: it may sit before 正文, in which
    // case inserting first would shift the block we then delete.
    const afterRemoval = parseLedger(joinDocument(lines, loaded.doc));
    const archiveIndex = discoverArchives(afterRemoval);
    const appendixHeadings = afterRemoval.sections.filter((section) => section.level === 2 && section.title === "附录");
    const hiddenAppendices = appendixHeadings.filter((section) =>
      !archiveIndex.appendices.some((visible) => visible.line_start === section.line_start));
    if (hiddenAppendices.length > 0) {
      return err(`issuemd close: ## 附录 at L${hiddenAppendices[0]!.line_start} is inside an HTML/comment/fence block; move it outside before archiving\n`, 3);
    }
    if (archiveIndex.appendices.length > 1) {
      return err(`issuemd close: duplicate ## 附录 headings (W266); resolve them before archiving\n`, 3);
    }
    const target = archiveIndex.appendices[0];
    // Place the archive before the appendix's existing trailing blank lines so
    // `reopen` can later restore those bytes instead of `terminate` discarding
    // them when the archive is removed.
    const scopeStart = target?.line_start ?? 0;
    let last = target?.line_end ?? lines.length;
    while (last > scopeStart && lines[last - 1] === "") last--;
    const insertAt = last + 1;
    // An archive inserted after an unclosed fence is code to every reader:
    // check and reopen would never see it (the body is gone for good).
    if (endsInFence(lines.slice(0, insertAt - 1))) {
      return err(
        `issuemd close: 附录 ends inside an unclosed code fence; close the fence first, ` +
          "or the kept body would be swallowed by it\n",
        3,
      );
    }
    if (target) {
      lines = insertLines(lines, insertAt, ["", ...archive]);
    } else {
      lines = insertLines(lines, insertAt, ["", "## 附录", APPENDIX_AUTO, "", ...archive]);
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

  if (archive && archivedPayloadLines) {
    const candidate = parseLedger(joinDocument(lines, loaded.doc));
    const invalid = validateSerializedArchive(candidate, idText, archivedPayloadLines);
    if (invalid) return err(`issuemd close: refusing to write v3 archive for #${idText}: ${invalid}\n`, 3);
  }

  const overrideNote = v.criteria != null && fromBody != null && criteria !== fromBody
    ? `#${idText} closing criteria override: ${shortenNote(fromBody)} → ${shortenNote(criteria)}\n`
    : undefined;
  let overLimit: Diagnostic | undefined;
  const result = commit(file, loaded, errors, lines, !!v["dry-run"], {
    report: overrideNote,
    observeCheck(report) { overLimit = report.warnings.find(({ code, id }) => code === "W201" && id === idText); },
    allowLost: (diagnostic) => diagnostic.code === "E102" && diagnostic.id === idText,
    preserveTrailingBlanks,
    receipt: `#${idText} closed as ${status}`,
  });
  if (keepBody && result.code === 0) {
    const hint = overLimit ? `W201: #${idText} ${overLimit.message}\n` : "";
    return {
      code: 0, stdout: result.stdout,
      stderr: result.stderr + `W250: kept the body of #${idText} by moving it into 附录; remove with 'issuemd prune FILE ID' when reopen is no longer needed (verified v2/v3 archives only)\n` + escapedNote + hint,
    };
  }
  return result.code === 0 && escapedNote ? { ...result, stderr: result.stderr + escapedNote } : result;
}

function inlineCodeCommitHashes(text: string): string {
  const ranges = inlineCodeRanges(text);
  const hashes = [...text.matchAll(/\b[0-9a-f]{7,40}\b/g)];
  let result = text;
  for (const match of hashes.reverse()) {
    const hash = match[0];
    if (!/[a-f]/.test(hash) && hash.length !== 40) continue;
    const index = match.index!;
    if (ranges.some(([start, end]) => index > start && index < end)) continue;
    let start = index;
    while (start > 0 && text[start - 1] === "`") start--;
    let end = index + hash.length;
    while (end < text.length && text[end] === "`") end++;
    const content = text.slice(start, end);
    const ticksInside = [...content.matchAll(/`+/g)].reduce((max, run) => Math.max(max, run[0].length), 0);
    const delimiter = "`".repeat(ticksInside + 1);
    const replacement = `${delimiter} ${content} ${delimiter}`;
    result = result.slice(0, start) + replacement + result.slice(end);
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
    // Already open. Without --status there is nothing to do: the default
    // target is 未决, but silently turning 观察 into 未决 is a change nobody
    // asked for (round 14 review). An explicit, different open status is a
    // plain status update. Neither can create a second open row, so the
    // duplicate-summary guard below does not apply to this branch.
    const wanted = v.status;
    if (wanted == null || wanted === found.row.status) {
      return v["dry-run"]
        ? { code: 0, stdout: "(no changes)\n", stderr: snapshotNote(loaded) }
        : ok("(no changes)\n");
    }
    const lines = [...loaded.lines];
    lines[found.row.line - 1] = replaceCell(lines[found.row.line - 1]!, 1, wanted);
    return commit(file, loaded, errors, lines, !!v["dry-run"], { receipt: `#${idText} status ${found.row.status} → ${wanted}` });
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
  const criterionEvidence = inlineCodeCommitHashes(criteria);
  // `close --keep-body` archived the body in 附录 precisely so it could be
  // recovered. Restore it instead of leaving an empty skeleton and a W250
  // heading that claims the (now open) issue still has a kept body.
  const archiveIndex = discoverArchives(ledger);
  const appendices = archiveIndex.appendices;
  const ambiguity = duplicateAppendixRefusal("reopen", appendices);
  if (ambiguity) return ambiguity;
  const archivedCandidates = archiveIndex.archives.filter(({ id }) => id === idText);
  if (archivedCandidates.length > 1) {
    const locations = archivedCandidates.map(({ section }) => `L${section.line_start}`).join(", ");
    return err(
      `issuemd reopen: multiple archives for #${idText} in 附录 (${locations}); merge or remove duplicates first\n`,
      3,
    );
  }
  const archived = archivedCandidates[0]?.section;
  if (!archived) {
    const hidden = hiddenArchiveNote(archiveIndex, idText, ledger);
    if (hidden) return err(`issuemd reopen: ${hidden}\n`, 3);
  }
  // The archive spans heading → end marker. Archives written before the
  // marker existed fall back to the H3's extent, minus trailing blank lines
  // (those separate it from whatever follows and must stay).
  let archiveSpan: { start: number; end: number } | undefined;
  let restored: string[] | undefined;
  let archivedPayloadLines: string[] | undefined;
  if (archived) {
    const located = locateArchivePayload(ledger, archived, archiveIndex.masks);
    if (!located.range) {
      const reason = located.refusal?.reason ?? "the payload boundary is invalid";
      return err(`issuemd reopen: archive for #${idText} cannot be restored: ${reason}; repair it first\n`, 3);
    }
    const range = located.range;
    if (range.version === "v2" || range.version === "v3") {
      restored = loaded.lines.slice(range.start - 1, range.end);
      archivedPayloadLines = [...restored];
    } else {
      const overlapping = archiveIndex.hiddenArchives.filter(({ line }) => line >= range.start && line <= range.framingEnd);
      if (overlapping.length > 0) {
        const locations = overlapping.map(({ id, line }) => `#${id} at L${line}`).join(", ");
        return err(`issuemd reopen: legacy archive for #${idText} overlaps a hidden kept-body archive (${locations}). Review the boundaries before retrying\n`, 3);
      }
      // Legacy keeps its original H3 and provenance note as restored body text.
      restored = loaded.lines.slice(archived.line_start, range.end);
    }
    // A table-only close criterion remains history separate from the archived
    // payload, preserving the existing reopen contract.
    const archivedCriteria = extractCriteria(restored);
    const archivedHistory = findLabel(restored, 1, restored.length, "关闭时判据")?.text.trim();
    if (criteria !== "" && archivedCriteria !== criteria && archivedHistory !== criteria) {
      restored.push("", `**关闭时判据**：${criterionEvidence}`);
    }
    const start = archived.line_start > 1 && loaded.lines[archived.line_start - 2] === ""
      ? archived.line_start - 1
      : archived.line_start;
    archiveSpan = { start, end: range.framingEnd };
  }

  // Reclaim only the exact generated section, and only if every remaining
  // line is empty or the provenance marker. User comments also count as data.
  const appendix = appendices[0];
  if (archiveSpan && appendix && loaded.lines[appendix.line_start] === APPENDIX_AUTO) {
    const remaining = loaded.lines.slice(appendix.line_start + 1, appendix.line_end)
      .filter((_, index) => {
        const line = appendix.line_start + 2 + index;
        return line < archiveSpan!.start || line > archiveSpan!.end;
      });
    if (remaining.every((line) => line === "")) {
      const start = loaded.lines[appendix.line_start - 2] === "" ? appendix.line_start - 1 : appendix.line_start;
      archiveSpan = { start, end: archiveSpan.end };
    }
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
  const reopened = parseLedger(joinDocument(lines, loaded.doc));
  const bodySection = reopened.sections.find(
    (section) => section.level === 2 && section.title === "正文",
  );
  if (!bodySection) return err("issuemd reopen: the 正文 section is missing\n", 3);
  const hasRestoredBody = archived != null && restored != null;
  const bodyBlocksAfterReopen = bodyBlocks(reopened);
  const hasLaterBody = bodyBlocksAfterReopen.some((block) => compareIds(block.id, found.span) > 0);
  const lastBodyBlock = bodyBlocksAfterReopen.at(-1);
  const appendToEnd = hasRestoredBody && bodySection.line_end === lines.length && !hasLaterBody &&
    (!lastBodyBlock || lastBodyBlock.end === bodySection.line_end);
  const bodyAt = appendToEnd ? lines.length + 1 : bodyInsertAt(reopened, found.span, bodySection.line_end);
  let bodyLines: string[];
  if (hasRestoredBody) {
    bodyLines = [`### Issue ${spanText(found.span)}: ${found.row.summary}`, ...restored!];
  } else {
    const acceptance = found.row.status === "已修" ? criterionEvidence : "";
    bodyLines = bodySkeleton(spanText(found.span), found.row.summary, acceptance);
    if (found.row.status !== "已修" && criterionEvidence !== "") {
      const criteriaAt = bodyLines.findIndex((line) => /^\*\*验收判据\*\*/.test(line));
      if (criteriaAt >= 0) bodyLines[criteriaAt] = `**关闭理由**：${criterionEvidence}`;
    }
  }
  const restoreAtEof = appendToEnd;
  const beforeBody = lines[bodyAt - 2];
  const restoredBlock = hasRestoredBody && beforeBody !== undefined && beforeBody.trim() !== ""
    ? ["", ...bodyLines]
    : bodyLines;
  lines = hasRestoredBody
    ? insertLines(lines, bodyAt, restoredBlock)
    : insertBlock(lines, bodyAt, bodyLines);

  if (archivedPayloadLines) {
    const candidateLines = terminate(lines, loaded.doc, loaded.lines, restoreAtEof);
    const candidateLedger = parseLedger(joinDocument(candidateLines, loaded.doc));
    const restoredBlock = bodyBlocks(candidateLedger).find((candidate) =>
      `${candidate.id.start}${candidate.id.suffix}` === idText);
    const actual = restoredBlock
      ? candidateLedger.lines.slice(restoredBlock.line, restoredBlock.line + archivedPayloadLines.length)
      : [];
    if (!restoredBlock || actual.length !== archivedPayloadLines.length ||
        actual.some((line, index) => line !== archivedPayloadLines![index])) {
      return err(`issuemd reopen: refusing to write; restored v2/v3 payload for #${idText} would change line records\n`, 3);
    }
    if (archivePayloadSnapshot(candidateLedger, idText) !== archivePayloadSnapshot(ledger, idText)) {
      return err(`issuemd reopen: refusing to write; reopening #${idText} would hide or alter another archive\n`, 3);
    }
  }

  const result = commit(file, loaded, errors, lines, !!v["dry-run"], {
    preserveTrailingBlanks: restoreAtEof,
    receipt: `#${idText} reopened as ${reopenStatus}`,
  });
  if (result.code !== 0 || extractCriteria(bodyLines.slice(1)) != null) return result;
  return {
    ...result,
    stderr: result.stderr + `issuemd reopen: #${idText} has no acceptance criteria; add **验收判据** before closing (W261)\n`,
  };
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
  return commit(file, loaded, errors, lines, !!v["dry-run"], {
    receipt: `#${idText} status ${found.row.status} → ${next}`,
  });
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
  // The table summary may already match while the body or kept-body archive
  // has drifted. Only bypass duplicate detection here; let the full candidate
  // reach commit(), whose byte comparison decides whether this is a no-op.
  const sameSummary = next === found.row.summary;
  // Renaming is the other way two open rows end up with one summary; refuse
  // it like `new` does (dogfood #34).
  if (!sameSummary && found.table === "open" && !v["allow-duplicate-title"]) {
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
  const changes: string[] = [];
  const reportTitle = (copy: string, old: string) =>
    changes.push(`updated #${idText} ${copy}: ${JSON.stringify(old)} → ${JSON.stringify(next)}\n`);
  if (!sameSummary) {
    lines[found.row.line - 1] = replaceCell(lines[found.row.line - 1]!, 3, next);
    reportTitle("table summary", found.row.summary);
  }
  const block = bodyBlocks(ledger).find(
    (candidate) => `${candidate.id.start}${candidate.id.suffix}` === idText,
  );
  if (block && unescapeCell(block.title) !== next) {
    lines[block.line - 1] = `### Issue ${idText}: ${next}`;
    reportTitle("body title", unescapeCell(block.title));
  }
  // A kept-body archive heading is a third copy of the summary; keep it in
  // step, or it silently disagrees with the table forever (dogfood #40).
  // Only archives inside a canonical 附录 section are managed; multiple
  // appendix sections form one logical archive area.
  const archiveIndex = discoverArchives(ledger);
  for (const { section, id } of archiveIndex.archives) {
    if (id !== idText) continue;
    const index = section.line_start - 1;
    const match = ARCHIVE_HEADING.exec(lines[index]!);
    if (match && unescapeCell(match[2]!) !== next) {
      lines[index] = archiveHeading(idText, next);
      reportTitle("archive title", unescapeCell(match[2]!));
    }
  }
  const result = commit(file, loaded, errors, lines, !!v["dry-run"], { receipt: `#${idText} renamed` });
  if (result.code !== 0) return result;
  if (next.includes("|")) {
    changes.push("W205: the new title contains a pipe; it was escaped in the table cell\n");
  }
  return { ...result, stderr: result.stderr + changes.join("") };
}

/** Last nonblank body line, or the heading line for an empty body. */
function bodyContentEnd(lines: string[], heading: number, end: number): number {
  while (end > heading && lines[end - 1]!.trim() === "") end--;
  return end;
}

/** Replace or append text under an open issue's heading (dogfood #16/#24/#97). */
function cmdBody(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const idText = rest[1];
  const moving = v["move-evidence"] != null;
  if (file == null || idText == null || rest.length !== 2 ||
      (moving ? (v.append || v["body-file"] != null) : v["body-file"] == null)) {
    return err(`usage: ${COMMANDS.body.usage}\n`, 2);
  }
  let incoming: string[] = [];
  let originalIncoming: string[] = [];
  if (!moving) {
    const read = readBodyFile(v["body-file"]!, "body");
    if ("code" in read) return read;
    originalIncoming = read.lines;
    incoming = trimBlank(read.lines);
  }
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors, warnings } = opened;
  const found = findRow(ledger, idText);
  if (!found) return missingIssue("body", idText);
  const refused = perIdRefusal("body", idText, found);
  if (refused) return refused;
  if (found.table === "closed") {
    return err(`issuemd body: #${idText} is closed; a closed issue has no body (reopen it first)\n`, 2);
  }
  if (moving) {
    const built = buildMoveEvidence(ledger, idText, v["move-evidence"]!);
    if ("error" in built) return err(`issuemd body --move-evidence: ${built.error}\n`, built.code);
    let remaining: Diagnostic | undefined;
    const result = commit(file, loaded, errors, built.move.lines, !!v["dry-run"], {
      receipt: `#${idText} evidence moved to ${built.move.anchor}`,
      observeCheck(report) { remaining = report.warnings.find(({ code, id }) => code === "W201" && id === idText); },
      validateCandidate(candidate) {
        const refusal = validateMoveEvidence(ledger, candidate, built.move);
        return refusal ? err(`issuemd body --move-evidence: ${refusal}; nothing written\n`, 3) : undefined;
      },
    });
    if (result.code !== 0) return result;
    const state = remaining ? `W201 remains active for #${idText}: ${remaining.message}` : `W201 cleared for #${idText}`;
    return { ...result, stderr: `${result.stderr}${state}\n` };
  }
  const block = bodyBlocks(ledger).find((candidate) => `${candidate.id.start}${candidate.id.suffix}` === idText);
  let lines = loaded.lines;
  if (incoming.length === 0) {
    return commit(file, loaded, errors, lines, !!v["dry-run"]);
  }
  if (block) {
    if (v.append) {
      const currentBody = lines.slice(block.line - 1, block.end);
      const incomingLabels = [...bodyLabels(incoming, 1, incoming.length)];
      const incomingCriteria = incomingLabels.find(({ label }) => isCriteriaLabel(label));
      if (incomingCriteria) {
        return err(`issuemd body: append contains criteria label **${incomingCriteria.label}** at input L${incomingCriteria.line}; ` +
          "put quoted criteria inside a code fence or replace the body with reviewed criteria\n", 2);
      }
      const currentLabels = [...bodyLabels(currentBody, 1, currentBody.length)];
      const lastLabel = currentLabels.at(-1)?.label;
      let addition = incoming;
      if (lastLabel && isCriteriaLabel(lastLabel) && incomingLabels[0]?.line !== 1) {
        const reserved = new Set([...currentLabels, ...incomingLabels].map(({ label }) => label));
        let reviewLabel = "复测记录";
        for (let suffix = 2; reserved.has(reviewLabel); suffix++) reviewLabel = `复测记录 ${suffix}`;
        addition = [`**${reviewLabel}**：`, "", ...incoming];
      }
      const end = bodyContentEnd(lines, block.line, block.end);
      const candidate = insertBlock(lines, end + 1, addition);
      const candidateBody = candidate.slice(block.line - 1, block.end + candidate.length - lines.length);
      const before = criteriaOccurrences(currentBody);
      const after = criteriaOccurrences(candidateBody);
      const previousHints = new Set(criteriaBoundaryHints(currentBody).map(({ line, detail }) => `${line}:${detail}`));
      const newHint = criteriaBoundaryHints(candidateBody).find(({ line, detail }) => !previousHints.has(`${line}:${detail}`));
      if (JSON.stringify(before) !== JSON.stringify(after) || newHint) {
        const where = newHint ? ` at L${block.line + newHint.line - 1}` : "";
        return err(`issuemd body: append would change or obscure criteria for #${idText}${where}; ` +
          "use a separate review label or replace the body with reviewed criteria\n", 2);
      }
      lines = candidate;
    } else {
      const current = trimBlank(lines.slice(block.line, block.end));
      // A body-only round trip should preserve the ledger's original spacing.
      if (current.length === incoming.length && current.every((line, index) => line === incoming[index])) {
        return commit(file, loaded, errors, lines, !!v["dry-run"]);
      }
      const heading = lines[block.line - 1]!;
      lines = removeLines(lines, block.line, block.end - block.line + 1);
      lines = insertBlock(lines, block.line, [heading, "", ...incoming]);
    }
  } else {
    const section = ledger.sections.find((candidate) => candidate.level === 2 && candidate.title === "正文");
    if (!section) return err("issuemd body: the 正文 section is missing\n", 3);
    const at = bodyInsertAt(ledger, found.span, section.line_end);
    lines = insertBlock(lines, at, [`### Issue ${idText}: ${found.row.summary}`, "", ...originalIncoming]);
  }
  const bytes = Buffer.byteLength(incoming.join("\n"));
  const receipt = v.append ? `#${idText} body appended, ${bytes} bytes` : `#${idText} body replaced, ${bytes} bytes`;
  let overLimit: Diagnostic | undefined;
  const result = commit(file, loaded, errors, lines, !!v["dry-run"], {
    receipt,
    observeCheck(report) { overLimit = report.warnings.find(({ code, id }) => code === "W201" && id === idText); },
  });
  if (result.code !== 0) return result;
  const aliasHint = criteriaAliasWriteHint(file, lines, idText);
  const overLimitNote = overLimit && !warnings.some(({ code, id }) => code === "W201" && id === idText)
    ? `W201: #${idText} ${overLimit.message}; move older evidence to a linked file\n`
    : "";
  const notes = `${aliasHint}${overLimitNote}`;
  return notes ? { ...result, stderr: result.stderr + notes } : result;
}

function cmdCriteria(rest: string[], v: Values): CliResult {
  const [file, idText] = rest;
  const value = v.criteria;
  if (file == null || idText == null || rest.length !== 2 || value == null) {
    return err(`usage: ${COMMANDS.criteria.usage}\n`, 2);
  }
  if (value.trim() === "" || /[\r\n]|<!--|-->/.test(value)) {
    return err("issuemd criteria: --criteria must be one nonempty Markdown line without HTML comment delimiters\n", 2);
  }
  const opened = openLedger(file, v["if-unchanged"]);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;
  const found = findRow(ledger, idText);
  if (!found) return missingIssue("criteria", idText);
  const refused = perIdRefusal("criteria", idText, found);
  if (refused) return refused;
  if (found.table === "closed") {
    return err(`issuemd criteria: #${idText} is closed; use 'issuemd close FILE ID --criteria TEXT' to correct its table cell\n`, 2);
  }
  const bodies = bodyBlocks(ledger).filter(({ id }) => spanText(id) === idText);
  const owners = [...ledger.rows.open, ...ledger.rows.closed].filter(({ ids }) => ids.some((span) =>
    span.suffix === found.span.suffix && span.start <= found.span.start && found.span.start <= span.end));
  if (bodies.length !== 1 || owners.length !== 1 || unreadableHolding(ledger, idText)) {
    return err(`issuemd criteria: #${idText} needs one unambiguous open row and its own body\n`, 2);
  }
  const block = bodies[0]!;
  const edit = editOpenCriteria(loaded.lines.slice(block.line - 1, block.end), value, block.line - 1);
  if ("error" in edit) return err(`issuemd criteria: #${idText} ${edit.error}\n`, 2);
  const lines = [...loaded.lines.slice(0, block.line - 1), ...edit.body, ...loaded.lines.slice(block.end)];
  return commit(file, loaded, errors, lines, !!v["dry-run"], {
    receipt: `#${idText} acceptance criteria updated`,
    preserveTrailingBlanks: true,
  });
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
  return commit(file, loaded, errors, lines, !!v["dry-run"], {
    receipt: `#${idText} priority ${found.row.priority || "(none)"} → ${next || "(none)"}`,
  });
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
  const priorW212 = checkParsedLedger(ledger, file).warnings.filter(({ code }) => code === "W212");
  const priorCounts = new Map<string, number>();
  for (const diagnostic of priorW212) {
    const key = diagnosticKey(diagnostic);
    priorCounts.set(key, (priorCounts.get(key) ?? 0) + 1);
  }
  const addedW212: Diagnostic[] = [];
  // The ids this row covers are the only E102s split may multiply: they were
  // already reported (once, for the first missing one) before the split.
  const result = commit(file, loaded, errors, lines, !!v["dry-run"], {
    receipt: `#${idText} split into ${rowIds.size} rows`,
    tolerate: (diagnostic) => diagnostic.code === "E102" && diagnostic.id != null && rowIds.has(diagnostic.id),
    observeCheck: (report) => {
      const remaining = new Map(priorCounts);
      for (const diagnostic of report.warnings.filter(({ code }) => code === "W212")) {
        const key = diagnosticKey(diagnostic);
        const count = remaining.get(key) ?? 0;
        if (count > 0) remaining.set(key, count - 1);
        else addedW212.push(diagnostic);
      }
    },
  });
  if (result.code !== 0) return result;
  const duplicateIds = [...new Set(addedW212.flatMap(({ id, message }) => [
    ...(id == null ? [] : [id]),
    ...[...message.matchAll(/#(\d+[a-z]?)/g)].map((match) => match[1]!),
  ]))];
  const namedIds = duplicateIds.length <= 3
    ? duplicateIds.map((id) => `#${id}`).join(", ")
    : `#${duplicateIds[0]} … #${duplicateIds.at(-1)} (${duplicateIds.length} ids)`;
  const duplicateNote = addedW212.length > 0
    ? `issuemd split: introduced ${addedW212.length} W212 duplicate-summary warning(s) for ${namedIds}; ` +
      "run 'issuemd rename FILE ID \"…\"' to distinguish them; details: 'issuemd check FILE --json'\n"
    : "";
  if (missing.length === 0) return duplicateNote ? { ...result, stderr: result.stderr + duplicateNote } : result;
  const ids = missing.length <= 3
    ? missing.map((id) => `#${id}`).join(", ")
    : `${missing.length} ids (#${missing[0]}, … (${missing.length - 2} more), #${missing.at(-1)})`;
  const note = `issuemd split: no body block for ${ids}; ` +
    "nothing was invented — write one with 'issuemd body FILE ID --body-file -'\n";
  return { ...result, stderr: result.stderr + duplicateNote + note };
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
  const convertedLedger = parseLedger(target);
  for (const { id, lines: payloadLines } of result.archivePayloads ?? []) {
    const invalid = validateSerializedArchive(convertedLedger, id, payloadLines);
    if (invalid) return err(`issuemd adopt: refusing v3 archive for #${id}: ${invalid}\n`, 3);
  }
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
      return writeFailure(file, error);
    }
  }
  // Written after the ledger so a failed conversion never leaves a report
  // that describes a write that did not happen.
  const receipt = unchanged ? "" : writeReceipt(file, "adopted ledger", target) + hardLinkNote(file, loaded);
  const failed = writeReport();
  if (failed) return { ...failed, stderr: receipt + failed.stderr };
  // Same words as every other no-op write, and as this command's --dry-run:
  // a retrying caller can tell "already converted" from "just converted".
  return {
    code: 0,
    stdout: (unchanged ? "(no changes)\n\n" : "") + report,
    stderr: receipt,
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

function syncFixHashes(
  file: string,
  loaded: Loaded,
  ledger: ReturnType<typeof parseLedger>,
  errors: Diagnostic[],
  warnings: Diagnostic[],
  v: Values,
): CliResult {
  const lines = [...loaded.lines];
  const hashWarnings = warnings.filter(({ code }) => code === "W202");
  const fenced = fencedLines(lines, true);
  const visibility = bodyVisibility(lines, fenced);
  const rawHtml = htmlBlockLines(lines, fenced);
  const repairRanges = hashRepairRanges(lines, fenced);
  const tableLines = new Set<number>();
  for (const block of ledger.blocks) {
    for (let offset = 0; offset < block.rows.length; offset++) tableLines.add(block.line + offset);
  }
  const openIds = new IdSet(ledger.rows.open.flatMap((row) => row.ids));
  const closedIds = new IdSet(ledger.rows.closed.flatMap((row) => row.ids));
  const allBodyLines = new Set<number>();
  const editableBodyLines = new Set<number>();
  const headings = new Set<number>(ledger.sections.map(({ line_start }) => line_start));
  for (const block of bodyBlocks(ledger)) {
    for (let line = block.line; line <= block.end; line++) allBodyLines.add(line);
    if (!openIds.has(block.id) || closedIds.has(block.id)) continue;
    for (let line = block.line + 1; line <= block.end; line++) editableBodyLines.add(line);
  }
  const appendixLines = new Set<number>();
  const archivePayloadLines = new Set<number>();
  const malformedArchiveLines = new Set<number>();
  const archiveIndex = discoverArchives(ledger);
  for (const appendix of archiveIndex.appendices) {
    for (let line = appendix.line_start + 1; line <= appendix.line_end; line++) appendixLines.add(line);
  }
  for (const { section: archive } of archiveIndex.archives) {
    headings.add(archive.line_start);
    const range = archivePayloadRange(ledger, archive, fenced);
    if (!range) {
      for (let line = archive.line_start; line <= archive.line_end; line++) malformedArchiveLines.add(line);
    } else {
      for (let line = range.start; line <= range.end; line++) archivePayloadLines.add(line);
    }
  }

  const edits: { line: number; column: number; hash: string; id?: string; start: number; end: number }[] = [];
  const skipped: { line: number; column?: number; reason: string }[] = [];
  for (const warning of hashWarnings) {
    const line = lines[warning.line - 1] ?? "";
    const hash = /Possible pinned commit hash: ([0-9a-f]{7,40})/.exec(warning.message)?.[1];
    const span = hashSpans(line).find((candidate) => candidate.hash === hash &&
      Array.from(line.slice(0, candidate.start)).length + 1 === warning.column);
    if (!span) {
      skipped.push({ line: warning.line, column: warning.column, reason: "source span could not be resolved" });
      continue;
    }
    let reason: string | undefined;
    if (tableLines.has(warning.line)) reason = "parsed table cell; preserve table ids and syntax";
    else if (headings.has(warning.line)) reason = "managed or structural heading";
    else if (malformedArchiveLines.has(warning.line)) reason = "malformed archive subtree is read-only";
    else if (archivePayloadLines.has(warning.line)) reason = "frozen archive payload";
    else if (hashRepairContextSkipReason(line, warning.line - 1, span, repairRanges) != null) {
      reason = hashRepairContextSkipReason(line, warning.line - 1, span, repairRanges);
    }
    else if (rawHtml[warning.line - 1]) reason = "raw HTML block";
    else if (fenced[warning.line - 1]) reason = "fenced code";
    else if (visibility.hidden[warning.line - 1] || line.includes("<!--") || line.includes("-->")) reason = "HTML comment text";
    else if (!editableBodyLines.has(warning.line) && !appendixLines.has(warning.line)) {
      reason = allBodyLines.has(warning.line) ? "body is not open" : "outside open bodies and appendix prose";
    } else {
      reason = hashRepairContextSkipReason(line, warning.line - 1, span, repairRanges) ?? hashRepairSkipReason(line, span);
    }    if (reason) skipped.push({ line: warning.line, column: warning.column, reason });
    else edits.push({ line: warning.line, column: warning.column!, hash: span.hash, ...(warning.id ? { id: warning.id } : {}), start: span.start, end: span.end });
  }

  const editsByLine = new Map<number, typeof edits>();
  for (const edit of edits) {
    const group = editsByLine.get(edit.line) ?? [];
    group.push(edit);
    editsByLine.set(edit.line, group);
  }
  for (const [lineNo, group] of editsByLine) {
    let text = lines[lineNo - 1]!;
    for (const edit of group.sort((a, b) => b.start - a.start)) {
      text = `${text.slice(0, edit.start)}\`${text.slice(edit.start, edit.end)}\`${text.slice(edit.end)}`;
    }
    lines[lineNo - 1] = text;
  }
  let remaining = 0;
  const result = commit(file, loaded, errors, lines, !!v["dry-run"], {
    ...(edits.length ? { receipt: "sync --fix-hashes" } : {}),
    observeCheck(report) {
      remaining = report.warnings.filter(({ code }) => code === "W202").length;
    },
    validateCandidate() {
      if (v["require-complete"] && remaining > 0) {
        return err(`issuemd sync --fix-hashes: --require-complete found ${remaining} remaining W202 warning(s); nothing written\n`, 3);
      }
      return undefined;
    },
  });
  const wrapVerb = result.code === 0 ? "wrapped" : "would wrap";
  const notes = [
    ...edits.map(({ line, column, id, hash }) => `${wrapVerb} W202${id ? ` #${id}` : ""} at L${line}:${column}: ${hash}`),
    ...skipped.map(({ line, column, reason }) => `skipped W202 at L${line}${column == null ? "" : `:${column}`}: ${reason}`),
  ];
  const summary = `W202: wrapped ${edits.length}, skipped ${skipped.length}, remaining ${remaining}\n`;
  return { ...result, stderr: `${result.stderr}${summary}${notes.length ? `${notes.join("\n")}\n` : ""}` };
}

const errorIdentity = (diagnostics: Diagnostic[]) => diagnostics
  .map(({ code, id, message, expected, actual }) => `${code}|${id ?? ""}|${message}|${expected ?? ""}|${actual ?? ""}`)
  .sort()
  .join("\n");

/** Delete one explicitly confirmed kept-body archive; the closed row stays. */
function cmdPrune(rest: string[], v: Values): CliResult {
  const [file, idText] = rest;
  if (file == null || idText == null || rest.length !== 2) return err(`usage: ${COMMANDS.prune.usage}\n`, 2);
  const dry = !!v["dry-run"];
  const confirm = !!v.confirm;
  if (dry === confirm) return err("issuemd prune: choose exactly one of --dry-run or --confirm\n", 2);
  if (confirm && v["if-unchanged"] == null) {
    return err("issuemd prune: --confirm requires --if-unchanged SNAPSHOT from the preview\n", 2);
  }
  if (!confirm && v["if-unchanged"] != null) {
    return err("issuemd prune: --if-unchanged belongs with --confirm\n", 2);
  }
  const opened = openLedger(file, confirm ? v["if-unchanged"] : undefined);
  if ("code" in opened) return opened;
  const { loaded, ledger, errors } = opened;
  const found = prunableArchive(ledger, idText);
  if (found.refusal) {
    const locations = found.refusal.lines.map((line) => `L${line}`).join(", ");
    const where = locations ? ` (${locations})` : "";
    return err(`issuemd prune: #${idText}: ${found.refusal.reason}${where}; nothing written\n`, found.refusal.code);
  }
  const { start, end } = found.target;
  const candidate = loaded.lines.slice();
  candidate.splice(start - 1, end - start + 1);
  const candidateLines = terminate(candidate, loaded.doc, loaded.lines, true);
  const candidateDoc = parseLedger(joinDocument(candidateLines, loaded.doc));
  const afterErrors = checkParsedLedger(candidateDoc, file).errors;
  if (errorIdentity(errors) !== errorIdentity(afterErrors)) {
    return err("issuemd prune: refusing to write; the deletion would change existing check errors\n", 3);
  }
  if (JSON.stringify(archivePayloadSnapshot(candidateDoc, idText)) !== JSON.stringify(archivePayloadSnapshot(ledger, idText)) ||
      JSON.stringify(archiveFramingSnapshot(candidateDoc, idText)) !== JSON.stringify(archiveFramingSnapshot(ledger, idText))) {
    return err("issuemd prune: refusing to write; another archive's payload or framing would change\n", 3);
  }
  return commit(file, loaded, errors, candidateLines, dry, {
    preserveTrailingBlanks: true,
    report: `pruned #${idText} archive at L${start}-L${end}\n`,
    receipt: `#${idText} archive pruned`,
  });
}

function cmdSync(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null || rest.length !== 1) {
    return err(`usage: ${COMMANDS.sync.usage}\n`, 2);
  }
  if (v["require-complete"] && !v["fix-hashes"]) {
    return err("issuemd sync: --require-complete requires --fix-hashes\n", 2);
  }
  const modes = [!!v.guide, !!v["fix-tables"], !!v.titles, !!v["criteria-labels"], !!v["fix-hashes"]].filter(Boolean).length;
  if (modes === 0) return err("issuemd sync: choose --guide, --fix-tables, --titles, --criteria-labels or --fix-hashes\n", 2);
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
  if (v["fix-hashes"]) return syncFixHashes(file, loaded, ledger, errors, opened.warnings, v);
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
    return commit(file, loaded, errors, lines, !!v["dry-run"], { receipt: "sync --guide" });
  }

  if (v["fix-tables"]) {
    lines = fixTables(lines, ledger);
    return commit(file, loaded, errors, lines, !!v["dry-run"], { receipt: "sync --fix-tables" });
  }

  if (v["criteria-labels"]) return syncCriteriaLabels(file, loaded, ledger, errors, v);
  return syncTitles(file, loaded, ledger, errors, prefer, v);
}

function syncCriteriaLabels(
  file: string,
  loaded: Loaded,
  ledger: ReturnType<typeof parseLedger>,
  errors: Diagnostic[],
  v: Values,
): CliResult {
  const bodies = new Map(bodyBlocks(ledger).map((block) => [`${block.id.start}${block.id.suffix}`, block]));
  const changes: { id: string; line: number; oldLabel: string; newLine: string }[] = [];
  const skipped: string[] = [];
  for (const row of ledger.rows.open) {
    if (row.ids.length !== 1 || row.ids[0]!.start !== row.ids[0]!.end) continue;
    const id = spanText(row.ids[0]!);
    const body = bodies.get(id);
    if (!body) continue;
    const bodyLines = loaded.lines.slice(body.line - 1, body.end);
    const repair = criteriaAliasRepair(bodyLines, body.line - 1);
    if (!repair) continue;
    if (!repair.eligible) {
      skipped.push(`#${id}: ${repair.reason ?? "nearby criteria labels need review"}`);
      continue;
    }
    const candidate = repair.eligible;
    // Renaming prose that is not criteria-shaped would erase W261 and
    // promote a status sentence into the acceptance criteria (dogfood #104).
    const aliasBlock = labelBlock(bodyLines, candidate.line - body.line + 1, bodyLines.length, candidate.label);
    if (!blockHasListItems(aliasBlock) && !v.force) {
      skipped.push(`#${id}: block has no list items; pass --force to rename it anyway`);
      continue;
    }
    const source = loaded.lines[candidate.line - 1]!;
    const parsed = /^([ \t]{0,3})\*\*([^*]+)\*\*(.*)$/.exec(source);
    if (!parsed) continue;
    const colonInside = /[:：]\s*$/.test(parsed[2]!);
    const newLine = `${parsed[1]}**验收判据${colonInside ? "：" : ""}**${parsed[3]}`;
    changes.push({ id, line: candidate.line, oldLabel: candidate.label, newLine });
  }
  const skippedNote = skipped.length ? `issuemd sync --criteria-labels: skipped ${skipped.join("; ")}\n` : "";
  if (changes.length === 0) {
    const result = commit(file, loaded, errors, loaded.lines, !!v["dry-run"]);
    return skippedNote ? { ...result, stderr: result.stderr + skippedNote } : result;
  }
  let lines = [...loaded.lines];
  for (const change of changes.sort((a, b) => b.line - a.line)) lines[change.line - 1] = change.newLine;
  const result = commit(file, loaded, errors, lines, !!v["dry-run"], { receipt: "sync --criteria-labels" });
  if (result.code !== 0) return result;
  const receipt = changes.map(({ id, line, oldLabel }) =>
    `updated #${id} criteria label at L${line}: ${JSON.stringify(oldLabel)} → "验收判据"`).join("\n");
  return { ...result, stderr: `${result.stderr}${receipt}\n${skippedNote}` };
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
  const unmoved: string[] = [];
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
    if (foldWhitespace(title) === foldWhitespace(row.summary)) {
      const progress = v["move-progress"] ? matchProgressCue(row.summary) : undefined;
      if (progress) unmoved.push(
        `issuemd sync --titles --move-progress: #${id} still has W260 progress text ` +
        `${JSON.stringify(progress.cue)} at summary column ${progress.column}. ` +
        "Review the issue, use 'issuemd rename FILE ID <title>', then preserve the progress note with 'issuemd body FILE ID --append --body-file -'.\n",
      );
      continue;
    }
    changes.push({ id, oldSummary: row.summary, title, rowLine: row.line, bodyLine: block.line });
  }
  const skippedNote = skipped.length === 0
    ? ""
    : `issuemd sync --titles: skipped ${skipped.length} multi-id row(s) whose summary differs from a body title ` +
      `(split the row first, then re-run): ${skipped.map((ids) => `#${ids}`).join("; ")}\n`;
  const notes = skippedNote + unmoved.join("");
  if (changes.length === 0) {
    // Same contract as every other dry-run: say "(no changes)", give the snapshot.
    return v["dry-run"]
      ? { code: 0, stdout: "(no changes)\n", stderr: snapshotNote(loaded) + notes }
      : { code: 0, stdout: "(no changes)\n", stderr: notes };
  }

  // Only --prefer body loses the table wording; --prefer table copies it into
  // the heading, so there only real progress words are refused (review 11).
  const progress = changes.filter((change) => prefer === "body" || matchProgressCue(change.oldSummary) != null);
  if (prefer === "body" && progress.length > 0 &&
      (v.prefer !== "body" || (!v["move-progress"] && !v["drop-progress"]))) {
    const listed = progress.map(({ id, oldSummary, title }) => `  #${id}  摘要: ${oldSummary}；正文标题: ${title}`).join("\n");
    return err(
      `issuemd sync --titles: ${progress.length} summary(ies) differ from body titles; choosing the body would replace table text, nothing written\n` +
        `${listed}\n` +
        "choose --prefer body --move-progress to preserve the summary in the body, --prefer body --drop-progress to discard it, " +
        "or --prefer table to keep the summary\n",
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

  const result = commit(file, loaded, errors, lines, !!v["dry-run"], { receipt: "sync --titles" });
  if (result.code !== 0) return notes ? { ...result, stderr: result.stderr + notes } : result;
  const changesNote = changes.map((change) => prefer === "body"
    ? `updated #${change.id} summary: ${JSON.stringify(change.oldSummary)} → ${JSON.stringify(change.title)}`
    : `updated #${change.id} body title: ${JSON.stringify(change.title)} → ${JSON.stringify(change.oldSummary)}`
  ).join("\n");
  const note = changesNote ? `${changesNote}\n` : "";
  return { ...result, stderr: result.stderr + note + notes };
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

const foldWhitespace = (text: string) => text.trim().replace(/\s+/g, " ");
