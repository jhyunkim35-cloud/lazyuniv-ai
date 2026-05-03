// SRS data layer: SM-2 spaced repetition for section-level weakness cards.
// Depends on: constants.js (db, currentUser), storage.js (openDB, getAllFolders, getAllNotes).

(function () {

  // ── Date helpers ──────────────────────────────────────────────

  function todayYmd() {
    const d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function addDaysToYmd(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return dt.getFullYear() + '-' +
           String(dt.getMonth() + 1).padStart(2, '0') + '-' +
           String(dt.getDate()).padStart(2, '0');
  }

  // ── IDB helpers ───────────────────────────────────────────────

  function idbGetSrsCard(cardId) {
    return openDB().then(conn => new Promise((res, rej) => {
      const req = conn.transaction('srsCards', 'readonly').objectStore('srsCards').get(cardId);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    }));
  }

  function idbPutSrsCard(card) {
    return openDB().then(conn => new Promise((res, rej) => {
      const tx = conn.transaction('srsCards', 'readwrite');
      tx.objectStore('srsCards').put(card);
      tx.oncomplete = () => res(card);
      tx.onerror    = e => rej(e.target.error);
    }));
  }

  function idbGetSrsCardsByFolder(folderId) {
    return openDB().then(conn => new Promise((res, rej) => {
      const idx = conn.transaction('srsCards', 'readonly').objectStore('srsCards').index('folderId');
      const req = idx.getAll(folderId);
      req.onsuccess = e => res(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    }));
  }

  // ── SM-2 algorithm ────────────────────────────────────────────

  function computeNextSrs(card, quality) {
    const c = Object.assign({}, card);
    const today = todayYmd();

    if (quality < 3) {
      c.interval    = 1;
      c.repetitions = 0;
    } else {
      if (c.repetitions === 0)      c.interval = 1;
      else if (c.repetitions === 1) c.interval = 6;
      else                          c.interval = Math.round((c.interval || 1) * (c.easeFactor || 2.5));
      c.repetitions = (c.repetitions || 0) + 1;
    }

    c.easeFactor     = Math.max(1.3, (c.easeFactor || 2.5) + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    c.nextReviewDate = addDaysToYmd(today, c.interval);
    c.lastReviewDate = today;
    c.lastQuality    = quality;
    return c;
  }

  // ── Card ID: base64url of encodeURIComponent(folderId\x01noteId\x01sectionTitle) ──

  function cardIdFor(folderId, noteId, sectionTitle) {
    const raw = encodeURIComponent([folderId, noteId, sectionTitle].join('\x01'));
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function _decodeCardId(cardId) {
    try {
      const b64    = cardId.replace(/-/g, '+').replace(/_/g, '/');
      const pad    = (4 - b64.length % 4) % 4;
      const raw    = decodeURIComponent(atob(b64 + '='.repeat(pad)));
      const parts  = raw.split('\x01');
      if (parts.length === 3) return { folderId: parts[0], noteId: parts[1], sectionTitle: parts[2] };
    } catch {}
    return null;
  }

  // ── Firestore ref helper ──────────────────────────────────────

  function srsCardsRef() {
    if (typeof currentUser === 'undefined' || !currentUser) return null;
    return db.collection('users').doc(currentUser.uid).collection('srsCards');
  }

  // ── Public API ────────────────────────────────────────────────

  async function saveSrsCard(card) {
    const ref = srsCardsRef();
    if (ref) {
      try {
        await ref.doc(card.id).set(card, { merge: true });
      } catch (e) {
        console.warn('[saveSrsCard] firestore:', e.message);
      }
    }
    try { await idbPutSrsCard(card); } catch (e) {
      console.warn('[saveSrsCard] IDB:', e.message);
    }
    return card;
  }

  async function getSrsCard(cardId) {
    const ref = srsCardsRef();
    if (ref) {
      try {
        const doc = await ref.doc(cardId).get();
        if (doc.exists) {
          const data = doc.data();
          try { await idbPutSrsCard(data); } catch {}
          return data;
        }
      } catch (e) {
        console.warn('[getSrsCard] firestore:', e.message);
      }
    }
    return idbGetSrsCard(cardId);
  }

  async function getDueCards(folderId, todayYmdStr) {
    let cards = [];
    const ref = srsCardsRef();
    if (ref) {
      try {
        const snap = await ref.where('folderId', '==', folderId).get();
        cards = snap.docs.map(d => d.data());
      } catch (e) {
        console.warn('[getDueCards] firestore:', e.message);
        cards = await idbGetSrsCardsByFolder(folderId);
      }
    } else {
      cards = await idbGetSrsCardsByFolder(folderId);
    }

    const due = cards
      .filter(c => c.nextReviewDate && c.nextReviewDate <= todayYmdStr)
      .sort((a, b) => (a.nextReviewDate || '').localeCompare(b.nextReviewDate || ''));

    // Apply effectiveDailyTarget limit using IDB folder/note data (no extra Firestore reads)
    if (typeof effectiveDailyTarget === 'function') {
      try {
        const [allFolders, allNotes] = await Promise.all([
          typeof getAllFolders === 'function' ? getAllFolders() : Promise.resolve([]),
          typeof getAllNotes   === 'function' ? getAllNotes()   : Promise.resolve([]),
        ]);
        const folder     = allFolders.find(f => f.id === folderId);
        const notesCount = allNotes.filter(n => n.folderId === folderId).length;
        if (folder && folder.examPlan) {
          return due.slice(0, effectiveDailyTarget(folder.examPlan, notesCount));
        }
      } catch {}
    }
    return due;
  }

  async function gradeCard(cardId, quality) {
    let card = await getSrsCard(cardId);
    if (!card) {
      const decoded = _decodeCardId(cardId);
      card = Object.assign(
        { id: cardId, interval: 0, repetitions: 0, easeFactor: 2.5 },
        decoded || {}
      );
    }
    const updated = computeNextSrs(card, quality);
    return saveSrsCard(updated);
  }

  window.computeNextSrs = computeNextSrs;
  window.cardIdFor      = cardIdFor;
  window.saveSrsCard    = saveSrsCard;
  window.getSrsCard     = getSrsCard;
  window.getDueCards    = getDueCards;
  window.gradeCard      = gradeCard;

})();
