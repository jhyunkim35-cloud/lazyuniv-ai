// Folder manager: create, rename, delete folders; modal UI.
// Depends on: constants.js (FOLDER_COLORS, _activeFolderId), firestore_sync.js (getAllFoldersFS, saveFolderFS, renameFolderFS, deleteFolderFS), ui.js (showToast), markdown.js (escHtml), notes_crud.js (renderSavedNotes), home_view.js (renderHomeView).

async function showFolderManager() {
  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  overlay.id = 'folderManagerOverlay';
  overlay.innerHTML = `
    <div class="db-modal">
      <h3>📁 폴더 관리</h3>
      <div class="db-modal-list" id="folderManagerList"></div>
      <div class="db-modal-footer">
        <input id="newFolderInput" type="text" placeholder="새 폴더 이름..." />
        <button onclick="createFolderFromInput()">만들기</button>
        <button onclick="document.getElementById('folderManagerOverlay').remove()">닫기</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  await refreshFolderManagerList();
}

async function refreshFolderManagerList() {
  const listEl = document.getElementById('folderManagerList');
  if (!listEl) return;
  const folders = await getAllFoldersFS();
  listEl.innerHTML = '';
  if (!folders.length) {
    listEl.innerHTML = '<div style="font-size:0.82rem; color:var(--text-muted); padding:0.5rem;">폴더가 없습니다.</div>';
    return;
  }
  for (const folder of folders) {
    const row = document.createElement('div');
    row.className = 'db-modal-row';
    row.dataset.folderId = folder.id;

    const label = document.createElement('span');
    label.textContent = `📁 ${folder.name}`;

    const actions = document.createElement('div');
    actions.className = 'db-modal-row-actions';

    const renameBtn = document.createElement('button');
    renameBtn.title = '이름 변경';
    renameBtn.textContent = '✏️';
    renameBtn.addEventListener('click', () => renameFolderPrompt(folder.id, folder.name, folder.color));

    const deleteBtn = document.createElement('button');
    deleteBtn.title = '삭제';
    deleteBtn.textContent = '🗑';
    deleteBtn.addEventListener('click', () => deleteFolderConfirm(folder.id));

    actions.append(renameBtn, deleteBtn);
    row.append(label, actions);
    listEl.appendChild(row);
  }
}

async function createFolderFromInput() {
  const input = document.getElementById('newFolderInput');
  const name  = input?.value.trim();
  if (!name) return;
  await saveFolderFS({ name });
  input.value = '';
  await refreshFolderManagerList();
  renderSavedNotes();
  renderHomeView();
}

function renameFolderPrompt(id, currentName, currentColor) {
  showFolderEditModal(id, currentName, currentColor);
}

function showFolderEditModal(id, currentName = '', currentColor = null) {
  const chosenColorRef = { value: currentColor || FOLDER_COLORS[0].value };
  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  const colorDots = FOLDER_COLORS.map(c =>
    `<span class="folder-color-option${c.value === chosenColorRef.value ? ' selected' : ''}" data-color="${escHtml(c.value)}" style="background:${c.value}" title="${escHtml(c.name)}"></span>`
  ).join('');
  overlay.innerHTML = `
    <div class="db-modal">
      <h3 style="margin-bottom:1rem; font-size:1rem;">${id ? '📁 폴더 편집' : '📁 새 폴더'}</h3>
      <div style="margin-bottom:0.8rem;">
        <label style="font-size:0.78rem; font-weight:600; color:var(--text-muted); display:block; margin-bottom:0.3rem;">폴더 이름</label>
        <input class="folderEditNameInput" value="${escHtml(currentName)}" placeholder="폴더 이름..."
          style="width:100%; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--surface2); color:var(--text); font-size:0.85rem; box-sizing:border-box;" />
      </div>
      <div style="margin-bottom:1rem;">
        <label style="font-size:0.78rem; font-weight:600; color:var(--text-muted); display:block; margin-bottom:0.4rem;">색상</label>
        <div class="folder-color-picker">${colorDots}</div>
      </div>
      <div class="db-modal-footer">
        <button onclick="this.closest('.db-modal-overlay').remove()">취소</button>
        <button class="folderEditConfirmBtn" style="background:var(--primary); color:#fff; border:none; border-radius:6px; padding:0.4rem 1rem; cursor:pointer; font-size:0.85rem;">저장</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelectorAll('.folder-color-option').forEach(dot => {
    dot.addEventListener('click', () => {
      overlay.querySelectorAll('.folder-color-option').forEach(d => d.classList.remove('selected'));
      dot.classList.add('selected');
      chosenColorRef.value = dot.dataset.color;
    });
  });

  const nameInput = overlay.querySelector('.folderEditNameInput');
  setTimeout(() => nameInput.focus(), 50);

  const doSave = async () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('폴더 이름을 입력하세요.'); return; }
    try {
      if (id) {
        await renameFolderFS(id, name, chosenColorRef.value);
      } else {
        await saveFolderFS({ name, color: chosenColorRef.value });
      }
      overlay.remove();
      await refreshFolderManagerList().catch(() => {});
      renderSavedNotes();
      renderHomeView();
    } catch(e) { showToast(`❌ ${e.message}`); }
  };
  overlay.querySelector('.folderEditConfirmBtn').addEventListener('click', doSave);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
}

async function deleteFolderConfirm(id) {
  if (!confirm('폴더를 삭제하시겠습니까? (폴더 내 노트는 미분류로 이동됩니다)')) return;
  await deleteFolderFS(id);
  await refreshFolderManagerList();
  renderSavedNotes();
  // If viewing the deleted folder, return to home
  if (_activeFolderId === id) _activeFolderId = null;
  renderHomeView();
}
