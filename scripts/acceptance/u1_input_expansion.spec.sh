# 회귀 가드 — U1 입력 확장 (2026-07-08)
# PPT/PDF 없이 녹취록만으로 노트 생성, 텍스트 붙여넣기 메모 입력, .docx 업로드 지원.
assert_contains public/js/note_creation.js "if (!pptFile && !imageFiles.length && !txtFiles.some(s => s.file !== null)) return;" "U1-1a: 단일 모드 분석 게이트 — PPT 없이 녹취록만 있어도 통과 (U8: imageFiles 조건 추가)"
assert_contains public/js/note_creation.js "녹취록 전용 모드 — PPT 없음" "U1-1b: PPT 없을 때 진행 메시지가 녹취록 전용 모드를 알림"

assert_contains public/js/pptx_parser.js "analyzeBtn.disabled = isRunning || (!hasDoc && !hasRecordings);" "U1-2a: checkReady가 PPT 없이도 녹취록만으로 분석 버튼 활성화 (U8: hasDoc = pptFile||imageFiles)"
assert_contains public/js/pptx_parser.js "녹취록만으로도 분석할 수 있어요" "U1-2b: recOnlyHint 문구가 PPT 없이도 분석 가능함을 안내"

assert_contains public/js/pipeline.js "const hasPpt   = pptText && pptText.trim().length > 0;" "U1-3a: agent1_writeNotes가 PPT 유무를 판별"
assert_contains public/js/pipeline.js "PPT 자료가 없으므로 녹취록 내용만으로 핵심 개념을 충실히 정리하세요" "U1-3b: PPT 없을 때 단일 패스 프롬프트가 녹취록 전용으로 안내"
assert_contains public/js/pipeline.js "const hasPpt2 = pptText && pptText.trim().length > 0;" "U1-3c: agent2_critiqueNotes도 PPT 유무를 판별 (agent1과 동일 패턴)"

assert_contains public/js/pptx_parser.js "async function extractDocxText(file)" "U1-4a: extractDocxText 함수 존재 (JSZip으로 word/document.xml 파싱)"
assert_contains public/js/pptx_parser.js "if (name.endsWith('.docx')) return extractDocxText(file);" "U1-4b: extractPresentationText가 .docx를 extractDocxText로 디스패치"
assert_contains public/index.html 'id="pptInput" accept=".pptx,.pdf,.docx,.jpg,.jpeg,.png,.webp" multiple' "U1-4c: 단일 모드 pptInput accept에 .docx 포함 (U8: 이미지 확장자 + multiple 추가)"
assert_contains public/index.html 'id="batchPptInput" accept=".pptx,.pdf,.docx"' "U1-4d: 배치 모드 batchPptInput accept에 .docx 포함"

assert_contains public/index.html 'id="pasteMemoBtn"' "U1-5a: 텍스트 붙여넣기 버튼이 녹취록 업로드 영역에 존재"
assert_contains public/js/main_inline.js "document.getElementById('pasteMemoBtn').addEventListener('click'" "U1-5b: pasteMemoBtn 클릭 핸들러 등록"
assert_contains public/js/main_inline.js "new File([text], '메모.txt', { type: 'text/plain' })" "U1-5c: 붙여넣은 텍스트가 .txt File로 래핑되어 기존 녹취록 입력 경로 재사용"
