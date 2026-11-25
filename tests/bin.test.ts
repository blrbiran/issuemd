import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { built } from "./built.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// The manifest's bin lives under dist/; the tests run the same file from the
// test build so they never touch the dist/ a global install is using (#21).
const binRel = (manifest.bin.issuemd as string).replace(/^dist\//, "");
const bin = built(binRel);
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
  expect(paths).toContain("skills/issuemd/SKILL.md");
  expect(paths).toContain("TEMPLATE.md");
  expect(paths).toContain("THIRD_PARTY_NOTICES.md");
  // dist/ itself is built by prepack at publish time, so check that the
  // manifest ships it and that a build has the bin and none of the deleted
  // generic Markdown modules (the build swaps in a fresh directory).
  expect(manifest.files).toContain("dist");
  expect(manifest.bin.issuemd).toStartWith("dist/");
  expect(existsSync(bin)).toBe(true);
  expect(existsSync(built("src/render.js"))).toBe(false);
  expect(existsSync(built("src/select.js"))).toBe(false);
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
  const entry = manifest.exports["."];
  expect(entry.import).toBe("./dist/src/index.js");
  expect(entry.types).toBe("./dist/src/index.d.ts");
  const api = await import(pathToFileURL(built("src/index.js")).href);
  expect(typeof api.checkLedger).toBe("function");
  expect(typeof api.parseLedger).toBe("function");
  expect(typeof api.writeAtomically).toBe("function");
  expect(existsSync(built("src/index.d.ts"))).toBe(true);
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

test("a concurrent change is exit 4 (E130, retryable), distinct from usage errors (#18)", async () => {
  const { mkdtempSync, writeFileSync, appendFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const work = mkdtempSync(join(tmpdir(), "issuemd-race-"));
  try {
    const ledger = join(work, "l.md");
    writeFileSync(ledger, readFileSync(new URL("../TEMPLATE.md", import.meta.url)));
    const fifo = join(work, "body.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    // `new` reads the ledger first, then blocks opening the FIFO body.
    const child = spawn("node", [bin, "new", ledger, "--title", "A", "--body-file", fifo]);
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const closed = once(child, "close");
    // Opening the FIFO for writing blocks until the child opens it to read,
    // which it only does after loading the ledger: no sleep, no race.
    const { open } = await import("node:fs/promises");
    const writer = await open(fifo, "w");
    appendFileSync(ledger, "\n另一个 agent 的改动\n");
    await writer.write("**现象**：a\n");
    await writer.close(); // EOF unblocks the child
    const [code] = await closed;
    expect(code).toBe(4);
    expect(stderr).toContain("E130");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("build --out only accepts dist-like directory names, never a source directory", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // Run a copy of the script in a scratch root: if validation regressed, the
  // damage lands there, not in this checkout.
  const work = mkdtempSync(join(tmpdir(), "issuemd-build-"));
  try {
    mkdirSync(join(work, "scripts"));
    mkdirSync(join(work, "src"));
    copyFileSync(fileURLToPath(new URL("../scripts/build.mjs", import.meta.url)), join(work, "scripts", "build.mjs"));
    writeFileSync(join(work, "src", "keep.ts"), "export {};\n");
    for (const out of ["src", "bin", "tests", "scripts", ".", "..", "-x", "a/b", ""]) {
      const result = spawnSync("node", [join(work, "scripts", "build.mjs"), "--out", out], { cwd: work, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--out");
      expect(existsSync(join(work, "src", "keep.ts"))).toBe(true);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("parallel writers: every exit-0 write is in the file; the rest exit 4", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const work = mkdtempSync(join(tmpdir(), "issuemd-parallel-"));
  const exec = (args: string[]) => new Promise<number>((resolve) => {
    const child = spawn("node", [bin, ...args], { stdio: "ignore" });
    child.on("close", (code) => resolve(code ?? -1));
  });
  try {
    const ledger = join(work, "l.md");
    let lost = 0;
    let applied = 0;
    for (let trial = 0; trial < 12; trial++) {
      writeFileSync(ledger, readFileSync(new URL("../TEMPLATE.md", import.meta.url)));
      for (const title of ["a", "b", "c", "d", "e", "f"]) {
        expect(spawnSync("node", [bin, "new", ledger, "--title", title]).status).toBe(0);
      }
      const ids = ["1", "2", "3", "4", "5", "6"];
      const codes = await Promise.all(ids.map((id) => exec(["priority", ledger, id, "P0"])));
      const text = readFileSync(ledger, "utf8");
      codes.forEach((code, at) => {
        expect([0, 4]).toContain(code);
        if (code !== 0) return;
        applied++;
        if (!text.includes(`| ${ids[at]} | 未决 | P0 |`)) lost++;
      });
    }
    expect(applied).toBeGreaterThan(0);
    expect(lost).toBe(0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 60_000);

test("a write lock held by a live process makes a write exit 4; a dead holder's lock is cleared", async () => {
  const { mkdtempSync, writeFileSync, rmSync, existsSync: exists } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const work = mkdtempSync(join(tmpdir(), "issuemd-lock-"));
  try {
    const ledger = join(work, "l.md");
    writeFileSync(ledger, readFileSync(new URL("../TEMPLATE.md", import.meta.url)));
    const lock = join(work, ".l.md.issuemd-lock");
    writeFileSync(lock, `${process.pid}\n`);
    const before = readFileSync(ledger, "utf8");
    const held = spawnSync("node", [bin, "new", ledger, "--title", "x"], { encoding: "utf8" });
    expect(held.status).toBe(4);
    expect(held.stderr).toContain(".l.md.issuemd-lock");
    expect(readFileSync(ledger, "utf8")).toBe(before);
    // A pid that cannot be alive: the lock is stale and is taken over.
    writeFileSync(lock, "2147483646\n");
    const taken = spawnSync("node", [bin, "new", ledger, "--title", "x"], { encoding: "utf8" });
    expect(taken.status).toBe(0);
    expect(exists(lock)).toBe(false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30_000);

test("an unreadable lock path (a directory, a dangling link) gives exit 4 after the wait, not a spin", async () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const work = mkdtempSync(join(tmpdir(), "issuemd-lockdir-"));
  try {
    const ledger = join(work, "l.md");
    writeFileSync(ledger, readFileSync(new URL("../TEMPLATE.md", import.meta.url)));
    const { symlinkSync } = await import("node:fs");
    for (const make of [() => mkdirSync(join(work, ".l.md.issuemd-lock")), () => symlinkSync(join(work, "nowhere"), join(work, ".l.md.issuemd-lock"))]) {
      rmSync(join(work, ".l.md.issuemd-lock"), { recursive: true, force: true });
      make();
      const result = spawnSync("node", [bin, "new", ledger, "--title", "x"], { encoding: "utf8", timeout: 10_000 });
      expect(result.signal).toBeNull();
      expect(result.status).toBe(4);
      expect(result.stderr).toContain("issuemd-lock");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 20_000);
