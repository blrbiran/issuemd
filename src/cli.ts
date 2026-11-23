/**
 * issuemd CLI — composes scan + sections + select + render into commands.
 *
 * Uses node:util.parseArgs only: zero runtime dependencies. Subcommand
 * dispatch is a tiny switch on argv[0]; that's about 20 lines of glue we'd
 * reinvent on top of any framework anyway, and the cold-start benchmark
 * (see BENCHMARK.md) showed cac and parseArgs tied at ~16ms.
 *
 * Public commands (MVP):
 *   issuemd [file]                   toc
 *   issuemd <file> <selector>        alias for: issuemd read
 *   issuemd read <file> <selector>   read section(s) matching selector
 *   issuemd ls <file> <selector>     direct children of matching section
 *   issuemd grep <file> <pattern>    regex search inside section bodies
 *   issuemd --help | -h              help
 *
 * File argument accepts `-` to read stdin.
 *
 * Exit codes:
 *   0  found something / toc printed / help
 *   1  ran successfully but found no matches (grep-style, so `&&` chaining
 *      works the way agents expect)
 *   2  usage error (bad flag, missing file, invalid regex, file not found)
 */

import { parseArgs, type ParseArgsConfig } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";

import { scan } from "./scan.js";
import { buildSections, countLines, pathOf, type Section } from "./sections.js";
import { match, parseSelector } from "./select.js";
import { renderSection, renderToc, truncateBody } from "./render.js";
import {
  setSection,
  appendToSection,
  insertAfter,
  removeSection,
  renameSection,
  shiftLevel,
  moveSection,
  unifiedDiff,
} from "./write.js";

const HELP = `issuemd — CLI for working with large Markdown files

Usage:
  issuemd                              show this help
  issuemd <file>                       print table of contents
  issuemd <file> <selector>            alias for 'issuemd read'
  issuemd toc    <file>                print table of contents (explicit)
  issuemd read   <file> <selector>     print sections matching selector
  issuemd ls     <file> <selector>     list direct child headings
  issuemd grep   <file> <pattern>      regex-search section bodies
  issuemd links  <file> [selector]     extract markdown links from sections
  issuemd code   <file> [selector]     extract fenced code blocks

  [write — modify files in place; --dry-run prints diff instead]:
  issuemd set    <file> <sel> --body <text>            replace section body
  issuemd append <file> <sel> --body <text>            append to section body
  issuemd insert <file> --after <sel> --body <text>    insert after section
  issuemd rm     <file> <sel>                          remove section
  issuemd rename <file> <sel> <new-name>               rename heading
  issuemd promote <file> <sel>                         decrease heading level
  issuemd demote  <file> <sel>                         increase heading level
  issuemd mv <file> <from> <to>                        re-parent section under <to>

Selector grammar:
  Install                   fuzzy, case-insensitive substring
  =Install                  exact, case-insensitive equality
  /^inst/i                  regex (JS syntax); flags default to 'i'
  ##Install                 level filter (1..6 '#'s)
  Guide > Install           descendant, any depth under 'Guide'
  Guide >> Install          direct child of 'Guide'

Options:
  --depth <n>               TOC: max heading depth to show (0 = none)
  --flat                    TOC: flat list, no indentation
  --max-results <n>         cap matches for read/ls (default 25)
  --max-lines <n>           truncate long bodies (0 = unlimited)
  --body-only               read: skip subsections
  --no-body                 read: print headings only
  --raw                     read: drop delimiter lines
  --json                    machine-readable JSON output
  --lang <lang>             code: filter code blocks by language
  --body <text>             write: inline body content
  --after <selector>        insert: selector of section to insert after
  --dry-run                 write: print unified diff, don't modify file

Use '-' as <file> to read from stdin. Exit code is 1 when no matches.
`;

export type CliResult = { code: number; stdout: string; stderr: string };

function ok(s: string): CliResult {
  return { code: 0, stdout: s, stderr: "" };
}
function noMatch(s: string): CliResult {
  // Successful run that found nothing: exit 1 so `issuemd ... && foo` works the
  // way agents expect, but keep the friendly message on stdout so humans see
  // it too.
  return { code: 1, stdout: s, stderr: "" };
}
function err(s: string, code = 1): CliResult {
  return { code, stdout: "", stderr: s };
}

const OPTIONS = {
  depth: { type: "string" },
  flat: { type: "boolean" },
  "max-results": { type: "string" },
  "max-lines": { type: "string" },
  "body-only": { type: "boolean" },
  "no-body": { type: "boolean" },
  raw: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  // write commands
  "dry-run": { type: "boolean" },
  body: { type: "string" },
  after: { type: "string" },
  // code command
  lang: { type: "string" },
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
  if (values.help || positionals.length === 0) {
    return ok(HELP);
  }

  // Detect explicit subcommand by the first positional.
  const head = positionals[0];
  const CMDS = new Set([
    "read", "ls", "grep", "toc",
    "links", "code",
    "set", "append", "insert", "rm", "rename", "promote", "demote", "mv",
  ]);
  if (head && CMDS.has(head)) {
    return dispatch(head, positionals.slice(1), values);
  }

  // Positional form:
  //   issuemd <file>              -> toc
  //   issuemd <file> <selector>   -> read
  if (positionals.length === 1) return dispatch("toc", positionals, values);
  return dispatch("read", positionals, values);
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

async function dispatch(
  cmd: string,
  rest: string[],
  values: Values,
): Promise<CliResult> {
  switch (cmd) {
    case "toc":
      return cmdToc(rest, values);
    case "read":
      return cmdRead(rest, values);
    case "ls":
      return cmdLs(rest, values);
    case "grep":
      return cmdGrep(rest, values);
    case "links":
      return cmdLinks(rest, values);
    case "code":
      return cmdCode(rest, values);
    case "set":
      return cmdSet(rest, values);
    case "append":
      return cmdAppend(rest, values);
    case "insert":
      return cmdInsert(rest, values);
    case "rm":
      return cmdRm(rest, values);
    case "rename":
      return cmdRename(rest, values);
    case "promote":
      return cmdPromote(rest, values);
    case "demote":
      return cmdDemote(rest, values);
    case "mv":
      return cmdMv(rest, values);
    default:
      return err(`issuemd: unknown command '${cmd}'\n${HELP}`, 2);
  }
}

/**
 * Read `file` from disk or stdin. Returns a CliResult on failure so callers
 * can just forward it — we swallow raw ENOENT stack traces here and emit a
 * friendly "issuemd: cannot open 'foo.md'" message instead.
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

/**
 * Parse `v` as a base-10 integer. Returns null (not fallback) on invalid
 * input so callers can distinguish "not provided" from "bad value".
 */
function parseIntOrNull(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || String(n) !== v.trim()) return null;
  return n;
}

function readFlag(
  v: Values,
  name: "depth" | "max-results" | "max-lines",
  fallback: number | null,
): { value: number | null } | CliResult {
  const raw = v[name];
  if (raw == null) return { value: fallback };
  const n = parseIntOrNull(raw);
  if (n == null || n < 0) {
    return err(`issuemd: --${name} expects a non-negative integer, got '${raw}'\n`, 2);
  }
  return { value: n };
}

// ---- commands ----------------------------------------------------------

function cmdToc(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null) return err("issuemd toc: missing <file>\n", 2);
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));

  if (v.json) {
    return ok(
      JSON.stringify(
        {
          file,
          total_lines: countLines(src),
          headings: sections.map(sectionToJSON),
        },
        null,
        2,
      ),
    );
  }

  const depth = readFlag(v, "depth", null);
  if ("code" in depth) return depth;
  return ok(
    renderToc(file, src, sections, {
      depth: depth.value ?? undefined,
      flat: !!v.flat,
    }),
  );
}

async function cmdRead(rest: string[], v: Values): Promise<CliResult> {
  const file = rest[0];
  const selectorStr = rest[1];
  if (file == null || selectorStr == null) {
    return err("issuemd read: missing <file> or <selector>\n", 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));

  const maxResults = readFlag(v, "max-results", 25);
  if ("code" in maxResults) return maxResults;
  const maxLines = readFlag(v, "max-lines", 0);
  if ("code" in maxLines) return maxLines;

  const selector = parseSelector(selectorStr);
  const matches = match(sections, selector);

  // Split source once and pass srcLines through to render. Previously
  // renderSection/sliceBody each re-split for every match, turning
  // `issuemd read file.md sel` into O(matches × file_size).
  const srcLines = src.split("\n");

  if (v.json) {
    return emitReadJson(
      file,
      srcLines,
      sections,
      matches,
      maxResults.value ?? 25,
      maxLines.value ?? 0,
      v,
    );
  }

  if (matches.length === 0) return noMatch("(no match)\n");

  const cap = maxResults.value ?? 25;
  const toPrint = matches.slice(0, cap);
  const out: string[] = [];
  if (matches.length > cap) {
    out.push(
      `${matches.length} matches, showing first ${cap}. Use --max-results=N to raise the cap.`,
    );
  }
  for (const sec of toPrint) {
    out.push(
      renderSection(file, srcLines, sec, {
        bodyOnly: !!v["body-only"],
        noBody: !!v["no-body"],
        raw: !!v.raw,
        maxLines: maxLines.value ?? 0,
        allSections: sections,
      }),
    );
  }
  return ok(out.join("\n"));
}

function emitReadJson(
  file: string,
  srcLines: string[],
  all: Section[],
  matches: Section[],
  maxResults: number,
  maxLines: number,
  v: Values,
): CliResult {
  const body = JSON.stringify(
    {
      file,
      matches: matches.slice(0, maxResults).map((s) => ({
        ...sectionToJSON(s),
        body: v["no-body"]
          ? ""
          : maybeTruncate(sliceBody(srcLines, s, all, !!v["body-only"]), maxLines),
      })),
      truncated: matches.length > maxResults,
    },
    null,
    2,
  );
  // JSON path keeps exit 0 regardless — the shape itself signals no matches.
  return matches.length === 0 ? { code: 1, stdout: body, stderr: "" } : ok(body);
}

function cmdLs(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const selectorStr = rest[1];
  if (file == null || selectorStr == null) {
    return err("issuemd ls: missing <file> or <selector>\n", 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));

  const maxResults = readFlag(v, "max-results", 25);
  if ("code" in maxResults) return maxResults;
  const cap = maxResults.value ?? 25;

  const selector = parseSelector(selectorStr);
  const matches = match(sections, selector).slice(0, cap);

  // Index children by parent once so we don't repeat an O(n) filter per
  // match — inexpensive in practice but easy to do right.
  const childrenOf = new Map<Section, Section[]>();
  for (const sec of sections) {
    if (sec.parent) {
      const list = childrenOf.get(sec.parent);
      if (list) list.push(sec);
      else childrenOf.set(sec.parent, [sec]);
    }
  }

  if (v.json) {
    const results = matches.map((parent) => ({
      parent: sectionToJSON(parent),
      children: (childrenOf.get(parent) ?? []).map(sectionToJSON),
    }));
    const body = JSON.stringify({ file, results }, null, 2);
    return matches.length === 0 ? { code: 1, stdout: body, stderr: "" } : ok(body);
  }

  if (matches.length === 0) return noMatch("(no match)\n");

  const out: string[] = [];
  for (const parent of matches) {
    const children = childrenOf.get(parent) ?? [];
    out.push(
      `${"#".repeat(parent.level)} ${parent.title}  L${parent.line_start}-${parent.line_end}`,
    );
    if (children.length === 0) {
      out.push("  (no children)");
    } else {
      for (const c of children) {
        out.push(
          `  ${"#".repeat(c.level)} ${c.title}  L${c.line_start}-${c.line_end}`,
        );
      }
    }
  }
  return ok(out.join("\n"));
}

function cmdGrep(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const pattern = rest[1];
  if (file == null || pattern == null) {
    return err("issuemd grep: missing <file> or <pattern>\n", 2);
  }
  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return err(`issuemd grep: invalid regex: ${(e as Error).message}\n`, 2);
  }

  const srcLines = src.split("\n");
  type Hit = { section: Section | null; line: number; text: string };
  const hits: Hit[] = [];

  // Walk all lines once and attribute each match to the innermost enclosing
  // section. Sections are in document order, so a monotonic cursor is enough.
  // Matches before the first heading get `section: null`.
  let secIdx = -1;
  for (let lineNo = 1; lineNo <= srcLines.length; lineNo++) {
    while (
      secIdx + 1 < sections.length &&
      sections[secIdx + 1]!.line_start <= lineNo
    ) {
      secIdx++;
    }
    const line = srcLines[lineNo - 1]!;
    if (re.test(line)) {
      const section = secIdx >= 0 ? sections[secIdx] ?? null : null;
      hits.push({ section, line: lineNo, text: line });
    }
  }

  if (v.json) {
    const body = JSON.stringify(
      hits.map((h) => ({
        file,
        line: h.line,
        text: h.text,
        section: h.section ? sectionToJSON(h.section) : null,
      })),
      null,
      2,
    );
    return hits.length === 0 ? { code: 1, stdout: body, stderr: "" } : ok(body);
  }

  if (hits.length === 0) return noMatch("(no match)\n");

  // Group consecutive hits by section for readable output.
  const out: string[] = [];
  let lastSection: Section | null | undefined = undefined;
  for (const hit of hits) {
    if (hit.section !== lastSection) {
      if (hit.section) {
        const path = pathOf(hit.section).concat(hit.section.title).join(" > ");
        out.push(
          `── ${path}  L${hit.section.line_start}-${hit.section.line_end}`,
        );
      } else {
        out.push(`── ${file}  (no enclosing heading)`);
      }
      lastSection = hit.section;
    }
    out.push(`  L${hit.line}:  ${hit.text}`);
  }
  return ok(out.join("\n"));
}

// ---- links ------------------------------------------------------------------

function cmdLinks(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const selectorStr = rest[1]; // optional
  if (file == null) return err("issuemd links: missing <file>\n", 2);

  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  // Extract all inline markdown links [text](url), attributed to sections.
  const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
  type Hit = { section: Section | null; line: number; text: string; url: string };
  const hits: Hit[] = [];

  let secIdx = -1;
  for (let lineNo = 1; lineNo <= srcLines.length; lineNo++) {
    while (secIdx + 1 < sections.length && sections[secIdx + 1]!.line_start <= lineNo) secIdx++;
    const sec = secIdx >= 0 ? sections[secIdx] ?? null : null;
    const line = srcLines[lineNo - 1]!;
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(line)) !== null) {
      hits.push({ section: sec, line: lineNo, text: m[1]!, url: m[2]! });
    }
  }

  // Filter by selector if provided.
  let filtered = hits;
  if (selectorStr) {
    const selector = parseSelector(selectorStr);
    const matched = match(sections, selector);
    if (matched.length === 0) return noMatch("(no match)\n");
    filtered = hits.filter((h) =>
      matched.some((s) => h.line >= s.line_start && h.line <= s.line_end),
    );
  }

  if (filtered.length === 0) return noMatch("(no match)\n");

  if (v.json) {
    return ok(
      JSON.stringify(
        filtered.map((h) => ({
          file,
          line: h.line,
          text: h.text,
          url: h.url,
          section: h.section ? sectionToJSON(h.section) : null,
        })),
        null,
        2,
      ),
    );
  }

  const out: string[] = [];
  let lastSec: Section | null | undefined = undefined;
  for (const hit of filtered) {
    if (hit.section !== lastSec) {
      if (hit.section) {
        const path = pathOf(hit.section).concat(hit.section.title).join(" > ");
        out.push(`── ${path}  L${hit.section.line_start}-${hit.section.line_end} ${"─".repeat(8)}`);
      } else {
        out.push(`── ${file}  (no enclosing heading)`);
      }
      lastSec = hit.section;
    }
    out.push(`  ${hit.text} → ${hit.url}`);
  }
  return ok(out.join("\n"));
}

// ---- code -------------------------------------------------------------------

type CodeBlock = {
  section: Section | null;
  line_start: number;
  line_end: number;
  lang: string;
  body: string;
};

function extractCodeBlocks(srcLines: string[], sections: Section[]): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let inFence = false;
  let fenceChar = 0;
  let fenceMinLen = 0;
  let fenceLang = "";
  let fenceStart = 0;
  let bodyLines: string[] = [];
  let fenceSection: Section | null = null;
  let secIdx = -1;

  for (let lineNo = 1; lineNo <= srcLines.length; lineNo++) {
    while (secIdx + 1 < sections.length && sections[secIdx + 1]!.line_start <= lineNo) secIdx++;
    const sec = secIdx >= 0 ? sections[secIdx] ?? null : null;
    const line = srcLines[lineNo - 1]!;

    if (!inFence) {
      const m = line.match(/^( {0,3})(```+|~~~+)(.*)/);
      if (m) {
        inFence = true;
        fenceChar = m[2]!.charCodeAt(0);
        fenceMinLen = m[2]!.length;
        fenceLang = (m[3]!.trim().split(/\s/)[0] ?? "");
        fenceStart = lineNo;
        bodyLines = [];
        fenceSection = sec;
      }
    } else {
      const m = line.match(/^( {0,3})(```+|~~~+)\s*$/);
      if (m && m[2]!.charCodeAt(0) === fenceChar && m[2]!.length >= fenceMinLen) {
        blocks.push({ section: fenceSection, line_start: fenceStart, line_end: lineNo, lang: fenceLang, body: bodyLines.join("\n") });
        inFence = false;
      } else {
        bodyLines.push(line);
      }
    }
  }

  return blocks;
}

function cmdCode(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const selectorStr = rest[1]; // optional
  if (file == null) return err("issuemd code: missing <file>\n", 2);

  const loaded = loadFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  let blocks = extractCodeBlocks(srcLines, sections);

  // Filter by selector.
  if (selectorStr) {
    const selector = parseSelector(selectorStr);
    const matched = match(sections, selector);
    if (matched.length === 0) return noMatch("(no match)\n");
    blocks = blocks.filter((b) =>
      matched.some((s) => b.line_start >= s.line_start && b.line_end <= s.line_end),
    );
  }

  // Filter by --lang.
  if (v.lang) {
    blocks = blocks.filter((b) => b.lang === v.lang);
  }

  if (blocks.length === 0) return noMatch("(no match)\n");

  if (v.json) {
    return ok(
      JSON.stringify(
        blocks.map((b) => ({
          file,
          line_start: b.line_start,
          line_end: b.line_end,
          lang: b.lang,
          body: b.body,
          section: b.section ? sectionToJSON(b.section) : null,
        })),
        null,
        2,
      ),
    );
  }

  const out: string[] = [];
  let lastSec: Section | null | undefined = undefined;
  for (const b of blocks) {
    if (b.section !== lastSec) {
      if (b.section) {
        const path = pathOf(b.section).concat(b.section.title).join(" > ");
        out.push(`── ${path}  L${b.section.line_start}-${b.section.line_end} ${"─".repeat(8)}`);
      } else {
        out.push(`── ${file}  (no enclosing heading)`);
      }
      lastSec = b.section;
    }
    const fence = b.lang ? `\`\`\`${b.lang}` : "```";
    out.push(fence);
    out.push(b.body);
    out.push("```");
  }
  return ok(out.join("\n"));
}

// ---- shared write helpers ---------------------------------------------------

/**
 * Apply a mutation: if --dry-run, print a unified diff; otherwise write the
 * new content back to `file`. Returns a CliResult.
 */
/** loadFile variant that rejects stdin ('-') for commands that write back. */
function loadWritableFile(file: string): { src: string } | CliResult {
  if (file === "-") return err("issuemd: write commands do not support stdin ('-')\n", 2);
  return loadFile(file);
}

function applyWrite(
  file: string,
  oldLines: string[],
  newLines: string[],
  v: Values,
): CliResult {
  if (v["dry-run"]) {
    const diff = unifiedDiff(oldLines, newLines, file);
    return ok(diff || "(no changes)\n");
  }
  writeFileSync(file, newLines.join("\n"));
  return ok("");
}

/**
 * Resolve body content for write commands.
 * Prefers --body flag; falls back to stdin when explicitly redirected (not a TTY
 * and not already consumed). In interactive use, --body is required.
 */
function requireBody(v: Values, cmd: string): { lines: string[] } | CliResult {
  if (v.body != null) return { lines: v.body.split("\n") };
  // Stdin redirect: only read when we're confident the caller piped content.
  // process.stdin.isTTY is undefined (not false) in bun's test runner, so the
  // explicit `=== false` check avoids accidentally consuming stdin in tests.
  if (process.stdin.isTTY === false) {
    const src = readFileSync(0, "utf8");
    return { lines: src.split("\n") };
  }
  return err(`issuemd ${cmd}: --body <text> is required (or pipe content via stdin)\n`, 2);
}

// ---- write commands ---------------------------------------------------------

function cmdSet(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const selectorStr = rest[1];
  if (file == null || selectorStr == null) return err("issuemd set: missing <file> or <selector>\n", 2);

  const bodyResult = requireBody(v, "set");
  if ("code" in bodyResult) return bodyResult;

  const loaded = loadWritableFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  const matches = match(sections, parseSelector(selectorStr));
  if (matches.length === 0) return noMatch("(no match)\n");

  const newLines = setSection(srcLines, matches[0]!, sections, bodyResult.lines);
  return applyWrite(file, srcLines, newLines, v);
}

function cmdAppend(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const selectorStr = rest[1];
  if (file == null || selectorStr == null) return err("issuemd append: missing <file> or <selector>\n", 2);

  const bodyResult = requireBody(v, "append");
  if ("code" in bodyResult) return bodyResult;

  const loaded = loadWritableFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  const matches = match(sections, parseSelector(selectorStr));
  if (matches.length === 0) return noMatch("(no match)\n");

  const newLines = appendToSection(srcLines, matches[0]!, sections, bodyResult.lines);
  return applyWrite(file, srcLines, newLines, v);
}

function cmdInsert(rest: string[], v: Values): CliResult {
  const file = rest[0];
  if (file == null) return err("issuemd insert: missing <file>\n", 2);
  if (v.after == null) return err("issuemd insert: --after <selector> is required\n", 2);

  const bodyResult = requireBody(v, "insert");
  if ("code" in bodyResult) return bodyResult;

  const loaded = loadWritableFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  const matches = match(sections, parseSelector(v.after));
  if (matches.length === 0) return noMatch("(no match)\n");

  const newLines = insertAfter(srcLines, matches[0]!, bodyResult.lines);
  return applyWrite(file, srcLines, newLines, v);
}

function cmdRm(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const selectorStr = rest[1];
  if (file == null || selectorStr == null) return err("issuemd rm: missing <file> or <selector>\n", 2);

  const loaded = loadWritableFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  const matches = match(sections, parseSelector(selectorStr));
  if (matches.length === 0) return noMatch("(no match)\n");

  const newLines = removeSection(srcLines, matches[0]!);
  return applyWrite(file, srcLines, newLines, v);
}

function cmdRename(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const selectorStr = rest[1];
  const newTitle = rest[2];
  if (file == null || selectorStr == null) return err("issuemd rename: missing <file> or <selector>\n", 2);
  if (newTitle == null) return err("issuemd rename: missing new name\n", 2);

  const loaded = loadWritableFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  const matches = match(sections, parseSelector(selectorStr));
  if (matches.length === 0) return noMatch("(no match)\n");

  const newLines = renameSection(srcLines, matches[0]!, newTitle);
  return applyWrite(file, srcLines, newLines, v);
}

function cmdPromote(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const selectorStr = rest[1];
  if (file == null || selectorStr == null) return err("issuemd promote: missing <file> or <selector>\n", 2);

  const loaded = loadWritableFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  const matches = match(sections, parseSelector(selectorStr));
  if (matches.length === 0) return noMatch("(no match)\n");

  const newLines = shiftLevel(srcLines, matches[0]!, -1);
  return applyWrite(file, srcLines, newLines, v);
}

function cmdDemote(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const selectorStr = rest[1];
  if (file == null || selectorStr == null) return err("issuemd demote: missing <file> or <selector>\n", 2);

  const loaded = loadWritableFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  const matches = match(sections, parseSelector(selectorStr));
  if (matches.length === 0) return noMatch("(no match)\n");

  const newLines = shiftLevel(srcLines, matches[0]!, +1);
  return applyWrite(file, srcLines, newLines, v);
}

function cmdMv(rest: string[], v: Values): CliResult {
  const file = rest[0];
  const fromStr = rest[1];
  const toStr = rest[2];
  if (file == null || fromStr == null) return err("issuemd mv: missing <file> or <from>\n", 2);
  if (toStr == null) return err("issuemd mv: missing destination <to>\n", 2);

  const loaded = loadWritableFile(file);
  if ("code" in loaded) return loaded;
  const { src } = loaded;
  const sections = buildSections(scan(src), countLines(src));
  const srcLines = src.split("\n");

  const fromMatches = match(sections, parseSelector(fromStr));
  if (fromMatches.length === 0) return noMatch("(no match)\n");

  const toMatches = match(sections, parseSelector(toStr));
  if (toMatches.length === 0) return noMatch("(no match for destination)\n");

  const fromSec = fromMatches[0]!;
  const toSec = toMatches[0]!;

  // Guard against circular moves (toSec is a descendant of fromSec).
  let cur: Section | null = toSec;
  while (cur) {
    if (cur === fromSec) return err("issuemd mv: cannot move a section into its own descendant\n", 2);
    cur = cur.parent;
  }

  const newLines = moveSection(srcLines, fromSec, toSec);
  return applyWrite(file, srcLines, newLines, v);
}

// ---- shared helpers ----------------------------------------------------

function sliceBody(
  srcLines: string[],
  sec: Section,
  all: Section[],
  bodyOnly: boolean,
): string {
  let end = sec.line_end;
  if (bodyOnly) {
    const firstChild = all.find((s) => s.parent === sec);
    if (firstChild) end = firstChild.line_start - 1;
  }
  return srcLines.slice(sec.line_start - 1, end).join("\n");
}

function maybeTruncate(body: string, maxLines: number): string {
  return maxLines > 0 ? truncateBody(body, maxLines) : body;
}

function sectionToJSON(sec: Section): Record<string, unknown> {
  return {
    level: sec.level,
    title: sec.title,
    line_start: sec.line_start,
    line_end: sec.line_end,
    path: pathOf(sec),
  };
}

// Entry point lives in bin/issuemd.ts; this module only exports `run`.
