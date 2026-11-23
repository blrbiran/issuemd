import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const bin = fileURLToPath(new URL(`../${manifest.bin.issuemd}`, import.meta.url));
const cwd = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixture = "canonical-clean.md";

function run(...args: string[]) {
  return spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" });
}

test("help advertises only ledger commands", () => {
  const result = run("--help");
  expect(result.status).toBe(0);
  for (const command of ["issuemd check", "issuemd list", "issuemd show", "issuemd counts", "issuemd read", "issuemd new", "issuemd close", "issuemd sync"]) {
    expect(result.stdout).toContain(command);
  }
  expect(result.stdout).not.toContain("issuemd toc");
  expect(result.stdout).not.toContain("selector");
  expect(result.stdout).not.toMatch(/--pretty|issuemd retrieve|issuemd index/);
});

test("a bare file path is a usage error pointing at list", () => {
  const result = run(fixture);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("issuemd list FILE");
});

test("list works from another cwd with a relative path", () => {
  const result = run("list", fixture);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("侧栏宽度不可调");
});

test("no arguments is a usage error, not a help dump", () => {
  const result = run();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("missing command");
});

test("check still accepts a document on stdin", () => {
  const result = spawnSync("node", [bin, "check", "-", "--json"], {
    cwd,
    input: readFileSync(new URL(`../fixtures/${fixture}`, import.meta.url), "utf8"),
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).ok).toBe(true);
});

test("a consumer can close stdout after the first chunk of a large read", async () => {
  const child = spawn("node", [bin, "show", "-", "1"], { cwd });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.once("data", () => child.stdout.destroy());
  child.stdin.end(readFileSync(new URL(`../fixtures/${fixture}`, import.meta.url)));
  expect(await closed).toEqual([0, null]);
  expect(stderr).toBe("");
});

test("npm package includes the CLI and keeps the draft ledger skill out", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const [pack] = JSON.parse(result.stdout);
  const paths = pack.files.map(({ path }: { path: string }) => path);
  expect(paths).toContain(manifest.bin.issuemd);
  expect(paths).not.toContain("skills/issuemd/SKILL.md");
});

test("the omitted pretty formatter is reported as an unknown option", () => {
  const result = run("list", fixture, "--pretty");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--pretty");
});