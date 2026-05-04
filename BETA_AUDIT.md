# Lazyuniv AI — 베타 출시 전 감사 보고서

> 감사 일자: 2026-05-04  
> 감사자: Claude (Sonnet 4.6)  
> 대상 커밋: `972396d` (HEAD)  
> 범위: 코드 전체 정적 분석 + 흐름 추적 (코드 수정 없음)

---

## 1. 핵심 기능 점검

### 1-A. 인증 (Firebase Google OAuth)

**firebase_auth.js, constants.js, main.js**

| 항목 | 상태 | 설명 |
|------|------|------|
| Google 팝업 로그인 | ✅ 정상 | `auth/popup-closed-by-user` 정상 처리 |
| 로그아웃 | ✅ 정상 | `auth.signOut()` → UI 초기화 |
| `onAuthStateChanged` 경합 | ⚠️ 잠재 위험 | `init()` IIFE에서 `getAllNotesFS()`를 호출하나, `auth.onAuthStateChanged`가 아직 resolve되기 전에 실행될 수 있음. `getAllNotesFS()`는 `currentUser == null` 상태에서는 IDB fallback으로 빠지므로 실용 버그는 없으나, 로그인 직후 중복 sync가 발생할 수 있음 — `renderHomeView()`가 `syncNotesOnLogin().then(renderHomeView)` 경로와 `init()` 경로에서 동시에 실행됨. **P2** |
| 세션 만료 중 결제 콜백 | ❌ 버그 | **`main.js:61-67`**: 결제 성공 콜백에서 `currentUser`를 기다리는 Promise에 timeout이 없음. 사용자 세션이 만료된 상태로 Toss 결제 완료 페이지로 돌아오면 `auth.onAuthStateChanged`가 절대 resolve되지 않아 콜백이 영구 대기 → 결제 확인 API 미호출, 사용자에게 아무 피드백도 없음. **P1** |

**P1 재현 시나리오**: 사용자가 결제 진행 중 장시간 방치(세션 만료) → 카드사 결제 완료 → Toss가 `?payment=success` URL로 리다이렉트 → 페이지 로드 시 `currentUser == null` + `onAuthStateChanged`가 로그인하지 않은 사용자를 감지 → Promise 영구 대기 → 결제 확인 안 됨.

---

### 1-B. 파일 업로드 (PPT/PDF)

**pptx_parser.js, note_creation.js, constants.js**

| 항목 | 상태 | 설명 |
|------|------|------|
| 200MB 파일 크기 제한 | ✅ 정상 | `onPptChange`, `parseNotionFile` 모두 체크 |
| 형식 검증 | ✅ 정상 | `.pptx` / `.pdf` 확장자만 허용 |
| PDF 200페이지 하드 리밋 | ✅ 정상 | `MAX_PDF_PAGES = 200` 초과시 `PageLimitError` throw |
| 대용량 PDF OOM 위험 | ⚠️ 잠재 위험 | `pptx_parser.js:687-691`: 200페이지 PDF를 `scale: 1.5`로 렌더링하면 A4 기준 약 1123×1587px × 200페이지 → JPEG canvas 변환 시 메모리 수백MB 사용 가능. 5페이지마다 yield하나 GC가 빠르지 않으면 OOM 가능. **P2** |
| PPT 이미지 추출 시 3MB 초과 이미지 스킵 | ✅ 정상 | `extractPptxImages:542`: `MAX_BASE64_LEN` 체크 |
| 수강 녹취록 `.txt` 크기 제한 | ✅ 정상 | `MAX_FILE_SIZE_BYTES` 체크 |

---

### 1-C. AI 노트 생성 (api/claude.js → Anthropic)

> **비고**: api/claude.js는 감사 중인 sister sub-claude 작업 대상이지만 read는 허용됨.

| 항목 | 상태 | 설명 |
|------|------|------|
| 서버 사이드 API 키 보호 | ✅ 정상 | 클라이언트에 ANTHROPIC_API_KEY 미노출; 모든 호출은 `/api/claude` 프록시 경유 |
| B1 strict mode (analysisId) | ✅ 정상 | `noteAnalysis` 기능은 `analysisId` 없으면 400 반환; Firestore 트랜잭션으로 중복 과금 방지 |
| 429 재시도 (클라이언트) | ✅ 정상 | `api.js`: 3회 재시도, `Retry-After` 헤더 준수, `abortableSleep`으로 취소 지원 |
| Vercel 함수 타임아웃 설정 없음 | ❌ 버그 | **`vercel.json`**: `functions` 설정 없음 → Hobby 플랜 10초, Pro 플랜 60초 기본값. 스트리밍 노트 생성(Sonnet×2 + Haiku)은 복잡한 강의에서 120초+ 걸릴 수 있음. Hobby라면 10초에서 함수 종료 → 파이프라인 전체 실패. **P0** (플랜 확인 필요) |
| 스트리밍 중 Firestore billing fail-open | ⚠️ 잠재 위험 | `claude.js:336`: 과금 실패 시 `fail open` — 오류를 무시하고 응답 반환. 반대로 billing 성공하지만 응답 실패 경우는 없으나, 역방향(응답 OK + billing 실패)이면 무료로 분석 가능. Firestore 장애 중 대량 무료 이용 가능. **P2** |
| IP 기반 rate limit이 서버리스에서 무효 | ⚠️ 잠재 위험 | `claude.js:4`: `const rateLimit = new Map()` → Vercel 람다 인스턴스 간 공유 안 됨. 동시 사용자 많을 때 rate limit이 사실상 작동하지 않음. **P1** (§2에서 추가 분석) |

---

### 1-D. AI 퀴즈 생성

**quiz.js**

| 항목 | 상태 | 설명 |
|------|------|------|
| 문제 수 미달 시 에러 | ✅ 정상 | `questions.length < 5` 검사 후 에러 throw |
| 60초 타임아웃 | ✅ 정상 | `B2: quizTimer = setTimeout(() => quizCtl.abort(), 60000)` |
| 모델 폴백 | ✅ 정상 | `claude-sonnet-4-6` 실패 시 `claude-sonnet-4-5` 폴백 |
| max_tokens 과대 계산 | ⚠️ 잠재 위험 | `quiz.js:142`: `Math.max(16000, count * 1500)` → 10문제 = 16,000 출력 토큰. 월정액 사용자가 하루 100번 퀴즈 생성 시 160만 토큰 × $15/1M = $24/일/사용자. **과금 폭주 위험** (§2 참조). **P1** |
| 퀴즈는 quota 미차감 | ⚠️ 잠재 위험 | `claude.js:161`: `feature !== 'noteAnalysis'` → 퀴즈 생성은 quota 차감 없음. 월정액 사용자 무제한 퀴즈. **P1** |

---

### 1-E. STT 녹음 (recorder.js + AssemblyAI)

**recorder.js, api/assemblyai.js**

| 항목 | 상태 | 설명 |
|------|------|------|
| 오디오 파일 Storage 업로드 → AssemblyAI URL 전달 | ✅ 정상 | 4.5MB Vercel body 제한 우회 |
| STT 완료 후 오디오 삭제 | ✅ 정상 | `recorder.js:859-864`: `storage.ref(pathToDelete).delete()` (best-effort) |
| 오디오 Storage 경로 | ✅ 정상 | `users/{uid}/recordings/{ts}_...{ext}` → storage.rules 커버 |
| IP-based rate limit (30req/min) | ⚠️ 잠재 위험 | assemblyai.js도 동일하게 `Map` 기반 → 서버리스 환경에서 비효율. **P1** |
| 백드롭 클릭 시 최소화 | ✅ 정상 | 최신 커밋(`972396d`)에서 수정됨 |
| iOS 경고 | ✅ 정상 | `isiOS()` 감지 후 안내 표시 |
| 긴 강의(2시간+) AssemblyAI polling | ⚠️ 잠재 위험 | 6초마다 poll, 완료까지 최대 몇 분 가능. 사용자가 페이지 닫으면 `pollHandle`이 `clearInterval`되지만 이미 제출된 transcript는 완료됨. STT 결과를 받을 창구가 없어져 transcript 손실. **P2** |

---

### 1-F. 결제 (Toss Payments — api/toss.js)

| 항목 | 상태 | 설명 |
|------|------|------|
| 서버 측 금액 검증 | ✅ 정상 | `data.totalAmount`로 plan 결정, 클라이언트 `plan` 파라미터 무시 |
| Toss `paymentKey` 서버 확인 | ✅ 정상 | Toss API `/v1/payments/confirm` 호출 후 `status === 'DONE'` 확인 |
| **`uid` 인증 없음** | ❌ 버그 | **`api/toss.js:12,16`**: `uid`를 request body에서 그대로 신뢰. Firebase ID token 검증 없음. 공격자가 자신의 유효 `paymentKey`로 타 사용자의 `uid`를 지정해 요청 가능 → 피해자 계정에 구독이 추가되고 공격자는 혜택 못 받음. 실제 금전 피해는 없으나 데이터 무결성 위반. **P1** |
| **중복 orderId 검사 없음** | ❌ 버그 | **`api/toss.js` 전체**: 동일 `orderId`로 중복 요청 시 Toss API가 두 번째 confirm을 거부하므로 실제 이중결제는 없음. 하지만 Toss가 먼저 확인 후 Firestore 쓰기가 실패하는 시나리오에서 사용자는 결제됐지만 plan은 미업데이트될 수 있음. `lastOrderId` 비교로 멱등성 추가 권장. **P1** |
| **TEST 키 사용 중** | ❌ 버그 | **`payment.js:36`**: `TossPayments('test_ck_mBZ1gQ4YVXBjEx6651Wj8l2KPoqN')` → 실제 결제 불가. 베타 출시 전 반드시 live 키로 교체 필요. **P0** |
| Toss 웹훅 미구현 | ⚠️ 잠재 위험 | 결제 성공 콜백이 클라이언트 리다이렉트에만 의존. 서버 웹훅 없음 → 사용자가 결제 후 브라우저를 닫으면 plan 미업데이트 가능. 1-A의 세션 만료 버그와 복합시 P0급 결제 손실. **P1** |

---

### 1-G. 노트 CRUD + Firestore 동기화

**firestore_sync.js, notes_crud.js, storage.js**

| 항목 | 상태 | 설명 |
|------|------|------|
| Ghost note 방지 | ✅ 정상 | `saveNote`, `saveNoteFS` 양쪽에 title+content guard |
| 멀티디바이스 sync | ⚠️ 잠재 위험 | `syncNotesOnLogin:430` 이하: 로컬→Firestore 업로드(section 3,4)가 HOTFIX로 주석처리됨. 기기 A에서 오프라인으로 만든 노트는 기기 B에서 절대 보이지 않음. **P1** |
| `safeNotePartialUpdate` | ✅ 정상 | doc 없으면 create 대신 IDB fallback |
| Firestore 문서 1MB 초과 방지 | ✅ 정상 | 900KB 초과 시 필드 순차 strip |
| **Storage rules가 슬라이드 이미지 경로 미커버** | ❌ 버그 | **`storage.rules`**: `users/{uid}/recordings/{filename}`만 허용. `uploadSlideImages`(firestore_sync.js:524)는 `users/{uid}/notes/{noteId}/slide_{i}.png` 경로로 업로드 → 모든 신규 슬라이드 이미지 업로드 `permission-denied`로 실패. 에러는 per-image catch로 조용히 삡되어 `urls.push(null)` 처리됨 → 멀티디바이스에서 슬라이드 이미지 없음. **P0** |
| `deleteSlideImages` 실패 | ⚠️ 잠재 위험 | 동일 Storage rules 문제로 `listAll()` + `item.delete()` 도 실패. 오래된 슬라이드 이미지가 Storage에 영구 잔류 → 과금. **P1** |

---

### 1-H. 폴더 / 검색 / 태그 / 시험 plan / SRS

**folders.js, exam_plan.js, srs.js**

| 항목 | 상태 | 설명 |
|------|------|------|
| 폴더 색상 CSS injection 방지 | ✅ 정상 | `sanitizeFolderColor` whitelist 검증 |
| `deleteFolderFS` — 노트 이동 후 폴더 삭제 | ✅ 정상 | 하위 노트를 folderId=null로 이동 후 삭제 |
| `updateNoteOrderFS` batch write | ✅ 정상 | Firestore batch로 원자적 정렬 |
| SRS SM-2 알고리즘 | ✅ 정상 | 표준 SM-2 구현 |
| SRS Firestore 룰 커버 | ✅ 정상 | `users/{uid}/srsCards` 포함 |
| Exam plan 날짜 검증 | ⚠️ 잠재 위험 | 과거 날짜도 `examDate`로 등록 가능. `getDaysUntil` 음수 반환 → UI에 "D+N" 표시. 기능 버그는 없지만 혼란 유발. **P2** |
| Timetable Firestore 룰 커버 | ✅ 정상 | `users/{uid}/timetable` 포함 |

---

## 2. 이용자 증가 시 리스크 (스케일링 + 비용)

> 기준 시나리오: 베타 3개월 후 월 활성 사용자 1,000명, 인당 월 평균 5강의

---

### 2-A. AI API 비용 폭주 🔴 높음

**추정 토큰 소비 (강의 1회당)**
| 호출 | 모델 | Input | Output |
|------|------|-------|--------|
| Agent1 (노트 작성) | Sonnet 4.6 | ~8,000 | ~20,000 |
| Agent2 (비평) | Sonnet 4.6 | ~30,000 (누적) | ~4,000 |
| Haiku patch (iter2 시) | Haiku 4.5 | ~25,000 | ~15,000 |
| Transcript highlight | Sonnet 4.6 | ~20,000 | ~5,000 |
| **합계** | | **~83,000** | **~44,000** |

Sonnet 4.6 요금 (Input $3/M, Output $15/M):  
→ 노트 1회 ≈ **$0.25 + $0.66 = $0.91**

1,000명 × 5강의 × $0.91 ≈ **월 $4,550 (약 620만 원)**  
무료 3회 × 1,000명만 해도 월 $2,730

**퀴즈 추가 비용**: 월정액(₩7,900) 사용자가 퀴즈 무제한 생성 가능. 사용자 1명이 10문제 × 100회 = 160만 출력 토큰 = **$24/인/월** → 월정액 수익 ₩7,900($5.7) 대비 **역마진** 발생 가능.

**완화 방안** (P1):  
- `api/claude.js`에 `feature !== 'noteAnalysis'` 기능(퀴즈, classify)에 대해 **사용자별 일일 rate limit 추가**: 퀴즈 무료 10회/일, 유료 100회/일. Firestore `users/{uid}` 문서의 `quizUsage.{YYYY-MM-DD}` 필드로 카운팅.
- 프롬프트 캐싱 적용률 모니터링 — 현재 `cachePrefix` 사용 중이나 cache hit 여부 로깅 없음.

---

### 2-B. Firestore read/write 비용 🟡 중간

**가장 비싼 경로**: `renderHomeView()`
- `getAllNotesFS()` + `getAllFoldersFS()` = 2 collection reads (문서 수만큼 read 과금)
- `renderHomeView()`는 최소 6개 코드 경로에서 호출됨: `notes_crud.js:234,275,446,479,523`, `home_view.js:242`
- 노트 100개 × 6회 호출 = **600 Firestore document reads** per action

**완화 방안** (P2):  
- `renderHomeView()`에 debounce 추가 (현재 없음). 동일 이벤트 루프 내 중복 호출 방지.
- 장기적으로 IDB를 primary source로 사용하고 Firestore는 초기 sync + 변경 사항만 반영.

**리얼타임 리스너**: `onSnapshot` 없음 → 리스너 과금 위험 없음 ✅

---

### 2-C. Firebase Storage 비용 🟡 중간

| 파일 종류 | 경로 | 정책 |
|-----------|------|------|
| STT 오디오 | `users/{uid}/recordings/` | STT 완료 후 자동 삭제 ✅ |
| 슬라이드 이미지 | `users/{uid}/notes/{noteId}/slide_N.png` | 영구 보관 (삭제 기능 있으나 Storage rules 버그로 현재 실패) |

슬라이드 이미지 (PPT당 평균 20장 × 200KB/장): 강의 1회 당 4MB  
1,000명 × 5강의 × 4MB = **20GB/월** → Firebase Storage 비용 ≈ **월 $0.5** (저렴)

STT 오디오: 1시간 강의 ≈ 30~50MB webm → 자동 삭제로 누적 없음 ✅

---

### 2-D. AssemblyAI 비용 🟡 중간

AssemblyAI Universal 모델: $0.37/시간

1,000명 × 5강의 × 1.5시간 = 7,500시간 → **월 $2,775 (약 380만 원)**

**완화 방안** (P1):  
- 현재 per-user AssemblyAI 사용량 추적 없음. 월정액 사용자 STT 무제한 → 롤업 모니터링 필요.
- `api/assemblyai.js`에 사용자별 월 STT 시간 한도 추가 고려 (예: 무료 3시간, 유료 무제한).

---

### 2-E. Vercel 함수 실행 시간 초과 🔴 높음

`vercel.json`에 `maxDuration` 미설정:
- **Hobby 플랜 기본값: 10초** — 스트리밍 노트 생성이 10초 만에 끊김. 사실상 서비스 불가.
- **Pro 플랜 기본값: 60초** — 복잡한 강의(녹취록 10만 자+)에서 90초+ 소요 가능 → 타임아웃.

**완화 방안** (P0):  
```json
// vercel.json에 추가
{
  "functions": {
    "api/claude.js": { "maxDuration": 300 }
  }
}
```
Pro 플랜 이상 필요. 현재 Vercel 플랜 확인 후 즉시 적용.

---

### 2-F. Firestore 1MB 문서 한도 🟡 중간

기존에 `extractedImages` base64 문제(M4)는 해결됨(이미지를 Storage URL로 대체, 4MB → 수 byte).

현재 위험 필드:
- `pptText`: 100장 PPT = 최대 10만 자 ≈ 100KB — 안전
- `filteredText`: 2시간 강의 = 최대 20만 자 ≈ 200KB — 안전
- `notesHtml`: Firestore에 저장 안 함(save 시 `delete toSave.notesHtml`) ✅
- `highlightedTranscript`: 20만 자 가능. 900KB 초과 시 strip 로직이 있음 ✅

**잔존 위험**: strip 순서(`pipelineLog, highlightedTranscript, pptText, recText`) 실행 후에도 `notesText`(24,000 토큰 ≈ 96KB)가 남아있고, `filteredText`를 같이 보관하면 200KB+가 됨. 극단적 케이스(초장문 PPT + 초장문 녹취록)에서 950KB 초과 가능. 이 경우 **Firestore write skip — IndexedDB만 저장** → 멀티디바이스 sync 불가.

---

### 2-G. 동시성 Race Conditions 🟡 중간

| Race | 현황 |
|------|------|
| 결제 race (같은 analysisId 동시 요청) | Firestore transaction으로 보호 ✅ |
| quota race (무료 3회 동시 요청) | `analysisId` 기반 session doc으로 보호 ✅ |
| 노트 동시 편집 (같은 노트 두 기기) | `updatedAt` 비교 기반 — Firestore 트랜잭션 없음. `updatedAt`이 동일하면 나중 기기의 데이터가 이전 기기의 데이터를 덮어씀. **P2** |
| 폴더 이동 `sortOrder` race | `Date.now()` 사용으로 이전 `Math.max+1` 경합 수정됨 ✅ |

---

### 2-H. DDoS / 어뷰징 🔴 높음

**무료 계정 어뷰징**: 구글 계정 복수 생성으로 무료 3회씩 반복 이용 가능.  
→ 현재 이메일 검증이나 디바이스 지문 없음.  
→ **완화**: 서버 측 구글 계정 이메일 도메인 제한 불가(구글 계정은 무료). 단기: 신규 가입 IP 당 무료 계정 수 제한. 장기: 신용카드 등록 없이 무료 사용은 구조적 한계.

**대용량 파일 반복 업로드**: 200MB PDF를 반복 업로드 시 PDF 파싱은 클라이언트에서 실행되므로 서버 부하는 없지만, 최종 `/api/claude` 호출 시 텍스트가 이미 추출된 상태. 서버는 텍스트 길이로 비용을 지불함. 

**AI API 무료 우회**: `feature: 'quiz'`로 `/api/claude`를 직접 호출하면 quota 차감 없이 Sonnet을 호출할 수 있음. rate limit 10req/min/IP가 있으나 서버리스 환경에서 사실상 무효(2-I 참조). **P1**

---

### 2-I. Rate Limiting 부재 (분산 환경에서 무효) 🔴 높음

**`api/claude.js:4`**, **`api/assemblyai.js:17`** 모두 동일 문제:

```js
const rateLimit = new Map(); // 인메모리 — 람다 인스턴스 간 공유 안 됨
```

Vercel은 동시 요청마다 새 람다 컨테이너를 생성할 수 있음. 즉:
- 사용자 A가 10개 탭에서 동시에 `/api/claude`를 호출하면 각각 다른 컨테이너 → 각 컨테이너는 `count = 1`만 보임 → rate limit 완전 우회.

**완화 방안** (P1):  
`api/claude.js`에 사용자별(uid 기반) Firestore 카운터 추가. IP 기반보다 uid 기반이 어뷰징 방지에 효과적.

예시:
```js
// Firestore 기반 사용자별 분 단위 rate limit
const windowKey = uid + ':' + Math.floor(Date.now() / 60000);
const counterRef = admin.firestore().collection('rateLimits').doc(windowKey);
await admin.firestore().runTransaction(async tx => {
  const doc = await tx.get(counterRef);
  const count = (doc.exists ? doc.data().count : 0) + 1;
  if (count > 60) throw new Error('rate_limited'); // 60req/min 유료, 10req/min 무료
  tx.set(counterRef, { count, expireAt: /* +2분 */ }, { merge: true });
});
```

TTL 설정 필요 (`expireAt` 기반 Firestore TTL).

---

## 3. 데이터 무결성 / 보안

### 3-A. Firestore Security Rules 상태

> Sister sub-claude 커밋 `30af4d2` (2026-05-04 10:38 KST)에서 생성됨.

✅ 기본 deny (catch-all) 적용  
✅ `users/{uid}` 및 8개 subcollection 모두 `request.auth.uid == uid` 조건으로 격리  
✅ `analysisSessions`는 `allow false` → 클라이언트 접근 차단  

**⚠️ 치명적 미비점** (P0):

`match /users/{uid} { allow read, write: if request.auth != null && request.auth.uid == uid; }` 규칙은 사용자가 자신의 **payment 필드를 직접 쓸 수 있음**을 허용합니다.

재현 시나리오:
```js
// 브라우저 콘솔에서 로그인 후 실행
firebase.firestore().collection('users').doc(firebase.auth().currentUser.uid)
  .set({ plan: 'monthly', planExpiry: '2099-12-31T00:00:00.000Z' }, { merge: true });
```

서버의 `checkQuota()`는 `admin.firestore()`로 이 문서를 읽으므로, 위 공격 후 `data.plan === 'monthly'` → `{ allowed: true, slot: 'monthly' }` 반환 → **무료 월정액 이용** 가능.

**완화 방안** (P0):  
`users/{uid}` 문서를 읽기 전용으로 변경하거나, 결제 필드 write를 필드 수준으로 차단:

```js
match /users/{uid} {
  allow read: if request.auth != null && request.auth.uid == uid;
  // 결제 필드는 Admin SDK만 쓸 수 있도록: 클라이언트 write 전면 차단
  allow write: if false;
}
```

현재 클라이언트에서 `users/{uid}` 문서에 직접 쓰는 코드(`setPaidPlan` 함수, `payment.js:94`)가 있으나 실제 호출 경로는 없음(main.js에서 server API를 통해 처리). 따라서 `allow write: if false`로 바꿔도 기능 손상 없음.

---

### 3-B. API Key 노출 위험

| 키 | 위치 | 상태 |
|----|------|------|
| Firebase client apiKey | `constants.js:6` | ⚠️ 공개 (Firebase 앱에서 정상, Security Rules로 보호) |
| Anthropic API Key | 서버 환경변수만 | ✅ 클라이언트 미노출 |
| AssemblyAI API Key | 서버 환경변수만 | ✅ 클라이언트 미노출 |
| Toss TEST 클라이언트 키 | `payment.js:36` | ⚠️ TEST 키 노출 (정상 패턴이나 베타 전 live 키 교체 필요) |
| Firebase Service Account | Vercel 환경변수 | ✅ 클라이언트 미노출 |

`index.html:3790`: `<input id="apiKeySettings" placeholder="sk-ant-api03-...">` — 레거시 UI. 실제로는 서버 프록시 사용중이라 값이 전송되지 않지만, 사용자에게 혼란 줄 수 있음. (P2: 베타 후 제거)

---

### 3-C. 사용자 데이터 격리

| 경로 | 격리 상태 |
|------|----------|
| Firestore `users/{uid}/*` | ✅ `uid == request.auth.uid` |
| Storage `users/{uid}/recordings/*` | ✅ `uid == request.auth.uid` |
| Storage `users/{uid}/notes/*` (슬라이드 이미지) | ❌ rules 미커버 (현재 기본 deny로 오히려 업로드 차단됨) |
| AssemblyAI 오디오 URL | ✅ `isAllowedAudioUrl()` 검증으로 우리 Storage만 허용 |

---

### 3-D. Firebase B1 Strict Mode 상태

Sister sub-claude가 `B1 strict mode` 활성화 (`994c5a8` 커밋):

`api/claude.js:170`: `noteAnalysis` 기능에 `analysisId` 없으면 400 반환 → **활성화됨** ✅

---

## 4. 베타 출시 전 권장 액션 (우선순위 순)

### P0 — 출시 막아야 함

- [ ] **[P0-1] Firestore users/{uid} 쓰기 차단**  
  파일: `firestore.rules` (sister sub-claude 담당이나 배포 전 반드시 확인)  
  변경: `allow write: if false;` (Admin SDK는 rules bypass)  
  예상 작업: 3분 | **sub-claude 처리 가능**

- [ ] **[P0-2] Storage rules에 notes 경로 추가**  
  파일: `storage.rules`  
  추가 rule:
  ```
  match /users/{uid}/notes/{allPaths=**} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
  ```
  예상 작업: 3분 | **sub-claude 처리 가능**

- [ ] **[P0-3] Toss TEST 키 → LIVE 키 교체**  
  파일: `public/js/payment.js:36`  
  `TossPayments('test_ck_...')` → `TossPayments(환경변수)` 또는 live 키  
  예상 작업: 10분 | **사용자 직접 처리** (Toss 대시보드에서 live key 확인 필요)

- [ ] **[P0-4] Vercel maxDuration 설정**  
  파일: `vercel.json`  
  추가:
  ```json
  "functions": { "api/claude.js": { "maxDuration": 300 } }
  ```
  Vercel Pro 플랜 필요 (현재 플랜 확인). Hobby라면 Pro 업그레이드 필수.  
  예상 작업: 5분 | **사용자 직접 처리** (Vercel 대시보드)

---

### P1 — 출시 후 1주 내

- [ ] **[P1-1] toss.js uid 인증 추가**  
  파일: `api/toss.js`  
  `idToken`을 request body에 추가하고 `admin.auth().verifyIdToken(idToken)`으로 uid 추출. client body의 uid 신뢰 제거.  
  예상 작업: 20분 + main.js 수정(idToken 전달) | **sub-claude 처리 가능**

- [ ] **[P1-2] 결제 콜백 auth 대기 timeout 추가**  
  파일: `public/js/main.js:61`  
  5초 타임아웃 후 "로그인 후 결제 확인 필요" 안내 toast.  
  예상 작업: 15분 | **sub-claude 처리 가능**

- [ ] **[P1-3] 퀴즈 생성에 사용자별 일일 rate limit**  
  파일: `api/claude.js`  
  `feature === 'quiz'`일 때 Firestore `quizUsage.{date}` 카운터 체크. 무료 10회/일, 유료 100회/일.  
  예상 작업: 60분 | **sub-claude 처리 가능**

- [ ] **[P1-4] 분산 rate limit (IP 기반 → uid+Firestore 기반)**  
  파일: `api/claude.js`, `api/assemblyai.js`  
  인메모리 Map 제거 → Firestore TTL 기반 카운터.  
  예상 작업: 45분 | **sub-claude 처리 가능**

- [ ] **[P1-5] 슬라이드 이미지 삭제 실패 모니터링**  
  현재 Storage rules 수정 후(P0-2) 실제 삭제가 작동하는지 확인. 기존 배포 전 업로드된 이미지 정리 스크립트 작성.  
  예상 작업: 30분 | **사용자 직접 처리** (Firebase console)

- [ ] **[P1-6] 오프라인→온라인 sync 복구 (HOTFIX 해제)**  
  파일: `public/js/firestore_sync.js:430-440` (section 3, 4 주석 해제)  
  Ghost note 재발 방지책(saveNoteFS ghost guard)이 충분히 검증된 후 재활성화.  
  예상 작업: 15분 + 테스트 | **사용자 직접 처리** (검증 후 결정)

- [ ] **[P1-7] toss.js orderId 멱등성 체크**  
  파일: `api/toss.js`  
  Firestore에서 `lastOrderId == orderId`이면 이미 처리된 요청으로 간주 → 200 반환 (Toss API 재호출 없이).  
  예상 작업: 20분 | **sub-claude 처리 가능**

---

### P2 — 여유 있게

- [ ] **[P2-1] Toss 결제 웹훅 구현**  
  파일: `api/toss-webhook.js` (신규)  
  결제 취소/환불 이벤트도 자동 처리.  
  예상 작업: 2시간

- [ ] **[P2-2] renderHomeView() debounce**  
  파일: `public/js/home_view.js`  
  동일 tick 내 중복 호출 방지 → Firestore read 절감.  
  예상 작업: 30분

- [ ] **[P2-3] apiKeySettings UI 제거**  
  파일: `public/index.html:3790`  
  레거시 API key 입력 필드 제거 (서버 프록시 방식으로 전환됨).  
  예상 작업: 10분

- [ ] **[P2-4] 200페이지 PDF OOM 완화**  
  파일: `public/js/pptx_parser.js:687`  
  canvas를 재사용(OffscreenCanvas) + 페이지당 해상도 `scale: 1.0`으로 낮추기.  
  예상 작업: 1시간

---

## 5. 베타 후 우선 개선 (post-launch backlog)

1. **Toss 웹훅 전체 구현** — 구독 갱신, 자동 결제 실패, 환불 처리 자동화 (현재 수동 대응 필요)

2. **구독 자동 갱신** — 현재 `planExpiry = now + 30일` 로 고정. 다음 달 자동 청구 없음 → 사용자가 매월 수동 결제 필요. 구독 UX가 매우 불편.

3. **노트 동시 편집 충돌 해결** — 같은 노트를 두 기기에서 수정 시 마지막 write가 이기는 LWW(Last Write Wins) 현재 정책. Firestore에서 merge 전략 도입 고려.

4. **어뷰징 탐지 대시보드** — `usage.{monthKey}` 필드를 기반으로 비정상적 사용 패턴 탐지 (예: 무료 계정 일일 3회 초과 시도 로그).

5. **STT 결과 재사용** — transcript store 구현됨(`transcripts_store.js`)이나 UI에서 브라우징 후 기존 녹취록을 새 노트에 첨부하는 기능 미완성.

6. **AssemblyAI speaker_labels 정확도** — `universal` 모델 + `speaker_labels: true` 사용 중이나 한국어 화자 분리 정확도가 낮을 수 있음. 실제 강의 녹음으로 QA 필요.

7. **iOS Safari MediaRecorder 호환성** — `pickMimeType()` 폴백 있으나 iOS에서 실제 테스트 필요. iOS는 `audio/mp4`만 지원하며 일부 기기에서 MediaRecorder 자체가 없음.

8. **레거시 `incrementUsage()` 함수 제거** — `payment.js:84`: no-op으로 표시된 함수가 여전히 존재. 혼란 방지용 코드 정리.

9. **`setPaidPlan()` 함수 제거** — `payment.js:94`: 현재 호출 경로 없음. 서버가 plan 관리를 전담한 후 불필요. Firestore rules에서 write 차단(P0-1)과 함께 제거하면 깔끔.

10. **Vercel Edge Config 또는 Redis로 rate limit 이전** — P1-4에서 Firestore 기반으로 전환하더라도 Firestore latency(~100ms)가 rate limit 체크에 추가됨. 장기적으로 Vercel KV(Redis) 사용 고려.

---

*End of Audit*
