import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.js";

const dir = mkdtempSync(join(tmpdir(), "issuemd-cross-ledger-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const canonical = readFileSync(new URL("../fixtures/canonical-clean.md", import.meta.url), "utf8");
let sequence = 0;
function fixture(content: string): string {
  const path = join(dir, `${++sequence}.md`);
  writeFileSync(path, content);
  return path;
}
function highLedger(): string {
  return fixture(canonical.replace("## 正文", "| 557 | 已修 | P2 | old issue | works |\n\n## 正文"));
}

test("external ledger references do not warn or reserve ids, but remain searchable references", async () => {
  const path = highLedger();
  const body = fixture("**现象**：见 Orca 台账 #558、cafe 台账 #999 与 ledger #9999。\n\n**验收判据**：works\n");
  expect((await run(["body", path, "2", "--body-file", body])).code).toBe(0);
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.warnings.filter((warning: { code: string }) => warning.code === "W271")).toEqual([]);
  const found = JSON.parse((await run(["find", path, "#558", "--json"])).stdout);
  expect(found.matches).toContainEqual(expect.objectContaining({ id: "2", where: "reference" }));
  const created = await run(["new", path, "--title", "next issue"]);
  expect(created.code).toBe(0);
  expect(created.stdout.trim()).toBe("558");

  const explicitLedger = highLedger();
  const explicitBody = fixture("**现象**：见 Orca 台账 #558。\n\n**验收判据**：works\n");
  expect((await run(["body", explicitLedger, "2", "--body-file", explicitBody])).code).toBe(0);
  const explicit = await run(["new", explicitLedger, "--id", "558", "--title", "explicit external id"]);
  expect(explicit.code).toBe(0);
});

test("this ledger references remain local as well", async () => {
  const path = highLedger();
  const body = fixture("**现象**：this ledger #558 already uses this ID.\n\n**验收判据**：works\n");
  expect((await run(["body", path, "2", "--body-file", body])).code).toBe(0);
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W271", id: "558" }));
  const created = await run(["new", path, "--title", "next issue"]);
  expect(created.stdout.trim()).toBe("559");
});

test("a later local clause ends the external scope", async () => {
  const path = highLedger();
  const body = fixture("**现象**：见 Orca 台账 #558；另见 #21。\n\n**验收判据**：works\n");
  expect((await run(["body", path, "2", "--body-file", body])).code).toBe(0);
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.warnings).not.toContainEqual(expect.objectContaining({ code: "W271", id: "558" }));
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W271", id: "21" }));
  const created = await run(["new", path, "--title", "next issue"]);
  expect(created.stdout.trim()).toBe("558");
});

test("a later self-ledger context overrides an external file mention on the same line", async () => {
  const path = highLedger();
  const body = fixture("**现象**：Orca/orca_dogfooding/issue-20261023.md includes #558; 本台账 #558 is separate.\n\n**验收判据**：works\n");
  expect((await run(["body", path, "2", "--body-file", body])).code).toBe(0);
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W271", id: "558" }));
});

 test("self-ledger references remain warnings and reserve their ids", async () => {
  const path = highLedger();
  const body = fixture("**现象**：本台账 #558 记录了先前的事项。\n\n**验收判据**：works\n");
  expect((await run(["body", path, "2", "--body-file", body])).code).toBe(0);
  const checked = JSON.parse((await run(["check", path, "--json"])).stdout);
  expect(checked.warnings).toContainEqual(expect.objectContaining({ code: "W271", id: "558" }));
  const created = await run(["new", path, "--title", "next issue"]);
  expect(created.code).toBe(0);
  expect(created.stdout.trim()).toBe("559");
  const explicit = await run(["new", path, "--id", "558", "--title", "reused reference"]);
  expect(explicit.code).toBe(2);
});

