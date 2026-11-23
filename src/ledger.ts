/**
 * Ledger recognition for the generic write commands.
 *
 * P1 does not model ledgers yet (P2 does). It only needs to know "this file is
 * a ledger" so that a generic `rm` cannot delete an issue's body while leaving
 * its index row behind — the drift `lilmd rm` produces on real ledgers.
 */

const LEDGER_SECTIONS = ["## 索引", "## 已关闭", "## 正文"];

export function isLedger(src: string): boolean {
  return LEDGER_SECTIONS.every((heading) => new RegExp(`^${heading}\\s*$`, "m").test(src));
}