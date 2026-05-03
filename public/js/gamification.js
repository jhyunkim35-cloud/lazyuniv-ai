// Gamification data layer: streak + XP tracking.
// Depends on: constants.js (db, currentUser).

(function () {

  // ── Date helpers ──────────────────────────────────────────────

  function todayYmd() {
    const d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function yesterdayYmd() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  const DEFAULTS = { streak: 0, lastReviewDay: null, xp: 0, todayDoneCount: 0, todayYmd: null };

  // ── IDB (standalone gamification DB) ─────────────────────────

  function openGamifDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('gamificationDB', 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('state', { keyPath: 'id' });
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function idbGetState() {
    try {
      const conn = await openGamifDB();
      return new Promise((resolve) => {
        const req = conn.transaction('state', 'readonly').objectStore('state').get('gamif');
        req.onsuccess = e => resolve(e.target.result || null);
        req.onerror   = ()  => resolve(null);
      });
    } catch { return null; }
  }

  async function idbPutState(state) {
    try {
      const conn = await openGamifDB();
      return new Promise((resolve, reject) => {
        const record = Object.assign({}, state, { id: 'gamif' });
        const tx = conn.transaction('state', 'readwrite');
        tx.objectStore('state').put(record);
        tx.oncomplete = () => resolve(record);
        tx.onerror    = e => reject(e.target.error);
      });
    } catch (e) {
      console.warn('[idbPutState] gamif:', e.message);
    }
  }

  // ── Firestore ref helper ──────────────────────────────────────

  function gamifRef() {
    if (typeof currentUser === 'undefined' || !currentUser) return null;
    return db.collection('users').doc(currentUser.uid).collection('gamification').doc('state');
  }

  // ── Public API ────────────────────────────────────────────────

  async function getGamificationState() {
    const ref = gamifRef();
    if (ref) {
      try {
        const doc = await ref.get();
        if (doc.exists) {
          const data = doc.data();
          idbPutState(data).catch(() => {});
          return Object.assign({}, DEFAULTS, data);
        }
      } catch (e) {
        console.warn('[getGamificationState] firestore:', e.message);
      }
    }
    const cached = await idbGetState();
    if (cached) return Object.assign({}, DEFAULTS, cached);
    return Object.assign({}, DEFAULTS);
  }

  async function saveGamificationState(state) {
    const ref = gamifRef();
    if (ref) {
      try {
        await ref.set(state, { merge: true });
      } catch (e) {
        console.warn('[saveGamificationState] firestore:', e.message);
      }
    }
    try {
      await idbPutState(state);
    } catch (e) {
      console.warn('[saveGamificationState] IDB:', e.message);
    }
  }

  async function onCardReviewed(quality) {
    const state = await getGamificationState();
    const today = todayYmd();
    const yesterday = yesterdayYmd();

    if (state.todayYmd !== today) {
      state.todayDoneCount = 0;
      state.todayYmd = today;
    }

    if (state.lastReviewDay === null) {
      state.streak = 1;
    } else if (state.lastReviewDay === today) {
      // already counted today
    } else if (state.lastReviewDay === yesterday) {
      state.streak = (state.streak || 0) + 1;
    } else {
      state.streak = 1;
    }

    state.lastReviewDay = today;
    state.xp = (state.xp || 0) + (quality >= 3 ? 10 : 5);
    state.todayDoneCount = (state.todayDoneCount || 0) + 1;

    await saveGamificationState(state);
    return state;
  }

  window.getGamificationState  = getGamificationState;
  window.saveGamificationState = saveGamificationState;
  window.onCardReviewed        = onCardReviewed;

})();
