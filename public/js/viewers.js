// Split-view panels and PDF popup.
// Depends on: constants.js (extractedImages, recommendedSlides, currentNoteId, storedHighlightedTranscript, storedFilteredText, storedNotesText, _accordionOpenLabels, _classifyCache, debugLog), markdown.js (escHtml), ui.js (showSuccessToast, showToast), image_gallery.js (insertImagesInline), quiz.js (launchQuiz, clearQuizInlineArea, classifyNoteContent, renderClassifyArea), firestore_sync.js (saveNoteFS, getNoteFS).

function populateSplitImagePanel() {
  const panel  = document.getElementById('splitImagePanel');
  const grid   = document.getElementById('splitImageGrid');
  const countEl  = document.getElementById('splitImageCount');
  const insertBtn = document.getElementById('splitImageInsertBtn');
  if (!panel || !grid) return;

  if (!extractedImages.length) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';
  grid.innerHTML = '';

  const sortedImages = [...extractedImages].sort((a, b) => a.slideNumber - b.slideNumber);
  const seen = new Set();
  for (const img of sortedImages) {
    if (seen.has(img.slideNumber)) continue;
    seen.add(img.slideNumber);

    const item = document.createElement('div');
    item.className = 'img-pick-item';
    item.dataset.slide = String(img.slideNumber);

    const thumbImg = document.createElement('img');
    thumbImg.src = getImgSrc(img);
    thumbImg.style.cssText = 'width:120px; height:90px; object-fit:cover; border-radius:4px; display:block;';

    const label = document.createElement('div');
    label.style.cssText = 'text-align:center; font-size:0.72rem; color:var(--text-muted); padding:2px;';
    label.textContent = `슬라이드 ${img.slideNumber}`;

    item.append(thumbImg, label);
    item.addEventListener('click', () => {
      item.classList.toggle('selected');
      const selCount = grid.querySelectorAll('.img-pick-item.selected').length;
      countEl.textContent = selCount ? `${selCount}장 선택됨` : '';
      insertBtn.style.display = selCount ? '' : 'none';
    });
    grid.appendChild(item);
  }

  // Header toggle
  document.getElementById('splitImageHeader').onclick = () => {
    const hidden = grid.style.display === 'none';
    grid.style.display = hidden ? 'flex' : 'none';
    document.getElementById('splitImageToggle').innerHTML = hidden
      ? '<i data-lucide="chevron-up" class="icon-xs"></i>'
      : '<i data-lucide="chevron-down" class="icon-xs"></i>';
  };

  // Insert button
  insertBtn.onclick = async () => {
    const selected = Array.from(grid.querySelectorAll('.img-pick-item.selected'));
    if (!selected.length) return;

    const selectedSlides = selected.map(el => parseInt(el.dataset.slide));
    const prevRecommended = recommendedSlides.slice();
    recommendedSlides = selectedSlides;

    const splitNotes = document.getElementById('splitNotes');
    insertImagesInline(splitNotes);

    recommendedSlides = prevRecommended;

    selected.forEach(el => el.classList.remove('selected'));
    countEl.textContent = '';
    insertBtn.style.display = 'none';
    switchSplitTab('notes');

    // Persist the updated HTML (with images) back to IndexedDB
    if (currentNoteId) {
      try {
        const existing = await getNoteFS(currentNoteId);
        if (existing) {
          const prevInserted = existing.insertedSlideNumbers || [];
          const merged = [...new Set([...prevInserted, ...selectedSlides])].sort((a, b) => a - b);
          await saveNoteFS(Object.assign({}, existing, {
            notesHtml:            splitNotes.innerHTML,
            insertedSlideNumbers: merged,
          }));
          showSuccessToast('💾 저장 업데이트됨');
        }
      } catch (e) {
        console.error('Image insert save error:', e);
        showToast(`❌ 저장 실패: ${e.message}`);
      }
    } else {
      showSuccessToast(`${selectedSlides.length}장 삽입 완료`);
    }
  };
}

function switchSplitTab(tab) {
  const _sqArea = document.getElementById('quizInlineArea');
  if (_sqArea && _sqArea._quizApi) _sqArea._quizApi.savePartialIfEligible();
  // Quiz/classify tabs: only activate if notes are available
  if ((tab === 'quiz' || tab === 'classify') && !storedNotesText) return;

  document.querySelectorAll('#splitTabs .split-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  const notesEl      = document.getElementById('splitNotes');
  const transcriptEl = document.getElementById('splitTranscript');
  const accordionEl  = document.getElementById('splitAccordion');
  const quizAreaEl   = document.getElementById('quizInlineArea');
  const classifyEl   = document.getElementById('classifyArea');

  notesEl.style.display      = tab === 'notes'      ? 'flex'  : 'none';
  transcriptEl.style.display = tab === 'transcript' ? 'flex'  : 'none';
  accordionEl.style.display  = tab === 'accordion'  ? 'block' : 'none';
  quizAreaEl.style.display   = tab === 'quiz'       ? 'flex'  : 'none';
  classifyEl.style.display   = tab === 'classify'   ? 'flex'  : 'none';

  if (tab === 'transcript' && !transcriptEl.innerHTML.trim()) {
    if (storedHighlightedTranscript) {
      transcriptEl.innerHTML = `<div class="transcript-content">${storedHighlightedTranscript}</div>`;
    } else if (storedFilteredText) {
      transcriptEl.innerHTML = `<div class="transcript-content">${escHtml(storedFilteredText)}</div>`;
    } else {
      transcriptEl.innerHTML = '<span class="placeholder-msg">녹취록이 없습니다.</span>';
    }
  }

  if (tab !== 'accordion') {
    // Save open state before leaving accordion tab
    _accordionOpenLabels = new Set(
      Array.from(accordionEl.querySelectorAll('.acc-section.open .acc-header'))
        .map(h => h.textContent.trim())
    );
  }

  if (tab === 'accordion' && !accordionEl.innerHTML.trim()) {
    accordionEl.innerHTML = notesEl.innerHTML.trim()
      ? buildAccordionView(notesEl)
      : '<span class="placeholder-msg">노트가 없습니다.</span>';
    if (_accordionOpenLabels.size) {
      accordionEl.querySelectorAll('.acc-header').forEach(h => {
        const sec = h.closest('.acc-section');
        if (sec) {
          if (_accordionOpenLabels.has(h.textContent.trim())) sec.classList.add('open');
          else sec.classList.remove('open');
        }
      });
    }
    if (currentNoteId) _attachAccordionSrsButtons(accordionEl, currentNoteId);
  }

  // Refresh weakness badges whenever notes tab is shown
  if (tab === 'notes' && currentNoteId) {
    updateNoteWeaknessBadges(currentNoteId).catch(() => {});
  }

  // Launch quiz settings when switching to quiz tab (only if area is empty)
  if (tab === 'quiz' && !quizAreaEl.innerHTML.trim()) {
    launchQuiz();
  }

  // Classify tab: use cache or fetch from API
  if (tab === 'classify') {
    const noteId = currentNoteId;
    // Invalidate cache when a different note is active
    if (_classifyCache && _classifyCache.noteId !== noteId) {
      _classifyCache = null;
      classifyEl.innerHTML = '';
    }
    if (_classifyCache) {
      // Already rendered — nothing to do (content persists in the DOM)
      return;
    }
    if (classifyEl.innerHTML.trim()) return; // currently loading, don't re-trigger

    // Show loading spinner
    classifyEl.innerHTML = `<div class="quiz-inline-loading"><span class="qi-spinner"></span><span>분류 분석 중…</span></div>`;

    classifyNoteContent(storedNotesText)
      .then(items => {
        _classifyCache = { noteId, items };
        renderClassifyArea(items);
      })
      .catch(err => {
        classifyEl.innerHTML = `<span class="placeholder-msg" style="color:#ef4444;">오류: ${escHtml(err.message)}</span>`;
        _classifyCache = null;
      });
  }
}

function buildAccordionView(sourceEl) {
  const container = sourceEl.querySelector('.md-content') || sourceEl;
  const nodes = Array.from(container.childNodes);

  let html = '';
  let h1Section = null; // { label, body }
  let h2Section = null; // { label, body }

  function closeH2() {
    if (!h2Section) return;
    const content = h2Section.body || '';
    const h2Html = `<div class="acc-sub open">` +
      `<div class="acc-sub-header" onclick="this.closest('.acc-sub').classList.toggle('open')">► ${h2Section.label}</div>` +
      `<div class="acc-sub-body">${content}</div>` +
      `</div>`;
    if (h1Section) h1Section.body += h2Html;
    else html += h2Html;
    h2Section = null;
  }

  function closeH1() {
    closeH2();
    if (!h1Section) return;
    html += `<div class="acc-section open">` +
      `<div class="acc-header" onclick="this.closest('.acc-section').classList.toggle('open')">${h1Section.label}</div>` +
      `<div class="acc-body">${h1Section.body}</div>` +
      `</div>`;
    h1Section = null;
  }

  for (const node of nodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toLowerCase();

    if (tag === 'h1') {
      closeH1();
      h1Section = { label: node.innerHTML, body: '' };
    } else if (tag === 'h2') {
      closeH2();
      h2Section = { label: node.innerHTML, body: '' };
    } else if (tag === 'hr') {
      // skip
    } else {
      const content = node.outerHTML;
      if (h2Section) h2Section.body += content;
      else if (h1Section) h1Section.body += content;
      else html += content;
    }
  }
  closeH1();

  return html || '<span class="placeholder-msg">내용이 없습니다.</span>';
}

function openPdfPopup(bodyEl) {
  const contentEl = bodyEl.querySelector('.md-content') || bodyEl;
  const titleEl = contentEl.querySelector('h1');
  const pageTitle = titleEl ? titleEl.textContent.trim() : '통합 학습 노트';

  debugLog('PDF', 'Opening print-ready page');

  const win = window.open('', '_blank');
  if (!win) {
    showToast('⚠️ 팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.');
    return;
  }

  // Clone content and convert base64 images to blob URLs to avoid megabytes in document.write
  const cloned = contentEl.cloneNode(true);
  cloned.querySelectorAll('img[src^="data:"]').forEach(img => {
    try {
      const [header, b64] = img.src.split(',');
      const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      img.src = URL.createObjectURL(new Blob([arr], { type: mime }));
    } catch(e) {}
  });

  win.document.write(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <title>${pageTitle}</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap" rel="stylesheet" />
  <style>
    * { font-family: 'Noto Sans KR', 'Segoe UI', 'Apple SD Gothic Neo', sans-serif; box-sizing:border-box; margin:0; padding:0; color:#1a1a1a; }
    body { background:#fff; font-size:11pt; line-height:1.8; padding:1.5cm 2cm; max-width:21cm; margin:0 auto; }
    h1 { font-size:18pt; font-weight:700; border-bottom:2px solid #333; padding-bottom:0.4em; margin:0 0 1em; }
    h2 { font-size:14pt; font-weight:700; border-bottom:1px solid #ccc; padding-bottom:0.25em; margin:1.8em 0 0.6em; }
    h3 { font-size:12pt; font-weight:700; margin:1.4em 0 0.4em; }
    p { margin:0.4em 0; }
    p:empty { margin:0.15em 0; }
    ul, ol { padding-left:1.6em; margin:0.3em 0 0.5em; }
    li { margin:0.2em 0; }
    strong { font-weight:700; }
    em { font-style:italic; }
    hr { border:none; border-top:1px solid #ccc; margin:1.4em 0; }
    code { font-family:'Courier New',monospace; font-size:10pt; background:#f3f4f6; padding:0.1em 0.4em; border-radius:3px; }
    blockquote { border-left:3px solid #7c4dff; margin:0.5em 0; padding:0.4em 0.8em; background:#f5f3ff; border-radius:0 4px 4px 0; }
    blockquote p { margin:0.15em 0; color:#555; }
    table { width:auto; border-collapse:collapse; margin:0.8em 0; font-size:10pt; }
    th, td { border:1px solid #999; padding:0.3em 0.6em; text-align:left; }
    th { background:#e8e8e8; font-weight:700; }
    .highlight-important { background:#fff3cd; color:#856404; border:1px solid #ffc107; padding:0.1em 0.35em; border-radius:3px; }
    figure { margin:1.2em 0; page-break-inside:avoid; }
    .inserted-slide-img { width:100%; max-width:100%; border:1px solid #ddd; border-radius:4px; }
    .inserted-slide-caption { font-size:9pt; color:#666; text-align:center; margin-top:0.3em; }
    #printBar { position:fixed; top:0; left:0; right:0; background:#f0f0f0; border-bottom:2px solid #ccc; padding:8px 16px; display:flex; align-items:center; gap:12px; z-index:9999; }
    #printBar button { padding:6px 16px; font-size:10pt; font-weight:600; border:none; border-radius:4px; cursor:pointer; }
    #printBtn { background:#2563eb; color:#fff; }
    #printBtn:hover { background:#1d4ed8; }
    #closeBtn { background:#e5e7eb; color:#333; }
    #closeBtn:hover { background:#d1d5db; }
    body { padding-top:calc(1.5cm + 44px); }
    @media print {
      #printBar { display:none !important; }
      body { padding:0; padding-top:0; }
      h2, h3 { page-break-after:avoid; }
      ul, ol, p { page-break-inside:avoid; }
      figure { page-break-inside:avoid; }
      table, th, td { border:1px solid #333 !important; }
      th { background:#e0e0e0 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      .highlight-important { background:#fff3cd !important; color:#856404 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      .inserted-slide-img { max-width:100% !important; }
    }
  </style>
</head>
<body>
  <div id="printBar">
    <button id="printBtn" onclick="window.print()">📄 PDF로 저장 (Ctrl+P)</button>
    <button id="closeBtn" onclick="window.close()">✕ 닫기</button>
    <span style="font-size:9pt; color:#666;">인쇄 대화상자에서 'PDF로 저장'을 선택하세요</span>
  </div>
  ${cloned.innerHTML}
</body>
</html>`);
  win.document.close();
  debugLog('PDF', 'Print-ready page opened');
}

function _accSrsToday() {
  const d = new Date();
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

async function _attachAccordionSrsButtons(container, noteId) {
  if (!noteId || typeof cardIdFor !== 'function' || typeof saveSrsCard !== 'function') return;
  let folderId = '';
  try {
    const note = await getNoteFS(noteId);
    if (note) folderId = note.folderId || '';
  } catch (e) {}

  container.querySelectorAll('.acc-sub-header').forEach(header => {
    const raw = header.textContent || '';
    const sectionTitle = raw.replace(/^[►▶]\s*/, '').trim();
    if (!sectionTitle) return;

    const cardId = cardIdFor(folderId, noteId, sectionTitle);
    const btn = document.createElement('button');
    btn.className = 'srs-add-btn';
    btn.textContent = '+ 복습 추가';

    const setActive = () => {
      btn.textContent = '✓ 복습 중';
      btn.disabled = true;
      btn.classList.add('active');
    };

    if (typeof getSrsCard === 'function') {
      getSrsCard(cardId).then(existing => {
        if (existing) {
          setActive();
        } else {
          btn.addEventListener('click', async e => {
            e.stopPropagation();
            await saveSrsCard({
              id: cardId, folderId, noteId, sectionTitle,
              nextReviewDate: _accSrsToday(),
              interval: 0, repetitions: 0, easeFactor: 2.5,
            }).catch(() => {});
            setActive();
            if (typeof showToast === 'function') showToast('✓ 복습 카드에 추가됨');
          });
        }
      }).catch(() => {
        btn.addEventListener('click', async e => {
          e.stopPropagation();
          await saveSrsCard({
            id: cardId, folderId, noteId, sectionTitle,
            nextReviewDate: _accSrsToday(),
            interval: 0, repetitions: 0, easeFactor: 2.5,
          }).catch(() => {});
          setActive();
          if (typeof showToast === 'function') showToast('✓ 복습 카드에 추가됨');
        });
      });
    }

    header.appendChild(btn);
  });
}
