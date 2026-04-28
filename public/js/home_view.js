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
  card.innerHTML = `
    <div class="folder-card-icon">📁</div>
    <div class="folder-card-info">
      <div class="folder-card-name">${colorDot}${escHtml(folder.name)}</div>
      <div class="folder-card-count">${noteCount}개의 노트</div>
    </div>
    <div class="folder-card-actions">
      <button title="이름 변경">✏️</button>
      <button title="삭제">🗑</button>
    </div>`;
  const [renameBtn, deleteBtn] = card.querySelectorAll('.folder-card-actions button');
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
  // Firestore: update only the changed fields
  const ref = userNotesRef();
  if (ref) {
    const { updatedAt } = updated;
    try {
      await ref.doc(noteId).set({ folderId, sortOrder: newSortOrder, updatedAt }, { merge: true });
    } catch (e) {
      console.warn('Firestore folder move sync failed:', e);
    }
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

  // Show/hide recent section and update title/back button
  const recentSection = document.getElementById('recentSection');
  const folderBackBtn = document.getElementById('folderBackBtn');
  const allNotesTitle = document.getElementById('allNotesTitle');
  if (recentSection) recentSection.style.display = isFolderView ? 'none' : '';
  if (folderBackBtn) folderBackBtn.style.display  = isFolderView ? ''     : 'none';

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
      const fsRef = userNotesRef();
      if (fsRef) {
        const updatedAt = new Date().toISOString();
        fsRef.doc(noteId).set({ folderId: null, updatedAt }, { merge: true })
          .catch(e2 => console.warn('Firestore eject sync failed:', e2));
      }
      showToast('📤 홈으로 이동했습니다');
      await renderHomeView();
    });
  }

  if (allNotesTitle) {
    if (isFolderView) {
      const folderName = folderMap[_activeFolderId] || '폴더';
      allNotesTitle.textContent = '📁 ' + folderName;
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
    if (activeQuery) {
      if (icon) icon.textContent = '🔍';
      if (text) text.textContent = `"${activeQuery}" 검색 결과가 없습니다`;
      if (sub)  sub.textContent  = '다른 검색어를 시도해보세요';
      if (btn)  btn.style.display = 'none';
    } else if (_activeFolderId) {
      if (icon) icon.textContent = '📂';
      if (text) text.textContent = '이 폴더에 노트가 없습니다';
      if (sub)  sub.textContent  = '새 분석을 실행하거나 다른 노트를 이동하세요';
      if (btn)  btn.style.display = 'none';
    } else {
      if (icon) icon.textContent = '📝';
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
  const displayTitle = isNotion ? '📓 ' + (note.title || '제목없음') : (note.title || '제목없음');
  const notionBadge  = isNotion ? '<span class="notion-type-badge">노션</span>' : '';
  card.innerHTML = `
    <input type="checkbox" class="note-card-checkbox">
    <span class="note-card-drag-handle">⠿</span>
    <div class="note-card-content">
      <div class="note-card-folder">${folderName ? colorDot + '📁 ' + escHtml(folderName) : '📄 미분류'}</div>
      <div class="note-card-title">${escHtml(displayTitle)}</div>
      <div class="note-card-preview">${escHtml(preview)}</div>
      <div class="note-card-footer">
        <span>${fmtDate(note.updatedAt)}</span>
        <span>${sourceText.length.toLocaleString()}자</span>
      </div>
    </div>
    ${notionBadge}
    <div class="note-card-actions">
      <button title="이름 변경">✏️</button>
      <button title="폴더 이동">📁</button>
      <button title="삭제">🗑</button>
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
    ejectBtn.textContent = '📤';
    ejectBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const updated = Object.assign({}, note, { folderId: null });
      await saveNote(updated);
      const ref = userNotesRef();
      if (ref) {
        const updatedAt = new Date().toISOString();
        ref.doc(note.id).set({ folderId: null, updatedAt }, { merge: true })
          .catch(e2 => console.warn('Firestore eject sync failed:', e2));
      }
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
      const grid = card.closest('#allNotesGrid');
      if (!grid) { cleanupDocListeners(); _noteDrag = null; return; }
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

  const mkItem = (label, folderId, count, folder) => {
    const item = document.createElement('div');
    item.className = 'sidebar-folder-item' + (_activeFolderId === folderId ? ' active' : '');
    const span = document.createElement('span');
    if (folder?.color) {
      const dot = document.createElement('span');
      dot.className = 'folder-color-dot';
      dot.style.background = folder.color;
      span.appendChild(dot);
      span.append(folder.name);
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
      rnBtn.textContent = '✏️';
      rnBtn.addEventListener('click', e => { e.stopPropagation(); renameFolderPrompt(folderId, folder.name, folder.color); });
      item.appendChild(rnBtn);
    }
    item.onclick = () => filterByFolder(folderId);
    return item;
  };

  container.appendChild(mkItem('📋 전체',  null,   notes.length));
  container.appendChild(mkItem('📄 미분류', 'none', countMap['__none__'] || 0));
  folders.forEach(f => container.appendChild(mkItem('📁 ' + f.name, f.id, countMap[f.id] || 0, f)));
}

function filterByFolder(folderId) {
  _activeFolderId = folderId;
  if (_currentView !== 'home') switchView('home');
  else renderHomeView();
}

function createFolderFromSidebar() {
  showFolderEditModal(null);
}
