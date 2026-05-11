// Cost-splitting groups — UI module.
// Depends on: constants.js (currentNoteId), firebase auth (idToken),
// ui.js (showToast, showSuccessToast).
// Backend: POST /api/group-create, POST /api/group-join.
//
// Flow: creator opens "친구랑 나누기" from a note detail → modal → form
// (lecture name, total cost, expected minutes, audio path) → API call →
// invite link displayed → share via system share sheet, KakaoTalk, or copy.

(function () {
  'use strict';

  // ── DOM helpers (no jQuery, no innerHTML interpolation of untrusted data) ─
  function $(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function toast(msg, kind = 'info') {
    if (kind === 'success' && typeof showSuccessToast === 'function') return showSuccessToast(msg);
    if (typeof showToast === 'function') return showToast(msg);
    console.log('[groups]', msg);
  }

  async function getIdToken() {
    try {
      const u = firebase.auth().currentUser;
      if (!u) return null;
      return await u.getIdToken();
    } catch (e) {
      console.error('[groups] getIdToken failed', e);
      return null;
    }
  }

  // ── Style injection (scoped, idempotent) ──────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('groups-styles')) return;
    const css = `
      .groups-overlay {
        position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999; padding: 16px;
      }
      .groups-modal {
        background: var(--surface, #fff); border-radius: 16px;
        max-width: 480px; width: 100%; max-height: 90vh; overflow-y: auto;
        padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.15);
      }
      .groups-modal h2 {
        margin: 0 0 4px; font-size: 18px; font-weight: 700;
        color: var(--text, #0f172a);
      }
      .groups-modal .subtitle {
        margin: 0 0 20px; font-size: 13px; color: var(--text-muted, #64748b);
      }
      .groups-field { margin-bottom: 14px; }
      .groups-field label {
        display: block; font-size: 12px; font-weight: 600;
        color: var(--text, #0f172a); margin-bottom: 6px;
      }
      .groups-field input {
        width: 100%; padding: 10px 12px; border: 1px solid var(--border, #e2e8f0);
        border-radius: 8px; font-size: 14px; box-sizing: border-box;
        background: var(--surface, #fff); color: var(--text, #0f172a);
      }
      .groups-field input:focus {
        outline: none; border-color: var(--primary, #7c3aed);
        box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.12);
      }
      .groups-field .hint {
        font-size: 11px; color: var(--text-muted, #94a3b8); margin-top: 4px;
      }
      .groups-actions {
        display: flex; gap: 8px; margin-top: 20px;
      }
      .groups-btn {
        flex: 1; padding: 10px 16px; border-radius: 8px; font-size: 14px;
        font-weight: 600; cursor: pointer; border: none; transition: all 0.15s;
      }
      .groups-btn-primary {
        background: var(--primary, #7c3aed); color: #fff;
      }
      .groups-btn-primary:hover:not(:disabled) { background: #6d28d9; }
      .groups-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .groups-btn-secondary {
        background: transparent; color: var(--text, #0f172a);
        border: 1px solid var(--border, #e2e8f0);
      }
      .groups-btn-secondary:hover { background: var(--surface-2, #f8fafc); }
      .groups-invite-box {
        background: var(--surface-2, #f8fafc); border: 1px solid var(--border, #e2e8f0);
        border-radius: 10px; padding: 14px; margin: 16px 0;
      }
      .groups-invite-url {
        font-family: monospace; font-size: 13px; color: var(--primary, #7c3aed);
        word-break: break-all; background: #fff; padding: 8px 10px;
        border-radius: 6px; border: 1px solid var(--border, #e2e8f0);
      }
      .groups-share-row {
        display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;
      }
      .groups-share-btn {
        flex: 1; min-width: 100px; padding: 10px; border-radius: 8px;
        border: 1px solid var(--border, #e2e8f0); background: #fff;
        cursor: pointer; font-size: 13px; font-weight: 600;
        color: var(--text, #0f172a); display: flex; align-items: center;
        justify-content: center; gap: 6px; transition: all 0.15s;
      }
      .groups-share-btn:hover { border-color: var(--primary, #7c3aed); }
      .groups-share-btn.kakao { background: #fee500; border-color: #fee500; }
      .groups-share-btn.kakao:hover { background: #fdd835; }
    `;
    const style = document.createElement('style');
    style.id = 'groups-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Group create modal ────────────────────────────────────────────────────
  function openGroupCreateModal(opts = {}) {
    ensureStyles();

    const defaults = {
      lectureName: opts.lectureName || '',
      totalCost: opts.totalCost || 1500,
      expectedMinutes: opts.expectedMinutes || 90,
      audioStoragePath: opts.audioStoragePath || '',
      noteId: opts.noteId || null,
    };

    // Hard gate: without a recording, there is nothing for friends to share.
    // The caller (the shareGroupBtn handler in index.html) is supposed to
    // check this first and toast, but defend-in-depth in case it's called
    // from somewhere else later.
    if (!defaults.audioStoragePath || !defaults.audioStoragePath.startsWith('users/')) {
      toast('이 노트는 녹음 파일이 없어 공유할 수 없습니다');
      return;
    }

    // Inputs (audio path is now derived from the note, not user-entered)
    const lectureInput = $('input', { type: 'text', placeholder: '예: 산업심리학 5주차', value: defaults.lectureName, maxlength: 100 });
    const costInput    = $('input', { type: 'number', min: 100, max: 50000, step: 100, value: defaults.totalCost });
    const minutesInput = $('input', { type: 'number', min: 1, max: 300, value: defaults.expectedMinutes });

    const inviteBox = $('div', { class: 'groups-invite-box', style: 'display:none' });
    const submitBtn = $('button', { class: 'groups-btn groups-btn-primary' }, '그룹 만들기');
    const cancelBtn = $('button', { class: 'groups-btn groups-btn-secondary' }, '취소');

    const overlay = $('div', { class: 'groups-overlay' });
    const modal = $('div', { class: 'groups-modal' });
    overlay.appendChild(modal);

    function close() {
      overlay.remove();
    }
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    submitBtn.addEventListener('click', async () => {
      const lectureName = lectureInput.value.trim();
      const totalCost = Number(costInput.value);
      const expectedMinutes = Number(minutesInput.value);
      const audioStoragePath = defaults.audioStoragePath; // pre-validated above

      if (!lectureName) return toast('강의명을 입력해주세요');
      if (!(totalCost > 0 && totalCost <= 50000)) return toast('총 비용은 100~50000원');
      if (!(expectedMinutes > 0 && expectedMinutes <= 300)) return toast('예상 시간은 1~300분');

      submitBtn.disabled = true;
      submitBtn.textContent = '만드는 중...';

      const idToken = await getIdToken();
      if (!idToken) {
        submitBtn.disabled = false;
        submitBtn.textContent = '그룹 만들기';
        return toast('로그인이 필요합니다');
      }

      try {
        const res = await fetch('/api/group-create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + idToken,
          },
          body: JSON.stringify({
            lectureName,
            totalCost,
            expectedMinutes,
            audioStoragePath,
            noteId: defaults.noteId,
            idempotencyKey: defaults.noteId ? `note-${defaults.noteId}` : null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || ('http_' + res.status));
        }
        showInviteResult(inviteBox, data, lectureName);
        submitBtn.style.display = 'none';
        cancelBtn.textContent = '닫기';
      } catch (e) {
        console.error('[groups] create failed', e);
        toast('그룹 생성 실패: ' + (e.message || 'unknown'));
        submitBtn.disabled = false;
        submitBtn.textContent = '그룹 만들기';
      }
    });

    // Build modal body
    modal.appendChild($('h2', {}, '👥 친구랑 비용 나누기'));
    modal.appendChild($('p', { class: 'subtitle' }, '원작자가 선결제하고 친구들이 사후에 분담 송금합니다.'));

    modal.appendChild(field('강의명', lectureInput, '나중에 그룹 이름으로 표시됩니다'));
    modal.appendChild(field('총 STT 비용 (원)', costInput, '내가 결제한 실제 금액'));
    modal.appendChild(field('예상 강의 시간 (분)', minutesInput));

    // Info row: audio is auto-linked from the note — no user input required
    const audioInfo = $('div', { style: 'background:var(--surface-2,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:var(--text-muted,#64748b);display:flex;align-items:center;gap:8px' });
    audioInfo.appendChild($('span', { style: 'flex-shrink:0' }, '🎙️'));
    audioInfo.appendChild($('span', {}, '녹음 파일이 이 노트에 자동 연결됩니다'));
    modal.appendChild(audioInfo);

    modal.appendChild(inviteBox);

    const actions = $('div', { class: 'groups-actions' });
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    modal.appendChild(actions);

    document.body.appendChild(overlay);
    setTimeout(() => lectureInput.focus(), 50);
  }

  function field(label, input, hint) {
    const wrap = $('div', { class: 'groups-field' });
    wrap.appendChild($('label', {}, label));
    wrap.appendChild(input);
    if (hint) wrap.appendChild($('div', { class: 'hint' }, hint));
    return wrap;
  }

  // ── Invite result panel ───────────────────────────────────────────────────
  function showInviteResult(box, data, lectureName) {
    box.style.display = 'block';
    box.replaceChildren();

    const url = `${location.origin}/?join=${encodeURIComponent(data.inviteToken)}`;

    box.appendChild($('div', { style: 'font-weight:600;font-size:14px;margin-bottom:8px' }, '✅ 그룹 생성 완료'));
    box.appendChild($('div', { style: 'font-size:12px;color:var(--text-muted,#64748b);margin-bottom:8px' }, '아래 링크를 친구한테 공유하세요'));

    const urlBox = $('div', { class: 'groups-invite-url' }, url);
    box.appendChild(urlBox);

    const row = $('div', { class: 'groups-share-row' });

    // Copy button
    const copyBtn = $('button', { class: 'groups-share-btn',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = '✓ 복사됨';
          setTimeout(() => { copyBtn.replaceChildren(document.createTextNode('📋 복사')); }, 2000);
        } catch (e) {
          toast('복사 실패');
        }
      }
    }, '📋 복사');
    row.appendChild(copyBtn);

    // System share (works on mobile = native share sheet incl. KakaoTalk)
    if (navigator.share) {
      const shareBtn = $('button', { class: 'groups-share-btn',
        onclick: async () => {
          try {
            await navigator.share({
              title: 'Notyx 강의 그룹 초대',
              text: `${lectureName} 강의 노트/녹취록 공유 그룹에 참여하세요`,
              url,
            });
          } catch (e) {
            if (e.name !== 'AbortError') toast('공유 실패');
          }
        }
      }, '📤 공유');
      row.appendChild(shareBtn);
    }

    // KakaoTalk web share fallback (opens mobile Kakao or browser tab)
    const kakaoText = encodeURIComponent(`${lectureName} 강의 노트/녹취록 공유 그룹 ${url}`);
    const kakaoBtn = $('a', {
      class: 'groups-share-btn kakao',
      href: `https://accounts.kakao.com/weblogin/share?u=${encodeURIComponent(url)}&text=${kakaoText}`,
      target: '_blank',
      rel: 'noopener',
    }, '💬 카카오톡');
    row.appendChild(kakaoBtn);

    box.appendChild(row);
  }

  // ── Group join modal ──────────────────────────────────────────────────────
  // Called when a friend clicks an invite link (?join=<token>) and auth is
  // ready. The modal shows a confirm gate first — joining is idempotent on
  // the backend (re-clicking is a no-op) but we still want explicit consent
  // so the user understands what they're entering.
  function openGroupJoinModal({ token } = {}) {
    ensureStyles();
    if (!token || typeof token !== 'string') {
      toast('초대 링크가 올바르지 않습니다');
      return;
    }

    const overlay = $('div', { class: 'groups-overlay' });
    const modal = $('div', { class: 'groups-modal' });
    overlay.appendChild(modal);

    function close() { overlay.remove(); }

    const joinBtn = $('button', { class: 'groups-btn groups-btn-primary' }, '합류하기');
    const cancelBtn = $('button', { class: 'groups-btn groups-btn-secondary' }, '취소');
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const statusBox = $('div', { class: 'groups-invite-box', style: 'display:none' });

    joinBtn.addEventListener('click', async () => {
      joinBtn.disabled = true;
      joinBtn.textContent = '합류 중...';
      const idToken = await getIdToken();
      if (!idToken) {
        joinBtn.disabled = false;
        joinBtn.textContent = '합류하기';
        return toast('로그인이 필요합니다');
      }
      try {
        const res = await fetch('/api/group-join', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + idToken,
          },
          body: JSON.stringify({ inviteToken: token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 404) throw new Error('group_not_found');
          if (res.status === 403 && data.error === 'group_full') throw new Error('group_full');
          if (res.status === 403 && data.error === 'group_inactive') throw new Error('group_inactive');
          throw new Error(data.error || ('http_' + res.status));
        }
        showJoinSuccess(statusBox, data);
        joinBtn.style.display = 'none';
        cancelBtn.textContent = '닫기';
      } catch (e) {
        console.error('[groups] join failed', e);
        const msg = (
          e.message === 'group_not_found' ? '그룹을 찾을 수 없습니다 (만료된 링크일 수 있어요)' :
          e.message === 'group_full' ? '그룹 정원이 가득 찼습니다' :
          e.message === 'group_inactive' ? '비활성화된 그룹입니다' :
          e.message === 'bad_token' ? '초대 토큰이 올바르지 않습니다' :
          '합류 실패: ' + (e.message || 'unknown')
        );
        showJoinError(statusBox, msg);
        joinBtn.disabled = false;
        joinBtn.textContent = '합류하기';
      }
    });

    modal.appendChild($('h2', {}, '👥 강의 그룹 합류'));
    modal.appendChild($('p', { class: 'subtitle' }, '친구가 공유한 강의 노트/녹취록 그룹에 합류합니다.'));

    const summary = $('div', { style: 'background:var(--surface-2,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:14px;margin-bottom:8px;font-size:13px;line-height:1.6' });
    summary.appendChild($('div', { style: 'font-weight:600;margin-bottom:6px' }, '합류하면…'));
    const ul = $('ul', { style: 'margin:0;padding-left:18px;color:var(--text-muted,#64748b)' });
    ul.appendChild($('li', {}, '그룹의 강의 노트와 녹취록을 함께 볼 수 있어요'));
    ul.appendChild($('li', {}, '원작자가 결제한 STT 비용을 나중에 분담 송금할 수 있어요'));
    ul.appendChild($('li', {}, '내 학습 데이터는 그대로 비공개로 유지됩니다'));
    summary.appendChild(ul);
    modal.appendChild(summary);

    modal.appendChild(statusBox);

    const actions = $('div', { class: 'groups-actions' });
    actions.appendChild(cancelBtn);
    actions.appendChild(joinBtn);
    modal.appendChild(actions);

    document.body.appendChild(overlay);
  }

  function showJoinSuccess(box, data) {
    box.style.display = 'block';
    box.replaceChildren();
    box.appendChild($('div', { style: 'font-weight:600;font-size:14px;color:var(--primary,#7c3aed);margin-bottom:6px' },
      '✅ "' + (data.lectureName || '강의') + '" 그룹 합류 완료'));
    box.appendChild($('div', { style: 'font-size:12px;color:var(--text-muted,#64748b)' },
      '현재 멤버 ' + (data.memberCount || 1) + '명' + (data.already ? ' (이미 멤버였어요)' : '')));
    box.appendChild($('div', { style: 'font-size:11px;color:var(--text-muted,#94a3b8);margin-top:8px' },
      '그룹 노트/녹취록 보기는 곧 추가됩니다.'));
  }

  function showJoinError(box, msg) {
    box.style.display = 'block';
    box.replaceChildren();
    box.appendChild($('div', { style: 'font-weight:600;font-size:13px;color:#dc2626' }, '❌ ' + msg));
  }

  // ── Expose ────────────────────────────────────────────────────────────────
  window.openGroupCreateModal = openGroupCreateModal;
  window.openGroupJoinModal = openGroupJoinModal;
})();
