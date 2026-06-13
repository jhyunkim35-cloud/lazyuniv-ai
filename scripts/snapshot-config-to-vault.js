// Operator tool (untracked, like read-bug-reports.js): snapshot the project's
// NON-SECRET config files into the Obsidian vault so their contents are
// retrievable / restorable from notes.
//
// NEVER snapshots secrets (.env*, keys, credentials) — see WHITELIST + FORBIDDEN.
// Refresh the snapshot anytime after config changes:
//     node scripts/snapshot-config-to-vault.js
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VAULT_NOTE = 'C:/Users/김준현/Documents/Obsidian Vault/20 Dev/설정 파일 스냅샷.md';

// NON-SECRET config files (relative to repo root). Order = usefulness.
const FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  'firestore.rules',
  'storage.rules',
  'firestore.indexes.json',
  'firebase.json',
  '.firebaserc',
  'vercel.json',
  'package.json',
  '.gitignore',
];

// Hard guard: never emit anything matching this, even if added to FILES later.
const FORBIDDEN = /(^|\/)\.env|secret|credential|serviceaccount|key\.json|package-lock\.json/i;

const fence = (f) => {
  if (f.endsWith('.json') || f === '.firebaserc') return 'json';
  if (f.endsWith('.rules')) return 'js';
  if (f.endsWith('.yml') || f.endsWith('.yaml')) return 'yaml';
  return '';
};

const today = new Date().toISOString().slice(0, 10);

let out = '# 설정 파일 스냅샷 (' + today + ')\n\n';
out += '> 프로젝트의 비밀 아닌 설정 파일 내용 사본. 필요할 때 바로 꺼내 쓰기용.\n';
out += '> 관련: [[작업 규약]] · [[Claude Code 무인 루프 세팅]]\n';
out += '> ⚠️ **스냅샷이다 — 원본 바뀌면 낡는다.** git-tracked 파일은 repo(meeting-app)가 정본.\n';
out += '> 갱신: `node scripts/snapshot-config-to-vault.js` (이 노트를 다시 생성).\n';
out += '> 🔒 **비밀 제외:** `.env.local`(API키·토스 시크릿) 등은 절대 안 넣음. `package-lock.json`은 파생 노이즈라 제외.\n\n';
out += '제외 목록: `.env.local`, `api/_firebase-admin.js`/`firebase_auth.js`(소스), `package-lock.json`.\n';

for (const rel of FILES) {
  out += '\n---\n\n### `' + rel + '`\n\n';
  if (FORBIDDEN.test(rel)) { out += '(비밀/제외 패턴 매치 — 스킵)\n'; continue; }
  const abs = path.join(REPO, rel.split('/').join(path.sep));
  let body;
  try { body = fs.readFileSync(abs, 'utf8'); }
  catch (e) { out += '(읽기 실패: ' + e.code + ')\n'; continue; }
  out += '```' + fence(rel) + '\n' + body.replace(/\s+$/, '') + '\n```\n';
}

fs.writeFileSync(VAULT_NOTE, out, 'utf8');
console.log('WROTE', VAULT_NOTE);
console.log('files:', FILES.length, '| bytes:', Buffer.byteLength(out, 'utf8'));
