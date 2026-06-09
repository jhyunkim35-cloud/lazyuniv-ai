// Toss Payments webhook (server-to-server fallback).
//
// WHY: the browser confirm flow (api/toss.js) can be missed — user closes the
// tab/popup before the redirect, or the auth wait times out on return. Toss
// still captured the payment, so without this the user is charged but never
// entitled. This endpoint runs independently of the browser.
//
// SECURITY: this URL is public and unauthenticated, so we NEVER trust the POST
// body's amount/status. We take only the paymentKey/orderId from the body, then
// RE-FETCH the payment from the Toss API with our secret key and treat that as
// the sole source of truth. uid comes from the payment's customerKey (both the
// plan and STT flows set customerKey = full Firebase uid). Fulfillment goes
// through the same idempotent grantEntitlement() the confirm flow uses, so if
// both fire for one payment there is no double grant.
//
// SETUP (manual, not done by code): register this URL as a webhook in the Toss
// developer console → https://notyx.co.kr/api/toss-webhook

const { grantEntitlement, sttPriceForUnits, planForAmount } = require('./_grant');

// Find the STT unit count n whose price equals the verified amount (or null).
function sttUnitsForAmount(amount) {
  for (let n = 1; n <= 200; n++) {
    if (sttPriceForUnits(n) === amount) return n;
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Body may arrive parsed or as a raw string depending on content-type.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};
  const payload = body.data && typeof body.data === 'object' ? body.data : body;
  const paymentKey = payload.paymentKey || body.paymentKey || null;
  const orderId = payload.orderId || body.orderId || null;

  if (!paymentKey && !orderId) {
    // Nothing actionable — ack so Toss doesn't retry forever.
    console.warn('[toss-webhook] no paymentKey/orderId in payload');
    return res.status(200).json({ ok: true, ignored: 'no_identifier' });
  }

  const secretKey = process.env.TOSS_SECRET_KEY;
  if (!secretKey) {
    console.error('[toss-webhook] TOSS_SECRET_KEY missing');
    return res.status(500).json({ ok: false, message: 'server_misconfigured' });
  }
  const encoded = Buffer.from(secretKey + ':').toString('base64');
  const url = paymentKey
    ? 'https://api.tosspayments.com/v1/payments/' + encodeURIComponent(paymentKey)
    : 'https://api.tosspayments.com/v1/payments/orders/' + encodeURIComponent(orderId);

  // Authoritative re-fetch from Toss.
  let payment;
  try {
    const r = await fetch(url, { headers: { 'Authorization': 'Basic ' + encoded } });
    if (r.status >= 500) {
      // Toss transient — let Toss retry the webhook later.
      console.error('[toss-webhook] Toss lookup 5xx:', r.status);
      return res.status(502).json({ ok: false, message: 'toss_lookup_failed' });
    }
    payment = await r.json();
    if (!r.ok) {
      console.warn('[toss-webhook] Toss lookup not ok:', r.status, payment && payment.code);
      return res.status(200).json({ ok: true, ignored: 'lookup_not_ok' });
    }
  } catch (e) {
    console.error('[toss-webhook] Toss lookup error:', e.message);
    return res.status(502).json({ ok: false, message: 'toss_lookup_error' });
  }

  if (payment.status !== 'DONE') {
    return res.status(200).json({ ok: true, ignored: 'status_' + payment.status });
  }

  const uid = payment.customerKey;
  if (!uid) {
    console.warn('[toss-webhook] payment has no customerKey, cannot attribute. orderId=', payment.orderId);
    return res.status(200).json({ ok: true, ignored: 'no_customerKey' });
  }

  const verifiedAmount = payment.totalAmount;
  let kind, minutes;
  if (planForAmount(verifiedAmount)) {
    kind = 'plan';            // grantEntitlement derives monthly/single from amount
  } else {
    const n = sttUnitsForAmount(verifiedAmount);
    if (!n) {
      console.warn('[toss-webhook] amount matches no plan or STT tier:', verifiedAmount);
      return res.status(200).json({ ok: true, ignored: 'unknown_amount' });
    }
    kind = 'sttEntitlement';
    minutes = n * 30;
  }

  const result = await grantEntitlement({
    uid, kind, minutes,
    paymentKey: payment.paymentKey,
    orderId: payment.orderId,
    verifiedAmount,
  });

  if (result.ok) {
    return res.status(200).json({ ok: true, idempotent: !!result.idempotent });
  }
  // Transient write failure → let Toss retry; permanent rejection → ack.
  if (result.status === 500) {
    return res.status(500).json({ ok: false, message: result.message });
  }
  console.warn('[toss-webhook] grant rejected:', result.message);
  return res.status(200).json({ ok: true, ignored: 'grant_rejected' });
};
