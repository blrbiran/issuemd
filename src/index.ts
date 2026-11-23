/**
 * Library entry for programmatic use.
 *
 * The CLI composes these pieces in src/cli.ts; importing from here lets other
 * tools parse a ledger or scan headings without spawning the binary.
 */

export { scan, type Heading } from "./scan.js";
export { buildSections, countLines, pathOf, type Section } from "./sections.js";
export {
  bodyBlocks,
  isLedger,
  maxIssueId,
  parseLedger,
  type BodyBlock,
  type Diagnostic,
  type LedgerRow,
  type TableKind,
} from "./ledger.js";
export { checkLedger, STATUS_CLASSES } from "./ledger-check.js";
export {
  IdSet,
  compareIds,
  idText,
  parseId,
  parseIds,
  type IdSpan,
} from "./issue-id.js";
export {
  findRow,
  formatIssueRow,
  spanText,
  summaryLine,
  viewIssue,
  type IssueView,
  type ListedIssue,
} from "./ledger-read.js";
export { joinDocument, readDocument, writeAtomically, type Document } from "./io.js";