// Single-note analysis flow — analyzeBtn handler body.
// Depends on: constants.js (pptFile, txtFiles, storedPptText, storedFilteredText, storedNotesText, storedHighlightedTranscript, extractedImages, currentUser, isRunning, abortController, _batchRunning, _batchProgress, _batchBuddyVisible, _currentView, _notesCollapsed, resultsEl, analyzeBtn, quizBtn, classifyBtn, notionCopyBtn, dlNotionFileBtn, copyNotesBtn, dlTxtBtn, dlMdBtn, dlPdfBtn, splitViewBtn, REC_ORDINALS, _lastGenerationError, debugLog), pptx_parser.js, image_gallery.js (renderImageGallery), ui.js, pipeline.js (runAgentPipeline), firestore_sync.js (autoSaveNote, incrementUsage).

async function runSingleNoteAnalysis() {
  if (!currentUser) { showToast('🔑 로그인 후 이용할 수 있습니다.'); return; }
  const usageCheck = await canAnalyze();
  if (!usageCheck.allowed) {
    showPaymentModal();
    return;
  }
  if (isRunning) return;  // double-click guard
  const apiKey = 'server-proxied';
  if (!pptFile) return;

  isRunning = true;
  abortController = new AbortController();

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

    analyzeBtn.textContent = '⏳ AI 에이전트 실행 중… (Sonnet 작성 → Sonnet 비평 → Haiku 수정)';
    setProgress(20, 'AI 노트 작성·검토 시작…');
    await runAgentPipeline(apiKey);

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

    // Auto-save to IndexedDB
    autoSaveNote().catch(e => { console.error('autoSaveNote:', e); showToast(`❌ 자동 저장 실패: ${e.message}`); });
    await incrementUsage();

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
