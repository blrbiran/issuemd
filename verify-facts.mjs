// Verify the numbers quoted in SPEC.md against the two real ledgers.
// Usage: node verify-facts.mjs [cafe-issue.md] [orca-issue.md]
// Exit 1 if any assertion fails.
import {readFileSync} from 'node:fs';
const isSep=r=>/^\s*\|[\s:|-]+\|\s*$/.test(r);
const isRow=r=>/^\s*\|/.test(r);
const ID=/^\d+[a-z]?$/;
function parse(p){
  const L=readFileSync(p,'utf8').split('\n'); let h2='',h3=''; const rows=[]; const body=[]; const heads=[]; let inBody=false;
  for(let i=0;i<L.length;i++){const l=L[i];
    if(/^## /.test(l)){h2=l.slice(3).trim();h3='';heads.push({lv:2,t:h2,line:i+1});inBody=/^正文/.test(h2);continue;}
    if(/^### /.test(l)){h3=l.slice(4).trim();heads.push({lv:3,t:h3,line:i+1});const m=l.match(/^### Issue (\d+[a-z]?): (.*)$/);if(m&&inBody)body.push({id:m[1],t:m[2],line:i+1});continue;}
    if(isRow(l)&&!isSep(l)){const cells=l.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(s=>s.trim());const ids=cells[0].match(/\d+[a-z]?/g)||[];if(ids.length)rows.push({line:i+1,h2,h3,cells,ids,sep:false});}
  }
  // mark sep blocks
  let blk=null;
  for(let i=0;i<L.length;i++){if(isRow(L[i])){if(!blk){blk={sep:false};}if(isSep(L[i]))blk.sep=true;}else{blk=null;}}
  return {L,rows,body,heads};
}
const CAFE=process.argv[2]||'/Users/biran/code/skills/comm/cafe_dogfooding/issue-20261119.md';
const ORCA=process.argv[3]||'/Users/biran/code/skills/orca/orca_dogfooding/issue-20261023.md';
const cafe=parse(CAFE);
const orca=parse(ORCA);
const R=[];
const chk=(n,a,b)=>R.push([n,a,b,a===b?'OK':'MISMATCH']);
chk('cafe lines (wc -l)',cafe.L.length-(cafe.L[cafe.L.length-1]===''?1:0),2663);
chk('orca lines (wc -l)',orca.L.length-(orca.L[orca.L.length-1]===''?1:0),2107);
chk('cafe H2',cafe.heads.filter(h=>h.lv===2).length,5);
chk('orca H2',orca.heads.filter(h=>h.lv===2).length,5);
chk('cafe body',cafe.body.length,28);
chk('orca body',orca.body.length,16);
// blocks
function blocks(x){const L=x.L;let out=[],cur=null;for(let i=0;i<L.length;i++){if(isRow(L[i])){if(!cur){cur={sep:false,rows:0};out.push(cur);}cur.rows++;if(isSep(L[i]))cur.sep=true;}else cur=null;}return out;}
const cb=blocks(cafe), ob=blocks(orca);
chk('cafe blocks total',cb.length,43);
chk('cafe invalid blocks',cb.filter(b=>!b.sep).length,0);
chk('orca blocks total',ob.length,28);
chk('orca invalid blocks',ob.filter(b=>!b.sep).length,11);
chk('orca invalid rows',ob.filter(b=>!b.sep).reduce((a,b)=>a+b.rows,0),90);
// cafe index / closed
const ci=cafe.rows.filter(r=>/^状态总览$/.test(r.h2));
const cc=cafe.rows.filter(r=>/^已关闭/.test(r.h2));
chk('cafe index rows',ci.length,76);
chk('cafe closed rows',cc.length,48);
const ciClosed=new Set(ci.filter(r=>r.cells[1]==='已修').flatMap(r=>r.ids));
const ccIds=new Set(cc.flatMap(r=>r.ids));
chk('cafe index-closed == closed',[...ciClosed].sort().join()===[...ccIds].sort().join(),true);
// mismatches
const sum=new Map(); for(const r of ci) sum.set(r.cells[0],r.cells[3]);
chk('cafe E106 count',cafe.body.filter(b=>{const t=sum.get(b.id);return t===undefined||t.trim()!==b.t.trim();}).length,27);
const closedSum=new Map(); for(const r of cc) closedSum.set(r.cells[0],r.cells[2]);
chk('cafe closed-summary drift',[...ccIds].filter(id=>{const a=sum.get(id),b=closedSum.get(id);return a&&b&&a.trim()!==b.trim();}).length,47);
// W260 progress markers
const PROG=/已落地|仍缺|仍无|仍逐|仍走/;
chk('cafe W260 (progress in summary, not in body)',cafe.body.filter(b=>{const t=sum.get(b.id)||'';return PROG.test(t)&&!PROG.test(b.t);}).length,5);
// orca counts
const oi=orca.rows.filter(r=>/^待处理/.test(r.h2));
const oc=orca.rows.filter(r=>/^已关闭/.test(r.h2));
chk('orca index ids',new Set(oi.flatMap(r=>r.ids)).size,16);
chk('orca closed ids',new Set(oc.flatMap(r=>r.ids)).size,275);
chk('orca closed rows',oc.length,261);
chk('orca intersection',[...new Set(oc.flatMap(r=>r.ids))].filter(x=>new Set(oi.flatMap(r=>r.ids)).has(x)).length,0);
chk('orca 已修 ids',oc.filter(r=>/^已修/.test(r.h3)).reduce((a,r)=>a+r.ids.length,0),211);
chk('orca 已修 body mismatch',orca.body.filter(b=>{const r=oi.find(x=>x.cells[0]===b.id);return r&&r.cells[1].trim()!==b.t.trim();}).length,0);
// other declared counts
for(const [h,want] of [['owner 裁决不跟踪',23],['决定不改',7],['延后',6],['不是缺陷',7],['未分类',5],['范围外',3],['撤回',3],['并入',3]]){
  const got=oc.filter(r=>r.h3.startsWith(h)).reduce((a,r)=>a+r.ids.length,0);
  chk(`orca ${h}`,got,want);
}
// heading counts
chk('cafe headings with (N) count',cafe.heads.filter(h=>/（\d+）/.test(h.t)).length,0);
chk('orca headings with (N) count',orca.heads.filter(h=>/（\d+）/.test(h.t)).length,12);
for(const [n,a,b] of R) console.log((a===b?'✓':'✗')+` ${n}: ${a}${a===b?'':' (want '+b+')'}`);
const bad=R.filter(r=>r[2]!==r[1]).length;
console.log('\nMISMATCHES:',bad,'/',R.length);
process.exit(bad?1:0);
