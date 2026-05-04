const { getAdmin } = require('./_firebase-admin');

/**
 * Record per-user usage to users/{uid}/usage/{YYYY-MM}.
 * Uses FieldValue.increment so concurrent writes are safe.
 * Throws on Firestore error — callers MUST wrap in try/catch.
 *
 * @param {{ uid: string, kind: 'note'|'quiz'|'classify'|'stt'|'payment'|null, increments?: object }} opts
 */
async function recordUsage({ uid, kind, increments = {} }) {
  const admin = getAdmin();
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;

  const now = new Date();
  const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const ref = db.collection('users').doc(uid).collection('usage').doc(monthKey);

  const update = { lastActivityAt: FV.serverTimestamp() };

  if (kind === 'note')     update.noteCount     = FV.increment(1);
  else if (kind === 'quiz')     update.quizCount     = FV.increment(1);
  else if (kind === 'classify') update.classifyCount = FV.increment(1);

  if (increments.inputTokens)     update.inputTokens     = FV.increment(increments.inputTokens);
  if (increments.outputTokens)    update.outputTokens    = FV.increment(increments.outputTokens);
  if (increments.cachedTokens)    update.cachedTokens    = FV.increment(increments.cachedTokens);
  if (increments.sttSeconds)      update.sttSeconds      = FV.increment(increments.sttSeconds);
  if (increments.paymentTotalKRW) update.paymentTotalKRW = FV.increment(increments.paymentTotalKRW);
  if (increments.paymentCount)    update.paymentCount    = FV.increment(increments.paymentCount);

  await ref.set(update, { merge: true });
}

module.exports = { recordUsage };
