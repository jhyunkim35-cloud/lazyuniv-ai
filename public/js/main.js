// App bootstrap: auth listener, init, initial display state, debug panel ticker, payment callback.
// MUST load last — depends on all other /js/ files.

auth.onAuthStateChanged(user => {
  currentUser = user;
  updateAuthUI();
});

/* ═══════════════════════════════════════════════
   Init — load saved notes on page load
═══════════════════════════════════════════════ */
(async function init() {
  // Load theme preference
  if (localStorage.getItem('theme') === 'light') {
    document.documentElement.classList.add('light');
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = '🌙';
  }
  // Set initial view: home if notes exist, new if empty
  try {
    const notes = await getAllNotesFS();
    switchView(notes.length > 0 ? 'home' : 'new');
  } catch (_) {
    switchView('new');
  }
})();

// Initial state: hide sidebar and content views until auth resolves
document.getElementById('sidebar').style.display = 'none';
document.getElementById('homeView').style.display = 'none';
document.getElementById('landingView').style.display = '';

setInterval(() => {
  const panel = document.getElementById('debugPanel');
  if (panel && panel.style.display === 'flex') {
    const c = document.getElementById('debugLogContent');
    c.textContent = _debugLog.join('\n');
    c.scrollTop = c.scrollHeight;
  }
}, 1000);

// Handle Toss payment callback
(async function handlePaymentCallback() {
  const params = new URLSearchParams(window.location.search);
  const paymentStatus = params.get('payment');
  // Clean URL immediately so paymentKey never leaks to history on error
  window.history.replaceState({}, '', window.location.pathname);
  if (!paymentStatus) return;

  if (paymentStatus === 'success') {
    const paymentKey = params.get('paymentKey');
    const orderId = params.get('orderId');
    const amount = params.get('amount');
    const plan = params.get('plan'); // kept for diagnostics; not used for state

    try {
      // Wait for auth before sending uid to server
      await new Promise(resolve => {
        if (currentUser) resolve();
        else auth.onAuthStateChanged(u => { if (u) resolve(); });
      });
      const uid = currentUser.uid;

      // Verify payment on server — server derives plan from Toss-verified amount and writes Firestore
      const res = await fetch('/api/toss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentKey, orderId, amount: Number(amount), uid })
      });
      const result = await res.json();

      if (result.success) {
        const planLabel = result.plan === 'monthly' ? '월간 무제한' : '단건';
        showSuccessToast(`✅ 결제 완료! ${planLabel} 플랜이 활성화되었습니다.`);
        if (typeof renderHomeView === 'function') await renderHomeView();
      } else {
        showToast('❌ 결제 확인 실패: ' + (result.message || ''));
      }
    } catch (e) {
      showToast('❌ 결제 확인 오류: ' + e.message);
    }
  } else if (paymentStatus === 'fail') {
    showToast('❌ 결제가 취소되었습니다.');
  }
})();
