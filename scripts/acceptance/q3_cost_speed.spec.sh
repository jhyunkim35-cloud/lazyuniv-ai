# 회귀 가드 — Q3 비용·속도 최적화 (2026-07-08)
# 청크 캐시 재구성(전사록 캐시 포함), agent2 dead 캐시 제거, prevNotes 다이제스트(O(N)),
# critique/하이라이트 병렬화, 온디맨드 도구 캐시 공유, system 프롬프트 이중 전송 제거가
# 코드에 남아있는지 잠금.
assert_contains public/js/pipeline.js "if (hasTxt) cachePrefix += \`\n\n[강의 녹취록]\n\${recText}\`;" "Fix1: 청크/단일패스 캐시 블록에 전체 전사록 포함"
assert_contains public/js/pipeline.js "const chunkCache = cachePrefix;" "Fix1: 청크 캐시가 매 청크 동일(byte-identical)한 공유 블록"
assert_contains public/js/pipeline.js "Fix 2 (Q3): pass null cachePrefix" "Fix2: agent2 critic dead 캐시 라이트 제거 주석"
assert_contains public/js/pipeline.js "'claude-haiku-4-5-20251001', null, { feature: 'noteAnalysis' });" "Fix2: agent2 critic 호출이 cachePrefix=null로 무캐시 전송"
assert_contains public/js/pipeline.js "function buildPrevNotesDigest" "Fix3: prevNotes O(N) 다이제스트 함수 존재"
assert_contains public/js/pipeline.js "이미 작성된 섹션·용어 (중복 금지)" "Fix3: 다이제스트가 청크 프롬프트에 사용됨"
assert_contains public/js/pipeline.js "const [critiqued, highlighted, summaryRes] = await Promise.all([" "Fix4: agent2 critique + 하이라이트 병렬 실행"
assert_contains public/js/pipeline.js "function buildToolsCachePrefix" "Fix5: 온디맨드 도구 공유 캐시 레이아웃 함수 존재"
assert_contains public/js/pipeline.js "buildToolsCachePrefix(stripped)" "Fix5: 마인드맵/암기 도구가 공유 캐시 레이아웃 사용"
assert_contains public/js/quiz.js "buildToolsCachePrefix(stripLeadingSummary(noteText))" "Fix5: 퀴즈 생성이 동일 공유 캐시 레이아웃 재사용"
assert_contains public/js/pipeline.js "const MINIMAL_SYSTEM = '위 사용자 메시지에 포함된 지시사항을 정확히 따르세요." "Fix6: system 파라미터 중복 제거 — 최소 system 문자열"
assert_repo_absent "chunkCache = \`\${systemPrompt}\n\n[형식]" "Fix1 회귀 방지: 청크별 재구축 캐시(pptChunk 스코프)가 되살아나지 않음"
