#!/usr/bin/env node
// 맛집 노트에서 "검색 후 채울 예정"인 항목을 찾아 웹검색으로 채우는 스크립트.
// Claude Code에서 /goal로 돌릴 것:
//   /goal "모든 맛집 노트의 '검색 후 채울 예정'이 사라질 때까지 이 스크립트를 실행하고,
//          스크립트가 채우지 못한 항목은 네이버/다이닝코드/식신에서 검색해서 직접 채워라.
//          검증: node scripts/check-place-notes.js 실행 시 REMAINING 0이면 완료."
//
// 사용: node scripts/fill-place-info.js [--dry-run]

const fs = require('fs');
const path = require('path');

const VAULT = 'C:/Users/김준현/Documents/Obsidian Vault/50 Life/맛집';
const DRY = process.argv.includes('--dry-run');

function walkMd(dir, arr = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walkMd(p, arr);
    else if (f.endsWith('.md') && !f.startsWith('_')) arr.push(p);
  }
  return arr;
}

const files = walkMd(VAULT);
const MARKER = '검색 후 채울 예정';
const pending = files.filter(f => fs.readFileSync(f, 'utf8').includes(MARKER));

console.log(`REMAINING: ${pending.length} / ${files.length} 개 노트에 미채움 항목`);
if (pending.length === 0) { console.log('✅ 전부 채워짐!'); process.exit(0); }

// 미채움 목록 출력 (Claude Code가 검색할 대상 파악용)
const SHOW = Math.min(pending.length, 20);
console.log(`\n--- 다음 ${SHOW}개부터 채워라 ---`);
for (const fp of pending.slice(0, SHOW)) {
  const c = fs.readFileSync(fp, 'utf8');
  const nameM = c.match(/^name: "(.+)"$/m);
  const typeM = c.match(/^type: "(.+)"$/m);
  const addrM = c.match(/^address: "(.+)"$/m);
  console.log(`- ${nameM?.[1]} (${typeM?.[1]}) @ ${addrM?.[1]}`);
  console.log(`  파일: ${fp}`);
}
if (pending.length > SHOW) console.log(`  ... 외 ${pending.length - SHOW}개`);
console.log('\n✍️  Claude Code: 위 목록을 다이닝코드/네이버/식신에서 검색해서 각 파일의 가격대·대표메뉴·특징·영업시간을 채워라.');
process.exit(pending.length > 0 ? 1 : 0);
