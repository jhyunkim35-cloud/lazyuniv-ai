// Shared payment fulfillment. Given a Toss-VERIFIED payment, grant the
// entitlement exactly once. Used by:
//   - api/toss.js          (browser confirm flow; uid from Firebase ID token)
//   - api/toss-webhook.js  (server-to-server fallback; uid from Toss customerKey)
//
// Idempotency: users/{uid}/paymentLog/{paymentKey} is the guard. Whichever path
// runs first seals it; the other becomes a no-op. This is what makes it safe for
// the confirm flow and the webhook to both fire for the same payment.
//
// SECURITY: callers must pass an amount that Toss itself confirmed (confirm
// response totalAmount, or a re-fetched payment's totalAmount) — never a
// client-supplied amount.

const { getAdmin } = require('./_firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { recordUsage } = require('./_usage');

// STT per-use price for n thirty-minute blocks.
// MUST stay in sync with public/js/payment.js priceFor().
function sttPriceForUnits(n) {
  return n <= 5 ? 500 + n * 1000 : n === 6 ? 6600 : 6600 + (n - 6) * 1000;
}

// Map a Toss-verified amount to a plan, or null if it isn't a plan amount.
// Plan amounts (500, 7900) do not collide with any STT amount (1500, 2500, …).
function planForAmount(amount) {
  if (amount === 7900) return 'monthly';
  if (amount === 500) return 'single';
  return null;
}

// Returns { ok:true, ... } on success or idempotent hit;
//         { ok:false, status, message } on rejection.
async function grantEntitlement({ uid, kind, minutes, paymentKey, orderId, verifiedAmount }) {
  if (!uid || !paymentKey) return { ok: false, status: 400, message: 'missing uid/paymentKey' };

  const admin = getAdmin();
  const db = admin.firestore();
  const idemRef = db.collection('users').doc(uid).collection('paymentLog').doc(paymentKey);

  // Idempotency guard — already fulfilled? return the cached record, no re-grant.
  try {
    const snap = await idemRef.get();
    if (snap.exists) return { ok: true, idempotent: true, ...snap.data() };
  } catch (e) {
    console.warn('[grant] idempotency precheck skipped:', e.message);
  }

  // ── STT per-use entitlement ──────────────────────────────────────────
  if (kind === 'sttEntitlement') {
    const n = Math.max(1, Math.ceil((Number(minutes) || 0) / 30));
    const expectedPrice = sttPriceForUnits(n);
    if (verifiedAmount !== expectedPrice) {
      console.error('[grant] STT amount mismatch:', verifiedAmount, 'expected', expectedPrice);
      return { ok: false, status: 400, message: 'Amount mismatch for STT entitlement' };
    }
    try {
      await db.collection('users').doc(uid)
        .collection('sttEntitlements').doc(paymentKey)
        .set({
          minutes: n * 30,
          priceKRW: verifiedAmount,
          paidAt: FieldValue.serverTimestamp(),
          consumed: false,
          consumedAt: null,
          transcriptId: null,
          orderId,
          paymentKey,
        });
    } catch (e) {
      console.error('[grant] sttEntitlement write failed:', e);
      return { ok: false, status: 500, message: 'Entitlement creation failed: ' + e.message };
    }
    try {
      await recordUsage({ uid, kind: 'sttPayment', increments: { sttPaymentCount: 1, sttPaymentTotalKRW: verifiedAmount } });
    } catch (e) { console.error('[usage] stt payment record failed:', e.message); }
    try {
      await idemRef.set({
        kind: 'sttEntitlement', orderId, paymentKey,
        priceKRW: verifiedAmount, minutes: n * 30,
        processedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) { console.warn('[grant] paymentLog seal failed:', e.message); }
    return { ok: true, minutes: n * 30, priceKRW: verifiedAmount };
  }

  // ── Plan purchase (monthly / single) ─────────────────────────────────
  // Plan is derived from the Toss-verified amount, never a client/url value.
  const verifiedPlan = planForAmount(verifiedAmount);
  if (!verifiedPlan) {
    console.error('[grant] unrecognized amount:', verifiedAmount);
    return { ok: false, status: 400, message: 'Unrecognized payment amount: ' + verifiedAmount };
  }
  try {
    const userRef = db.collection('users').doc(uid);
    if (verifiedPlan === 'monthly') {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 30);
      await userRef.set({
        plan: 'monthly',
        planExpiry: expiry.toISOString(),
        lastOrderId: orderId,
        lastPaymentAt: new Date().toISOString(),
      }, { merge: true });
    } else {
      await userRef.set({
        singlePurchases: FieldValue.increment(1),
        lastOrderId: orderId,
        lastPaymentAt: new Date().toISOString(),
      }, { merge: true });
    }
  } catch (e) {
    console.error('[grant] plan write failed:', e);
    return { ok: false, status: 500, message: 'Plan update failed: ' + e.message };
  }
  try {
    await recordUsage({ uid, kind: 'payment', increments: { paymentCount: 1, paymentTotalKRW: verifiedAmount } });
  } catch (e) { console.error('[usage] payment record failed:', e.message); }
  try {
    await idemRef.set({
      kind: verifiedPlan, orderId, paymentKey,
      priceKRW: verifiedAmount,
      processedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn('[grant] paymentLog seal failed:', e.message); }
  return { ok: true, plan: verifiedPlan };
}

module.exports = { grantEntitlement, sttPriceForUnits, planForAmount };
