// Firebase Admin SDK singleton for serverless functions.
// Initializes once per Lambda container, reuses across invocations.
const admin = require('firebase-admin');

let initialized = false;

function getAdmin() {
  if (!initialized) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing');
    }
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(raw);
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON: ' + e.message);
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    initialized = true;
  }
  return admin;
}

module.exports = { getAdmin };
