#!/usr/bin/env node
/**
 * Build into a staging directory, then swap it in for `dist/`.
 *
 * `dist/bin/issuemd.js` is the `bin` that `npm link` (and a global install)
 * points at, and other agents on the same machine may be running it while
 * someone runs `npm test`. The old build was `rm -rf dist && tsc`, which
 * (a) left a window with no CLI at all, (b) left no CLI if tsc failed, and
 * (c) dropped the executable bit, because tsc creates files 0644.
 *
 * Here tsc writes to `.dist-staging/`; with `noEmitOnError` a type error
 * leaves the current `dist/` untouched. On success the bin is made
 * executable and the two directories are swapped with renames, so `dist/`
 * is missing only between two rename(2) calls.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, ".dist-staging");
const dist = join(root, "dist");
const retired = join(root, `.dist-retired-${process.pid}`);

rmSync(staging, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "--outDir", staging], { cwd: root, stdio: "inherit" });
if (result.status !== 0) {
  rmSync(staging, { recursive: true, force: true });
  console.error("build: tsc failed; the existing dist/ was left untouched");
  process.exit(result.status ?? 1);
}

chmodSync(join(staging, "bin", "issuemd.js"), 0o755);
if (existsSync(dist)) renameSync(dist, retired);
renameSync(staging, dist);
rmSync(retired, { recursive: true, force: true });
