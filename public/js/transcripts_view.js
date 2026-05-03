// Transcripts list view + preview modal + per-card actions.
//
// Two surfaces:
//   1. Full list view (#transcriptsView) — sidebar entry "🎙 내 녹취록"
//   2. Preview modal (lazy-built singleton) — opens when a card is clicked
//
// Depends on: transcripts_store.js (saveTranscriptFS / getAllTranscriptsFS /
//   getTranscriptFS / deleteTranscriptFS / renameTranscriptFS),
//   ui.js (showToast, switchView), markdown.js (escHtml), constants.js
//   (currentUser).
//
// Mirrors the home/note-card patterns used elsewhere — same card metaphor,
// same hover/menu interactions — so users don't need to learn a new vocab.

(function () {

  // ── Helpers ─────────────────────────────────────────────
  function fmtDuration(sec) {
    if (!sec || sec < 1) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `${s}초`;
    if (s === 0) return `${m}분`;
    return `${m}분 ${s}초`;
  }

  // "2026-05-02 16:35" — same shape as defaultTranscriptTitle so the title
  // and the meta line don't visually fight each other.
  function fmtDateTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const yyyy = d.getFullYear();
      const mm   = String(d.getMonth() + 1).padStart(2, '0');
      const dd   = String(d.getDate()).padStart(2, '0');
      const hh   = String(d.getHours()).padStart(2, '0');
      const mi   = String(d.getMinutes()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    } catch { return ''; }
  }

  function previewText(text, maxChars = 180) {
    if (!text) return '';
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > maxChars ? collapsed.slice(0, maxChars) + '…' : collapsed;
  }

  // ── List view ───────────────────────────────────────────
  async function renderTranscriptsView() {
    const grid  = document.getElementById('transcriptsGrid');
    const empty = document.getElementById('emptyTranscriptsMsg');
    const count = document.getElementById('transcriptsViewCount');
    if (!grid) return;

    // Skeleton while loading (matches home_view.js pattern)
    if (!grid.querySelector('.transcript-card')) {
      grid.innerHTML = Array(3).fill(
        '<div class="skeleton-card"><div class="skeleton-line short"></div><div class="skeleton-line medium"></div><div class="skeleton-line long"></div></div>'
      ).join('');
    }

    const items = (typeof getAllTranscriptsFS === 'function')
      ? await getAllTranscriptsFS()
      : [];

    grid.innerHTML = '';
    if (count) count.textContent = items.length;

    if (!items.length) {
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    for (const t of items) {
      grid.appendChild(buildTranscriptCard(t));
    }
  }

  function buildTranscriptCard(t) {
    const card = document.createElement('div');
    card.className = 'transcript-card';
    card.dataset.transcriptId = t.id;

    const dur = fmtDuration(t.durationSec);
    const chars = (t.charCount || (t.text || '').length).toLocaleString();
    const date = fmtDateTime(t.createdAt);

    // Note: escHtml is from markdown.js (depended on by the rest of the app).
    const title = (typeof escHtml === 'function') ? escHtml(t.title || '제목 없음') : (t.title || '제목 없음');
    const preview = (typeof escHtml === 'function')
      ? escHtml(previewText(t.text || ''))
      : previewText(t.text || '');

    const truncatedTag = t.truncated
      ? '<span class="transcript-truncated-tag" title="원본 텍스트가 너무 길어 일부만 저장되었습니다">잘림</span>'
      : '';

    card.innerHTML = `
      <div class="transcript-card-head">
        <div class="transcript-card-title">${title} ${truncatedTag}</div>
        <button class="transcript-card-menu-btn" title="메뉴" aria-label="메뉴"><i data-lucide="more-horizontal" class="icon-sm"></i></button>
      </div>
      <div class="transcript-card-meta">
        <span>${date}</span>
        ${dur ? `<span>· ${dur}</span>` : ''}
        <span>· ${chars}자</span>
      </div>
      <div class="transcript-card-preview">${preview || '<span style="color:var(--text-muted)">(빈 녹취록)</span>'}</div>
    `;

    // Click anywhere except menu → open preview
    card.addEventListener('click', (e) => {
      if (e.target.closest('.transcript-card-menu-btn')) return;
      openTranscriptPreview(t.id);
    });

    // Menu button → contextual menu
    const menuBtn = card.querySelector('.transcript-card-menu-btn');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showCardMenu(menuBtn, t);
    });

    return card;
  }

  // ── Card menu (rename / download / delete) ──────────────
  let _openMenu = null;
  function closeCardMenu() {
    if (_openMenu) {
      _openMenu.remove();
      _openMenu = null;
      document.removeEventListener('click', _outsideMenuListener, true);
    }
  }
  function _outsideMenuListener(e) {
    if (_openMenu && !_openMenu.contains(e.target)) closeCardMenu();
  }
  function showCardMenu(anchorBtn, t) {
    closeCardMenu();
    const menu = document.createElement('div');
    menu.className = 'transcript-card-menu';
    menu.innerHTML = `
      <button data-act="preview">미리보기</button>
      <button data-act="rename">이름 변경</button>
      <button data-act="copy">텍스트 복사</button>
      <button data-act="download">.txt 다운로드</button>
      <button data-act="delete" class="danger">삭제</button>
    `;
    document.body.appendChild(menu);
    _openMenu = menu;

    // Position below the anchor (right-aligned for sane behavior near edge).
    const rect = anchorBtn.getBoundingClientRect();
    const menuW = 180;
    const left = Math.max(8, Math.min(window.innerWidth - menuW - 8, rect.right - menuW));
    menu.style.left = `${left}px`;
    menu.style.top  = `${rect.bottom + 4 + window.scrollY}px`;

    menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      closeCardMenu();
      if (act === 'preview')  openTranscriptPreview(t.id);
      else if (act === 'rename')   await renameTranscriptPrompt(t);
      else if (act === 'copy')     await copyTranscriptText(t);
      else if (act === 'download') downloadTranscriptTxt(t);
      else if (act === 'delete')   await confirmDeleteTranscript(t);
    });

    // Close on outside click — defer to next tick so the click that opened
    // the menu doesn't immediately close it.
    setTimeout(() => document.addEventListener('click', _outsideMenuListener, true), 0);
  }

  // ── Action handlers ─────────────────────────────────────
  async function renameTranscriptPrompt(t) {
    const newTitle = prompt('새 제목을 입력하세요:', t.title || '');
    if (newTitle == null) return;
    const trimmed = newTitle.trim();
    if (!trimmed || trimmed === t.title) return;
    try {
      await renameTranscriptFS(t.id, trimmed);
      window.showToast?.('✅ 이름이 변경되었습니다.');
      // Refresh both the list view (if we're on it) and the preview modal title.
      if (_currentView === 'transcripts') renderTranscriptsView();
      const titleEl = document.getElementById('transcriptPreviewTitle');
      if (titleEl && titleEl.dataset.transcriptId === t.id) {
        titleEl.textContent = trimmed;
      }
      updateMyTranscriptsCount(); // (count doesn't change on rename, but safe)
    } catch (e) {
      console.error('[renameTranscript] failed:', e);
      window.showToast?.('❌ 이름 변경에 실패했습니다.');
    }
  }

  async function copyTranscriptText(t) {
    // Re-fetch in case the card snapshot is stale.
    const fresh = (typeof getTranscriptFS === 'function') ? await getTranscriptFS(t.id) : t;
    const text = (fresh && fresh.text) || t.text || '';
    if (!text) {
      window.showToast?.('복사할 텍스트가 없습니다.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      window.showToast?.('📋 클립보드에 복사되었습니다.');
    } catch (e) {
      console.error('[copyTranscriptText] failed:', e);
      window.showToast?.('❌ 복사에 실패했습니다.');
    }
  }

  function downloadTranscriptTxt(t) {
    const text = t.text || '';
    if (!text) {
      window.showToast?.('내용이 없습니다.');
      return;
    }
    // Sanitize title for filename — keep Korean chars, drop OS-unsafe ones.
    const safeName = (t.title || 'transcript').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function confirmDeleteTranscript(t) {
    if (!confirm(`"${t.title}" 녹취록을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      await deleteTranscriptFS(t.id);
      window.showToast?.('🗑 삭제되었습니다.');
      // Close preview if it was showing this transcript.
      const titleEl = document.getElementById('transcriptPreviewTitle');
      if (titleEl && titleEl.dataset.transcriptId === t.id) {
        hidePreviewModal();
      }
      if (_currentView === 'transcripts') renderTranscriptsView();
      updateMyTranscriptsCount();
    } catch (e) {
      console.error('[deleteTranscript] failed:', e);
      window.showToast?.('❌ 삭제에 실패했습니다.');
    }
  }

  // ── Preview modal (lazy singleton) ──────────────────────
  let _previewEl = null;

  function ensurePreviewModal() {
    if (_previewEl) return _previewEl;
    _previewEl = document.createElement('div');
    _previewEl.id = 'transcriptPreviewModal';
    _previewEl.className = 'transcript-preview-modal hidden';
    _previewEl.innerHTML = `
      <div class="transcript-preview-backdrop"></div>
      <div class="transcript-preview-panel" role="dialog" aria-modal="true">
        <header class="transcript-preview-head">
          <div class="transcript-preview-title-wrap">
            <div id="transcriptPreviewTitle" class="transcript-preview-title">제목</div>
            <div id="transcriptPreviewMeta" class="transcript-preview-meta"></div>
          </div>
          <button id="transcriptPreviewCloseBtn" class="transcript-preview-close" aria-label="닫기"><i data-lucide="x" class="icon-sm"></i></button>
        </header>
        <div id="transcriptPreviewBody" class="transcript-preview-body"></div>
        <footer class="transcript-preview-footer">
          <button id="transcriptPreviewRenameBtn"   class="action-btn"><i data-lucide="pencil" class="icon-sm"></i><span>이름 변경</span></button>
          <button id="transcriptPreviewCopyBtn"     class="action-btn"><i data-lucide="copy" class="icon-sm"></i><span>텍스트 복사</span></button>
          <button id="transcriptPreviewDownloadBtn" class="action-btn"><i data-lucide="download" class="icon-sm"></i><span>.txt 다운로드</span></button>
          <button id="transcriptPreviewDeleteBtn"   class="action-btn danger"><i data-lucide="trash-2" class="icon-sm"></i><span>삭제</span></button>
        </footer>
      </div>
    `;
    document.body.appendChild(_previewEl);

    _previewEl.querySelector('.transcript-preview-backdrop').addEventListener('click', hidePreviewModal);
    _previewEl.querySelector('#transcriptPreviewCloseBtn').addEventListener('click', hidePreviewModal);

    // Action buttons stash the current transcript on the title element via dataset.
    function currentTranscript() {
      const id = document.getElementById('transcriptPreviewTitle')?.dataset.transcriptId;
      if (!id) return null;
      const cached = _previewEl._currentTranscript;
      return cached && cached.id === id ? cached : null;
    }
    document.getElementById('transcriptPreviewRenameBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) renameTranscriptPrompt(t);
    });
    document.getElementById('transcriptPreviewCopyBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) copyTranscriptText(t);
    });
    document.getElementById('transcriptPreviewDownloadBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) downloadTranscriptTxt(t);
    });
    document.getElementById('transcriptPreviewDeleteBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) confirmDeleteTranscript(t);
    });

    // Esc to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !_previewEl.classList.contains('hidden')) {
        hidePreviewModal();
      }
    });

    return _previewEl;
  }

  async function openTranscriptPreview(id) {
    const t = (typeof getTranscriptFS === 'function') ? await getTranscriptFS(id) : null;
    if (!t) {
      window.showToast?.('녹취록을 찾을 수 없습니다.');
      return;
    }
    ensurePreviewModal();
    _previewEl._currentTranscript = t;

    const titleEl = document.getElementById('transcriptPreviewTitle');
    const metaEl  = document.getElementById('transcriptPreviewMeta');
    const bodyEl  = document.getElementById('transcriptPreviewBody');
    titleEl.textContent       = t.title || '제목 없음';
    titleEl.dataset.transcriptId = t.id;

    const dur   = fmtDuration(t.durationSec);
    const chars = (t.charCount || (t.text || '').length).toLocaleString();
    const date  = fmtDateTime(t.createdAt);
    const truncatedNote = t.truncated ? ' · ⚠ 일부 잘림' : '';
    metaEl.textContent = [date, dur, `${chars}자${truncatedNote}`].filter(Boolean).join(' · ');

    // Render as preformatted text — preserves paragraph breaks from the
    // STT output without trying to interpret it as markdown.
    bodyEl.textContent = t.text || '';

    _previewEl.classList.remove('hidden');
  }

  function hidePreviewModal() {
    if (_previewEl) _previewEl.classList.add('hidden');
  }

  // ── Home-card transcript count ──────────────────────────
  // The home page's record button has a "내 녹취록 N개" link in it. Updated
  // on:  login, after recordings finish, after rename/delete, on view switch.
  async function updateMyTranscriptsCount() {
    const el = document.getElementById('myTranscriptsCount');
    if (!el) return;
    if (!currentUser) { el.textContent = '0'; return; }
    try {
      const items = await getAllTranscriptsFS();
      el.textContent = String(items.length);
    } catch (e) {
      // best-effort
    }
  }

  // ── Public API ──────────────────────────────────────────
  window.renderTranscriptsView    = renderTranscriptsView;
  window.openTranscriptPreview    = openTranscriptPreview;
  window.updateMyTranscriptsCount = updateMyTranscriptsCount;

})();
