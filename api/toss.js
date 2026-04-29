const { getAdmin } = require('./_firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://lazyuniv-ai.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { paymentKey, orderId, amount, uid } = req.body;
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ success: false, message: 'Missing parameters' });
  }
  if (!uid) return res.status(400).json({ success: false, message: 'uid required' });

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
      // Derive plan from Toss-verified amount — client URL param is not trusted
      const verifiedAmount = data.totalAmount;
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

      return res.status(200).json({ success: true, data, plan: verifiedPlan });
    } else {
      return res.status(400).json({ success: false, message: data.message || 'Payment failed' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};
