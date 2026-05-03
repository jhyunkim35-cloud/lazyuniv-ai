// Payment: usage quota, plan management, Toss payment flow.
// Depends on: constants.js (currentUser, db, DEVELOPER_EMAILS), ui.js (showToast).

function showPaymentModal() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:16px;padding:2rem;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
      <h2 style="margin:0 0 0.5rem;font-size:1.3rem;color:var(--text);">🔒 무료 이용 한도 초과</h2>
      <p style="color:var(--text-muted);font-size:0.9rem;margin-bottom:1.5rem;">이번 달 무료 3회를 모두 사용했습니다.</p>
      <div style="display:flex;flex-direction:column;gap:0.8rem;margin-bottom:1.5rem;">
        <button onclick="startPayment('single')" style="padding:1rem;border:2px solid var(--primary);border-radius:12px;background:transparent;color:var(--text);cursor:pointer;text-align:left;">
          <div style="font-weight:700;font-size:1rem;">📝 1회 이용권 — ₩500</div>
          <div style="font-size:0.82rem;color:var(--text-muted);margin-top:0.3rem;">이번 분석 1회만 결제</div>
        </button>
        <button onclick="startPayment('monthly')" style="padding:1rem;border:2px solid var(--secondary);border-radius:12px;background:linear-gradient(135deg,rgba(124,77,255,0.08),rgba(0,180,216,0.08));color:var(--text);cursor:pointer;text-align:left;">
          <div style="font-weight:700;font-size:1rem;">🎓 월정액 — ₩7,900/월</div>
          <div style="font-size:0.82rem;color:var(--text-muted);margin-top:0.3rem;">한 달간 무제한 이용</div>
        </button>
      </div>
      <button onclick="this.closest('div[style*=fixed]').remove()" style="width:100%;padding:0.7rem;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text-muted);cursor:pointer;font-size:0.85rem;">닫기</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function startPayment(plan) {
  // Close payment modal
  document.querySelector('div[style*="position:fixed"][style*="z-index:10000"]')?.remove();

  const amount = plan === 'monthly' ? 7900 : 500;
  const orderName = plan === 'monthly' ? 'Lazyuniv AI 월정액' : 'Lazyuniv AI 1회 이용권';
  const orderId = 'order_' + currentUser.uid.substring(0, 8) + '_' + Date.now();

  try {
    const tossPayments = TossPayments('test_ck_mBZ1gQ4YVXBjEx6651Wj8l2KPoqN');
    const payment = tossPayments.payment({ customerKey: currentUser.uid });

    await payment.requestPayment({
      method: 'CARD',
      amount: { currency: 'KRW', value: amount },
      orderId,
      orderName,
      customerEmail: currentUser.email,
      customerName: currentUser.displayName || '사용자',
      successUrl: window.location.origin + '?payment=success&plan=' + plan + '&orderId=' + orderId,
      failUrl: window.location.origin + '?payment=fail',
    });
  } catch (e) {
    if (e.code === 'USER_CANCEL') return;
    showToast('❌ 결제 실패: ' + e.message);
  }
}

/* ═══════════════════════════════════════════════
   Usage quota and plan functions (moved from firestore_sync.js)
═══════════════════════════════════════════════ */

async function getUserUsage() {
  if (!currentUser) return { monthlyCount: 0, plan: 'free', planExpiry: null };
  const ref = db.collection('users').doc(currentUser.uid);
  const doc = await ref.get();
  if (!doc.exists) return { monthlyCount: 0, plan: 'free', planExpiry: null };
  const data = doc.data();
  const now = new Date();
  const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const count = (data.usage && data.usage[monthKey]) || 0;
  const plan = data.plan || 'free';
  const planExpiry = data.planExpiry || null;
  // Check if paid plan expired
  if (plan === 'monthly' && planExpiry && new Date(planExpiry) < now) {
    return { monthlyCount: count, plan: 'free', planExpiry: null };
  }
  return { monthlyCount: count, plan, planExpiry };
}

async function incrementUsage() {
  // C1: Deprecated client-side increment. Usage is now tracked server-side
  // in api/claude.js (see billOnSuccess in the proxy handler) so the user
  // can't bypass billing by skipping this call. Kept as a no-op in case
  // any future code path still calls it; safe to delete entirely once
  // verified there are no callers.
  if (!currentUser) return;
}

async function canAnalyze() {
  if (DEVELOPER_EMAILS.includes(currentUser?.email)) return { allowed: true, reason: '' };
  const usage = await getUserUsage();
  if (usage.plan === 'monthly') return { allowed: true, reason: '' };
  if (usage.monthlyCount < 3) return { allowed: true, reason: '', remaining: 3 - usage.monthlyCount };
  return { allowed: false, reason: 'monthly_limit', monthlyCount: usage.monthlyCount };
}

async function setPaidPlan(plan, orderId) {
  if (!currentUser) return;
  const ref = db.collection('users').doc(currentUser.uid);
  if (plan === 'monthly') {
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + 1);
    await ref.set({ plan: 'monthly', planExpiry: expiry.toISOString(), lastOrderId: orderId }, { merge: true });
  } else if (plan === 'single') {
    const now = new Date();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    await ref.set({ singlePurchases: firebase.firestore.FieldValue.increment(1), lastOrderId: orderId }, { merge: true });
  }
}
