// Folder manager: create, rename, delete folders; modal UI.
// Depends on: constants.js (FOLDER_COLORS, _activeFolderId), firestore_sync.js (getAllFoldersFS, saveFolderFS, renameFolderFS, deleteFolderFS), ui.js (showToast), markdown.js (escHtml), notes_crud.js (fmtDate), home_view.js (renderHomeView).

async function showFolderManager() {
  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  overlay.id = 'folderManagerOverlay';
  overlay.innerHTML = `
    <div class="db-modal">
      <h3 style="display:flex;align-items:center;gap:0.4rem;"><i data-lucide="folder-cog" class="icon-sm" style="color:var(--primary);"></i><span>폴더 관리</span></h3>
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

    // Use a color dot + name (matching the sidebar/home-view style) instead
    // of a generic 📁 emoji. Falls back to neutral if folder has no color.
    const label = document.createElement('span');
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.gap = '0.4rem';
    const dotColor = folder.color || 'var(--text-muted)';
    label.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escHtml(dotColor)};flex-shrink:0;"></span><span>${escHtml(folder.name)}</span>`;

    const actions = document.createElement('div');
    actions.className = 'db-modal-row-actions';

    const renameBtn = document.createElement('button');
    renameBtn.title = '이름 변경';
    renameBtn.setAttribute('aria-label', '이름 변경');
    renameBtn.innerHTML = '<i data-lucide="pencil" class="icon-sm"></i>';
    renameBtn.addEventListener('click', () => renameFolderPrompt(folder.id, folder.name, folder.color));

    const deleteBtn = document.createElement('button');
    deleteBtn.title = '삭제';
    deleteBtn.setAttribute('aria-label', '삭제');
    deleteBtn.innerHTML = '<i data-lucide="trash-2" class="icon-sm"></i>';
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
  renderHomeView();
}

function renameFolderPrompt(id, currentName, currentColor) {
  showFolderEditModal(id, currentName, currentColor);
}

function showFolderEditModal(id, currentName = '', currentColor = null) {
  const chosenColorRef = { value: currentColor || FOLDER_COLORS[0].value };
  // R3: when editing, look up the existing lectureCode so the input
  // pre-fills with what the user already chose (or stays blank for new
  // folders / folders never linked to a room).
  let initialLectureCode = '';
  if (id) {
    getAllFoldersFS().then(folders => {
      const f = folders.find(x => x.id === id);
      const input = overlay.querySelector('.folderEditLectureInput');
      if (f && f.lectureCode && input) input.value = f.lectureCode;
    }).catch(() => {});
  }
  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  const colorDots = FOLDER_COLORS.map(c =>
    `<span class="folder-color-option${c.value === chosenColorRef.value ? ' selected' : ''}" data-color="${escHtml(c.value)}" style="background:${c.value}" title="${escHtml(c.name)}"></span>`
  ).join('');
  overlay.innerHTML = `
    <div class="db-modal">
      <h3 style="margin-bottom:1rem; font-size:1rem; display:flex; align-items:center; gap:0.4rem;"><i data-lucide="${id ? 'folder-pen' : 'folder-plus'}" class="icon-sm" style="color:var(--primary);"></i><span>${id ? '폴더 편집' : '새 폴더'}</span></h3>
      <div style="margin-bottom:0.8rem;">
        <label style="font-size:0.78rem; font-weight:600; color:var(--text-muted); display:block; margin-bottom:0.3rem;">폴더 이름</label>
        <input class="folderEditNameInput" value="${escHtml(currentName)}" placeholder="폴더 이름..."
          style="width:100%; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--surface2); color:var(--text); font-size:0.85rem; box-sizing:border-box;" />
      </div>
      <div style="margin-bottom:0.8rem;">
        <label style="font-size:0.78rem; font-weight:600; color:var(--text-muted); display:block; margin-bottom:0.3rem;">스터디 룸 초대 코드 (선택)</label>
        <input class="folderEditLectureInput" value="${escHtml(initialLectureCode)}" placeholder="예: PSYC301, 산심2026" maxlength="20"
          style="width:100%; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--surface2); color:var(--text); font-size:0.85rem; box-sizing:border-box;" />
        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:0.25rem;">같은 코드의 스터디 룸에 이 폴더 노트 학습 활동이 공유됩니다 (시간/노트수만, 내용 X)</div>
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
  const lectureInput = overlay.querySelector('.folderEditLectureInput');
  setTimeout(() => nameInput.focus(), 50);

  const doSave = async () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('폴더 이름을 입력하세요.'); return; }
    // R3: lectureCode is optional. Empty string = clear / no linking.
    // renameFolderFS + saveFolderFS persist `null` to make later reads
    // unambiguous (vs "field missing entirely").
    const lectureCode = (lectureInput?.value || '').trim() || null;
    try {
      if (id) {
        await renameFolderFS(id, name, chosenColorRef.value, lectureCode);
      } else {
        await saveFolderFS({ name, color: chosenColorRef.value, lectureCode });
      }
      overlay.remove();
      await refreshFolderManagerList().catch(() => {});
      renderHomeView();
    } catch(e) { showToast(`❌ ${e.message}`); }
  };
  overlay.querySelector('.folderEditConfirmBtn').addEventListener('click', doSave);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
  lectureInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
}

async function deleteFolderConfirm(id) {
  if (!confirm('폴더를 삭제하시겠습니까? (폴더 내 노트는 미분류로 이동됩니다)')) return;
  await deleteFolderFS(id);
  await refreshFolderManagerList();
  // If viewing the deleted folder, return to home
  if (_activeFolderId === id) _activeFolderId = null;
  renderHomeView();
}
