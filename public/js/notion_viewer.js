// Notion Note Viewer: open/close modal, tab switching, weakness badge overlay.
// Depends on: constants.js (_currentNotionNoteId, currentNoteId, storedNotesText), markdown.js (renderMarkdown), ui.js (showToast), firestore_sync.js (saveNoteFS, deleteNoteFS), quiz.js (showQuizSettings, getWeaknessReport).

/* ═══════════════════════════════════════════════
   Notion Note Viewer
═══════════════════════════════════════════════ */
// Constants, state, DOM refs, Firebase init moved to /js/constants.js

function openNotionNote(note) {
  _currentNotionNoteId = note.id;
  currentNoteId = note.id;
  storedNotesText = note.markdownContent || '';

  const viewer = document.getElementById('notionViewer');
  document.getElementById('notionViewerTitle').textContent = note.title || '제목없음';

  // Render body
  const bodyContent = document.getElementById('notionBodyContent');
  bodyContent.innerHTML = renderMarkdown(note.markdownContent || '');

  // Reset to body tab
  _switchNotionTab('body');

  // Clear any previous quiz area
  const quizArea = document.getElementById('notionQuizArea');
  quizArea.innerHTML = '';
  delete quizArea.dataset.noteId;
  quizArea.style.display = 'flex';

  // Wire up tab buttons
  document.getElementById('notionTabBody').onclick = () => _switchNotionTab('body');
  document.getElementById('notionTabQuiz').onclick = () => _switchNotionTab('quiz');

  // Wire up rename/delete
  document.getElementById('notionViewerRenameBtn').onclick = async () => {
    const newTitle = prompt('노트 이름:', note.title || '');
    if (!newTitle || newTitle.trim() === note.title) return;
    const updated = Object.assign({}, note, { title: newTitle.trim() });
    await saveNoteFS(updated);
    document.getElementById('notionViewerTitle').textContent = newTitle.trim();
    note.title = newTitle.trim();
    showToast('✏️ 이름 변경 완료');
    renderHomeView();
  };

  document.getElementById('notionViewerDeleteBtn').onclick = async () => {
    if (!confirm('이 노트를 삭제하시겠습니까?')) return;
    await deleteNoteFS(note.id);
    _closeNotionViewer();
    showToast('🗑 노트 삭제 완료');
    renderHomeView();
  };

  // Wire up back button
  document.getElementById('notionViewerBackBtn').onclick = _closeNotionViewer;

  viewer.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function _closeNotionViewer() {
  const _nqArea = document.getElementById('notionQuizArea');
  if (_nqArea && _nqArea._quizApi) _nqArea._quizApi.savePartialIfEligible();
  const viewer = document.getElementById('notionViewer');
  viewer.style.display = 'none';
  document.body.style.overflow = '';
  _currentNotionNoteId = null;
}

function _switchNotionTab(tab) {
  const _nqArea = document.getElementById('notionQuizArea');
  if (_nqArea && _nqArea._quizApi) _nqArea._quizApi.savePartialIfEligible();
  document.getElementById('notionTabBody').classList.toggle('active', tab === 'body');
  document.getElementById('notionTabQuiz').classList.toggle('active', tab === 'quiz');
  document.getElementById('notionBodyPanel').style.display  = tab === 'body' ? '' : 'none';
  document.getElementById('notionQuizPanel').style.display  = tab === 'quiz' ? '' : 'none';

  if (tab === 'quiz') {
    const quizArea = document.getElementById('notionQuizArea');
    const needsFreshQuiz =
      quizArea.dataset.noteId !== _currentNotionNoteId ||
      !quizArea.innerHTML.trim() ||
      quizArea.style.display === 'none';
    if (needsFreshQuiz) {
      const note = { id: _currentNotionNoteId, title: document.getElementById('notionViewerTitle').textContent };
      const noteText = storedNotesText;
      if (!noteText) { showToast('노트 내용이 없습니다.'); return; }
      quizArea.innerHTML = '';
      quizArea.dataset.noteId = _currentNotionNoteId;
      quizArea.style.display = 'flex';
      showQuizSettings(note.title, note.id, noteText, quizArea);
    }
  }

  if (tab === 'body' && _currentNotionNoteId) {
    updateNotionWeaknessBadges(_currentNotionNoteId).catch(() => {});
  }
}

async function updateNotionWeaknessBadges(noteId) {
  if (!noteId) return;
  const bodyContent = document.getElementById('notionBodyContent');
  if (!bodyContent) return;
  const h2s = Array.from(bodyContent.querySelectorAll('h2'));
  if (!h2s.length) return;

  const report = await getWeaknessReport(noteId).catch(() => null);
  if (!report || !report.sections.length) return;

  const sectionMap = new Map(report.sections.map(s => [s.name, s]));
  h2s.forEach(h2 => {
    h2.querySelector('.weakness-badge')?.remove();
    const text = h2.textContent.trim();
    const sec  = sectionMap.get(text) || [...sectionMap.values()].find(s => text.includes(s.name) || s.name.includes(text));
    if (!sec) return;
    const cls   = sec.accuracy >= 80 ? 'green' : sec.accuracy >= 50 ? 'yellow' : 'red';
    const badge = document.createElement('span');
    badge.className  = `weakness-badge ${cls}`;
    badge.textContent = sec.accuracy + '%';
    h2.appendChild(badge);
  });
}
