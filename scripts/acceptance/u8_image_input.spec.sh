# 회귀 가드 — U8 이미지 문서 입력 (2026-07-08)
# 발표자료 슬롯에 슬라이드/필기 사진을 직접 업로드(여러 장 = 한 강의의 페이지들)해
# 비전으로 전사 → [페이지 N] 블록으로 조립, 기존 파이프라인(청킹/인용칩/오버레이)이
# 그대로 동작하는지 잠금.

# ── 입력: accept + multiple ──
assert_contains public/index.html 'id="pptInput" accept=".pptx,.pdf,.docx,.jpg,.jpeg,.png,.webp" multiple' "U8-1a: pptInput accept에 이미지 확장자 포함 + multiple 속성"
assert_contains public/js/main_inline.js "if (e.target.files.length) onPptChange(e.target.files);" "U8-1b: pptInput change 핸들러가 FileList 전체를 onPptChange에 전달"

# ── 상태: imageFiles ──
assert_contains public/js/constants.js "let imageFiles = [];" "U8-2a: imageFiles 전역 상태 존재"
assert_contains public/js/constants.js "const MAX_IMAGE_UPLOAD_COUNT = 30;" "U8-2b: 이미지 업로드 최대 장수 상수 존재"

# ── 상호 배타 (문서 슬롯: pptFile ↔ imageFiles) ──
assert_contains public/js/pptx_parser.js "imageFiles = list;" "U8-3a: 다중 이미지 선택 시 imageFiles에 저장"
assert_contains public/js/pptx_parser.js "pptFile = null;" "U8-3b: 이미지 선택 시 기존 pptFile 클리어"
assert_contains public/js/pptx_parser.js "imageFiles = [];  // mutual exclusion" "U8-3c: pptx/pdf/docx 선택 시 기존 imageFiles 클리어"
assert_contains public/js/pptx_parser.js "const hasDoc = !!pptFile || imageFiles.length > 0;" "U8-3d: checkReady가 imageFiles도 문서 슬롯으로 인정"
assert_contains public/js/note_creation.js "if (!pptFile && !imageFiles.length && !txtFiles.some(s => s.file !== null)) return;" "U8-3e: 분석 시작 게이트가 imageFiles만 있어도 통과"

# ── 검증: 여러 파일은 전부 이미지여야 함, 장수 제한 ──
assert_contains public/js/pptx_parser.js "if (!list.every(isImageUploadFile))" "U8-4a: 다중 파일 선택 시 전부 이미지인지 검증"
assert_contains public/js/pptx_parser.js "if (list.length > MAX_IMAGE_UPLOAD_COUNT)" "U8-4b: 이미지 장수 상한 초과 시 토스트"

# ── 비전 전사 호출 (image_gallery.js 콜 shape 재사용: feature:'vision', idToken) ──
assert_contains public/js/pptx_parser.js "async function extractImagesText(files)" "U8-5a: extractImagesText 함수 존재"
assert_contains public/js/pptx_parser.js "async function transcribeImageBatch(items)" "U8-5b: 배치 비전 전사 함수 존재"
assert_contains public/js/pptx_parser.js "feature: 'vision'" "U8-5c: 비전 호출이 feature:'vision'로 /api/claude 재사용"
assert_contains public/js/pptx_parser.js "model: 'claude-haiku-4-5-20251001'" "U8-5d: 전사는 haiku 모델 사용 (비용 절감)"
assert_contains public/js/pptx_parser.js "헤더로 시작하세요" "U8-5e: 프롬프트가 각 이미지에 [페이지 N] 헤더를 명시적으로 지정"

# ── 실패 구제: 개별 이미지 실패는 계속, 전부 실패면 throw ──
assert_contains public/js/pptx_parser.js "(이미지 인식 실패)" "U8-6a: 개별 이미지 전사 실패 시 플레이스홀더 삽입"
assert_contains public/js/pptx_parser.js "if (failCount === downscaled.length)" "U8-6b: 전부 실패 시에만 throw"
assert_contains public/js/pptx_parser.js "if (e.name === 'AbortError') throw e;" "U8-6c: AbortError는 항상 재전파"

# ── 갤러리 연동 (imgs shape → renderImageGallery → 인용칩/오버레이) ──
assert_contains public/js/note_creation.js "const { pptText, imgs } = await extractImagesText(imageFiles);" "U8-7a: 이미지 전사 결과로 storedPptText + imgs 획득"
assert_contains public/js/note_creation.js "renderImageGallery(imgs);" "U8-7b: 이미지 업로드 경로도 renderImageGallery로 갤러리 채움 (인용칩 연동)"
assert_contains public/js/pptx_parser.js "slideNumber: i + 1," "U8-7c: 이미지 imgs 배열의 페이지 번호가 선택 순서(1..N)"

# ── 파이프라인 무변경: 기존 정규식이 [페이지 N]도 매치 ──
assert_contains public/js/pipeline.js '/\[(?:슬라이드|페이지) (\d+)\]([\s\S]*?)(?=\[(?:슬라이드|페이지) \d+\]|$)/g' "U8-8a: agent1 slideMatch 정규식이 [페이지 N] 헤더도 매치 (파이프라인 무변경 확인)"

# ── 배치 모드는 v1 범위 밖 ──
assert_contains public/js/pptx_parser.js "Single-note only; see note_creation.js." "U8-9a: 이미지 업로드는 단일노트 전용 (배치 미지원) ponytail 코멘트"
assert_contains public/index.html 'id="batchPptInput" accept=".pptx,.pdf,.docx"' "U8-9b: batchPptInput은 변경 없음 (이미지 미지원 유지)"

# ── 캐시버스트 ──
assert_contains public/index.html "/js/pptx_parser.js?v=u8image" "U8-10a: pptx_parser.js 캐시버스트 갱신"
assert_contains public/index.html "/js/note_creation.js?v=u8image" "U8-10b: note_creation.js 캐시버스트 갱신"
assert_contains public/index.html "/js/constants.js?v=u8image" "U8-10c: constants.js 캐시버스트 갱신"
assert_contains public/index.html "/js/main_inline.js?v=u8image" "U8-10d: main_inline.js 캐시버스트 갱신"
