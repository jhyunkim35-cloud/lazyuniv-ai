// Notes CRUD: auto-save, list rendering, open/load, Notion file import, delete, move, rename, detect splits.
// Depends on: constants.js (currentNoteId, storedNotesText, storedPptText, storedFilteredText, storedHighlightedTranscript, extractedImages, pptFile), storage.js, firestore_sync.js (saveNoteFS, getNoteFS, getAllNotesFS, deleteNoteFS, searchNotesFS, getAllFoldersFS, getStorageSize, getNextSortOrder, saveFolderFS), ui.js (showToast, showSuccessToast), markdown.js (escHtml, renderMarkdown), quiz.js (clearQuizInlineArea).

/* ═══════════════════════════════════════════════
   Auto-save after pipeline
═══════════════════════════════════════════════ */
function promptNoteName(defaultTitle) {
  return new Promise(resolve => {
    const name = prompt('노트 이름을 입력하세요:', defaultTitle);
    resolve(name && name.trim() ? name.trim() : defaultTitle);
  });
}

async function autoSaveNote() {
  try {
    const slide1Section    = storedPptText.match(/\[슬라이드 1\]([\s\S]*?)(?=\[슬라이드 \d+\]|$)/);
    const slide1Title      = slide1Section?.[1].match(/^제목: (.+)/m)?.[1].trim();
    const headingMatch     = storedNotesText.match(/^#\s+(.+)/m);
    const headingTitle     = headingMatch?.[1].replace(/\*\*/g, '').trim();
    const fileTitle        = pptFile?.name?.replace(/\.[^.]+$/, '') || document.getElementById('pptTagName')?.textContent || '새 노트';
    const autoTitle        = slide1Title || headingTitle || fileTitle;
    const title = await promptNoteName(autoTitle);
    // GUARD: prevent ghost notes — both title and content must be non-empty
    const _titleOk = title && title.trim();
    const _contentOk = storedNotesText && storedNotesText.trim();
    if (!_titleOk || !_contentOk) {
      console.warn('[autoSaveNote] skipped empty note save', { titleOk: !!_titleOk, contentOk: !!_contentOk });
      return;
    }
    const notesHtml = document.getElementById('finalNotesBody')?.innerHTML || '';
    const record = await saveNoteFS({
      id:                   currentNoteId || undefined,
      title,
      folderId:             currentNoteId ? (await getNoteFS(currentNoteId))?.folderId ?? null : null,
      notesText:            storedNotesText,
      notesHtml,
      pptText:              storedPptText,
      filteredText:         storedFilteredText,
      highlightedTranscript: storedHighlightedTranscript,
      extractedImages:      extractedImages,
    });
    currentNoteId = record.id;
    showSuccessToast('💾 저장 완료');
    renderSavedNotes();
    renderHomeView();
  } catch (e) {
    console.error('autoSaveNote error:', e);
  }
}

/* ═══════════════════════════════════════════════
   Render saved notes list + recent bar
═══════════════════════════════════════════════ */
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
}

async function renderSavedNotes(filteredNotes, activeQuery = '') {
  const [notes, folders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
  const displayNotes = filteredNotes !== undefined ? filteredNotes : notes;

  // Recent bar (top 5 from all notes, not filtered)
  const recentBar = document.getElementById('recentNotesBar');
  recentBar.innerHTML = '';
  notes.slice(0, 5).forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'recent-note-pill';
    const d = new Date(n.updatedAt || n.createdAt);
    btn.textContent = `📖 ${n.title || '제목없음'} (${d.getMonth()+1}/${d.getDate()})`;
    btn.onclick = () => openSavedNote(n.id);
    recentBar.appendChild(btn);
  });

  const list    = document.getElementById('savedNotesList');
  const emptyMsg = document.getElementById('emptyNotesMsg');
  list.innerHTML = '';

  if (!displayNotes.length) {
    emptyMsg.textContent = activeQuery
      ? `"${activeQuery}" 검색 결과가 없습니다.`
      : '저장된 노트가 없습니다. AI 분석을 시작하면 자동으로 저장됩니다.';
    emptyMsg.style.display = '';
    return;
  }
  emptyMsg.style.display = 'none';

  // Group by folder
  const folderMap = Object.fromEntries(folders.map(f => [f.id, f.name]));
  const groups = {};
  for (const note of displayNotes) {
    const key = note.folderId || '__none__';
    (groups[key] = groups[key] || []).push(note);
  }

  // Sort: uncategorized first, then folders alphabetically
  const sortedKeys = ['__none__', ...folders.map(f => f.id)].filter(k => groups[k]);

  for (const key of sortedKeys) {
    const groupNotes = groups[key];
    if (!groupNotes) continue;
    const label = document.createElement('div');
    label.className = 'folder-group-label';
    label.textContent = key === '__none__' ? '📄 미분류' : `📁 ${folderMap[key] || key}`;
    list.appendChild(label);

    for (const note of groupNotes) {
      const card = document.createElement('div');
      card.className = 'saved-note-card';
      card.dataset.noteId = note.id;
      const charCount = (note.notesText || '').length.toLocaleString();
      const folderName = note.folderId ? (folderMap[note.folderId] || '알 수 없음') : '미분류';
      card.innerHTML = `
        <div class="saved-note-title">${escHtml(note.title || '제목없음')}</div>
        <div class="saved-note-meta">${fmtDate(note.updatedAt)} · ${charCount}자 · ${escHtml(folderName)}</div>
        <div class="saved-note-actions">
          <button title="열기" onclick="openSavedNote('${note.id}');event.stopPropagation()">📖 열기</button>
          <button title="폴더 이동" onclick="moveSavedNote('${note.id}');event.stopPropagation()">📁 이동</button>
          <button title="삭제" onclick="confirmDeleteNote('${note.id}');event.stopPropagation()">🗑</button>
        </div>`;
      card.addEventListener('click', () => openSavedNote(note.id));
      list.appendChild(card);
    }
  }

  // Storage size
  const bytes = await getStorageSize();
  const mb    = (bytes / 1024 / 1024).toFixed(2);
  const el    = document.getElementById('storageSize');
  if (el) el.textContent = `${mb} MB`;
}

/* ═══════════════════════════════════════════════
   Open saved note
═══════════════════════════════════════════════ */
async function openSavedNote(id) {
  const note = await getNoteFS(id);
  if (!note) { showToast('노트를 찾을 수 없습니다.'); return; }

  // Branch: notion notes use a dedicated viewer
  if (note.type === 'notion') {
    openNotionNote(note);
    return;
  }

  // Regenerate notesHtml from notesText if missing (Firestore excludes it to stay under 1MB)
  if (!note.notesHtml && note.notesText) {
    note.notesHtml = renderMarkdown(note.notesText);
  }

  clearQuizInlineArea();
  storedNotesText            = note.notesText            || '';
  storedPptText              = note.pptText              || '';
  storedFilteredText         = note.filteredText         || '';
  storedHighlightedTranscript = note.highlightedTranscript || '';
  extractedImages            = note.extractedImages      || [];
  currentNoteId              = note.id;

  const body = document.getElementById('finalNotesBody');
  if (note.notesHtml) {
    body.innerHTML = note.notesHtml;
  } else if (note.notesText) {
    body.innerHTML = renderMarkdown(note.notesText);
  } else {
    body.innerHTML = '<span class="placeholder-msg">노트 내용이 없습니다.</span>';
  }

  // Clear cached split-viewer content so it re-renders from restored state
  const splitNotes      = document.getElementById('splitNotes');
  const splitTranscript = document.getElementById('splitTranscript');
  const splitAccordion  = document.getElementById('splitAccordion');
  if (splitNotes)      splitNotes.innerHTML      = '';
  if (splitTranscript) splitTranscript.innerHTML = '';
  if (splitAccordion)  splitAccordion.innerHTML  = '';
  const splitClassify = document.getElementById('classifyArea');
  if (splitClassify)   splitClassify.innerHTML   = '';
  _classifyCache = null;

  // Enable action buttons (they start disabled until a pipeline runs)
  [quizBtn, classifyBtn, notionCopyBtn, dlNotionFileBtn, copyNotesBtn, dlTxtBtn, dlMdBtn, dlPdfBtn, splitViewBtn].forEach(b => { b.disabled = false; });
  const _dbgBtnRestore = document.getElementById('splitDebugBtn');
  if (_dbgBtnRestore) _dbgBtnRestore.style.display = '';
  document.getElementById('notesActions')?.classList.add('visible');
  document.getElementById('collapseBtn')?.classList.add('visible');

  // Auto-open split viewer
  setTimeout(() => {
    const splitBtn = document.getElementById('splitViewBtn');
    if (splitBtn) splitBtn.click();
  }, 100);
}

/* ═══════════════════════════════════════════════
   Notion file parser
═══════════════════════════════════════════════ */
async function collectMdFromZip(zip, pathPrefix = '', depth = 0) {
  if (depth > 5) return []; // zip-bomb guard
  const results = [];
  const nestedZips = [];

  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const lp = path.toLowerCase();
    if (lp.endsWith('.md')) {
      results.push({ path: pathPrefix + path, getText: () => entry.async('string') });
    } else if (lp.endsWith('.zip')) {
      nestedZips.push({ path, entry });
    }
  });

  for (const { path, entry } of nestedZips) {
    const innerBlob = await entry.async('blob');
    const innerZip  = await JSZip.loadAsync(innerBlob);
    const inner     = await collectMdFromZip(innerZip, pathPrefix + path + '/', depth + 1);
    results.push(...inner);
  }

  return results;
}

async function parseNotionFile(file) {
  let combinedMd = '';

  if (file.name.toLowerCase().endsWith('.md')) {
    combinedMd = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('파일 읽기 실패'));
      reader.readAsText(file, 'UTF-8');
    });
  } else if (file.name.toLowerCase().endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);
    const mdEntries = await collectMdFromZip(zip);
    if (mdEntries.length === 0) {
      alert('마크다운 파일이 없습니다');
      return null;
    }
    mdEntries.sort((a, b) => a.path.localeCompare(b.path));
    const parts = await Promise.all(mdEntries.map(m => m.getText()));
    combinedMd = parts.join('\n\n---\n\n');
  } else {
    alert('.md 또는 .zip 파일만 지원됩니다');
    return null;
  }

  if (!combinedMd.trim()) {
    alert('빈 파일입니다');
    return null;
  }

  // Cleanup: remove Notion UUID suffixes from inline links
  combinedMd = combinedMd.replace(/([^\s\(\)]+?)\s+[a-f0-9]{32}(\.md|\))/g, '$1$2');

  // Extract title from first H1
  let title = '';
  const h1Match = combinedMd.match(/^#\s+(.+)$/m);
  if (h1Match) {
    title = h1Match[1].trim();
    combinedMd = combinedMd.replace(/^#\s+.+\n?/m, '');
  } else {
    title = file.name.replace(/\.(md|zip)$/i, '');
  }

  // Strip Notion metadata block (lines after title removal like Created:, Last edited time:, etc.)
  const metaPattern = /^(Created|Last edited time|Tags|Status|Owner|Type|Date|Priority):\s/i;
  const lines = combinedMd.split('\n');
  let i = 0;
  // Skip leading blank lines then check up to 6 lines for metadata
  while (i < lines.length && lines[i].trim() === '') i++;
  const metaStart = i;
  let metaEnd = i;
  while (metaEnd < metaStart + 6 && metaEnd < lines.length && (lines[metaEnd].trim() === '' || metaPattern.test(lines[metaEnd]))) {
    metaEnd++;
  }
  if (metaEnd > metaStart) {
    lines.splice(metaStart, metaEnd - metaStart);
    combinedMd = lines.join('\n');
  }

  combinedMd = combinedMd.trim();

  if (!combinedMd) {
    alert('빈 파일입니다');
    return null;
  }

  if (combinedMd.length > 500000) {
    const ok = confirm(`파일이 큽니다 (${combinedMd.length.toLocaleString()}자). 계속하시겠습니까?`);
    if (!ok) return null;
  }

  return { title, markdown: combinedMd };
}

/* ═══════════════════════════════════════════════
   Delete note
═══════════════════════════════════════════════ */
async function confirmDeleteNote(id) {
  if (!confirm('이 노트를 삭제하시겠습니까?')) return;
  await deleteNoteFS(id);
  if (currentNoteId === id) currentNoteId = null;
  showToast('🗑 노트 삭제 완료');
  await renderSavedNotes();
  await renderHomeView(); // refresh grid and folder note counts
}

/* ═══════════════════════════════════════════════
   Move note to folder
═══════════════════════════════════════════════ */
async function moveSavedNote(id) {
  const [note, folders] = await Promise.all([getNoteFS(id), getAllFoldersFS()]);
  if (!note) return;

  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  overlay.innerHTML = `
    <div class="db-modal" style="max-height:60vh;">
      <h3>📁 폴더 이동</h3>
      <div class="db-modal-list" id="moveFolderList"></div>
      <div class="db-modal-footer">
        <button onclick="this.closest('.db-modal-overlay').remove()">취소</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('#moveFolderList');
  const allChoices = [{ id: null, name: '미분류 (폴더 없음)' }, ...folders];
  for (const folder of allChoices) {
    const row = document.createElement('div');
    row.className = 'db-modal-row';
    row.style.cursor = 'pointer';
    row.innerHTML = `<span>${folder.id ? '📁 ' : '📄 '}${escHtml(folder.name)}</span>`;
    row.onclick = async () => {
      const newSortOrder = await getNextSortOrder(folder.id, note.id);
      const updated = Object.assign({}, note, { folderId: folder.id, sortOrder: newSortOrder });
      await saveNoteFS(updated);
      overlay.remove();
      showSuccessToast(`📁 "${note.title || '노트'}" 이동 완료`);
      renderSavedNotes();
      renderHomeView();
    };
    listEl.appendChild(row);
  }
}

/* ═══════════════════════════════════════════════
   Folder manager modal
═══════════════════════════════════════════════ */
function detectNoteSplits(htmlContent) {
  const root = document.createElement('div');
  root.innerHTML = htmlContent;

  // Walk top-level nodes collecting text of each
  const nodes = [...root.childNodes];

  // --- Try 주차 pattern first ---
  // Match elements whose text looks like "N주차 ..." or "- N주차 ..."
  const weekRegex = /^[-•\s]*(\d+)\s*주차\s*[-–—:：]?\s*(.+)?/;
  const splits = [];

  let currentTitle = null;
  let currentNodes = [];

  const flush = () => {
    if (currentTitle !== null) {
      const frag = document.createElement('div');
      currentNodes.forEach(n => frag.appendChild(n.cloneNode(true)));
      const html = frag.innerHTML.trim();
      const plainText = frag.innerText?.trim() || frag.textContent.trim();
      if (html) splits.push({ title: currentTitle, html, plainText });
    }
  };

  let foundWeek = false;
  for (const node of nodes) {
    const text = (node.textContent || '').trim();
    const m    = weekRegex.exec(text);
    if (m && text.length < 120) {
      // This node is a split marker
      flush();
      foundWeek = true;
      const weekNum  = m[1];
      const subtitle = (m[2] || '').trim().replace(/[<>()[\]]/g, '').trim();
      currentTitle   = subtitle ? `${weekNum}주차 - ${subtitle}` : `${weekNum}주차`;
      currentNodes   = [];
    } else {
      currentNodes.push(node);
    }
  }
  flush();

  if (foundWeek && splits.length > 0) return splits;

  // --- Fallback: split on <h1> or <h2> elements ---
  const headingNodes = [...root.querySelectorAll('h1, h2')];
  if (headingNodes.length >= 2) {
    currentTitle = null;
    currentNodes = [];
    const allChildren = [...root.childNodes];
    for (const node of allChildren) {
      const tag = node.nodeName;
      if (tag === 'H1' || tag === 'H2') {
        flush();
        currentTitle = (node.textContent || '').trim() || '가져온 노트';
        currentNodes = [];
      } else {
        currentNodes.push(node);
      }
    }
    flush();
    if (splits.length > 0) return splits;
  }

  // --- No markers: single note ---
  const plainText = root.innerText?.trim() || root.textContent.trim();
  return [{ title: '가져온 노트', html: htmlContent, plainText }];
}

function showImportNoteModal() {
  const existing = document.getElementById('importNoteOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'importNoteOverlay';
  overlay.className = 'db-modal-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.innerHTML = `
    <div class="db-modal" style="max-width:620px;display:flex;flex-direction:column;max-height:92vh;gap:0.7rem;">
      <h3 style="flex-shrink:0;">📥 노트 가져오기</h3>
      <div id="importNoteBody" contenteditable="true"
        style="min-height:200px;max-height:40vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:1rem;background:var(--surface2);color:var(--text);font-size:0.88rem;line-height:1.6;outline:none;cursor:text;flex-shrink:0;"
        data-placeholder="노션에서 복사한 내용을 여기에 붙여넣기 (Ctrl+V)"></div>
      <div style="display:flex;align-items:center;gap:0.6rem;flex-shrink:0;">
        <button id="importPreviewBtn" style="padding:0.45rem 1rem;border-radius:6px;border:1px solid var(--border);background:var(--surface3);color:var(--text);font-size:0.85rem;cursor:pointer;">🔍 미리보기</button>
        <span id="importPreviewCount" style="font-size:0.82rem;color:var(--text-muted);"></span>
      </div>
      <div id="importPreviewArea" style="display:none;flex-direction:column;gap:0.4rem;overflow-y:auto;flex:1;min-height:0;"></div>
      <div class="db-modal-footer" style="justify-content:flex-end;flex-shrink:0;">
        <button onclick="this.closest('.db-modal-overlay').remove()" style="background:var(--surface3);color:var(--text);">취소</button>
        <button id="importNoteSaveBtn" disabled style="padding:0.5rem 1.2rem;border-radius:6px;border:none;background:var(--primary);color:#fff;font-size:0.85rem;cursor:pointer;opacity:0.5;">저장</button>
      </div>
    </div>`;

  const body       = overlay.querySelector('#importNoteBody');
  const previewBtn = overlay.querySelector('#importPreviewBtn');
  const previewArea= overlay.querySelector('#importPreviewArea');
  const countEl    = overlay.querySelector('#importPreviewCount');
  const saveBtn    = overlay.querySelector('#importNoteSaveBtn');

  let detectedSplits = [];

  previewBtn.addEventListener('click', () => {
    const html = body.innerHTML.trim();
    if (!html || html === '<br>') { showToast('내용을 붙여넣기 해주세요.'); return; }

    detectedSplits = detectNoteSplits(html);
    countEl.textContent = `${detectedSplits.length}개의 노트가 감지되었습니다`;

    previewArea.innerHTML = detectedSplits.map((s, i) => `
      <div class="import-preview-item">
        <input type="checkbox" checked data-idx="${i}">
        <div class="import-preview-item-body">
          <div class="import-preview-title">${escHtml(s.title)}</div>
          <div class="import-preview-snippet">${escHtml(s.plainText.slice(0, 140))}</div>
        </div>
      </div>`).join('');

    previewArea.style.display = 'flex';
    saveBtn.disabled = false;
    saveBtn.style.opacity = '1';
  });

  saveBtn.addEventListener('click', async () => {
    const checked = [...previewArea.querySelectorAll('input[type=checkbox]:checked')]
      .map(cb => detectedSplits[parseInt(cb.dataset.idx)]).filter(Boolean);

    if (!checked.length) { showToast('저장할 노트를 선택해주세요.'); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중…';

    try {
      const now = new Date().toISOString();
      for (const s of checked) {
        if (!s.title?.trim() || !s.plainText?.trim()) {
          console.warn('[import] skipped empty split');
          continue;
        }
        const id = uuidv4();
        const note = {
          id,
          title:     s.title,
          notesHtml: s.html,
          notesText: s.plainText,
          createdAt: now,
          folderId:  null,
          source:    'import',
          extractedImages: [],
        };
        await saveNote(note);
        const ref = userNotesRef();
        if (ref) {
          const updatedAt = new Date().toISOString();
          ref.doc(id).set({ id, title: s.title, notesText: s.plainText, createdAt: now, source: 'import', folderId: null, updatedAt }, { merge: true })
            .catch(e => console.warn('import Firestore sync failed:', e));
        }
      }
      showToast(`📥 ${checked.length}개 노트 저장 완료`);
      overlay.remove();
      await renderHomeView();
    } catch(e) {
      showToast('❌ 저장 실패: ' + e.message);
      saveBtn.disabled = false;
      saveBtn.textContent = '저장';
    }
  });

  document.body.appendChild(overlay);
  body.focus();
}

async function renameSavedNote(id) {
  const note = await getNoteFS(id);
  if (!note) return;
  const newTitle = prompt('노트 이름:', note.title || '');
  if (!newTitle || newTitle.trim() === note.title) return;
  await saveNoteFS(Object.assign({}, note, { title: newTitle.trim() }));
  await renderSavedNotes();
  await renderHomeView();
}

/* ═══════════════════════════════════════════════
   Export / Import
═══════════════════════════════════════════════ */
async function exportAllNotes() {
  const [notes, folders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
  const data = JSON.stringify({ notes, folders, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `meeting-notes-export-${dateStamp()}.json` });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showSuccessToast('⬇ 내보내기 완료');
}

async function importNotes(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const notes   = data.notes   || [];
    const folders = data.folders || [];
    const [existingNotes, existingFolders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
    const existingNoteIds   = new Set(existingNotes.map(n => n.id));
    const existingFolderIds = new Set(existingFolders.map(f => f.id));
    let imported = 0;
    for (const folder of folders) {
      if (!existingFolderIds.has(folder.id)) { await saveFolderFS(folder); }
    }
    for (const note of notes) {
      if (!existingNoteIds.has(note.id)) { await saveNoteFS(note); imported++; }
    }
    input.value = '';
    showSuccessToast(`⬆ ${imported}개 노트 가져오기 완료`);
    renderSavedNotes();
    renderHomeView();
  } catch (e) {
    showToast(`❌ 가져오기 실패: ${e.message}`);
  }
}
