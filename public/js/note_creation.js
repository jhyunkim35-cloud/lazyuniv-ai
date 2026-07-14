// Single-note analysis flow — analyzeBtn handler body.
// Depends on: constants.js (pptFile, imageFiles, txtFiles, storedPptText, storedFilteredText, storedNotesText, storedHighlightedTranscript, extractedImages, currentUser, isRunning, abortController, _batchRunning, _batchProgress, _batchBuddyVisible, _currentView, _notesCollapsed, resultsEl, analyzeBtn, quizBtn, classifyBtn, notionCopyBtn, dlNotionFileBtn, copyNotesBtn, dlTxtBtn, dlMdBtn, dlPdfBtn, splitViewBtn, REC_ORDINALS, _lastGenerationError, debugLog), pptx_parser.js (extractImagesText, U8), image_gallery.js (renderImageGallery), ui.js, pipeline.js (runAgentPipeline), notes_crud.js (draftSaveNote, autoSaveNote), payment.js (canAnalyze, showPaymentModal).

async function runSingleNoteAnalysis() {
  if (!currentUser) { showToast('🔑 로그인 후 이용할 수 있습니다.'); return; }
  const usageCheck = await canAnalyze();
  if (!usageCheck.allowed) {
    showPaymentModal();
    return;
  }
  if (isRunning) return;  // double-click guard
  const apiKey = 'server-proxied';
  // U1: allow transcript-only analysis — PPT/PDF is now optional as long as
  // at least one transcript slot is filled. U8: image upload also fills the
  // document slot.
  if (!pptFile && !imageFiles.length && !txtFiles.some(s => s.file !== null)) return;

  // A new single-mode analysis always produces a NEW note. Clear currentNoteId
  // so autoSaveNote generates a fresh id instead of reusing the id of whatever
  // note was last saved or opened. Without this, the second (and every later)
  // analysis saved under the previous note's id and overwrote it — which is
  // why only the most recent note survived in the home list.
  currentNoteId = null;

  isRunning = true;
  abortController = new AbortController();

  // Keep the screen awake during the long streaming generation so a mobile
  // auto-lock doesn't suspend the page and kill the request mid-stream.
  acquireWakeLock();
  _genWasHidden = false;
  if (isMobileDevice()) showToast('📱 생성 중에는 화면을 켜두세요 — 화면을 벗어나면 중단될 수 있어요.');

  // Reuse buddy system so user can navigate away freely
  _batchRunning      = true;
  _batchProgress     = { done: 0, total: 1 };
  _batchBuddyVisible = false;
  const _singleGoHomeRow = document.getElementById('batchGoHomeRow');
  if (_singleGoHomeRow) _singleGoHomeRow.style.display = '';

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = '⏳ 파일 처리 중…';

  const cancelBtn = document.getElementById('cancelBtn');
  cancelBtn.classList.add('visible');

  // disable download buttons until notes are ready
  [quizBtn, classifyBtn, notionCopyBtn, dlNotionFileBtn, copyNotesBtn, dlTxtBtn, dlMdBtn, dlPdfBtn, splitViewBtn].forEach(b => { b.disabled = true; });
  const _dbgBtnReset = document.getElementById('splitDebugBtn');
  if (_dbgBtnReset) _dbgBtnReset.style.display = 'none';
  _lastGenerationError = '';

  resultsEl.classList.add('visible');
  document.getElementById('agentSection').classList.add('visible');
  document.getElementById('notesActions').classList.remove('visible');
  document.getElementById('finalNotesBody').innerHTML = '<span class="placeholder-msg">분석 대기 중…</span>';
  const notesBody2 = document.getElementById('finalNotesBody');
  notesBody2.style.maxHeight = '';
  notesBody2.style.overflow  = '';
  notesBody2.style.padding   = '';
  _notesCollapsed = false;
  const collapseBtnEl = document.getElementById('collapseBtn');
  collapseBtnEl.textContent = '▲ 접기';
  collapseBtnEl.classList.remove('visible');
  clearQuizInlineArea();

  // scroll results into view
  setTimeout(() => resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);

  // Reset image state so a PDF re-run never shows stale PPTX gallery data
  renderImageGallery([]);

  try {
    if (pptFile) {
      setProgress(5, '파일 읽는 중…');
      const pptText = await extractPresentationText(pptFile);
      storedPptText = pptText;

      // Extract images from PPTX or PDF and render gallery
      if (pptFile.name.toLowerCase().endsWith('.pptx')) {
        setProgress(8, '슬라이드 이미지 추출 중…');
        const imgs = await extractPptxImages(pptFile);
        renderImageGallery(imgs);
        if (imgs.length) agentLog(0, `슬라이드 이미지 ${imgs.length}개 발견`);
      } else if (pptFile.name.toLowerCase().endsWith('.pdf')) {
        setProgress(8, 'PDF 페이지 이미지 렌더링 중…');
        const imgs = await extractPdfPageImages(pptFile);
        renderImageGallery(imgs);
        if (imgs.length) agentLog(0, `PDF 페이지 이미지 ${imgs.length}개 렌더링`);
      }
      // .docx has no images to extract — falls through here with none, which is fine.
    } else if (imageFiles.length) {
      // U8: standalone image upload (photos of slides/handwritten notes) — transcribe
      // via vision into [페이지 N] blocks so the rest of the pipeline is unaware
      // the document didn't come from a deck.
      setProgress(5, `이미지 텍스트 인식 중… (${imageFiles.length}장)`);
      const { pptText, imgs } = await extractImagesText(imageFiles);
      storedPptText = pptText;
      renderImageGallery(imgs);
      agentLog(0, `이미지 ${imageFiles.length}장 텍스트 인식 완료`);
    } else {
      // U1: transcript-only — no PPT/PDF to parse, no images to extract.
      storedPptText = '';
      setProgress(5, '녹취록 전용 모드 — PPT 없음');
    }

    const recFiles = txtFiles.filter(s => s.file !== null);
    if (recFiles.length > 0) {
      setProgress(10, `녹취록 ${recFiles.length}개 병합 중…`);
      const parts = [];
      for (let i = 0; i < recFiles.length; i++) {
        agentLog(0, `${REC_ORDINALS[i] ?? (i+1)+'교시'} 녹취록 읽는 중… (${recFiles[i].file.name})`);
        parts.push((await recFiles[i].file.text()).trim());
      }
      const merged = parts.join('\n\n');
      agentLog(0, `녹취록 ${recFiles.length}개 병합 완료 — 총 ${merged.length.toLocaleString()}자`);

      setProgress(12, '화자 분리 중…');
      const professorNum = parseInt(document.getElementById('professorNum').value) || 1;
      const separated    = separateSpeakers(merged, professorNum);

      setProgress(15, '화자 분리 완료…');
      storedFilteredText = separated.text;
    } else {
      setProgress(15, 'PPT 전용 모드 — 녹취록 없음');
      storedFilteredText = '';
    }

    analyzeBtn.textContent = '⏳ AI 에이전트 실행 중… (Sonnet 작성 → Haiku 비평 → Haiku 수정)';
    setProgress(20, 'AI 노트 작성·검토 시작…');
    await runAgentPipeline(apiKey);

    // U17: persist high-conf deixis annotations back onto their source transcript
    // records (display layer for the preview modal). Fire-and-forget; text untouched.
    // Runs whenever the deixis stage produced a result — INCLUDING an empty one —
    // so a re-analysis with a different deck overwrites stale annotations instead
    // of leaving old slide citations behind.
    if (typeof storedDeixisRan !== 'undefined' && storedDeixisRan) {
      // Anchor against the RAW stored text (threaded by transcripts_view), not the
      // speaker-names-applied analysis text — the preview modal anchors in raw
      // t.text, so anything validated on a different form would silently never render.
      const rawTexts = [];
      for (const s of recFiles) {
        try { rawTexts.push(typeof s.file._rawText === 'string' ? s.file._rawText : await s.file.text()); }
        catch (e) { rawTexts.push(''); console.warn('[deixis] raw read failed:', e); }
      }
      for (let i = 0; i < recFiles.length; i++) {
        try {
          const tid = recFiles[i].file._transcriptId;
          if (!tid) continue;
          // Unambiguous attribution: the quote must anchor exactly once in THIS
          // file and nowhere in any sibling file of the same run.
          const mine = assignAnnotationsToRecordText(storedDeixisAnnotations, rawTexts[i])
            .filter(a => rawTexts.every((t2, j) => j === i || _countOccurrences(t2, a.q) === 0));
          saveDeixisAnnotationsFS(tid, mine).catch(e => console.warn('[deixis] save failed:', e));
        } catch (e) {
          console.warn('[deixis] annotation loop failed:', e);
        }
      }
    }

    setProgress(100, '완료!');
    setTimeout(() => setProgress(null), 800);

    // Single note done — celebrate on buddy if user navigated away, then clean up
    _batchRunning = false;
    const _sBuddy  = document.getElementById('batchBuddy');
    const _sSpeech = document.getElementById('batchBuddySpeech');
    const _sChar   = document.getElementById('batchBuddyChar');
    if (_batchBuddyVisible && _sBuddy) {
      if (_sSpeech) _sSpeech.textContent = '✅ 완료!';
      if (_sChar)   { _sChar.classList.remove('working'); _sChar.classList.add('done'); }
      setTimeout(() => { _sBuddy.style.display = 'none'; _batchBuddyVisible = false; }, 3000);
      if (_currentView === 'home') showToast('✅ 노트 생성 완료!');
    } else {
      _batchBuddyVisible = false;
      updateBatchBuddy();
    }

    // Q5: silent draft save FIRST — before the name/folder modal — so a tab
    // close between "generation done" and "user confirmed the modal" can't
    // lose the note (worst case: it survives under the auto title in
    // 미분류). autoSaveNote() then finalizes the SAME note id with the
    // user's chosen title/folder (or keeps the auto title on cancel —
    // unchanged prior behavior).
    await draftSaveNote().catch(e => console.error('draftSaveNote:', e));
    autoSaveNote().catch(e => { console.error('autoSaveNote:', e); showToast(`❌ 자동 저장 실패: ${e.message}`); });
    // Usage is now incremented server-side by /api/claude on first call.

    // Auto-open split viewer after pipeline completes — wait two rAF ticks so the
    // DOM has fully flushed before the split viewer tries to read slide data.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const splitBtn = document.getElementById('splitViewBtn');
    if (splitBtn && !splitBtn.disabled) splitBtn.click();

  } catch (err) {
    if (err.name === 'AbortError') {
      showToast('분석이 취소되었습니다.');
    } else {
      console.error(err);
      _lastGenerationError = `[${new Date().toISOString()}] ${err.name}: ${err.message}`;
      showToast(`❌ 오류: ${err.message}`);
    }
    setProgress(null);
  } finally {
    isRunning = false;
    abortController = null;
    releaseWakeLock();
    _genWasHidden = false;
    // Clean up buddy state on error/abort (success path already cleared _batchRunning)
    if (_batchRunning) {
      _batchRunning      = false;
      _batchBuddyVisible = false;
      updateBatchBuddy();
    }
    const _fGoHomeRow = document.getElementById('batchGoHomeRow');
    if (_fGoHomeRow) _fGoHomeRow.style.display = 'none';
    analyzeBtn.textContent = '✨ AI 분석 시작';
    cancelBtn.classList.remove('visible');
    checkReady();
  }
}
