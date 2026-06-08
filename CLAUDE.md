# Notyx (노틱스) — 프로젝트 가이드

한국 대학생용 AI 학습노트 SaaS. 솔로 개발자 김준현(jhyun.kim35@gmail.com).
Vanilla JS + Vercel 서버리스 + Firebase. 라이브: notyx.co.kr

## 🔄 세션 연속성 (매 세션 필수)
- **작업 시작**: `C:\Users\김준현\notyx-vault\10 Notyx\작업로그\_타임라인.md` 를 먼저 읽고 직전 맥락 복원. 특정 작업 디테일이 필요하면 그 작업로그 노트를 Grep로 핀포인트.
- **작업 종료**: 그 세션 작업을 `...\작업로그\YYYY-MM-DD 작업명.md` 로 정리(뭘·어떻게·결과·커밋·교훈) + `_타임라인.md` 맨 위에 한 줄 추가.

## ⚠️ 환경 규칙 (어기면 사고)
- 한글 파일: PowerShell `Set-Content` **절대 금지** (CP949 모지바케 사고 이력). claude-code Edit/Write 또는 Node fs만.
- Git Bash 한글 경로: `$HOME` 환경변수로 (직접 입력 시 모지바케).
- PowerShell 5.1: `&&`·`||`·삼항 금지 → `;` 또는 `if ($?) {}`.
- JS 수정 후: `node --check public/js/<파일>.js` 로 문법 검증.
- 캐시버스트: `index.html` 의 `?v=OLD` → `?v=NEW` 교체 필수 (안 하면 stale).

## 🛠 작업 방식
- 코드 수정: **감사/검토 먼저 제시 → 준현 OK → 실행** (건너뛰면 명시적으로 지적).
- 큰 작업: 라운드로 분할, 라운드 끝마다 검증(smoke 스크립트 + curl).
- 롤백 안전망: 라운드 시작 전 `git log -1 --oneline` 해시 메모 → 문제 시 reset.
- 작업 전 `notyx-vault\20 Dev\도구·스킬 카탈로그.md` 확인해 최적 도구/스킬 선택.
- 톤: 짧고 직접적인 한국어(케이브맨). 단 기술 정확성·검토 먼저 규칙은 유지.

## 📚 스택
- `public/index.html` + `public/js/` ~36개 (ES모듈 X, `<script src>`, **로드순서 중요**)
- `api/` Vercel 서버리스 (claude.js 프록시, toss.js, assemblyai.js, _firebase-admin.js)
- Firebase Auth(구글)/Firestore/Storage, IndexedDB 로컬 primary, Toss 결제
- AI: Claude Sonnet 4.6(노트/퀴즈) · Haiku(분류/채점)
- 배포: `git push` → Vercel auto-deploy (repo: jhyunkim35-cloud/lazyuniv-ai → main)
- 로컬 경로: `C:\Users\김준현\meeting-app`
