/* Admin dashboard logic — standalone, no build step */
(function () {
  'use strict';

  const auth = firebase.auth();

  const $loading      = document.getElementById('loading');
  const $authSection  = document.getElementById('auth-section');
  const $errorMsg     = document.getElementById('error-msg');
  const $dashboard    = document.getElementById('dashboard-section');
  const $signinBtn    = document.getElementById('signin-btn');
  const $searchBox    = document.getElementById('search-box');
  const $sortSelect   = document.getElementById('sort-select');
  const $tbody        = document.getElementById('users-tbody');
  const $tfoot        = document.getElementById('users-tfoot');

  let allUsers = [];
  let currentMonth = '';
  let sortKey  = 'lastActivity';
  let sortDir  = -1; // -1 = desc, 1 = asc

  // ── helpers ──────────────────────────────────────────────────────────────

  function show(el)  { el.style.display = ''; }
  function hide(el)  { el.style.display = 'none'; }

  function showError(msg) {
    $errorMsg.textContent = msg;
    show($errorMsg);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' });
    } catch { return iso; }
  }

  function fmtNum(n) {
    if (n == null || n === 0) return '0';
    return Number(n).toLocaleString('ko-KR');
  }

  function fmtSttMin(secs) {
    if (!secs) return '0';
    return (secs / 60).toFixed(1);
  }

  // Current YYYY-MM
  function nowMonthKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function getLastActivity(user) {
    // Most recent lastActivityAt across any usage month
    let best = null;
    for (const u of Object.values(user.usage || {})) {
      if (!u || !u.lastActivityAt) continue;
      if (!best || u.lastActivityAt > best) best = u.lastActivityAt;
    }
    return best;
  }

  function getCurrentUsage(user) {
    return (user.usage || {})[currentMonth] || {};
  }

  function getSortValue(user) {
    const cu = getCurrentUsage(user);
    switch (sortKey) {
      case 'lastActivity': return getLastActivity(user) || '';
      case 'noteCount':    return cu.noteCount    || 0;
      case 'paymentCount': return cu.paymentCount || 0;
      case 'email':        return (user.email || '').toLowerCase();
      case 'plan':         return user.plan || '';
      case 'createdAt':    return user.createdAt || '';
      case 'sttSeconds':   return cu.sttSeconds   || 0;
      case 'quizCount':    return cu.quizCount    || 0;
      default:             return '';
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────

  function renderTable() {
    const filter = $searchBox.value.trim().toLowerCase();

    let rows = allUsers.filter(u => {
      if (!filter) return true;
      return (u.email || '').toLowerCase().includes(filter) ||
             (u.uid || '').toLowerCase().startsWith(filter);
    });

    rows.sort((a, b) => {
      const av = getSortValue(a);
      const bv = getSortValue(b);
      if (av < bv) return sortDir;
      if (av > bv) return -sortDir;
      return 0;
    });

    $tbody.innerHTML = '';

    rows.forEach((user) => {
      const cu  = getCurrentUsage(user);
      const la  = getLastActivity(user);
      const uid = user.uid || '';

      const tr = document.createElement('tr');
      tr.dataset.uid = uid;

      const planBadge = user.plan === 'monthly'
        ? `<span class="badge badge-monthly">월정액</span>`
        : user.singlePurchases > 0
          ? `<span class="badge badge-single">단건(${user.singlePurchases})</span>`
          : `<span class="badge badge-free">무료</span>`;

      const tokens = cu.inputTokens || cu.outputTokens || cu.cachedTokens
        ? `${fmtNum(cu.inputTokens)}/${fmtNum(cu.outputTokens)}/${fmtNum(cu.cachedTokens)}`
        : '—';

      tr.innerHTML = `
        <td class="uid-short" title="${uid}">${uid.slice(0, 8)}…</td>
        <td>${user.email || '—'}</td>
        <td>${planBadge}</td>
        <td>${fmtDate(user.createdAt)}</td>
        <td class="num">${fmtNum(cu.noteCount)}</td>
        <td class="num">${fmtNum(cu.quizCount)}</td>
        <td class="num">${tokens}</td>
        <td class="num">${fmtSttMin(cu.sttSeconds)}</td>
        <td class="num">${fmtNum(cu.paymentCount)}</td>
        <td>${la ? fmtDate(la) : '—'}</td>
      `;

      tr.addEventListener('click', () => toggleDetail(tr, user));
      $tbody.appendChild(tr);
    });

    renderFooter(rows);
  }

  function toggleDetail(tr, user) {
    const existingDetail = tr.nextElementSibling;
    if (existingDetail && existingDetail.classList.contains('detail-row')) {
      existingDetail.remove();
      return;
    }

    const months = Object.keys(user.usage || {}).sort().reverse();
    if (months.length === 0) {
      const dr = document.createElement('tr');
      dr.className = 'detail-row';
      dr.innerHTML = `<td colspan="10"><div class="detail-inner" style="color:var(--text-muted)">사용 기록 없음</div></td>`;
      tr.after(dr);
      return;
    }

    const headerCols = ['월', '노트', '퀴즈', '분류', '입력 토큰', '출력 토큰', '캐시 토큰', 'STT 분', '결제건', '결제 금액(KRW)', '마지막 활동'];
    const headerHtml = headerCols.map(h => `<th>${h}</th>`).join('');

    const rowsHtml = months.map(month => {
      const u = user.usage[month] || {};
      return `<tr>
        <td>${month}</td>
        <td class="num">${fmtNum(u.noteCount)}</td>
        <td class="num">${fmtNum(u.quizCount)}</td>
        <td class="num">${fmtNum(u.classifyCount)}</td>
        <td class="num">${fmtNum(u.inputTokens)}</td>
        <td class="num">${fmtNum(u.outputTokens)}</td>
        <td class="num">${fmtNum(u.cachedTokens)}</td>
        <td class="num">${fmtSttMin(u.sttSeconds)}</td>
        <td class="num">${fmtNum(u.paymentCount)}</td>
        <td class="num">${fmtNum(u.paymentTotalKRW)}</td>
        <td>${u.lastActivityAt ? fmtDate(u.lastActivityAt) : '—'}</td>
      </tr>`;
    }).join('');

    const dr = document.createElement('tr');
    dr.className = 'detail-row';
    dr.innerHTML = `<td colspan="10">
      <div class="detail-inner">
        <strong style="color:var(--text-muted);font-size:11px;">UID: ${user.uid}</strong>
        ${user.email ? `<span style="color:var(--text-muted);margin-left:12px;">${user.email}</span>` : ''}
        <table style="margin-top:8px;width:100%">
          <thead><tr>${headerHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </td>`;
    tr.after(dr);
  }

  function renderFooter(rows) {
    const cm = currentMonth;
    let totalUsers = rows.length;
    let activeUsers = 0;
    let totalNotes = 0, totalTokens = 0, totalRevenue = 0, totalPayments = 0;

    for (const user of rows) {
      const cu = (user.usage || {})[cm] || {};
      if (cu.lastActivityAt) activeUsers++;
      totalNotes    += cu.noteCount    || 0;
      totalTokens   += (cu.inputTokens || 0) + (cu.outputTokens || 0);
      totalRevenue  += cu.paymentTotalKRW || 0;
      totalPayments += cu.paymentCount    || 0;
    }

    $tfoot.innerHTML = `<tr>
      <td colspan="4">
        총 ${fmtNum(totalUsers)}명 &nbsp;|&nbsp; 이번달 활성 ${fmtNum(activeUsers)}명
      </td>
      <td class="num">${fmtNum(totalNotes)}</td>
      <td>—</td>
      <td class="num">${fmtNum(totalTokens)}</td>
      <td>—</td>
      <td class="num">${fmtNum(totalPayments)}</td>
      <td>₩${fmtNum(totalRevenue)}</td>
    </tr>`;
  }

  // ── sort via column headers ───────────────────────────────────────────────

  document.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = -sortDir;
      } else {
        sortKey = key;
        sortDir = -1;
      }
      document.querySelectorAll('thead th').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(sortDir === -1 ? 'sort-desc' : 'sort-asc');
      renderTable();
    });
  });

  $sortSelect.addEventListener('change', () => {
    sortKey = $sortSelect.value;
    sortDir = -1;
    renderTable();
  });

  $searchBox.addEventListener('input', renderTable);

  // ── auth + data fetch ────────────────────────────────────────────────────

  $signinBtn.addEventListener('click', () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(err => showError('로그인 실패: ' + err.message));
  });

  async function loadDashboard(user) {
    hide($loading);
    show($dashboard);

    try {
      const token = await user.getIdToken(true);
      const res = await fetch('/api/admin?action=overview', {
        headers: { 'Authorization': 'Bearer ' + token },
      });

      if (res.status === 403) {
        hide($dashboard);
        showError('관리자 권한이 없는 계정입니다.');
        return;
      }
      if (!res.ok) {
        hide($dashboard);
        showError('서버 오류: ' + res.status);
        return;
      }

      const data = await res.json();
      allUsers = data.users || [];
      currentMonth = nowMonthKey();
      renderTable();
    } catch (e) {
      hide($dashboard);
      showError('데이터 로드 실패: ' + e.message);
    }
  }

  auth.onAuthStateChanged((user) => {
    if (user) {
      hide($authSection);
      loadDashboard(user);
    } else {
      hide($loading);
      show($authSection);
    }
  });
})();
