# Notyx (노틱스) — 프로젝트 가이드

한국 대학생용 AI 학습노트 SaaS. 솔로 개발자 김준현(jhyun.kim35@gmail.com).
Vanilla JS + Vercel 서버리스 + Firebase. 라이브: notyx.co.kr

## ✅ 행동 규약 (매번 — 까먹지 말 것)
> 하네스 원칙: 규칙은 부탁이 아니라 강제. 머리로 기억하지 말고 이 순서를 그대로 따른다.

**⓪ 세션 시작 — 옵시디언 볼트 무조건 먼저 (예외 없음):**
- 볼트 루트: `C:\Users\김준현\Documents\Obsidian Vault`
- `Documents\Obsidian Vault\10 Notyx\작업로그\_타임라인.md` 먼저 읽고 직전 맥락 복원. 디테일 필요하면 해당 작업로그 노트를 Grep로 핀포인트.
- 작업 전 `Documents\Obsidian Vault\20 Dev\도구·스킬 카탈로그.md` 확인해 최적 도구/스킬 선택.
- 이 단계 건너뛰면 스스로 멈추고 먼저 읽는다.

**② 작업 단위(라운드)마다 — 끝나면 즉시, 미루지 말 것:**
1. **감사/검토 먼저 제시 → 준현 OK → 실행** (순서 건너뛰면 스스로 명시 지적).
2. 라운드 시작 전 `git log -1 --oneline` 해시 메모 (롤백 안전망).
3. JS 수정 후 `node --check`, 캐시버스트 `?v=` 교체.
4. **관련 파일만** `git add <파일>` 명시 (미관련 변경 안 섞기) → 커밋 → `git push`.
5. 라이브 검증 (curl로 배포 확인).
6. **옵시디언 즉시 기록** ← 제일 자주 까먹는 거. **라운드 끝 = 기록 끝.** `Documents\Obsidian Vault\10 Notyx\작업로그\YYYY-MM-DD 작업명.md`(뭘·어떻게·결과·커밋·교훈) + `_타임라인.md` 맨 위 한 줄.

**③ 세션 종료:** 위 6번이 모든 라운드에 대해 됐는지 확인.

**톤:** 짧고 직접적인 한국어(케이브맨). 단 기술 정확성·검토 먼저 규칙은 항상 유지.

## ⚠️ 환경 규칙 (어기면 사고)
- 한글 파일: PowerShell `Set-Content` **절대 금지** (CP949 모지바케 사고 이력). claude-code Edit/Write 또는 Node fs만.
- Git Bash 한글 경로: `$HOME` 환경변수로 (직접 입력 시 모지바케).
- PowerShell 5.1: `&&`·`||`·삼항 금지 → `;` 또는 `if ($?) {}`.
- JS 수정 후: `node --check public/js/<파일>.js` 로 문법 검증.
- 캐시버스트: `index.html` 의 `?v=OLD` → `?v=NEW` 교체 필수 (안 하면 stale).
- 프리커밋 훅: `.githooks/pre-commit`가 JS 문법오류·한글 모지바케 자동 차단. 새 클론 1회만 `git config core.hooksPath .githooks` (안 하면 훅 안 돎).

## 📚 스택
- `public/index.html` + `public/js/` ~36개 (ES모듈 X, `<script src>`, **로드순서 중요**)
- `api/` Vercel 서버리스 (claude.js 프록시, toss.js, assemblyai.js, _firebase-admin.js)
- Firebase Auth(구글)/Firestore/Storage, IndexedDB 로컬 primary, Toss 결제
- AI: Claude Sonnet 4.6(노트/퀴즈) · Haiku(분류/채점)
- 배포: `git push` → Vercel auto-deploy (repo: jhyunkim35-cloud/lazyuniv-ai → main)
- 로컬 경로: `C:\Users\김준현\meeting-app`
