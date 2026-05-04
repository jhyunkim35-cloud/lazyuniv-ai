// Gamification data layer: streak + XP tracking + daily goal + streak calendar.
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

  const DEFAULTS = {
    streak: 0, lastReviewDay: null, xp: 0, todayDoneCount: 0, todayYmd: null,
    dailyGoal: 5, dailyProgress: {}, dailyHistory: [],
    totalNotes: 0, totalReviews: 0, totalQuizzes: 0, perfectQuizzes: 0,
    unlockedIds: [], unlockedDates: {},
  };

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

  // ── Daily progress helpers ────────────────────────────────────

  function ensureTodayProgress(state) {
    const today = todayYmd();
    if (!state.dailyProgress) state.dailyProgress = {};
    if (!state.dailyProgress[today]) {
      state.dailyProgress[today] = { cardsReviewed: 0, notesCreated: 0, quizzesCompleted: 0, completed: false };
    }
    if (!state.dailyHistory) state.dailyHistory = [];
    if (!state.dailyHistory.includes(today)) {
      state.dailyHistory.push(today);
      state.dailyHistory.sort();
      if (state.dailyHistory.length > 30) {
        const removed = state.dailyHistory.splice(0, state.dailyHistory.length - 30);
        removed.forEach(ymd => { delete state.dailyProgress[ymd]; });
      }
    }
    return state.dailyProgress[today];
  }

  function _isGoalMet(state) {
    const today = todayYmd();
    const prog = (state.dailyProgress && state.dailyProgress[today]) || {};
    const goal = state.dailyGoal || 5;
    return (prog.cardsReviewed || 0) >= goal ||
           (prog.notesCreated  || 0) >= 1   ||
           (prog.quizzesCompleted || 0) >= 1;
  }

  async function _checkAndAwardGoal(state) {
    const today = todayYmd();
    const prog  = state.dailyProgress && state.dailyProgress[today];
    if (!prog) return state;
    const alreadyCompleted = prog.completed;
    if (_isGoalMet(state) && !alreadyCompleted) {
      prog.completed = true;
      state.xp = (state.xp || 0) + 50;
      await saveGamificationState(state);
      showDailyGoalCelebration(state);
    } else {
      await saveGamificationState(state);
    }
    return state;
  }

  // ── Celebration modal ─────────────────────────────────────────

  function showDailyGoalCelebration(state) {
    const existing = document.getElementById('dailyGoalCelebration');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'dailyGoalCelebration';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(0,0,0,0.55);';

    const card = document.createElement('div');
    card.style.cssText =
      'background:var(--surface,#1e1e2e);border-radius:1rem;padding:2rem 2.5rem;' +
      'text-align:center;max-width:320px;width:90%;' +
      'box-shadow:0 8px 40px rgba(0,0,0,0.35);';
    card.innerHTML =
      '<div style="font-size:3rem;margin-bottom:0.4rem;">🎉</div>' +
      '<div style="font-size:1.25rem;font-weight:800;margin-bottom:0.4rem;">오늘의 목표 달성!</div>' +
      '<div style="color:var(--primary,#7c4dff);font-weight:700;font-size:1.05rem;margin-bottom:0.35rem;">+50 XP 보너스!</div>' +
      '<div style="color:var(--text-muted,#888);margin-bottom:1.5rem;">🔥 ' + (state.streak || 0) + '일 연속</div>' +
      '<button id="dailyGoalCelebOk" style="padding:0.65rem 2rem;background:var(--primary,#7c4dff);' +
      'color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;">확인</button>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('dailyGoalCelebOk').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  }

  // ── Core actions ──────────────────────────────────────────────

  async function onCardReviewed(quality) {
    const state = await getGamificationState();
    const today     = todayYmd();
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

    state.lastReviewDay  = today;
    state.xp             = (state.xp || 0) + (quality >= 3 ? 10 : 5);
    state.todayDoneCount = (state.todayDoneCount || 0) + 1;
    state.totalReviews   = (state.totalReviews || 0) + 1;

    const prog = ensureTodayProgress(state);
    prog.cardsReviewed = (prog.cardsReviewed || 0) + 1;

    const updatedState = await _checkAndAwardGoal(state);
    if (typeof runAchievementChecks === 'function') runAchievementChecks(updatedState).catch(() => {});
    return updatedState;
  }

  async function getTodayProgress() {
    const state = await getGamificationState();
    const today = todayYmd();
    return (state.dailyProgress && state.dailyProgress[today]) ||
      { cardsReviewed: 0, notesCreated: 0, quizzesCompleted: 0, completed: false };
  }

  async function markNoteCreated() {
    try {
      const state       = await getGamificationState();
      state.totalNotes  = (state.totalNotes || 0) + 1;
      const prog        = ensureTodayProgress(state);
      prog.notesCreated = (prog.notesCreated || 0) + 1;
      const updatedState = await _checkAndAwardGoal(state);
      if (typeof runAchievementChecks === 'function') runAchievementChecks(updatedState).catch(() => {});
      return updatedState;
    } catch (e) {
      console.warn('[markNoteCreated]', e.message);
    }
  }

  async function markQuizCompleted(perfect = false) {
    try {
      const state        = await getGamificationState();
      state.totalQuizzes = (state.totalQuizzes || 0) + 1;
      if (perfect) state.perfectQuizzes = (state.perfectQuizzes || 0) + 1;
      const prog        = ensureTodayProgress(state);
      prog.quizzesCompleted = (prog.quizzesCompleted || 0) + 1;
      const updatedState = await _checkAndAwardGoal(state);
      if (typeof runAchievementChecks === 'function') runAchievementChecks(updatedState).catch(() => {});
      return updatedState;
    } catch (e) {
      console.warn('[markQuizCompleted]', e.message);
    }
  }

  async function checkDailyGoalCompleted() {
    const state = await getGamificationState();
    return _isGoalMet(state);
  }

  window.getGamificationState    = getGamificationState;
  window.saveGamificationState   = saveGamificationState;
  window.onCardReviewed          = onCardReviewed;
  window.getTodayProgress        = getTodayProgress;
  window.markNoteCreated         = markNoteCreated;
  window.markQuizCompleted       = markQuizCompleted;
  window.checkDailyGoalCompleted = checkDailyGoalCompleted;

})();
