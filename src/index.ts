/**
 * Library entry for programmatic use.
 *
 * The CLI composes these pieces in src/cli.ts; importing from here lets
 * other tools build TOCs, section trees, or selectors without spawning
 * the binary.
 */

export { scan, type Heading } from "./scan.js";
export { buildSections, countLines, pathOf, type Section } from "./sections.js";
export {
  parseSelector,
  match,
  type Segment,
  type Op,
  type Kind,
} from "./select.js";
export {
  renderToc,
  renderSection,
  truncateBody,
  type TocOptions,
  type SectionOptions,
} from "./render.js";
