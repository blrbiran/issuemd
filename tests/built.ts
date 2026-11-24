/**
 * Where the tests find the compiled CLI and modules.
 *
 * `npm test` compiles into `.dist-test/`, never `dist/`: `dist/bin/issuemd.js`
 * is what `npm link` / a global install runs, and other agents on the same
 * machine use it while tests run. Building work-in-progress code into it
 * changed their CLI under them (dogfood #21). `dist/` is only written by
 * `npm run build` and `prepack`.
 */
import { fileURLToPath } from "node:url";

export const BUILD_DIR = process.env.ISSUEMD_BUILD_DIR ?? ".dist-test";

/** Absolute path of `rel` (e.g. `bin/issuemd.js`) inside the test build. */
export function built(rel: string): string {
  return fileURLToPath(new URL(`../${BUILD_DIR}/${rel}`, import.meta.url));
}
