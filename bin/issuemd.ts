#!/usr/bin/env node
import { run } from "../src/cli.js";

const result = await run(process.argv.slice(2));
if (result.stdout) {
  // Readers such as `head` may close the pipe before the entire result is written.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  process.stdout.write(
    result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n",
  );
}
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
