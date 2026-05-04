// Home view: note card grid, folder cards, drag-reorder, sidebar folders, filter.
// Depends on: constants.js (_activeFolderId, _bulkSelectMode, _selectedNoteIds, _noteDrag, _currentView, currentNoteId), firestore_sync.js (getAllNotesFS, getAllFoldersFS, getNoteFS, saveNote, userNotesRef, getNextSortOrder, updateNoteOrderFS, getStorageSize), ui.js (showToast, switchView), markdown.js (escHtml, renderMarkdown), notes_crud.js (openSavedNote, renameSavedNote, moveSavedNote, confirmDeleteNote, fmtDate), folders.js (showFolderEditModal, deleteFolderFS, renameFolderPrompt).

/* ═══════════════════════════════════════════════
   Home view — note card grid
═══════════════════════════════════════════════ */
function buildFolderCard(folder, noteCount) {
  const card = document.createElement('div');
  card.className = 'folder-card';
  card.dataset.folderId = folder.id;
  const colorDot = folder.color
    ? `<span class="folder-color-dot" style="background:${folder.color};width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:0.3rem;vertical-align:middle;"></span>`
    : '';
  // Optional D-day badge from exam_plan.js — only shown when this folder
  // has an examPlan registered. Safe-noop if exam_plan.js hasn't loaded.
  const examBadge = (folder.examPlan && typeof examPlanBadgeHtml === 'function')
    ? examPlanBadgeHtml(folder.examPlan, noteCount)
    : '';
  card.innerHTML = `
    <div class="folder-card-icon"><i data-lucide="folder"></i></div>
    <div class="folder-card-info">
      <div class="folder-card-name">${colorDot}${escHtml(folder.name)}${examBadge}<span class="srs-due-badge" style="display:none"></span></div>
      <div class="folder-card-count">${noteCount}개의 노트</div>
    </div>
    <div class="folder-card-actions">
      <button title="이름 변경"><i data-lucide="pencil"></i></button>
      <button title="삭제"><i data-lucide="trash-2"></i></button>
    </div>`;
  const [renameBtn, deleteBtn] = card.querySelectorAll('.folder-card-actions button');
  // Async SRS due badge — only for folders with an exam plan; populated after card is returned
  if (folder.examPlan && typeof getDueCards === 'function') {
    const d = new Date();
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    getDueCards(folder.id, ymd).then(dueCards => {
      if (!dueCards.length) return;
      const badgeEl = card.querySelector('.srs-due-badge');
      if (badgeEl) {
        badgeEl.textContent = `오늘 복습 ${dueCards.length}개`;
        badgeEl.style.display = '';
        badgeEl.style.cursor = 'pointer';
        badgeEl.title = '복습 시작';
        badgeEl.addEventListener('click', e => {
          e.stopPropagation();
          if (typeof enterReviewMode === 'function') enterReviewMode(folder.id);
        });
      }
    }).catch(() => {});
  }
  renameBtn.addEventListener('click', e => { e.stopPropagation(); showFolderEditModal(folder.id, folder.name, folder.color || null); });
  deleteBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm('폴더를 삭제하시겠습니까? (폴더 내 노트는 미분류로 이동됩니다)')) return;
    await deleteFolderFS(folder.id);
    renderHomeView();
  });

  // ── Accept note drops (Pointer Events — matches attachNoteDrag system) ──────
  card.addEventListener('pointerenter', () => {
    if (_noteDrag && _noteDrag.noteId) card.classList.add('folder-drag-over');
  });
  card.addEventListener('pointerleave', () => {
    card.classList.remove('folder-drag-over');
  });
  card.addEventListener('pointerup', async () => {
    if (_noteDrag && _noteDrag.noteId) {
      const noteId = _noteDrag.noteId;
      card.classList.remove('folder-drag-over');
      await moveNoteToFolder(noteId, folder.id);
      await renderHomeView();
    }
  });

  card.addEventListener('click', () => filterByFolder(folder.id));
  return card;
}

async function moveNoteToFolder(noteId, folderId) {
  const note = await getNoteFS(noteId);
  if (!note) return;
  const newSortOrder = await getNextSortOrder(folderId, noteId);
  const updated = Object.assign({}, note, { folderId, sortOrder: newSortOrder });
  // Use saveNote (IndexedDB only) — avoids re-uploading slide images via saveNoteFS
  await saveNote(updated);
  // Firestore: update only the changed fields — use safeNotePartialUpdate so a
  // missing Firestore doc cannot be auto-created with `set merge` (ghost note).
  const { updatedAt } = updated;
  try {
    await safeNotePartialUpdate(noteId, { folderId, sortOrder: newSortOrder, updatedAt });
  } catch (e) {
    console.warn('Firestore folder move sync failed:', e);
  }
  showToast(`📁 노트를 폴더로 이동했습니다`);
}

async function renderHomeView(filteredNotes, activeQuery = '') {
  // Show skeleton while loading
  const allGrid    = document.getElementById('allNotesGrid');
  const recentGrid = document.getElementById('recentNotesGrid');
  if (allGrid && !allGrid.querySelector('.note-card,.folder-card')) {
    allGrid.innerHTML = Array(4).fill(
      '<div class="skeleton-card"><div class="skeleton-line short"></div><div class="skeleton-line medium"></div><div class="skeleton-line long"></div><div class="skeleton-line short"></div></div>'
    ).join('');
  }

  const [notes, folders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
  const folderMap      = Object.fromEntries(folders.map(f => [f.id, f.name]));
  const folderColorMap = Object.fromEntries(folders.map(f => [f.id, f.color || null]));

  // Determine which notes to show
  let displayNotes = filteredNotes !== undefined ? filteredNotes : notes;
  const isHomeView   = !_activeFolderId;             // null → home (unfiled + folder cards)
  const isFolderView = _activeFolderId && _activeFolderId !== 'none'; // specific folder UUID

  if (_activeFolderId === 'none') {
    displayNotes = displayNotes.filter(n => !n.folderId);
  } else if (isFolderView) {
    displayNotes = displayNotes.filter(n => n.folderId === _activeFolderId);
  } else {
    // Home view: show only unfiled notes (filed notes live inside folder cards)
    displayNotes = displayNotes.filter(n => !n.folderId);
  }

  // Gamification streak/XP badge + daily goal section — home view only
  const gamifBadge = document.getElementById('gamifStreakBadge');
  if (gamifBadge) {
    if (!isFolderView && typeof getGamificationState === 'function') {
      getGamificationState().then(state => {
        gamifBadge.innerHTML =
          `<span style="display:inline-flex;align-items:center;gap:0.35rem;font-size:0.85rem;` +
          `color:var(--text-muted);background:var(--surface2);padding:0.3rem 0.75rem;border-radius:999px;">` +
          `<i data-lucide="flame" class="icon-sm"></i><span>${state.streak}일 연속</span>` +
          `<span style="opacity:0.4;">·</span>` +
          `<i data-lucide="star" class="icon-sm"></i><span>${state.xp} XP</span>` +
          `</span>`;
        gamifBadge.style.display = '';
        window.mountLucideIcons?.();
        renderDailyEngagementSection(state);
      }).catch(() => { gamifBadge.style.display = 'none'; });
    } else {
      gamifBadge.style.display = 'none';
      const existing = document.getElementById('gamifDailyGoal');
      if (existing) existing.style.display = 'none';
    }
  }

  // Show/hide recent section and update title/back button
  const recentSection = document.getElementById('recentSection');
  const folderBackBtn = document.getElementById('folderBackBtn');
  const allNotesTitle = document.getElementById('allNotesTitle');
  if (recentSection) recentSection.style.display = isFolderView ? 'none' : '';
  if (folderBackBtn) folderBackBtn.style.display  = isFolderView ? ''     : 'none';

  // Hide the home-page record card while inside a folder view — it belongs
  // on the unfiltered home only.
  const homeRecordSection = document.getElementById('homeRecordSection');
  if (homeRecordSection) homeRecordSection.style.display = isFolderView ? 'none' : '';

  // Refresh the "내 녹취록 N개" count on the home record card. Fire-and-forget;
  // best-effort, no need to block the rest of the render on a Firestore round trip.
  if (typeof updateMyTranscriptsCount === 'function') updateMyTranscriptsCount();

  // ── Exam-plan controls (button + summary card) ─────────────────────────
  // The 🎓 button only makes sense inside a real folder. Inside the special
  // 'none' (uncategorized) view we have no folderId to attach a plan to.
  const folderExamPlanBtn = document.getElementById('folderExamPlanBtn');
  const folderExamSummary = document.getElementById('folderExamPlanSummary');
  if (folderExamPlanBtn && folderExamSummary) {
    if (isFolderView) {
      const folderObj = folders.find(f => f.id === _activeFolderId);
      const hasPlan   = !!(folderObj && folderObj.examPlan);

      folderExamPlanBtn.style.display = '';
      folderExamPlanBtn.innerHTML = hasPlan
        ? '<i data-lucide="graduation-cap" class="icon-sm"></i><span>시험 일정</span>'
        : '<i data-lucide="graduation-cap" class="icon-sm"></i><span>시험 등록</span>';

      if (hasPlan && typeof effectiveDailyTarget === 'function' &&
          typeof getDaysUntil === 'function' && typeof modeLabel === 'function') {
        const plan        = folderObj.examPlan;
        const folderNotes = notes.filter(n => n.folderId === _activeFolderId).length;
        const daysLeft    = getDaysUntil(plan.examDate);
        const dailyTarget = effectiveDailyTarget(plan, folderNotes);
        const dDayLabel   = daysLeft == null ? ''
                          : daysLeft < 0   ? `D+${-daysLeft}`
                          : daysLeft === 0 ? 'D-Day'
                          : `D-${daysLeft}`;
        const isPast = daysLeft != null && daysLeft < 0;

        folderExamSummary.innerHTML = `
          <div class="exam-summary-stat" style="min-width:60px;">
            <div class="exam-summary-stat-num" style="color:${isPast ? 'var(--text-muted)' : 'var(--primary)'};">${dDayLabel}</div>
            <div class="exam-summary-stat-label">${plan.examDate}</div>
          </div>
          <div class="exam-summary-divider"></div>
          <div class="exam-summary-stat">
            <div class="exam-summary-stat-num">${dailyTarget}개</div>
            <div class="exam-summary-stat-label">매일 목표</div>
          </div>
          <div class="exam-summary-divider"></div>
          <div class="exam-summary-stat">
            <div class="exam-summary-stat-num" style="font-size:0.92rem;">${modeLabel(plan.prepMode)}</div>
            <div class="exam-summary-stat-label">${plan.prepStartDate} 부터</div>
          </div>
          <div class="exam-summary-stat">
            <div class="exam-summary-stat-num">${folderNotes}개</div>
            <div class="exam-summary-stat-label">노트</div>
          </div>
        `;
        folderExamSummary.style.display = '';
      } else {
        folderExamSummary.style.display = 'none';
      }
    } else {
      folderExamPlanBtn.style.display  = 'none';
      folderExamSummary.style.display  = 'none';
    }
  }

  // Show exam-review button only in folder view with 2+ notes
  const examReviewBtn = document.getElementById('examReviewBtn');
  if (examReviewBtn) {
    const folderNoteCount = isFolderView
      ? notes.filter(n => n.folderId === _activeFolderId).length
      : 0;
    examReviewBtn.style.display = (isFolderView && folderNoteCount >= 2) ? '' : 'none';
  }

  // Eject drop zone — visible only in folder view
  const ejectDropZone = document.getElementById('ejectDropZone');
  if (ejectDropZone) {
    ejectDropZone.style.display = isFolderView ? '' : 'none';
    // Re-attach listeners (replace element clone to avoid duplicate handlers)
    const fresh = ejectDropZone.cloneNode(true);
    ejectDropZone.replaceWith(fresh);
    fresh.addEventListener('dragover',  e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    fresh.addEventListener('dragenter', e => { e.preventDefault(); fresh.classList.add('eject-drag-over'); });
    fresh.addEventListener('dragleave', e => { if (!fresh.contains(e.relatedTarget)) fresh.classList.remove('eject-drag-over'); });
    fresh.addEventListener('drop', async e => {
      e.preventDefault();
      fresh.classList.remove('eject-drag-over');
      const noteId = e.dataTransfer.getData('text/plain');
      if (!noteId) return;
      const n = await getNoteFS(noteId);
      if (!n) return;
      const updated = Object.assign({}, n, { folderId: null });
      await saveNote(updated);
      const updatedAt = new Date().toISOString();
      safeNotePartialUpdate(noteId, { folderId: null, updatedAt })
        .catch(e2 => console.warn('Firestore eject sync failed:', e2));
      showToast('📤 홈으로 이동했습니다');
      await renderHomeView();
    });
  }

  if (allNotesTitle) {
    if (isFolderView) {
      const folderName = folderMap[_activeFolderId] || '폴더';
      // Folder header title: lucide folder icon + name (replaces 📁 emoji
      // prefix). The Mutation observer in icons.js will mount the SVG.
      allNotesTitle.innerHTML = `<i data-lucide="folder" class="icon-sm"></i><span>${escHtml(folderName)}</span>`;
    } else {
      allNotesTitle.textContent = '모든 노트';
    }
  }

  const emptyMsg  = document.getElementById('emptyHomeMsg');
  if (!recentGrid || !allGrid) return;

  // Recent grid: only unfiled notes in home view; hidden in folder view
  recentGrid.innerHTML = '';
  if (!isFolderView) {
    notes.filter(n => !n.folderId).slice(0, 4).forEach(note =>
      recentGrid.appendChild(buildNoteCard(note, folderMap, folderColorMap)));
  }

  allGrid.innerHTML = '';
  if (_bulkSelectMode) {
    allGrid.classList.add('bulk-select-mode');
    // Cards are rebuilt — stale selections are gone; reset count
    _selectedNoteIds.clear();
    const allChk = document.getElementById('bulkSelectAllChk');
    if (allChk) { allChk.checked = false; allChk.indeterminate = false; }
    _updateBulkBar();
  }

  // Count notes per folder for folder cards
  const folderCountMap = {};
  notes.forEach(n => { if (n.folderId) folderCountMap[n.folderId] = (folderCountMap[n.folderId] || 0) + 1; });

  const hasContent = isHomeView ? (folders.length > 0 || displayNotes.length > 0) : displayNotes.length > 0;
  if (!hasContent) {
    emptyMsg.style.display = '';
    const icon = document.getElementById('emptyHomeIcon');
    const text = document.getElementById('emptyHomeMsgText');
    const sub  = document.getElementById('emptyHomeSubText');
    const btn  = document.getElementById('emptyHomeNewBtn');
    // Empty-state icon: replace emoji textContent with a Lucide SVG. The
    // outer #emptyHomeIcon container already styles the 56×56 rounded
    // background — we just swap its child icon to match the state.
    const emptyIconHtml = (name) =>
      `<i data-lucide="${name}" style="width:26px; height:26px; color:var(--text-muted);"></i>`;
    if (activeQuery) {
      if (icon) icon.innerHTML = emptyIconHtml('search-x');
      if (text) text.textContent = `"${activeQuery}" 검색 결과가 없습니다`;
      if (sub)  sub.textContent  = '다른 검색어를 시도해보세요';
      if (btn)  btn.style.display = 'none';
    } else if (_activeFolderId) {
      if (icon) icon.innerHTML = emptyIconHtml('folder-open');
      if (text) text.textContent = '이 폴더에 노트가 없습니다';
      if (sub)  sub.textContent  = '새 분석을 실행하거나 다른 노트를 이동하세요';
      if (btn)  btn.style.display = 'none';
    } else {
      if (icon) icon.innerHTML = emptyIconHtml('notebook-pen');
      if (text) text.textContent = '아직 저장된 노트가 없습니다';
      if (sub)  sub.textContent  = 'AI 분석을 완료하면 자동으로 저장됩니다';
      if (btn)  btn.style.display = '';
    }
  } else {
    emptyMsg.style.display = 'none';
    // In home view: prepend folder cards, then unfiled note cards
    if (isHomeView) {
      folders.forEach(f => allGrid.appendChild(buildFolderCard(f, folderCountMap[f.id] || 0)));
    }
    const sorted = [...displayNotes].sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    sorted.forEach(note => allGrid.appendChild(buildNoteCard(note, folderMap, folderColorMap)));
  }

  renderSidebarFolders(notes, folders);

  const bytes = await getStorageSize();
  const mb = (bytes / 1024 / 1024).toFixed(2);
  ['storageSize', 'sidebarStorageSize'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = `${mb} MB`;
  });
}

function buildNoteCard(note, folderMap, folderColorMap = {}) {
  const card = document.createElement('div');
  card.className = 'note-card';
  card.dataset.noteId = note.id;
  const folderName  = note.folderId ? (folderMap[note.folderId] || '알 수 없음') : '';
  const folderColor = note.folderId ? (folderColorMap[note.folderId] || null) : null;
  const colorDot    = folderColor ? `<span class="folder-color-dot" style="background:${folderColor}"></span>` : '';
  const isNotion    = note.type === 'notion';
  const sourceText  = isNotion ? (note.markdownContent || '') : (note.notesText || '');
  const preview = sourceText
    .replace(/^#+\s+.*/gm, '').replace(/\*\*/g, '').replace(/\n+/g, ' ').trim().slice(0, 100);
  // Title is plain — the "노션" badge in the corner already signals type, no
  // need for a redundant emoji prefix.
  const displayTitle = note.title || '제목없음';
  const notionBadge  = isNotion ? '<span class="notion-type-badge">노션</span>' : '';
  // Folder pill: color dot + folder name (no folder emoji — the dot is the
  // folder marker). Unfiled notes use a small file icon.
  const folderPill = folderName
    ? `${colorDot}${escHtml(folderName)}`
    : `<i data-lucide="file-text" class="icon-xs"></i><span>미분류</span>`;
  card.innerHTML = `
    <input type="checkbox" class="note-card-checkbox">
    <span class="note-card-drag-handle"><i data-lucide="grip-vertical"></i></span>
    <div class="note-card-content">
      <div class="note-card-folder">${folderPill}</div>
      <div class="note-card-title">${escHtml(displayTitle)}</div>
      <div class="note-card-preview">${escHtml(preview)}</div>
      <div class="note-card-footer">
        <span>${fmtDate(note.updatedAt)}</span>
        <span>${sourceText.length.toLocaleString()}자</span>
      </div>
    </div>
    ${notionBadge}
    <div class="note-card-actions">
      <button title="이름 변경"><i data-lucide="pencil"></i></button>
      <button title="폴더 이동"><i data-lucide="folder-input"></i></button>
      <button title="삭제"><i data-lucide="trash-2"></i></button>
    </div>`;
  const checkbox = card.querySelector('.note-card-checkbox');
  checkbox.addEventListener('click', e => {
    e.stopPropagation();
    if (checkbox.checked) { _selectedNoteIds.add(note.id); card.classList.add('bulk-selected'); }
    else                  { _selectedNoteIds.delete(note.id); card.classList.remove('bulk-selected'); }
    _updateBulkBar();
  });
  card.addEventListener('click', () => {
    if (_bulkSelectMode) {
      checkbox.checked = !checkbox.checked;
      if (checkbox.checked) { _selectedNoteIds.add(note.id); card.classList.add('bulk-selected'); }
      else                  { _selectedNoteIds.delete(note.id); card.classList.remove('bulk-selected'); }
      _updateBulkBar();
      return;
    }
    openSavedNote(note.id);
  });
  const [renameBtn, moveBtn, deleteBtn] = card.querySelectorAll('.note-card-actions button');
  renameBtn.addEventListener('click', e => { e.stopPropagation(); renameSavedNote(note.id); });
  moveBtn.addEventListener('click',   e => { e.stopPropagation(); moveSavedNote(note.id); });
  deleteBtn.addEventListener('click', e => { e.stopPropagation(); confirmDeleteNote(note.id); });

  // Eject button — shown only when viewing inside the note's own folder
  if (note.folderId && _activeFolderId === note.folderId) {
    const ejectBtn = document.createElement('button');
    ejectBtn.className = 'note-eject-btn';
    ejectBtn.title = '폴더에서 내보내기';
    ejectBtn.innerHTML = '<i data-lucide="log-out"></i>';
    ejectBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const updated = Object.assign({}, note, { folderId: null });
      await saveNote(updated);
      const updatedAt = new Date().toISOString();
      safeNotePartialUpdate(note.id, { folderId: null, updatedAt })
        .catch(e2 => console.warn('Firestore eject sync failed:', e2));
      showToast('📤 홈으로 이동했습니다');
      await renderHomeView();
    });
    card.appendChild(ejectBtn);
  }

  // ── Pointer-based smooth drag reorder ────────────────────────
  attachNoteDrag(card, note.id);

  return card;
}

/* ═══════════════════════════════════════════════
   Pointer-drag reorder for note cards
═══════════════════════════════════════════════ */
function attachNoteDrag(card, noteId) {
  const handle = card.querySelector('.note-card-drag-handle');
  if (!handle) return;

  let startX, startY, docMoveHandler, docUpHandler;

  handle.addEventListener('pointerdown', e => {
    if (_bulkSelectMode) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    _noteDrag = { card, noteId, dragging: false, insertIndex: -1 };

    // Attach to document so events keep firing even when card has pointer-events:none
    docMoveHandler = onMove;
    docUpHandler   = onUp;
    document.addEventListener('pointermove',   docMoveHandler);
    document.addEventListener('pointerup',     docUpHandler);
    document.addEventListener('pointercancel', docUpHandler);
  });

  function onMove(e) {
    if (!_noteDrag || _noteDrag.card !== card) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!_noteDrag.dragging) {
      if (Math.hypot(dx, dy) < 6) return; // ignore micro-movement
      // -- Drag starts --
      const grid = card.closest('#allNotesGrid'); // null for #recentNotesGrid cards — folder drop still works
      const rect = card.getBoundingClientRect();
      _noteDrag.dragging   = true;
      _noteDrag.grid       = grid;
      _noteDrag.offsetX    = startX - rect.left;
      _noteDrag.offsetY    = startY - rect.top;
      _noteDrag.cardH      = rect.height;

      // Original card becomes invisible placeholder (keeps its space in flow)
      card.classList.add('note-card-placeholder');
      card.style.minHeight = rect.height + 'px';

      // Floating clone follows the cursor
      const clone = card.cloneNode(true);
      clone.className = 'note-card note-card-dragging';
      clone.style.cssText =
        `position:fixed;width:${rect.width}px;height:${rect.height}px;` +
        `left:${rect.left}px;top:${rect.top}px;margin:0;pointer-events:none;`;
      document.body.appendChild(clone);
      _noteDrag.clone = clone;

      document.body.style.userSelect  = 'none';
      document.body.style.touchAction = 'none';
      return;
    }

    // -- Move clone --
    const { clone, offsetX, offsetY, cardH, grid } = _noteDrag;
    const cloneLeft = e.clientX - offsetX;
    const cloneTop  = e.clientY - offsetY;
    clone.style.left = cloneLeft + 'px';
    clone.style.top  = cloneTop  + 'px';

    if (grid) {
      // Determine insert position from clone center Y
      const cloneCenterY = cloneTop + cardH / 2;
      const otherCards = [...grid.querySelectorAll('.note-card[data-note-id]')]
        .filter(c => c !== card);

      let newIdx = otherCards.length;
      for (let i = 0; i < otherCards.length; i++) {
        const r = otherCards[i].getBoundingClientRect();
        if (cloneCenterY < r.top + r.height / 2) { newIdx = i; break; }
      }

      if (newIdx !== _noteDrag.insertIndex) {
        _noteDrag.insertIndex = newIdx;

        // FLIP: record positions before DOM change
        const snapshots = otherCards.map(c => ({ c, top: c.getBoundingClientRect().top }));

        // Move placeholder in DOM
        if (newIdx >= otherCards.length) {
          otherCards[otherCards.length - 1]?.after(card) ?? grid.appendChild(card);
        } else {
          otherCards[newIdx].before(card);
        }

        // FLIP: animate other cards from old → new position
        requestAnimationFrame(() => {
          snapshots.forEach(({ c, top: oldTop }) => {
            const newTop = c.getBoundingClientRect().top;
            const delta  = oldTop - newTop;
            if (Math.abs(delta) < 1) return;
            c.style.transition = 'none';
            c.style.transform  = `translateY(${delta}px)`;
            requestAnimationFrame(() => {
              c.style.transition = 'transform 0.2s ease';
              c.style.transform  = '';
            });
          });
        });
      }
    }
  }

  function onUp() {
    cleanupDocListeners();
    commitDrag();
  }

  function cleanupDocListeners() {
    document.removeEventListener('pointermove',   docMoveHandler);
    document.removeEventListener('pointerup',     docUpHandler);
    document.removeEventListener('pointercancel', docUpHandler);
  }

  function commitDrag() {
    if (!_noteDrag || _noteDrag.card !== card) return;
    const { dragging, clone, grid } = _noteDrag;
    _noteDrag = null;
    document.body.style.userSelect  = '';
    document.body.style.touchAction = '';

    if (!dragging || !clone) return;

    // Clean up transform residue from FLIP on all cards
    if (grid) grid.querySelectorAll('.note-card').forEach(c => { c.style.transition = ''; c.style.transform = ''; });

    clone.remove();
    card.classList.remove('note-card-placeholder');
    card.style.minHeight = '';
    card.classList.add('note-card-settling');
    card.addEventListener('animationend', () => card.classList.remove('note-card-settling'), { once: true });

    if (grid) {
      const orderedIds = [...grid.querySelectorAll('.note-card[data-note-id]')]
        .map(c => c.dataset.noteId).filter(Boolean);
      updateNoteOrderFS(orderedIds).catch(err => console.warn('reorder save:', err));
    }
  }
}

/* ═══════════════════════════════════════════════
   Sidebar folder list
═══════════════════════════════════════════════ */
async function renderSidebarFolders(notes, folders) {
  if (!notes || !folders) [notes, folders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
  const container = document.getElementById('sidebarFolders');
  if (!container) return;
  container.innerHTML = '';

  const countMap = {};
  notes.forEach(n => { const k = n.folderId || '__none__'; countMap[k] = (countMap[k] || 0) + 1; });

  const mkItem = (label, folderId, count, folder, iconName) => {
    const item = document.createElement('div');
    item.className = 'sidebar-folder-item' + (_activeFolderId === folderId ? ' active' : '');
    const span = document.createElement('span');
    if (folder?.color) {
      // User folder: color dot + name. The dot is the visual marker, no
      // need for a folder icon on top of it.
      const dot = document.createElement('span');
      dot.className = 'folder-color-dot';
      dot.style.background = folder.color;
      span.appendChild(dot);
      span.append(folder.name);
    } else if (iconName) {
      // System pseudo-folder (전체 / 미분류): Lucide icon + label.
      span.innerHTML = `<i data-lucide="${iconName}" class="icon-xs"></i><span>${escHtml(label)}</span>`;
    } else if (folder) {
      // User folder without a color — still no folder emoji, just the
      // name (the indent + sidebar-folder-item context is enough).
      span.textContent = folder.name;
    } else {
      span.textContent = label;
    }
    const badge = document.createElement('span');
    badge.className = 'sidebar-folder-count';
    badge.textContent = count;
    item.append(span, badge);
    if (folder) {
      const rnBtn = document.createElement('button');
      rnBtn.className = 'sidebar-folder-rename';
      rnBtn.title = '이름 변경';
      rnBtn.innerHTML = '<i data-lucide="pencil"></i>';
      rnBtn.addEventListener('click', e => { e.stopPropagation(); renameFolderPrompt(folderId, folder.name, folder.color); });
      item.appendChild(rnBtn);

      item.addEventListener('pointerenter', () => {
        if (_noteDrag && _noteDrag.noteId) item.classList.add('folder-drag-over');
      });
      item.addEventListener('pointerleave', () => {
        item.classList.remove('folder-drag-over');
      });
      item.addEventListener('pointerup', async () => {
        if (_noteDrag && _noteDrag.noteId) {
          const noteId = _noteDrag.noteId;
          item.classList.remove('folder-drag-over');
          await moveNoteToFolder(noteId, folder.id);
          await renderHomeView();
        }
      });
    }
    item.onclick = () => filterByFolder(folderId);
    return item;
  };

  container.appendChild(mkItem('전체',  null,   notes.length, null, 'list'));
  container.appendChild(mkItem('미분류', 'none', countMap['__none__'] || 0, null, 'file-text'));
  folders.forEach(f => container.appendChild(mkItem(f.name, f.id, countMap[f.id] || 0, f)));
}

function filterByFolder(folderId) {
  _activeFolderId = folderId;
  if (_currentView !== 'home') switchView('home');
  else renderHomeView();
}

function createFolderFromSidebar() {
  showFolderEditModal(null);
}

/* ═══════════════════════════════════════════════
   Daily goal progress bar + streak calendar
═══════════════════════════════════════════════ */
function renderDailyEngagementSection(state) {
  const badge = document.getElementById('gamifStreakBadge');
  if (!badge) return;

  let section = document.getElementById('gamifDailyGoal');
  if (!section) {
    section = document.createElement('div');
    section.id = 'gamifDailyGoal';
    section.style.cssText =
      'margin-bottom:1.25rem;padding:1rem 1.25rem;' +
      'background:var(--surface2,#1a1a2e);border-radius:var(--radius,12px);' +
      'border:1px solid var(--border,rgba(255,255,255,0.08));';
    badge.insertAdjacentElement('afterend', section);
  }
  section.style.display = '';

  const today = (function() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  })();

  const goal = state.dailyGoal || 5;
  const prog = (state.dailyProgress && state.dailyProgress[today]) ||
    { cardsReviewed: 0, notesCreated: 0, quizzesCompleted: 0, completed: false };

  const goalDone = prog.completed ||
    (prog.cardsReviewed || 0) >= goal ||
    (prog.notesCreated  || 0) >= 1  ||
    (prog.quizzesCompleted || 0) >= 1;

  const barPct = goalDone ? 100 : Math.min(100, Math.round(((prog.cardsReviewed || 0) / goal) * 100));

  // Goal options for settings picker
  const GOAL_OPTIONS = [3, 5, 10, 15];

  // ── Top row: title + settings gear ──
  const titleRow =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.6rem;">' +
      '<span style="font-size:0.88rem;font-weight:700;">오늘의 목표</span>' +
      '<div style="position:relative;">' +
        '<button id="gamifGoalSettingsBtn" title="목표 변경" style="background:none;border:none;cursor:pointer;' +
        'color:var(--text-muted,#888);padding:0.1rem 0.25rem;border-radius:4px;font-size:0.9rem;">⚙️</button>' +
        '<div id="gamifGoalDropdown" style="display:none;position:absolute;right:0;top:1.6rem;' +
        'background:var(--surface,#1e1e2e);border:1px solid var(--border,rgba(255,255,255,0.12));' +
        'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);z-index:100;min-width:120px;">' +
          GOAL_OPTIONS.map(n =>
            '<div class="gamif-goal-opt" data-goal="' + n + '" style="padding:0.5rem 1rem;cursor:pointer;' +
            'font-size:0.85rem;' + (n === goal ? 'color:var(--primary,#7c4dff);font-weight:700;' : '') + '">' +
            n + '장 복습</div>'
          ).join('') +
        '</div>' +
      '</div>' +
    '</div>';

  // ── Progress bar ──
  const barColor = goalDone ? 'var(--success,#22c55e)' : 'var(--primary,#7c4dff)';
  const progressBar =
    '<div style="height:8px;background:var(--surface3,rgba(255,255,255,0.06));border-radius:999px;overflow:hidden;margin-bottom:0.4rem;">' +
      '<div style="height:100%;width:' + barPct + '%;background:' + barColor + ';' +
      'border-radius:999px;transition:width 0.4s ease;"></div>' +
    '</div>';

  const subtitle = goalDone
    ? '<div style="font-size:0.78rem;color:var(--success,#22c55e);font-weight:600;">✅ 오늘 목표 달성! <span style="opacity:0.7;">(+50 XP 보너스)</span></div>'
    : '<div style="font-size:0.78rem;color:var(--text-muted,#888);">' +
        goal + '장 복습 또는 1개 노트 생성 &nbsp;·&nbsp; ' +
        '<span style="color:var(--text,inherit);">' + (prog.cardsReviewed || 0) + '/' + goal + '</span>' +
      '</div>';

  // ── Streak calendar (last 7 days) ──
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ymd = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const dayProg = state.dailyProgress && state.dailyProgress[ymd];
    const met = dayProg && (dayProg.completed || dayProg.cardsReviewed >= (state.dailyGoal||5) || dayProg.notesCreated >= 1 || dayProg.quizzesCompleted >= 1);
    const isToday = ymd === today;
    const label = ['일','월','화','수','목','금','토'][d.getDay()];
    let tooltip = ymd;
    if (dayProg && met) {
      const parts = [];
      if (dayProg.cardsReviewed) parts.push('복습 ' + dayProg.cardsReviewed + '장');
      if (dayProg.notesCreated)  parts.push('노트 ' + dayProg.notesCreated + '개');
      if (dayProg.quizzesCompleted) parts.push('퀴즈 ' + dayProg.quizzesCompleted + '회');
      if (parts.length) tooltip += ' · ' + parts.join(', ');
    }
    days.push({ ymd, met, isToday, label, tooltip });
  }

  const calendarSquares = days.map(({ met, isToday, label, tooltip }) => {
    const bg = met
      ? 'background:var(--primary,#7c4dff);'
      : 'background:var(--surface3,rgba(255,255,255,0.06));';
    const pulse = isToday
      ? 'outline:2px solid var(--primary,#7c4dff);outline-offset:2px;'
      : '';
    const animation = isToday && !met ? 'animation:gamifPulse 2s ease-in-out infinite;' : '';
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;">' +
      '<div title="' + tooltip + '" style="width:24px;height:24px;border-radius:5px;' +
      bg + pulse + animation + '"></div>' +
      '<span style="font-size:0.6rem;color:var(--text-muted,#888);">' + label + '</span>' +
    '</div>';
  }).join('');

  const calendar =
    '<div style="display:flex;gap:6px;margin-top:0.85rem;justify-content:flex-start;">' +
      calendarSquares +
    '</div>';

  section.innerHTML = titleRow + progressBar + subtitle + calendar;

  // Inject pulse keyframes once
  if (!document.getElementById('gamifPulseStyle')) {
    const style = document.createElement('style');
    style.id = 'gamifPulseStyle';
    style.textContent = '@keyframes gamifPulse{0%,100%{opacity:1}50%{opacity:0.45}}';
    document.head.appendChild(style);
  }

  // Settings dropdown toggle
  const settingsBtn  = section.querySelector('#gamifGoalSettingsBtn');
  const dropdown     = section.querySelector('#gamifGoalDropdown');
  if (settingsBtn && dropdown) {
    settingsBtn.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'none' ? '' : 'none';
    });
    document.addEventListener('click', () => { dropdown.style.display = 'none'; }, { once: true });

    section.querySelectorAll('.gamif-goal-opt').forEach(opt => {
      opt.addEventListener('mouseover', () => { opt.style.background = 'var(--surface2,#1a1a2e)'; });
      opt.addEventListener('mouseout',  () => { opt.style.background = ''; });
      opt.addEventListener('click', async () => {
        dropdown.style.display = 'none';
        const newGoal = parseInt(opt.dataset.goal, 10);
        if (!newGoal || newGoal === goal) return;
        if (typeof getGamificationState === 'function') {
          try {
            const st = await getGamificationState();
            st.dailyGoal = newGoal;
            await saveGamificationState(st);
            renderDailyEngagementSection(st);
          } catch(_) {}
        }
      });
    });
  }
}
