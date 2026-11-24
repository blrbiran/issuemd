import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkLedger } from "../src/ledger-check.js";
import { bodyBlocks, parseLedger } from "../src/ledger.js";

/**
 * Scale guard for spec §14 Q4 (">10k lines: parse time untested"). This is a
 * ceiling, not a benchmark: it exists to catch accidental quadratic behaviour
 * (e.g. re-scanning the whole document per row), not to track microseconds.
 * Measured on a 2021-class laptop: ~44 ms parse / ~79 ms check for 10k
 * issues (~35k lines), and ~155 ms / ~270 ms at 40k issues (120k lines) — no
 * quadratic blow-up.
 */

function ledgerWith(issues: number): string {
  const open: string[] = [];
  const closed: string[] = [];
  const bodies: string[] = [];
  for (let id = 1; id <= issues; id++) {
    if (id % 2 === 0) {
      closed.push(`| ${id} | 已修 | P2 | 摘要 ${id} | 判据 ${id} |`);
      continue;
    }
    open.push(`| ${id} | 未决 | P2 | 摘要 ${id} |`);
    bodies.push(`### Issue ${id}: 摘要 ${id}\n\n**现象**：现象 ${id}。\n**验收判据**：判据 ${id}。\n`);
  }
  // Reuse the canonical header verbatim so the status table matches the
  // canonical one (E112), then append generated tables and bodies.
  const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
  const header = canonical.slice(0, canonical.indexOf("## 索引"));
  return [
    header,
    "## 索引",
    "",
    "| # | 状态 | P | 摘要 |",
    "|---|---|---|---|",
    ...open,
    "",
    "## 已关闭",
    "",
    "| # | 状态 | P | 摘要 | 判据 |",
    "|---|---|---|---|---|",
    ...closed,
    "",
    "## 正文",
    "",
    ...bodies,
    "",
    "## 附录",
  ].join("\n");
}

test("a 10k-issue / 35k-line ledger parses and checks within a sane budget", () => {
  const src = ledgerWith(10_000);
  expect(src.split("\n").length).toBeGreaterThan(30_000);

  const parseStart = performance.now();
  const ledger = parseLedger(src);
  bodyBlocks(ledger);
  const parseMs = performance.now() - parseStart;

  const checkStart = performance.now();
  const report = checkLedger(src, "big.md");
  const checkMs = performance.now() - checkStart;

  expect(report.errors).toEqual([]);
  expect(ledger.rows.open.length + ledger.rows.closed.length).toBe(10_000);
  // Generous on purpose: the assertion is "linear-ish", not "fast on this box".
  expect(parseMs).toBeLessThan(2_000);
  expect(checkMs).toBeLessThan(4_000);
});