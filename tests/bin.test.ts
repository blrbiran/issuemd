import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
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

test("npm package ships the CLI, the ledger skill, and no removed modules", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const [pack] = JSON.parse(result.stdout);
  const paths = pack.files.map(({ path }: { path: string }) => path);
  expect(paths).toContain(manifest.bin.issuemd);
  expect(paths).toContain("skills/issuemd/SKILL.md");
  expect(paths).toContain("TEMPLATE.md");
  expect(paths).toContain("THIRD_PARTY_NOTICES.md");
  // Generic Markdown modules were deleted from src/; a stale dist/ must not
  // smuggle them back into the tarball.
  expect(paths).not.toContain("dist/src/render.js");
  expect(paths).not.toContain("dist/src/select.js");
});

test("the manifest carries the metadata npm needs to render the package page", () => {
  expect(manifest.repository?.url).toContain("blrbiran/issuemd");
  expect(manifest.homepage).toContain("github.com/blrbiran/issuemd");
  expect(manifest.bugs?.url).toContain("issues");
  expect(Array.isArray(manifest.keywords) && manifest.keywords.length > 0).toBe(true);
  expect(manifest.description.length).toBeGreaterThan(10);
  expect(manifest.publishConfig?.access).toBe("public");
});

test("the package resolves as a library entry, with type declarations", async () => {
  const api = await import("@blrbiran/issuemd");
  expect(typeof api.checkLedger).toBe("function");
  expect(typeof api.parseLedger).toBe("function");
  expect(typeof api.writeAtomically).toBe("function");
  const types = fileURLToPath(new URL("../dist/src/index.d.ts", import.meta.url));
  expect(existsSync(types)).toBe(true);
});

test("the omitted pretty formatter is reported as an unknown option", () => {
  const result = run("list", fixture, "--pretty");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--pretty");
});
test("the built bin is executable, so npm link keeps working after a rebuild (#20)", () => {
  expect(statSync(bin).mode & 0o111).toBe(0o111);
  // Executed directly, not through `node`: the shebang plus the mode bit.
  const result = spawnSync(bin, ["--help"], { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
});
