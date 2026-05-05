const { getAdmin } = require('./_firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { recordUsage } = require('./_usage');

module.exports = async function handler(req, res) {
  // CORS — both legacy and post-rebrand origins until DNS swap is complete
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'https://lazyuniv-ai.vercel.app',
    'https://notyx.vercel.app',
  ];
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ─── Auth: verify Firebase ID token; the uid comes from the *token*,
  //          NEVER the request body. Without this, any client could pass
  //          someone else's uid and cause STT entitlements / plan upgrades
  //          to be written to that user's record. ──────────────────────
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ success: false, message: 'auth_required' });
  let uid;
  try {
    const adminSdk = getAdmin();
    const decoded = await adminSdk.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ success: false, message: 'invalid_token' });
  }

  const { paymentKey, orderId, amount, kind, minutes } = req.body;
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ success: false, message: 'Missing parameters' });
  }

  // ─── Idempotency: refuse to re-process the same paymentKey. Without
  //          this, a client retry between Toss confirm and our response
  //          would re-increment singlePurchases or duplicate the
  //          entitlement. Toss itself rejects the same paymentKey twice
  //          after DONE, but we double-guard at our layer. ─────────────
  try {
    const adminSdk = getAdmin();
    const db = adminSdk.firestore();
    const idemRef = db.collection('users').doc(uid).collection('paymentLog').doc(paymentKey);
    const idemSnap = await idemRef.get();
    if (idemSnap.exists) {
      // Already processed — return cached result so retries are no-ops.
      return res.status(200).json({ success: true, idempotent: true, ...idemSnap.data() });
    }
  } catch (e) {
    // Idempotency check failure shouldn't block payment — log and continue.
    console.warn('[toss] idempotency precheck skipped:', e.message);
  }

  const secretKey = process.env.TOSS_SECRET_KEY;
  const encoded = Buffer.from(secretKey + ':').toString('base64');

  try {
    const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + encoded,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });

    const data = await response.json();

    if (response.ok && data.status === 'DONE') {
      const verifiedAmount = data.totalAmount;

      // ── STT per-use entitlement ──────────────────────────────────
      if (kind === 'sttEntitlement') {
        const n = Math.max(1, Math.ceil((Number(minutes) || 0) / 30));
        const expectedPrice = n <= 5 ? 500 + n * 1000 : n === 6 ? 6600 : 6600 + (n - 6) * 1000;
        if (verifiedAmount !== expectedPrice) {
          console.error('STT entitlement amount mismatch:', verifiedAmount, 'expected:', expectedPrice);
          return res.status(400).json({ success: false, message: 'Amount mismatch for STT entitlement' });
        }
        try {
          const admin = getAdmin();
          const db = admin.firestore();
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
          console.error('Firestore sttEntitlement write failed:', e);
          return res.status(500).json({ success: false, message: 'Entitlement creation failed: ' + e.message });
        }
        try {
          await recordUsage({ uid, kind: 'sttPayment', increments: { sttPaymentCount: 1, sttPaymentTotalKRW: verifiedAmount } });
        } catch (e) { console.error('[usage] stt payment record failed:', e.message); }
        // Seal idempotency — future retries with same paymentKey return immediately.
        try {
          const adminSdk = getAdmin();
          await adminSdk.firestore()
            .collection('users').doc(uid)
            .collection('paymentLog').doc(paymentKey)
            .set({
              kind: 'sttEntitlement',
              orderId,
              paymentKey,
              priceKRW: verifiedAmount,
              minutes: n * 30,
              processedAt: FieldValue.serverTimestamp(),
            });
        } catch (e) { console.warn('[toss] paymentLog seal failed:', e.message); }
        return res.status(200).json({ success: true, data, minutes: n * 30, priceKRW: verifiedAmount });
      }

      // ── Plan purchase (monthly / single) ────────────────────────
      // Derive plan from Toss-verified amount — client URL param is not trusted
      let verifiedPlan;
      if (verifiedAmount === 7900) verifiedPlan = 'monthly';
      else if (verifiedAmount === 500) verifiedPlan = 'single';
      else {
        console.error('Unknown payment amount:', verifiedAmount);
        return res.status(400).json({ success: false, message: 'Unrecognized payment amount: ' + verifiedAmount });
      }

      // Write plan to Firestore via Admin SDK — client never touches plan field
      try {
        const admin = getAdmin();
        const db = admin.firestore();
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
        console.error('Firestore write failed:', e);
        return res.status(500).json({ success: false, message: 'Plan update failed: ' + e.message });
      }

      try {
        await recordUsage({
          uid,
          kind: 'payment',
          increments: { paymentCount: 1, paymentTotalKRW: verifiedAmount },
        });
      } catch (e) {
        console.error('[usage] payment record failed:', e.message);
      }

      // Seal idempotency for plan purchases too.
      try {
        const adminSdk = getAdmin();
        await adminSdk.firestore()
          .collection('users').doc(uid)
          .collection('paymentLog').doc(paymentKey)
          .set({
            kind: verifiedPlan,
            orderId,
            paymentKey,
            priceKRW: verifiedAmount,
            processedAt: FieldValue.serverTimestamp(),
          });
      } catch (e) { console.warn('[toss] paymentLog seal failed:', e.message); }

      return res.status(200).json({ success: true, data, plan: verifiedPlan });
    } else {
      return res.status(400).json({ success: false, message: data.message || 'Payment failed' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};
