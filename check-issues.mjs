#!/usr/bin/env node
// Consistency check for the single-file issue ledger (issue-20261023.md).
//   node check-issues.mjs        -> exit 0 when consistent, 1 with a list of problems
// Rules enforced:
//   1. every `### Issue <n>:` block under `## 正文` has exactly one row in `## 待处理`
//   2. every `## 待处理` row has a body block
//   3. body blocks are unique and in ascending id order
//   4. `## 正文` contains no `**状态**` line (status lives only in the tables)
//   5. no id appears twice across the index tables
import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('issue-20261023.md', import.meta.url), 'utf8');
const problems = [];
const ids = (re, s) => [...s.matchAll(re)].map((m) => Number(m[1]));
// match a heading line exactly (a bare indexOf also hits inline `## x` mentions in the how-to table)
const section = (start) => {
  const head = text.match(new RegExp(`^${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm'));
  if (!head) throw new Error(`missing section: ${start}`);
  const rest = text.slice(head.index + head[0].length);
  const next = rest.match(/^## /m);
  return rest.slice(0, next ? next.index : undefined);
};

// 1/2. pending rows vs body blocks
const pending = ids(/^\| (\d+) \|/gm, section('## 待处理'));
const body = ids(/^### Issue (\d+): /gm, section('## 正文'));
const pendingSet = new Set(pending);
const bodySet = new Set(body);
if (pending.length !== pendingSet.size) problems.push(`待处理: duplicate ids (${pending.length} rows, ${pendingSet.size} unique)`);
for (const n of bodySet) if (!pendingSet.has(n)) problems.push(`正文: #${n} has a block but is not in 待处理 (closed? delete the block)`);
for (const n of pendingSet) if (!bodySet.has(n)) problems.push(`正文: #${n} is in 待处理 but has no block`);
if (body.some((n, i) => i > 0 && n <= body[i - 1])) problems.push('正文: blocks are not in ascending id order');

// 2b. body heading text should equal the pending row's summary (so the lilmd TOC reads like the table)
const summary = new Map();
for (const m of section('## 待处理').matchAll(/^\| (\d+) \| (.+?) \|/gm)) summary.set(Number(m[1]), m[2].trim());
for (const m of section('## 正文').matchAll(/^### Issue (\d+): (.+)$/gm)) {
  const n = Number(m[1]), title = m[2].trim(), want = summary.get(n);
  if (want !== undefined && title !== want) problems.push(`正文: #${n} heading "${title}" != summary "${want}"`);
}

// 3. status must not be duplicated in the body
if (/^\*\*状态\*\*/m.test(section('## 正文'))) problems.push('正文: contains a **状态** line; status belongs only in the tables');

// 4. an id may appear in only one index row (待处理 + 已关闭), and nowhere else in a table
const index = section('## 待处理') + section('## 已关闭');
const seen = new Set();
for (const m of index.matchAll(/^\| ([\d,\s]+) \|/gm))
  for (const n of (m[1].match(/\d+/g) ?? []).map(Number)) {
    if (seen.has(n)) problems.push(`index: #${n} appears in more than one row`);
    seen.add(n);
  }
for (const n of bodySet) if (!seen.has(n)) problems.push(`index: #${n} missing from the tables`);

if (problems.length === 0) {
  console.log(`ok: ${pendingSet.size} open issues, ${bodySet.size} body blocks, ${seen.size} indexed ids`);
  process.exit(0);
}
console.error(problems.map((p) => `- ${p}`).join('\n'));
process.exit(1);
