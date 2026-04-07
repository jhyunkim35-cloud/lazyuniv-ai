export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://lazyuniv-ai.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { paymentKey, orderId, amount } = req.body;
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ success: false, message: 'Missing parameters' });
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
      return res.status(200).json({ success: true, data });
    } else {
      return res.status(400).json({ success: false, message: data.message || 'Payment failed' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}
