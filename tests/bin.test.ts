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

test("help advertises the available Markdown commands", () => {
  const result = run("--help");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("issuemd toc");
  expect(result.stdout).toContain("--dry-run");
  expect(result.stdout).not.toMatch(/--pretty|issuemd retrieve|issuemd index/);
});

test("a relative Markdown path prints the TOC from outside the project root", () => {
  const result = run(fixture, "--depth", "1");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^canonical-clean\.md  L1-\d+  \d+ headings$/);
  expect(lines[1]).toMatch(/^# Demo Issue 台账  L1-\d+$/);
});

test("a chained selector prints a single JSON match", () => {
  const result = run(fixture, "=正文 >> /^Issue 2:/", "--json");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const doc = JSON.parse(result.stdout);
  expect(doc.matches).toHaveLength(1);
  expect(doc.matches[0]).toMatchObject({ level: 3, title: "Issue 2: 侧栏宽度不可调" });
  expect(doc.matches[0].body).toContain("重启后保持上次宽度");
});

test("TOC accepts a Markdown document from stdin", () => {
  const result = spawnSync("node", [bin, "-"], {
    cwd,
    encoding: "utf8",
    input: "# Guide\n\n## Example\ntext\n",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("-  L1-4  2 headings\n# Guide  L1-4\n  ## Example  L3-4\n");
});

test("dry-run emits a diff and preserves the file bytes", () => {
  const path = new URL(`../fixtures/${fixture}`, import.meta.url);
  const before = readFileSync(path);
  const result = run("rename", fixture, "=正文", "Issue details", "--dry-run");
  expect(result.status).toBe(0);
  expect(result.stdout.replaceAll("\r\n", "\n")).toContain("-## 正文\n+## Issue details");
  expect(readFileSync(path)).toEqual(before);
});

test("a consumer can close stdout after the first chunk of a large read", async () => {
  const child = spawn("node", [bin, "read", "-", "=Guide", "--raw"], { cwd });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.once("data", () => child.stdout.destroy());
  child.stdin.end(`# Guide\n\n${"long Markdown line\n".repeat(100_000)}`);
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
  const result = run("read", fixture, "=正文", "--pretty");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--pretty");
});
